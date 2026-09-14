"""Parquet layout and content-derived dataset manifests.

The snapshot ID participates in result cache keys so data changes invalidate cached answers.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from .schema import PARTITION_KEYS, SORT_KEYS, TABLES

#: Row-group size balancing metadata overhead against pruning granularity.
ROW_GROUP_SIZE = 128_000

COMPRESSION = "zstd"
COMPRESSION_LEVEL = 3

#: Bloom-filtered columns used to skip files during single-match drill-down.
BLOOM_COLUMNS = ("match_id",)

MANIFEST_NAME = "_manifest.json"

_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _validate_component(name: str, value: str) -> str:
    """Reject path separators, traversal, and ambiguous Hive partition values."""
    if (
        not value
        or value in {".", ".."}
        or not _SAFE_COMPONENT.fullmatch(value)
        or "/" in value
        or "\\" in value
    ):
        raise ValueError(f"Invalid {name} partition value: {value!r}")
    return value


@dataclass(frozen=True, slots=True)
class PartitionKey:
    patch: str
    queue: str
    region: str

    def path_parts(self) -> tuple[str, ...]:
        return (
            f"patch={_validate_component('patch', self.patch)}",
            f"queue={_validate_component('queue', self.queue)}",
            f"region={_validate_component('region', self.region)}",
        )


def partition_dir(root: Path, table: str, key: PartitionKey) -> Path:
    if table not in TABLES:
        raise ValueError(f"Unknown table: {table!r}")
    resolved_root = root.resolve(strict=False)
    candidate = root.joinpath(table, *key.path_parts()).resolve(strict=False)
    if not candidate.is_relative_to(resolved_root):
        raise ValueError(f"Partition path escapes dataset root: {candidate}")
    return candidate


@contextmanager
def staged_dataset(root: Path) -> Iterator[Path]:
    """Build a complete dataset beside `root`, then replace `root` as one generation.

    The previous dataset is restored if the final rename fails. This deliberately implements
    replace semantics: callers cannot accidentally mix synthetic, Riot, or stale part files.
    """
    requested_root = root.absolute()
    if requested_root.is_symlink():
        raise ValueError(f"Dataset root must not be a symbolic link: {requested_root}")
    root = requested_root.resolve(strict=False)
    if root == Path(root.anchor) or (root / ".git").exists():
        raise ValueError(f"Refusing to replace unsafe dataset root: {root}")
    root.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{root.name}.staging-", dir=root.parent))
    backup: Path | None = None
    try:
        yield stage
        if root.exists():
            backup = Path(tempfile.mkdtemp(prefix=f".{root.name}.backup-", dir=root.parent))
            backup.rmdir()
            root.rename(backup)
        try:
            stage.rename(root)
        except BaseException:
            if backup is not None and backup.exists() and not root.exists():
                backup.rename(root)
            raise
        if backup is not None:
            shutil.rmtree(backup, ignore_errors=True)
    except BaseException:
        if stage.exists():
            shutil.rmtree(stage)
        raise


def sort_table(table: str, data: pa.Table) -> pa.Table:
    """Sort by table keys at write time to preserve pruning performance."""
    keys = SORT_KEYS.get(table)
    if not keys:
        return data
    present = [k for k in keys if k in data.column_names]
    if not present:
        return data
    return data.sort_by([(k, "ascending") for k in present])


def write_partition(
    root: Path,
    table: str,
    key: PartitionKey,
    data: pa.Table,
    *,
    part_index: int = 0,
) -> Path:
    """Write one file for a partition.

    Partition columns are encoded by the Hive path and removed from the file to avoid duplicate
    storage and ambiguous filter pushdown.
    """
    schema = TABLES[table]
    data = data.select([n for n in schema.names if n in data.column_names])
    data = data.cast(pa.schema([schema.field(n) for n in data.column_names]))
    data = sort_table(table, data)

    out_dir = partition_dir(root, table, key)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"part-{part_index:04d}.parquet"

    bloom = {c: {} for c in BLOOM_COLUMNS if c in data.column_names}
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        pq.write_table(
            data,
            temporary,
            compression=COMPRESSION,
            compression_level=COMPRESSION_LEVEL,
            row_group_size=ROW_GROUP_SIZE,
            write_statistics=True,
            use_dictionary=True,
            bloom_filter_options=bloom or None,
            # Page indexes enable row-group pruning for low-latency single-match drill-down.
            write_page_index=True,
            store_schema=True,
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def _hash_files(root: Path) -> tuple[str, list[dict[str, Any]]]:
    """Hash file paths and contents so identical regenerated data keeps its snapshot ID."""
    entries: list[dict[str, Any]] = []
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.parquet")):
        rel = path.relative_to(root).as_posix()
        h = hashlib.sha256(path.read_bytes()).hexdigest()
        meta = pq.read_metadata(path)
        entries.append(
            {"path": rel, "rows": meta.num_rows, "bytes": path.stat().st_size, "sha256": h}
        )
        digest.update(rel.encode())
        digest.update(h.encode())
    return digest.hexdigest(), entries


def write_manifest(root: Path, *, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Update and return the dataset manifest."""
    snapshot, files = _hash_files(root)
    by_table: dict[str, dict[str, int]] = {}
    for f in files:
        table = f["path"].split("/", 1)[0]
        agg = by_table.setdefault(table, {"files": 0, "rows": 0, "bytes": 0})
        agg["files"] += 1
        agg["rows"] += f["rows"]
        agg["bytes"] += f["bytes"]

    manifest: dict[str, Any] = {
        "snapshot_id": f"sha256:{snapshot[:32]}",
        "generated_at": datetime.now(UTC).isoformat(),
        "partition_keys": list(PARTITION_KEYS),
        "tables": by_table,
        "files": files,
    }
    if extra:
        manifest.update(extra)
    path = root / MANIFEST_NAME
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)
    return manifest


def read_manifest(root: Path) -> dict[str, Any] | None:
    path = root / MANIFEST_NAME
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def files_per_partition(root: Path, table: str) -> dict[str, int]:
    """Count files per partition; values above four indicate a compaction need."""
    counts: dict[str, int] = {}
    table_dir = root / table
    if not table_dir.exists():
        return counts
    for path in table_dir.rglob("*.parquet"):
        key = path.parent.relative_to(table_dir).as_posix()
        counts[key] = counts.get(key, 0) + 1
    return counts
