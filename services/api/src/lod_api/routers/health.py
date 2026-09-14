"""Separate process liveness from dataset readiness."""

from __future__ import annotations

import json
from typing import Any

import duckdb
from fastapi import APIRouter, Response, status
from lod_data.layout import read_manifest
from lod_data.schema import TABLES

from lod_api.config import settings

router = APIRouter(tags=["health"])


@router.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"status": "ok", "engine": f"duckdb-{duckdb.__version__}"}


@router.get("/readyz")
def readyz(response: Response) -> dict[str, Any]:
    """Report reference-data and dataset readiness independently."""
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
    except (OSError, json.JSONDecodeError) as exc:
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
