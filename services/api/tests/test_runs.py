"""Asynchronous run lifecycle and AnalysisResponse contract."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pyarrow as pa
import pytest
from lod_api.compile.plan import PhysicalPlan
from lod_api.engine.duckdb_engine import QueryCancelled
from lod_api.engine.interface import EngineCapabilities, ResultSet, ResultStats
from lod_api.runs import RunManager, RunQueueFull

CASES = Path(__file__).resolve().parents[3] / "tests" / "conformance" / "cases"


class FakeEngine:
    name = "fake"

    def __init__(self) -> None:
        self.executions = 0

    def capabilities(self) -> EngineCapabilities:
        return EngineCapabilities(False, False, True, False, True, 1)

    def execute(self, plan: PhysicalPlan, *, run_id: str) -> ResultSet:
        self.executions += 1
        data = (
            pa.table(
                {
                    "m0_arm0": [0.614],
                    "n_arm0": [5_000],
                    "m0_arm1": [0.424],
                    "n_arm1": [5_000],
                }
            )
            if plan.compare_arms
            else pa.table({"m0": [0.6], "n": [100]})
        )
        return ResultSet(
            result_type=plan.result_shape,
            data=data,
            stats=ResultStats(
                total_units=200,
                total_matches=200,
                matched_units=100,
                matched_matches=100,
                baseline_values={"m0": 0.5},
                elapsed_ms=2.5,
            ),
            engine="fake-1",
        )

    def explain(self, plan: PhysicalPlan) -> str:
        return f"plan:{plan.ast_hash}"

    def cancel(self, run_id: str) -> bool:
        return False


def _ast(case: str = "dod-a-first-blood-win-rate") -> dict:
    return json.loads((CASES / case / "expected.ast.json").read_text(encoding="utf-8"))


def test_run_lifecycle_and_result_envelope() -> None:
    manager = RunManager(FakeEngine(), max_workers=1, snapshot_provider=lambda: "snapshot-1")
    run_id = manager.submit(_ast())

    index = 0
    phases: list[str] = []
    while True:
        events, terminal = manager.wait_events(run_id, index, timeout=2)
        phases.extend(event["phase"] for event in events)
        index += len(events)
        if terminal:
            break

    assert phases == ["compiling", "planning", "running", "materializing", "completed"]
    record = manager.get(run_id)
    assert record is not None and record.response is not None
    response = record.response
    assert response["format"] == "loldsl.result"
    assert response["result"]["rows"] == [{"m0": 0.6, "n": 100}]
    assert response["result"]["confidenceInterval95"]["low"] < 0.6
    assert response["result"]["confidenceInterval95"]["high"] > 0.6
    assert response["result"]["baseline"] == {
        "value": 0.5,
        "differencePoints": 10.0,
        "labelKo": "전체 기준선",
    }
    assert response["provenance"]["matchedUnits"] == 100
    assert response["caveats"][0]["code"] == "OBSERVATIONAL"
    assert response["timing"]["engineVersion"] == "fake-1"
    assert response["timing"]["cacheHit"] is False
    assert response["provenance"]["dataset"]["snapshotId"] == "snapshot-1"
    assert response["provenance"]["drilldown"]["token"] != record.plan.ast_hash
    assert response["provenance"]["drilldown"]["expiresAt"].endswith("+00:00")


def test_identical_run_uses_cache_and_snapshot_change_invalidates_it() -> None:
    engine = FakeEngine()
    snapshot = ["snapshot-1"]
    manager = RunManager(engine, max_workers=1, snapshot_provider=lambda: snapshot[0])

    def run() -> dict:
        run_id = manager.submit(_ast())
        while True:
            _, terminal = manager.wait_events(run_id, 0, timeout=2)
            if terminal:
                break
        record = manager.get(run_id)
        assert record is not None and record.response is not None
        return record.response

    assert run()["timing"]["cacheHit"] is False
    assert run()["timing"]["cacheHit"] is True
    assert engine.executions == 1
    snapshot[0] = "snapshot-2"
    assert run()["timing"]["cacheHit"] is False
    assert engine.executions == 2


def test_comparison_response_has_groups_intervals_and_observed_difference() -> None:
    manager = RunManager(FakeEngine(), max_workers=1)
    run_id = manager.submit(_ast("compare-first-blood"))
    while True:
        _, terminal = manager.wait_events(run_id, 0, timeout=2)
        if terminal:
            break
    record = manager.get(run_id)
    assert record is not None and record.response is not None
    comparison = record.response["result"]["comparison"]
    assert comparison["differencePoints"] == 19.0
    assert [group["n"] for group in comparison["groups"]] == [5_000, 5_000]
    assert all(group["confidenceInterval95"] for group in comparison["groups"])
    assert record.response["result"]["baseline"]["value"] == 0.5


class CountCompareEngine(FakeEngine):
    def execute(self, plan: PhysicalPlan, *, run_id: str) -> ResultSet:
        result = super().execute(plan, run_id=run_id)
        result.data = pa.table(
            {"m0_arm0": [4_965], "n_arm0": [4_965], "m0_arm1": [5_035], "n_arm1": [5_035]}
        )
        return result


def test_non_rate_comparison_uses_plain_difference_without_binomial_interval() -> None:
    ast = _ast("compare-first-blood")
    ast["body"]["returns"] = [
        {
            "kind": "ReturnItem",
            "expr": {"kind": "CallExpr", "callee": "count", "scope": None, "args": []},
            "alias": None,
        }
    ]
    manager = RunManager(CountCompareEngine(), max_workers=1)
    run_id = manager.submit(ast)
    record = manager._runs[run_id]
    assert record.future is not None
    record.future.result(timeout=2)

    assert record.status == "completed"
    comparison = record.response["result"]["comparison"]
    assert comparison["unit"] == "count"
    assert comparison["difference"] == -70
    assert comparison["measure"] == {
        "id": "m0",
        "alias": "m0",
        "labelKo": "개수",
        "decimals": 0,
    }
    assert "differencePoints" not in comparison
    assert all("confidenceInterval95" not in group for group in comparison["groups"])


class DurationCompareEngine(FakeEngine):
    def execute(self, plan: PhysicalPlan, *, run_id: str) -> ResultSet:
        result = super().execute(plan, run_id=run_id)
        result.data = pa.table(
            {"m0_arm0": [195.0], "n_arm0": [80], "m0_arm1": [240.0], "n_arm1": [75]}
        )
        return result


def test_duration_comparison_preserves_seconds_and_plain_difference() -> None:
    ast = _ast("compare-first-blood")
    duration_ast = _ast("dod-c-first-blood-to-turret")
    ast["body"]["returns"] = duration_ast["body"]["returns"]
    manager = RunManager(DurationCompareEngine(), max_workers=1)
    run_id = manager.submit(ast)
    record = manager._runs[run_id]
    assert record.future is not None
    record.future.result(timeout=2)

    assert record.status == "completed"
    comparison = record.response["result"]["comparison"]
    assert comparison["unit"] == "seconds"
    assert comparison["difference"] == -45
    assert comparison["measure"]["decimals"] == 0
    assert "differencePoints" not in comparison
    assert all("confidenceInterval95" not in group for group in comparison["groups"])


class PartiallyUndefinedDurationCompareEngine(FakeEngine):
    def execute(self, plan: PhysicalPlan, *, run_id: str) -> ResultSet:
        result = super().execute(plan, run_id=run_id)
        result.data = pa.table(
            {
                "m0_arm0": [195.0],
                "defined_m0_arm0": [80],
                "n_arm0": [80],
                "m0_arm1": pa.array([None], type=pa.float64()),
                "defined_m0_arm1": [0],
                "n_arm1": [75],
            }
        )
        return result


def test_comparison_keeps_an_arm_whose_measure_is_undefined() -> None:
    ast = _ast("compare-first-blood")
    duration_ast = _ast("dod-c-first-blood-to-turret")
    ast["body"]["returns"] = duration_ast["body"]["returns"]
    manager = RunManager(PartiallyUndefinedDurationCompareEngine(), max_workers=1)
    run_id = manager.submit(ast)
    record = manager._runs[run_id]
    assert record.future is not None
    record.future.result(timeout=2)

    comparison = record.response["result"]["comparison"]
    assert comparison["difference"] is None
    assert comparison["groups"][1] == {
        "id": "arm1",
        "labelKo": "조건 2",
        "value": None,
        "n": 75,
        "defined": 0,
        "coverage": 0.0,
    }


class FailingEngine(FakeEngine):
    def execute(self, plan: PhysicalPlan, *, run_id: str) -> ResultSet:
        raise RuntimeError("의도한 실패")


def test_execution_failure_becomes_a_diagnostic_event() -> None:
    manager = RunManager(FailingEngine(), max_workers=1)
    run_id = manager.submit(_ast())

    while True:
        events, terminal = manager.wait_events(run_id, 0, timeout=2)
        if terminal:
            break

    assert events[-1]["phase"] == "failed"
    assert events[-1]["diagnostic"]["code"] == "E-EXE-001"
    assert events[-1]["diagnostic"]["bodyKo"] == (
        "분석 서버 내부에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
    )


class SlowEngine(FakeEngine):
    def __init__(self) -> None:
        self.started = threading.Event()
        self.interrupted = threading.Event()

    def execute(self, plan: PhysicalPlan, *, run_id: str) -> ResultSet:
        self.started.set()
        self.interrupted.wait(timeout=2)
        raise QueryCancelled(run_id)

    def cancel(self, run_id: str) -> bool:
        self.interrupted.set()
        return True


def test_running_query_can_be_cancelled() -> None:
    engine = SlowEngine()
    manager = RunManager(engine, max_workers=1)
    run_id = manager.submit(_ast())
    assert engine.started.wait(timeout=2)
    assert manager.cancel(run_id) is True

    while True:
        events, terminal = manager.wait_events(run_id, 0, timeout=2)
        if terminal:
            break
    assert events[-1]["phase"] == "cancelled"


class CooperativeOnlyEngine(FakeEngine):
    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def execute(self, plan: PhysicalPlan, *, run_id: str) -> ResultSet:
        self.started.set()
        assert self.release.wait(timeout=2)
        return super().execute(plan, run_id=run_id)


def test_cancellation_state_discards_a_result_when_native_interrupt_misses() -> None:
    engine = CooperativeOnlyEngine()
    manager = RunManager(engine, max_workers=1)
    run_id = manager.submit(_ast())
    assert engine.started.wait(timeout=2)
    assert manager.cancel(run_id) is True
    engine.release.set()
    record = manager._runs[run_id]
    assert record.future is not None
    record.future.result(timeout=2)

    assert record.status == "cancelled"
    assert record.response is None


def test_cancellation_requested_during_planning_prevents_execution(monkeypatch) -> None:
    import lod_api.runs as runs_module

    original_builder = runs_module.PlanBuilder
    planning_started = threading.Event()
    release_planning = threading.Event()

    class BlockingBuilder:
        def build(self, *args, **kwargs):
            planning_started.set()
            assert release_planning.wait(timeout=2)
            return original_builder().build(*args, **kwargs)

    engine = FakeEngine()
    monkeypatch.setattr(runs_module, "PlanBuilder", BlockingBuilder)
    manager = RunManager(engine, max_workers=1)
    run_id = manager.submit(_ast())
    assert planning_started.wait(timeout=2)

    assert manager.cancel(run_id) is True
    release_planning.set()
    record = manager._runs[run_id]
    assert record.future is not None
    record.future.result(timeout=2)

    assert record.status == "cancelled"
    assert engine.executions == 0


class BlockingEngine(FakeEngine):
    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def execute(self, plan: PhysicalPlan, *, run_id: str) -> ResultSet:
        self.started.set()
        assert self.release.wait(timeout=2)
        return super().execute(plan, run_id=run_id)


def test_run_queue_has_bounded_admission() -> None:
    engine = BlockingEngine()
    manager = RunManager(engine, max_workers=1, max_queued_runs=1)
    first = manager.submit(_ast())
    assert engine.started.wait(timeout=2)
    second = manager.submit(_ast())

    with pytest.raises(RunQueueFull):
        manager.submit(_ast())

    engine.release.set()
    for run_id in (first, second):
        record = manager._runs[run_id]
        assert record.future is not None
        record.future.result(timeout=2)


def test_completed_runs_expire_from_memory() -> None:
    manager = RunManager(FakeEngine(), max_workers=1, run_ttl_seconds=0)
    run_id = manager.submit(_ast())
    record = manager._runs[run_id]
    assert record.future is not None
    record.future.result(timeout=2)
    record.completed_at = time.time() - 1
    record.last_accessed_at = time.time() - 1
    assert manager.get(run_id) is None


def test_long_running_job_receives_a_full_ttl_after_completion() -> None:
    manager = RunManager(FakeEngine(), max_workers=1, run_ttl_seconds=60)
    run_id = manager.submit(_ast())
    record = manager._runs[run_id]
    assert record.future is not None
    record.future.result(timeout=2)
    record.created_at = time.time() - 3_600

    assert manager.get(run_id) is record
    assert record.completed_at is not None


def test_last_access_extends_run_and_drilldown_expiry() -> None:
    manager = RunManager(FakeEngine(), max_workers=1, run_ttl_seconds=60)
    run_id = manager.submit(_ast())
    record = manager._runs[run_id]
    assert record.future is not None
    record.future.result(timeout=2)
    previous_expiry = record.response["provenance"]["drilldown"]["expiresAt"]
    record.completed_at = time.time() - 30
    record.last_accessed_at = time.time() - 30

    assert manager.get(run_id) is record
    assert record.response["provenance"]["drilldown"]["expiresAt"] >= previous_expiry
