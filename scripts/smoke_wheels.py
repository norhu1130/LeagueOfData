"""Load bundled reference resources from built wheels outside the repository layout."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import zipfile
from pathlib import Path


def wheel_for(directory: Path, prefix: str) -> Path:
    matches = sorted(directory.glob(f"{prefix}-*.whl"))
    if len(matches) != 1:
        raise RuntimeError(f"expected one {prefix} wheel in {directory}, found {matches}")
    return matches[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("wheel_dir", type=Path)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="lod-wheel-smoke-") as temporary:
        extracted = Path(temporary)
        for prefix in ("lod_data", "lod_api"):
            with zipfile.ZipFile(wheel_for(args.wheel_dir, prefix)) as archive:
                archive.extractall(extracted)

        sys.path.insert(0, str(extracted))
        from lod_api.catalog import load_catalog
        from lod_data.regions import preset_regions

        catalog = load_catalog()
        regions = preset_regions()
        assert catalog.hash.startswith("sha256:")
        assert len(regions) == 16
        assert Path(sys.modules["lod_api"].__file__).is_relative_to(extracted)
        assert Path(sys.modules["lod_data"].__file__).is_relative_to(extracted)
        print(
            json.dumps(
                {
                    "catalogHash": catalog.hash,
                    "regions": len(regions),
                    "wheelDir": str(args.wheel_dir),
                }
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
