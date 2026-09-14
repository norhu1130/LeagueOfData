"""Verify region containment against TypeScript-generated golden data."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from lod_data import coords
from lod_data.regions import load_reference, point_in_region, preset_regions

GOLDEN = (
    Path(__file__).resolve().parents[3]
    / "tests"
    / "conformance"
    / "regions"
    / "point_in_region.json"
)


def test_reference_constants_match_typescript() -> None:
    data = load_reference()
    assert data["map"]["min"] == coords.MAP_MIN
    assert data["map"]["span"] == coords.MAP_SPAN
    assert data["coordSpace"] == "norm-v1"


def test_all_presets_loaded() -> None:
    regions = preset_regions()
    assert len(regions) == 16
    for expected in ("top_lane", "mid_lane", "bot_lane", "river", "dragon_pit", "baron_pit"):
        assert expected in regions


def test_point_in_region_matches_typescript_golden() -> None:
    if not GOLDEN.exists():
        pytest.skip(f"golden file is absent: {GOLDEN}")
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    regions = preset_regions()

    mismatches: list[str] = []
    for case in golden["cases"]:
        x, y = case["x"], case["y"]
        expected = set(case["hits"])
        actual = {rid for rid, r in regions.items() if point_in_region(x, y, r)}
        if actual != expected:
            only_py = sorted(actual - expected)
            only_ts = sorted(expected - actual)
            mismatches.append(f"({x}, {y}) python_only={only_py} ts_only={only_ts}")

    assert not mismatches, (
        f"TypeScript and Python differ at {len(mismatches)} points:\n" + "\n".join(mismatches[:10])
    )


def test_dragon_pit_center_matches_game_coordinates() -> None:
    n = coords.to_norm(9866, 4414)
    shape = preset_regions()["dragon_pit"].shape
    assert shape["kind"] == "circle"
    assert abs(shape["cx"] - n.x_norm) < 1e-3
    assert abs(shape["cy"] - n.y_norm) < 1e-3
