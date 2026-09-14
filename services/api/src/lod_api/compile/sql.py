"""Compile PhysicalPlan to parameterized DuckDB SQL with a flagged base join.

Base rows represent analysis units, event CTEs materialize witnesses, frame CTEs perform ASOF
probes, and flagged rows expose one boolean per condition. Results and provenance share the same
scan. User values are always parameters and identifiers come only from validated catalog data.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from lod_api.catalog import Catalog

from .plan import Atom, AtomKind, BoolNode, EventBinding, FrameProbe, PhysicalPlan

IDENTIFIER_RE = re.compile(r"^[a-z_][a-z0-9_]*$")

#: Columns exposed by event witnesses for conditions and measures.
WITNESS_COLUMNS = (
    "event_id",
    "timestamp_ms",
    "x_norm",
    "y_norm",
    "x_raw",
    "y_raw",
    "team_id",
    "participant_id",
    "champion_id",
    "role",
    "victim_id",
    "victim_team_id",
    "assist_ids",
    "assist_count",
    "lane_type",
    "tower_type",
    "event_subtype",
    "item_id",
    "ward_type",
    "level",
)

TEAM_ID = {"blue": 100, "red": 200}
COMPARISON_SQL = {
    "=": "=",
    "!=": "!=",
    ">": ">",
    ">=": ">=",
    "<": "<",
    "<=": "<=",
}


def safe_identifier(name: str) -> str:
    if not IDENTIFIER_RE.match(name):
        raise ValueError(f"허용되지 않는 식별자: {name!r}")
    return name


def safe_comparison_operator(operator: str) -> str:
    """Map a plan operator to a fixed SQL token rather than interpolating plan data."""
    try:
        return COMPARISON_SQL[operator]
    except KeyError as exc:
        raise ValueError(f"Unsupported comparison operator: {operator!r}") from exc


@dataclass
class CompiledQuery:
    sql: str
    params: dict[str, Any]
    #: Result column order and meaning.
    columns: list[str] = field(default_factory=list)
    #: Per-condition funnel column names.
    funnel_columns: list[str] = field(default_factory=list)
    #: Columns used to separate result and provenance from combined execution.
    result_columns: list[str] = field(default_factory=list)
    provenance_columns: list[str] = field(default_factory=list)


class SqlCompiler:
    def __init__(self, plan: PhysicalPlan, catalog: Catalog, *, has_spatial: bool = True) -> None:
        self.plan = plan
        self.catalog = catalog
        self.has_spatial = has_spatial
        self.params: dict[str, Any] = {}
        self._param_index = 0

    def param(self, value: Any) -> str:
        self._param_index += 1
        name = f"p{self._param_index}"
        self.params[name] = value
        return f"${name}"

    def _params_used_by(self, sql: str) -> dict[str, Any]:
        """Drop bindings introduced by SELECT expressions removed from derivative queries."""
        names = set(re.findall(r"\$(p\d+)\b", sql))
        return {name: value for name, value in self.params.items() if name in names}

    # ------------------------------------------------------------------ base

    def _dataset_where(self, alias: str = "m") -> list[str]:
        clauses: list[str] = []
        ds = self.plan.dataset
        if ds.patch:
            clauses.append(f"{alias}.patch = {self.param(ds.patch)}")
        if ds.queue:
            clauses.append(f"{alias}.queue = {self.param(ds.queue)}")
        if ds.tier:
            clauses.append(f"{alias}.tier = {self.param(ds.tier)}")
        if ds.region:
            clauses.append(f"{alias}.region = {self.param(ds.region)}")
        if ds.exclude_remakes:
            # Invalid matches would silently inflate the win-rate denominator.
            clauses.append(f"{alias}.winning_team IN (100, 200)")
            clauses.append(f"NOT {alias}.ended_early_surrender")
        item_landmarks = [
            float(atom.params["at_seconds"])
            for atom in self.plan.atoms
            if atom.kind == AtomKind.ITEM_STATE
        ]
        if item_landmarks:
            # Eligibility is applied before boolean conditions. Otherwise NOT owns_item_at(...)
            # would incorrectly include matches that ended before the requested landmark.
            clauses.append(f"{alias}.duration_s >= {self.param(max(item_landmarks))}")
        return clauses

    def _base_cte(self) -> str:
        grain = self.plan.grain
        where = self._dataset_where()

        if grain == "match":
            cond = " AND ".join(where) or "TRUE"
            return (
                "base AS (\n"
                "  SELECT m.*,\n"
                "         NULL::USMALLINT AS team_id,\n"
                "         NULL::UTINYINT AS participant_id,\n"
                "         (m.winning_team = 100) AS unit_win\n"
                f"  FROM matches m WHERE {cond}\n"
                ")"
            )

        if grain == "team":
            side = self.plan.team_side
            clauses = [*where]
            if side:
                clauses.append(f"s.team_id = {self.param(TEAM_ID[side])}")
            cond = " AND ".join(clauses) or "TRUE"
            return (
                "base AS (\n"
                "  SELECT s.*, NULL::UTINYINT AS participant_id, s.win AS unit_win\n"
                "  FROM match_summary s JOIN matches m USING (match_id)\n"
                f"  WHERE {cond}\n"
                ")"
            )

        if grain == "player":
            if self.plan.player_selector is not None:
                selector = self.param(self.plan.player_selector)
                where.append(f"(p.riot_id = {selector} OR p.summoner_name = {selector})")
            cond = " AND ".join(where) or "TRUE"
            return (
                "base AS (\n"
                "  SELECT p.*,\n"
                "         p.win AS unit_win,\n"
                "         m.duration_s, m.patch, m.queue, m.region\n"
                "  FROM participants p JOIN matches m USING (match_id)\n"
                f"  WHERE {cond}\n"
                ")"
            )

        # At event grain each reference event is one row.
        chain = self.plan.chain
        if chain is None:
            raise ValueError("사건 단위 분석에는 기준 사건이 필요합니다.")
        trigger = chain.trigger
        clauses = [*self._dataset_where("m"), trigger.where]
        if trigger.team_side:
            clauses.append(f"ev.team_id = {self.param(TEAM_ID[trigger.team_side])}")
        if trigger.participant_selector is not None:
            selector = self.param(trigger.participant_selector)
            clauses.append(
                "EXISTS (SELECT 1 FROM participants p "
                "WHERE p.match_id = ev.match_id AND p.participant_id = ev.participant_id "
                f"AND (p.riot_id = {selector} OR p.summoner_name = {selector}))"
            )
        cond = " AND ".join(c for c in clauses if c)
        occurrence = ""
        if trigger.ordinal != "any":
            descending = trigger.ordinal == "last"
            number = 1 if trigger.ordinal in {"first", "last"} else int(trigger.ordinal)
            partition = ["ev.match_id"]
            if trigger.participant_scoped:
                partition.append("ev.participant_id")
            elif trigger.per_team:
                partition.append("ev.team_id")
            direction = " DESC" if descending else ""
            occurrence = (
                "\n  QUALIFY row_number() OVER (PARTITION BY "
                + ", ".join(partition)
                + f" ORDER BY ev.timestamp_ms{direction}, ev.event_id{direction}) = "
                + self.param(number)
            )
        return (
            "base AS (\n"
            "  SELECT ev.match_id, ev.team_id, ev.participant_id, ev.event_id,\n"
            "         ev.timestamp_ms AS trigger_ms,\n"
            "         (m.winning_team = ev.team_id) AS unit_win,\n"
            "         m.duration_s, m.patch, m.queue, m.region\n"
            f"  FROM {safe_identifier(trigger.table)} ev JOIN matches m USING (match_id)\n"
            f"  WHERE {cond}{occurrence}\n"
            ")"
        )

    # -------------------------------------------------------------- witness

    def _witness_cte(self, binding: EventBinding) -> str:
        """Build one event witness using `arg_min` and reuse it across predicates and measures."""
        table = safe_identifier(binding.table)
        clauses = [binding.where]
        if binding.team_side:
            clauses.append(f"team_id = {self.param(TEAM_ID[binding.team_side])}")
        where = " AND ".join(c for c in clauses if c and c != "TRUE") or "TRUE"

        group_cols = ["match_id"]
        if binding.participant_scoped:
            group_cols.append("participant_id")
        elif binding.per_team:
            group_cols.append("team_id")
        picked = [
            c
            for c in self._available_columns(binding)
            if c not in group_cols and c != "timestamp_ms"
        ]

        if isinstance(binding.ordinal, int):
            columns = [*group_cols, "timestamp_ms", *picked]
            partition = ", ".join(group_cols)
            return (
                f"{binding.id} AS (\n"
                f"  SELECT {', '.join(columns)}\n"
                f"  FROM {table} WHERE {where}\n"
                f"  QUALIFY row_number() OVER (PARTITION BY {partition} "
                f"ORDER BY timestamp_ms, event_id) = {self.param(binding.ordinal)}\n"
                ")"
            )

        # Even ordinal=any selects one representative row so position and time share a witness.
        agg = "arg_max" if binding.ordinal == "last" else "arg_min"
        pick_ts = "max(timestamp_ms)" if binding.ordinal == "last" else "min(timestamp_ms)"
        order = "struct_pack(ts := timestamp_ms, id := event_id)"

        selects = [f"{pick_ts} AS timestamp_ms"] + [
            f"{agg}({col}, {order}) AS {col}" for col in picked
        ]
        return (
            f"{binding.id} AS (\n"
            f"  SELECT {', '.join(group_cols)}, {', '.join(selects)}\n"
            f"  FROM {table} WHERE {where}\n"
            f"  GROUP BY {', '.join(group_cols)}\n"
            ")"
        )

    def _probe_cte(self, probe: FrameProbe) -> str:
        """Build an ASOF probe for the latest frame at or before the requested time."""
        column = safe_identifier(probe.column)
        at_ms = int(probe.at_seconds * 1000)
        side_filter = (
            f"AND f.team_id = {self.param(TEAM_ID[probe.team_side])}" if probe.team_side else ""
        )
        # DuckDB requires the ASOF inequality between columns, so lift the constant into
        # the left side.
        return (
            f"{probe.id} AS (\n"
            f"  SELECT b.match_id, b.team_id, f.frame_idx AS frame_used, f.{column} AS value\n"
            f"  FROM (SELECT DISTINCT match_id, team_id, {at_ms}::BIGINT AS probe_ms FROM base) b\n"
            "  ASOF LEFT JOIN timeline_team_frames f\n"
            "    ON b.match_id = f.match_id\n"
            "   AND b.team_id = f.team_id\n"
            "   AND f.timestamp_ms <= b.probe_ms\n"
            f"  WHERE TRUE {side_filter}\n"
            ")"
        )

    # ---------------------------------------------------------------- Atoms

    def _binding_ref(self, binding_id: str) -> EventBinding:
        for binding in self.plan.bindings:
            if binding.id == binding_id:
                return binding
        raise KeyError(binding_id)

    def _carried(self, binding: EventBinding, column: str) -> str:
        """Return the carried column name used outside the flagged SELECT."""
        return f"{binding.id}__{column}"

    def _available_columns(self, binding: EventBinding) -> list[str]:
        """Return columns physically exposed by an event table or view."""
        declared = set(self.catalog.event(binding.event_id).columns)
        return [c for c in WITNESS_COLUMNS if c in declared]

    def _join_key(self, binding: EventBinding) -> str:
        keys = ["match_id"]
        if binding.participant_scoped:
            keys.append("participant_id")
        elif binding.per_team:
            keys.append("team_id")
        return " AND ".join(f"base.{k} = {binding.id}.{k}" for k in keys)

    def _is_repeatable_any(self, binding: EventBinding) -> bool:
        event = self.catalog.event(binding.event_id)
        return binding.ordinal == "any" and not event.at_most_once_per_match

    def _qualified_event_where(self, binding: EventBinding, alias: str) -> str:
        columns = set(self.catalog.event(binding.event_id).columns)
        return re.sub(
            r"\b([a-z_][a-z0-9_]*)\b",
            lambda match: (
                f"{alias}.{match.group(1)}" if match.group(1) in columns else match.group(1)
            ),
            binding.where,
        )

    def _raw_binding_clauses(self, binding: EventBinding, alias: str) -> list[str]:
        clauses = [f"{alias}.match_id = base.match_id", self._qualified_event_where(binding, alias)]
        if binding.team_side:
            clauses.append(f"{alias}.team_id = {self.param(TEAM_ID[binding.team_side])}")
        elif not binding.any_team and self.plan.grain in ("team", "player"):
            clauses.append(f"{alias}.team_id = base.team_id")
        if binding.participant_scoped and binding.participant_selector is None:
            clauses.append(f"{alias}.participant_id = base.participant_id")
        elif binding.participant_selector is not None:
            selector = self.param(binding.participant_selector)
            clauses.append(
                "EXISTS (SELECT 1 FROM participants scoped_player "
                f"WHERE scoped_player.match_id = {alias}.match_id "
                f"AND scoped_player.participant_id = {alias}.participant_id "
                f"AND (scoped_player.riot_id = {selector} "
                f"OR scoped_player.summoner_name = {selector}))"
            )
        return clauses

    def _event_exists_sql(self, binding: EventBinding) -> str:
        clauses = self._raw_binding_clauses(binding, "ev")
        where = " AND ".join(f"({clause})" for clause in clauses if clause and clause != "TRUE")
        return f"EXISTS (SELECT 1 FROM {safe_identifier(binding.table)} ev WHERE {where})"

    def _atom_sql(self, atom: Atom) -> str:
        kind = atom.kind

        if kind == AtomKind.EVENT_GROUP:
            binding = self._binding_ref(atom.params["binding"])
            region = next(r for r in self.plan.regions if r.id == atom.params["region"])
            if self._is_repeatable_any(binding):
                predicate = self._region_predicate(binding, region.payload, alias="ev")
                return self._spatial_exists(binding, predicate)
            exists = f"{binding.id}.match_id IS NOT NULL"
            predicate = self._region_predicate(binding, region.payload)
            return f"({exists} AND {predicate})"

        if kind == AtomKind.EVENT_EXISTS:
            binding = self._binding_ref(atom.params["binding"])
            if self._is_repeatable_any(binding):
                exists = self._event_exists_sql(binding)
            else:
                exists = f"{binding.id}.match_id IS NOT NULL"
            # For non-partitioned events, separately compare event and base-row teams.
            if (
                not self._is_repeatable_any(binding)
                and not binding.per_team
                and self.plan.grain == "team"
                and binding.team_side is None
                and not binding.any_team
            ):
                exists = f"({exists} AND {binding.id}.team_id = base.team_id)"
            else:
                exists = f"({exists})"
            if atom.params.get("negated"):
                return f"NOT coalesce({exists}, FALSE)"
            return exists

        if kind == AtomKind.EVENT_FIELD:
            binding = self._binding_ref(atom.params["binding"])
            existential = self._is_repeatable_any(binding)
            alias = "ev" if existential else binding.id
            expr = self._field_expr(binding, atom.params["sql"], alias=alias)
            raw_operator = atom.params["op"]
            if raw_operator == "CONTAINS ALL":
                if not existential:
                    raise ValueError("선택한 값 모두 조건에는 반복 사건이 필요합니다.")
                unique_values = tuple(dict.fromkeys(atom.params["values"]))
                placeholders = ", ".join(self.param(value) for value in unique_values)
                clauses = [
                    *self._raw_binding_clauses(binding, alias),
                    f"{expr} IN ({placeholders})",
                ]
                where = " AND ".join(
                    f"({clause})" for clause in clauses if clause and clause != "TRUE"
                )
                return (
                    f"((SELECT count(DISTINCT {expr}) FROM "
                    f"{safe_identifier(binding.table)} {alias} WHERE {where}) = "
                    f"{self.param(len(unique_values))})"
                )
            if raw_operator in {"IN", "NOT IN"}:
                placeholders = ", ".join(self.param(value) for value in atom.params["values"])
                predicate = f"({expr} {raw_operator} ({placeholders}))"
            elif raw_operator == "BETWEEN":
                lower = self.param(atom.params["value"])
                upper = self.param(atom.params["upper"])
                predicate = f"({expr} BETWEEN {lower} AND {upper})"
            else:
                operator = safe_comparison_operator(raw_operator)
                predicate = f"({expr} {operator} {self.param(atom.params['value'])})"
            if existential:
                clauses = [*self._raw_binding_clauses(binding, alias), predicate]
                where = " AND ".join(
                    f"({clause})" for clause in clauses if clause and clause != "TRUE"
                )
                return (
                    f"EXISTS (SELECT 1 FROM {safe_identifier(binding.table)} {alias} WHERE {where})"
                )
            return predicate

        if kind == AtomKind.SPATIAL_REGION:
            binding = self._binding_ref(atom.params["binding"])
            region = next(r for r in self.plan.regions if r.id == atom.params["region"])
            if self._needs_existential_spatial(binding):
                predicate = self._region_predicate(binding, region.payload, alias="ev")
                return self._spatial_exists(binding, predicate)
            return self._region_predicate(binding, region.payload)

        if kind == AtomKind.SPATIAL_RADIUS:
            binding = self._binding_ref(atom.params["binding"])
            radius = atom.params["radius"]
            target_x = atom.params["target_x"]
            target_y = atom.params["target_y"]
            alias = "ev" if self._needs_existential_spatial(binding) else binding.id
            # Distance uses raw game coordinates because user radius values are game units.
            predicate = (
                f"(({alias}.x_raw - {self.param(target_x)})"
                f" * ({alias}.x_raw - {self.param(target_x)})"
                f" + ({alias}.y_raw - {self.param(target_y)})"
                f" * ({alias}.y_raw - {self.param(target_y)})"
                f" <= {self.param(radius * radius)})"
            )
            return (
                self._spatial_exists(binding, predicate)
                if self._needs_existential_spatial(binding)
                else predicate
            )

        if kind == AtomKind.FRAME_MEASURE:
            probe = next(p for p in self.plan.probes if p.id == atom.params["probe"])
            operator = safe_comparison_operator(atom.params["op"])
            return f"({probe.id}.value {operator} {self.param(atom.params['value'])})"

        if kind == AtomKind.ATTRIBUTE:
            expression = str(atom.params["sql"])
            if atom.params["op"] in {"IN", "NOT IN"}:
                placeholders = ", ".join(self.param(value) for value in atom.params["values"])
                return f"(({expression}) {atom.params['op']} ({placeholders}))"
            operator = safe_comparison_operator(atom.params["op"])
            return f"(({expression}) {operator} {self.param(atom.params['value'])})"

        if kind == AtomKind.ROSTER:
            champions = tuple(dict.fromkeys(atom.params["champions"]))
            placeholders = ", ".join(self.param(champion) for champion in champions)
            relation = atom.params.get("relation")
            team_predicate = (
                "roster.team_id <> base.team_id"
                if relation == "opponent"
                else "roster.team_id = base.team_id"
            )
            extra = ""
            if relation == "ally" and self.plan.grain == "player":
                extra += " AND roster.participant_id <> base.participant_id"
            if atom.params.get("role"):
                extra += f" AND roster.role = {self.param(atom.params['role'])}"
            return (
                "EXISTS (SELECT 1 FROM participants roster "
                "WHERE roster.match_id = base.match_id "
                f"AND {team_predicate}{extra} AND roster.champion IN ({placeholders}))"
            )

        if kind == AtomKind.ITEM_STATE:
            return self._item_state_sql(atom)

        if kind == AtomKind.TEMPORAL_GAP:
            start = self._binding_ref(atom.params["start"])
            end = self._binding_ref(atom.params["end"])
            if self._is_repeatable_any(start) or self._is_repeatable_any(end):
                return self._temporal_exists_sql(start, end, atom.params.get("window"))
            window = atom.params.get("window")
            gap = f"({end.id}.timestamp_ms::BIGINT - {start.id}.timestamp_ms::BIGINT)"
            ordered = f"({gap} > 0 OR ({gap} = 0 AND {end.id}.event_id > {start.id}.event_id))"
            parts = [f"{end.id}.match_id IS NOT NULL", ordered]
            if window:
                parts.append(f"{gap} <= {self.param(int(window * 1000))}")
            return "(" + " AND ".join(parts) + ")"

        raise ValueError(f"아직 SQL로 내릴 수 없는 조건입니다: {kind}")

    def _item_scope_sql(self, alias: str, relation: str) -> str:
        if self.plan.grain == "player":
            if relation == "opponent":
                return f"{alias}.team_id <> base.team_id"
            return f"{alias}.participant_id = base.participant_id"
        operator = "<>" if relation == "opponent" else "="
        return f"{alias}.team_id {operator} base.team_id"

    def _item_state_sql(self, atom: Atom) -> str:
        at_ms = self.param(int(float(atom.params["at_seconds"]) * 1000))
        item_ids = tuple(dict.fromkeys(atom.params["item_ids"]))
        relation = str(atom.params.get("relation") or "target")
        placeholders = ", ".join(self.param(item_id) for item_id in item_ids)
        scope = self._item_scope_sql("item_event", relation)
        common = (
            "item_event.match_id = base.match_id "
            f"AND {scope} AND item_event.timestamp_ms <= {at_ms}"
        )
        if atom.params["mode"] == "purchased_by":
            return (
                "EXISTS (SELECT 1 FROM events item_event WHERE "
                f"{common} AND item_event.event_type = 'item_purchase' "
                f"AND item_event.item_id IN ({placeholders}))"
            )

        # Riot ITEM_UNDO has beforeId (removed) and afterId (restored). Treat every event as
        # an inventory delta and retain item stacks whose net quantity is positive at the cutoff.
        return (
            "EXISTS (SELECT 1 FROM ("
            "SELECT inventory_delta.participant_id, inventory_delta.item_id "
            "FROM ("
            "SELECT item_event.participant_id, item_event.item_id, "
            "CASE WHEN item_event.event_type = 'item_purchase' THEN 1 ELSE -1 END AS delta "
            f"FROM events item_event WHERE {common} "
            "AND item_event.event_type IN "
            "('item_purchase', 'item_sell', 'item_destroy', 'item_undo') "
            f"AND item_event.item_id IN ({placeholders}) "
            "UNION ALL "
            "SELECT item_event.participant_id, item_event.item_after_id AS item_id, 1 AS delta "
            f"FROM events item_event WHERE {common} "
            "AND item_event.event_type = 'item_undo' "
            f"AND item_event.item_after_id IN ({placeholders})"
            ") inventory_delta "
            "GROUP BY inventory_delta.participant_id, inventory_delta.item_id "
            "HAVING sum(inventory_delta.delta) > 0"
            ") owned_item)"
        )

    def _temporal_exists_sql(
        self, start: EventBinding, end: EventBinding, window: float | None
    ) -> str:
        sources: list[str] = []
        clauses: list[str] = []

        def order_key(binding: EventBinding, alias: str) -> tuple[str, str]:
            if self._is_repeatable_any(binding):
                sources.append(f"{safe_identifier(binding.table)} {alias}")
                clauses.extend(self._raw_binding_clauses(binding, alias))
                return f"{alias}.timestamp_ms", f"{alias}.event_id"
            return f"{binding.id}.timestamp_ms", f"{binding.id}.event_id"

        start_ts, start_id = order_key(start, "tev_start")
        end_ts, end_id = order_key(end, "tev_end")
        gap = f"({end_ts}::BIGINT - {start_ts}::BIGINT)"
        clauses.append(f"({gap} > 0 OR ({gap} = 0 AND {end_id} > {start_id}))")
        if window is not None:
            clauses.append(f"{gap} <= {self.param(int(window * 1000))}")
        where = " AND ".join(f"({clause})" for clause in clauses if clause and clause != "TRUE")
        return f"EXISTS (SELECT 1 FROM {' CROSS JOIN '.join(sources)} WHERE {where})"

    def _field_expr(self, binding: EventBinding, sql: Any, *, alias: str | None = None) -> str:
        if isinstance(sql, dict):
            raise ValueError("위치는 비교가 아니라 영역 조건으로 써야 합니다.")
        # Catalog SQL is a column or simple expression; qualify it with the witness alias.
        source = alias or binding.id
        return re.sub(
            r"\b([a-z_][a-z0-9_]*)\b",
            lambda m: f"{source}.{m.group(1)}" if m.group(1) in WITNESS_COLUMNS else m.group(1),
            str(sql),
        )

    def _needs_existential_spatial(self, binding: EventBinding) -> bool:
        """Compile repeated-event region membership as an existential condition."""
        event = self.catalog.event(binding.event_id)
        return binding.ordinal == "any" and not event.at_most_once_per_match

    def _spatial_exists(self, binding: EventBinding, predicate: str) -> str:
        clauses = [*self._raw_binding_clauses(binding, "ev"), predicate]
        where = " AND ".join(f"({clause})" for clause in clauses if clause and clause != "TRUE")
        return f"EXISTS (SELECT 1 FROM {safe_identifier(binding.table)} ev WHERE {where})"

    def _region_predicate(
        self, binding: EventBinding, shape: dict[str, Any], *, alias: str | None = None
    ) -> str:
        """Compile containment with a bounding-box prefilter and shape-specialized exact test."""
        source = alias or binding.id
        x = f"{source}.x_norm"
        y = f"{source}.y_norm"
        kind = shape["kind"]

        if kind == "rect":
            x0, x1 = sorted((shape["x0"], shape["x1"]))
            y0, y1 = sorted((shape["y0"], shape["y1"]))
            return (
                f"({x} BETWEEN {self.param(x0)} AND {self.param(x1)}"
                f" AND {y} BETWEEN {self.param(y0)} AND {self.param(y1)})"
            )

        if kind == "circle":
            cx, cy, r = shape["cx"], shape["cy"], shape["r"]
            return (
                f"(({x} - {self.param(cx)}) * ({x} - {self.param(cx)})"
                f" + ({y} - {self.param(cy)}) * ({y} - {self.param(cy)})"
                f" <= {self.param(r * r)})"
            )

        if kind == "multi":
            parts = [self._region_predicate(binding, part, alias=alias) for part in shape["parts"]]
            return "(" + " OR ".join(parts) + ")"

        points = [(float(px), float(py)) for px, py in shape["points"]]
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        bbox = (
            f"{x} BETWEEN {self.param(min(xs))} AND {self.param(max(xs))}"
            f" AND {y} BETWEEN {self.param(min(ys))} AND {self.param(max(ys))}"
        )

        if self.has_spatial:
            ring = ", ".join(f"{px} {py}" for px, py in [*points, points[0]])
            wkt = f"POLYGON(({ring}))"
            exact = f"ST_Within(ST_Point({x}, {y}), ST_GeomFromText({self.param(wkt)}))"
        else:
            exact = self._raycast(x, y, points)

        return f"({bbox} AND {exact})"

    def _raycast(self, x: str, y: str, points: list[tuple[float, float]]) -> str:
        """Compile the TypeScript-equivalent even-odd ray-casting fallback as SQL."""
        terms = []
        n = len(points)
        for i in range(n):
            xi, yi = points[i]
            xj, yj = points[(i - 1) % n]
            pxi, pyi = self.param(xi), self.param(yi)
            pxj, pyj = self.param(xj), self.param(yj)
            terms.append(
                f"CASE WHEN (({pyi} > {y}) <> ({pyj} > {y}))"
                f" AND ({x} < ({pxj} - {pxi}) * ({y} - {pyi})"
                f" / nullif({pyj} - {pyi}, 0) + {pxi}) THEN 1 ELSE 0 END"
            )
        return "((" + " + ".join(terms) + ") % 2 = 1)"

    # ------------------------------------------------------------ Boolean assembly

    def _bool_sql(self, node: BoolNode) -> str:
        if node.op == "true":
            return "TRUE"
        if node.op == "atom":
            return node.atom or "TRUE"
        if node.op == "not":
            inner = self._bool_sql(node.children[0])
            # Treat null as false because a missing event did not occur.
            return f"NOT coalesce({inner}, FALSE)"
        joiner = " AND " if node.op == "and" else " OR "
        return "(" + joiner.join(self._bool_sql(c) for c in node.children) + ")"

    def _selection_sql(self) -> str:
        """Return the complete eligibility predicate for result rows and drill-down."""
        condition = self._bool_sql(self.plan.condition)
        if self.plan.chain_as_filter:
            return f"({condition}) AND coalesce(chain_hit, FALSE)"
        return condition

    # ------------------------------------------------------------ Measure SQL

    def _carried_columns(self) -> list[str]:
        """Carry witness columns needed by measures into flagged rows."""
        out: list[str] = []
        seen: set[tuple[str, str]] = set()
        for measure in self.plan.measures:
            duration = measure.params.get("duration")
            if duration:
                for binding_id in (duration["start"], duration["end"]):
                    binding = self._binding_ref(binding_id)
                    self._append_carried(out, seen, binding, "timestamp_ms")
            field_param = measure.params.get("field")
            if field_param:
                binding = self._binding_ref(field_param["binding"])
                declared = set(self.catalog.event(binding.event_id).columns)
                for name in re.findall(r"\b[a-z_][a-z0-9_]*\b", str(field_param["sql"])):
                    if name in declared:
                        self._append_carried(out, seen, binding, name)
        for key in self.plan.group_keys:
            binding_id = key.params.get("binding")
            column = key.params.get("column")
            if not binding_id or not column or (binding_id, column) in seen:
                continue
            binding = self._binding_ref(binding_id)
            self._append_carried(out, seen, binding, column)
        return out

    def _append_carried(
        self,
        out: list[str],
        seen: set[tuple[str, str]],
        binding: EventBinding,
        column: str,
    ) -> None:
        if (binding.id, column) in seen:
            return
        seen.add((binding.id, column))
        out.append(f"    {binding.id}.{column} AS {self._carried(binding, column)}")

    def _measure_sql(self, measure: Any) -> str:
        fn = self.catalog.function(measure.function)
        template = fn.get("sqlTemplate")

        if measure.function == "win_rate":
            return "avg(CASE WHEN unit_win THEN 1.0 ELSE 0.0 END)"
        if measure.function == "loss_rate":
            return "avg(CASE WHEN NOT unit_win THEN 1.0 ELSE 0.0 END)"
        if measure.function == "success_rate":
            return "avg(CASE WHEN chain_hit THEN 1.0 ELSE 0.0 END)"
        if measure.function in {
            "pick_rate",
            "ban_rate",
            "champion_win_rate",
            "champion_games",
            "role_pick_rate",
        }:
            champion = self.param(measure.params["champion"])
            picked_matches = (
                "SELECT DISTINCT champion_player.match_id FROM participants champion_player "
                f"WHERE champion_player.champion = {champion}"
            )
            if measure.function == "pick_rate":
                return f"avg(CASE WHEN match_id IN ({picked_matches}) THEN 1.0 ELSE 0.0 END)"
            if measure.function == "champion_games":
                return f"count(DISTINCT CASE WHEN match_id IN ({picked_matches}) THEN match_id END)"
            if measure.function == "champion_win_rate":
                won_matches = (
                    "SELECT DISTINCT champion_player.match_id FROM participants champion_player "
                    f"WHERE champion_player.champion = {champion} AND champion_player.win"
                )
                return (
                    f"avg(CASE WHEN match_id IN ({won_matches}) THEN 1.0 "
                    f"WHEN match_id IN ({picked_matches}) THEN 0.0 END)"
                )
            if measure.function == "ban_rate":
                banned_matches = (
                    "SELECT DISTINCT ban_team.match_id FROM teams ban_team, "
                    "UNNEST(ban_team.bans) AS banned(champion_id) "
                    "WHERE banned.champion_id IN (SELECT DISTINCT champion_id "
                    f"FROM participants WHERE champion = {champion})"
                )
                return f"avg(CASE WHEN match_id IN ({banned_matches}) THEN 1.0 ELSE 0.0 END)"
            role = self.param(measure.params["role"])
            return (
                "avg(CASE WHEN match_id IN (SELECT DISTINCT role_player.match_id "
                "FROM participants role_player WHERE role_player.champion = "
                f"{champion} AND role_player.role = {role}) THEN 0.5 ELSE 0.0 END)"
            )

        duration = measure.params.get("duration")
        if duration:
            start = self._binding_ref(duration["start"])
            end = self._binding_ref(duration["end"])
            # Reverse event order is undefined; do not mix negative durations into averages.
            start_ts = self._carried(start, "timestamp_ms")
            end_ts = self._carried(end, "timestamp_ms")
            expr = (
                f"CASE WHEN {end_ts} >= {start_ts} "
                f"THEN ({end_ts}::BIGINT - {start_ts}::BIGINT) / 1000.0 END"
            )
            return (template or "avg({0})").replace("{0}", expr)

        condition = measure.params.get("condition")
        if condition is not None:
            if measure.function != "rate":
                raise ValueError("조건 집계는 발생 비율에서만 사용할 수 있습니다.")
            expr = self._bool_sql(condition)
            return (template or "avg(CASE WHEN {0} THEN 1.0 ELSE 0.0 END)").replace("{0}", expr)

        field_param = measure.params.get("field")
        if field_param:
            binding = self._binding_ref(field_param["binding"])
            raw = str(field_param["sql"])
            declared = set(self.catalog.event(binding.event_id).columns)
            expr = re.sub(
                r"\b([a-z_][a-z0-9_]*)\b",
                lambda match: (
                    self._carried(binding, match.group(1))
                    if match.group(1) in declared
                    else match.group(1)
                ),
                raw,
            )
            return (template or "avg({0})").replace("{0}", expr)

        subject = measure.params.get("subject")
        if subject:
            return (template or "avg({0})").replace("{0}", str(subject["sql"]))

        probe_id = measure.params.get("probe")
        if probe_id:
            expr = f"{probe_id}__value"
            return (template or "avg({0})").replace("{0}", expr)

        if "literal" in measure.params:
            expr = self.param(measure.params["literal"])
            return (template or "avg({0})").replace("{0}", expr)

        if measure.function == "count":
            return "count(*)"
        raise ValueError(f"아직 계산할 수 없는 측정값입니다: {measure.function}")

    def _measure_defined_sql(self, measure: Any) -> str | None:
        """Return the condition under which a measure is defined for this unit."""
        duration = measure.params.get("duration")
        if duration:
            start = self._binding_ref(duration["start"])
            end = self._binding_ref(duration["end"])
            start_ts = self._carried(start, "timestamp_ms")
            end_ts = self._carried(end, "timestamp_ms")
            return f"{start_ts} IS NOT NULL AND {end_ts} IS NOT NULL AND {end_ts} >= {start_ts}"
        field_param = measure.params.get("field")
        if field_param:
            binding = self._binding_ref(field_param["binding"])
            return f"{self._carried(binding, 'timestamp_ms')} IS NOT NULL"
        probe_id = measure.params.get("probe")
        if probe_id:
            return f"{probe_id}__value IS NOT NULL"
        return None

    # --------------------------------------------------------------- Assembly

    def compile(self) -> CompiledQuery:
        plan = self.plan
        ctes: list[str] = [self._base_cte()]
        ctes += [self._witness_cte(b) for b in plan.bindings]
        ctes += [self._probe_cte(p) for p in plan.probes]

        joins = []
        for binding in plan.bindings:
            joins.append(f"  LEFT JOIN {binding.id} ON {self._join_key(binding)}")
        for probe in plan.probes:
            key = f"base.match_id = {probe.id}.match_id"
            if plan.grain in ("team", "player"):
                key += f" AND base.team_id = {probe.id}.team_id"
            joins.append(f"  LEFT JOIN {probe.id} ON {key}")

        flag_columns = [f"    {self._atom_sql(atom)} AS {atom.id}" for atom in plan.atoms]
        probe_columns = [
            f"    {p.id}.frame_used AS {p.id}_frame, {p.id}.value AS {p.id}__value"
            for p in plan.probes
        ]
        carried = self._carried_columns()

        chain_column: list[str] = []
        if plan.chain and plan.chain.target is not None:
            chain_column = [f"    {self._chain_hit_sql()} AS chain_hit"]

        select_parts = ["    base.*", *flag_columns, *probe_columns, *carried, *chain_column]
        ctes.append(
            "flagged AS (\n  SELECT\n"
            + ",\n".join(select_parts)
            + "\n  FROM base\n"
            + "\n".join(joins)
            + "\n)"
        )

        # Aggregate comparison arms in one scan so both branches observe identical data.
        if plan.compare_arms:
            arm_columns: list[str] = []
            columns: list[str] = []
            for arm in plan.compare_arms:
                cond = self._bool_sql(arm.condition)
                for measure in plan.measures:
                    expr = self._measure_sql(measure)
                    alias = f"{measure.alias}_{arm.id}"
                    arm_columns.append(f"{expr} FILTER (WHERE {cond}) AS {alias}")
                    columns.append(alias)
                    defined = self._measure_defined_sql(measure)
                    if defined is not None:
                        defined_alias = f"defined_{measure.alias}_{arm.id}"
                        arm_columns.append(
                            f"count(*) FILTER (WHERE ({cond}) AND ({defined})) AS {defined_alias}"
                        )
                        columns.append(defined_alias)
                arm_columns.append(f"count(*) FILTER (WHERE {cond}) AS n_{arm.id}")
                columns.append(f"n_{arm.id}")
            sql = (
                "WITH " + ",\n".join(ctes) + "\nSELECT " + ", ".join(arm_columns) + "\nFROM flagged"
            )
            return CompiledQuery(sql=sql, params=dict(self.params), columns=columns)

        condition_sql = self._selection_sql()
        ctes.append(f"matched AS (SELECT * FROM flagged WHERE {condition_sql})")

        group_cols = [f"{k.sql} AS {safe_identifier(k.alias)}" for k in plan.group_keys]
        measure_cols = [
            f"{self._measure_sql(m)} AS {safe_identifier(m.alias)}" for m in plan.measures
        ]

        if plan.group_keys:
            keys = ", ".join(safe_identifier(k.alias) for k in plan.group_keys)
            having = ""
            min_sample = max((k.min_sample or 0) for k in plan.group_keys)
            if min_sample:
                having = f"\n  HAVING count(*) >= {self.param(min_sample)}"
            sql = (
                "WITH "
                + ",\n".join(ctes)
                + f"\nSELECT {', '.join(group_cols)}, {', '.join(measure_cols)}, count(*) AS n\n"
                + f"FROM matched\nGROUP BY {keys}{having}\nORDER BY n DESC"
            )
            columns = [k.alias for k in plan.group_keys] + [m.alias for m in plan.measures] + ["n"]
            return CompiledQuery(sql=sql, params=dict(self.params), columns=columns)

        sql = (
            "WITH "
            + ",\n".join(ctes)
            + f"\nSELECT {', '.join(measure_cols)}, count(*) AS n\nFROM matched"
        )
        columns = [m.alias for m in plan.measures] + ["n"]
        return CompiledQuery(sql=sql, params=dict(self.params), columns=columns)

    def _chain_hit_sql(self) -> str:
        """Compile whether a strictly later follow-up occurs inside the chain window."""
        chain = self.plan.chain
        if chain is None or chain.target is None:
            raise RuntimeError("chain SQL requested without a complete chain plan")
        target = chain.target
        identity_clauses = [
            "t.match_id = base.match_id",
            self._qualified_event_where(target, "t"),
        ]
        if target.team_side:
            identity_clauses.append(f"t.team_id = {self.param(TEAM_ID[target.team_side])}")
        elif chain.opponent_team:
            identity_clauses.append("t.team_id <> base.team_id")
        elif chain.same_team and not target.any_team:
            identity_clauses.append("t.team_id = base.team_id")
        if target.participant_selector is not None:
            selector = self.param(target.participant_selector)
            identity_clauses.append(
                "EXISTS (SELECT 1 FROM participants scoped_player "
                "WHERE scoped_player.match_id = t.match_id "
                "AND scoped_player.participant_id = t.participant_id "
                f"AND (scoped_player.riot_id = {selector} "
                f"OR scoped_player.summoner_name = {selector}))"
            )
        elif target.participant_scoped:
            identity_clauses.append("t.participant_id = base.participant_id")

        temporal_clauses = [
            "(t.timestamp_ms > base.trigger_ms "
            "OR (t.timestamp_ms = base.trigger_ms AND t.event_id > base.event_id))"
        ]
        if chain.window_seconds is not None:
            window_ms = int(chain.window_seconds * 1000)
            temporal_clauses.append(f"t.timestamp_ms <= base.trigger_ms + {self.param(window_ms)}")

        def filter_clauses(alias: str) -> list[str]:
            clauses: list[str] = []
            for item in chain.target_filters:
                expr = self._field_expr(target, item["sql"], alias=alias)
                if item["op"] == "CONTAINS ALL":
                    continue
                if item["op"] in {"IN", "NOT IN"}:
                    placeholders = ", ".join(self.param(value) for value in item["values"])
                    clauses.append(f"{expr} {item['op']} ({placeholders})")
                else:
                    operator = safe_comparison_operator(item["op"])
                    clauses.append(f"{expr} {operator} {self.param(item['value'])}")
            return clauses

        all_filters = [item for item in chain.target_filters if item["op"] == "CONTAINS ALL"]
        if all_filters:
            if target.ordinal != "any" or len(all_filters) != 1:
                raise ValueError("선택한 값 모두 조건은 순서 없는 끝 사건 하나에만 쓸 수 있습니다.")
            item = all_filters[0]
            unique_values = tuple(dict.fromkeys(item["values"]))
            expr = self._field_expr(target, item["sql"], alias="t")
            placeholders = ", ".join(self.param(value) for value in unique_values)
            clauses = [
                *identity_clauses,
                *temporal_clauses,
                *filter_clauses("t"),
                f"{expr} IN ({placeholders})",
            ]
            where = " AND ".join(f"({clause})" for clause in clauses if clause and clause != "TRUE")
            return (
                f"((SELECT count(DISTINCT {expr}) FROM {safe_identifier(target.table)} t "
                f"WHERE {where}) = {self.param(len(unique_values))})"
            )

        if target.ordinal != "any":
            descending = target.ordinal == "last"
            occurrence = 1 if target.ordinal in {"first", "last"} else int(target.ordinal)
            partition = "t.match_id"
            if chain.opponent_team or (chain.same_team and not target.any_team):
                partition += ", t.team_id"
            identity = " AND ".join(f"({clause})" for clause in identity_clauses)
            temporal = " AND ".join(
                f"({clause.replace('t.', 'ranked.')})"
                for clause in [*temporal_clauses, *filter_clauses("ranked")]
            )
            direction = " DESC" if descending else ""
            return (
                "EXISTS (SELECT 1 FROM (SELECT t.* FROM "
                f"{safe_identifier(target.table)} t WHERE {identity} "
                f"QUALIFY row_number() OVER (PARTITION BY {partition} "
                f"ORDER BY t.timestamp_ms{direction}, t.event_id{direction}) = "
                f"{self.param(occurrence)}) ranked WHERE {temporal})"
            )

        clauses = [*identity_clauses, *temporal_clauses, *filter_clauses("t")]
        where = " AND ".join(f"({clause})" for clause in clauses)
        return f"EXISTS (SELECT 1 FROM {safe_identifier(target.table)} t WHERE {where})"

    def compile_provenance(self) -> CompiledQuery:
        """Compile denominators, numerators, and condition funnels in the same scan."""
        plan = self.plan
        ctes: list[str] = [self._base_cte()]
        ctes += [self._witness_cte(b) for b in plan.bindings]
        ctes += [self._probe_cte(p) for p in plan.probes]

        joins = []
        for binding in plan.bindings:
            joins.append(f"  LEFT JOIN {binding.id} ON {self._join_key(binding)}")
        for probe in plan.probes:
            key = f"base.match_id = {probe.id}.match_id"
            if plan.grain in ("team", "player"):
                key += f" AND base.team_id = {probe.id}.team_id"
            joins.append(f"  LEFT JOIN {probe.id} ON {key}")

        flag_columns = [f"    {self._atom_sql(atom)} AS {atom.id}" for atom in plan.atoms]
        probe_columns = [
            f"    {p.id}.frame_used AS {p.id}_frame, {p.id}.value AS {p.id}__value"
            for p in plan.probes
        ]
        carried = self._carried_columns()
        chain_column = (
            [f"    {self._chain_hit_sql()} AS chain_hit"]
            if plan.chain and plan.chain.target is not None
            else []
        )
        ctes.append(
            "flagged AS (\n  SELECT\n"
            + ",\n".join(["    base.*", *flag_columns, *probe_columns, *carried, *chain_column])
            + "\n  FROM base\n"
            + "\n".join(joins)
            + "\n)"
        )

        aggregates = [
            "count(*) AS total_units",
            "count(DISTINCT match_id) AS total_matches",
        ]
        columns = ["total_units", "total_matches"]
        funnel_columns: list[str] = []

        # Per-condition individual matches.
        for atom in plan.atoms:
            aggregates.append(
                f"count(*) FILTER (WHERE coalesce({atom.id}, FALSE)) AS alone_{atom.id}"
            )
            funnel_columns.append(f"alone_{atom.id}")
            columns.append(f"alone_{atom.id}")

        if plan.chain and plan.chain.target is not None:
            aggregates.append("count(*) FILTER (WHERE coalesce(chain_hit, FALSE)) AS alone_chain")
            funnel_columns.append("alone_chain")
            columns.append("alone_chain")

        # Cumulative AND-chain matches; OR/NOT trees report only individual matches.
        chain_atoms = _conjunction_atoms(plan.condition)
        if chain_atoms:
            accumulated: list[str] = []
            for index, atom_id in enumerate(chain_atoms):
                accumulated.append(f"coalesce({atom_id}, FALSE)")
                aggregates.append(
                    f"count(*) FILTER (WHERE {' AND '.join(accumulated)}) AS cum_{index}"
                )
                funnel_columns.append(f"cum_{index}")
                columns.append(f"cum_{index}")

        if plan.chain_as_filter:
            base_condition = self._bool_sql(plan.condition)
            aggregates.append(
                "count(*) FILTER (WHERE "
                f"({base_condition}) AND coalesce(chain_hit, FALSE)) AS cum_chain"
            )
            funnel_columns.append("cum_chain")
            columns.append("cum_chain")

        condition_sql = (
            " OR ".join(f"({self._bool_sql(a.condition)})" for a in plan.compare_arms)
            if plan.compare_arms
            else self._selection_sql()
        )
        aggregates.append(f"count(*) FILTER (WHERE {condition_sql}) AS matched_units")
        aggregates.append(
            f"count(DISTINCT match_id) FILTER (WHERE {condition_sql}) AS matched_matches"
        )
        columns += ["matched_units", "matched_matches"]

        for measure in plan.measures:
            # Calculate unfiltered rate baselines from the same flagged aggregation.
            if measure.unit == "percent":
                name = f"baseline_{measure.id}"
                aggregates.append(f"{self._measure_sql(measure)} AS {name}")
                columns.append(name)
            defined = self._measure_defined_sql(measure)
            if defined:
                name = f"defined_{measure.id}"
                aggregates.append(
                    f"count(*) FILTER (WHERE ({condition_sql}) AND ({defined})) AS {name}"
                )
                columns.append(name)

        # Survivorship count: null probes where a match ended before the requested time.
        for probe in plan.probes:
            aggregates.append(
                f"count(*) FILTER (WHERE {probe.id}_frame IS NULL) AS missing_{probe.id}"
            )
            columns.append(f"missing_{probe.id}")

        sql = (
            "WITH "
            + ",\n".join(ctes)
            + "\nSELECT "
            + ",\n       ".join(aggregates)
            + "\nFROM flagged"
        )
        return CompiledQuery(
            sql=sql,
            params=dict(self.params),
            columns=columns,
            funnel_columns=funnel_columns,
        )

    def compile_combined(self) -> CompiledQuery:
        """Compile one SQL statement where results and provenance share `flagged`."""
        main = self.compile()
        provenance = SqlCompiler(
            self.plan, self.catalog, has_spatial=self.has_spatial
        ).compile_provenance()
        if any(main.params.get(key) != value for key, value in provenance.params.items()):
            raise AssertionError("결과와 provenance의 파라미터 바인딩이 어긋났습니다.")
        main_prefix, main_select = main.sql.rsplit("\nSELECT ", 1)
        _, provenance_select = provenance.sql.rsplit("\nSELECT ", 1)
        sql = (
            main_prefix
            + ",\n_result AS (\n  SELECT "
            + main_select.replace("\n", "\n  ")
            + "\n),\n_provenance AS (\n  SELECT "
            + provenance_select.replace("\n", "\n  ")
            + "\n)\nSELECT _result.*, _provenance.*\n"
            + "FROM _provenance LEFT JOIN _result ON TRUE"
        )
        return CompiledQuery(
            sql=sql,
            params=main.params,
            columns=[*main.columns, *provenance.columns],
            funnel_columns=provenance.funnel_columns,
            result_columns=main.columns,
            provenance_columns=provenance.columns,
        )

    def compile_matched_ids(self, limit: int | None = None, offset: int = 0) -> CompiledQuery:
        """Compile matching match IDs for drill-down (§24)."""
        if (limit is not None and limit < 1) or offset < 0:
            raise ValueError("limit은 1 이상, offset은 0 이상이어야 합니다.")
        query = self.compile()
        base_sql = query.sql.split("\nSELECT ", 1)[0]
        key_columns = ["match_id"]
        if self.plan.grain in ("team", "player", "event"):
            key_columns.append("team_id")
        if self.plan.grain in ("player", "event"):
            key_columns.append("participant_id")
        if self.plan.grain == "event":
            key_columns.append("event_id")
        keys = ", ".join(key_columns)
        truth_columns = [
            f"bool_or(coalesce({atom.id}, FALSE)) AS truth_{atom.id}" for atom in self.plan.atoms
        ]
        if self.plan.chain and self.plan.chain.target is not None:
            truth_columns.append("bool_or(coalesce(chain_hit, FALSE)) AS chain_hit")
        if self.plan.compare_arms:
            condition = " OR ".join(
                f"({self._bool_sql(arm.condition)})" for arm in self.plan.compare_arms
            )
            source = f"flagged WHERE {condition}"
            arm_columns = [
                f"bool_or(coalesce({self._bool_sql(arm.condition)}, FALSE)) AS arm_{arm.id}"
                for arm in self.plan.compare_arms
            ]
            truth_columns.extend(arm_columns)
        else:
            source = "matched"
        page = f" LIMIT {limit}" if limit is not None else ""
        page += f" OFFSET {offset}" if offset else ""
        if truth_columns:
            selected = ", ".join([keys, *truth_columns])
            sql = (
                f"{base_sql}\nSELECT {selected} FROM {source} GROUP BY {keys} ORDER BY {keys}{page}"
            )
        else:
            sql = f"{base_sql}\nSELECT DISTINCT {keys} FROM {source} ORDER BY {keys}{page}"
        columns = [*key_columns]
        columns.extend(f"truth_{atom.id}" for atom in self.plan.atoms)
        if self.plan.chain and self.plan.chain.target is not None:
            columns.append("chain_hit")
        columns.extend(f"arm_{arm.id}" for arm in self.plan.compare_arms)
        return CompiledQuery(sql=sql, params=self._params_used_by(sql), columns=columns)

    def compile_matched_points(self, limit: int = 5_000) -> CompiledQuery | None:
        """Compile event coordinates matching spatial conditions for a bounded UI sample."""
        atom = next(
            (item for item in self.plan.atoms if item.kind == AtomKind.SPATIAL_REGION), None
        )
        if atom is None:
            return None
        binding = self._binding_ref(atom.params["binding"])
        region = next(r for r in self.plan.regions if r.id == atom.params["region"])
        main = self.compile()
        prefix = main.sql.rsplit("\nSELECT ", 1)[0]
        if self.plan.compare_arms:
            condition = " OR ".join(
                f"({self._bool_sql(arm.condition)})" for arm in self.plan.compare_arms
            )
            source = f"(SELECT * FROM flagged WHERE {condition}) matched"
        else:
            source = "matched"
        clauses = ["ev.match_id = matched.match_id", self._qualified_event_where(binding, "ev")]
        if self.plan.grain in ("team", "player"):
            clauses.append("ev.team_id = matched.team_id")
        if self.plan.grain == "player":
            clauses.append("ev.participant_id = matched.participant_id")
        if binding.team_side:
            clauses.append(f"ev.team_id = {self.param(TEAM_ID[binding.team_side])}")
        clauses.append(self._region_predicate(binding, region.payload, alias="ev"))
        sql = (
            prefix
            + "\nSELECT ev.match_id, ev.event_id, ev.timestamp_ms, ev.x_norm, ev.y_norm "
            + f"FROM {source} JOIN {safe_identifier(binding.table)} ev "
            + "ON ev.match_id = matched.match_id "
            + "WHERE "
            + " AND ".join(f"({clause})" for clause in clauses)
            + f" ORDER BY ev.match_id, ev.timestamp_ms LIMIT {int(limit)}"
        )
        return CompiledQuery(
            sql=sql,
            params=self._params_used_by(sql),
            columns=["match_id", "event_id", "timestamp_ms", "x_norm", "y_norm"],
        )


def _conjunction_atoms(node: BoolNode) -> list[str]:
    """Return top-level AND atom IDs in cumulative-funnel order."""
    if node.op == "atom" and node.atom:
        return [node.atom]
    if node.op == "and":
        out: list[str] = []
        for child in node.children:
            found = _conjunction_atoms(child)
            if not found:
                return []
            out.extend(found)
        return out
    return []
