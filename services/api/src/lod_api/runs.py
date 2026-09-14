"""Analysis-run lifecycle and result envelopes independent of the concrete execution engine."""

from __future__ import annotations

import logging
import math
import shutil
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from lod_api.bias import audit_plan
from lod_api.canonical import canonical_hash
from lod_api.catalog import load_effective_catalog
from lod_api.compile.plan import DatasetFilter, PhysicalPlan
from lod_api.compile.planner import PlanBuilder
from lod_api.config import settings
from lod_api.db import dataset_snapshot_id
from lod_api.engine.duckdb_engine import DuckDBEngine, QueryCancelled
from lod_api.engine.interface import ExecutionEngine, ResultSet

TerminalStatus = Literal["completed", "failed", "cancelled"]
logger = logging.getLogger(__name__)


class RunQueueFull(Exception):
    """The bounded analysis executor has no remaining admission capacity."""


@dataclass(slots=True)
class RunRecord:
    run_id: str
    created_at: float
    status: str = "queued"
    plan: PhysicalPlan | None = None
    response: dict[str, Any] | None = None
    diagnostic: dict[str, Any] | None = None
    events: list[dict[str, Any]] = field(default_factory=list)
    future: Future[None] | None = None
    cache_key: str | None = None
    snapshot_id: str | None = None
    completed_at: float | None = None
    last_accessed_at: float = field(default_factory=time.time)
    cancellation_requested: bool = False
    condition: threading.Condition = field(default_factory=threading.Condition)

    @property
    def terminal(self) -> bool:
        return self.status in {"completed", "failed", "cancelled"}


class RunManager:
    def __init__(
        self,
        engine: ExecutionEngine | None = None,
        *,
        max_workers: int = 4,
        max_queued_runs: int = settings.max_queued_runs,
        max_cache_entries: int = 64,
        run_ttl_seconds: int = settings.run_ttl_seconds,
        snapshot_provider: Callable[[], str | None] = dataset_snapshot_id,
    ) -> None:
        if max_workers < 1 or max_queued_runs < 0:
            raise ValueError("Run limits must be non-negative and include at least one worker.")
        self.engine = engine or DuckDBEngine()
        self._max_workers = max_workers
        self._max_queued_runs = max_queued_runs
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="lod-run")
        self._runs: dict[str, RunRecord] = {}
        self._lock = threading.Lock()
        self._cache: OrderedDict[str, ResultSet] = OrderedDict()
        self._cache_lock = threading.Lock()
        self._max_cache_entries = max_cache_entries
        self._snapshot_provider = snapshot_provider
        self._run_ttl_seconds = run_ttl_seconds

    def submit(
        self,
        ast: dict[str, Any],
        *,
        regions: dict[str, dict[str, Any]] | None = None,
        dataset: DatasetFilter | None = None,
    ) -> str:
        self._purge_expired()
        with self._lock:
            outstanding = sum(not item.terminal for item in self._runs.values())
            if outstanding >= self._max_workers + self._max_queued_runs:
                raise RunQueueFull
            run_id = uuid.uuid4().hex
            now = time.time()
            record = RunRecord(run_id=run_id, created_at=now, last_accessed_at=now)
            self._runs[run_id] = record
        record.future = self._executor.submit(self._execute, record, ast, regions or {}, dataset)
        return run_id

    def get(self, run_id: str) -> RunRecord | None:
        self._purge_expired()
        with self._lock:
            record = self._runs.get(run_id)
            if record is not None:
                now = time.time()
                record.last_accessed_at = now
                if record.response is not None:
                    record.response["provenance"]["drilldown"]["expiresAt"] = (
                        datetime.fromtimestamp(now + self._run_ttl_seconds, UTC).isoformat()
                    )
            return record

    def _purge_expired(self) -> None:
        cutoff = time.time() - self._run_ttl_seconds
        with self._lock:
            expired = [
                run_id
                for run_id, record in self._runs.items()
                if record.terminal
                and max(record.completed_at or record.created_at, record.last_accessed_at) < cutoff
            ]
            for run_id in expired:
                self._runs.pop(run_id, None)
        for run_id in expired:
            run_dir = (settings.runs_dir / run_id).resolve()
            root = settings.runs_dir.resolve()
            if run_dir.parent == root and run_dir.name == run_id:
                shutil.rmtree(run_dir, ignore_errors=True)

    def cancel(self, run_id: str) -> bool:
        record = self.get(run_id)
        if record is None:
            return False
        with record.condition:
            if record.terminal:
                return False
            record.cancellation_requested = True
        cancelled_before_start = bool(record.future and record.future.cancel())
        self.engine.cancel(run_id)
        if cancelled_before_start:
            self._publish(record, "cancelled", terminal=True)
        return True

    def wait_events(
        self, run_id: str, index: int, timeout: float = 15.0
    ) -> tuple[list[dict[str, Any]], bool]:
        record = self.get(run_id)
        if record is None:
            raise KeyError(run_id)
        with record.condition:
            if len(record.events) <= index and not record.terminal:
                record.condition.wait(timeout=timeout)
            return list(record.events[index:]), record.terminal

    def _publish(
        self, record: RunRecord, phase: str, *, terminal: bool = False, **data: Any
    ) -> None:
        with record.condition:
            record.status = phase
            record.events.append({"phase": phase, **data})
            if terminal:
                record.status = phase
                now = time.time()
                record.completed_at = now
                record.last_accessed_at = now
            record.condition.notify_all()

    @staticmethod
    def _raise_if_cancelled(record: RunRecord) -> None:
        with record.condition:
            if record.cancellation_requested:
                raise QueryCancelled(record.run_id)

    def _execute(
        self,
        record: RunRecord,
        ast: dict[str, Any],
        regions: dict[str, dict[str, Any]],
        dataset: DatasetFilter | None,
    ) -> None:
        compile_started = time.perf_counter()
        try:
            self._raise_if_cancelled(record)
            self._publish(record, "compiling", done=0, total=1)
            shapes = {region_id: value.get("shape", value) for region_id, value in regions.items()}
            catalog = load_effective_catalog()
            record.plan = PlanBuilder().build(ast, regions=shapes, dataset=dataset)
            dataset_source = catalog.as_dict().get("datasetSource")
            self._raise_if_cancelled(record)
            record.snapshot_id = self._snapshot_provider()
            record.cache_key = canonical_hash(
                {
                    "astHash": record.plan.ast_hash,
                    "regions": shapes,
                    "dataset": asdict(record.plan.dataset),
                    "snapshotId": record.snapshot_id,
                    "engineVersion": getattr(self.engine, "cache_version", self.engine.name),
                }
            )
            compile_ms = (time.perf_counter() - compile_started) * 1000
            self._publish(record, "planning", done=1, total=1)
            self._raise_if_cancelled(record)
            cached = self._cache_get(record.cache_key)
            if cached is not None:
                self._publish(record, "materializing", done=0, total=1)
                self._raise_if_cancelled(record)
                expires_at = time.time() + self._run_ttl_seconds
                record.response = analysis_response(
                    record.run_id,
                    record.plan,
                    cached,
                    compile_ms,
                    cache_hit=True,
                    cache_key=record.cache_key,
                    snapshot_id=record.snapshot_id,
                    expires_at=expires_at,
                    dataset_source=dataset_source,
                )
                self._raise_if_cancelled(record)
                self._publish(record, "completed", terminal=True, result=record.response)
                return
            self._publish(record, "running", indeterminate=True)
            self._raise_if_cancelled(record)
            result = self.engine.execute(record.plan, run_id=record.run_id)
            self._raise_if_cancelled(record)
            self._cache_put(record.cache_key, result)
            self._publish(record, "materializing", done=0, total=1)
            self._raise_if_cancelled(record)
            expires_at = time.time() + self._run_ttl_seconds
            record.response = analysis_response(
                record.run_id,
                record.plan,
                result,
                compile_ms,
                cache_hit=False,
                cache_key=record.cache_key,
                snapshot_id=record.snapshot_id,
                expires_at=expires_at,
                dataset_source=dataset_source,
            )
            self._raise_if_cancelled(record)
            self._publish(record, "completed", terminal=True, result=record.response)
        except QueryCancelled:
            record.response = None
            self._publish(record, "cancelled", terminal=True)
        except Exception as exc:  # noqa: BLE001 — convert execution failures to SSE diagnostics
            logger.exception("Analysis run %s failed", record.run_id)
            safe_message = getattr(exc, "message_ko", None)
            record.diagnostic = {
                "code": getattr(exc, "code", "E-EXE-001"),
                "severity": "error",
                "titleKo": "분석을 실행하지 못했습니다",
                "bodyKo": safe_message
                if isinstance(safe_message, str)
                else "분석 서버 내부에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
            }
            self._publish(record, "failed", terminal=True, diagnostic=record.diagnostic)

    def _cache_get(self, key: str) -> ResultSet | None:
        with self._cache_lock:
            result = self._cache.get(key)
            if result is not None:
                self._cache.move_to_end(key)
            return result

    def _cache_put(self, key: str, result: ResultSet) -> None:
        if self._max_cache_entries <= 0:
            return
        with self._cache_lock:
            self._cache[key] = result
            self._cache.move_to_end(key)
            while len(self._cache) > self._max_cache_entries:
                self._cache.popitem(last=False)


def analysis_response(
    run_id: str,
    plan: PhysicalPlan,
    result: ResultSet,
    compile_ms: float,
    *,
    cache_hit: bool = False,
    cache_key: str | None = None,
    snapshot_id: str | None = None,
    expires_at: float | None = None,
    dataset_source: str | None = None,
) -> dict[str, Any]:
    rows = result.data.to_pylist()
    provenance = {
        "grain": plan.grain,
        "grainLabelKo": plan.grain_unit_ko,
        "totalMatches": result.stats.total_matches,
        "totalUnits": result.stats.total_units,
        "matchedMatches": result.stats.matched_matches,
        "matchedUnits": result.stats.matched_units,
        "denominatorKo": plan.denominator_ko,
        "conditions": result.stats.conditions,
        "excluded": result.stats.excluded,
        "measureCoverage": result.stats.measure_coverage,
        "dataset": {
            "snapshotId": snapshot_id,
            "filters": asdict(plan.dataset),
            "matchCount": result.stats.total_matches,
        },
        "drilldown": {
            "token": cache_key or plan.ast_hash,
            "expiresAt": datetime.fromtimestamp(expires_at, UTC).isoformat()
            if expires_at is not None
            else None,
        },
    }
    payload: dict[str, Any] = {
        "type": result.result_type,
        "columns": result.data.column_names,
        "rows": rows,
        "measures": [
            {
                "id": measure.id,
                "alias": measure.alias,
                "labelKo": measure.label_ko,
                "unit": measure.unit,
                "decimals": measure.decimals,
            }
            for measure in plan.measures
        ],
        "mapPoints": result.map_points,
    }
    comparison = _comparison_payload(plan, rows)
    if comparison is not None:
        payload["comparison"] = comparison
    provenance["biasAudit"] = audit_plan(
        plan, dataset_source=dataset_source, result_payload=payload
    )
    interval = _rate_interval(plan, rows)
    if interval is not None:
        payload["confidenceInterval95"] = interval
    rate = _single_rate(plan, rows)
    if rate is not None:
        measure, value, sample_size = rate
        baseline = result.stats.baseline_values.get(measure.id)
        if baseline is not None:
            payload["baseline"] = {
                "value": baseline,
                "differencePoints": round((value - baseline) * 100, 6),
                "labelKo": "전체 기준선",
            }
    elif comparison is not None and plan.measures[0].unit == "percent":
        baseline = result.stats.baseline_values.get(plan.measures[0].id)
        first_value = comparison["groups"][0]["value"]
        if baseline is not None:
            payload["baseline"] = {
                "value": baseline,
                "differencePoints": round((first_value - baseline) * 100, 6),
                "labelKo": "전체 기준선",
            }
    caveats = [
        {
            "code": "OBSERVATIONAL",
            "messageKo": (
                "이 수치는 조건을 만족한 경기들에서 관찰된 비율입니다. "
                "조건이 승리의 원인임을 뜻하지 않습니다."
            ),
        }
    ]
    if rate is not None:
        _, _, sample_size = rate
        if sample_size < 30:
            caveats.append(
                {
                    "code": "SMALL_SAMPLE",
                    "messageKo": "표본이 30개보다 적어 결과 변동성이 큽니다.",
                }
            )
        if interval is not None and interval["high"] - interval["low"] >= 0.2:
            caveats.append(
                {
                    "code": "WIDE_CI",
                    "messageKo": "95% 신뢰구간이 넓습니다. 더 많은 경기를 확인해 주세요.",
                }
            )
        baseline = result.stats.baseline_values.get(plan.measures[0].id)
        if (
            interval is not None
            and baseline is not None
            and interval["low"] <= baseline <= interval["high"]
        ):
            caveats.append(
                {
                    "code": "NOT_SIGNIFICANT",
                    "messageKo": "전체 기준선과의 차이가 이번 표본의 불확실성 범위 안에 있습니다.",
                }
            )
    if result.stats.excluded:
        caveats.append(
            {
                "code": "SURVIVORSHIP",
                "messageKo": "요청 시각 전에 끝난 경기는 해당 시점 측정에서 제외되었습니다.",
            }
        )
    if any(item["ratio"] < 0.9 for item in result.stats.measure_coverage):
        caveats.append(
            {
                "code": "MEASURE_COVERAGE_LOW",
                "messageKo": (
                    "일부 경기에서는 필요한 두 사건을 모두 확인할 수 없어 측정에서 빠졌습니다."
                ),
            }
        )
    return {
        "format": "loldsl.result",
        "version": 1,
        "runId": run_id,
        "result": payload,
        "provenance": provenance,
        "caveats": caveats,
        "viz": _viz(result.result_type),
        "timing": {
            "compileMs": compile_ms,
            "executeMs": 0.0 if cache_hit else result.stats.elapsed_ms,
            "cacheHit": cache_hit,
            "engineVersion": result.engine,
        },
    }


def _rate_interval(plan: PhysicalPlan, rows: list[dict[str, Any]]) -> dict[str, float] | None:
    if len(rows) != 1 or len(plan.measures) != 1 or plan.measures[0].unit != "percent":
        return None
    value = rows[0].get(plan.measures[0].alias)
    n = rows[0].get("n")
    if value is None or not isinstance(n, int) or n <= 0:
        return None
    z = 1.959963984540054
    denominator = 1 + z * z / n
    center = (value + z * z / (2 * n)) / denominator
    margin = z * math.sqrt(value * (1 - value) / n + z * z / (4 * n * n)) / denominator
    return {"low": max(0.0, center - margin), "high": min(1.0, center + margin)}


def _single_rate(plan: PhysicalPlan, rows: list[dict[str, Any]]) -> tuple[Any, float, int] | None:
    if len(rows) != 1 or len(plan.measures) != 1 or plan.measures[0].unit != "percent":
        return None
    measure = plan.measures[0]
    value = rows[0].get(measure.alias)
    sample_size = rows[0].get("n")
    if not isinstance(value, (int, float)) or not isinstance(sample_size, int) or sample_size <= 0:
        return None
    return measure, float(value), sample_size


def _wilson(value: float, n: int) -> dict[str, float]:
    z = 1.959963984540054
    denominator = 1 + z * z / n
    center = (value + z * z / (2 * n)) / denominator
    margin = z * math.sqrt(value * (1 - value) / n + z * z / (4 * n * n)) / denominator
    return {"low": max(0.0, center - margin), "high": min(1.0, center + margin)}


def _comparison_payload(plan: PhysicalPlan, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not plan.compare_arms or len(rows) != 1 or len(plan.measures) != 1:
        return None
    row = rows[0]
    measure = plan.measures[0]
    groups = []
    is_rate = measure.unit == "percent"
    for arm in plan.compare_arms:
        value = row.get(f"{measure.alias}_{arm.id}")
        n = row.get(f"n_{arm.id}")
        if not isinstance(n, int):
            continue
        group = {
            "id": arm.id,
            "labelKo": arm.label_ko,
            "value": float(value) if isinstance(value, (int, float)) else None,
            "n": n,
        }
        defined = row.get(f"defined_{measure.alias}_{arm.id}")
        if isinstance(defined, int):
            group["defined"] = defined
            group["coverage"] = defined / n if n > 0 else 0.0
        if is_rate:
            group["confidenceInterval95"] = (
                _wilson(float(value), n) if isinstance(value, (int, float)) and n > 0 else None
            )
        groups.append(group)
    if len(groups) < 2:
        return None
    first_value = groups[0]["value"]
    second_value = groups[1]["value"]
    difference = (
        first_value - second_value
        if isinstance(first_value, (int, float)) and isinstance(second_value, (int, float))
        else None
    )
    payload: dict[str, Any] = {
        "groups": groups,
        "unit": measure.unit,
        "measure": {
            "id": measure.id,
            "alias": measure.alias,
            "labelKo": measure.label_ko,
            "decimals": measure.decimals,
        },
    }
    if is_rate:
        payload["differencePoints"] = round(difference * 100, 6) if difference is not None else None
    else:
        payload["difference"] = (
            round(difference, measure.decimals if measure.decimals is not None else 6)
            if difference is not None
            else None
        )
    return payload


def _viz(result_shape: str) -> dict[str, Any]:
    if result_shape == "scalar":
        return {"primary": "kpi", "alternatives": [], "reasonKo": "결과가 하나의 값입니다."}
    if result_shape == "comparison":
        return {
            "primary": "comparison_bar",
            "alternatives": ["table"],
            "reasonKo": "두 조건의 값을 나란히 비교합니다.",
        }
    return {"primary": "bar", "alternatives": ["table"], "reasonKo": "분류별 값을 비교합니다."}


manager = RunManager(
    max_workers=settings.max_concurrent_runs,
    max_queued_runs=settings.max_queued_runs,
)
