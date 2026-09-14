"""Batch-normalize preserved bronze JSON into silver and gold Parquet tables."""

from __future__ import annotations

import gzip
import json
import os
import time
from collections import Counter, defaultdict
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import Future, ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pyarrow as pa

from ..layout import PartitionKey, staged_dataset, write_manifest, write_partition
from ..schema import SCHEMA_VERSION, TABLES
from .collector import is_surrendered
from .normalize import UnsupportedMapError, normalize_match


@dataclass(frozen=True, slots=True)
class NormalizationProgress:
    processed: int
    total: int
    completed: int
    failed: int
    excluded: int
    workers: int
    elapsed_seconds: float


@dataclass(slots=True)
class _NormalizationResult:
    status: str
    match_id: str
    key: tuple[str, str, str] | None = None
    tables: dict[str, pa.Table] | None = None
    detail: dict[str, Any] | None = None


def _normalize_one(match_path_value: str, queue_ids: frozenset[int] | None) -> _NormalizationResult:
    """Read and normalize one match inside a worker process."""
    match_path = Path(match_path_value)
    match_id = match_path.parent.name
    timeline_path = match_path.with_name("timeline.json.gz")
    if not timeline_path.exists():
        return _NormalizationResult(
            status="failed",
            match_id=match_id,
            detail={"match": match_id, "error": "timeline missing"},
        )
    try:
        with gzip.open(match_path, "rt", encoding="utf-8") as stream:
            match = json.load(stream)
        queue_id = int(match.get("info", {}).get("queueId") or 0)
        if queue_ids is not None and queue_id not in queue_ids:
            return _NormalizationResult(
                status="excluded",
                match_id=match_id,
                detail={"match": match_id, "reason": "queue", "queueId": queue_id},
            )
        if is_surrendered(match):
            return _NormalizationResult(
                status="excluded",
                match_id=match_id,
                detail={"match": match_id, "reason": "surrender"},
            )
        with gzip.open(timeline_path, "rt", encoding="utf-8") as stream:
            timeline = json.load(stream)
        dataset = normalize_match(match, timeline)
        match_row = dataset.tables["matches"].to_pylist()[0]
        return _NormalizationResult(
            status="completed",
            match_id=match_id,
            key=(match_row["patch"], match_row["queue"], match_row["region"]),
            tables=dataset.tables,
        )
    except UnsupportedMapError as exc:
        return _NormalizationResult(
            status="excluded",
            match_id=match_id,
            detail={
                "match": exc.match_id,
                "reason": "unsupported_map",
                "mapId": exc.map_id,
            },
        )
    except Exception as exc:  # noqa: BLE001 — report one corrupt source and continue
        return _NormalizationResult(
            status="failed",
            match_id=match_id,
            detail={"match": match_id, "error": str(exc)},
        )


def _normalization_results(
    match_paths: Sequence[Path], queue_ids: frozenset[int] | None, workers: int
) -> Iterator[_NormalizationResult]:
    if workers <= 1 or len(match_paths) <= 1:
        for path in match_paths:
            yield _normalize_one(str(path), queue_ids)
        return

    # Keep only a small number of Arrow-table results in memory while retaining input order,
    # which makes output part assignment deterministic across worker counts.
    path_iter = iter(match_paths)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        pending: list[Future[_NormalizationResult]] = []
        for path in path_iter:
            pending.append(pool.submit(_normalize_one, str(path), queue_ids))
            if len(pending) >= workers * 2:
                break
        while pending:
            future = pending.pop(0)
            yield future.result()
            try:
                path = next(path_iter)
            except StopIteration:
                continue
            pending.append(pool.submit(_normalize_one, str(path), queue_ids))


def normalize_bronze(
    data_dir: Path,
    *,
    silver_dir: Path | None = None,
    batch_size: int = 250,
    queue_ids: set[int] | None = None,
    workers: int | None = None,
    progress: Callable[[NormalizationProgress], None] | None = None,
) -> dict[str, Any]:
    if batch_size <= 0:
        raise ValueError("batch_size must be greater than zero")
    if workers is not None and workers <= 0:
        raise ValueError("workers must be greater than zero")
    bronze = data_dir / "bronze" / "riot"
    silver = silver_dir or data_dir / "silver"
    match_paths = sorted(bronze.glob("*/match.json.gz"))
    effective_workers = workers or min(max(1, len(match_paths)), max(1, (os.cpu_count() or 2) - 1))
    selected_queues = frozenset(queue_ids) if queue_ids is not None else None
    failures: list[dict[str, str]] = []
    exclusions: list[dict[str, Any]] = []
    attempted = 0
    completed = 0
    started = time.monotonic()

    def report() -> None:
        if progress is not None:
            progress(
                NormalizationProgress(
                    processed=attempted,
                    total=len(match_paths),
                    completed=completed,
                    failed=len(failures),
                    excluded=len(exclusions),
                    workers=effective_workers,
                    elapsed_seconds=time.monotonic() - started,
                )
            )

    report()
    with staged_dataset(silver) as stage:
        grouped: dict[tuple[str, str, str], dict[str, list[pa.Table]]] = defaultdict(
            lambda: defaultdict(list)
        )
        next_part: dict[tuple[str, str, str], int] = defaultdict(int)
        buffered = 0

        def flush() -> None:
            nonlocal buffered
            for key_tuple, tables in sorted(grouped.items()):
                key = PartitionKey(*key_tuple)
                part_index = next_part[key_tuple]
                for table_name in TABLES:
                    chunks = tables.get(table_name, [])
                    table = pa.concat_tables(chunks) if chunks else TABLES[table_name].empty_table()
                    write_partition(stage, table_name, key, table, part_index=part_index)
                next_part[key_tuple] += 1
            grouped.clear()
            buffered = 0

        for result in _normalization_results(match_paths, selected_queues, effective_workers):
            attempted += 1
            if result.status == "completed":
                assert result.key is not None and result.tables is not None
                for table_name, table in result.tables.items():
                    grouped[result.key][table_name].append(table)
                completed += 1
                buffered += 1
                if buffered >= batch_size:
                    flush()
            elif result.status == "excluded":
                assert result.detail is not None
                exclusions.append(result.detail)
            else:
                assert result.detail is not None
                failures.append(result.detail)
            report()
        if buffered:
            flush()

        failed = len(failures)
        excluded = len(exclusions)
        excluded_by_reason = dict(Counter(item["reason"] for item in exclusions))
        manifest = write_manifest(
            stage,
            extra={
                "source": "riot_v5",
                "schemaVersion": SCHEMA_VERSION,
                "eventOrigins": ["observed", "inferred_rule"],
                "inferredEventTypes": ["baron_spawn", "dragon_spawn", "herald_spawn"],
                "n_matches": completed,
                "spatialMapId": 11,
                "normalizationQuality": {
                    "attempted": attempted,
                    "completed": completed,
                    "failed": failed,
                    "excluded": excluded,
                    "completionRate": completed / attempted if attempted else 0.0,
                    "failureRate": failed / attempted if attempted else 0.0,
                    "excludedByReason": excluded_by_reason,
                },
                "normalizationFailures": failures,
                "normalizationExclusions": exclusions,
            },
        )
    return manifest
