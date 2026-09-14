"""Write synthetic datasets to Parquet.

Large runs assign chunks and output files to workers so the complete dataset is never held
in memory.
"""

from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import pyarrow as pa

from ..layout import PartitionKey, staged_dataset, write_manifest, write_partition
from ..schema import SCHEMA_VERSION, TABLES
from .generator import generate
from .params import SynthParams


def _write_chunk(
    part_index: int,
    n: int,
    start_index: int,
    seed: int,
    params: SynthParams,
    root: str,
    patch: str,
    queue: str,
    queue_id: int,
    region_code: str,
) -> dict[str, int]:
    ds = generate(
        n,
        seed=seed,
        params=params,
        patch=patch,
        queue=queue,
        queue_id=queue_id,
        region_code=region_code,
        start_index=start_index,
    )
    key = PartitionKey(patch=patch, queue=queue, region=region_code)
    counts: dict[str, int] = {}
    for table_name, table in ds.tables.items():
        write_partition(Path(root), table_name, key, table, part_index=part_index)
        counts[table_name] = table.num_rows
    return counts


def write_dataset(
    n_matches: int,
    root: Path,
    *,
    seed: int = 20260913,
    params: SynthParams | None = None,
    patch: str = "14.19",
    queue: str = "RANKED_SOLO_5x5",
    queue_id: int = 420,
    region_code: str = "SYNTH",
    workers: int | None = None,
    chunk_size: int = 2500,
    progress: bool = True,
) -> dict[str, Any]:
    if n_matches <= 0:
        raise ValueError("n_matches must be greater than zero")
    if chunk_size <= 0:
        raise ValueError("chunk_size must be greater than zero")
    if workers is not None and workers <= 0:
        raise ValueError("workers must be greater than zero")
    params = params or SynthParams.load()

    with staged_dataset(root) as stage:
        return _write_dataset(
            n_matches,
            stage,
            seed=seed,
            params=params,
            patch=patch,
            queue=queue,
            queue_id=queue_id,
            region_code=region_code,
            workers=workers,
            chunk_size=chunk_size,
            progress=progress,
        )


def _write_dataset(
    n_matches: int,
    root: Path,
    *,
    seed: int,
    params: SynthParams,
    patch: str,
    queue: str,
    queue_id: int,
    region_code: str,
    workers: int | None,
    chunk_size: int,
    progress: bool,
) -> dict[str, Any]:

    chunks: list[tuple[int, int, int]] = []
    start = 0
    idx = 0
    while start < n_matches:
        size = min(chunk_size, n_matches - start)
        chunks.append((idx, size, start))
        start += size
        idx += 1

    workers = workers or min(len(chunks), max(1, (os.cpu_count() or 2) - 1))
    totals: dict[str, int] = dict.fromkeys(TABLES, 0)

    def accumulate(counts: dict[str, int], done: int) -> None:
        for k, v in counts.items():
            totals[k] += v
        if progress:
            print(
                f"  {done}/{len(chunks)} chunks complete ({totals['matches']:,} matches)",
                flush=True,
            )

    args = [
        (i, size, st, seed, params, str(root), patch, queue, queue_id, region_code)
        for i, size, st in chunks
    ]

    if workers <= 1 or len(chunks) == 1:
        for done, a in enumerate(args, 1):
            accumulate(_write_chunk(*a), done)
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_write_chunk, *a) for a in args]
            for done, fut in enumerate(futures, 1):
                accumulate(fut.result(), done)

    manifest = write_manifest(
        root,
        extra={
            "source": "synthetic_v1",
            "schemaVersion": SCHEMA_VERSION,
            "eventOrigins": ["synthetic"],
            "inferredEventTypes": [],
            "n_matches": n_matches,
            "seed": seed,
            "patch": patch,
            "queue": queue,
            "region": region_code,
            "calibration": params.calibration,
        },
    )
    manifest["row_counts"] = totals
    return manifest


def empty_dataset_tables() -> dict[str, pa.Table]:
    return {name: schema.empty_table() for name, schema in TABLES.items()}
