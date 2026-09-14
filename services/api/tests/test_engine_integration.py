"""End-to-end conformance from TypeScript golden AST through PhysicalPlan to DuckDB."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import pytest
from lod_api.compile.planner import PlanBuilder
from lod_api.engine.duckdb_engine import AmbiguousMatchedUnit, DuckDBEngine
from lod_data.duckdb_views import register_views
from lod_data.synth.writer import write_dataset

CASES = Path(__file__).resolve().parents[3] / "tests" / "conformance" / "cases"
REFERENCE = Path(__file__).resolve().parents[3] / "data" / "reference"
N_MATCHES = 500


@pytest.fixture(scope="module")
def engine_context(tmp_path_factory: pytest.TempPathFactory):
    root = tmp_path_factory.mktemp("engine-silver")
    write_dataset(N_MATCHES, root, seed=20260914, workers=1, chunk_size=N_MATCHES, progress=False)
    con = duckdb.connect()
    register_views(con, root)
    raw = json.loads((REFERENCE / "regions_builtin.json").read_text(encoding="utf-8"))
    regions = {item["id"]: item["shape"] for item in raw["regions"]}
    regions.update(
        {
            "custom_region_1": {
                "kind": "rect",
                "x0": 0.0,
                "y0": 0.55,
                "x1": 0.35,
                "y1": 1.0,
            },
            "custom_top_region": regions["top_lane"],
        }
    )
    yield con, regions
    con.close()


def _execute(case: str, context, monkeypatch):
    from lod_api.engine import duckdb_engine

    con, regions = context
    monkeypatch.setattr(duckdb_engine, "cursor", con.cursor)
    monkeypatch.setattr(duckdb_engine, "has_spatial", lambda: False)
    ast = json.loads((CASES / case / "expected.ast.json").read_text(encoding="utf-8"))
    plan = PlanBuilder().build(ast, regions=regions)
    return DuckDBEngine().execute(plan, run_id=f"test-{case}")


def _execute_ast(ast: dict, context, monkeypatch, *, regions: dict | None = None):
    from lod_api.engine import duckdb_engine

    con, default_regions = context
    monkeypatch.setattr(duckdb_engine, "cursor", con.cursor)
    monkeypatch.setattr(duckdb_engine, "has_spatial", lambda: False)
    plan = PlanBuilder().build(ast, regions=regions or default_regions)
    return DuckDBEngine().execute(plan, run_id="test-custom")


def test_dod_a_first_blood_rate(engine_context, monkeypatch) -> None:
    result = _execute("dod-a-first-blood-win-rate", engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    assert row["n"] > N_MATCHES * 0.45
    assert 0.5 < row["m0"] < 0.75
    assert result.stats.total_units == N_MATCHES
    assert 0.4 < result.stats.baseline_values["m0"] < 0.6


def test_champion_pick_rate_counts_each_match_once(engine_context, monkeypatch) -> None:
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
                    "alias": None,
                }
            ],
        },
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    con, _ = engine_context
    expected = con.execute(
        """
        SELECT count(DISTINCT p.match_id)::DOUBLE / (SELECT count(*) FROM matches)
        FROM participants p
        WHERE p.champion = 'Ahri'
        """
    ).fetchone()[0]

    assert row["n"] == N_MATCHES
    assert row["m0"] == pytest.approx(expected)


def test_champion_overview_measures_share_match_scope(engine_context, monkeypatch) -> None:
    functions = ["pick_rate", "ban_rate", "champion_win_rate", "champion_games"]
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
                        "callee": function,
                        "scope": None,
                        "args": [{"kind": "StringLit", "value": "Ahri"}],
                    },
                    "alias": None,
                }
                for function in functions
            ],
        },
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    con, _ = engine_context
    total, picked, wins, banned = con.execute(
        """
        SELECT
          (SELECT count(*) FROM matches),
          count(DISTINCT p.match_id),
          count(DISTINCT p.match_id) FILTER (WHERE p.win),
          (SELECT count(DISTINCT t.match_id)
             FROM teams t, UNNEST(t.bans) AS b(champion_id)
            WHERE b.champion_id = 103)
        FROM participants p
        WHERE p.champion = 'Ahri'
        """
    ).fetchone()

    assert row["n"] == total
    assert row["m0"] == pytest.approx(picked / total)
    assert row["m1"] == pytest.approx(banned / total)
    assert row["m2"] == pytest.approx(wins / picked)
    assert row["m3"] == picked


def test_role_pick_rate_uses_two_role_slots_per_match(engine_context, monkeypatch) -> None:
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
                        "callee": "role_pick_rate",
                        "scope": None,
                        "args": [
                            {"kind": "StringLit", "value": "Ahri"},
                            {"kind": "StringLit", "value": "MID"},
                        ],
                    },
                    "alias": None,
                }
            ],
        },
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    con, _ = engine_context
    picks = con.execute(
        "SELECT count(*) FROM participants WHERE champion = 'Ahri' AND role = 'MID'"
    ).fetchone()[0]
    assert row["m0"] == pytest.approx(picks / (N_MATCHES * 2))


def test_player_subject_fields_support_filters_and_aggregates(engine_context, monkeypatch) -> None:
    def field(name: str) -> dict:
        return {
            "kind": "FieldAccess",
            "object": {"kind": "Identifier", "name": "player"},
            "field": name,
        }

    ast = {
        "kind": "Program",
        "analyze": {"kind": "ScopeRef", "entity": "player"},
        "body": {
            "kind": "SimpleStmt",
            "chain": None,
            "when": {
                "kind": "BinaryExpr",
                "left": field("kda"),
                "op": ">=",
                "right": {"kind": "NumberLit", "value": 3},
            },
            "groupBy": [],
            "returns": [
                {
                    "kind": "ReturnItem",
                    "expr": {
                        "kind": "CallExpr",
                        "callee": "avg",
                        "scope": None,
                        "args": [field("damage_dealt")],
                    },
                    "alias": None,
                },
                {
                    "kind": "ReturnItem",
                    "expr": {
                        "kind": "CallExpr",
                        "callee": "median",
                        "scope": None,
                        "args": [field("cs_per_minute")],
                    },
                    "alias": None,
                },
            ],
        },
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    con, _ = engine_context
    expected = con.execute(
        """
        SELECT avg(p.total_damage_dealt_to_champions),
               median((p.total_minions_killed + p.neutral_minions_killed) * 60.0 / m.duration_s),
               count(*)
        FROM participants p JOIN matches m USING (match_id)
        WHERE (p.kills + p.assists)::DOUBLE / greatest(p.deaths, 1) >= 3
          AND m.winning_team IN (100, 200) AND NOT m.ended_early_surrender
        """
    ).fetchone()
    assert row["m0"] == pytest.approx(expected[0])
    assert row["m1"] == pytest.approx(expected[1])
    assert row["n"] == expected[2]


def test_matched_parquet_and_match_detail(engine_context, monkeypatch, tmp_path) -> None:
    from lod_api.engine import duckdb_engine

    con, regions = engine_context
    monkeypatch.setattr(duckdb_engine, "cursor", con.cursor)
    monkeypatch.setattr(duckdb_engine, "has_spatial", lambda: False)
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    plan = PlanBuilder().build(ast, regions=regions)
    engine = DuckDBEngine()
    target = tmp_path / "matched.parquet"
    monkeypatch.setattr(engine, "_matched_path", lambda _run_id: target)

    page = engine.matched_matches(plan, run_id="a" * 32, limit=2)
    assert page.num_rows == 2
    assert target.exists()
    match_id = page.to_pylist()[0]["match_id"]
    detail = engine.match_detail(plan, run_id="a" * 32, match_id=match_id)
    assert detail is not None
    assert detail["match"]["match_id"] == match_id
    assert len(detail["participants"]) == 10
    assert {"puuid", "riot_id", "summoner_name"}.isdisjoint(detail["participants"][0])
    assert detail["events"]
    assert detail["teamFrames"]
    assert detail["matchReason"]["conditions"]
    assert detail["matchReason"]["conditions"][0]["witnesses"]
    assert detail["matchReason"]["conditions"][0]["witnesses"][0]["event_id"] >= 0


def test_dod_b_spatial_funnel(engine_context, monkeypatch) -> None:
    result = _execute("dod-b-top-lane-first-blood", engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    assert row["n"] > 20
    # Event occurrence and its location qualifier are intentionally one atomic condition/card.
    assert len(result.stats.conditions) == 1
    assert result.stats.conditions[0]["matchedCumulative"] == row["n"]


def test_dod_c_duration_reports_coverage(engine_context, monkeypatch) -> None:
    result = _execute("dod-c-first-blood-to-turret", engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    assert 150 < row["m0"] < 260
    coverage = result.stats.measure_coverage[0]
    assert 0 < coverage["defined"] <= coverage["eligible"]
    assert coverage["ratio"] <= 1


def test_elder_dragon_win_rate_and_time_to_victory(engine_context, monkeypatch) -> None:
    def event_ref(event_type: str, ordinal: str) -> dict:
        return {
            "kind": "EventRef",
            "bindingId": f"any.{event_type}#{ordinal}",
            "scope": None,
            "eventType": event_type,
            "ordinal": ordinal,
            "surface": event_type,
        }

    condition_elder = event_ref("elder_dragon_kill", "any")
    last_elder = event_ref("elder_dragon_kill", "last")
    victory = event_ref("victory", "any")
    ast = {
        "kind": "Program",
        "analyze": {"kind": "ScopeRef", "entity": "team"},
        "body": {
            "kind": "SimpleStmt",
            "chain": None,
            "when": {"kind": "EventPredicate", "event": condition_elder, "negated": False},
            "groupBy": [],
            "returns": [
                {
                    "kind": "ReturnItem",
                    "expr": {
                        "kind": "CallExpr",
                        "callee": "win_rate",
                        "scope": None,
                        "args": [],
                    },
                    "alias": None,
                },
                {
                    "kind": "ReturnItem",
                    "expr": {
                        "kind": "CallExpr",
                        "callee": "avg",
                        "scope": None,
                        "args": [
                            {
                                "kind": "CallExpr",
                                "callee": "duration",
                                "scope": None,
                                "args": [last_elder, victory],
                            }
                        ],
                    },
                    "alias": None,
                },
            ],
        },
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    con, _ = engine_context
    expected = con.execute(
        """
        WITH elder AS (
          SELECT e.match_id, e.team_id, max(e.timestamp_ms) AS last_elder_ms
          FROM events e
          WHERE e.event_type = 'dragon_kill' AND e.event_subtype = 'ELDER_DRAGON'
          GROUP BY e.match_id, e.team_id
        )
        SELECT count(*), avg(CASE WHEN s.win THEN 1.0 ELSE 0.0 END),
               avg((v.timestamp_ms - last_elder_ms) / 1000.0), count(v.timestamp_ms)
        FROM elder e
        JOIN match_summary s USING (match_id, team_id)
        LEFT JOIN events v
          ON v.match_id = e.match_id AND v.team_id = e.team_id
         AND v.event_type = 'game_end'
        """
    ).fetchone()

    assert row["n"] == expected[0]
    assert row["m0"] == pytest.approx(expected[1])
    assert row["m1"] == pytest.approx(expected[2])
    duration_coverage = result.stats.measure_coverage[0]
    assert duration_coverage["measureId"] == "m1"
    assert duration_coverage["eligible"] == expected[0]
    assert duration_coverage["defined"] == expected[3]


def test_dod_d_gold_lead(engine_context, monkeypatch) -> None:
    result = _execute("dod-d-gold-lead-win-rate", engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    assert row["n"] > 50
    assert 0.55 < row["m0"] < 0.9


@pytest.mark.parametrize("function", ["purchased_item_by", "owns_item_at"])
def test_point_in_time_item_conditions_execute_in_duckdb(
    function, engine_context, monkeypatch
) -> None:
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    ast["analyze"] = {"kind": "ScopeRef", "entity": "team"}
    ast["body"]["returns"][0]["expr"]["scope"] = None
    ast["body"]["when"] = {
        "kind": "CallExpr",
        "callee": function,
        "scope": None,
        "args": [
            {"kind": "ClockLit", "seconds": 900, "raw": "15:00"},
            {"kind": "NumberLit", "value": 3071},
            {"kind": "NumberLit", "value": 3153},
        ],
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    eligible_matches = (
        engine_context[0]
        .execute(
            "SELECT count(*) FROM matches WHERE duration_s >= 900 AND winning_team IN (100, 200) "
            "AND NOT ended_early_surrender"
        )
        .fetchone()[0]
    )

    assert 0 <= result.data.to_pylist()[0]["n"] <= eligible_matches * 2
    assert result.stats.total_units == eligible_matches * 2


def test_dod_e_matches_independent_existential_query(engine_context, monkeypatch) -> None:
    result = _execute("dod-e-death-in-region", engine_context, monkeypatch)
    con, _ = engine_context
    expected = con.execute(
        """
        SELECT count(*) FROM match_summary s
        WHERE s.team_id = 100 AND EXISTS (
          SELECT 1 FROM v_deaths d
          WHERE d.match_id = s.match_id AND d.team_id = s.team_id
            AND d.x_norm BETWEEN 0.0 AND 0.35 AND d.y_norm BETWEEN 0.55 AND 1.0
        )
        """
    ).fetchone()[0]
    assert result.data.to_pylist()[0]["n"] == expected
    assert result.map_points
    assert all(0 <= point["x_norm"] <= 0.35 for point in result.map_points)
    assert all(0.55 <= point["y_norm"] <= 1 for point in result.map_points)


def test_dod_f_chain_rate(engine_context, monkeypatch) -> None:
    result = _execute("dod-f-dragon-after-kill", engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    assert row["n"] > 1_000
    assert 0.03 < row["m0"] < 0.45


def test_explicit_any_team_event_is_not_correlated_to_the_analysis_team(
    engine_context, monkeypatch
) -> None:
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    event = ast["body"]["when"]["event"]
    event["scope"] = {"kind": "ScopeRef", "entity": "team"}
    event["bindingId"] = "team.first_blood#any"

    result = _execute_ast(ast, engine_context, monkeypatch)
    con, _ = engine_context
    expected = con.execute("SELECT count(DISTINCT match_id) FROM v_first_blood").fetchone()[0]

    assert result.data.to_pylist()[0]["n"] == expected


def test_chain_uses_the_explicit_opposing_team_target(engine_context, monkeypatch) -> None:
    ast = json.loads(
        (CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text(encoding="utf-8")
    )
    target = ast["body"]["chain"]["condition"]["event"]
    target["scope"] = {"kind": "ScopeRef", "entity": "team", "side": "red"}
    target["bindingId"] = "red.dragon_kill#any"

    result = _execute_ast(ast, engine_context, monkeypatch)
    con, _ = engine_context
    expected = con.execute(
        """
        SELECT avg(CASE WHEN EXISTS (
          SELECT 1 FROM events d
          WHERE d.match_id = k.match_id AND d.event_type = 'dragon_kill'
            AND d.team_id = 200
            AND (d.timestamp_ms > k.timestamp_ms
                 OR (d.timestamp_ms = k.timestamp_ms AND d.event_id > k.event_id))
            AND d.timestamp_ms <= k.timestamp_ms + 90000
        ) THEN 1.0 ELSE 0.0 END)
        FROM events k WHERE k.event_type = 'kill' AND k.team_id = 100
        """
    ).fetchone()[0]

    assert result.data.to_pylist()[0]["m0"] == pytest.approx(expected)


def test_chain_uses_the_trigger_team_opponent_for_both_sides(engine_context, monkeypatch) -> None:
    ast = json.loads(
        (CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text(encoding="utf-8")
    )
    trigger = ast["body"]["chain"]["trigger"]
    trigger["scope"] = {"kind": "ScopeRef", "entity": "team"}
    trigger["bindingId"] = "team.kill#any"
    target = ast["body"]["chain"]["condition"]["event"]
    target["scope"] = {
        "kind": "ScopeRef",
        "entity": "team",
        "relation": "opponent-of-trigger",
    }
    target["bindingId"] = "opponent-of-trigger.dragon_kill#any"

    result = _execute_ast(ast, engine_context, monkeypatch)
    con, _ = engine_context
    expected = con.execute(
        """
        SELECT avg(CASE WHEN EXISTS (
          SELECT 1 FROM events d
          WHERE d.match_id = k.match_id AND d.event_type = 'dragon_kill'
            AND d.team_id <> k.team_id
            AND (d.timestamp_ms > k.timestamp_ms
                 OR (d.timestamp_ms = k.timestamp_ms AND d.event_id > k.event_id))
            AND d.timestamp_ms <= k.timestamp_ms + 90000
        ) THEN 1.0 ELSE 0.0 END)
        FROM events k WHERE k.event_type = 'kill'
        """
    ).fetchone()[0]

    assert result.data.to_pylist()[0]["m0"] == pytest.approx(expected)


def test_same_event_chain_requires_a_distinct_later_event(engine_context, monkeypatch) -> None:
    ast = json.loads(
        (CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text(encoding="utf-8")
    )
    trigger = ast["body"]["chain"]["trigger"]
    ast["body"]["chain"]["condition"]["event"] = {
        **trigger,
        "bindingId": "blue.kill#target",
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    value = result.data.to_pylist()[0]["m0"]

    assert 0 < value < 1


def test_comparison_drilldown_preserves_arm_and_true_atom_only(
    engine_context, monkeypatch, tmp_path
) -> None:
    from lod_api.engine import duckdb_engine

    con, regions = engine_context
    monkeypatch.setattr(duckdb_engine, "cursor", con.cursor)
    monkeypatch.setattr(duckdb_engine, "has_spatial", lambda: False)
    ast = json.loads(
        (CASES / "compare-first-blood" / "expected.ast.json").read_text(encoding="utf-8")
    )
    plan = PlanBuilder().build(ast, regions=regions)
    engine = DuckDBEngine()
    target = tmp_path / "compare-matched.parquet"
    monkeypatch.setattr(engine, "_matched_path", lambda _run_id: target)

    engine.execute(plan, run_id="b" * 32)
    item = engine.matched_matches(plan, run_id="b" * 32, limit=1).to_pylist()[0]
    detail = engine.match_detail(
        plan,
        run_id="b" * 32,
        match_id=item["match_id"],
        team_id=item["team_id"],
    )

    assert detail is not None
    assert len(detail["matchReason"]["arms"]) == 1
    assert len(detail["matchReason"]["conditions"]) == 1
    assert detail["matchReason"]["conditions"][0]["matched"] is True


def test_multi_unit_match_detail_requires_the_exact_team(
    engine_context, monkeypatch, tmp_path
) -> None:
    from lod_api.engine import duckdb_engine

    con, regions = engine_context
    monkeypatch.setattr(duckdb_engine, "cursor", con.cursor)
    monkeypatch.setattr(duckdb_engine, "has_spatial", lambda: False)
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    ast["analyze"].pop("side")
    ast["body"]["when"] = None
    ast["body"]["returns"][0]["expr"]["scope"] = {"kind": "ScopeRef", "entity": "team"}
    plan = PlanBuilder().build(ast, regions=regions)
    engine = DuckDBEngine()
    target = tmp_path / "multi-unit-matched.parquet"
    monkeypatch.setattr(engine, "_matched_path", lambda _run_id: target)

    engine.execute(plan, run_id="c" * 32)
    items = engine.matched_matches(plan, run_id="c" * 32, limit=2).to_pylist()
    assert items[0]["match_id"] == items[1]["match_id"]

    with pytest.raises(AmbiguousMatchedUnit):
        engine.match_detail(plan, run_id="c" * 32, match_id=items[0]["match_id"])

    detail = engine.match_detail(
        plan,
        run_id="c" * 32,
        match_id=items[0]["match_id"],
        team_id=items[0]["team_id"],
    )
    assert detail is not None
    assert detail["matchReason"]["unit"]["team_id"] == items[0]["team_id"]


@pytest.mark.parametrize(
    "case",
    [
        "bucket-time",
        "compare-first-blood",
        "group-by-champion",
        "group-by-position-region",
        "nested-or",
        "spatial-within-radius",
        "spec-14-ex5-player-champion",
        "spec-35-end-to-end",
        "temporal-between",
    ],
)
def test_remaining_executable_golden_cases(case: str, engine_context, monkeypatch) -> None:
    result = _execute(case, engine_context, monkeypatch)
    assert result.data.num_rows > 0


def test_rate_condition_executes_the_condition_instead_of_returning_one(
    engine_context, monkeypatch
) -> None:
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    condition = ast["body"]["when"]
    ast["body"]["when"] = None
    ast["body"]["returns"][0]["expr"] = {
        "kind": "CallExpr",
        "callee": "rate",
        "args": [condition],
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    value = result.data.to_pylist()[0]["m0"]

    assert 0.2 < value < 0.8


def test_point_in_time_measure_aggregate_executes_real_frame_values(
    engine_context, monkeypatch
) -> None:
    ast = json.loads(
        (CASES / "dod-d-gold-lead-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    measure_at = ast["body"]["when"]["left"]
    ast["body"]["when"] = None
    ast["body"]["returns"][0]["expr"] = {
        "kind": "CallExpr",
        "callee": "avg",
        "args": [measure_at],
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    value = result.data.to_pylist()[0]["m0"]

    assert abs(value) > 1


def test_execute_materializes_the_complete_drilldown_before_completion(
    engine_context, monkeypatch, tmp_path
) -> None:
    from lod_api.engine import duckdb_engine

    con, regions = engine_context
    monkeypatch.setattr(duckdb_engine, "cursor", con.cursor)
    monkeypatch.setattr(duckdb_engine, "has_spatial", lambda: False)
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    plan = PlanBuilder().build(ast, regions=regions)
    engine = DuckDBEngine()
    target = tmp_path / "matched.parquet"
    monkeypatch.setattr(engine, "_matched_path", lambda _run_id: target)

    result = engine.execute(plan, run_id="a" * 32)

    assert result.matched_ref == str(target)
    assert target.exists()
    assert duckdb.read_parquet(target).count("*").fetchone()[0] == result.stats.matched_units


def test_player_selector_and_player_event_are_applied_to_the_same_participant(
    engine_context, monkeypatch
) -> None:
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    selector = "SynthPlayer00000"
    ast["analyze"] = {"kind": "ScopeRef", "entity": "player", "selector": selector}
    event = ast["body"]["when"]["event"]
    event.update(
        bindingId=f"player({selector}).kill#any",
        eventType="kill",
        surface="kill",
        scope={"kind": "ScopeRef", "entity": "player", "selector": selector},
    )
    ast["body"]["returns"][0]["expr"] = {
        "kind": "CallExpr",
        "callee": "count",
        "args": [],
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    row = result.data.to_pylist()[0]

    assert 0 < row["n"] <= 10
    assert row["m0"] == row["n"]


def test_repeatable_temporal_condition_matches_any_valid_event_pair(
    engine_context, monkeypatch
) -> None:
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    template = ast["body"]["when"]["event"]
    kill = {**template, "bindingId": "blue.kill#any", "eventType": "kill", "surface": "kill"}
    dragon = {
        **template,
        "bindingId": "blue.dragon_kill#any",
        "eventType": "dragon_kill",
        "surface": "dragon_kill",
    }
    ast["body"]["when"] = {
        "kind": "TemporalPredicate",
        "relation": "AFTER",
        "left": dragon,
        "right": kill,
        "rightUpper": None,
        "window": {"kind": "DurationLit", "seconds": 90, "raw": "90s"},
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    con, _ = engine_context
    expected = con.execute(
        """
        SELECT count(*) FROM match_summary s
        WHERE s.team_id = 100 AND EXISTS (
          SELECT 1 FROM events k CROSS JOIN events d
          WHERE k.match_id = s.match_id AND d.match_id = s.match_id
            AND k.team_id = s.team_id AND d.team_id = s.team_id
            AND k.event_type = 'kill' AND d.event_type = 'dragon_kill'
            AND (d.timestamp_ms > k.timestamp_ms
                 OR (d.timestamp_ms = k.timestamp_ms AND d.event_id > k.event_id))
            AND d.timestamp_ms <= k.timestamp_ms + 90000
        )
        """
    ).fetchone()[0]

    assert result.data.to_pylist()[0]["n"] == expected


def test_numbered_dragon_occurrence_and_subtype_variant_share_engine_semantics(
    engine_context, monkeypatch
) -> None:
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    event = ast["body"]["when"]["event"]
    event.update(
        bindingId="blue.dragon_kill#nth-2",
        eventType="dragon_kill",
        ordinal=2,
        surface="dragon_kill",
    )
    result = _execute_ast(ast, engine_context, monkeypatch)
    con, _ = engine_context
    expected = con.execute(
        """
        SELECT count(*) FROM match_summary s
        WHERE s.team_id = 100 AND (
          SELECT count(*) FROM events d
          WHERE d.match_id = s.match_id AND d.team_id = s.team_id
            AND d.event_type = 'dragon_kill'
        ) >= 2
        """
    ).fetchone()[0]
    assert result.data.to_pylist()[0]["n"] == expected

    event.update(
        bindingId="blue.chemtech_dragon_kill#nth-1",
        eventType="chemtech_dragon_kill",
        ordinal=1,
        surface="chemtech_dragon_kill",
    )
    subtype_result = _execute_ast(ast, engine_context, monkeypatch)
    expected_subtype = con.execute(
        """
        SELECT count(*) FROM match_summary s
        WHERE s.team_id = 100 AND EXISTS (
          SELECT 1 FROM events d
          WHERE d.match_id = s.match_id AND d.team_id = s.team_id
            AND d.event_type = 'dragon_kill' AND d.event_subtype = 'CHEMTECH_DRAGON'
        )
        """
    ).fetchone()[0]
    assert subtype_result.data.to_pylist()[0]["n"] == expected_subtype


def test_numbered_dragon_is_executable_as_a_chain_target(engine_context, monkeypatch) -> None:
    ast = json.loads(
        (CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text(encoding="utf-8")
    )
    target = ast["body"]["chain"]["condition"]["event"]
    target.update(bindingId="any.dragon_kill#nth-2", ordinal=2)

    result = _execute_ast(ast, engine_context, monkeypatch)
    row = result.data.to_pylist()[0]
    assert row["n"] > 0
    assert 0 <= row["m0"] <= 1

    target.update(
        bindingId="any.chemtech_dragon_kill#nth-1",
        eventType="chemtech_dragon_kill",
        ordinal=1,
        surface="chemtech_dragon_kill",
    )
    subtype_result = _execute_ast(ast, engine_context, monkeypatch)
    subtype_row = subtype_result.data.to_pylist()[0]
    assert subtype_row["n"] == row["n"]
    assert 0 <= subtype_row["m0"] <= 1


def test_numbered_dragon_chain_trigger_creates_one_unit_per_matching_team(
    engine_context, monkeypatch
) -> None:
    ast = json.loads(
        (CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text(encoding="utf-8")
    )
    trigger = ast["body"]["chain"]["trigger"]
    trigger.update(
        bindingId="blue.dragon_kill#nth-2",
        eventType="dragon_kill",
        ordinal=2,
        surface="dragon_kill",
    )
    target = ast["body"]["chain"]["condition"]["event"]
    target.update(bindingId="any.baron_kill#any", eventType="baron_kill", surface="baron_kill")

    result = _execute_ast(ast, engine_context, monkeypatch)
    con, _ = engine_context
    expected = con.execute(
        """
        SELECT count(*) FROM (
          SELECT match_id FROM events
          WHERE event_type = 'dragon_kill' AND team_id = 100
          GROUP BY match_id HAVING count(*) >= 2
        )
        """
    ).fetchone()[0]
    assert result.data.to_pylist()[0]["n"] == expected


def test_death_role_membership_uses_the_victim_role(engine_context, monkeypatch) -> None:
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    event = ast["body"]["when"]["event"]
    event.update(bindingId="blue.death#any", eventType="death", surface="death")
    ast["body"]["when"] = {
        "kind": "InExpr",
        "value": {"kind": "FieldAccess", "object": event, "field": "role"},
        "set": [
            {"kind": "StringLit", "value": "TOP"},
            {"kind": "StringLit", "value": "MID"},
        ],
        "negated": False,
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    con, _ = engine_context
    expected = con.execute(
        """
        SELECT count(*) FROM match_summary s
        WHERE s.team_id = 100 AND EXISTS (
          SELECT 1 FROM v_deaths d
          WHERE d.match_id = s.match_id AND d.team_id = s.team_id
            AND d.role IN ('TOP', 'MID')
        )
        """
    ).fetchone()[0]

    assert result.data.to_pylist()[0]["n"] == expected


def test_chain_target_filter_is_correlated_to_the_follow_up_event(
    engine_context, monkeypatch
) -> None:
    ast = json.loads(
        (CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text(encoding="utf-8")
    )
    target = ast["body"]["chain"]["condition"]["event"]
    target.update(bindingId="any.death#any", eventType="death", surface="death")
    ast["body"]["chain"]["condition"] = {
        "kind": "InExpr",
        "value": {"kind": "FieldAccess", "object": target, "field": "role"},
        "set": [{"kind": "StringLit", "value": "TOP"}],
        "negated": False,
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    row = result.data.to_pylist()[0]

    assert row["n"] > 0
    assert 0 <= row["m0"] <= 1


def test_chain_can_require_each_selected_victim_role(engine_context, monkeypatch) -> None:
    ast = json.loads(
        (CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text(encoding="utf-8")
    )
    target = ast["body"]["chain"]["condition"]["event"]
    target.update(bindingId="any.death#any", eventType="death", surface="death")
    membership = {
        "kind": "InExpr",
        "value": {"kind": "FieldAccess", "object": target, "field": "role"},
        "set": [
            {"kind": "StringLit", "value": "TOP"},
            {"kind": "StringLit", "value": "MID"},
        ],
        "negated": False,
    }
    ast["body"]["chain"]["condition"] = {
        "kind": "CallExpr",
        "callee": "all_values",
        "scope": None,
        "args": [membership],
    }

    result = _execute_ast(ast, engine_context, monkeypatch)
    row = result.data.to_pylist()[0]

    assert row["n"] > 0
    assert 0 <= row["m0"] <= 1


def test_non_success_measure_filters_to_successful_chain_units(engine_context, monkeypatch) -> None:
    ast = json.loads(
        (CASES / "dod-f-dragon-after-kill" / "expected.ast.json").read_text(encoding="utf-8")
    )
    trigger = ast["body"]["chain"]["trigger"]
    trigger.update(
        bindingId="any.dragon_kill#4",
        eventType="dragon_kill",
        ordinal=4,
        scope=None,
        surface="dragon_kill",
    )
    target = ast["body"]["chain"]["condition"]["event"]
    target.update(bindingId="any.death#any", eventType="death", surface="death", scope=None)
    ast["body"]["chain"]["condition"] = {
        "kind": "InExpr",
        "value": {"kind": "FieldAccess", "object": target, "field": "role"},
        "set": [{"kind": "StringLit", "value": "TOP"}],
        "negated": False,
    }
    ast["body"]["returns"][0]["expr"].update(callee="loss_rate")

    plan = PlanBuilder().build(ast)
    assert plan.chain_as_filter is True

    result = _execute_ast(ast, engine_context, monkeypatch)
    row = result.data.to_pylist()[0]

    assert 0 < row["n"] < result.stats.total_units
    assert row["n"] == result.stats.matched_units
    assert result.stats.conditions[-1]["id"] == "chain"
    assert result.stats.conditions[-1]["matchedCumulative"] == row["n"]
    assert 0 <= row["m0"] <= 1

    ast["body"]["groupBy"] = [
        {
            "kind": "GroupKey",
            "expr": {
                "kind": "FieldAccess",
                "object": dict(trigger),
                "field": "monster_subtype",
            },
            "alias": None,
        }
    ]
    grouped = _execute_ast(ast, engine_context, monkeypatch).data.to_pylist()
    assert grouped
    assert {item["monster_subtype"] for item in grouped} <= {
        "AIR_DRAGON",
        "CHEMTECH_DRAGON",
        "EARTH_DRAGON",
        "FIRE_DRAGON",
        "HEXTECH_DRAGON",
        "WATER_DRAGON",
    }


def test_loss_rate_is_the_complement_of_win_rate(engine_context, monkeypatch) -> None:
    ast = json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )
    win = _execute_ast(ast, engine_context, monkeypatch).data.to_pylist()[0]["m0"]
    ast["body"]["returns"][0]["expr"].update(callee="loss_rate")
    loss = _execute_ast(ast, engine_context, monkeypatch).data.to_pylist()[0]["m0"]

    assert loss == pytest.approx(1 - win)


def test_spatial_comparison_executes_and_returns_map_points(engine_context, monkeypatch) -> None:
    ast = json.loads(
        (CASES / "dod-e-death-in-region" / "expected.ast.json").read_text(encoding="utf-8")
    )
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

    result = _execute_ast(ast, engine_context, monkeypatch)

    assert result.result_type == "comparison"
    assert result.data.num_rows == 1
    assert result.map_points
