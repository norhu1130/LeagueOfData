"""Register shared DuckDB views for backend and validation tools."""

from __future__ import annotations

from pathlib import Path

import duckdb

VIEWS_SQL = Path(__file__).with_name("views.sql")

#: Logical tables that exist only as views and may be referenced by catalog bindings.
DERIVED_VIEWS = (
    "v_deaths",
    "v_event_assists",
    "v_first_blood",
    "v_solo_kills",
    "v_dragon_soul_acquired",
    "v_first_tower",
)


def register_views(con: duckdb.DuckDBPyConnection, silver_root: Path | str) -> list[str]:
    """Register views over a silver directory and return their names.

    Missing table directories are skipped so readiness can report a partial dataset.
    """
    root = str(silver_root).rstrip("/")
    remote = root.startswith(("s3://", "gs://", "gcs://"))
    # The root is embedded in a SQL string literal in views.sql. Remote roots are validated by
    # the API, while escaping also keeps local paths containing apostrophes well formed.
    sql = VIEWS_SQL.read_text(encoding="utf-8").replace("{root}", root.replace("'", "''"))
    created: list[str] = []
    for statement in (s.strip() for s in sql.split(";")):
        # Comment-only fragments have no name, but statements may legitimately start with comments.
        name = _view_name(statement)
        if name is None:
            continue
        if not name.startswith("v_") and not remote and not (Path(root) / name).exists():
            continue
        try:
            con.execute(statement)
        except duckdb.Error:
            # A missing base table can prevent creation of a derived view.
            continue
        if name:
            created.append(name)
    return created


def _view_name(statement: str) -> str | None:
    marker = "CREATE OR REPLACE VIEW "
    idx = statement.find(marker)
    if idx < 0:
        return None
    rest = statement[idx + len(marker) :].strip()
    return rest.split()[0]
