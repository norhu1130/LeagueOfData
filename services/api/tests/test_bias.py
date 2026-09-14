from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from lod_api.bias import audit_plan
from lod_api.catalog import load_effective_catalog
from lod_api.compile.plan import DatasetFilter
from lod_api.compile.planner import PlanBuilder
from lod_api.main import create_app

CASES = Path(__file__).resolve().parents[3] / "tests" / "conformance" / "cases"


def _base_ast() -> dict:
    return json.loads(
        (CASES / "dod-a-first-blood-win-rate" / "expected.ast.json").read_text(encoding="utf-8")
    )


def _item_response_ast() -> dict:
    ast = _base_ast()
    ast["analyze"] = {"kind": "ScopeRef", "entity": "team"}
    ast["body"]["returns"][0]["expr"]["scope"] = None
    roster = {
        "kind": "CallExpr",
        "callee": "opponent_has_champion",
        "scope": None,
        "args": [{"kind": "StringLit", "value": "Vladimir"}],
    }
    purchase = {
        "kind": "InExpr",
        "value": {
            "kind": "FieldAccess",
            "object": {
                "kind": "EventRef",
                "bindingId": "any.item_purchase#any",
                "scope": None,
                "eventType": "item_purchase",
                "ordinal": "any",
                "surface": "item_purchase",
            },
            "field": "item",
        },
        "set": [{"kind": "NumberLit", "value": 3165}],
        "negated": False,
    }
    ast["body"]["when"] = {
        "kind": "BinaryExpr",
        "op": "AND",
        "left": roster,
        "right": {"kind": "UnaryExpr", "op": "NOT", "operand": purchase},
    }
    return ast


def test_item_analysis_gets_deterministic_post_outcome_and_proxy_warnings() -> None:
    plan = PlanBuilder().build(_item_response_ast())

    audit = audit_plan(plan, dataset_source="riot_v5")
    codes = {warning["code"] for warning in audit["warnings"]}

    assert audit["riskLevel"] == "high"
    assert "ITEM_POST_OUTCOME" in codes
    assert "CHAMPION_EXPOSURE_PROXY" in codes
    assert "NETWORK_SAMPLE" in codes
    assert "자동으로 변경·제외하지 않았습니다" in audit["limitationsKo"]


def test_patch_and_tier_filters_remove_only_their_own_warnings() -> None:
    plan = PlanBuilder().build(_base_ast(), dataset=DatasetFilter(patch="26.18", tier="GOLD"))

    codes = {warning["code"] for warning in audit_plan(plan)["warnings"]}

    assert "PATCH_UNCONTROLLED" not in codes
    assert "TIER_UNCONTROLLED" not in codes


def test_point_in_time_item_condition_removes_only_the_untimed_item_warning() -> None:
    ast = _item_response_ast()
    ast["body"]["when"]["right"] = {
        "kind": "UnaryExpr",
        "op": "NOT",
        "operand": {
            "kind": "CallExpr",
            "callee": "owns_item_at",
            "scope": None,
            "args": [
                {"kind": "ClockLit", "seconds": 900, "raw": "15:00"},
                {"kind": "NumberLit", "value": 3165},
            ],
        },
    }
    codes = {warning["code"] for warning in audit_plan(PlanBuilder().build(ast))["warnings"]}

    assert "ITEM_POST_OUTCOME" not in codes
    assert "ITEM_LANDMARK_ELIGIBILITY" in codes
    assert "CHAMPION_EXPOSURE_PROXY" in codes


def test_result_audit_flags_large_comparison_group_imbalance() -> None:
    plan = PlanBuilder().build(_base_ast())

    audit = audit_plan(
        plan,
        result_payload={"comparison": {"groups": [{"n": 10}, {"n": 80}]}},
    )

    assert "GROUP_IMBALANCE" in {warning["code"] for warning in audit["warnings"]}


def test_bias_audit_endpoint_does_not_start_an_analysis() -> None:
    catalog = load_effective_catalog()

    response = TestClient(create_app()).post(
        "/api/v1/analyses/bias-audit",
        json={"ast": _item_response_ast(), "catalogHash": catalog.hash},
    )

    assert response.status_code == 200
    assert response.json()["riskLevel"] == "high"
    assert any(warning["code"] == "ITEM_POST_OUTCOME" for warning in response.json()["warnings"])
