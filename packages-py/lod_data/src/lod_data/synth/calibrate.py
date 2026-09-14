"""Calibration for the synthetic generation model.

Each target is paired with a monotonic control fitted by binary search, with several coordinate
descent rounds for interactions. A fixed seed supplies common random numbers so Monte Carlo noise
does not prevent convergence.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime

import numpy as np

from .engine import measure, simulate
from .params import CALIBRATION_TARGETS, SynthParams

#: Knob to target metric, search range, and direction. Positive direction means increasing the
#: knob increases the metric; negative means it decreases the metric.
KNOBS: dict[str, tuple[str, tuple[float, float], int]] = {
    "blue_bias": ("blue_win_rate", (-0.40, 0.40), +1),
    "beta_fb_base": ("win_rate_given_first_blood", (0.20, 3.00), +1),
    "gold_sigma": ("win_rate_given_gold_lead_1500_at_10m", (250.0, 900.0), -1),
    "lane_signal_spread": ("_fb_lane_gap", (0.20, 3.00), +1),
    "tower_threshold": ("median_fb_to_first_tower_s", (1200.0, 6000.0), +1),
}

#: Lane signal strength is tuned through one spread scalar relative to baseline values.
_LANE_BASE = {"TOP": 1.45, "MID": 1.05, "BOT": 0.75, "JUNGLE": 1.00, "RIVER": 0.90}


def _apply_lane_spread(p: SynthParams, spread: float) -> None:
    p.lane_fb_signal = {k: 1.0 + (v - 1.0) * spread for k, v in _LANE_BASE.items()}


def evaluate(p: SynthParams, n: int, seed: int) -> dict[str, float]:
    m = measure(simulate(n, p, np.random.default_rng(seed)))
    # Top-to-bot first-blood win-rate difference from §40.
    m["_fb_lane_gap"] = m["win_rate_given_fb_top"] - m["win_rate_given_fb_bot"]
    return m


def _set_knob(p: SynthParams, knob: str, value: float) -> None:
    if knob == "lane_signal_spread":
        _apply_lane_spread(p, value)
    else:
        setattr(p, knob, value)


def _bisect(
    p: SynthParams,
    knob: str,
    target: float,
    lo: float,
    hi: float,
    direction: int,
    metric: str,
    evaluate_fn: Callable[[SynthParams], dict[str, float]],
    iterations: int = 11,
) -> float:
    """Binary search under the assumption that a metric responds monotonically to a knob."""
    for _ in range(iterations):
        mid = 0.5 * (lo + hi)
        _set_knob(p, knob, mid)
        value = evaluate_fn(p)[metric]
        if np.isnan(value):
            return mid
        above = value > target
        if (direction > 0 and above) or (direction < 0 and not above):
            hi = mid
        else:
            lo = mid
    final = 0.5 * (lo + hi)
    _set_knob(p, knob, final)
    return final


def calibrate(
    *,
    n: int = 20_000,
    seed: int = 20260913,
    rounds: int = 3,
    start: SynthParams | None = None,
    verbose: bool = True,
) -> tuple[SynthParams, dict[str, float]]:
    p = replace(start or SynthParams())

    # Express the lane differential as the difference between two targets.
    lane_gap_target = (
        CALIBRATION_TARGETS["win_rate_given_fb_top"][0]
        - CALIBRATION_TARGETS["win_rate_given_fb_bot"][0]
    )
    targets = {m: t for m, (t, _) in CALIBRATION_TARGETS.items()}
    targets["_fb_lane_gap"] = lane_gap_target

    def ev(pp: SynthParams) -> dict[str, float]:
        return evaluate(pp, n, seed)

    for r in range(rounds):
        for knob, (metric, (lo, hi), direction) in KNOBS.items():
            if metric not in targets:
                continue
            value = _bisect(p, knob, targets[metric], lo, hi, direction, metric, ev)
            if verbose:
                print(f"  round {r + 1}  {knob:20s} -> {value:.4f}")
        if verbose:
            m = ev(p)
            print(f"  round {r + 1} result: " + report_line(m))

    final = ev(p)
    p.calibration = {
        "calibrated_at": datetime.now(UTC).isoformat(),
        "n": n,
        "seed": seed,
        "rounds": rounds,
        "achieved": {k: round(float(v), 4) for k, v in final.items()},
        "targets": {k: t for k, (t, _) in CALIBRATION_TARGETS.items()},
    }
    return p, final


def report_line(m: dict[str, float]) -> str:
    keys = (
        "blue_win_rate",
        "win_rate_given_first_blood",
        "win_rate_given_fb_top",
        "win_rate_given_fb_bot",
        "win_rate_given_gold_lead_1500_at_10m",
        "win_rate_given_gold_lead_3000_at_10m",
        "median_fb_to_first_tower_s",
    )
    return " ".join(f"{k.replace('win_rate_given_', '')}={m[k]:.3f}" for k in keys)


def check(m: dict[str, float]) -> list[str]:
    """Return metrics outside tolerance; an empty list means success."""
    failures = []
    for metric, (target, tol) in CALIBRATION_TARGETS.items():
        value = m.get(metric)
        if value is None or np.isnan(value):
            failures.append(f"{metric}: unavailable")
        elif abs(value - target) > tol:
            failures.append(f"{metric}: {value:.4f} (target {target:.4f} ± {tol:.3f})")
    return failures
