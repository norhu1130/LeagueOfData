from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pyarrow as pa
from fastapi.testclient import TestClient
from lod_api.catalog import load_catalog, load_effective_catalog
from lod_api.compile.planner import PlanBuilder
from lod_api.main import app
from lod_api.routers.analyses import validate_analysis_ast
from lod_api.runs import RunManager, RunQueueFull, RunRecord
from test_runs import FakeEngine

CASES = Path(__file__).resolve().parents[3] / "tests" / "conformance" / "cases"
client = TestClient(app)


def _ast(case: str = "dod-a-first-blood-win-rate") -> dict:
    return json.loads((CASES / case / "expected.ast.json").read_text(encoding="utf-8"))


def test_request_boundary_accepts_numbered_event_ordinals() -> None:
    ast = _ast("dod-c-first-blood-to-turret")
    duration = ast["body"]["returns"][0]["expr"]["args"][0]
    duration["args"][1]["ordinal"] = 2
    validate_analysis_ast(ast)


def test_run_and_sse_contract(monkeypatch) -> None:
    from lod_api.routers import analyses

    isolated = RunManager(FakeEngine(), max_workers=1)
    monkeypatch.setattr(analyses, "manager", isolated)
    response = client.post(
        "/api/v1/analyses/run",
        json={"ast": _ast(), "catalogHash": load_effective_catalog().hash},
    )
    assert response.status_code == 202
    run_id = response.json()["runId"]

    stream = client.get(f"/api/v1/runs/{run_id}/events")
    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("text/event-stream")
    assert '"phase": "completed"' in stream.text

    state = client.get(f"/api/v1/runs/{run_id}").json()
    assert state["status"] == "completed"
    assert state["result"]["result"]["rows"][0]["m0"] == 0.6
    assert client.get(f"/api/v1/runs/{run_id}/explain").status_code == 200


def test_catalog_hash_mismatch_is_rejected_before_execution() -> None:
    response = client.post(
        "/api/v1/analyses/run", json={"ast": _ast(), "catalogHash": "sha256:old"}
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "E-SEM-060"


def test_run_boundary_uses_the_effective_source_catalog_hash(monkeypatch) -> None:
    from lod_api.routers import analyses

    static = load_catalog()
    effective = static.for_source("riot_v5")
    monkeypatch.setattr(analyses, "load_effective_catalog", lambda: effective)
    monkeypatch.setattr(analyses.manager, "submit", lambda *_args, **_kwargs: "a" * 32)

    stale = client.post(
        "/api/v1/analyses/run",
        json={"ast": _ast(), "catalogHash": static.hash},
    )
    accepted = client.post(
        "/api/v1/analyses/run",
        json={"ast": _ast(), "catalogHash": effective.hash},
    )

    assert stale.status_code == 409
    assert stale.json()["detail"]["catalogHash"] == effective.hash
    assert accepted.status_code == 202


def test_catalog_hash_is_required_at_the_execution_boundary() -> None:
    response = client.post("/api/v1/analyses/run", json={"ast": _ast()})

    assert response.status_code == 422


def test_unknown_binary_operator_is_rejected_before_queueing() -> None:
    ast = deepcopy(_ast())
    ast["body"]["when"] = {
        "kind": "BinaryExpr",
        "op": "CONTAINS",
        "left": ast["body"]["when"],
        "right": {"kind": "BoolLit", "value": True},
    }

    response = client.post(
        "/api/v1/analyses/run",
        json={"ast": ast, "catalogHash": load_effective_catalog().hash},
    )

    assert response.status_code == 422
    assert "지원하지 않는 비교 또는 계산 연산자" in response.text


def test_unknown_ast_node_is_rejected_before_queueing() -> None:
    ast = deepcopy(_ast())
    ast["body"]["when"] = {"kind": "UnknownPredicate"}

    response = client.post(
        "/api/v1/analyses/run",
        json={"ast": ast, "catalogHash": load_effective_catalog().hash},
    )

    assert response.status_code == 422
    assert "사용할 수 없는 분석 노드" in response.text


def test_semantically_unknown_function_is_rejected_before_queueing(monkeypatch) -> None:
    from lod_api.routers import analyses

    ast = deepcopy(_ast())
    ast["body"]["returns"][0]["expr"]["callee"] = "unknown_measure"

    def must_not_submit(*_args, **_kwargs):
        raise AssertionError("invalid AST entered the run queue")

    monkeypatch.setattr(analyses.manager, "submit", must_not_submit)
    response = client.post(
        "/api/v1/analyses/run",
        json={"ast": ast, "catalogHash": load_effective_catalog().hash},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "E-SEM-001"


def test_hostile_browser_origin_is_rejected() -> None:
    response = client.post(
        "/api/v1/analyses/run",
        headers={"Origin": "https://attacker.example"},
        json={"ast": _ast(), "catalogHash": load_effective_catalog().hash},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "E-SEC-001"


def test_loopback_browser_origin_is_allowed() -> None:
    response = client.post(
        "/api/v1/analyses/run",
        headers={"Origin": "http://127.0.0.1:5193"},
        json={"ast": _ast(), "catalogHash": "sha256:stale"},
    )

    assert response.status_code == 409


def test_analysis_request_body_limit_is_enforced_before_validation(monkeypatch) -> None:
    from lod_api.config import settings

    monkeypatch.setattr(settings, "max_request_body_bytes", 32)
    response = client.post(
        "/api/v1/analyses/run",
        json={"ast": _ast(), "catalogHash": load_effective_catalog().hash},
    )

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "E-SEC-002"


def test_ast_depth_limit_is_enforced(monkeypatch) -> None:
    from lod_api.routers import analyses

    ast = deepcopy(_ast())
    atom = ast["body"]["when"]
    for _ in range(6):
        atom = {"kind": "UnaryExpr", "op": "NOT", "operand": atom}
    ast["body"]["when"] = atom
    monkeypatch.setattr(analyses.settings, "max_ast_depth", 5)

    response = client.post(
        "/api/v1/analyses/run",
        json={"ast": ast, "catalogHash": load_effective_catalog().hash},
    )

    assert response.status_code == 422
    assert "분석 구조가 너무 깊습니다" in response.text


def test_ast_node_and_string_limits_are_enforced(monkeypatch) -> None:
    from lod_api.routers import analyses

    monkeypatch.setattr(analyses.settings, "max_ast_nodes", 2)
    too_many_nodes = client.post(
        "/api/v1/analyses/run",
        json={"ast": _ast(), "catalogHash": load_effective_catalog().hash},
    )
    assert too_many_nodes.status_code == 422
    assert "분석 노드 수가 허용 범위를 넘었습니다" in too_many_nodes.text

    monkeypatch.setattr(analyses.settings, "max_ast_nodes", 1_000)
    monkeypatch.setattr(analyses.settings, "max_ast_string_length", 3)
    long_string = client.post(
        "/api/v1/analyses/run",
        json={"ast": _ast(), "catalogHash": load_effective_catalog().hash},
    )
    assert long_string.status_code == 422
    assert "문자열이 비어 있거나 너무 깁니다" in long_string.text


def test_region_vertex_limit_is_enforced(monkeypatch) -> None:
    from lod_api.routers import analyses

    monkeypatch.setattr(analyses.settings, "max_region_vertices", 3)
    response = client.post(
        "/api/v1/analyses/run",
        json={
            "ast": _ast(),
            "catalogHash": load_effective_catalog().hash,
            "regions": {
                "test_region": {
                    "kind": "polygon",
                    "points": [[0, 0], [1, 0], [1, 1], [0, 1]],
                }
            },
        },
    )

    assert response.status_code == 422
    assert "영역 꼭짓점 수가 허용 범위를 넘었습니다" in response.text


def test_region_count_limit_is_enforced(monkeypatch) -> None:
    from lod_api.routers import analyses

    monkeypatch.setattr(analyses.settings, "max_regions", 0)
    response = client.post(
        "/api/v1/analyses/run",
        json={
            "ast": _ast(),
            "catalogHash": load_effective_catalog().hash,
            "regions": {"test_region": {"kind": "rect", "x0": 0, "y0": 0, "x1": 1, "y1": 1}},
        },
    )
    assert response.status_code == 422
    assert "영역 수가 허용 범위를 넘었습니다" in response.text


def test_full_run_queue_returns_a_stable_429_diagnostic(monkeypatch) -> None:
    from lod_api.routers import analyses

    def reject(*_args, **_kwargs):
        raise RunQueueFull

    monkeypatch.setattr(analyses.manager, "submit", reject)
    response = client.post(
        "/api/v1/analyses/run",
        json={"ast": _ast(), "catalogHash": load_effective_catalog().hash},
    )

    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "E-RUN-001"


def test_drilldown_is_available_only_after_completion(monkeypatch) -> None:
    from lod_api.routers import analyses

    isolated = RunManager(FakeEngine(), max_workers=1)
    run_id = "d" * 32
    record = RunRecord(
        run_id=run_id, created_at=0, status="running", plan=PlanBuilder().build(_ast())
    )
    isolated._runs[run_id] = record
    monkeypatch.setattr(analyses, "manager", isolated)

    matches = client.get(f"/api/v1/runs/{run_id}/matches")
    detail = client.get(f"/api/v1/matches/SYNTH_1?runId={run_id}")

    assert matches.status_code == 409
    assert detail.status_code == 409


def test_comparison_match_list_exposes_arm_without_internal_truth_columns(monkeypatch) -> None:
    from lod_api.engine.duckdb_engine import DuckDBEngine
    from lod_api.routers import analyses

    engine = DuckDBEngine()
    isolated = RunManager(engine, max_workers=1)
    run_id = "e" * 32
    plan = PlanBuilder().build(_ast("compare-first-blood"))
    isolated._runs[run_id] = RunRecord(
        run_id=run_id,
        created_at=0,
        status="completed",
        plan=plan,
    )
    monkeypatch.setattr(analyses, "manager", isolated)
    monkeypatch.setattr(
        engine,
        "matched_matches",
        lambda *_args, **_kwargs: pa.table(
            {
                "match_id": ["SYNTH_1"],
                "team_id": [100],
                "truth_f0": [True],
                "truth_f1": [False],
                "arm_arm0": [True],
                "arm_arm1": [False],
            }
        ),
    )

    response = client.get(f"/api/v1/runs/{run_id}/matches")

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["arm"] == plan.compare_arms[0].label_ko
    assert item["arms"] == [{"id": "arm0", "labelKo": plan.compare_arms[0].label_ko}]
    assert all(not key.startswith(("truth_", "arm_")) for key in item)


def test_ambiguous_match_detail_returns_a_stable_conflict(monkeypatch) -> None:
    from lod_api.engine.duckdb_engine import AmbiguousMatchedUnit, DuckDBEngine
    from lod_api.routers import analyses

    engine = DuckDBEngine()
    isolated = RunManager(engine, max_workers=1)
    run_id = "f" * 32
    plan = PlanBuilder().build(_ast())
    isolated._runs[run_id] = RunRecord(
        run_id=run_id,
        created_at=0,
        status="completed",
        plan=plan,
    )
    monkeypatch.setattr(analyses, "manager", isolated)

    def ambiguous(*_args, **_kwargs):
        raise AmbiguousMatchedUnit("SYNTH_1")

    monkeypatch.setattr(engine, "match_detail", ambiguous)

    response = client.get(f"/api/v1/matches/SYNTH_1?runId={run_id}")

    assert response.status_code == 409
    assert "여러 분석 단위" in response.json()["detail"]
