"""Separate process liveness from dataset readiness."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

import duckdb
import pyarrow.parquet as pq
from fastapi import APIRouter, Response, status
from lod_data.layout import read_manifest
from lod_data.schema import TABLES

from lod_api.config import settings

router = APIRouter(tags=["health"])


@router.api_route("/healthz", methods=["GET", "HEAD"])
def healthz() -> dict[str, Any]:
    if settings.public_instance:
        return {"status": "ok"}
    return {"status": "ok", "engine": f"duckdb-{duckdb.__version__}"}


@router.api_route("/readyz", methods=["GET", "HEAD"])
def readyz(response: Response) -> dict[str, Any]:
    """Report reference-data and dataset readiness independently."""
    if settings.public_instance:
        ready = _public_ready()
        if not ready:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"ready": ready}

    checks: dict[str, Any] = {}

    reference_files = [
        settings.reference_dir / "catalog.json",
        settings.reference_dir / "regions_builtin.json",
    ]
    missing_reference = [path.name for path in reference_files if not path.is_file()]
    checks["reference"] = {
        "ok": not missing_reference,
        "files": [path.name for path in reference_files],
        "missing": missing_reference,
        "hintKo": None if not missing_reference else "`pnpm gen:reference` 를 실행하세요.",
    }

    silver = settings.silver_dir
    manifest_error = None
    try:
        manifest = read_manifest(silver)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        manifest = None
        manifest_error = type(exc).__name__
    manifest_tables = manifest.get("tables", {}) if isinstance(manifest, dict) else {}
    required_tables = sorted(TABLES)
    parquet_tables = sorted(
        table for table in required_tables if any((silver / table).rglob("*.parquet"))
    )
    missing_tables = sorted(
        set(required_tables) - set(manifest_tables) | set(required_tables) - set(parquet_tables)
    )
    match_rows = manifest_tables.get("matches", {}).get("rows", 0)
    has_data = (
        isinstance(manifest, dict)
        and not missing_tables
        and isinstance(match_rows, int)
        and match_rows > 0
    )
    checks["dataset"] = {
        "ok": has_data,
        "manifest": "_manifest.json",
        "manifestError": manifest_error,
        "snapshotId": manifest.get("snapshot_id") if isinstance(manifest, dict) else None,
        "matchCount": match_rows if isinstance(match_rows, int) else 0,
        "tables": parquet_tables,
        "requiredTables": required_tables,
        "missingTables": missing_tables,
        "hintKo": None if has_data else "`uv run lod-data synth --n 10000` 으로 데이터를 만드세요.",
    }

    ready = all(c["ok"] for c in checks.values())
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"ready": ready, "checks": checks}


def _public_ready() -> bool:
    """Use only bounded manifest reads for externally polled public readiness."""
    manifest_path = settings.silver_dir / "_manifest.json"
    catalog_path = settings.reference_dir / "catalog.json"
    regions_path = settings.reference_dir / "regions_builtin.json"
    signatures = tuple(
        _file_signature(path) for path in (manifest_path, catalog_path, regions_path)
    )
    if any(signature is None for signature in signatures):
        return False
    witnesses = _cached_public_witnesses(
        str(settings.silver_dir), str(settings.reference_dir), signatures
    )
    return witnesses is not None and _has_table_witnesses(settings.silver_dir, witnesses)


def _file_signature(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_mtime_ns, stat.st_size


@lru_cache(maxsize=16)
def _cached_public_witnesses(
    silver_dir: str,
    reference_dir: str,
    _signatures: tuple[tuple[int, int] | None, ...],
) -> tuple[str, ...] | None:
    """Parse the manifest only when it or either reference file changes."""
    try:
        manifest = read_manifest(Path(silver_dir))
        reference_root = Path(reference_dir)
        for name in ("catalog.json", "regions_builtin.json"):
            value = json.loads((reference_root / name).read_text(encoding="utf-8"))
            if not isinstance(value, (dict, list)):
                return None
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(manifest, dict):
        return None
    tables = manifest.get("tables")
    if not isinstance(tables, dict) or not set(TABLES).issubset(tables):
        return None
    matches = tables.get("matches")
    if not (isinstance(matches, dict) and type(matches.get("rows")) is int and matches["rows"] > 0):
        return None
    return _table_witnesses(manifest.get("files"))


def _table_witnesses(files: Any) -> tuple[str, ...] | None:
    """Select one manifest-declared Parquet file per table without walking the dataset."""
    if not isinstance(files, list):
        return None
    witnesses: dict[str, str] = {}
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            continue
        relative = entry["path"]
        table = relative.split("/", 1)[0]
        if table in TABLES and table not in witnesses:
            witnesses[table] = relative
            if len(witnesses) == len(TABLES):
                break
    if set(witnesses) != set(TABLES):
        return None
    return tuple(witnesses[table] for table in sorted(TABLES))


def _has_table_witnesses(silver_dir: Path, witnesses: tuple[str, ...]) -> bool:
    """Stat the fixed witness set on each probe so file deletion is noticed immediately."""
    if len(witnesses) != len(TABLES):
        return False
    root = silver_dir.resolve()
    for relative in witnesses:
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or target.suffix != ".parquet":
            return False
        signature = _file_signature(target)
        if signature is None or not _valid_parquet_witness(str(target), signature):
            return False
    return True


@lru_cache(maxsize=128)
def _valid_parquet_witness(path: str, signature: tuple[int, int]) -> bool:
    """Validate a witness once per file revision while keeping readiness I/O bounded."""
    if signature[1] <= 0:
        return False
    try:
        pq.read_metadata(path)
    except (OSError, ValueError):
        return False
    return True
