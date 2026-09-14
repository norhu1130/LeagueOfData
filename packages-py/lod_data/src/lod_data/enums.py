"""Event categories and domain enumerations shared by physical data contracts."""

from __future__ import annotations

from enum import StrEnum
from typing import Final


class Team(StrEnum):
    BLUE = "BLUE"
    RED = "RED"


TEAM_ID_BLUE: Final = 100
TEAM_ID_RED: Final = 200
TEAM_IDS: Final = (TEAM_ID_BLUE, TEAM_ID_RED)


def other_team_id(team_id: int) -> int:
    return TEAM_ID_RED if team_id == TEAM_ID_BLUE else TEAM_ID_BLUE


def side_of(team_id: int) -> str:
    return Team.BLUE if team_id == TEAM_ID_BLUE else Team.RED


class Role(StrEnum):
    """Five normalized roles; unstable Riot source values remain separately in `role_raw`."""

    TOP = "TOP"
    JUNGLE = "JUNGLE"
    MID = "MID"
    BOT = "BOT"
    SUPPORT = "SUPPORT"


ROLES: Final = tuple(Role)


class EventType(StrEnum):
    """Physically stored event types.

    Death, assist, and first blood are views over kills to avoid row duplication.
    """

    KILL = "kill"
    SPECIAL_KILL = "special_kill"

    RECALL = "recall"
    ITEM_PURCHASE = "item_purchase"
    ITEM_SELL = "item_sell"
    ITEM_DESTROY = "item_destroy"
    ITEM_UNDO = "item_undo"

    TURRET_DESTROY = "turret_destroy"
    TURRET_PLATE_DESTROY = "turret_plate_destroy"
    INHIBITOR_DESTROY = "inhibitor_destroy"

    DRAGON_SPAWN = "dragon_spawn"
    DRAGON_KILL = "dragon_kill"
    HERALD_SPAWN = "herald_spawn"
    HERALD_KILL = "herald_kill"
    BARON_SPAWN = "baron_spawn"
    BARON_KILL = "baron_kill"
    GRUB_SPAWN = "grub_spawn"
    GRUB_KILL = "grub_kill"

    WARD_PLACED = "ward_placed"
    WARD_DESTROYED = "ward_destroyed"

    CHAMPION_LEVEL_UP = "champion_level_up"
    SKILL_LEVEL_UP = "skill_level_up"

    DRAGON_SOUL_GIVEN = "dragon_soul_given"
    OBJECTIVE_BOUNTY_PRESTART = "objective_bounty_prestart"
    GAME_END = "game_end"


EVENT_TYPES: Final = tuple(EventType)


def first_event_scope(event_type: str, team_id: int | None) -> tuple[str, int | None]:
    """Return the compatibility scope represented by `events.is_first_of_type`.

    Kills are global because their first row is first blood. Actor-owned event types are scoped to
    a team; teamless events such as inferred spawns are global.
    """
    return event_type, None if event_type == EventType.KILL or team_id is None else team_id


#: Events with positions. Other events use null coordinates and `has_position=False`.
#: Wards are excluded because Riot does not provide their coordinates.
POSITIONAL_EVENT_TYPES: Final = frozenset(
    {
        EventType.KILL,
        EventType.SPECIAL_KILL,
        EventType.TURRET_DESTROY,
        EventType.TURRET_PLATE_DESTROY,
        EventType.INHIBITOR_DESTROY,
        EventType.DRAGON_SPAWN,
        EventType.DRAGON_KILL,
        EventType.HERALD_SPAWN,
        EventType.HERALD_KILL,
        EventType.BARON_SPAWN,
        EventType.BARON_KILL,
        EventType.GRUB_SPAWN,
        EventType.GRUB_KILL,
    }
)


class TowerTier(StrEnum):
    OUTER = "OUTER_TURRET"
    INNER = "INNER_TURRET"
    BASE = "BASE_TURRET"
    NEXUS = "NEXUS_TURRET"


#: Destruction order; inner turrets cannot fall before outer turrets.
TOWER_TIER_ORDER: Final = (TowerTier.OUTER, TowerTier.INNER, TowerTier.BASE)


class Lane(StrEnum):
    TOP = "TOP_LANE"
    MID = "MID_LANE"
    BOT = "BOT_LANE"


LANES: Final = tuple(Lane)

#: Role-to-primary-lane mapping; jungle has no lane.
ROLE_LANE: Final = {
    Role.TOP: Lane.TOP,
    Role.MID: Lane.MID,
    Role.BOT: Lane.BOT,
    Role.SUPPORT: Lane.BOT,
}


class MonsterType(StrEnum):
    DRAGON = "DRAGON"
    BARON = "BARON_NASHOR"
    HERALD = "RIFTHERALD"
    GRUB = "HORDE"


DRAGON_SUBTYPES: Final = (
    "FIRE_DRAGON",
    "AIR_DRAGON",
    "EARTH_DRAGON",
    "WATER_DRAGON",
    "HEXTECH_DRAGON",
    "CHEMTECH_DRAGON",
    "ELDER_DRAGON",
)

WARD_TYPES: Final = ("YELLOW_TRINKET", "CONTROL_WARD", "SIGHT_WARD", "BLUE_TRINKET")


class DataSource(StrEnum):
    RIOT_V5 = "riot_v5"
    SYNTHETIC = "synthetic_v1"


class EventOrigin(StrEnum):
    """How an event row entered the canonical timeline."""

    OBSERVED = "observed"
    INFERRED_RULE = "inferred_rule"
    SYNTHETIC = "synthetic"


#: Schema evolution marker; increment and document migrations for column changes.
SCHEMA_VERSION: Final = 5
