"""Vectorized stochastic-process core for synthetic matches.

Calibration and full generation share this implementation to prevent model drift. Resolution is
one minute, matching timeline frames; second-level event times are sampled within each minute.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..enums import LANES, TOWER_TIER_ORDER
from .params import SynthParams, sigmoid

MAX_MINUTES = 49


@dataclass(slots=True)
class MatchPaths:
    """Generated time series and event lists, represented as `[n_matches, ...]` arrays."""

    delta: np.ndarray  # [n] latent blue-side skill advantage
    duration_min: np.ndarray  # [n] integer minutes
    gold_diff: np.ndarray  # [n, MAX_MINUTES] blue minus red at minute boundaries
    xp_diff: np.ndarray  # [n, MAX_MINUTES]
    kill_diff: np.ndarray  # [n, MAX_MINUTES] cumulative kill difference
    blue_kills_per_min: np.ndarray  # [n, MAX_MINUTES] integers
    red_kills_per_min: np.ndarray  # [n, MAX_MINUTES]
    blue_win: np.ndarray  # [n] bool

    # First blood
    fb_occurred: np.ndarray  # [n] bool
    fb_blue: np.ndarray  # [n] bool indicating whether blue took first blood
    fb_time_s: np.ndarray  # [n] float
    fb_lane_idx: np.ndarray  # [n] index into FB_LANES
    fb_solo: np.ndarray  # [n] bool

    # Turrets: variable-length destruction events per match
    tower_events: list[list[tuple[float, str, str, bool]]]  # (seconds, lane, tier, blue_destroyed)
    plate_events: list[list[tuple[float, str, bool]]]  # (seconds, lane, blue_destroyed)

    # Objectives: (seconds, blue_took, subtype)
    dragon_events: list[list[tuple[float, bool, str]]]
    herald_events: list[list[tuple[float, bool]]]
    baron_events: list[list[tuple[float, bool]]]
    grub_events: list[list[tuple[float, bool]]]


#: First-blood contexts: three lanes, jungle, and river.
FB_LANES = ("TOP", "MID", "BOT", "JUNGLE", "RIVER")

_DRAGON_SUBTYPES = (
    "FIRE_DRAGON",
    "AIR_DRAGON",
    "EARTH_DRAGON",
    "WATER_DRAGON",
    "HEXTECH_DRAGON",
    "CHEMTECH_DRAGON",
    "ELDER_DRAGON",
)


def _kill_rate(minute: int, p: SynthParams) -> float:
    if minute < 14:
        return p.kill_rate_early
    if minute < 22:
        return p.kill_rate_mid
    return p.kill_rate_late


def simulate(n: int, p: SynthParams, rng: np.random.Generator) -> MatchPaths:
    """Simulate stochastic processes for `n` matches."""
    delta = rng.normal(0.0, 1.0, size=n)

    gold_diff = np.zeros((n, MAX_MINUTES), dtype=np.float64)
    xp_diff = np.zeros((n, MAX_MINUTES), dtype=np.float64)
    kill_diff = np.zeros((n, MAX_MINUTES), dtype=np.int32)
    blue_kills = np.zeros((n, MAX_MINUTES), dtype=np.int32)
    red_kills = np.zeros((n, MAX_MINUTES), dtype=np.int32)

    alive = np.ones(n, dtype=bool)
    duration = np.full(n, MAX_MINUTES - 1, dtype=np.int32)

    tower_events: list[list[tuple[float, str, str, bool]]] = [[] for _ in range(n)]
    plate_events: list[list[tuple[float, str, bool]]] = [[] for _ in range(n)]
    dragon_events: list[list[tuple[float, bool, str]]] = [[] for _ in range(n)]
    herald_events: list[list[tuple[float, bool]]] = [[] for _ in range(n)]
    baron_events: list[list[tuple[float, bool]]] = [[] for _ in range(n)]
    grub_events: list[list[tuple[float, bool]]] = [[] for _ in range(n)]

    # Cumulative lane pressure and next destroyed tier by team.
    lane_names = [lane.value for lane in LANES]
    pressure = {(lane, blue): np.zeros(n) for lane in lane_names for blue in (True, False)}
    tier_idx = {
        (lane, blue): np.zeros(n, dtype=np.int8) for lane in lane_names for blue in (True, False)
    }
    plates_left = {
        (lane, blue): np.full(n, 5, dtype=np.int8) for lane in lane_names for blue in (True, False)
    }

    next_dragon = np.full(n, p.dragon_first_spawn_s)
    next_herald = np.full(n, p.herald_first_spawn_s)
    next_baron = np.full(n, p.baron_first_spawn_s)
    next_grub = np.full(n, p.grub_first_spawn_s)
    pending_take = {
        "dragon": np.full(n, np.inf),
        "herald": np.full(n, np.inf),
        "baron": np.full(n, np.inf),
        "grub": np.full(n, np.inf),
    }
    dragon_count = np.zeros(n, dtype=np.int32)

    d = np.zeros(n)  # Current gold difference.

    for minute in range(1, MAX_MINUTES):
        t_start_s = (minute - 1) * 60.0
        act = alive.copy()
        if not act.any():
            break

        # --- Kills: per-minute Poisson; ownership depends on delta and current lead ---
        rate = _kill_rate(minute - 1, p)
        total_kills = rng.poisson(rate * 2.0, size=n) * act
        p_blue_kill = sigmoid(p.beta_kill * delta + p.gamma_kill * d / 1500.0)
        bk = rng.binomial(total_kills, np.clip(p_blue_kill, 0.001, 0.999))
        rk = total_kills - bk
        blue_kills[:, minute] = bk
        red_kills[:, minute] = rk

        # --- Objectives: taken after spawn and contest delay -----------------
        now_s = minute * 60.0
        p_blue_obj = sigmoid(p.beta_obj * delta + p.gamma_obj * d / 1500.0)

        obj_shock = np.zeros(n)
        for kind, next_at, respawn, delay_mean, shock, despawn in (
            (
                "dragon",
                next_dragon,
                p.dragon_respawn_s,
                p.dragon_contest_delay_mean_s,
                p.shock_dragon,
                None,
            ),
            (
                "herald",
                next_herald,
                p.herald_respawn_s,
                p.herald_contest_delay_mean_s,
                p.shock_herald,
                p.herald_despawn_s,
            ),
            (
                "baron",
                next_baron,
                p.baron_respawn_s,
                p.baron_contest_delay_mean_s,
                p.shock_baron,
                None,
            ),
            ("grub", next_grub, p.grub_respawn_s, 60.0, 0.0, 900.0),
        ):
            take_at = pending_take[kind]
            newly_available = act & np.isinf(take_at) & (next_at <= now_s)
            if despawn is not None:
                newly_available &= next_at < despawn
            available_idx = np.flatnonzero(newly_available)
            if available_idx.size:
                take_at[available_idx] = next_at[available_idx] + rng.exponential(
                    delay_mean, size=available_idx.size
                )
                if despawn is not None:
                    expired = available_idx[take_at[available_idx] >= despawn]
                    take_at[expired] = np.inf
                    next_at[expired] = np.inf

            due = act & np.isfinite(take_at) & (take_at <= now_s)
            idx = np.flatnonzero(due)
            if idx.size == 0:
                continue
            taken_s = take_at[idx].copy()
            blue_took = rng.random(idx.size) < p_blue_obj[idx]
            sign = np.where(blue_took, 1.0, -1.0)
            obj_shock[idx] += sign * shock

            for k, i in enumerate(idx):
                ts = float(taken_s[k])
                bt = bool(blue_took[k])
                if kind == "dragon":
                    # Preserve an explicit unknown bucket so the UI's forward-compatible
                    # "other dragon" filter is exercised by generated datasets too.
                    sub = (
                        "UNKNOWN_DRAGON"
                        if i % 29 == 0 and dragon_count[i] == 0
                        else _DRAGON_SUBTYPES[int(dragon_count[i]) % len(_DRAGON_SUBTYPES)]
                    )
                    dragon_events[i].append((ts, bt, sub))
                    dragon_count[i] += 1
                elif kind == "herald":
                    herald_events[i].append((ts, bt))
                elif kind == "baron":
                    baron_events[i].append((ts, bt))
                else:
                    grub_events[i].append((ts, bt))
            next_at[idx] = taken_s + respawn if respawn > 0 else np.inf
            take_at[idx] = np.inf

        # --- Turret plates: available before 14 minutes and possible at zero lead ---
        plate_shock = np.zeros(n)
        if now_s <= p.plate_despawn_s:
            for lane in lane_names:
                w = p.tower_lane_weight[lane]
                for blue_breaks in (True, False):
                    sign = 1.0 if blue_breaks else -1.0
                    prob = np.clip((p.plate_base + p.plate_gain * sign * d / 1500.0) * w, 0.0, 0.55)
                    key = (lane, not blue_breaks)  # The opposing team's plate is destroyed.
                    hit = act & (plates_left[key] > 0) & (rng.random(n) < prob)
                    idx = np.flatnonzero(hit)
                    if idx.size == 0:
                        continue
                    plates_left[key][idx] -= 1
                    plate_shock[idx] += sign * p.shock_plate
                    for i in idx:
                        plate_events[i].append(
                            (t_start_s + float(rng.random()) * 60.0, lane, blue_breaks)
                        )

        # --- Turrets: destroy the next tier after team pressure crosses threshold ---
        tower_shock = np.zeros(n)
        for lane in lane_names:
            w = p.tower_lane_weight[lane]
            for blue_destroys in (True, False):
                key = (lane, blue_destroys)
                sign = 1.0 if blue_destroys else -1.0
                push = (p.tower_base_push + p.tower_pressure_gain * sign * d) * w + rng.normal(
                    0.0, p.tower_noise_sigma, size=n
                )
                pressure[key] += np.maximum(push, 0.0) * act

                ready = (
                    act
                    & (pressure[key] >= p.tower_threshold)
                    & (tier_idx[key] < len(TOWER_TIER_ORDER))
                )
                idx = np.flatnonzero(ready)
                if idx.size == 0:
                    continue
                pressure[key][idx] -= p.tower_threshold
                tower_shock[idx] += sign * p.shock_tower
                for i in idx:
                    tier = TOWER_TIER_ORDER[int(tier_idx[key][i])]
                    tower_events[i].append(
                        (t_start_s + float(rng.random()) * 60.0, lane, tier.value, blue_destroys)
                    )
                    tier_idx[key][i] += 1

        # --- One gold SDE step (dt = 1 minute) -------------------------------
        # Event gold value grows later through bounties and larger fights.
        time_scale = 1.0 + (minute - 1) / p.gold_scale_time_min
        kill_shock = (bk - rk) * p.shock_kill * time_scale
        # Revert toward the skill-justified equilibrium and apply snowball only above threshold.
        d_star = p.gold_equilibrium_per_delta * delta
        excess = np.maximum(np.abs(d) - p.snowball_threshold, 0.0) * np.sign(d)
        drift = p.gold_reversion * (d_star - d) + p.snowball_gain * excess
        noise = rng.normal(0.0, p.gold_sigma * time_scale, size=n)
        d = d + (drift + noise) * act + (kill_shock + obj_shock + tower_shock + plate_shock) * act

        gold_diff[:, minute] = np.where(act, d, gold_diff[:, minute - 1])
        xp_diff[:, minute] = np.where(
            act, 0.62 * d + rng.normal(0.0, 400.0, size=n), xp_diff[:, minute - 1]
        )
        kill_diff[:, minute] = kill_diff[:, minute - 1] + (bk - rk)

        # --- End hazard rises sharply with absolute lead --------------------
        if minute >= p.min_duration_min:
            # A ramp prevents an artificial spike at the minimum duration.
            ramp = np.clip(
                (minute - p.hazard_ramp_start_min)
                / max(p.hazard_ramp_end_min - p.hazard_ramp_start_min, 1e-9),
                0.0,
                1.0,
            )
            h = p.hazard_base * ramp * np.exp(np.abs(d) / p.hazard_gold_scale)
            ends = act & (rng.random(n) < np.clip(h, 0.0, 0.95))
            if minute >= p.max_duration_min:
                ends = act.copy()
            duration[ends] = minute
            alive &= ~ends

    duration = np.clip(duration, int(p.min_duration_min), MAX_MINUTES - 1)

    # --- Outcome as a function of delta and final gold difference -----------
    final_gold = gold_diff[np.arange(n), duration]
    p_blue_win = sigmoid(p.beta_win * delta + p.gamma_gold * final_gold / 2000.0 + p.blue_bias)
    blue_win = rng.random(n) < p_blue_win

    # --- First blood ---------------------------------------------------------
    lane_keys = list(FB_LANES)
    prior = np.array([p.lane_fb_prior[k] for k in lane_keys], dtype=np.float64)
    prior = prior / prior.sum()
    fb_lane_idx = rng.choice(len(lane_keys), size=n, p=prior)

    signal = np.array([p.lane_fb_signal[k] for k in lane_keys])[fb_lane_idx]
    p_blue_fb = sigmoid(p.beta_fb_base * signal * delta)
    fb_blue = rng.random(n) < p_blue_fb

    fb_time_s = rng.lognormal(np.log(p.fb_time_median_s), p.fb_time_sigma, size=n)
    # First blood cannot occur after match end.
    fb_occurred = fb_time_s < duration * 60.0
    fb_time_s = np.minimum(fb_time_s, duration * 60.0 - 5.0)

    solo_p = np.array([p.lane_solo_prob[k] for k in lane_keys])[fb_lane_idx]
    fb_solo = rng.random(n) < solo_p

    return MatchPaths(
        delta=delta,
        duration_min=duration,
        gold_diff=gold_diff,
        xp_diff=xp_diff,
        kill_diff=kill_diff,
        blue_kills_per_min=blue_kills,
        red_kills_per_min=red_kills,
        blue_win=blue_win,
        fb_occurred=fb_occurred,
        fb_blue=fb_blue,
        fb_time_s=fb_time_s,
        fb_lane_idx=fb_lane_idx,
        fb_solo=fb_solo,
        tower_events=tower_events,
        plate_events=plate_events,
        dragon_events=dragon_events,
        herald_events=herald_events,
        baron_events=baron_events,
        grub_events=grub_events,
    )


def measure(paths: MatchPaths) -> dict[str, float]:
    """Measure calibration targets from generated output.

    Definitions must match the Parquet measurements in `validate.py`.
    """
    win = paths.blue_win
    n = len(win)
    fb_any = paths.fb_occurred

    lane_of = np.array(FB_LANES)[paths.fb_lane_idx]
    gd10 = paths.gold_diff[:, 10]
    long_enough = paths.duration_min >= 10

    def rate(mask: np.ndarray, outcome: np.ndarray) -> float:
        m = int(mask.sum())
        return float(outcome[mask].mean()) if m else float("nan")

    # Team-grain first-blood win rate combines blue wins after blue FB and red wins after red FB.
    fb_team_win = np.where(paths.fb_blue, win, ~win)
    fb_to_tower: list[float] = []
    for index, events in enumerate(paths.tower_events):
        first = [time_s for time_s, _lane, _tier, blue in events if blue == paths.fb_blue[index]]
        if first:
            gap = min(first) - float(paths.fb_time_s[index])
            if gap > 0:
                fb_to_tower.append(gap)

    return {
        "blue_win_rate": float(win.mean()),
        "first_blood_rate": float(fb_any.mean()),
        "win_rate_given_first_blood": rate(fb_any, fb_team_win),
        "win_rate_given_fb_top": rate(fb_any & (lane_of == "TOP"), fb_team_win),
        "win_rate_given_fb_mid": rate(fb_any & (lane_of == "MID"), fb_team_win),
        "win_rate_given_fb_bot": rate(fb_any & (lane_of == "BOT"), fb_team_win),
        "win_rate_given_gold_lead_1500_at_10m": rate(long_enough & (gd10 >= 1500), win),
        "win_rate_given_gold_lead_3000_at_10m": rate(long_enough & (gd10 >= 3000), win),
        "median_duration_min": float(np.median(paths.duration_min)),
        "median_fb_to_first_tower_s": float(np.median(fb_to_tower))
        if fb_to_tower
        else float("nan"),
        "mean_gold_diff_abs_10m": float(np.abs(gd10[long_enough]).mean()),
        "n": float(n),
    }
