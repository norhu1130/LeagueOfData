"""Regression tests for the PhysicalPlan/ExecutionEngine boundary."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pyarrow as pa
import pytest
from lod_api.catalog import load_catalog
from lod_api.compile.plan import AtomKind, DatasetFilter
from lod_api.compile.planner import PlanBuilder, PlanError
from lod_api.compile.sql import SqlCompiler
from lod_api.engine.duckdb_engine import DuckDBEngine
from lod_api.engine.interface import ExecutionEngine

CASES = Path(__file__).resolve().parents[3] / "tests" / "conformance" / "cases"


def _plan(case: str):
    ast = json.loads((CASES / case / "expected.ast.json").read_text(encoding="utf-8"))
    return PlanBuilder().build(ast)


def _plan_with_regions(case: str, regions: dict):
    ast = json.loads((CASES / case / "expected.ast.json").read_text(encoding="utf-8"))
    return PlanBuilder().build(ast, regions=regions)


def test_duckdb_satisfies_execution_engine_protocol() -> None:
    engine = DuckDBEngine()
    assert isinstance(engine, ExecutionEngine)
    assert engine.capabilities().interrupt is True


def test_dataset_queue_and_tier_filters_are_parameterized() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    plan = PlanBuilder().build(ast, dataset=DatasetFilter(queue="SWIFTPLAY", tier="GOLD"))
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert "m.queue =" in query.sql
    assert "m.tier =" in query.sql
    assert "SWIFTPLAY" in query.params.values()
    assert "GOLD" in query.params.values()


def test_pick_rate_uses_match_presence_and_parameterizes_champion() -> None:
    ast = {
        "kind": "Program",
        "analyze": {"kind": "ScopeRef", "entity": "match"},
        "body": {
            "kind": "SimpleStmt",
            "chain": None,
            "when": None,
            "groupBy": [],
            "returns": [
                {
                    "kind": "ReturnItem",
                    "expr": {
                        "kind": "CallExpr",
                        "callee": "pick_rate",
                        "scope": None,
                        "args": [{"kind": "StringLit", "value": "Ahri"}],
                    },
                    "alias": "pick_rate",
                }
            ],
        },
    }

    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.grain == "match"
    assert plan.measures[0].params["champion"] == "Ahri"
    assert "SELECT DISTINCT champion_player.match_id FROM participants champion_player" in query.sql
    assert "Ahri" in query.params.values()
    assert "Ahri" not in query.sql

    matched = SqlCompiler(plan, load_catalog(), has_spatial=False).compile_matched_ids()
    assert "Ahri" not in matched.params.values()


def test_opponent_roster_condition_is_team_relative_and_parameterized() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    ast["analyze"] = {"kind": "ScopeRef", "entity": "team"}
    ast["body"]["returns"][0]["expr"]["scope"] = None
    ast["body"]["when"] = {
        "kind": "CallExpr",
        "callee": "opponent_has_champion",
        "scope": None,
        "args": [
            {"kind": "StringLit", "value": champion}
            for champion in ("Trundle", "Briar", "Vladimir", "Aatrox")
        ],
    }
    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.atoms[0].kind == AtomKind.ROSTER
    assert "FROM participants roster" in query.sql
    assert "roster.team_id <> base.team_id" in query.sql
    assert all(
        champion in query.params.values() for champion in ("Trundle", "Briar", "Vladimir", "Aatrox")
    )


def test_ally_roster_condition_uses_ally_label_and_excludes_the_subject_player() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    ast["analyze"] = {"kind": "ScopeRef", "entity": "player"}
    ast["body"]["returns"][0]["expr"]["scope"] = None
    ast["body"]["when"] = {
        "kind": "CallExpr",
        "callee": "ally_has_champion",
        "scope": None,
        "args": [{"kind": "StringLit", "value": "Rakan"}],
    }

    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.atoms[0].label_ko == "같은 팀에 Rakan 챔피언이 있습니다"
    assert plan.atoms[0].dsl == "ally_has_champion(Rakan)"
    assert "roster.team_id = base.team_id" in query.sql
    assert "roster.participant_id <> base.participant_id" in query.sql


def _point_in_time_item_ast(function: str, *, negated: bool = False) -> dict:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    ast["analyze"] = {"kind": "ScopeRef", "entity": "team"}
    ast["body"]["returns"][0]["expr"]["scope"] = None
    call = {
        "kind": "CallExpr",
        "callee": function,
        "scope": None,
        "args": [
            {"kind": "ClockLit", "seconds": 900, "raw": "15:00"},
            {"kind": "NumberLit", "value": 3165},
            {"kind": "NumberLit", "value": 6609},
        ],
    }
    ast["body"]["when"] = {"kind": "UnaryExpr", "op": "NOT", "operand": call} if negated else call
    return ast


def test_purchase_by_landmark_is_team_relative_and_excludes_short_matches() -> None:
    plan = PlanBuilder().build(_point_in_time_item_ast("purchased_item_by", negated=True))
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.atoms[0].kind == AtomKind.ITEM_STATE
    assert "m.duration_s >=" in query.sql
    assert "item_event.team_id = base.team_id" in query.sql
    assert "item_event.timestamp_ms <=" in query.sql
    assert "item_event.event_type = 'item_purchase'" in query.sql
    assert 900 in query.params.values()
    assert 900_000 in query.params.values()


def test_owned_at_landmark_reconstructs_sales_destruction_and_undo() -> None:
    plan = PlanBuilder().build(_point_in_time_item_ast("owns_item_at"))
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert "'item_sell', 'item_destroy', 'item_undo'" in query.sql
    assert "item_event.item_after_id" in query.sql
    assert "HAVING sum(inventory_delta.delta) > 0" in query.sql


def test_point_in_time_item_condition_accepts_swiftplay_item_ids() -> None:
    ast = _point_in_time_item_ast("owns_item_at")
    ast["body"]["when"]["args"][1]["value"] = 323_075

    plan = PlanBuilder().build(ast)

    assert plan.atoms[0].params["item_ids"] == [323_075, 6609]


def test_player_item_condition_can_target_the_opposing_team() -> None:
    ast = _point_in_time_item_ast("owns_item_at")
    ast["analyze"] = {"kind": "ScopeRef", "entity": "player"}
    ast["body"]["when"]["scope"] = {
        "kind": "ScopeRef",
        "entity": "team",
        "relation": "opponent-of-trigger",
    }
    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert "item_event.team_id <> base.team_id" in query.sql


def test_provenance_exposes_the_columns_it_returns() -> None:
    query = SqlCompiler(
        _plan("dod-a-first-blood-win-rate"), load_catalog(), has_spatial=False
    ).compile_provenance()

    assert query.columns == [
        "total_units",
        "total_matches",
        "alone_f0",
        "cum_0",
        "matched_units",
        "matched_matches",
        "baseline_m0",
    ]
    assert "avg(CASE WHEN unit_win THEN 1.0 ELSE 0.0 END) AS baseline_m0" in query.sql
    assert query.funnel_columns == ["alone_f0", "cum_0"]


def test_combined_query_materializes_flagged_once_for_result_and_provenance() -> None:
    query = SqlCompiler(
        _plan("dod-a-first-blood-win-rate"), load_catalog(), has_spatial=False
    ).compile_combined()
    assert query.sql.count("flagged AS (") == 1
    assert "_result AS" in query.sql
    assert "_provenance AS" in query.sql
    assert query.result_columns == ["m0", "n"]
    assert "baseline_m0" in query.provenance_columns


def test_negated_compare_arm_has_its_own_funnel_count_and_label() -> None:
    plan = _plan("compare-first-blood")
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile_provenance()

    assert "NOT coalesce" in query.sql
    assert plan.atoms[1].label_ko.endswith("기록하지 않았습니다")

    # Also lock the regression where Arrow failed to preserve SQL result column names.
    table = pa.table(
        {
            "total_units": [10_000],
            "total_matches": [10_000],
            "alone_f0": [5_025],
            "alone_f1": [4_975],
            "matched_units": [10_000],
            "matched_matches": [10_000],
            "baseline_m0": [0.51],
        }
    )
    stats = DuckDBEngine()._build_stats(plan, table, query, 1.5)
    assert [c["matchedAlone"] for c in stats.conditions] == [5_025, 4_975]
    assert stats.baseline_values == {"m0": 0.51}


def test_team_base_carries_summary_columns_for_position_grouping() -> None:
    query = SqlCompiler(
        _plan("group-by-position-region"), load_catalog(), has_spatial=False
    ).compile()

    assert "FROM match_summary s" in query.sql
    assert "first_blood_region AS position_region" in query.sql


def test_bucket_group_carries_event_time_into_the_matched_rows() -> None:
    plan = _plan("bucket-time")
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.group_keys[0].alias == "bucket"
    assert len(plan.bindings) == 2
    assert plan.bindings[0].team_side == "blue"
    assert plan.bindings[1].team_side is None
    assert "e1.timestamp_ms AS e1__timestamp_ms" in query.sql
    assert "floor((e1__timestamp_ms / 1000.0) / 60.0) * 60.0" in query.sql


def test_spatial_radius_uses_catalog_landmark_instead_of_origin() -> None:
    plan = _plan("spatial-within-radius")
    atom = plan.atoms[0]
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert atom.params["target_x"] == 981
    assert atom.params["target_y"] == 10441
    assert 981 in query.params.values()
    assert 10441 in query.params.values()
    assert "EXISTS (SELECT 1 FROM v_deaths ev" in query.sql


def test_duration_provenance_counts_only_defined_measurements() -> None:
    plan = _plan("dod-c-first-blood-to-turret")
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile_provenance()

    assert "defined_m0" in query.columns
    assert "e0__timestamp_ms IS NOT NULL" in query.sql
    assert "e1__timestamp_ms IS NOT NULL" in query.sql
    assert plan.measures[0].unit == "seconds"
    assert plan.measures[0].decimals == 0


def test_after_temporal_condition_orders_right_then_left() -> None:
    ast = json.loads((CASES / "temporal-between" / "expected.ast.json").read_text())
    when = ast["body"]["when"]
    assert when["kind"] == "BinaryExpr"
    first = when["left"]["event"]
    later = {
        **first,
        "bindingId": "blue.turret_destroy#first",
        "eventType": "turret_destroy",
        "ordinal": "first",
        "surface": "first_turret_destroy",
    }
    ast["body"]["when"] = {
        "kind": "TemporalPredicate",
        "relation": "AFTER",
        "left": later,
        "right": first,
        "rightUpper": None,
        "window": {"kind": "DurationLit", "seconds": 600, "raw": "10m"},
    }
    plan = PlanBuilder().build(ast)
    atom = plan.atoms[0]
    assert atom.params["start"] == "e1"
    assert atom.params["end"] == "e0"


def test_repeatable_event_region_is_an_existential_condition() -> None:
    plan = _plan_with_regions(
        "dod-e-death-in-region",
        {"custom_region_1": {"kind": "rect", "x0": 0, "y0": 0.55, "x1": 0.35, "y1": 1}},
    )
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert "EXISTS (SELECT 1 FROM v_deaths ev" in query.sql
    assert "ev.team_id" in query.sql
    assert "ev.x_norm BETWEEN" in query.sql


def test_event_occurrence_and_location_share_one_repeatable_event_row() -> None:
    ast = json.loads((CASES / "dod-e-death-in-region" / "expected.ast.json").read_text())
    spatial = ast["body"]["when"]
    event = spatial["position"]["object"]
    ast["body"]["when"] = {
        "kind": "BinaryExpr",
        "op": "AND",
        "left": {"kind": "EventPredicate", "event": event, "negated": False},
        "right": spatial,
    }
    regions = {"custom_region_1": {"kind": "rect", "x0": 0, "y0": 0.55, "x1": 0.35, "y1": 1}}
    plan = PlanBuilder().build(ast, regions=regions)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert len(plan.atoms) == 1
    assert plan.atoms[0].kind == AtomKind.EVENT_GROUP
    assert query.sql.count("EXISTS (SELECT 1 FROM v_deaths ev") == 1
    assert "ev.x_norm BETWEEN" in query.sql


def test_rate_lowers_its_boolean_argument_instead_of_a_constant() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    condition = ast["body"]["when"]
    ast["body"]["when"] = None
    ast["body"]["returns"][0]["expr"] = {
        "kind": "CallExpr",
        "callee": "rate",
        "args": [condition],
    }

    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.measures[0].params["condition"].atom == "f0"
    assert "avg(CASE WHEN f0 THEN 1.0 ELSE 0.0 END)" in query.sql


def test_point_in_time_measure_can_be_aggregated() -> None:
    ast = json.loads((CASES / "dod-d-gold-lead-win-rate" / "expected.ast.json").read_text())
    measure_at = ast["body"]["when"]["left"]
    ast["body"]["when"] = None
    ast["body"]["returns"][0]["expr"] = {
        "kind": "CallExpr",
        "callee": "avg",
        "args": [measure_at],
    }

    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.measures[0].unit == "gold"
    assert "g0.value AS g0__value" in query.sql
    assert "avg(g0__value) AS m0" in query.sql


def test_unsupported_aggregate_argument_is_rejected_instead_of_becoming_one() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    ast["body"]["returns"][0]["expr"] = {
        "kind": "CallExpr",
        "callee": "avg",
        "args": [{"kind": "StringLit", "value": "not numeric"}],
    }

    with pytest.raises(PlanError, match="집계할 수 없는"):
        PlanBuilder().build(ast)


def test_compiler_rejects_an_untrusted_comparison_operator() -> None:
    ast = json.loads((CASES / "dod-d-gold-lead-win-rate" / "expected.ast.json").read_text())
    ast["body"]["when"]["op"] = ">= 0 OR read_text('/etc/passwd') IS NOT NULL OR"

    with pytest.raises(PlanError, match="비교 연산자"):
        PlanBuilder().build(ast)


def test_sql_compiler_rejects_an_operator_injected_into_a_physical_plan() -> None:
    plan = _plan("dod-d-gold-lead-win-rate")
    atom = replace(
        plan.atoms[0],
        params={
            **plan.atoms[0].params,
            "op": ">= 0 OR EXISTS(SELECT 1 FROM read_text('/etc/hosts')) OR g0.value =",
        },
    )
    untrusted_plan = replace(plan, atoms=(atom,))

    with pytest.raises(ValueError, match="Unsupported comparison operator"):
        SqlCompiler(untrusted_plan, load_catalog(), has_spatial=False).compile()


def test_player_selector_filters_base_rows_and_scopes_event_witnesses() -> None:
    ast = json.loads((CASES / "spec-14-ex5-player-champion" / "expected.ast.json").read_text())
    ast["analyze"]["selector"] = "Hide on bush"
    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.player_selector == "Hide on bush"
    assert "p.riot_id =" in query.sql
    assert "p.summoner_name =" in query.sql
    assert "Hide on bush" in query.params.values()
    columns = SqlCompiler(plan, load_catalog(), has_spatial=False).compile_matched_ids().columns
    assert columns[:3] == [
        "match_id",
        "team_id",
        "participant_id",
    ]
    assert columns[3:] == ["truth_f0", "truth_f1", "truth_f2"]


def test_inconsistent_measure_side_is_rejected() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    ast["body"]["returns"][0]["expr"]["scope"]["side"] = "red"

    with pytest.raises(PlanError, match="진영"):
        PlanBuilder().build(ast)


def test_inconsistent_frame_probe_side_is_rejected() -> None:
    ast = json.loads((CASES / "dod-d-gold-lead-win-rate" / "expected.ast.json").read_text())
    ast["body"]["when"]["left"]["scope"]["side"] = "red"

    with pytest.raises(PlanError, match="진영"):
        PlanBuilder().build(ast)


def test_repeatable_event_existence_uses_all_events_not_one_representative() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    event = ast["body"]["when"]["event"]
    event.update(bindingId="blue.kill#any", eventType="kill", surface="kill")
    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert "EXISTS (SELECT 1 FROM events ev" in query.sql
    assert "ev.team_id =" in query.sql


def test_repeatable_event_field_condition_uses_an_existential_event() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    event = ast["body"]["when"]["event"]
    event.update(bindingId="blue.kill#any", eventType="kill", surface="kill")
    ast["body"]["when"] = {
        "kind": "BinaryExpr",
        "left": {"kind": "FieldAccess", "object": event, "field": "time"},
        "op": ">",
        "right": {"kind": "DurationLit", "seconds": 600, "raw": "10m"},
    }

    query = SqlCompiler(PlanBuilder().build(ast), load_catalog(), has_spatial=False).compile()

    assert "EXISTS (SELECT 1 FROM events ev" in query.sql
    assert "ev.timestamp_ms / 1000.0" in query.sql


def test_repeatable_event_value_aggregate_is_rejected_as_ambiguous() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    event = ast["body"]["when"]["event"]
    event.update(bindingId="blue.kill#any", eventType="kill", surface="kill")
    ast["body"]["when"] = None
    ast["body"]["returns"][0]["expr"] = {
        "kind": "CallExpr",
        "callee": "avg",
        "args": [{"kind": "FieldAccess", "object": event, "field": "time"}],
    }

    with pytest.raises(PlanError, match="첫 번째 또는 마지막"):
        PlanBuilder().build(ast)


def test_player_scoped_event_is_rejected_for_team_analysis() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    event = ast["body"]["when"]["event"]
    event.update(
        bindingId="player(Faker).kill#any",
        eventType="kill",
        surface="kill",
        scope={"kind": "ScopeRef", "entity": "player", "selector": "Faker"},
    )

    with pytest.raises(PlanError, match="선수 단위"):
        PlanBuilder().build(ast)


def test_player_scoped_event_tracks_each_player_without_a_named_selector() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    ast["analyze"] = {"kind": "ScopeRef", "entity": "player"}
    event = ast["body"]["when"]["event"]
    event.update(
        bindingId="player.kill#any",
        eventType="kill",
        surface="kill",
        scope={"kind": "ScopeRef", "entity": "player"},
    )
    ast["body"]["returns"][0]["expr"] = {"kind": "CallExpr", "callee": "count", "args": []}

    plan = PlanBuilder().build(ast)
    sql = SqlCompiler(plan, load_catalog(), has_spatial=False).compile().sql

    assert plan.bindings[0].participant_scoped is True
    assert "ev.participant_id = base.participant_id" in sql


def test_explicit_any_team_scope_is_distinct_from_target_relative_scope() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    relative = ast["body"]["when"]["event"]
    relative["scope"] = None
    relative["bindingId"] = "relative.first_blood#any"

    relative_plan = PlanBuilder().build(ast)
    relative_sql = SqlCompiler(relative_plan, load_catalog(), has_spatial=False).compile().sql
    assert relative_plan.bindings[0].any_team is False
    assert relative_plan.bindings[0].per_team is True
    assert "base.team_id = e0.team_id" in relative_sql

    relative["scope"] = {"kind": "ScopeRef", "entity": "team"}
    relative["bindingId"] = "team.first_blood#any"
    any_plan = PlanBuilder().build(ast)
    any_sql = SqlCompiler(any_plan, load_catalog(), has_spatial=False).compile().sql
    assert any_plan.bindings[0].any_team is True
    assert any_plan.bindings[0].per_team is False
    assert "base.team_id = e0.team_id" not in any_sql


def test_explicit_any_team_scope_is_preserved_for_spatial_and_chain_conditions() -> None:
    spatial_ast = json.loads((CASES / "dod-e-death-in-region" / "expected.ast.json").read_text())
    event = spatial_ast["body"]["when"]["position"]["object"]
    event["scope"] = {"kind": "ScopeRef", "entity": "team"}
    event["bindingId"] = "team.death#any"
    spatial_plan = PlanBuilder().build(
        spatial_ast,
        regions={"custom_region_1": {"kind": "rect", "x0": 0, "y0": 0.55, "x1": 0.35, "y1": 1}},
    )
    spatial_sql = SqlCompiler(spatial_plan, load_catalog(), has_spatial=False).compile().sql
    assert spatial_plan.bindings[0].any_team is True
    assert "ev.team_id = base.team_id" not in spatial_sql

    chain_ast = json.loads((CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text())
    target = chain_ast["body"]["chain"]["condition"]["event"]
    target["scope"] = {"kind": "ScopeRef", "entity": "team"}
    target["bindingId"] = "team.dragon_kill#any"
    chain_plan = PlanBuilder().build(chain_ast)
    chain_sql = SqlCompiler(chain_plan, load_catalog(), has_spatial=False).compile().sql
    assert chain_plan.chain is not None and chain_plan.chain.target is not None
    assert chain_plan.chain.target.any_team is True
    assert "t.team_id = base.team_id" not in chain_sql


def test_chain_honors_explicit_target_side_and_strict_ordering() -> None:
    ast = json.loads((CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text())
    target = ast["body"]["chain"]["condition"]["event"]
    target["scope"] = {"kind": "ScopeRef", "entity": "team", "side": "red"}
    target["bindingId"] = "red.dragon_kill#any"

    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.chain is not None and plan.chain.target is not None
    assert plan.chain.target.team_side == "red"
    assert "t.team_id = base.team_id" not in query.sql
    assert "t.team_id =" in query.sql
    assert "t.timestamp_ms > base.trigger_ms" in query.sql
    assert "t.event_id > base.event_id" in query.sql
    assert 200 in query.params.values()


def test_chain_resolves_the_follow_up_team_relative_to_each_trigger() -> None:
    ast = json.loads((CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text())
    trigger = ast["body"]["chain"]["trigger"]
    trigger.update(
        bindingId="team.ward_placed#any",
        eventType="ward_placed",
        surface="ward_placed",
        scope={"kind": "ScopeRef", "entity": "team"},
    )
    target = ast["body"]["chain"]["condition"]["event"]
    target.update(
        bindingId="opponent-of-trigger.baron_kill#any",
        eventType="baron_kill",
        surface="baron_kill",
        scope={
            "kind": "ScopeRef",
            "entity": "team",
            "relation": "opponent-of-trigger",
        },
    )

    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.chain is not None
    assert plan.chain.opponent_team is True
    assert "t.team_id <> base.team_id" in query.sql
    assert "t.team_id = base.team_id" not in query.sql


def test_chain_honors_an_explicit_target_player_selector() -> None:
    ast = json.loads((CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text())
    target = ast["body"]["chain"]["condition"]["event"]
    target["scope"] = {
        "kind": "ScopeRef",
        "entity": "player",
        "selector": "SynthPlayer00000",
    }
    target["bindingId"] = "player(SynthPlayer00000).dragon_kill#any"

    plan = PlanBuilder().build(ast)
    query = SqlCompiler(plan, load_catalog(), has_spatial=False).compile()

    assert plan.chain is not None and plan.chain.target is not None
    assert plan.chain.target.participant_selector == "SynthPlayer00000"
    assert "scoped_player.participant_id = t.participant_id" in query.sql
    assert "SynthPlayer00000" in query.params.values()


def test_compare_with_grouping_is_rejected_explicitly() -> None:
    ast = json.loads((CASES / "compare-first-blood" / "expected.ast.json").read_text())
    ast["body"]["groupBy"] = [
        {
            "kind": "GroupKey",
            "expr": {"kind": "Identifier", "name": "patch"},
            "alias": None,
        }
    ]

    with pytest.raises(PlanError) as raised:
        PlanBuilder().build(ast)

    assert raised.value.code == "E-SEM-054"
    assert "함께 사용할 수 없습니다" in raised.value.message_ko


def test_compare_with_multiple_measures_is_planned() -> None:
    ast = json.loads((CASES / "compare-first-blood" / "expected.ast.json").read_text())
    ast["body"]["returns"].append(
        {
            "kind": "ReturnItem",
            "expr": {"kind": "CallExpr", "callee": "count", "scope": None, "args": []},
            "alias": None,
        }
    )

    plan = PlanBuilder().build(ast)

    assert [measure.function for measure in plan.measures] == ["win_rate", "count"]


def test_measure_valid_grain_is_enforced_by_the_planner() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    ast["analyze"] = {"kind": "ScopeRef", "entity": "match"}
    ast["body"]["returns"][0]["expr"] = {
        "kind": "CallExpr",
        "callee": "success_rate",
        "args": [],
    }

    with pytest.raises(PlanError, match="분석 단위"):
        PlanBuilder().build(ast)


def test_repeatable_temporal_events_use_existential_pair_matching() -> None:
    ast = json.loads((CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text())
    first = ast["body"]["when"]["event"]
    start = {**first, "bindingId": "blue.kill#any", "eventType": "kill", "surface": "kill"}
    end = {
        **first,
        "bindingId": "blue.dragon_kill#any",
        "eventType": "dragon_kill",
        "surface": "dragon_kill",
    }
    ast["body"]["when"] = {
        "kind": "TemporalPredicate",
        "relation": "AFTER",
        "left": end,
        "right": start,
        "rightUpper": None,
        "window": {"kind": "DurationLit", "seconds": 90, "raw": "90s"},
    }
    query = SqlCompiler(PlanBuilder().build(ast), load_catalog(), has_spatial=False).compile()

    assert "EXISTS (SELECT 1 FROM events tev_start CROSS JOIN events tev_end" in query.sql
    assert "tev_end.timestamp_ms::BIGINT - tev_start.timestamp_ms::BIGINT" in query.sql


def test_witnesses_use_timestamp_and_event_id_as_a_single_row_tie_break() -> None:
    query = SqlCompiler(
        _plan("dod-c-first-blood-to-turret"), load_catalog(), has_spatial=False
    ).compile()

    assert "struct_pack(ts := timestamp_ms, id := event_id)" in query.sql


def test_spatial_comparison_map_query_selects_from_flagged_arms() -> None:
    ast = json.loads((CASES / "dod-e-death-in-region" / "expected.ast.json").read_text())
    spatial = ast["body"]["when"]
    ast["body"] = {
        "kind": "CompareStmt",
        "arms": [
            {"kind": "CompareArm", "label": "inside", "when": spatial},
            {
                "kind": "CompareArm",
                "label": "outside",
                "when": {"kind": "UnaryExpr", "op": "NOT", "operand": spatial},
            },
        ],
        "groupBy": [],
        "returns": ast["body"]["returns"],
    }
    regions = {"custom_region_1": {"kind": "rect", "x0": 0, "y0": 0, "x1": 1, "y1": 1}}
    query = SqlCompiler(
        PlanBuilder().build(ast, regions=regions), load_catalog(), has_spatial=False
    ).compile_matched_points()

    assert query is not None
    assert "FROM (SELECT * FROM flagged WHERE" in query.sql
    assert "FROM matched JOIN" not in query.sql


def test_drilldown_materialization_has_no_silent_row_limit() -> None:
    query = SqlCompiler(
        _plan("dod-a-first-blood-win-rate"), load_catalog(), has_spatial=False
    ).compile_matched_ids()

    assert "LIMIT" not in query.sql
