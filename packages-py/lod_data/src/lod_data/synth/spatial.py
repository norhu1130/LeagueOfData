"""Spatial sampling that places events along lane terrain.

Samples should visibly form three lane branches and jungle clusters. A uniform distribution would
make custom-region analyses meaningless. Coordinates use normalized game orientation.
"""

from __future__ import annotations

import numpy as np

from ..coords import MAP_SPAN

#: Lane centerlines oriented from blue base to red base.
LANE_PATHS: dict[str, list[tuple[float, float]]] = {
    "TOP": [
        (0.09, 0.11),
        (0.07, 0.36),
        (0.08, 0.63),
        (0.13, 0.82),
        (0.28, 0.88),
        (0.52, 0.90),
        (0.75, 0.91),
        (0.88, 0.87),
    ],
    "MID": [
        (0.14, 0.13),
        (0.28, 0.28),
        (0.42, 0.43),
        (0.50, 0.50),
        (0.58, 0.58),
        (0.72, 0.72),
        (0.86, 0.86),
    ],
    "BOT": [
        (0.11, 0.09),
        (0.35, 0.07),
        (0.60, 0.08),
        (0.80, 0.11),
        (0.89, 0.25),
        (0.91, 0.48),
        (0.90, 0.72),
        (0.87, 0.88),
    ],
    "RIVER": [
        (0.22, 0.74),
        (0.36, 0.62),
        (0.50, 0.50),
        (0.64, 0.38),
        (0.78, 0.26),
    ],
}

#: Approximate jungle camp positions; red jungle uses 180-degree rotational symmetry.
JUNGLE_BLUE: list[tuple[float, float]] = [
    (0.22, 0.30),
    (0.32, 0.22),
    (0.28, 0.45),
    (0.40, 0.36),
    (0.18, 0.55),
    (0.45, 0.60),
]
JUNGLE_RED: list[tuple[float, float]] = [(1.0 - x, 1.0 - y) for x, y in JUNGLE_BLUE]

#: Late-game fight clusters around pits and mid-lane engagements.
LATE_HOTSPOTS: list[tuple[float, float]] = [
    (0.338, 0.701),  # Baron pit
    (0.666, 0.302),  # Dragon pit
    (0.50, 0.50),  # Mid lane
    (0.30, 0.30),
    (0.70, 0.70),  # Inhibitor approach
]

#: Perpendicular path jitter in game units, approximating lane width.
SIGMA_PERP_UNITS = 380.0
#: Along-path jitter.
SIGMA_ALONG_UNITS = 550.0
SIGMA_JUNGLE_UNITS = 700.0
SIGMA_HOTSPOT_UNITS = 1100.0

_PERP = SIGMA_PERP_UNITS / MAP_SPAN
_ALONG = SIGMA_ALONG_UNITS / MAP_SPAN
_JUNGLE = SIGMA_JUNGLE_UNITS / MAP_SPAN
_HOTSPOT = SIGMA_HOTSPOT_UNITS / MAP_SPAN


#: Margin used when clipping inside map bounds to avoid implementation-dependent edge points.
_EDGE = 0.002


def _in_bounds(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Clip generated coordinates inside map bounds.

    This applies only to generated data. Riot ingestion treats out-of-range coordinates as a
    quality signal and marks them as missing rather than silently clamping them.
    """
    return np.clip(x, _EDGE, 1.0 - _EDGE), np.clip(y, _EDGE, 1.0 - _EDGE)


def _interp_path(
    path: list[tuple[float, float]], s: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Interpolate a polyline by arc length and return unit tangents."""
    pts = np.asarray(path, dtype=np.float64)
    seg = np.diff(pts, axis=0)
    seg_len = np.hypot(seg[:, 0], seg[:, 1])
    cum = np.concatenate([[0.0], np.cumsum(seg_len)])
    total = cum[-1]

    target = np.clip(s, 0.0, 1.0) * total
    idx = np.clip(np.searchsorted(cum, target, side="right") - 1, 0, len(seg) - 1)
    local = (target - cum[idx]) / np.maximum(seg_len[idx], 1e-12)

    x = pts[idx, 0] + seg[idx, 0] * local
    y = pts[idx, 1] + seg[idx, 1] * local
    tx = seg[idx, 0] / np.maximum(seg_len[idx], 1e-12)
    ty = seg[idx, 1] / np.maximum(seg_len[idx], 1e-12)
    return x, y, tx, ty


def sample_on_lane(
    lane: str, n: int, rng: np.random.Generator, *, early: bool = False
) -> tuple[np.ndarray, np.ndarray]:
    """Sample `n` coordinates around a lane path.

    `early=True` biases samples toward the allied side for invades and early lane fights.
    """
    path = LANE_PATHS[lane]
    s = rng.beta(1.6, 3.0, size=n) if early else rng.beta(2.2, 2.2, size=n)
    x, y, tx, ty = _interp_path(path, s)

    perp = rng.normal(0.0, _PERP, size=n)
    along = rng.normal(0.0, _ALONG, size=n)
    # The normal to tangent `(tx, ty)` is `(-ty, tx)`.
    x = x + (-ty) * perp + tx * along
    y = y + tx * perp + ty * along
    return _in_bounds(x, y)


def sample_in_jungle(
    n: int, rng: np.random.Generator, *, blue_side: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """Sample coordinates around jungle camps."""
    if blue_side is None:
        blue_side = rng.random(n) < 0.5
    camps_b = np.asarray(JUNGLE_BLUE)
    camps_r = np.asarray(JUNGLE_RED)
    pick = rng.integers(0, len(camps_b), size=n)
    base = np.where(blue_side[:, None], camps_b[pick], camps_r[pick])
    jitter = rng.normal(0.0, _JUNGLE, size=(n, 2))
    out = base + jitter
    return _in_bounds(out[:, 0], out[:, 1])


def sample_late_fight(n: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Sample coordinates around late-game fight clusters."""
    spots = np.asarray(LATE_HOTSPOTS)
    pick = rng.integers(0, len(spots), size=n)
    base = spots[pick]
    jitter = rng.normal(0.0, _HOTSPOT, size=(n, 2))
    out = base + jitter
    return _in_bounds(out[:, 0], out[:, 1])


def sample_kill_positions(
    times_s: np.ndarray, rng: np.random.Generator
) -> tuple[np.ndarray, np.ndarray]:
    """Sample kill positions from a game-phase-dependent distribution.

    Distribution shifts from lanes early, to river/objectives mid game, and fight clusters late.
    """
    n = len(times_s)
    x = np.empty(n)
    y = np.empty(n)
    if n == 0:
        return x, y

    minutes = times_s / 60.0
    early = minutes < 14.0
    mid = (minutes >= 14.0) & (minutes < 22.0)
    late = minutes >= 22.0

    lane_choices = ("TOP", "MID", "BOT")
    lane_p = np.array([0.28, 0.36, 0.36])

    idx = np.flatnonzero(early)
    if idx.size:
        lanes = rng.choice(len(lane_choices), size=idx.size, p=lane_p)
        for li, lane in enumerate(lane_choices):
            sel = idx[lanes == li]
            if sel.size:
                x[sel], y[sel] = sample_on_lane(lane, sel.size, rng, early=True)

    idx = np.flatnonzero(mid)
    if idx.size:
        # Mid game: half in river and the rest across lanes and jungle.
        kind = rng.random(idx.size)
        river = idx[kind < 0.45]
        jungle = idx[(kind >= 0.45) & (kind < 0.70)]
        lanes_idx = idx[kind >= 0.70]
        if river.size:
            x[river], y[river] = sample_on_lane("RIVER", river.size, rng)
        if jungle.size:
            x[jungle], y[jungle] = sample_in_jungle(jungle.size, rng)
        if lanes_idx.size:
            lanes = rng.choice(len(lane_choices), size=lanes_idx.size, p=lane_p)
            for li, lane in enumerate(lane_choices):
                sel = lanes_idx[lanes == li]
                if sel.size:
                    x[sel], y[sel] = sample_on_lane(lane, sel.size, rng)

    idx = np.flatnonzero(late)
    if idx.size:
        x[idx], y[idx] = sample_late_fight(idx.size, rng)

    return x, y


def sample_first_blood_position(
    lane_names: np.ndarray, times_s: np.ndarray, rng: np.random.Generator
) -> tuple[np.ndarray, np.ndarray]:
    """Sample first-blood positions for a preselected lane/jungle/river context."""
    n = len(lane_names)
    x = np.empty(n)
    y = np.empty(n)
    early = times_s < 180.0

    for lane in ("TOP", "MID", "BOT", "RIVER"):
        sel = np.flatnonzero(lane_names == lane)
        if sel.size == 0:
            continue
        # Early first blood clusters near invade and lane-entry portions of paths.
        e = sel[early[sel]]
        late = sel[~early[sel]]
        if e.size:
            x[e], y[e] = sample_on_lane(lane, e.size, rng, early=True)
        if late.size:
            x[late], y[late] = sample_on_lane(lane, late.size, rng)

    sel = np.flatnonzero(lane_names == "JUNGLE")
    if sel.size:
        x[sel], y[sel] = sample_in_jungle(sel.size, rng)

    return x, y


def sample_lane_position(
    lane: str, n: int, rng: np.random.Generator
) -> tuple[np.ndarray, np.ndarray]:
    """Sample arbitrary lane positions for participant frames."""
    return sample_on_lane(lane, n, rng)
