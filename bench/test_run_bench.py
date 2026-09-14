from __future__ import annotations

import json

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from bench.run_bench import latency_budget, validate_dataset


def write_manifest(tmp_path, *, rows: int, n_matches: int, physical_rows: int | None = None):
    silver = tmp_path / "silver"
    silver.mkdir()
    matches = silver / "matches"
    matches.mkdir()
    pq.write_table(
        pa.table({"match_id": list(range(physical_rows if physical_rows is not None else rows))}),
        matches / "part-0000.parquet",
    )
    (silver / "_manifest.json").write_text(
        json.dumps(
            {
                "snapshot_id": "sha256:test",
                "source": "synthetic_v1",
                "n_matches": n_matches,
                "tables": {"matches": {"rows": rows}},
            }
        ),
        encoding="utf-8",
    )
    return silver


def test_validate_dataset_reports_path_snapshot_and_expected_rows(tmp_path) -> None:
    silver = write_manifest(tmp_path, rows=10_000, n_matches=10_000)

    selected, manifest, rows = validate_dataset(tmp_path, "synth-10k")

    assert selected == silver
    assert manifest["snapshot_id"] == "sha256:test"
    assert rows == 10_000


@pytest.mark.parametrize("rows,n_matches", [(10_000, 100_000), (100_000, 10_000)])
def test_validate_dataset_rejects_a_mismatched_profile(tmp_path, rows, n_matches) -> None:
    write_manifest(tmp_path, rows=rows, n_matches=n_matches)

    with pytest.raises(ValueError, match="requires exactly 100,000 matches"):
        validate_dataset(tmp_path, "synth-100k")


def test_validate_dataset_checks_physical_match_rows(tmp_path) -> None:
    write_manifest(tmp_path, rows=10_000, n_matches=10_000, physical_rows=9_999)

    with pytest.raises(ValueError, match="physical rows=9999"):
        validate_dataset(tmp_path, "synth-10k")


def test_latency_budgets_isolate_expensive_10k_cases() -> None:
    assert latency_budget("synth-10k", "dod-a-first-blood-win-rate") == ("p50", 250.0)
    assert latency_budget("synth-10k", "dod-e-death-in-region") == ("p50", 650.0)
    assert latency_budget("synth-10k", "dod-f-dragon-after-kill") == ("p50", 500.0)
    assert latency_budget("synth-100k", "dod-e-death-in-region") == ("p95", 2_000.0)
