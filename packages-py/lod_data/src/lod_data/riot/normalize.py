"""Normalize Match-V5 match and timeline JSON into shared Arrow schemas."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pyarrow as pa

from ..coords import is_in_map_bounds, to_norm
from ..enums import SCHEMA_VERSION, EventOrigin, first_event_scope
from ..regions import point_in_region, preset_regions
from ..schema import TABLES
from ..synth.generator import GeneratedDataset

QUEUE_NAMES = {
    420: "RANKED_SOLO_5x5",
    440: "RANKED_FLEX_SR",
    450: "ARAM",
    480: "SWIFTPLAY",
    490: "QUICKPLAY",
}
REGION_PRIORITY = ("dragon_pit", "baron_pit", "top_lane", "bot_lane", "mid_lane", "river")
DRAGON_PIT = (9866, 4414)
BARON_PIT = (4950, 10400)
SUPPORTED_SPATIAL_MAP_ID = 11

ROLE_NAMES = {
    "TOP": "TOP",
    "JUNGLE": "JUNGLE",
    "MIDDLE": "MID",
    "MID": "MID",
    "BOTTOM": "BOT",
    "BOT": "BOT",
    "UTILITY": "SUPPORT",
    "SUPPORT": "SUPPORT",
}

TIER_ORDER = (
    "IRON",
    "BRONZE",
    "SILVER",
    "GOLD",
    "PLATINUM",
    "EMERALD",
    "DIAMOND",
    "MASTER",
    "GRANDMASTER",
    "CHALLENGER",
)


class UnsupportedMapError(ValueError):
    """Raised when a match cannot share the Summoner's Rift spatial contract."""

    def __init__(self, match_id: str, map_id: int | None) -> None:
        self.match_id = match_id
        self.map_id = map_id
        super().__init__(
            f"match {match_id} uses unsupported map {map_id!r}; "
            f"only map {SUPPORTED_SPATIAL_MAP_ID} can be normalized into this dataset"
        )


def _row(table: str, **values: Any) -> dict[str, Any]:
    return {field.name: values.get(field.name) for field in TABLES[table]}


def _table(name: str, rows: list[dict[str, Any]]) -> pa.Table:
    return pa.Table.from_pylist(rows, schema=TABLES[name]) if rows else TABLES[name].empty_table()


def _side(team_id: int | None) -> str | None:
    return "BLUE" if team_id == 100 else "RED" if team_id == 200 else None


def _role(participant: dict[str, Any]) -> str | None:
    raw = participant.get("teamPosition") or participant.get("individualPosition")
    return ROLE_NAMES.get(str(raw).upper()) if raw else None


def _match_tier(participants: list[dict[str, Any]]) -> str:
    ranked = sorted(
        TIER_ORDER.index(str(participant["_lodRankTier"]).upper())
        for participant in participants
        if str(participant.get("_lodRankTier", "")).upper() in TIER_ORDER
    )
    return TIER_ORDER[ranked[len(ranked) // 2]] if ranked else "UNRANKED"


def _region_at(x: float | None, y: float | None) -> str | None:
    if x is None or y is None:
        return None
    regions = preset_regions()
    return next(
        (region_id for region_id in REGION_PRIORITY if point_in_region(x, y, regions[region_id])),
        None,
    )


def _position(event: dict[str, Any]) -> tuple[int | None, int | None, float | None, float | None]:
    position = event.get("position") or {}
    x, y = position.get("x"), position.get("y")
    if not isinstance(x, int) or not isinstance(y, int):
        return None, None, None, None
    nx, ny = to_norm(x, y)
    if not is_in_map_bounds(nx, ny):
        return x, y, None, None
    return x, y, nx, ny


def _patch_tuple(patch: str) -> tuple[int, int]:
    """Convert Riot year-based and legacy patch strings to comparable integer pairs."""
    try:
        major, minor = patch.split(".", 1)
        return int(major), int(minor)
    except (TypeError, ValueError):
        return 0, 0


def _spawn_rules(patch: str) -> dict[str, tuple[int, int, tuple[int, int]]]:
    """Return first spawn time, respawn delay, and position.

    Rules account for objective changes at patch boundaries 14.1, 25.1, 25.09, and 26.1.
    Herald has no respawn in supported 14+ versions, so its respawn interval is zero.
    """
    version = _patch_tuple(patch)
    herald_ms = (
        15 * 60_000
        if version >= (25, 9)
        else 16 * 60_000
        if version >= (25, 1)
        else 14 * 60_000
        if version >= (14, 1)
        else 8 * 60_000
    )
    baron_ms = 25 * 60_000 if (25, 1) <= version < (26, 1) else 20 * 60_000
    return {
        "dragon": (5 * 60_000, 5 * 60_000, DRAGON_PIT),
        "herald": (herald_ms, 0, BARON_PIT),
        "baron": (baron_ms, 6 * 60_000, BARON_PIT),
    }


def _add_spawn_events(
    events: list[dict[str, Any]], match_id: str, patch: str, duration_ms: int
) -> None:
    """Materialize rule-based objective spawns absent from Match-V5 timelines."""
    for monster, (first_ms, respawn_ms, (x, y)) in _spawn_rules(patch).items():
        spawn_times = [first_ms]
        if respawn_ms:
            spawn_times.extend(
                int(event["timestamp_ms"]) + respawn_ms
                for event in events
                if event["event_type"] == f"{monster}_kill"
            )
        nx, ny = to_norm(x, y)
        for timestamp_ms in sorted(set(spawn_times)):
            if timestamp_ms > duration_ms:
                continue
            events.append(
                _row(
                    "events",
                    match_id=match_id,
                    timestamp_ms=timestamp_ms,
                    frame_idx=timestamp_ms // 60_000,
                    event_type=f"{monster}_spawn",
                    event_subtype="INFERRED_RULE",
                    event_origin=EventOrigin.INFERRED_RULE,
                    x_raw=x,
                    y_raw=y,
                    x_norm=nx,
                    y_norm=ny,
                    has_position=True,
                    monster_type={
                        "dragon": "DRAGON",
                        "herald": "RIFTHERALD",
                        "baron": "BARON_NASHOR",
                    }[monster],
                )
            )


def _add_game_end_event(
    events: list[dict[str, Any]], match_id: str, duration_ms: int, winning_team: int
) -> None:
    """Ensure Match-V5's authoritative result is available as a temporal victory event."""
    if winning_team not in (100, 200) or any(event["event_type"] == "game_end" for event in events):
        return
    events.append(
        _row(
            "events",
            match_id=match_id,
            timestamp_ms=duration_ms,
            frame_idx=duration_ms // 60_000,
            event_type="game_end",
            event_subtype="MATCH_RESULT",
            event_origin=EventOrigin.OBSERVED,
            team_id=winning_team,
            has_position=False,
        )
    )


def normalize_match(match: dict[str, Any], timeline: dict[str, Any]) -> GeneratedDataset:
    info = match["info"]
    metadata = match["metadata"]
    match_id = str(metadata["matchId"])
    raw_map_id = info.get("mapId")
    map_id = int(raw_map_id) if raw_map_id is not None else None
    if map_id != SUPPORTED_SPATIAL_MAP_ID:
        raise UnsupportedMapError(match_id, map_id)
    platform = str(info.get("platformId") or match_id.split("_", 1)[0])
    region = platform.removesuffix("1")
    queue_id = int(info.get("queueId") or 0)
    queue = QUEUE_NAMES.get(queue_id, f"QUEUE_{queue_id}")
    version = str(info.get("gameVersion") or "0.0")
    patch = ".".join(version.split(".")[:2])
    duration_s = int(info.get("gameDuration") or 0)
    participants_raw = info.get("participants") or []
    tier = _match_tier(participants_raw)
    teams_raw = info.get("teams") or []
    winner = next((int(t["teamId"]) for t in teams_raw if t.get("win")), 0)

    matches = [
        _row(
            "matches",
            match_id=match_id,
            platform_id=platform,
            region=region,
            queue_id=queue_id,
            queue=queue,
            game_version=version,
            patch=patch,
            tier=tier,
            game_creation_ms=int(info.get("gameCreation") or 0),
            game_start_ms=int(info.get("gameStartTimestamp") or 0),
            duration_ms=duration_s * 1000,
            duration_s=duration_s,
            winning_team=winner,
            ended_in_surrender=any(p.get("gameEndedInSurrender") for p in participants_raw),
            ended_early_surrender=any(p.get("gameEndedInEarlySurrender") for p in participants_raw),
            map_id=map_id,
            data_source="riot_v5",
            ingested_at=datetime.now(UTC),
            schema_version=SCHEMA_VERSION,
        )
    ]
    participant_by_id = {int(p["participantId"]): p for p in participants_raw}
    participants = [
        _row(
            "participants",
            match_id=match_id,
            participant_id=int(p["participantId"]),
            team_id=int(p["teamId"]),
            side=_side(int(p["teamId"])),
            puuid=p.get("puuid"),
            riot_id="#".join(filter(None, [p.get("riotIdGameName"), p.get("riotIdTagline")])),
            summoner_name=p.get("summonerName"),
            champion_id=int(p.get("championId") or 0),
            champion=p.get("championName"),
            role=_role(p),
            role_raw=p.get("individualPosition") or p.get("teamPosition"),
            rank_tier=p.get("_lodRankTier"),
            rank_division=p.get("_lodRankDivision"),
            rank_league_points=p.get("_lodLeaguePoints"),
            win=bool(p.get("win")),
            kills=int(p.get("kills") or 0),
            deaths=int(p.get("deaths") or 0),
            assists=int(p.get("assists") or 0),
            gold_earned=int(p.get("goldEarned") or 0),
            gold_spent=int(p.get("goldSpent") or 0),
            total_damage_dealt_to_champions=int(p.get("totalDamageDealtToChampions") or 0),
            total_damage_taken=int(p.get("totalDamageTaken") or 0),
            vision_score=int(p.get("visionScore") or 0),
            wards_placed=int(p.get("wardsPlaced") or 0),
            wards_killed=int(p.get("wardsKilled") or 0),
            champ_level=int(p.get("champLevel") or 0),
            total_minions_killed=int(p.get("totalMinionsKilled") or 0),
            neutral_minions_killed=int(p.get("neutralMinionsKilled") or 0),
            items=[int(p.get(f"item{i}") or 0) for i in range(7) if p.get(f"item{i}")],
            first_blood_kill=bool(p.get("firstBloodKill")),
            first_blood_assist=bool(p.get("firstBloodAssist")),
            first_tower_kill=bool(p.get("firstTowerKill")),
        )
        for p in participants_raw
    ]
    teams = []
    for team in teams_raw:
        objectives = team.get("objectives") or {}
        team_id = int(team["teamId"])
        totals = [p for p in participants_raw if int(p["teamId"]) == team_id]
        teams.append(
            _row(
                "teams",
                match_id=match_id,
                team_id=team_id,
                side=_side(team_id),
                win=bool(team.get("win")),
                first_blood=bool((objectives.get("champion") or {}).get("first")),
                first_tower=bool((objectives.get("tower") or {}).get("first")),
                first_dragon=bool((objectives.get("dragon") or {}).get("first")),
                first_baron=bool((objectives.get("baron") or {}).get("first")),
                first_herald=bool((objectives.get("riftHerald") or {}).get("first")),
                first_inhibitor=bool((objectives.get("inhibitor") or {}).get("first")),
                tower_kills=int((objectives.get("tower") or {}).get("kills") or 0),
                inhibitor_kills=int((objectives.get("inhibitor") or {}).get("kills") or 0),
                dragon_kills=int((objectives.get("dragon") or {}).get("kills") or 0),
                baron_kills=int((objectives.get("baron") or {}).get("kills") or 0),
                herald_kills=int((objectives.get("riftHerald") or {}).get("kills") or 0),
                grub_kills=int((objectives.get("horde") or {}).get("kills") or 0),
                champion_kills=sum(int(p.get("kills") or 0) for p in totals),
                deaths=sum(int(p.get("deaths") or 0) for p in totals),
                assists=sum(int(p.get("assists") or 0) for p in totals),
                total_gold=sum(int(p.get("goldEarned") or 0) for p in totals),
                bans=[
                    champion_id
                    for ban in team.get("bans") or []
                    if (champion_id := int(ban.get("championId") or 0)) > 0
                ],
            )
        )

    frames = (timeline.get("info") or {}).get("frames") or []
    raw_events = [event for frame in frames for event in frame.get("events") or []]
    raw_events.sort(key=lambda event: int(event.get("timestamp") or 0))
    events: list[dict[str, Any]] = []
    for event in raw_events:
        event_type, subtype, team_id, participant_id, victim_id = _event_identity(event)
        if event_type is None:
            continue
        x, y, nx, ny = _position(event)
        actor = participant_by_id.get(participant_id or -1, {})
        if team_id is None:
            team_id = actor.get("teamId")
        if event_type == "kill" and team_id is None and victim_id is not None:
            victim_team = participant_by_id.get(victim_id, {}).get("teamId")
            team_id = 200 if victim_team == 100 else 100 if victim_team == 200 else None
        timestamp_ms = int(event.get("timestamp") or 0)
        events.append(
            _row(
                "events",
                match_id=match_id,
                event_id=len(events),
                timestamp_ms=timestamp_ms,
                frame_idx=timestamp_ms // 60_000,
                event_type=event_type,
                event_subtype=subtype,
                event_origin=EventOrigin.OBSERVED,
                team_id=team_id,
                participant_id=participant_id,
                champion_id=actor.get("championId"),
                role=_role(actor),
                victim_id=victim_id,
                victim_team_id=participant_by_id.get(victim_id or -1, {}).get("teamId"),
                victim_champion_id=participant_by_id.get(victim_id or -1, {}).get("championId"),
                assist_ids=[int(value) for value in event.get("assistingParticipantIds") or []],
                assist_count=len(event.get("assistingParticipantIds") or []),
                x_raw=x,
                y_raw=y,
                x_norm=nx,
                y_norm=ny,
                has_position=nx is not None,
                item_id=event.get("itemId") or event.get("beforeId"),
                item_after_id=event.get("afterId") or None,
                ward_type=event.get("wardType"),
                skill_slot=event.get("skillSlot"),
                level=event.get("level"),
                bounty=event.get("bounty"),
                kill_streak_length=event.get("killStreakLength"),
                building_type=event.get("buildingType"),
                tower_type=event.get("towerType"),
                lane_type=event.get("laneType"),
                monster_type=event.get("monsterType"),
                is_first_of_type=False,
            )
        )
    _add_game_end_event(events, match_id, duration_s * 1000, winner)
    _add_spawn_events(events, match_id, patch, duration_s * 1000)
    events.sort(key=lambda event: (int(event["timestamp_ms"]), str(event["event_type"])))
    first_scopes: set[tuple[str, int | None]] = set()
    for event_id, event in enumerate(events):
        event["event_id"] = event_id
        scope = first_event_scope(event["event_type"], event.get("team_id"))
        event["is_first_of_type"] = scope not in first_scopes
        first_scopes.add(scope)

    participant_frames: list[dict[str, Any]] = []
    team_frames: list[dict[str, Any]] = []
    for frame_index, frame in enumerate(frames):
        timestamp_ms = int(frame.get("timestamp") or frame_index * 60_000)
        by_team: dict[int, list[dict[str, Any]]] = {100: [], 200: []}
        for key, value in (frame.get("participantFrames") or {}).items():
            participant_id = int(value.get("participantId") or key)
            participant = participant_by_id.get(participant_id, {})
            team_id = int(participant.get("teamId") or (100 if participant_id <= 5 else 200))
            x, y, nx, ny = _position(value)
            normalized = _row(
                "timeline_participant_frames",
                match_id=match_id,
                frame_idx=frame_index,
                timestamp_ms=timestamp_ms,
                participant_id=participant_id,
                team_id=team_id,
                side=_side(team_id),
                champion_id=participant.get("championId"),
                role=_role(participant),
                total_gold=int(value.get("totalGold") or 0),
                current_gold=int(value.get("currentGold") or 0),
                xp=int(value.get("xp") or 0),
                level=int(value.get("level") or 0),
                minions_killed=int(value.get("minionsKilled") or 0),
                jungle_minions_killed=int(value.get("jungleMinionsKilled") or 0),
                x_raw=x,
                y_raw=y,
                x_norm=nx,
                y_norm=ny,
                damage_done_to_champions=int(
                    (value.get("damageStats") or {}).get("totalDamageDoneToChampions") or 0
                ),
                damage_taken=int((value.get("damageStats") or {}).get("totalDamageTaken") or 0),
            )
            participant_frames.append(normalized)
            by_team[team_id].append(normalized)
        gold = {team: sum(row["total_gold"] for row in values) for team, values in by_team.items()}
        xp = {team: sum(row["xp"] for row in values) for team, values in by_team.items()}
        for team_id in (100, 200):
            opponent = 200 if team_id == 100 else 100
            occurred = [event for event in events if event["timestamp_ms"] <= timestamp_ms]

            def count(kind: str, team: int, _occurred: list[dict[str, Any]] = occurred) -> int:
                return sum(
                    event["event_type"] == kind and event["team_id"] == team for event in _occurred
                )

            team_frames.append(
                _row(
                    "timeline_team_frames",
                    match_id=match_id,
                    frame_idx=frame_index,
                    timestamp_ms=timestamp_ms,
                    team_id=team_id,
                    side=_side(team_id),
                    total_gold=gold[team_id],
                    total_xp=xp[team_id],
                    total_level=sum(row["level"] for row in by_team[team_id]),
                    total_cs=sum(
                        row["minions_killed"] + row["jungle_minions_killed"]
                        for row in by_team[team_id]
                    ),
                    gold_diff=gold[team_id] - gold[opponent],
                    xp_diff=xp[team_id] - xp[opponent],
                    kill_diff=count("kill", team_id) - count("kill", opponent),
                    alive_towers=max(0, 11 - count("turret_destroy", opponent)),
                    dragons_taken=count("dragon_kill", team_id),
                    barons_taken=count("baron_kill", team_id),
                )
            )

    summaries = [
        _summary(match_id, team, events, team_frames, patch, queue, tier, region, duration_s)
        for team in teams
    ]
    rows_by_table = {
        "matches": matches,
        "participants": participants,
        "teams": teams,
        "events": events,
        "timeline_participant_frames": participant_frames,
        "timeline_team_frames": team_frames,
        "match_summary": summaries,
    }
    return GeneratedDataset(
        tables={name: _table(name, rows) for name, rows in rows_by_table.items()}, n_matches=1
    )


def _event_identity(
    event: dict[str, Any],
) -> tuple[str | None, str | None, int | None, int | None, int | None]:
    kind = str(event.get("type") or "").upper()
    actor_value = (
        event.get("creatorId")
        if kind == "WARD_PLACED"
        else event.get("killerId") or event.get("participantId")
    )
    participant = int(actor_value or 0) or None
    victim = int(event.get("victimId") or 0) or None
    if kind == "CHAMPION_KILL":
        return "kill", event.get("killType"), event.get("killerTeamId"), participant, victim
    if kind == "BUILDING_KILL":
        owner = int(event.get("teamId") or 0)
        actor_team = 200 if owner == 100 else 100 if owner == 200 else None
        event_type = (
            "turret_destroy"
            if event.get("buildingType") == "TOWER_BUILDING"
            else "inhibitor_destroy"
        )
        return event_type, event.get("towerType"), actor_team, participant, None
    if kind == "TURRET_PLATE_DESTROYED":
        owner = int(event.get("teamId") or 0)
        return "turret_plate_destroy", None, 200 if owner == 100 else 100, participant, None
    if kind == "ELITE_MONSTER_KILL":
        monster = event.get("monsterType")
        event_type = {
            "DRAGON": "dragon_kill",
            "BARON_NASHOR": "baron_kill",
            "RIFTHERALD": "herald_kill",
            "HORDE": "grub_kill",
        }.get(monster)
        return event_type, event.get("monsterSubType"), event.get("killerTeamId"), participant, None
    mapping = {
        "ITEM_PURCHASED": "item_purchase",
        "ITEM_SOLD": "item_sell",
        "ITEM_DESTROYED": "item_destroy",
        "ITEM_UNDO": "item_undo",
        "WARD_PLACED": "ward_placed",
        "WARD_KILL": "ward_destroyed",
        "SKILL_LEVEL_UP": "skill_level_up",
        "LEVEL_UP": "champion_level_up",
        "CHAMPION_SPECIAL_KILL": "special_kill",
        "GAME_END": "game_end",
    }
    team_id = event.get("winningTeam") if kind == "GAME_END" else event.get("killerTeamId")
    subtype = event.get("killType") if kind == "CHAMPION_SPECIAL_KILL" else None
    return mapping.get(kind), subtype, team_id, participant, None


def _summary(
    match_id: str,
    team: dict[str, Any],
    events: list[dict[str, Any]],
    frames: list[dict[str, Any]],
    patch: str,
    queue: str,
    tier: str,
    region: str,
    duration_s: int,
) -> dict[str, Any]:
    team_id = team["team_id"]
    own = [event for event in events if event["team_id"] == team_id]
    first_blood = next((event for event in events if event["event_type"] == "kill"), None)
    first_tower = next((event for event in events if event["event_type"] == "turret_destroy"), None)
    own_first_tower = next(
        (
            event
            for event in events
            if event["event_type"] == "turret_destroy" and event["team_id"] == team_id
        ),
        None,
    )
    probes = {row["timestamp_ms"] // 60_000: row for row in frames if row["team_id"] == team_id}
    return _row(
        "match_summary",
        match_id=match_id,
        team_id=team_id,
        side=_side(team_id),
        win=team["win"],
        duration_s=duration_s,
        patch=patch,
        queue=queue,
        tier=tier,
        region=region,
        got_first_blood=bool(first_blood and first_blood["team_id"] == team_id),
        first_blood_ms=first_blood["timestamp_ms"]
        if first_blood and first_blood["team_id"] == team_id
        else None,
        first_blood_x_norm=first_blood["x_norm"]
        if first_blood and first_blood["team_id"] == team_id
        else None,
        first_blood_y_norm=first_blood["y_norm"]
        if first_blood and first_blood["team_id"] == team_id
        else None,
        first_blood_region=_region_at(first_blood["x_norm"], first_blood["y_norm"])
        if first_blood and first_blood["team_id"] == team_id
        else None,
        first_blood_killer_role=first_blood["role"]
        if first_blood and first_blood["team_id"] == team_id
        else None,
        got_first_tower=bool(first_tower and first_tower["team_id"] == team_id),
        first_tower_ms=own_first_tower["timestamp_ms"] if own_first_tower else None,
        first_tower_lane=own_first_tower["lane_type"] if own_first_tower else None,
        fb_to_first_tower_ms=(own_first_tower["timestamp_ms"] - first_blood["timestamp_ms"])
        if (
            first_blood
            and own_first_tower
            and first_blood["team_id"] == team_id
            and own_first_tower["timestamp_ms"] >= first_blood["timestamp_ms"]
        )
        else None,
        gold_diff_at_5m=probes.get(5, {}).get("gold_diff"),
        gold_diff_at_10m=probes.get(10, {}).get("gold_diff"),
        gold_diff_at_15m=probes.get(15, {}).get("gold_diff"),
        gold_diff_at_20m=probes.get(20, {}).get("gold_diff"),
        xp_diff_at_10m=probes.get(10, {}).get("xp_diff"),
        kill_diff_at_10m=probes.get(10, {}).get("kill_diff"),
        first_dragon=team["first_dragon"],
        first_dragon_ms=next(
            (event["timestamp_ms"] for event in own if event["event_type"] == "dragon_kill"), None
        ),
        dragon_kills=team["dragon_kills"],
        baron_kills=team["baron_kills"],
        tower_kills=team["tower_kills"],
        total_kills=team["champion_kills"],
    )
