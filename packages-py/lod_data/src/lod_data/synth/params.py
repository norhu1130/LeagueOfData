"""Parameters for the synthetic generation model.

Calibration fits these values against target metrics. A latent team-strength variable is the
shared cause of first blood, gold progression, objectives, and victory, preventing intersections
from collapsing to hard-coded rates and demonstrating that association is not causation.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

PARAMS_PATH = Path(__file__).with_name("params.json")


def sigmoid(x: np.ndarray | float) -> np.ndarray | float:
    return 1.0 / (1.0 + np.exp(-np.asarray(x, dtype=np.float64)))


@dataclass(slots=True)
class SynthParams:
    """Generation parameters; field comments document units."""

    # --- First blood ---------------------------------------------------------
    #: P(blue first blood) = sigmoid(beta_fb_base * lane_signal * delta)
    beta_fb_base: float = 1.10
    #: Signal strength by lane. Top first blood more often reflects a solo skill difference,
    #: while bot-lane 2v2 fights contain more noise; this creates the §40 lane differential.
    lane_fb_signal: dict[str, float] = field(
        default_factory=lambda: {
            "TOP": 1.45,
            "MID": 1.05,
            "BOT": 0.75,
            "JUNGLE": 1.00,
            "RIVER": 0.90,
        }
    )
    #: Prior distribution of first-blood locations; bot is highest because it is a 2v2 lane.
    lane_fb_prior: dict[str, float] = field(
        default_factory=lambda: {
            "TOP": 0.17,
            "MID": 0.26,
            "BOT": 0.30,
            "JUNGLE": 0.19,
            "RIVER": 0.08,
        }
    )
    #: Solo-kill probability by lane; `assist_count=0` denotes a solo kill.
    lane_solo_prob: dict[str, float] = field(
        default_factory=lambda: {
            "TOP": 0.75,
            "MID": 0.60,
            "BOT": 0.25,
            "JUNGLE": 0.50,
            "RIVER": 0.45,
        }
    )
    #: First-blood time distribution, log-normal in seconds.
    fb_time_median_s: float = 205.0
    fb_time_sigma: float = 0.62

    # --- Gold curve (minute-scale SDE) ---------------------------------------
    #: Gold difference mean-reverts toward the level justified by skill difference:
    #:
    #:   dD = theta * (D* - D) dt + sigma(t) dW + event shocks, D* = equilibrium * delta
    #:
    #: Mean reversion removes transient leads; equilibrium retains the persistent skill component.
    gold_reversion: float = 0.11  # theta, per minute
    gold_equilibrium_per_delta: float = 250.0  # D* = this value * delta
    gold_sigma: float = 500.0  # gold/sqrt(minute), scaled over game time below
    #: Event gold value grows later through bounties and larger team fights.
    gold_scale_time_min: float = 14.0
    #: Snowball feedback applies only beyond the threshold, creating stomps and an S-shaped rate.
    snowball_threshold: float = 2500.0
    snowball_gain: float = 0.09  # per minute

    # --- Outcome -------------------------------------------------------------
    #: P(blue win) = sigmoid(beta_win*delta + gamma_gold*D(T_end)/2000 + blue_bias)
    beta_win: float = 1.35
    gamma_gold: float = 1.25
    #: Blue-side advantage producing an overall blue win rate near 0.51.
    blue_bias: float = 0.04

    # --- Match duration ------------------------------------------------------
    #: Nexus-destruction hazard h(t) = hazard_base * exp(|D(t)| / hazard_gold_scale).
    #: Stomps end earlier and close matches later, inducing a natural duration/lead correlation.
    hazard_base: float = 0.022  # per minute
    hazard_gold_scale: float = 6000.0
    #: Hazard ramp interval; a step would create an artificial spike in match endings.
    hazard_ramp_start_min: float = 14.0
    hazard_ramp_end_min: float = 22.0
    min_duration_min: float = 15.0
    max_duration_min: float = 48.0

    # --- Objectives ----------------------------------------------------------
    dragon_first_spawn_s: float = 300.0
    dragon_respawn_s: float = 300.0
    dragon_contest_delay_mean_s: float = 95.0
    #: Some dragon contests are preceded by a same-team pick, creating the DoD F time-chain signal.
    dragon_setup_kill_prob: float = 0.90
    #: P(blue takes objective) = sigmoid(beta_obj*delta + gamma_obj*D(t)/1500)
    beta_obj: float = 0.85
    gamma_obj: float = 0.25

    herald_first_spawn_s: float = 840.0
    herald_respawn_s: float = 360.0
    herald_despawn_s: float = 1140.0
    herald_contest_delay_mean_s: float = 70.0

    baron_first_spawn_s: float = 1200.0
    baron_respawn_s: float = 360.0
    baron_contest_delay_mean_s: float = 180.0

    grub_first_spawn_s: float = 300.0
    grub_respawn_s: float = 240.0

    # --- Turrets -------------------------------------------------------------
    #: Lane pressure P_lane(t) = lane_pressure_gain * D(t) * w_lane + noise.
    #: The next tier falls when cumulative team/lane pressure exceeds the threshold.
    #: Base push permits turret loss in even games; its ratio to gain controls first-turret time.
    tower_base_push: float = 330.0
    tower_pressure_gain: float = 0.025
    tower_threshold: float = 5200.0
    tower_noise_sigma: float = 260.0
    tower_lane_weight: dict[str, float] = field(
        default_factory=lambda: {"TOP_LANE": 0.9, "MID_LANE": 1.15, "BOT_LANE": 1.0}
    )
    plate_despawn_s: float = 840.0
    #: Plate-destruction probability per lane/team/minute = plate_base + plate_gain * lead/1500.
    plate_base: float = 0.12
    plate_gain: float = 0.03

    # --- Kills ---------------------------------------------------------------
    #: Expected team kills per minute, increasing over game phases.
    kill_rate_early: float = 0.25  # 0–14 minutes
    kill_rate_mid: float = 0.55  # 14–22 minutes
    kill_rate_late: float = 0.85  # 22+ minutes
    #: Kill ownership: P(blue kill) = sigmoid(beta_kill*delta + gamma_kill*D(t)/1500).
    beta_kill: float = 0.70
    gamma_kill: float = 0.18

    # --- Economy -------------------------------------------------------------
    #: Team total baseline: base(t) = gold_base_intercept + gold_base_slope * t_min.
    gold_base_intercept: float = 2500.0
    gold_base_slope: float = 1650.0
    #: Gold-allocation weights by role.
    role_gold_weight: dict[str, float] = field(
        default_factory=lambda: {
            "TOP": 0.21,
            "JUNGLE": 0.19,
            "MID": 0.24,
            "BOT": 0.26,
            "SUPPORT": 0.10,
        }
    )
    #: Event-driven gold shocks.
    shock_kill: float = 300.0
    shock_solo_kill: float = 400.0
    shock_tower: float = 550.0
    shock_plate: float = 175.0
    shock_dragon: float = 150.0
    shock_herald: float = 200.0
    shock_baron: float = 1200.0

    #: Calibration metadata recording the fitted targets.
    calibration: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, ensure_ascii=False) + "\n"

    def save(self, path: Path = PARAMS_PATH) -> None:
        path.write_text(self.to_json(), encoding="utf-8")

    @classmethod
    def load(cls, path: Path = PARAMS_PATH) -> SynthParams:
        if not path.exists():
            return cls()
        raw = json.loads(path.read_text(encoding="utf-8"))
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in raw.items() if k in known})


#: Calibration targets approximating solo-queue statistics. Validation remeasures generated
#: data and exits nonzero when a metric leaves tolerance.
CALIBRATION_TARGETS: dict[str, tuple[float, float]] = {
    # Metric: (target, tolerance)
    "blue_win_rate": (0.510, 0.020),
    "win_rate_given_first_blood": (0.600, 0.020),
    "win_rate_given_fb_top": (0.630, 0.030),
    "win_rate_given_fb_bot": (0.580, 0.030),
    "win_rate_given_gold_lead_1500_at_10m": (0.720, 0.030),
    # The 3000-gold target primarily checks monotonicity. Fitting both thresholds exactly causes
    # competing parameters, so DoD D fits 1500 while 3000 only guarantees a stronger lead rate.
    "win_rate_given_gold_lead_3000_at_10m": (0.810, 0.070),
    "first_blood_rate": (0.985, 0.015),
    "median_fb_to_first_tower_s": (195.0, 30.0),
}

# Metrics that require materialized event timestamps are validated from Parquet but are not knobs
# in the vectorized calibration loop.
VALIDATION_TARGETS: dict[str, tuple[float, float]] = {
    **CALIBRATION_TARGETS,
    "dragon_within_90s_after_kill": (0.18, 0.04),
}
