"""Validation for generated datasets.

Metrics are remeasured directly from Parquet rather than simulation arrays, catching errors during
row materialization. Definitions must match `engine.measure` so calibration and validation agree.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb

from ..regions import preset_regions
from .params import VALIDATION_TARGETS


@dataclass(slots=True)
class ValidationResult:
    metrics: dict[str, float]
    target_failures: list[str]
    integrity_failures: list[str]
    notes: list[str]

    @property
    def ok(self) -> bool:
        return not self.target_failures and not self.integrity_failures


def _views(con: duckdb.DuckDBPyConnection, root: Path) -> None:
    for table in (
        "matches",
        "participants",
        "teams",
        "events",
        "timeline_team_frames",
        "timeline_participant_frames",
        "match_summary",
    ):
        path = root / table
        if not path.exists():
            continue
        # Relation APIs keep a caller-controlled filesystem path out of SQL text. Table names are
        # selected exclusively from the fixed tuple above.
        con.from_parquet(
            str(path / "**/*.parquet"), hive_partitioning=True, union_by_name=True
        ).create_view(table, replace=True)


def _scalar(
    con: duckdb.DuckDBPyConnection, sql: str, params: dict[str, Any] | None = None
) -> float:
    row = con.execute(sql, params or {}).fetchone()
    return float("nan") if row is None or row[0] is None else float(row[0])


def measure_dataset(root: Path) -> dict[str, float]:
    con = duckdb.connect()
    _views(con, root)

    m: dict[str, float] = {}
    m["n_matches"] = _scalar(con, "SELECT count(*) FROM matches")
    m["blue_win_rate"] = _scalar(
        con, "SELECT avg(CASE WHEN winning_team = 100 THEN 1.0 ELSE 0.0 END) FROM matches"
    )
    m["first_blood_rate"] = _scalar(
        con,
        "SELECT avg(CASE WHEN got_first_blood THEN 1.0 ELSE 0.0 END) * 2 FROM match_summary",
    )
    # Win rate of team-matches that recorded first blood.
    m["win_rate_given_first_blood"] = _scalar(
        con,
        "SELECT avg(CASE WHEN win THEN 1.0 ELSE 0.0 END) FROM match_summary WHERE got_first_blood",
    )
    for lane, key in (("top_lane", "top"), ("mid_lane", "mid"), ("bot_lane", "bot")):
        m[f"win_rate_given_fb_{key}"] = _scalar(
            con,
            "SELECT avg(CASE WHEN win THEN 1.0 ELSE 0.0 END) FROM match_summary "
            "WHERE got_first_blood AND first_blood_region = $lane",
            {"lane": lane},
        )
    for threshold in (1500, 3000):
        m[f"win_rate_given_gold_lead_{threshold}_at_10m"] = _scalar(
            con,
            "SELECT avg(CASE WHEN win THEN 1.0 ELSE 0.0 END) FROM match_summary "
            "WHERE gold_diff_at_10m >= $threshold",
            {"threshold": threshold},
        )
    m["median_duration_min"] = _scalar(con, "SELECT median(duration_s) / 60.0 FROM matches")
    m["mean_fb_to_first_tower_s"] = _scalar(
        con,
        "SELECT avg(fb_to_first_tower_ms) / 1000.0 FROM match_summary "
        "WHERE fb_to_first_tower_ms IS NOT NULL AND fb_to_first_tower_ms > 0",
    )
    m["median_fb_to_first_tower_s"] = _scalar(
        con,
        "SELECT median(fb_to_first_tower_ms) / 1000.0 FROM match_summary "
        "WHERE fb_to_first_tower_ms IS NOT NULL AND fb_to_first_tower_ms > 0",
    )
    # DoD F: rate at which the same team takes dragon within 90 seconds after a kill.
    m["dragon_within_90s_after_kill"] = _scalar(
        con,
        """
        WITH trig AS (
          SELECT match_id, event_id, timestamp_ms AS t0, team_id
          FROM events WHERE event_type = 'kill'
        ),
        tgt AS (
          SELECT match_id, timestamp_ms AS t1, team_id
          FROM events WHERE event_type = 'dragon_kill'
        ),
        chain AS (
          SELECT t.match_id, t.event_id, t.t0, min(g.t1) AS t1
          FROM trig t LEFT JOIN tgt g
            ON g.match_id = t.match_id AND g.team_id = t.team_id
           AND g.t1 >= t.t0 AND g.t1 <= t.t0 + 90000
          GROUP BY 1, 2, 3
        )
        SELECT avg(CASE WHEN t1 IS NOT NULL THEN 1.0 ELSE 0.0 END) FROM chain
        """,
    )
    m["std_gold_diff_at_10m"] = _scalar(
        con, "SELECT stddev(gold_diff_at_10m) FROM match_summary WHERE side = 'BLUE'"
    )
    m["events_per_match"] = _scalar(
        con, "SELECT count(*)::DOUBLE / (SELECT count(*) FROM matches) FROM events"
    )
    con.close()
    return m


def check_integrity(root: Path) -> list[str]:
    """Validate structural integrity independently of target metrics."""
    con = duckdb.connect()
    _views(con, root)
    failures: list[str] = []

    def fail_if(sql: str, message: str) -> None:
        n = _scalar(con, sql)
        if n and n > 0:
            failures.append(f"{message}: {int(n)} cases")

    fail_if(
        "SELECT count(*) FROM (SELECT match_id FROM participants "
        "GROUP BY match_id HAVING count(*) <> 10)",
        "Matches that do not have exactly 10 participants",
    )
    fail_if(
        "SELECT count(*) FROM (SELECT match_id, team_id FROM participants "
        "GROUP BY match_id, team_id HAVING count(*) <> 5)",
        "Teams that do not have exactly 5 participants",
    )
    fail_if(
        "SELECT count(*) FROM (SELECT match_id, team_id, role FROM participants "
        "GROUP BY match_id, team_id, role HAVING count(*) <> 1)",
        "Duplicate roles within a team",
    )
    fail_if(
        "SELECT count(*) FROM (SELECT match_id, champion_id FROM participants "
        "GROUP BY match_id, champion_id HAVING count(*) > 1)",
        "Duplicate champions within a match",
    )
    fail_if(
        "SELECT count(*) FROM events e JOIN matches m USING (match_id) "
        "WHERE e.timestamp_ms > m.duration_ms",
        "Events beyond the match duration",
    )
    fail_if(
        "SELECT count(*) FROM events WHERE event_type = 'kill' AND participant_id = victim_id",
        "Kills where the killer is also the victim",
    )
    fail_if(
        "SELECT count(*) FROM events WHERE event_type = 'kill' "
        "AND list_contains(assist_ids, participant_id)",
        "Kills whose assist list includes the killer",
    )
    fail_if(
        "SELECT count(*) FROM events WHERE event_type = 'kill' "
        "AND list_contains(assist_ids, victim_id)",
        "Kills whose assist list includes the victim",
    )
    fail_if(
        "SELECT count(*) FROM events WHERE has_position "
        "AND (x_norm < -0.001 OR x_norm > 1.001 OR y_norm < -0.001 OR y_norm > 1.001)",
        "Coordinates outside the map bounds",
    )
    fail_if(
        "SELECT count(*) FROM (SELECT match_id FROM events WHERE event_type = 'kill' "
        "AND is_first_of_type GROUP BY match_id HAVING count(*) > 1)",
        "Matches with more than one first blood",
    )
    fail_if(
        "SELECT count(*) FROM (SELECT match_id, "
        "count(*) FILTER (WHERE event_type='kill') AS kills, "
        "count(*) FILTER (WHERE event_type='kill' AND is_first_of_type) AS firsts "
        "FROM events GROUP BY match_id) WHERE kills > 0 AND firsts <> 1",
        "Matches with kills but not exactly one first blood",
    )
    fail_if(
        "SELECT count(*) FROM participants WHERE role IS NULL OR "
        "role NOT IN ('TOP','JUNGLE','MID','BOT','SUPPORT')",
        "Participants with a noncanonical role",
    )
    fail_if(
        "SELECT count(*) FROM match_summary WHERE fb_to_first_tower_ms < 0",
        "Negative first-blood-to-first-tower durations",
    )
    fail_if(
        "SELECT count(*) FROM (SELECT match_id, sum(first_baron::INT) AS n "
        "FROM teams GROUP BY match_id) WHERE n > 1",
        "Matches with more than one first-baron team",
    )
    fail_if(
        "SELECT count(*) FROM timeline_team_frames WHERE timestamp_ms = 0 "
        "AND (alive_towers <> 11 OR dragons_taken <> 0 OR barons_taken <> 0 OR kill_diff <> 0)",
        "Initial team frames containing future state",
    )
    fail_if(
        "SELECT count(*) FROM (SELECT alive_towers, dragons_taken, barons_taken, "
        "lag(alive_towers) OVER w AS prev_towers, "
        "lag(dragons_taken) OVER w AS prev_dragons, "
        "lag(barons_taken) OVER w AS prev_barons FROM timeline_team_frames "
        "WINDOW w AS (PARTITION BY match_id, team_id ORDER BY frame_idx)) "
        "WHERE alive_towers > prev_towers OR dragons_taken < prev_dragons "
        "OR barons_taken < prev_barons",
        "Nonmonotonic cumulative team-frame state",
    )
    fail_if(
        """
        SELECT count(*) FROM (
          WITH final_frames AS (
            SELECT * FROM timeline_team_frames
            QUALIFY row_number() OVER (
              PARTITION BY match_id, team_id ORDER BY timestamp_ms DESC
            ) = 1
          ), event_totals AS (
            SELECT match_id, team_id,
                   count(*) FILTER (WHERE event_type='kill') AS kills,
                   count(*) FILTER (WHERE event_type='dragon_kill') AS dragons,
                   count(*) FILTER (WHERE event_type='baron_kill') AS barons
            FROM events WHERE team_id IN (100, 200) GROUP BY 1, 2
          ), paired AS (
            SELECT f.*,
                   coalesce(o.kills, 0) - coalesce(e.kills, 0) AS expected_kill_diff,
                   coalesce(o.dragons, 0) AS expected_dragons,
                   coalesce(o.barons, 0) AS expected_barons
            FROM final_frames f
            LEFT JOIN event_totals o USING (match_id, team_id)
            LEFT JOIN event_totals e
              ON e.match_id=f.match_id AND e.team_id=CASE f.team_id WHEN 100 THEN 200 ELSE 100 END
          )
          SELECT * FROM paired WHERE kill_diff <> expected_kill_diff
             OR dragons_taken <> expected_dragons OR barons_taken <> expected_barons
        )
        """,
        "Final team-frame state does not match materialized events",
    )
    fail_if(
        "SELECT count(*) FROM participants p JOIN matches m USING (match_id) "
        "WHERE p.win <> (p.team_id = m.winning_team)",
        "participants.win does not match matches.winning_team",
    )
    fail_if(
        "SELECT count(*) FROM match_summary s JOIN matches m USING (match_id) "
        "WHERE s.win <> (s.team_id = m.winning_team)",
        "match_summary.win does not match matches.winning_team",
    )
    # Turret tier order: inner cannot be destroyed before outer.
    fail_if(
        """
        SELECT count(*) FROM (
          SELECT match_id, team_id, lane_type,
                 min(CASE WHEN tower_type='OUTER_TURRET' THEN timestamp_ms END) AS outer_ms,
                 min(CASE WHEN tower_type='INNER_TURRET' THEN timestamp_ms END) AS inner_ms
          FROM events WHERE event_type='turret_destroy'
          GROUP BY 1,2,3
        ) WHERE inner_ms IS NOT NULL AND (outer_ms IS NULL OR inner_ms < outer_ms)
        """,
        "Turret tier order violations",
    )
    # Verify match_summary against values recomputed from events.
    fail_if(
        """
        SELECT count(*) FROM (
          SELECT s.match_id, s.team_id, s.got_first_blood,
                 (e.team_id IS NOT NULL) AS derived
          FROM match_summary s
          LEFT JOIN (SELECT match_id, team_id FROM events
                     WHERE event_type='kill' AND is_first_of_type) e
            ON e.match_id = s.match_id AND e.team_id = s.team_id
        ) WHERE got_first_blood <> derived
        """,
        "match_summary.got_first_blood does not match values derived from events",
    )
    con.close()
    return failures


def validate(root: Path) -> ValidationResult:
    metrics = measure_dataset(root)
    failures: list[str] = []
    for metric, (target, tol) in VALIDATION_TARGETS.items():
        value = metrics.get(metric)
        if value is None or value != value:  # NaN
            failures.append(f"{metric}: unavailable")
        elif abs(value - target) > tol:
            failures.append(f"{metric}: {value:.4f} (target {target:.4f} ± {tol:.3f})")

    notes: list[str] = []
    std = metrics.get("std_gold_diff_at_10m")
    if std and std > 2400:
        notes.append(
            f"The 10-minute gold-difference standard deviation is {std:,.0f}, wider than "
            "the real-world value (~1800). Distribution width was traded off to meet the "
            "conditional win-rate target (DoD D); recalibrate if distribution shape matters "
            "more than the expected analysis result."
        )
    n_regions = len(preset_regions())
    notes.append(f"First-blood locations were pre-tagged with {n_regions} preset regions.")

    return ValidationResult(
        metrics=metrics,
        target_failures=failures,
        integrity_failures=check_integrity(root),
        notes=notes,
    )


def format_result(result: ValidationResult) -> str:
    lines = ["Metrics:"]
    for k, v in result.metrics.items():
        lines.append(f"  {k:42s} {v:,.4f}")
    if result.target_failures:
        lines.append("\nTargets outside tolerance:")
        lines.extend(f"  ✗ {f}" for f in result.target_failures)
    if result.integrity_failures:
        lines.append("\nIntegrity violations:")
        lines.extend(f"  ✗ {f}" for f in result.integrity_failures)
    if result.notes:
        lines.append("\nNotes:")
        lines.extend(f"  · {n}" for n in result.notes)
    lines.append("\n" + ("PASS" if result.ok else "FAIL"))
    return "\n".join(lines)


def as_dict(result: ValidationResult) -> dict[str, Any]:
    return {
        "ok": result.ok,
        "metrics": result.metrics,
        "target_failures": result.target_failures,
        "integrity_failures": result.integrity_failures,
        "notes": result.notes,
    }
