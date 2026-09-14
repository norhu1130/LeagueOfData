"""Python counterpart of the Summoner's Rift coordinate contract in TypeScript.

Constants are verified against TypeScript-generated `data/reference/regions_builtin.json`.
Do not maintain an independent second definition.
"""

from __future__ import annotations

from typing import NamedTuple

# These values must match TypeScript; `load_reference()` verifies the generated artifact.
MAP_MIN: float = -120.0
MAP_SPAN: float = 15000.0


class NormPoint(NamedTuple):
    x_norm: float
    y_norm: float


class GamePoint(NamedTuple):
    x: float
    y: float


def to_norm(x: float, y: float) -> NormPoint:
    """Convert game to normalized coordinates without clamping data-quality failures."""
    return NormPoint((x - MAP_MIN) / MAP_SPAN, (y - MAP_MIN) / MAP_SPAN)


def from_norm(x_norm: float, y_norm: float) -> GamePoint:
    return GamePoint(x_norm * MAP_SPAN + MAP_MIN, y_norm * MAP_SPAN + MAP_MIN)


def radius_to_norm(radius_game_units: float) -> float:
    """Convert a game-unit radius to axis-independent normalized units."""
    return radius_game_units / MAP_SPAN


def radius_from_norm(radius_norm: float) -> float:
    return radius_norm * MAP_SPAN


def is_in_map_bounds(x_norm: float, y_norm: float, epsilon: float = 1e-3) -> bool:
    return -epsilon <= x_norm <= 1 + epsilon and -epsilon <= y_norm <= 1 + epsilon


# SQL fragments used by the compiler to normalize raw coordinates.
def norm_sql(raw_col: str) -> str:
    return f"(({raw_col}) - ({MAP_MIN})) / {MAP_SPAN}"
