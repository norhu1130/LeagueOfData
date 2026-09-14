"""Catalog loading and schema-drift defenses."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pytest
from fastapi import Response
from lod_api.catalog import Catalog, load_catalog, verify_against_schema
from lod_api.compile.planner import PlanBuilder, PlanError
from lod_data.duckdb_views import register_views
from lod_data.synth.writer import write_dataset

REFERENCE = Path(__file__).resolve().parents[3] / "data" / "reference" / "catalog.json"


@pytest.fixture(scope="module")
def catalog() -> Catalog:
    return load_catalog()


@pytest.fixture(scope="module")
def con(tmp_path_factory: pytest.TempPathFactory) -> duckdb.DuckDBPyConnection:
    root = tmp_path_factory.mktemp("silver")
    write_dataset(300, root, seed=31337, workers=1, chunk_size=300, progress=False)
    c = duckdb.connect()
    register_views(c, root)
    return c


class TestLoader:
    def test_loads_generated_catalog(self, catalog: Catalog) -> None:
        assert catalog.hash.startswith("sha256:")
        assert catalog.version
        assert catalog.map_span == 15000.0

    def test_matches_typescript_generated_file(self, catalog: Catalog) -> None:
        raw = json.loads(REFERENCE.read_text(encoding="utf-8"))
        assert raw["hash"] == catalog.hash
        assert raw["catalogVersion"] == catalog.version

    def test_refreshes_when_the_generated_file_changes(self, tmp_path: Path) -> None:
        target = tmp_path / "catalog.json"
        raw = json.loads(REFERENCE.read_text(encoding="utf-8"))
        raw["catalogVersion"] = "revision-one"
        target.write_text(json.dumps(raw), encoding="utf-8")
        assert load_catalog(target).version == "revision-one"

        raw["catalogVersion"] = "revision-two-longer"
        target.write_text(json.dumps(raw), encoding="utf-8")
        assert load_catalog(target).version == "revision-two-longer"

    def test_resolves_alias_surfaces(self, catalog: Catalog) -> None:
        assert catalog.resolve_surface("first_turret_destroy") == ("turret_destroy", "first")
        assert catalog.resolve_surface("kill") == ("kill", "any")
        with pytest.raises(KeyError):
            catalog.resolve_surface("없는사건")

    def test_loads_map_landmark(self, catalog: Catalog) -> None:
        landmark = catalog.landmark("blue.top_outer_turret")
        assert landmark["xRaw"] == 981
        assert landmark["yRaw"] == 10441
        with pytest.raises(KeyError):
            catalog.landmark("blue.없는건물")

    def test_unavailable_events_excluded_by_default(self, catalog: Catalog) -> None:
        ids = {e.id for e in catalog.events()}
        assert "turret_damage" not in ids
        assert "turret_damage" in {e.id for e in catalog.events(include_unavailable=True)}

    def test_endpoint_includes_dataset_facets_and_map_regions(
        self, con: duckdb.DuckDBPyConnection, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from lod_api.routers import catalog as catalog_router

        monkeypatch.setattr(catalog_router, "cursor", con.cursor)
        body = catalog_router.get_catalog(Response())
        assert len(body["mapRegions"]) == 16
        assert body["champions"]
        assert body["items"]
        assert body["patches"] == ["14.19"]
        assert body["queues"] == ["RANKED_SOLO_5x5"]
        assert body["platformRegions"] == ["SYNTH"]
        assert body["tiers"] == ["GOLD"]

    def test_synthetic_source_preserves_the_static_catalog(self, catalog: Catalog) -> None:
        effective = catalog.for_source("synthetic_v1")

        assert effective is catalog
        assert effective.hash == catalog.hash
        assert effective.event("recall").available is True
        assert "position" in effective.event("ward_placed").context

    def test_riot_source_disables_only_confirmed_missing_capabilities(
        self, catalog: Catalog
    ) -> None:
        effective = catalog.for_source("riot_v5")

        assert effective.hash != catalog.hash
        assert effective.event("recall").available is False
        assert "position" not in effective.event("ward_placed").context
        assert "position" not in effective.event("ward_destroyed").context
        assert effective.event("kill").available is True
        assert "position" in effective.event("kill").context

    def test_endpoint_exposes_effective_source_capabilities(
        self,
        catalog: Catalog,
        con: duckdb.DuckDBPyConnection,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from lod_api.routers import catalog as catalog_router

        monkeypatch.setattr(catalog_router, "cursor", con.cursor)
        monkeypatch.setattr(catalog_router, "dataset_source", lambda: "riot_v5")
        monkeypatch.setattr(catalog_router, "load_catalog", lambda: catalog)

        body = catalog_router.get_catalog(Response())

        assert body["datasetSource"] == "riot_v5"
        assert body["events"]["recall"]["available"] is False
        assert "position" not in body["events"]["ward_placed"]["context"]
        assert body["sourceCapabilities"]["contexts"]["ward_placed"]["position"] == {
            "available": False,
            "reasonKo": "Riot 타임라인의 와드 설치 사건에는 위치 좌표가 제공되지 않습니다.",
        }

    def test_riot_planning_rejects_recall_and_ward_position(self, catalog: Catalog) -> None:
        effective = catalog.for_source("riot_v5")
        recall_ast = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "tests/conformance/cases/dod-a-first-blood-win-rate/expected.ast.json"
            ).read_text(encoding="utf-8")
        )
        recall = recall_ast["body"]["when"]["event"]
        recall.update(bindingId="blue.recall#any", eventType="recall", surface="recall")
        with pytest.raises(PlanError, match="데이터에 없습니다"):
            PlanBuilder(effective).build(recall_ast)

        spatial_ast = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "tests/conformance/cases/dod-e-death-in-region/expected.ast.json"
            ).read_text(encoding="utf-8")
        )
        ward = spatial_ast["body"]["when"]["position"]["object"]
        ward.update(
            bindingId="blue.ward_placed#any",
            eventType="ward_placed",
            surface="ward_placed",
        )
        shapes = {"custom_region_1": {"kind": "rect", "x0": 0, "y0": 0, "x1": 1, "y1": 1}}
        with pytest.raises(PlanError, match="위치 정보를 사용할 수 없습니다"):
            PlanBuilder(effective).build(spatial_ast, regions=shapes)

    def test_no_hardcoded_event_names_in_compiler(self) -> None:
        """Compiler source must not hard-code catalog event names."""
        api_src = Path(__file__).resolve().parents[1] / "src" / "lod_api"
        offenders: list[str] = []
        for path in api_src.rglob("*.py"):
            if path.name == "catalog.py":
                continue
            text = path.read_text(encoding="utf-8")
            for name in ("'first_blood'", '"first_blood"', "'dragon_kill'", '"dragon_kill"'):
                if name in text:
                    offenders.append(f"{path.name}: {name}")
        assert not offenders, "Event names are hard-coded outside the catalog:\n" + "\n".join(
            offenders
        )


class TestSchemaDrift:
    def test_every_referenced_column_exists(
        self, con: duckdb.DuckDBPyConnection, catalog: Catalog
    ) -> None:
        check = verify_against_schema(con, catalog)
        detail = "\n".join(
            [f"missing table: {t}" for t in check.missing_tables]
            + [f"missing column: {t}.{c}" for t, c in check.missing_columns]
        )
        assert check.ok, detail

    def test_every_available_binding_executes(
        self, con: duckdb.DuckDBPyConnection, catalog: Catalog
    ) -> None:
        for event in catalog.events():
            con.execute(f"SELECT count(*) FROM {event.table} WHERE {event.where}").fetchone()

    def test_every_available_binding_returns_rows(
        self, con: duckdb.DuckDBPyConnection, catalog: Catalog
    ) -> None:
        """Every suggested event should have at least one representative generated row."""
        empty = []
        for event in catalog.events():
            (n,) = con.execute(f"SELECT count(*) FROM {event.table} WHERE {event.where}").fetchone()
            if n == 0:
                empty.append(event.id)
        assert not empty, f"events absent from generated data: {empty}"

    def test_detects_missing_column(self, catalog: Catalog) -> None:
        """Verify that the drift check itself detects a missing column."""
        broken = duckdb.connect()
        broken.execute("CREATE TABLE events (match_id VARCHAR)")
        check = verify_against_schema(broken, catalog)
        assert not check.ok
        assert any(c == "timestamp_ms" for _, c in check.missing_columns)

    def test_context_field_sql_columns_exist(
        self, con: duckdb.DuckDBPyConnection, catalog: Catalog
    ) -> None:
        """Verify context-field SQL expressions against physical event columns."""
        for event in catalog.events():
            if event.table != "events":
                continue
            for field_id in event.context:
                field = catalog.context_field(field_id)
                sql = field["sql"]
                exprs = list(sql.values()) if isinstance(sql, dict) else [sql]
                for expr in exprs:
                    con.execute(
                        f"SELECT {expr} FROM {event.table} WHERE {event.where} LIMIT 1"
                    ).fetchone()


class TestForbiddenPhrases:
    def test_catalog_korean_text_avoids_causal_claims(self, catalog: Catalog) -> None:
        """Section 23 forbids causal claims in localized catalog copy."""
        forbidden = catalog.forbidden_phrases
        violations: list[str] = []

        def walk(node: object, path: str) -> None:
            if isinstance(node, str):
                if path.split(".")[-1].endswith("Ko"):
                    for phrase in forbidden:
                        if phrase in node:
                            violations.append(f"{path}: '{phrase}'")
            elif isinstance(node, dict):
                for k, v in node.items():
                    walk(v, f"{path}.{k}")
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, f"{path}[{i}]")

        data = dict(catalog.as_dict())
        data.pop("forbiddenPhrases", None)
        walk(data, "catalog")
        assert not violations, "\n".join(violations)
