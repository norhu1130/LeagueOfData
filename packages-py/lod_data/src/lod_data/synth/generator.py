"""Materialize synthetic stochastic processes into seven Parquet tables.

Simulation output is expanded into rows shaped like Riot Match-V5 timelines. Both ingestion paths
share `lod_data.schema`. Per-match random streams preserve deterministic parallel generation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pyarrow as pa

from ..champions import CHAMPIONS_BY_ROLE
from ..coords import MAP_MIN, MAP_SPAN, from_norm
from ..enums import (
    ROLE_LANE,
    ROLES,
    SCHEMA_VERSION,
    TEAM_ID_BLUE,
    TEAM_ID_RED,
    DataSource,
    EventOrigin,
    EventType,
    MonsterType,
    Role,
    first_event_scope,
    side_of,
)
from ..regions import point_in_region, preset_regions
from ..schema import FRAME_INTERVAL_MS, TABLES
from . import spatial
from .engine import FB_LANES, MatchPaths, simulate
from .params import SynthParams

#: Fixed synthetic ingestion time; never use wall-clock time here.
#:
#: Snapshot IDs hash file content and participate in cache keys. Wall-clock values would break
#: seed reproducibility. Real Riot ingestion uses an actual ingestion timestamp.
SYNTHETIC_INGESTED_AT = datetime(2026, 1, 1, 0, 0, 0)


#: Region-tagging priority. Regions overlap, so narrow pits are tested before broad lanes.
_REGION_PRIORITY = (
    "dragon_pit",
    "baron_pit",
    "blue_base",
    "red_base",
    "top_lane",
    "bot_lane",
    "mid_lane",
    "river",
    "blue_jungle",
    "red_jungle",
)


def from_norm_arrays(x_norm: np.ndarray, y_norm: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Vectorized conversion from normalized arrays to raw coordinate arrays."""
    return (
        np.rint(x_norm * MAP_SPAN + MAP_MIN).astype(np.int64),
        np.rint(y_norm * MAP_SPAN + MAP_MIN).astype(np.int64),
    )


@dataclass(slots=True)
class GeneratedDataset:
    tables: dict[str, pa.Table]
    n_matches: int

    def row_counts(self) -> dict[str, int]:
        return {k: v.num_rows for k, v in self.tables.items()}


class _Columns:
    """Collect column lists and build one Arrow table at the end.

    Record only supplied fields and fill missing values with nulls at materialization time.
    Scanning every sparse event field per row would dominate generation time.
    """

    __slots__ = ("name", "schema", "data", "_n")

    def __init__(self, name: str) -> None:
        self.name = name
        self.schema = TABLES[name]
        self.data: dict[str, list] = {f: [] for f in self.schema.names}
        self._n = 0

    def add(self, **row) -> None:
        n = self._n
        for key, value in row.items():
            col = self.data[key]
            gap = n - len(col)
            if gap:
                col.extend([None] * gap)
            col.append(value)
        self._n = n + 1

    def build(self) -> pa.Table:
        for col in self.data.values():
            gap = self._n - len(col)
            if gap:
                col.extend([None] * gap)
        return self._build()

    def _build(self) -> pa.Table:
        return pa.table(
            {
                name: pa.array(values, type=self.schema.field(name).type)
                for name, values in self.data.items()
            },
            schema=self.schema,
        )


def _tag_region(x: float, y: float, regions: dict) -> str | None:
    for rid in _REGION_PRIORITY:
        region = regions.get(rid)
        if region is not None and point_in_region(x, y, region):
            return rid
    return None


def _assign_champions(rng: np.random.Generator) -> list[tuple[Role, int, str]]:
    """Assign roles and unique champions to ten participants across both teams."""
    used: set[int] = set()
    out: list[tuple[Role, int, str]] = []
    for _team in (TEAM_ID_BLUE, TEAM_ID_RED):
        for role in ROLES:
            pool = [c for c in CHAMPIONS_BY_ROLE[role] if c.id not in used]
            pick = pool[int(rng.integers(0, len(pool)))]
            used.add(pick.id)
            out.append((role, pick.id, pick.name))
    return out


def _generate_one(
    index: int,
    paths: MatchPaths,
    i: int,
    p: SynthParams,
    rng: np.random.Generator,
    cols: dict[str, _Columns],
    regions: dict,
    *,
    patch: str,
    queue: str,
    queue_id: int,
    region_code: str,
    base_epoch_ms: int,
) -> None:
    match_id = f"SYN_{index:09d}"
    duration_min = int(paths.duration_min[i])
    duration_ms = duration_min * 60_000 + int(rng.integers(0, 60_000))
    duration_s = duration_ms // 1000
    blue_win = bool(paths.blue_win[i])
    winning_team = TEAM_ID_BLUE if blue_win else TEAM_ID_RED

    roster = _assign_champions(rng)
    # Participant IDs 1–5 are blue and 6–10 are red.
    pid_team = [TEAM_ID_BLUE] * 5 + [TEAM_ID_RED] * 5
    pid_role = [r for r, _, _ in roster]
    pid_champ_id = [cid for _, cid, _ in roster]
    pid_champ = [cn for _, _, cn in roster]

    def pids_of(team_id: int) -> list[int]:
        return [k + 1 for k in range(10) if pid_team[k] == team_id]

    def pick_pid(team_id: int, prefer: Role | None = None) -> int:
        candidates = pids_of(team_id)
        if prefer is not None:
            match = [q for q in candidates if pid_role[q - 1] == prefer]
            if match:
                return match[0]
        return int(rng.choice(candidates))

    # ------------------------------------------------------------------ events
    events: list[dict] = []

    def emit(ts_ms: float, event_type: str, **kw) -> None:
        ts = int(max(0.0, min(float(ts_ms), duration_ms)))
        events.append({"timestamp_ms": ts, "event_type": event_type, **kw})

    def positioned(x: float, y: float) -> dict:
        g = from_norm(x, y)
        return {
            "x_raw": int(round(g.x)),
            "y_raw": int(round(g.y)),
            "x_norm": float(x),
            "y_norm": float(y),
            "has_position": True,
        }

    # --- Kills ---------------------------------------------------------------
    kill_minutes: list[int] = []
    kill_is_blue: list[bool] = []
    for minute in range(1, duration_min + 1):
        for _ in range(int(paths.blue_kills_per_min[i, minute])):
            kill_minutes.append(minute)
            kill_is_blue.append(True)
        for _ in range(int(paths.red_kills_per_min[i, minute])):
            kill_minutes.append(minute)
            kill_is_blue.append(False)

    kill_times = np.array(
        [(m - 1) * 60_000 + rng.random() * 60_000 for m in kill_minutes], dtype=np.float64
    )
    kx, ky = spatial.sample_kill_positions(kill_times / 1000.0, rng)

    # Generate first blood separately and move all remaining kills after it.
    fb_time_ms = float(paths.fb_time_s[i]) * 1000.0
    fb_exists = bool(paths.fb_occurred[i]) and fb_time_ms < duration_ms
    if fb_exists:
        keep = kill_times > fb_time_ms
        kill_times, kx, ky = kill_times[keep], kx[keep], ky[keep]
        kill_is_blue = [b for b, k in zip(kill_is_blue, keep, strict=False) if k]

        fb_lane = FB_LANES[int(paths.fb_lane_idx[i])]
        fbx, fby = spatial.sample_first_blood_position(
            np.array([fb_lane]), np.array([fb_time_ms / 1000.0]), rng
        )
        fb_blue = bool(paths.fb_blue[i])
        killer_team = TEAM_ID_BLUE if fb_blue else TEAM_ID_RED
        prefer = {"TOP": Role.TOP, "MID": Role.MID, "BOT": Role.BOT, "JUNGLE": Role.JUNGLE}.get(
            fb_lane
        )
        killer = pick_pid(killer_team, prefer)
        victim = pick_pid(TEAM_ID_RED if fb_blue else TEAM_ID_BLUE, prefer)
        solo = bool(paths.fb_solo[i])
        assists = (
            []
            if solo
            else [q for q in pids_of(killer_team) if q != killer][: int(rng.integers(1, 3))]
        )
        emit(
            fb_time_ms,
            EventType.KILL,
            event_subtype="FIRSTBLOOD",
            team_id=killer_team,
            participant_id=killer,
            victim_id=victim,
            victim_team_id=TEAM_ID_RED if fb_blue else TEAM_ID_BLUE,
            assist_ids=assists,
            is_first_of_type=True,
            **positioned(float(fbx[0]), float(fby[0])),
        )
        fb_info = (fb_time_ms, killer_team, float(fbx[0]), float(fby[0]), pid_role[killer - 1])
    else:
        fb_info = None
        # A match designated as having no first blood cannot retain ordinary champion kills.
        kill_times = kill_times[:0]
        kx = kx[:0]
        ky = ky[:0]
        kill_is_blue = []

    for k in range(len(kill_times)):
        blue = kill_is_blue[k]
        killer_team = TEAM_ID_BLUE if blue else TEAM_ID_RED
        killer = pick_pid(killer_team)
        victim = pick_pid(TEAM_ID_RED if blue else TEAM_ID_BLUE)
        n_assist = int(rng.integers(0, 4))
        assists = [q for q in pids_of(killer_team) if q != killer][:n_assist]
        emit(
            float(kill_times[k]),
            EventType.KILL,
            team_id=killer_team,
            participant_id=killer,
            victim_id=victim,
            victim_team_id=TEAM_ID_RED if blue else TEAM_ID_BLUE,
            assist_ids=assists,
            **positioned(float(kx[k]), float(ky[k])),
        )

    # --- Turrets and plates --------------------------------------------------
    first_tower_seen: set[int] = set()
    tower_info: dict[int, tuple[float, str]] = {}
    for ts_s, lane, tier, blue_destroyed in paths.tower_events[i]:
        if ts_s * 1000.0 > duration_ms:
            continue
        team = TEAM_ID_BLUE if blue_destroyed else TEAM_ID_RED
        lane_key = {"TOP_LANE": "TOP", "MID_LANE": "MID", "BOT_LANE": "BOT"}[lane]
        x, y = spatial.sample_on_lane(lane_key, 1, rng)
        first = team not in first_tower_seen
        if first:
            first_tower_seen.add(team)
            tower_info[team] = (ts_s * 1000.0, lane)
        emit(
            ts_s * 1000.0,
            EventType.TURRET_DESTROY,
            event_subtype=tier,
            team_id=team,
            participant_id=pick_pid(team),
            building_type="TOWER_BUILDING",
            tower_type=tier,
            lane_type=lane,
            is_first_of_type=first,
            **positioned(float(x[0]), float(y[0])),
        )
        # Inhibitors usually fall with base turrets.
        if tier == "BASE_TURRET" and rng.random() < 0.8:
            emit(
                ts_s * 1000.0 + rng.uniform(5_000, 90_000),
                EventType.INHIBITOR_DESTROY,
                team_id=team,
                participant_id=pick_pid(team),
                building_type="INHIBITOR_BUILDING",
                lane_type=lane,
                **positioned(float(x[0]), float(y[0])),
            )

    for ts_s, lane, blue_destroyed in paths.plate_events[i]:
        if ts_s * 1000.0 > duration_ms:
            continue
        team = TEAM_ID_BLUE if blue_destroyed else TEAM_ID_RED
        lane_key = {"TOP_LANE": "TOP", "MID_LANE": "MID", "BOT_LANE": "BOT"}[lane]
        x, y = spatial.sample_on_lane(lane_key, 1, rng)
        emit(
            ts_s * 1000.0,
            EventType.TURRET_PLATE_DESTROY,
            team_id=team,
            participant_id=pick_pid(team),
            lane_type=lane,
            **positioned(float(x[0]), float(y[0])),
        )

    # --- Objectives: physically materialize spawn events --------------------
    # Riot timelines omit spawns. Both ingestion paths derive them for consistent event sets.
    pit = {
        "dragon": (0.666, 0.302),
        "baron": (0.338, 0.701),
        "herald": (0.338, 0.701),
        "grub": (0.338, 0.701),
    }
    spawn_types = {
        "dragon": (EventType.DRAGON_SPAWN, EventType.DRAGON_KILL, MonsterType.DRAGON),
        "herald": (EventType.HERALD_SPAWN, EventType.HERALD_KILL, MonsterType.HERALD),
        "baron": (EventType.BARON_SPAWN, EventType.BARON_KILL, MonsterType.BARON),
        "grub": (EventType.GRUB_SPAWN, EventType.GRUB_KILL, MonsterType.GRUB),
    }
    obj_seen: dict[tuple[str, int], bool] = {}
    first_dragon: dict[int, float] = {}
    obj_counts: dict[tuple[int, str], int] = {}

    for kind, series in (
        ("dragon", paths.dragon_events[i]),
        ("herald", [(t, b, None) for t, b in paths.herald_events[i]]),
        ("baron", [(t, b, None) for t, b in paths.baron_events[i]]),
        ("grub", [(t, b, None) for t, b in paths.grub_events[i]]),
    ):
        spawn_type, kill_type, monster = spawn_types[kind]
        px, py = pit[kind]
        prev_kill_s = None
        for entry in series:
            ts_s, blue_took = entry[0], entry[1]
            subtype = entry[2] if len(entry) > 2 else None
            if ts_s * 1000.0 > duration_ms:
                continue
            spawn_s = (
                getattr(p, f"{kind}_first_spawn_s")
                if prev_kill_s is None
                else prev_kill_s + getattr(p, f"{kind}_respawn_s")
            )
            if spawn_s * 1000.0 <= duration_ms:
                emit(
                    spawn_s * 1000.0,
                    spawn_type,
                    monster_type=monster,
                    **positioned(px, py),
                )
            team = TEAM_ID_BLUE if blue_took else TEAM_ID_RED
            key = (kind, team)
            first = key not in obj_seen
            obj_seen[key] = True
            if kind == "dragon" and team not in first_dragon:
                first_dragon[team] = ts_s * 1000.0
            obj_counts[(team, kind)] = obj_counts.get((team, kind), 0) + 1
            emit(
                ts_s * 1000.0,
                kill_type,
                event_subtype=subtype,
                team_id=team,
                participant_id=pick_pid(team, Role.JUNGLE),
                monster_type=monster,
                is_first_of_type=first,
                **positioned(
                    float(np.clip(px + rng.normal(0, 0.01), 0.002, 0.998)),
                    float(np.clip(py + rng.normal(0, 0.01), 0.002, 0.998)),
                ),
            )
            prev_kill_s = ts_s

    # Model picks immediately preceding some dragon takes. These are explicit kill events rather
    # than a hard-coded query result, so they also participate in arbitrary combined analyses.
    for dragon in [ev for ev in events if ev["event_type"] == EventType.DRAGON_KILL]:
        if not fb_exists:
            break
        team = dragon["team_id"]
        dragon_ms = dragon["timestamp_ms"]
        already_has_setup = any(
            ev["event_type"] == EventType.KILL
            and ev.get("team_id") == team
            and dragon_ms - 90_000 <= ev["timestamp_ms"] <= dragon_ms
            for ev in events
        )
        if already_has_setup or rng.random() >= p.dragon_setup_kill_prob:
            continue
        killer = pick_pid(team)
        victim_team = TEAM_ID_RED if team == TEAM_ID_BLUE else TEAM_ID_BLUE
        victim = pick_pid(victim_team)
        setup_ms = max(fb_time_ms + 1 if fb_exists else 0, dragon_ms - rng.uniform(15_000, 85_000))
        emit(
            setup_ms,
            EventType.KILL,
            event_subtype="OBJECTIVE_SETUP",
            team_id=team,
            participant_id=killer,
            victim_id=victim,
            victim_team_id=victim_team,
            assist_ids=[],
            **positioned(
                float(np.clip(dragon["x_norm"] + rng.normal(0, 0.025), 0.002, 0.998)),
                float(np.clip(dragon["y_norm"] + rng.normal(0, 0.025), 0.002, 0.998)),
            ),
        )

    # --- Participant events: levels, recalls, wards, and items --------------
    for pid in range(1, 11):
        team = pid_team[pid - 1]
        role = pid_role[pid - 1]
        lane_key = ROLE_LANE.get(role, "MID")
        lane_name = lane_key.value.replace("_LANE", "") if hasattr(lane_key, "value") else "MID"

        n_levels = min(18, 2 + duration_min * 6 // 10)
        for lvl in range(2, n_levels + 1):
            emit(
                (lvl - 1) * duration_ms / (n_levels + 1),
                EventType.CHAMPION_LEVEL_UP,
                team_id=team,
                participant_id=pid,
                level=lvl,
            )
        n_recall = max(1, duration_min // 4)
        for r in range(n_recall):
            emit(
                (r + 0.7) * duration_ms / (n_recall + 1),
                EventType.RECALL,
                team_id=team,
                participant_id=pid,
            )
        n_items = max(1, duration_min // 3)
        for it in range(n_items):
            emit(
                (it + 0.75) * duration_ms / (n_items + 1),
                EventType.ITEM_PURCHASE,
                team_id=team,
                participant_id=pid,
                item_id=int(rng.integers(3000, 3200)),
            )
        n_wards = max(1, duration_min // 3 if role == Role.SUPPORT else duration_min // 6)
        wx, wy = spatial.sample_on_lane(
            lane_name if lane_name in spatial.LANE_PATHS else "MID", n_wards, rng
        )
        for w in range(n_wards):
            placed_ms = (w + 0.4) * duration_ms / (n_wards + 1)
            ward_type = "YELLOW_TRINKET" if role != Role.SUPPORT else "CONTROL_WARD"
            emit(
                placed_ms,
                EventType.WARD_PLACED,
                team_id=team,
                participant_id=pid,
                ward_type=ward_type,
                **positioned(float(wx[w]), float(wy[w])),
            )
            # Ward destruction belongs to the opposing team and retains the ward position.
            if rng.random() < 0.45:
                enemy = TEAM_ID_RED if team == TEAM_ID_BLUE else TEAM_ID_BLUE
                emit(
                    placed_ms + rng.uniform(20_000, 150_000),
                    EventType.WARD_DESTROYED,
                    team_id=enemy,
                    participant_id=pick_pid(enemy),
                    ward_type=ward_type,
                    **positioned(float(wx[w]), float(wy[w])),
                )

        # Item sales represent build or boot changes, zero to two per participant per match.
        for sell in range(int(rng.integers(0, 3))):
            emit(
                (sell + 1.3) * duration_ms / 4.0,
                EventType.ITEM_SELL,
                team_id=team,
                participant_id=pid,
                item_id=int(rng.integers(3000, 3200)),
            )

    emit(duration_ms, EventType.GAME_END, team_id=winning_team)

    # --- Event rows ----------------------------------------------------------
    events.sort(key=lambda e: e["timestamp_ms"])
    # `is_first_of_type` has event-specific scope: a kill is global (first blood), while
    # team-owned events are first per actor team. Teamless events are global by definition.
    first_scopes: set[tuple[str, int | None]] = set()
    for ev in events:
        event_type = str(ev["event_type"])
        scope = first_event_scope(event_type, ev.get("team_id"))
        ev["is_first_of_type"] = scope not in first_scopes
        first_scopes.add(scope)
    ec = cols["events"]
    for eid, ev in enumerate(events):
        pid = ev.get("participant_id")
        ec.add(
            match_id=match_id,
            event_id=eid,
            timestamp_ms=ev["timestamp_ms"],
            frame_idx=ev["timestamp_ms"] // FRAME_INTERVAL_MS,
            event_type=ev["event_type"],
            event_subtype=ev.get("event_subtype"),
            event_origin=EventOrigin.SYNTHETIC,
            team_id=ev.get("team_id"),
            participant_id=pid,
            champion_id=pid_champ_id[pid - 1] if pid else None,
            role=str(pid_role[pid - 1]) if pid else None,
            victim_id=ev.get("victim_id"),
            victim_team_id=ev.get("victim_team_id"),
            victim_champion_id=pid_champ_id[ev["victim_id"] - 1] if ev.get("victim_id") else None,
            assist_ids=ev.get("assist_ids"),
            assist_count=len(ev.get("assist_ids") or [])
            if ev.get("assist_ids") is not None
            else None,
            x_raw=ev.get("x_raw"),
            y_raw=ev.get("y_raw"),
            x_norm=ev.get("x_norm"),
            y_norm=ev.get("y_norm"),
            has_position=bool(ev.get("has_position", False)),
            item_id=ev.get("item_id"),
            ward_type=ev.get("ward_type"),
            skill_slot=ev.get("skill_slot"),
            level=ev.get("level"),
            bounty=ev.get("bounty"),
            kill_streak_length=ev.get("kill_streak_length"),
            building_type=ev.get("building_type"),
            tower_type=ev.get("tower_type"),
            lane_type=ev.get("lane_type"),
            monster_type=ev.get("monster_type"),
            is_first_of_type=ev.get("is_first_of_type", False),
        )

    # --- Frames --------------------------------------------------------------
    n_frames = duration_min + 1
    role_w = np.array([p.role_gold_weight[str(r)] for r in pid_role])
    share = np.empty((10,))
    for team_id in (TEAM_ID_BLUE, TEAM_ID_RED):
        mask = np.array([t == team_id for t in pid_team])
        w = role_w[mask] * rng.dirichlet(np.full(5, 28.0)) * 5
        share[mask] = w / w.sum()

    pc = cols["timeline_participant_frames"]
    tc = cols["timeline_team_frames"]
    team_kill_cum = {TEAM_ID_BLUE: 0, TEAM_ID_RED: 0}
    towers_lost = {TEAM_ID_BLUE: 0, TEAM_ID_RED: 0}
    dragons_taken = {TEAM_ID_BLUE: 0, TEAM_ID_RED: 0}
    barons_taken = {TEAM_ID_BLUE: 0, TEAM_ID_RED: 0}
    frame_event_cursor = 0

    # Sample all frame positions in one vectorized call; per-frame NumPy calls are about 10x slower.
    pid_lane_name: list[str] = []
    for k in range(10):
        lk = ROLE_LANE.get(pid_role[k])
        name = lk.value.replace("_LANE", "") if lk is not None else "MID"
        pid_lane_name.append(name if name in spatial.LANE_PATHS else "MID")
    pid_frame_xy = [
        spatial.sample_lane_position(pid_lane_name[k], n_frames, rng) for k in range(10)
    ]
    pid_frame_raw = [from_norm_arrays(xy[0], xy[1]) for xy in pid_frame_xy]

    for f in range(n_frames):
        t_min = f
        timestamp_ms = f * FRAME_INTERVAL_MS
        while (
            frame_event_cursor < len(events)
            and events[frame_event_cursor]["timestamp_ms"] <= timestamp_ms
        ):
            frame_event = events[frame_event_cursor]
            actor_team = frame_event.get("team_id")
            event_type = frame_event["event_type"]
            if actor_team in team_kill_cum:
                if event_type == EventType.KILL:
                    team_kill_cum[actor_team] += 1
                elif event_type == EventType.TURRET_DESTROY:
                    victim_team = TEAM_ID_RED if actor_team == TEAM_ID_BLUE else TEAM_ID_BLUE
                    towers_lost[victim_team] += 1
                elif event_type == EventType.DRAGON_KILL:
                    dragons_taken[actor_team] += 1
                elif event_type == EventType.BARON_KILL:
                    barons_taken[actor_team] += 1
            frame_event_cursor += 1
        base_team_gold = p.gold_base_intercept + p.gold_base_slope * t_min
        gd = float(paths.gold_diff[i, min(f, paths.gold_diff.shape[1] - 1)])
        xd = float(paths.xp_diff[i, min(f, paths.xp_diff.shape[1] - 1)])

        for team_id in (TEAM_ID_BLUE, TEAM_ID_RED):
            sign = 1.0 if team_id == TEAM_ID_BLUE else -1.0
            total_gold = max(500.0, base_team_gold + sign * gd / 2.0)
            total_xp = max(500.0, base_team_gold * 0.9 + sign * xd / 2.0)
            tc.add(
                match_id=match_id,
                frame_idx=f,
                timestamp_ms=timestamp_ms,
                team_id=team_id,
                side=side_of(team_id),
                total_gold=int(total_gold),
                total_xp=int(total_xp),
                total_level=int(min(90, 5 + t_min * 2.2)),
                total_cs=int(t_min * 28),
                gold_diff=int(sign * gd),
                xp_diff=int(sign * xd),
                kill_diff=int(sign * (team_kill_cum[TEAM_ID_BLUE] - team_kill_cum[TEAM_ID_RED])),
                alive_towers=max(0, 11 - towers_lost[team_id]),
                dragons_taken=dragons_taken[team_id],
                barons_taken=barons_taken[team_id],
            )

            for pid in pids_of(team_id):
                k = pid - 1
                g = total_gold * share[k]
                role = pid_role[k]
                fx, fy = pid_frame_xy[k]
                rx, ry = pid_frame_raw[k]
                pc.add(
                    match_id=match_id,
                    frame_idx=f,
                    timestamp_ms=timestamp_ms,
                    participant_id=pid,
                    team_id=team_id,
                    side=side_of(team_id),
                    champion_id=pid_champ_id[k],
                    role=str(role),
                    total_gold=int(g),
                    current_gold=int(g * rng.uniform(0.05, 0.4)),
                    xp=int(total_xp * share[k]),
                    level=int(min(18, 1 + t_min * 0.55)),
                    minions_killed=int(t_min * (7.0 if role != Role.SUPPORT else 1.0)),
                    jungle_minions_killed=int(t_min * (4.0 if role == Role.JUNGLE else 0.0)),
                    x_raw=int(rx[f]),
                    y_raw=int(ry[f]),
                    x_norm=float(fx[f]),
                    y_norm=float(fy[f]),
                    damage_done_to_champions=int(t_min * 600 * share[k] * 5),
                    damage_taken=int(t_min * 550 * share[k] * 5),
                )

    # --- Participants, teams, matches, and summaries ------------------------
    kills_by_pid = {q: 0 for q in range(1, 11)}
    deaths_by_pid = {q: 0 for q in range(1, 11)}
    assists_by_pid = {q: 0 for q in range(1, 11)}
    for ev in events:
        if ev["event_type"] != EventType.KILL:
            continue
        kills_by_pid[ev["participant_id"]] += 1
        deaths_by_pid[ev["victim_id"]] += 1
        for a in ev.get("assist_ids") or []:
            assists_by_pid[a] += 1

    final_gold_total = p.gold_base_intercept + p.gold_base_slope * duration_min
    gd_final = float(paths.gold_diff[i, min(duration_min, paths.gold_diff.shape[1] - 1)])
    first_tower_event = next(
        (ev for ev in events if ev["event_type"] == EventType.TURRET_DESTROY), None
    )

    ppc = cols["participants"]
    for pid in range(1, 11):
        k = pid - 1
        team_id = pid_team[k]
        sign = 1.0 if team_id == TEAM_ID_BLUE else -1.0
        team_gold = max(500.0, final_gold_total + sign * gd_final / 2.0)
        ppc.add(
            match_id=match_id,
            participant_id=pid,
            team_id=team_id,
            side=side_of(team_id),
            puuid=None,
            riot_id=f"SynthPlayer{index % 100000:05d}#{pid:02d}",
            summoner_name=f"SynthPlayer{index % 100000:05d}",
            champion_id=pid_champ_id[k],
            champion=pid_champ[k],
            role=str(pid_role[k]),
            role_raw=str(pid_role[k]),
            rank_tier="GOLD",
            rank_division="II",
            rank_league_points=50,
            win=(team_id == winning_team),
            kills=kills_by_pid[pid],
            deaths=deaths_by_pid[pid],
            assists=assists_by_pid[pid],
            gold_earned=int(team_gold * share[k]),
            gold_spent=int(team_gold * share[k] * 0.92),
            total_damage_dealt_to_champions=int(duration_min * 600 * share[k] * 5),
            total_damage_taken=int(duration_min * 550 * share[k] * 5),
            vision_score=int(duration_min * (1.8 if pid_role[k] == Role.SUPPORT else 0.8)),
            wards_placed=max(1, duration_min // (3 if pid_role[k] == Role.SUPPORT else 6)),
            wards_killed=int(rng.integers(0, 6)),
            champ_level=int(min(18, 1 + duration_min * 0.55)),
            total_minions_killed=int(duration_min * (7.0 if pid_role[k] != Role.SUPPORT else 1.0)),
            neutral_minions_killed=int(duration_min * (4.0 if pid_role[k] == Role.JUNGLE else 0.0)),
            items=[int(x) for x in rng.integers(3000, 3200, size=6)],
            first_blood_kill=bool(
                fb_info
                and next(
                    (
                        ev.get("participant_id")
                        for ev in events
                        if ev["event_type"] == EventType.KILL and ev["is_first_of_type"]
                    ),
                    None,
                )
                == pid
            ),
            first_blood_assist=False,
            first_tower_kill=bool(
                first_tower_event and first_tower_event.get("participant_id") == pid
            ),
        )

    team_kills = {
        TEAM_ID_BLUE: sum(kills_by_pid[q] for q in pids_of(TEAM_ID_BLUE)),
        TEAM_ID_RED: sum(kills_by_pid[q] for q in pids_of(TEAM_ID_RED)),
    }
    tower_counts = {TEAM_ID_BLUE: 0, TEAM_ID_RED: 0}
    for _ts, _lane, _tier, blue_destroyed in paths.tower_events[i]:
        tower_counts[TEAM_ID_BLUE if blue_destroyed else TEAM_ID_RED] += 1

    first_tower_team = min(tower_info, key=lambda t: tower_info[t][0]) if tower_info else None
    first_dragon_team = min(first_dragon, key=lambda t: first_dragon[t]) if first_dragon else None
    first_baron_event = next(
        (ev for ev in events if ev["event_type"] == EventType.BARON_KILL), None
    )
    first_baron_team = first_baron_event.get("team_id") if first_baron_event else None
    first_herald_event = next(
        (ev for ev in events if ev["event_type"] == EventType.HERALD_KILL), None
    )
    first_herald_team = first_herald_event.get("team_id") if first_herald_event else None

    tmc = cols["teams"]
    smc = cols["match_summary"]
    regions_map = regions
    for team_id in (TEAM_ID_BLUE, TEAM_ID_RED):
        sign = 1.0 if team_id == TEAM_ID_BLUE else -1.0
        got_fb = bool(fb_info and fb_info[1] == team_id)
        tmc.add(
            match_id=match_id,
            team_id=team_id,
            side=side_of(team_id),
            win=(team_id == winning_team),
            first_blood=got_fb,
            first_tower=(first_tower_team == team_id),
            first_dragon=(first_dragon_team == team_id),
            first_baron=(first_baron_team == team_id),
            first_herald=(first_herald_team == team_id),
            first_inhibitor=False,
            tower_kills=tower_counts[team_id],
            inhibitor_kills=0,
            dragon_kills=obj_counts.get((team_id, "dragon"), 0),
            baron_kills=obj_counts.get((team_id, "baron"), 0),
            herald_kills=obj_counts.get((team_id, "herald"), 0),
            grub_kills=obj_counts.get((team_id, "grub"), 0),
            champion_kills=team_kills[team_id],
            deaths=team_kills[TEAM_ID_RED if team_id == TEAM_ID_BLUE else TEAM_ID_BLUE],
            assists=sum(assists_by_pid[q] for q in pids_of(team_id)),
            total_gold=int(max(500.0, final_gold_total + sign * gd_final / 2.0)),
            bans=[],
        )

        def frame_gold(f: int, s: float = sign) -> int | None:
            return int(s * float(paths.gold_diff[i, f])) if duration_min >= f else None

        own_tower = tower_info.get(team_id)
        fb_ms = fb_info[0] if fb_info else None
        smc.add(
            match_id=match_id,
            team_id=team_id,
            side=side_of(team_id),
            win=(team_id == winning_team),
            duration_s=duration_s,
            patch=patch,
            queue=queue,
            tier="GOLD",
            region=region_code,
            got_first_blood=got_fb,
            first_blood_ms=int(fb_ms) if got_fb and fb_ms is not None else None,
            first_blood_x_norm=float(fb_info[2]) if got_fb else None,
            first_blood_y_norm=float(fb_info[3]) if got_fb else None,
            first_blood_region=_tag_region(fb_info[2], fb_info[3], regions_map) if got_fb else None,
            first_blood_killer_role=str(fb_info[4]) if got_fb else None,
            got_first_tower=(first_tower_team == team_id),
            first_tower_ms=int(own_tower[0]) if own_tower else None,
            first_tower_lane=own_tower[1] if own_tower else None,
            fb_to_first_tower_ms=(
                int(own_tower[0] - fb_ms)
                if (got_fb and own_tower and fb_ms is not None and own_tower[0] >= fb_ms)
                else None
            ),
            gold_diff_at_5m=frame_gold(5),
            gold_diff_at_10m=frame_gold(10),
            gold_diff_at_15m=frame_gold(15),
            gold_diff_at_20m=frame_gold(20),
            xp_diff_at_10m=int(sign * float(paths.xp_diff[i, 10])) if duration_min >= 10 else None,
            kill_diff_at_10m=int(sign * float(paths.kill_diff[i, 10]))
            if duration_min >= 10
            else None,
            first_dragon=(first_dragon_team == team_id),
            first_dragon_ms=int(first_dragon[team_id]) if team_id in first_dragon else None,
            dragon_kills=obj_counts.get((team_id, "dragon"), 0),
            baron_kills=obj_counts.get((team_id, "baron"), 0),
            tower_kills=tower_counts[team_id],
            total_kills=team_kills[team_id],
        )

    cols["matches"].add(
        match_id=match_id,
        platform_id=f"{region_code}1",
        region=region_code,
        queue_id=queue_id,
        queue=queue,
        game_version=f"{patch}.600.1234",
        patch=patch,
        tier="GOLD",
        game_creation_ms=base_epoch_ms + index * 600_000,
        game_start_ms=base_epoch_ms + index * 600_000 + 90_000,
        duration_ms=duration_ms,
        duration_s=duration_s,
        winning_team=winning_team,
        ended_in_surrender=bool(rng.random() < 0.22),
        ended_early_surrender=False,
        map_id=11,
        data_source=str(DataSource.SYNTHETIC),
        ingested_at=SYNTHETIC_INGESTED_AT,
        schema_version=SCHEMA_VERSION,
    )


def generate(
    n_matches: int,
    *,
    seed: int = 20260913,
    params: SynthParams | None = None,
    patch: str = "14.19",
    queue: str = "RANKED_SOLO_5x5",
    queue_id: int = 420,
    region_code: str = "SYNTH",
    start_index: int = 0,
) -> GeneratedDataset:
    p = params or SynthParams.load()
    regions = preset_regions()

    cols = {name: _Columns(name) for name in TABLES}
    base_epoch_ms = 1_760_000_000_000

    # Every match owns two counter-derived streams. Absolute match index, rather than chunk or
    # worker position, determines both streams, so changing chunk_size/workers cannot change data.
    for i in range(n_matches):
        absolute_index = start_index + i
        paths = simulate(
            1,
            p,
            np.random.default_rng(np.random.SeedSequence([seed, absolute_index, 0])),
        )
        _generate_one(
            absolute_index,
            paths,
            0,
            p,
            np.random.default_rng(np.random.SeedSequence([seed, absolute_index, 1])),
            cols,
            regions,
            patch=patch,
            queue=queue,
            queue_id=queue_id,
            region_code=region_code,
            base_epoch_ms=base_epoch_ms,
        )

    return GeneratedDataset(tables={k: c.build() for k, c in cols.items()}, n_matches=n_matches)
