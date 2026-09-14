"""DuckDB connection management with one process-wide database and per-query cursors."""

from __future__ import annotations

import contextlib
from functools import lru_cache
from pathlib import Path

import duckdb

from lod_api.config import settings


@lru_cache(maxsize=1)
def get_database() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    con.execute(f"SET threads = {settings.effective_duckdb_threads}")
    con.execute(f"SET memory_limit = '{settings.effective_duckdb_memory_limit}'")
    if settings.effective_duckdb_temp_directory_limit is not None:
        con.execute(
            f"SET max_temp_directory_size = '{settings.effective_duckdb_temp_directory_limit}'"
        )
    # Reuse Parquet metadata to reduce repeated-query latency.
    con.execute("SET enable_object_cache = true")
    tmp = settings.data_dir / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    con.execute(f"SET temp_directory = '{tmp}'")
    # Load a preinstalled spatial extension when available. Never download executable extensions at
    # runtime; offline and packaged environments use the compiler's pure-SQL geometry fallback.
    with contextlib.suppress(duckdb.Error):
        con.execute("LOAD spatial;")
    _register(con)
    return con


def _register(con: duckdb.DuckDBPyConnection) -> list[str]:
    from lod_data.duckdb_views import register_views

    return register_views(con, settings.silver_dir)


def refresh_views() -> list[str]:
    """Register views again after data ingestion."""
    return _register(get_database())


def cursor() -> duckdb.DuckDBPyConnection:
    """Create an independently interruptible cursor sharing catalogs and buffers."""
    return get_database().cursor()


def has_spatial(con: duckdb.DuckDBPyConnection | None = None) -> bool:
    c = con or get_database()
    try:
        c.execute("SELECT ST_Point(0, 0)").fetchone()
        return True
    except duckdb.Error:
        return False


def dataset_snapshot_id() -> str | None:
    """Return the current dataset content hash used by cache keys."""
    from lod_api.data_sources import active_dataset_metadata

    return active_dataset_metadata()[1]


def silver_exists() -> bool:
    root: Path = settings.silver_dir
    return root.exists() and any(p.is_dir() for p in root.iterdir())
