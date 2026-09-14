"""Execution-engine interface and capability negotiation required by §18 and §32."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

import pyarrow as pa

from lod_api.compile.plan import PhysicalPlan


@dataclass(frozen=True, slots=True)
class EngineCapabilities:
    """Native engine features used by the planner to select physical operations."""

    spatial_polygon: bool
    temporal_window_join: bool
    list_unnest: bool
    streaming_progress: bool
    interrupt: bool
    max_parallelism: int


@dataclass(slots=True)
class ResultStats:
    """Mandatory result provenance required by §22."""

    total_units: int
    total_matches: int
    matched_units: int
    matched_matches: int
    #: Per-condition individual and cumulative funnel counts.
    conditions: list[dict[str, Any]] = field(default_factory=list)
    #: Counts by exclusion reason.
    excluded: list[dict[str, Any]] = field(default_factory=list)
    #: Coverage for measures defined only on some rows, such as event durations.
    measure_coverage: list[dict[str, Any]] = field(default_factory=list)
    #: Unfiltered population rates used as interpretation baselines.
    baseline_values: dict[str, float | None] = field(default_factory=dict)
    rows_scanned: int = 0
    elapsed_ms: float = 0.0


@dataclass(slots=True)
class ResultSet:
    """Engine result using Arrow as the stable interchange format."""

    result_type: str
    data: pa.Table
    stats: ResultStats
    #: Reference to matching units used by drill-down (§24).
    matched_ref: str | None = None
    #: Bounded coordinate sample for spatial minimap overlays.
    map_points: list[dict[str, Any]] = field(default_factory=list)
    sql: str = ""
    engine: str = ""


@runtime_checkable
class ExecutionEngine(Protocol):
    name: str

    def capabilities(self) -> EngineCapabilities: ...

    def execute(self, plan: PhysicalPlan, *, run_id: str) -> ResultSet: ...

    def explain(self, plan: PhysicalPlan) -> str: ...

    def cancel(self, run_id: str) -> bool: ...
