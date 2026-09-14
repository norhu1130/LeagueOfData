"""DuckDB execution engine with native connection interruption."""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from lod_data.regions import point_in_shape

from lod_api.catalog import Catalog, load_effective_catalog
from lod_api.compile.plan import PhysicalPlan
from lod_api.compile.sql import TEAM_ID, CompiledQuery, SqlCompiler, safe_identifier
from lod_api.config import settings
from lod_api.db import cursor, has_spatial

from .interface import EngineCapabilities, ResultSet, ResultStats


class QueryCancelled(Exception):
    """Normal control flow for an explicitly cancelled query."""


class AmbiguousMatchedUnit(Exception):
    """A match contains multiple included analysis units and needs a unit selector."""


class DuckDBEngine:
    name = "duckdb"
    cache_version = f"duckdb-{duckdb.__version__}"

    def __init__(self, catalog: Catalog | None = None) -> None:
        self._catalog_override = catalog
        #: Run ID to active cursor, used for native interruption.
        self._running: dict[str, duckdb.DuckDBPyConnection] = {}
        self._lock = threading.Lock()
        self._materialize_lock = threading.Lock()

    def capabilities(self) -> EngineCapabilities:
        return EngineCapabilities(
            spatial_polygon=has_spatial(),
            temporal_window_join=True,
            list_unnest=True,
            streaming_progress=False,
            interrupt=True,
            max_parallelism=os.cpu_count() or 4,
        )

    def _compiler(self, plan: PhysicalPlan) -> SqlCompiler:
        return SqlCompiler(plan, self._catalog(), has_spatial=has_spatial())

    def _catalog(self) -> Catalog:
        return self._catalog_override or load_effective_catalog()

    def explain(self, plan: PhysicalPlan) -> str:
        return self._compiler(plan).compile().sql

    def cancel(self, run_id: str) -> bool:
        with self._lock:
            con = self._running.get(run_id)
        if con is None:
            return False
        con.interrupt()
        return True

    def _run(self, con: duckdb.DuckDBPyConnection, query: CompiledQuery) -> pa.Table:
        result = con.execute(query.sql, query.params).arrow()
        # DuckDB versions may return a RecordBatchReader instead of a Table.
        if isinstance(result, pa.RecordBatchReader):
            return result.read_all()
        return result

    def execute(self, plan: PhysicalPlan, *, run_id: str) -> ResultSet:
        compiler = self._compiler(plan)
        combined = compiler.compile_combined()
        point_query = self._compiler(plan).compile_matched_points()
        matched_query = (
            self._compiler(plan).compile_matched_ids() if self._valid_run_id(run_id) else None
        )

        con = cursor()
        with self._lock:
            self._running[run_id] = con

        started = time.perf_counter()
        try:
            combined_table = self._run(con, combined)
            point_table = self._run(con, point_query) if point_query else None
            matched_table = self._run(con, matched_query) if matched_query else None
        except duckdb.InterruptException as exc:
            raise QueryCancelled(run_id) from exc
        finally:
            with self._lock:
                self._running.pop(run_id, None)
            con.close()

        elapsed = (time.perf_counter() - started) * 1000
        matched_ref = None
        if matched_table is not None:
            path = self._write_matched_table(run_id, matched_table)
            matched_ref = str(path)
        table = combined_table.select(combined.result_columns)
        if (
            plan.group_keys
            and table.num_rows == 1
            and all(table.column(name).null_count == 1 for name in combined.result_columns)
        ):
            table = table.slice(0, 0)
        prov_table = combined_table.select(combined.provenance_columns).slice(0, 1)
        stats = self._build_stats(plan, prov_table, combined, elapsed)

        return ResultSet(
            result_type=plan.result_shape,
            data=table,
            stats=stats,
            matched_ref=matched_ref,
            map_points=point_table.to_pylist() if point_table is not None else [],
            sql=combined.sql,
            engine=f"{self.name}-{duckdb.__version__}",
        )

    @staticmethod
    def _valid_run_id(run_id: str) -> bool:
        return len(run_id) == 32 and all(c in "0123456789abcdef" for c in run_id)

    def _matched_path(self, run_id: str) -> Path:
        if not self._valid_run_id(run_id):
            raise ValueError("Invalid run identifier.")
        return settings.runs_dir / run_id / "matched.parquet"

    def _write_matched_table(self, run_id: str, table: pa.Table) -> Path:
        path = self._matched_path(run_id)
        os.makedirs(path.parent, exist_ok=True)
        temporary = path.with_suffix(".parquet.tmp")
        pq.write_table(table, temporary, compression="zstd")
        os.replace(temporary, path)
        return path

    def materialize_matched(self, plan: PhysicalPlan, *, run_id: str) -> os.PathLike[str]:
        """Materialize one drill-down Parquet set per run."""
        path = self._matched_path(run_id)
        if os.path.exists(path):
            return path
        with self._materialize_lock:
            if os.path.exists(path):
                return path
            query = self._compiler(plan).compile_matched_ids()
            con = cursor()
            try:
                table = self._run(con, query)
            finally:
                con.close()
            return self._write_matched_table(run_id, table)

    def matched_matches(
        self, plan: PhysicalPlan, *, run_id: str, limit: int = 500, offset: int = 0
    ) -> pa.Table:
        """Return matching games, reading only the materialized set after the first call."""
        path = self.materialize_matched(plan, run_id=run_id)
        con = cursor()
        try:
            order_columns = ["match_id"]
            if plan.grain in ("team", "player", "event"):
                order_columns.append("team_id")
            if plan.grain in ("player", "event"):
                order_columns.append("participant_id")
            if plan.grain == "event":
                order_columns.append("event_id")
            result = con.execute(
                "SELECT * FROM read_parquet($path) ORDER BY "
                + ", ".join(order_columns)
                + " LIMIT $limit OFFSET $offset",
                {"path": str(path), "limit": limit, "offset": offset},
            ).arrow()
            return result.read_all() if isinstance(result, pa.RecordBatchReader) else result
        finally:
            con.close()

    def match_detail(
        self,
        plan: PhysicalPlan,
        *,
        run_id: str,
        match_id: str,
        team_id: int | None = None,
        participant_id: int | None = None,
        event_id: int | None = None,
    ) -> dict[str, Any] | None:
        """Load summary, participants, events, and frames for one included match."""
        path = self.materialize_matched(plan, run_id=run_id)
        con = cursor()
        try:
            unit_filters = ["match_id = $match_id"]
            unit_params: dict[str, Any] = {"path": str(path), "match_id": match_id}
            for column, value in (
                ("team_id", team_id),
                ("participant_id", participant_id),
                ("event_id", event_id),
            ):
                if value is not None:
                    unit_filters.append(f"{column} = ${column}")
                    unit_params[column] = value
            included_result = con.execute(
                "SELECT * FROM read_parquet($path) WHERE "
                + " AND ".join(unit_filters)
                + " LIMIT 2",
                unit_params,
            )
            included_rows = included_result.fetchall()
            if not included_rows:
                return None
            if len(included_rows) > 1:
                raise AmbiguousMatchedUnit(match_id)
            included = {
                description[0]: value
                for description, value in zip(
                    included_result.description, included_rows[0], strict=True
                )
            }

            def rows(sql: str) -> list[dict[str, Any]]:
                arrow = con.execute(sql, {"match_id": match_id}).arrow()
                table = arrow.read_all() if isinstance(arrow, pa.RecordBatchReader) else arrow
                return table.to_pylist()

            match_rows = rows("SELECT * FROM matches WHERE match_id = $match_id")
            event_rows = rows(
                "SELECT event_id, timestamp_ms, event_type, event_subtype, team_id, "
                "participant_id, victim_id, x_raw, y_raw, x_norm, y_norm "
                "FROM events WHERE match_id = $match_id ORDER BY timestamp_ms, event_id"
            )
            event_type_by_id = {row["event_id"]: row["event_type"] for row in event_rows}
            witness_by_binding: dict[str, list[dict[str, Any]]] = {}
            for binding in plan.bindings:
                clauses = ["match_id = $match_id", binding.where]
                if binding.team_side or (
                    not binding.any_team and included.get("team_id") is not None
                ):
                    clauses.append("team_id = $team_id")
                query_params: dict[str, Any] = {"match_id": match_id}
                if binding.team_side:
                    query_params["team_id"] = TEAM_ID[binding.team_side]
                elif not binding.any_team and included.get("team_id") is not None:
                    query_params["team_id"] = included["team_id"]
                if binding.participant_selector is not None:
                    clauses.append(
                        "EXISTS (SELECT 1 FROM participants scoped_player "
                        "WHERE scoped_player.match_id = events.match_id "
                        "AND scoped_player.participant_id = events.participant_id "
                        "AND (scoped_player.riot_id = $participant_selector "
                        "OR scoped_player.summoner_name = $participant_selector))"
                    )
                    query_params["participant_selector"] = binding.participant_selector
                elif binding.participant_scoped and included.get("participant_id") is not None:
                    clauses.append("participant_id = $participant_id")
                    query_params["participant_id"] = included["participant_id"]
                arrow = con.execute(
                    "SELECT event_id, timestamp_ms, team_id, x_raw, y_raw, "
                    "x_norm, y_norm FROM "
                    + safe_identifier(binding.table)
                    + " events"
                    + " WHERE "
                    + " AND ".join(f"({clause})" for clause in clauses)
                    + " ORDER BY timestamp_ms, event_id LIMIT 200",
                    query_params,
                ).arrow()
                table = arrow.read_all() if isinstance(arrow, pa.RecordBatchReader) else arrow
                candidates = table.to_pylist()
                for candidate in candidates:
                    candidate["event_type"] = event_type_by_id.get(candidate["event_id"])
                if binding.ordinal == "first":
                    candidates = candidates[:1]
                elif binding.ordinal == "last":
                    candidates = candidates[-1:]
                elif isinstance(binding.ordinal, int):
                    candidates = candidates[binding.ordinal - 1 : binding.ordinal]
                witness_by_binding[binding.id] = candidates

            condition_reasons = []
            for atom in plan.atoms:
                if included.get(f"truth_{atom.id}") is not True:
                    continue
                binding_ids = [
                    value
                    for key, value in atom.params.items()
                    if key in {"binding", "start", "end"} and isinstance(value, str)
                ]
                witnesses = [
                    witness
                    for binding_id in binding_ids
                    for witness in witness_by_binding.get(binding_id, [])
                ]
                if atom.kind.value == "spatial_region":
                    region = next(r for r in plan.regions if r.id == atom.params["region"])
                    witnesses = [
                        witness
                        for witness in witnesses
                        if witness.get("x_norm") is not None
                        and witness.get("y_norm") is not None
                        and point_in_shape(
                            float(witness["x_norm"]),
                            float(witness["y_norm"]),
                            region.payload,
                        )
                    ]
                elif atom.kind.value == "spatial_radius":
                    tx, ty, radius = (
                        float(atom.params["target_x"]),
                        float(atom.params["target_y"]),
                        float(atom.params["radius"]),
                    )
                    witnesses = [
                        witness
                        for witness in witnesses
                        if witness.get("x_raw") is not None
                        and witness.get("y_raw") is not None
                        and (float(witness["x_raw"]) - tx) ** 2
                        + (float(witness["y_raw"]) - ty) ** 2
                        <= radius**2
                    ]
                elif atom.kind.value != "event_exists":
                    # The persisted truth value is authoritative. Do not attach candidate events
                    # as evidence for predicates whose exact witness was not materialized.
                    witnesses = []
                condition_reasons.append(
                    {
                        "id": atom.id,
                        "dsl": atom.dsl,
                        "labelKo": atom.label_ko,
                        "matched": True,
                        "witnesses": [
                            {
                                "event_id": witness["event_id"],
                                "timestamp_ms": witness["timestamp_ms"],
                                "event_type": witness.get("event_type"),
                            }
                            for witness in witnesses[:20]
                        ],
                    }
                )
            arms = [
                {"id": arm.id, "labelKo": arm.label_ko}
                for arm in plan.compare_arms
                if included.get(f"arm_{arm.id}") is True
            ]
            chain_matched = included.get("chain_hit") if plan.chain else None
            if plan.compare_arms:
                summary_ko = "이 경기는 표시된 비교 집단에 포함되었습니다."
            elif plan.chain and chain_matched is True:
                summary_ko = "이 경기에서 제한 시간 안의 이어지는 사건을 확인했습니다."
            elif plan.chain:
                summary_ko = "이 경기에는 시작 사건이 있지만 이어지는 사건은 확인되지 않았습니다."
            else:
                summary_ko = "이 경기는 표시된 분석 조건을 만족했습니다."
            return {
                "match": match_rows[0] if match_rows else None,
                "participants": rows(
                    "SELECT participant_id, team_id, side, champion_id, champion, role, win, "
                    "kills, deaths, assists, gold_earned, gold_spent, "
                    "total_damage_dealt_to_champions, total_damage_taken, vision_score, "
                    "wards_placed, wards_killed, champ_level, total_minions_killed, "
                    "neutral_minions_killed, items, first_blood_kill, first_blood_assist, "
                    "first_tower_kill FROM participants WHERE match_id = $match_id "
                    "ORDER BY participant_id"
                ),
                "events": event_rows,
                "teamFrames": rows(
                    "SELECT timestamp_ms, team_id, total_gold, gold_diff, kill_diff, "
                    "dragons_taken, barons_taken FROM timeline_team_frames "
                    "WHERE match_id = $match_id ORDER BY timestamp_ms, team_id"
                ),
                "matchReason": {
                    "summaryKo": summary_ko,
                    "conditions": condition_reasons,
                    "arms": arms,
                    "chainMatched": chain_matched,
                    "unit": {
                        key: included[key]
                        for key in ("match_id", "team_id", "participant_id", "event_id")
                        if key in included
                    },
                },
            }
        finally:
            con.close()

    def _build_stats(
        self,
        plan: PhysicalPlan,
        table: pa.Table,
        query: CompiledQuery,
        elapsed_ms: float,
    ) -> ResultStats:
        row: dict[str, Any] = {}
        if table.num_rows:
            values = table.to_pylist()[0]
            row = {k: v for k, v in values.items()}

        conditions: list[dict[str, Any]] = []
        cumulative_available = any(c.startswith("cum_") for c in query.funnel_columns)
        for index, atom in enumerate(plan.atoms):
            entry: dict[str, Any] = {
                "id": atom.id,
                "labelKo": atom.label_ko,
                "dsl": atom.dsl,
                "matchedAlone": int(row.get(f"alone_{atom.id}") or 0),
            }
            if cumulative_available and f"cum_{index}" in row:
                entry["matchedCumulative"] = int(row.get(f"cum_{index}") or 0)
            conditions.append(entry)

        if plan.chain and plan.chain.target is not None:
            target_label = self._catalog().event(plan.chain.target.event_id).label_ko
            window = (
                f"{int(plan.chain.window_seconds)}초 안에 "
                if plan.chain.window_seconds is not None
                else "그 뒤에 "
            )
            chain_entry: dict[str, Any] = {
                "id": "chain",
                "labelKo": f"{window}{target_label} 발생",
                "dsl": "이어지는 사건 조건",
                "matchedAlone": int(row.get("alone_chain") or 0),
            }
            if plan.chain_as_filter:
                chain_entry["matchedCumulative"] = int(row.get("cum_chain") or 0)
            conditions.append(chain_entry)

        excluded: list[dict[str, Any]] = []
        for probe in plan.probes:
            missing = int(row.get(f"missing_{probe.id}") or 0)
            if missing:
                minutes = int(probe.at_seconds // 60)
                excluded.append(
                    {
                        "reasonKo": f"{minutes}분보다 짧게 끝난 경기",
                        "count": missing,
                    }
                )

        measure_coverage: list[dict[str, Any]] = []
        baseline_values: dict[str, float | None] = {}
        matched_units = int(row.get("matched_units") or 0)
        for measure in plan.measures:
            baseline_key = f"baseline_{measure.id}"
            if baseline_key in row:
                value = row.get(baseline_key)
                baseline_values[measure.id] = float(value) if value is not None else None
            key = f"defined_{measure.id}"
            if key not in row:
                continue
            defined = int(row.get(key) or 0)
            measure_coverage.append(
                {
                    "measureId": measure.id,
                    "labelKo": measure.label_ko,
                    "defined": defined,
                    "eligible": matched_units,
                    "ratio": defined / matched_units if matched_units else 0.0,
                }
            )

        return ResultStats(
            total_units=int(row.get("total_units") or 0),
            total_matches=int(row.get("total_matches") or 0),
            matched_units=matched_units,
            matched_matches=int(row.get("matched_matches") or 0),
            conditions=conditions,
            excluded=excluded,
            measure_coverage=measure_coverage,
            baseline_values=baseline_values,
            elapsed_ms=elapsed_ms,
        )
