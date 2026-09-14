"""PhysicalPlan, the engine-neutral intermediate representation.

Engine replaceability (§32) requires an IR rather than a syntax-coupled AST boundary:

    AST JSON → PlanBuilder → PhysicalPlan → ExecutionEngine.execute()
                                              ├── DuckDBEngine (current)
                                              └── Polars/Rust (future)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal

Grain = Literal["match", "team", "player", "event"]


class AtomKind(StrEnum):
    """Atomic predicate kinds lowered differently by each engine."""

    EVENT_EXISTS = "event_exists"
    EVENT_GROUP = "event_group"
    EVENT_FIELD = "event_field"
    SPATIAL_REGION = "spatial_region"
    SPATIAL_RADIUS = "spatial_radius"
    FRAME_MEASURE = "frame_measure"
    TEMPORAL_GAP = "temporal_gap"
    ATTRIBUTE = "attribute"
    ROSTER = "roster"
    ITEM_STATE = "item_state"
    CONSTANT = "constant"


@dataclass(frozen=True, slots=True)
class EventBinding:
    """Witness materializing one event. Repeated references share one binding and row."""

    id: str  # e0, e1, ...
    binding_id: str  # Deterministic AST ID.
    event_id: str  # Catalog event ID.
    table: str
    where: str
    ordinal: str | int  # first | last | any | positive occurrence number
    #: Explicit blue/red restriction. None is interpreted with `any_team`.
    team_side: str | None
    #: An explicit `team.event` scope. False with no side means target-relative.
    any_team: bool
    #: Whether first occurrence is selected separately per team.
    per_team: bool
    #: Whether the witness belongs to the base-row participant.
    participant_scoped: bool
    #: Optional player name selector carried by `player("...")`.
    participant_selector: str | None
    label_ko: str


@dataclass(frozen=True, slots=True)
class FrameProbe:
    """Frame probe at a point in time, such as `gold_diff(10:00)`."""

    id: str  # g0, g1, ...
    measure: str  # gold_diff | xp_diff | kill_diff
    column: str
    at_seconds: float
    team_side: str | None
    label_ko: str


@dataclass(frozen=True, slots=True)
class RegionShape:
    """Geometry for spatial predicates in normalized game-oriented coordinates."""

    id: str
    kind: Literal["polygon", "rect", "circle", "multi"]
    payload: dict[str, Any]


@dataclass(frozen=True, slots=True)
class Atom:
    """One boolean column on a base row, enabling condition funnels in the same scan."""

    id: str  # f0, f1, ...
    kind: AtomKind
    #: Human-readable description used by the applied-conditions panel.
    label_ko: str
    #: Original DSL fragment.
    dsl: str
    #: Information required for engine lowering.
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class BoolNode:
    """Boolean tree over atom IDs preserving the original condition structure."""

    op: Literal["atom", "and", "or", "not", "true"]
    atom: str | None = None
    children: tuple[BoolNode, ...] = ()

    @staticmethod
    def always_true() -> BoolNode:
        return BoolNode(op="true")


@dataclass(frozen=True, slots=True)
class Measure:
    """One RETURN item."""

    id: str  # m0, m1, ...
    function: str
    label_ko: str
    alias: str
    #: Unit and precision used for result formatting.
    unit: str | None = None
    decimals: int | None = None
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class GroupKey:
    id: str
    label_ko: str
    sql: str
    alias: str
    min_sample: int | None = None
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ChainSpec:
    """Temporal chain such as `AFTER kill WITHIN 90s IF dragon_kill`."""

    trigger: EventBinding
    window_seconds: float | None
    target: EventBinding | None
    #: Whether the follow-up event must belong to the same team.
    same_team: bool
    #: Whether the follow-up event must belong to the trigger event's opposing team.
    opponent_team: bool
    #: Comparisons applied to the selected target event row.
    target_filters: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True, slots=True)
class CompareArm:
    id: str
    label_ko: str
    condition: BoolNode


@dataclass(frozen=True, slots=True)
class DatasetFilter:
    patch: str | None = None
    queue: str | None = None
    tier: str | None = None
    region: str | None = None
    #: Always-on filters such as remake exclusion.
    exclude_remakes: bool = True


@dataclass(frozen=True, slots=True)
class PhysicalPlan:
    grain: Grain
    grain_unit_ko: str
    team_side: str | None
    player_selector: str | None
    dataset: DatasetFilter

    bindings: tuple[EventBinding, ...]
    probes: tuple[FrameProbe, ...]
    regions: tuple[RegionShape, ...]
    atoms: tuple[Atom, ...]
    condition: BoolNode
    measures: tuple[Measure, ...]
    group_keys: tuple[GroupKey, ...]
    chain: ChainSpec | None = None
    #: Treat a successful follow-up as an eligibility filter. `success_rate()` is the
    #: exception: it intentionally keeps every trigger event in the denominator.
    chain_as_filter: bool = False
    compare_arms: tuple[CompareArm, ...] = ()

    #: Planner-owned result-shape hint.
    result_shape: str = "scalar"
    #: Denominator description (§22).
    denominator_ko: str = ""
    #: Source AST hash used by cache keys and drill-down tokens.
    ast_hash: str = ""

    def atom_by_id(self, atom_id: str) -> Atom:
        for atom in self.atoms:
            if atom.id == atom_id:
                return atom
        raise KeyError(atom_id)
