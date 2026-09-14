"""Load TypeScript-generated region definitions and provide point containment.

Containment must use the same even-odd ray casting as TypeScript `pointInShape`; conformance tests
keep boundary behavior aligned with frontend previews.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Any, Literal


def _repo_root() -> Path:
    # Walk four levels from the module directory to the package root.
    return Path(__file__).resolve().parents[4]


REFERENCE_PATH = _repo_root() / "data" / "reference" / "regions_builtin.json"

CoordSpace = Literal["norm-v1"]


@dataclass(frozen=True, slots=True)
class Bbox:
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass(frozen=True, slots=True)
class RegionDefinition:
    id: str
    label: str
    origin: str
    coord_space: CoordSpace
    shape: dict[str, Any]


@lru_cache(maxsize=1)
def load_reference() -> dict[str, Any]:
    """Load generated reference data and verify coordinate constants."""
    from . import coords

    if REFERENCE_PATH.exists():
        raw = REFERENCE_PATH.read_text(encoding="utf-8")
    else:
        bundled = resources.files("lod_data").joinpath("regions_builtin.json")
        if not bundled.is_file():
            raise FileNotFoundError(
                f"{REFERENCE_PATH} does not exist and the package has no bundled reference. "
                "Run `pnpm -F @lol/data-model export-reference` before building."
            )
        raw = bundled.read_text(encoding="utf-8")
    data = json.loads(raw)
    m = data["map"]
    if m["min"] != coords.MAP_MIN or m["span"] != coords.MAP_SPAN:
        raise ValueError(
            "Coordinate constants do not match the TypeScript definitions: "
            f"generated min={m['min']} span={m['span']} / "
            f"Python min={coords.MAP_MIN} span={coords.MAP_SPAN}"
        )
    return data


@lru_cache(maxsize=1)
def preset_regions() -> dict[str, RegionDefinition]:
    data = load_reference()
    return {
        r["id"]: RegionDefinition(
            id=r["id"],
            label=r["label"],
            origin=r["origin"],
            coord_space=r["coordSpace"],
            shape=r["shape"],
        )
        for r in data["regions"]
    }


def shape_bbox(shape: dict[str, Any]) -> Bbox:
    kind = shape["kind"]
    if kind == "polygon":
        xs = [p[0] for p in shape["points"]]
        ys = [p[1] for p in shape["points"]]
        return Bbox(min(xs), min(ys), max(xs), max(ys))
    if kind == "rect":
        return Bbox(
            min(shape["x0"], shape["x1"]),
            min(shape["y0"], shape["y1"]),
            max(shape["x0"], shape["x1"]),
            max(shape["y0"], shape["y1"]),
        )
    if kind == "circle":
        cx, cy, r = shape["cx"], shape["cy"], shape["r"]
        return Bbox(cx - r, cy - r, cx + r, cy + r)
    if kind == "multi":
        boxes = [shape_bbox(p) for p in shape["parts"]]
        return Bbox(
            min(b.x0 for b in boxes),
            min(b.y0 for b in boxes),
            max(b.x1 for b in boxes),
            max(b.y1 for b in boxes),
        )
    raise ValueError(f"Unknown shape: {kind}")


def point_in_shape(x_norm: float, y_norm: float, shape: dict[str, Any]) -> bool:
    kind = shape["kind"]
    if kind == "polygon":
        pts = shape["points"]
        n = len(pts)
        if n < 3:
            return False
        inside = False
        j = n - 1
        for i in range(n):
            xi, yi = pts[i]
            xj, yj = pts[j]
            if (yi > y_norm) != (yj > y_norm):
                d = yj - yi
                if d != 0 and x_norm < (xj - xi) * (y_norm - yi) / d + xi:
                    inside = not inside
            j = i
        return inside
    if kind == "rect":
        b = shape_bbox(shape)
        return b.x0 <= x_norm <= b.x1 and b.y0 <= y_norm <= b.y1
    if kind == "circle":
        dx = x_norm - shape["cx"]
        dy = y_norm - shape["cy"]
        return dx * dx + dy * dy <= shape["r"] ** 2
    if kind == "multi":
        return any(point_in_shape(x_norm, y_norm, p) for p in shape["parts"])
    raise ValueError(f"Unknown shape: {kind}")


def point_in_region(x_norm: float, y_norm: float, region: RegionDefinition) -> bool:
    return point_in_shape(x_norm, y_norm, region.shape)
