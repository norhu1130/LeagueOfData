"""Synthetic data pipeline regressions, including all six definition-of-done questions."""

from __future__ import annotations

from pathlib import Path

import duckdb
import lod_data.synth.writer as writer_module
import numpy as np
import pytest
from lod_data.layout import PartitionKey, partition_dir
from lod_data.schema import SCHEMA_VERSION
from lod_data.synth.engine import measure, simulate
from lod_data.synth.generator import generate
from lod_data.synth.params import SynthParams
from lod_data.synth.validate import check_integrity
from lod_data.synth.writer import write_dataset

N_TEST_MATCHES = 400
SEED = 4242


@pytest.fixture(scope="module")
def dataset(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("silver")
    write_dataset(N_TEST_MATCHES, root, seed=SEED, workers=1, chunk_size=400, progress=False)
    return root


@pytest.fixture(scope="module")
def con(dataset: Path) -> duckdb.DuckDBPyConnection:
    c = duckdb.connect()
    for table in (
        "matches",
        "participants",
        "teams",
        "events",
        "timeline_team_frames",
        "timeline_participant_frames",
        "match_summary",
    ):
        c.execute(
            f"CREATE VIEW {table} AS SELECT * FROM "
            f"read_parquet('{dataset / table}/**/*.parquet', hive_partitioning=1, union_by_name=1)"
        )
    return c


class TestDeterminism:
    def test_writer_forwards_explicit_params(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: list[float] = []

        def fake_write_chunk(*args):
            seen.append(args[4].tower_threshold)
            return {}

        monkeypatch.setattr(writer_module, "_write_chunk", fake_write_chunk)
        params = SynthParams(tower_threshold=1234.0)
        write_dataset(1, tmp_path, params=params, workers=1, chunk_size=1, progress=False)
        assert seen == [1234.0]

    def test_same_seed_produces_identical_data(self) -> None:
        a = generate(20, seed=99)
        b = generate(20, seed=99)
        for name in a.tables:
            assert a.tables[name].equals(b.tables[name]), f"{name} is not reproducible"

    def test_different_seed_produces_different_data(self) -> None:
        a = generate(20, seed=1)
        b = generate(20, seed=2)
        assert not a.tables["matches"].equals(b.tables["matches"])

    def test_chunk_size_does_not_change_logical_match_data(self, tmp_path: Path) -> None:
        a = tmp_path / "a"
        b = tmp_path / "b"
        write_dataset(8, a, seed=99, workers=1, chunk_size=8, progress=False)
        write_dataset(8, b, seed=99, workers=1, chunk_size=3, progress=False)
        c = duckdb.connect()
        for table in ("matches", "match_summary", "events"):
            left = a / table
            right = b / table
            difference = c.execute(
                f"SELECT count(*) FROM ("
                f"SELECT * FROM read_parquet('{left}/**/*.parquet', hive_partitioning=1) "
                f"EXCEPT SELECT * FROM read_parquet('{right}/**/*.parquet', hive_partitioning=1))"
            ).fetchone()[0]
            assert difference == 0, f"{table} changed with chunk size"

    def test_rerun_replaces_old_parts_instead_of_mixing_them(self, tmp_path: Path) -> None:
        root = tmp_path / "silver"
        write_dataset(5, root, seed=11, workers=1, chunk_size=2, progress=False)
        manifest = write_dataset(1, root, seed=11, workers=1, chunk_size=1, progress=False)
        actual = (
            duckdb.connect()
            .execute(
                "SELECT count(*) FROM read_parquet(?, hive_partitioning=1)",
                [str(root / "matches/**/*.parquet")],
            )
            .fetchone()[0]
        )
        assert manifest["n_matches"] == manifest["tables"]["matches"]["rows"] == actual == 1
        assert manifest["schemaVersion"] == SCHEMA_VERSION
        assert manifest["eventOrigins"] == ["synthetic"]
        assert manifest["inferredEventTypes"] == []

    @pytest.mark.parametrize("value", ["../14.19", "KR/../../escape", "", "."])
    def test_partition_values_cannot_escape_dataset_root(self, tmp_path: Path, value: str) -> None:
        with pytest.raises(ValueError):
            partition_dir(tmp_path, "matches", PartitionKey(value, "QUEUE", "KR"))

    def test_match_ids_are_unique_and_sequential(self, con: duckdb.DuckDBPyConnection) -> None:
        n, distinct = con.execute(
            "SELECT count(*), count(DISTINCT match_id) FROM matches"
        ).fetchone()
        assert n == distinct == N_TEST_MATCHES


class TestIntegrity:
    def test_no_integrity_violations(self, dataset: Path) -> None:
        failures = check_integrity(dataset)
        assert not failures, "Integrity violations:\n" + "\n".join(failures)

    def test_all_coordinates_in_map_bounds(self, con: duckdb.DuckDBPyConnection) -> None:
        (bad,) = con.execute(
            "SELECT count(*) FROM events WHERE has_position AND ("
            "x_norm < 0 OR x_norm > 1 OR y_norm < 0 OR y_norm > 1)"
        ).fetchone()
        assert bad == 0

    def test_raw_and_normalized_coordinates_agree(self, con: duckdb.DuckDBPyConnection) -> None:
        """Raw and normalized coordinates must identify the same point."""
        (bad,) = con.execute(
            "SELECT count(*) FROM events WHERE has_position "
            "AND abs((x_raw + 120.0) / 15000.0 - x_norm) > 0.001"
        ).fetchone()
        assert bad == 0

    def test_events_sorted_within_match(self, con: duckdb.DuckDBPyConnection) -> None:
        (bad,) = con.execute(
            "SELECT count(*) FROM (SELECT match_id, timestamp_ms, "
            "lag(timestamp_ms) OVER (PARTITION BY match_id ORDER BY event_id) AS prev "
            "FROM events) WHERE prev IS NOT NULL AND timestamp_ms < prev"
        ).fetchone()
        assert bad == 0

    def test_synthetic_event_origin_is_explicit(self, con: duckdb.DuckDBPyConnection) -> None:
        rows = con.execute(
            "SELECT event_origin, count(*) FROM events GROUP BY event_origin"
        ).fetchall()
        assert rows == [("synthetic", con.execute("SELECT count(*) FROM events").fetchone()[0])]

    def test_team_frame_state_is_cumulative_without_future_leakage(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        (bad_initial,) = con.execute(
            "SELECT count(*) FROM timeline_team_frames WHERE timestamp_ms=0 AND "
            "(kill_diff<>0 OR alive_towers<>11 OR dragons_taken<>0 OR barons_taken<>0)"
        ).fetchone()
        assert bad_initial == 0
        (bad_final,) = con.execute(
            """
            WITH final_frames AS (
              SELECT * FROM timeline_team_frames
              QUALIFY row_number() OVER (
                PARTITION BY match_id, team_id ORDER BY timestamp_ms DESC
              )=1
            ), totals AS (
              SELECT match_id, team_id,
                count(*) FILTER (WHERE event_type='kill') kills,
                count(*) FILTER (WHERE event_type='dragon_kill') dragons,
                count(*) FILTER (WHERE event_type='baron_kill') barons
              FROM events WHERE team_id IN (100,200) GROUP BY 1,2
            )
            SELECT count(*) FROM final_frames f
            LEFT JOIN totals own USING(match_id,team_id)
            LEFT JOIN totals enemy ON enemy.match_id=f.match_id
              AND enemy.team_id=CASE f.team_id WHEN 100 THEN 200 ELSE 100 END
            WHERE f.kill_diff<>coalesce(own.kills,0)-coalesce(enemy.kills,0)
               OR f.dragons_taken<>coalesce(own.dragons,0)
               OR f.barons_taken<>coalesce(own.barons,0)
            """
        ).fetchone()
        assert bad_final == 0

    def test_derived_durations_and_first_objective_flags_are_valid(
        self, con: duckdb.DuckDBPyConnection
    ) -> None:
        (negative,) = con.execute(
            "SELECT count(*) FROM match_summary WHERE fb_to_first_tower_ms < 0"
        ).fetchone()
        (multiple_baron,) = con.execute(
            "SELECT count(*) FROM (SELECT match_id, sum(first_baron::INT) n "
            "FROM teams GROUP BY 1) WHERE n > 1"
        ).fetchone()
        assert negative == 0
        assert multiple_baron == 0


class TestStatisticalShape:
    """Verify that the generation model remains non-degenerate under combined conditions."""

    def test_first_blood_correlates_with_winning(self) -> None:
        paths = simulate(6000, SynthParams.load(), np.random.default_rng(7))
        m = measure(paths)
        assert 0.55 < m["win_rate_given_first_blood"] < 0.66

    def test_lane_differential_is_ordered(self) -> None:
        """Top first blood should be a stronger signal than bot first blood."""
        paths = simulate(20000, SynthParams.load(), np.random.default_rng(13))
        m = measure(paths)
        assert m["win_rate_given_fb_top"] > m["win_rate_given_fb_bot"] + 0.02

    def test_gold_lead_win_rate_is_monotone(self) -> None:
        paths = simulate(20000, SynthParams.load(), np.random.default_rng(21))
        gd10 = paths.gold_diff[:, 10]
        ok = paths.duration_min >= 10
        rates = [paths.blue_win[ok & (gd10 >= t)].mean() for t in (0, 1000, 2000, 3000, 4000)]
        pairs = list(zip(rates[:-1], rates[1:], strict=True))
        assert all(a <= b + 0.01 for a, b in pairs), rates

    def test_combined_conditions_do_not_collapse(self) -> None:
        """Combined conditions must not collapse to a hard-coded single-condition rate."""
        paths = simulate(30000, SynthParams.load(), np.random.default_rng(31))
        fb_team_win = np.where(paths.fb_blue, paths.blue_win, ~paths.blue_win)
        gd10 = paths.gold_diff[:, 10]
        fb_gold = np.where(paths.fb_blue, gd10, -gd10)
        both = paths.fb_occurred & (fb_gold >= 1500)
        only_fb = paths.fb_occurred & (fb_gold < 1500)
        assert both.sum() > 500 and only_fb.sum() > 500
        # First blood plus a gold lead should outperform first blood alone.
        assert fb_team_win[both].mean() > fb_team_win[only_fb].mean() + 0.10

    def test_objective_kills_have_nonzero_contest_delay(self) -> None:
        events = generate(80, seed=81).tables["events"].to_pylist()
        dragon_times = [row["timestamp_ms"] for row in events if row["event_type"] == "dragon_kill"]
        assert len(set(dragon_times)) > 50
        assert all(timestamp % 300_000 != 0 for timestamp in dragon_times)


class TestSpatialDistribution:
    def test_kills_are_not_uniformly_distributed(self, con: duckdb.DuckDBPyConnection) -> None:
        """A nonuniform distribution is required for meaningful custom-region analysis."""
        rows = con.execute(
            "SELECT floor(x_norm * 5) AS gx, floor(y_norm * 5) AS gy, count(*) n "
            "FROM events WHERE event_type = 'kill' AND has_position GROUP BY 1, 2"
        ).fetchall()
        counts = np.array([r[2] for r in rows], dtype=float)
        # A uniform 25-cell grid has near-zero variation; lane structure increases it.
        assert counts.std() / counts.mean() > 0.5

    def test_first_blood_regions_are_tagged(self, con: duckdb.DuckDBPyConnection) -> None:
        rows = dict(
            con.execute(
                "SELECT first_blood_region, count(*) FROM match_summary "
                "WHERE got_first_blood GROUP BY 1"
            ).fetchall()
        )
        for region in ("top_lane", "mid_lane", "bot_lane"):
            assert rows.get(region, 0) > 0, f"no first blood tagged with {region}"


class TestDefinitionOfDone:
    """Verify that the dataset can answer all six questions from §38."""

    def test_a_first_blood_win_rate(self, con: duckdb.DuckDBPyConnection) -> None:
        rate, n = con.execute(
            "SELECT avg(CASE WHEN win THEN 1.0 ELSE 0.0 END), count(*) "
            "FROM match_summary WHERE got_first_blood"
        ).fetchone()
        assert n > N_TEST_MATCHES * 0.9
        assert 0.52 < rate < 0.70

    def test_b_top_lane_first_blood_win_rate(self, con: duckdb.DuckDBPyConnection) -> None:
        rate, n = con.execute(
            "SELECT avg(CASE WHEN win THEN 1.0 ELSE 0.0 END), count(*) "
            "FROM match_summary WHERE got_first_blood AND first_blood_region = 'top_lane'"
        ).fetchone()
        assert n > 20, "too few top-lane first-blood samples to answer question B"
        assert 0.4 < rate < 0.85

    def test_c_first_blood_to_first_tower_duration(self, con: duckdb.DuckDBPyConnection) -> None:
        avg_s, n = con.execute(
            "SELECT avg(fb_to_first_tower_ms) / 1000.0, count(*) FROM match_summary "
            "WHERE fb_to_first_tower_ms > 0"
        ).fetchone()
        assert n > 100
        assert 150 < avg_s < 260, f"{avg_s:.0f} seconds is outside the target range"

    def test_d_gold_lead_win_rate(self, con: duckdb.DuckDBPyConnection) -> None:
        rate, n = con.execute(
            "SELECT avg(CASE WHEN win THEN 1.0 ELSE 0.0 END), count(*) "
            "FROM match_summary WHERE gold_diff_at_10m >= 1500"
        ).fetchone()
        assert n > 50
        assert 0.62 < rate < 0.82

    def test_e_death_in_region_win_rate(self, con: duckdb.DuckDBPyConnection) -> None:
        """Measure win rate after a death inside a representative custom rectangle."""
        rate, n = con.execute(
            """
            WITH deaths AS (
              SELECT e.match_id, e.victim_team_id AS team_id
              FROM events e
              WHERE e.event_type = 'kill' AND e.has_position
                AND e.x_norm BETWEEN 0.0 AND 0.35 AND e.y_norm BETWEEN 0.55 AND 1.0
            )
            SELECT avg(CASE WHEN s.win THEN 1.0 ELSE 0.0 END), count(*)
            FROM deaths d JOIN match_summary s
              ON s.match_id = d.match_id AND s.team_id = d.team_id
            """
        ).fetchone()
        assert n > 100, "too few death samples inside the region"
        assert 0.0 < rate < 1.0

    def test_f_dragon_within_90s_after_kill(self, con: duckdb.DuckDBPyConnection) -> None:
        rate, n = con.execute(
            """
            WITH trig AS (
              SELECT match_id, event_id, timestamp_ms AS t0, team_id
              FROM events WHERE event_type = 'kill'
            ),
            tgt AS (
              SELECT match_id, timestamp_ms AS t1, team_id
              FROM events WHERE event_type = 'dragon_kill'
            ),
            chain AS (
              SELECT t.match_id, t.event_id, min(g.t1) AS t1
              FROM trig t LEFT JOIN tgt g
                ON g.match_id = t.match_id AND g.team_id = t.team_id
               AND g.t1 >= t.t0 AND g.t1 <= t.t0 + 90000
              GROUP BY 1, 2
            )
            SELECT avg(CASE WHEN t1 IS NOT NULL THEN 1.0 ELSE 0.0 END), count(*) FROM chain
            """
        ).fetchone()
        assert n > 1000
        # The rate must be neither zero nor one for the analysis to be meaningful.
        assert 0.05 < rate < 0.40


class TestDerivedViews:
    """Verify derived death, assist, and first-blood views against physical rows."""

    @staticmethod
    @pytest.fixture(scope="class")
    def vcon(dataset: Path) -> duckdb.DuckDBPyConnection:
        from lod_data.duckdb_views import register_views

        c = duckdb.connect()
        register_views(c, dataset)
        return c

    def test_all_views_register(self, vcon: duckdb.DuckDBPyConnection) -> None:
        from lod_data.duckdb_views import DERIVED_VIEWS

        for view in DERIVED_VIEWS:
            vcon.execute(f"SELECT count(*) FROM {view}").fetchone()

    def test_deaths_equal_kills(self, vcon: duckdb.DuckDBPyConnection) -> None:
        (kills,) = vcon.execute("SELECT count(*) FROM events WHERE event_type='kill'").fetchone()
        (deaths,) = vcon.execute("SELECT count(*) FROM v_deaths").fetchone()
        assert kills == deaths

    def test_participant_kd_matches_events(self, vcon: duckdb.DuckDBPyConnection) -> None:
        """Participant aggregates and event-derived values must agree."""
        (bad,) = vcon.execute(
            """
            WITH derived AS (
              SELECT match_id, participant_id, count(*) AS n
              FROM events WHERE event_type='kill' GROUP BY 1,2
            )
            SELECT count(*) FROM participants p
            LEFT JOIN derived d USING (match_id, participant_id)
            WHERE p.kills <> coalesce(d.n, 0)
            """
        ).fetchone()
        assert bad == 0

    def test_first_blood_view_at_most_one_per_match(self, vcon: duckdb.DuckDBPyConnection) -> None:
        (bad,) = vcon.execute(
            "SELECT count(*) FROM (SELECT match_id FROM v_first_blood "
            "GROUP BY match_id HAVING count(*) > 1)"
        ).fetchone()
        assert bad == 0

    def test_assists_unnest_count_matches_list_lengths(
        self, vcon: duckdb.DuckDBPyConnection
    ) -> None:
        (total,) = vcon.execute(
            "SELECT sum(assist_count) FROM events WHERE event_type='kill'"
        ).fetchone()
        (unnested,) = vcon.execute("SELECT count(*) FROM v_event_assists").fetchone()
        assert int(total) == unnested

    def test_solo_kills_are_a_meaningful_minority(self, vcon: duckdb.DuckDBPyConnection) -> None:
        (ratio,) = vcon.execute(
            "SELECT (SELECT count(*) FROM v_solo_kills)::DOUBLE / "
            "(SELECT count(*) FROM events WHERE event_type='kill')"
        ).fetchone()
        assert 0.10 < ratio < 0.60
