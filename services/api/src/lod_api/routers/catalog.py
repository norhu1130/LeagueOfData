"""Catalog endpoints for language tooling and visual-builder choices."""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any

from fastapi import APIRouter, Response
from lod_data.regions import preset_regions

from lod_api.catalog import (
    dataset_source,
    load_catalog,
    load_effective_catalog,
    verify_against_schema,
)
from lod_api.config import settings
from lod_api.db import cursor, dataset_snapshot_id

router = APIRouter(prefix="/api/v1", tags=["catalog"])
logger = logging.getLogger(__name__)


@router.get("/catalog")
def get_catalog(response: Response) -> dict[str, Any]:
    source = dataset_source()
    catalog = load_catalog().for_source(source)
    snapshot = dataset_snapshot_id()
    # Let the frontend reuse data while both catalog and dataset remain unchanged.
    response.headers["ETag"] = f'W/"{catalog.hash}:{snapshot or "nodata"}"'
    response.headers["Cache-Control"] = "no-store" if settings.public_instance else "no-cache"
    data = deepcopy(catalog.as_dict()) if settings.public_instance else dict(catalog.as_dict())
    data["datasetSnapshotId"] = snapshot
    data["datasetSource"] = source
    data.setdefault("sourceCapabilities", {"events": {}, "contexts": {}})
    data["instanceCapabilities"] = {
        "publicInstance": settings.public_instance,
        # Public visitors may use only the server-owned, spending-limited key. Session key
        # configuration remains outside the public route allowlist.
        "ai": not settings.public_instance or settings.openrouter_api_key is not None,
        "dataSourceManagement": not settings.public_instance,
        "matchDrilldown": not settings.public_instance,
        "diagnostics": not settings.public_instance,
    }
    data["mapRegions"] = [
        {
            "id": region.id,
            "label": region.label,
            "origin": region.origin,
            "coordSpace": region.coord_space,
            "shape": region.shape,
        }
        for region in preset_regions().values()
    ]
    data.update(_dataset_facets())
    if settings.public_instance:
        _redact_public_catalog(data)
    return data


def _redact_public_catalog(data: dict[str, Any]) -> None:
    """Remove compiler-only schema and SQL metadata from the public browser catalog."""
    data.pop("tables", None)
    data.pop("referencedColumns", None)
    for event in data.get("events", {}).values():
        if isinstance(event, dict):
            event.pop("sqlBinding", None)
    for collection in ("contextFields", "subjectFields", "groupKeys"):
        for definition in data.get(collection, {}).values():
            if isinstance(definition, dict):
                definition.pop("sql", None)
                definition.pop("table", None)


def _dataset_facets() -> dict[str, list[Any]]:
    """Return only picker values that are present in the current snapshot."""
    con = cursor()
    try:
        champions = [
            {"id": int(champion_id), "name": champion}
            for champion_id, champion in con.execute(
                "SELECT DISTINCT champion_id, champion FROM participants "
                "WHERE champion IS NOT NULL ORDER BY champion"
            ).fetchall()
        ]
        items = [
            {"id": int(item_id)}
            for (item_id,) in con.execute(
                "SELECT DISTINCT item_id FROM events "
                "WHERE event_type = 'item_purchase' AND item_id IS NOT NULL ORDER BY item_id"
            ).fetchall()
        ]
        patches = sorted(
            {
                str(row[0]).strip()
                for row in con.execute(
                    "SELECT DISTINCT patch FROM matches "
                    "WHERE patch IS NOT NULL AND trim(patch) <> ''"
                ).fetchall()
            },
            key=_patch_sort_key,
            reverse=True,
        )
        queues = [
            row[0]
            for row in con.execute("SELECT DISTINCT queue FROM matches ORDER BY queue").fetchall()
        ]
        platform_regions = [
            row[0]
            for row in con.execute("SELECT DISTINCT region FROM matches ORDER BY region").fetchall()
        ]
        try:
            tiers = [
                row[0]
                for row in con.execute(
                    "SELECT DISTINCT tier FROM matches WHERE tier IS NOT NULL ORDER BY tier"
                ).fetchall()
            ]
        except Exception:  # Older snapshots remain readable until regenerated.
            tiers = []
    except Exception:  # Static language metadata remains available before data generation.
        champions, items, patches, queues, platform_regions, tiers = [], [], [], [], [], []
    finally:
        con.close()
    return {
        "champions": champions,
        "items": items,
        "patches": patches,
        "queues": queues,
        "platformRegions": platform_regions,
        "tiers": tiers,
    }


def _patch_sort_key(patch: str) -> tuple[int, ...]:
    """Sort Riot major/minor patch labels numerically instead of lexicographically."""
    try:
        return tuple(int(part) for part in patch.split("."))
    except ValueError:
        return (-1,)


@router.get("/catalog/health")
def catalog_health() -> dict[str, Any]:
    """Verify catalog bindings against the physical dataset."""
    catalog = load_effective_catalog()
    con = cursor()
    try:
        check = verify_against_schema(con, catalog)
        bindings: list[dict[str, Any]] = []
        for event in catalog.events(include_unavailable=False):
            try:
                (n,) = con.execute(
                    f"SELECT count(*) FROM {event.table} WHERE {event.where}"
                ).fetchone()
                bindings.append({"event": event.id, "rows": int(n), "error": None})
            except Exception:  # noqa: BLE001 — report every diagnostic failure
                logger.exception("Catalog binding health check failed for %s", event.id)
                bindings.append({"event": event.id, "rows": None, "error": "E-CAT-001"})
    finally:
        con.close()

    empty = [b["event"] for b in bindings if b["rows"] == 0]
    broken = [b["event"] for b in bindings if b["error"]]
    return {
        "catalogVersion": catalog.version,
        "catalogHash": catalog.hash,
        "schema": check.as_dict(),
        "bindings": bindings,
        "emptyBindings": empty,
        "brokenBindings": broken,
        "ok": check.ok and not broken,
        # Empty bindings are warnings because a dataset may legitimately contain no such event.
        "warningKo": (
            f"다음 사건이 이 데이터셋에 하나도 없습니다: {', '.join(empty)}" if empty else None
        ),
    }
