"""Authoritative Parquet schemas shared by synthetic and Riot ingestion.

All in-game time uses unsigned `timestamp_ms` relative to game start. Raw and normalized
coordinates are both stored, and normalized y retains the game orientation.
"""

from __future__ import annotations

from typing import Final

import pyarrow as pa

from .enums import SCHEMA_VERSION

__all__ = [
    "SCHEMA_VERSION",
    "TABLES",
    "MATCHES",
    "PARTICIPANTS",
    "TEAMS",
    "EVENTS",
    "TIMELINE_PARTICIPANT_FRAMES",
    "TIMELINE_TEAM_FRAMES",
    "MATCH_SUMMARY",
    "PARTITION_KEYS",
    "SORT_KEYS",
    "FRAME_INTERVAL_MS",
    "empty_table",
]

#: Timeline frame interval. Riot emits 60-second frames; changing this also changes the
#: documented resolution of latest-frame-at-or-before probes.
FRAME_INTERVAL_MS: Final = 60_000


def _f(name: str, typ: pa.DataType, doc: str, *, nullable: bool = True) -> pa.Field:
    """Attach documentation as field metadata for catalog and schema tooling."""
    return pa.field(name, typ, nullable=nullable, metadata={"doc": doc})


# --------------------------------------------------------------------------- matches

MATCHES: Final = pa.schema(
    [
        _f(
            "match_id",
            pa.string(),
            "경기 식별자. Riot은 'KR_7123456789', 합성은 'SYN_...'",
            nullable=False,
        ),
        _f("platform_id", pa.string(), "플랫폼 코드 (KR1, NA1)"),
        _f("region", pa.string(), "지역. 파티션 키"),
        _f("queue_id", pa.uint16(), "큐 id. 420=솔로랭크"),
        _f("queue", pa.string(), "큐 이름. 파티션 키"),
        _f("game_version", pa.string(), "원본 버전 문자열 (14.19.624.9803)"),
        _f("patch", pa.string(), "패치 (14.19). game_version에서 파생. 파티션 키"),
        _f("tier", pa.string(), "참가자의 솔로랭크 티어 중앙값. 수집 시점 기준"),
        _f("game_creation_ms", pa.uint64(), "epoch ms. 경기 목록 정렬에만 쓴다"),
        _f("game_start_ms", pa.uint64(), "epoch ms"),
        _f("duration_ms", pa.uint32(), "경기 길이"),
        _f("duration_s", pa.uint32(), "경기 길이(초). 필터가 초 단위로 자주 와서 중복 저장"),
        _f("winning_team", pa.uint16(), "100=블루, 200=레드, 0=무효/리메이크"),
        _f("ended_in_surrender", pa.bool_(), "항복 종료"),
        _f("ended_early_surrender", pa.bool_(), "조기 항복(리메이크). 분석에서 보통 제외한다"),
        _f("map_id", pa.uint8(), "11=소환사의 협곡"),
        _f("data_source", pa.string(), "riot_v5 | synthetic_v1"),
        _f("ingested_at", pa.timestamp("ms"), "적재 시각"),
        _f("schema_version", pa.uint16(), "스키마 진화 추적"),
    ]
)

# ---------------------------------------------------------------------- participants

PARTICIPANTS: Final = pa.schema(
    [
        _f("match_id", pa.string(), "경기 식별자", nullable=False),
        _f("participant_id", pa.uint8(), "1..10", nullable=False),
        _f("team_id", pa.uint16(), "100 | 200", nullable=False),
        _f("side", pa.string(), "BLUE | RED. DSL의 team.blue와 직결"),
        _f("puuid", pa.string(), "합성 데이터는 NULL"),
        _f("riot_id", pa.string(), "Name#TAG"),
        _f("summoner_name", pa.string(), "표시 이름"),
        _f("champion_id", pa.uint16(), "챔피언 id"),
        _f("champion", pa.string(), "챔피언 영문명. DSL이 문자열로 비교한다"),
        _f("role", pa.string(), "정규화된 5값: TOP/JUNGLE/MID/BOT/SUPPORT"),
        _f("role_raw", pa.string(), "Riot 원본 포지션. 정규화가 틀렸을 때 추적용"),
        _f("rank_tier", pa.string(), "수집 시점 솔로랭크 티어"),
        _f("rank_division", pa.string(), "수집 시점 솔로랭크 단계"),
        _f("rank_league_points", pa.uint16(), "수집 시점 리그 포인트"),
        _f("win", pa.bool_(), "승패"),
        _f("kills", pa.uint16(), "킬"),
        _f("deaths", pa.uint16(), "데스"),
        _f("assists", pa.uint16(), "어시스트"),
        _f("gold_earned", pa.uint32(), "획득 골드"),
        _f("gold_spent", pa.uint32(), "소비 골드"),
        _f("total_damage_dealt_to_champions", pa.uint32(), "챔피언 대상 피해량"),
        _f("total_damage_taken", pa.uint32(), "받은 피해량"),
        _f("vision_score", pa.uint16(), "시야 점수"),
        _f("wards_placed", pa.uint16(), "설치한 와드"),
        _f("wards_killed", pa.uint16(), "제거한 와드"),
        _f("champ_level", pa.uint8(), "종료 시 레벨"),
        _f("total_minions_killed", pa.uint16(), "미니언 처치"),
        _f("neutral_minions_killed", pa.uint16(), "정글 몹 처치"),
        _f(
            "items",
            pa.list_(pa.uint32()),
            "종료 시 인벤토리. Swiftplay 변형 아이템 ID를 포함한다",
        ),
        _f("first_blood_kill", pa.bool_(), "Riot 제공 플래그. events 파생 결과 검증용 이중화"),
        _f("first_blood_assist", pa.bool_(), "Riot 제공 플래그"),
        _f("first_tower_kill", pa.bool_(), "Riot 제공 플래그"),
    ]
)

# ----------------------------------------------------------------------------- teams

TEAMS: Final = pa.schema(
    [
        _f("match_id", pa.string(), "경기 식별자", nullable=False),
        _f("team_id", pa.uint16(), "100 | 200", nullable=False),
        _f("side", pa.string(), "BLUE | RED"),
        _f("win", pa.bool_(), "승패"),
        _f("first_blood", pa.bool_(), "퍼스트 블러드 획득"),
        _f("first_tower", pa.bool_(), "첫 포탑 파괴"),
        _f("first_dragon", pa.bool_(), "첫 드래곤 처치"),
        _f("first_baron", pa.bool_(), "첫 바론 처치"),
        _f("first_herald", pa.bool_(), "첫 전령 처치"),
        _f("first_inhibitor", pa.bool_(), "첫 억제기 파괴"),
        _f("tower_kills", pa.uint8(), "파괴한 포탑 수"),
        _f("inhibitor_kills", pa.uint8(), "파괴한 억제기 수"),
        _f("dragon_kills", pa.uint8(), "드래곤 처치 수"),
        _f("baron_kills", pa.uint8(), "바론 처치 수"),
        _f("herald_kills", pa.uint8(), "전령 처치 수"),
        _f("grub_kills", pa.uint8(), "공허충 처치 수"),
        _f("champion_kills", pa.uint16(), "팀 총 킬"),
        _f("deaths", pa.uint16(), "팀 총 데스"),
        _f("assists", pa.uint16(), "팀 총 어시스트"),
        _f("total_gold", pa.uint32(), "팀 총 골드"),
        _f("bans", pa.list_(pa.uint16()), "밴 챔피언"),
    ]
)

# ---------------------------------------------------------------------------- events

EVENTS: Final = pa.schema(
    [
        _f("match_id", pa.string(), "경기 식별자", nullable=False),
        _f(
            "event_id",
            pa.uint32(),
            "경기 내 0부터의 순번. (timestamp_ms, 원본순) 안정 정렬",
            nullable=False,
        ),
        _f("timestamp_ms", pa.uint32(), "게임 시작 기준 밀리초", nullable=False),
        _f("frame_idx", pa.uint16(), "timestamp_ms // 60000. 프레임 조인·버킷팅 가속"),
        _f("event_type", pa.string(), "이벤트 분류 (lod_data.enums.EventType)", nullable=False),
        _f("event_subtype", pa.string(), "OUTER_TURRET, AIR_DRAGON, KILL_FIRST_BLOOD 등"),
        _f(
            "event_origin",
            pa.string(),
            "observed | inferred_rule | synthetic; distinguishes source facts from derived rows",
            nullable=False,
        ),
        _f("team_id", pa.uint16(), "**행위 주체** 팀. Riot의 건물 소유팀 규약과 반대다"),
        _f("participant_id", pa.uint8(), "행위 주체(killer/purchaser/ward placer)"),
        _f("champion_id", pa.uint16(), "주체 챔피언. events 단독 GROUP BY를 위해 비정규화"),
        _f("role", pa.string(), "주체 역할. 같은 이유로 비정규화"),
        _f("victim_id", pa.uint8(), "kill 전용"),
        _f("victim_team_id", pa.uint16(), "kill 전용"),
        _f("victim_champion_id", pa.uint16(), "kill 전용"),
        _f(
            "assist_ids",
            pa.list_(pa.uint8()),
            "어시스트 참가자. 별도 테이블 아님 — v_event_assists가 UNNEST",
        ),
        _f("assist_count", pa.uint8(), "assist_ids 길이. assist_count=0 이 솔로킬"),
        _f("x_raw", pa.int32(), "Riot 원본 좌표. 위치 없는 이벤트는 NULL"),
        _f("y_raw", pa.int32(), "Riot 원본 좌표"),
        _f("x_norm", pa.float32(), "정규 좌표 [0,1]. 영역 판정이 쓰는 공간"),
        _f("y_norm", pa.float32(), "정규 좌표 [0,1]. 게임 방향(y가 위)"),
        _f("has_position", pa.bool_(), "좌표 유효 여부. NULL 필터를 피하기 위한 명시 플래그"),
        _f(
            "item_id",
            pa.uint32(),
            "구매/판매 아이템. 구매 취소에서는 취소 전 아이템; Swiftplay 변형 ID 포함",
        ),
        _f(
            "item_after_id",
            pa.uint32(),
            "구매 취소 후 복원된 아이템 (Riot afterId); Swiftplay 변형 ID 포함",
        ),
        _f("ward_type", pa.string(), "와드 종류"),
        _f("skill_slot", pa.uint8(), "스킬 슬롯"),
        _f("level", pa.uint8(), "레벨업 후 레벨"),
        _f("bounty", pa.uint32(), "현상금"),
        _f("kill_streak_length", pa.uint8(), "연속 처치"),
        _f("building_type", pa.string(), "TOWER_BUILDING | INHIBITOR_BUILDING"),
        _f("tower_type", pa.string(), "OUTER_TURRET | INNER_TURRET | BASE_TURRET | NEXUS_TURRET"),
        _f("lane_type", pa.string(), "TOP_LANE | MID_LANE | BOT_LANE"),
        _f("monster_type", pa.string(), "DRAGON | BARON_NASHOR | RIFTHERALD | HORDE"),
        _f(
            "is_first_of_type",
            pa.bool_(),
            "First kill per match; first other event type per actor team. Teamless events are "
            "scoped per match.",
        ),
    ]
)

# ------------------------------------------------------- timeline_participant_frames

TIMELINE_PARTICIPANT_FRAMES: Final = pa.schema(
    [
        _f("match_id", pa.string(), "경기 식별자", nullable=False),
        _f("frame_idx", pa.uint16(), "프레임 번호 (0,1,2,...)", nullable=False),
        _f("timestamp_ms", pa.uint32(), "frame_idx * 60000", nullable=False),
        _f("participant_id", pa.uint8(), "1..10", nullable=False),
        _f("team_id", pa.uint16(), "100 | 200"),
        _f("side", pa.string(), "BLUE | RED"),
        _f("champion_id", pa.uint16(), "비정규화"),
        _f("role", pa.string(), "비정규화. 라인 상대 매칭에 쓴다"),
        _f("total_gold", pa.uint32(), "누적 획득 골드"),
        _f("current_gold", pa.uint32(), "보유 골드. recall 추론에 쓴다"),
        _f("xp", pa.uint32(), "누적 경험치"),
        _f("level", pa.uint8(), "레벨"),
        _f("minions_killed", pa.uint16(), "미니언 처치"),
        _f("jungle_minions_killed", pa.uint16(), "정글 몹 처치"),
        _f("x_raw", pa.int32(), "원본 좌표"),
        _f("y_raw", pa.int32(), "원본 좌표"),
        _f("x_norm", pa.float32(), "정규 좌표"),
        _f("y_norm", pa.float32(), "정규 좌표"),
        _f("damage_done_to_champions", pa.uint32(), "누적 챔피언 피해량"),
        _f("damage_taken", pa.uint32(), "누적 받은 피해량"),
    ]
)

# -------------------------------------------------------------- timeline_team_frames

TIMELINE_TEAM_FRAMES: Final = pa.schema(
    [
        _f("match_id", pa.string(), "경기 식별자", nullable=False),
        _f("frame_idx", pa.uint16(), "프레임 번호", nullable=False),
        _f("timestamp_ms", pa.uint32(), "frame_idx * 60000", nullable=False),
        _f("team_id", pa.uint16(), "100 | 200", nullable=False),
        _f("side", pa.string(), "BLUE | RED"),
        _f("total_gold", pa.uint32(), "팀 합산 골드"),
        _f("total_xp", pa.uint32(), "팀 합산 경험치"),
        _f("total_level", pa.uint16(), "팀 합산 레벨"),
        _f("total_cs", pa.uint16(), "팀 합산 CS"),
        _f("gold_diff", pa.int32(), "상대 팀 대비 골드 차이. **저장 시점에 계산**"),
        _f("xp_diff", pa.int32(), "상대 팀 대비 경험치 차이"),
        _f("kill_diff", pa.int16(), "해당 프레임까지 누적 킬 차이"),
        _f("alive_towers", pa.uint8(), "남은 포탑 수"),
        _f("dragons_taken", pa.uint8(), "누적 드래곤"),
        _f("barons_taken", pa.uint8(), "누적 바론"),
    ]
)

# --------------------------------------------------------------------- match_summary

MATCH_SUMMARY: Final = pa.schema(
    [
        _f("match_id", pa.string(), "경기 식별자", nullable=False),
        _f("team_id", pa.uint16(), "100 | 200", nullable=False),
        _f("side", pa.string(), "BLUE | RED"),
        _f("win", pa.bool_(), "승패"),
        _f("duration_s", pa.uint32(), "경기 길이(초)"),
        _f("patch", pa.string(), "패치"),
        _f("queue", pa.string(), "큐"),
        _f("tier", pa.string(), "경기 참가자 솔로랭크 티어 중앙값"),
        _f("region", pa.string(), "지역"),
        _f("got_first_blood", pa.bool_(), "이 팀이 퍼스트 블러드를 기록했는가"),
        _f("first_blood_ms", pa.uint32(), "퍼스트 블러드 시각. 없으면 NULL"),
        _f("first_blood_x_norm", pa.float32(), "퍼스트 블러드 위치"),
        _f("first_blood_y_norm", pa.float32(), "퍼스트 블러드 위치"),
        _f("first_blood_region", pa.string(), "내장 영역 사전 태깅 (top_lane 등)"),
        _f("first_blood_killer_role", pa.string(), "퍼스트 블러드 처치자 역할"),
        _f("got_first_tower", pa.bool_(), "이 팀이 첫 포탑을 파괴했는가"),
        _f("first_tower_ms", pa.uint32(), "첫 포탑 파괴 시각"),
        _f("first_tower_lane", pa.string(), "첫 포탑 라인"),
        _f(
            "fb_to_first_tower_ms",
            pa.int32(),
            "퍼스트 블러드 → 이 팀의 첫 포탑 파괴까지. 둘 중 하나라도 없으면 NULL",
        ),
        _f("gold_diff_at_5m", pa.int32(), "5분 골드 차이. 경기가 짧으면 NULL"),
        _f("gold_diff_at_10m", pa.int32(), "10분 골드 차이"),
        _f("gold_diff_at_15m", pa.int32(), "15분 골드 차이"),
        _f("gold_diff_at_20m", pa.int32(), "20분 골드 차이"),
        _f("xp_diff_at_10m", pa.int32(), "10분 경험치 차이"),
        _f("kill_diff_at_10m", pa.int16(), "10분 킬 차이"),
        _f("first_dragon", pa.bool_(), "첫 드래곤 획득"),
        _f("first_dragon_ms", pa.uint32(), "첫 드래곤 시각"),
        _f("dragon_kills", pa.uint8(), "드래곤 처치 수"),
        _f("baron_kills", pa.uint8(), "바론 처치 수"),
        _f("tower_kills", pa.uint8(), "포탑 파괴 수"),
        _f("total_kills", pa.uint16(), "팀 총 킬"),
    ]
)

TABLES: Final[dict[str, pa.Schema]] = {
    "matches": MATCHES,
    "participants": PARTICIPANTS,
    "teams": TEAMS,
    "events": EVENTS,
    "timeline_participant_frames": TIMELINE_PARTICIPANT_FRAMES,
    "timeline_team_frames": TIMELINE_TEAM_FRAMES,
    "match_summary": MATCH_SUMMARY,
}

#: Partition keys ordered by low cardinality and high filter selectivity. Limit depth to three
#: to avoid tiny files whose metadata costs exceed query execution.
PARTITION_KEYS: Final = ("patch", "queue", "region")

#: Sort keys. Leading with match_id co-locates one match in a row group, improving drill-down
#: and temporal-chain locality; leading with time would scatter matches.
SORT_KEYS: Final[dict[str, tuple[str, ...]]] = {
    "matches": ("match_id",),
    "participants": ("match_id", "participant_id"),
    "teams": ("match_id", "team_id"),
    "events": ("match_id", "timestamp_ms", "event_id"),
    "timeline_participant_frames": ("match_id", "frame_idx", "participant_id"),
    "timeline_team_frames": ("match_id", "frame_idx", "team_id"),
    "match_summary": ("match_id", "team_id"),
}


def empty_table(name: str) -> pa.Table:
    """Return an empty table for schema validation and test fixtures."""
    return TABLES[name].empty_table()
