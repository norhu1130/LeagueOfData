from __future__ import annotations

import gzip
import json

import pyarrow as pa
import pytest
from lod_data.riot.normalize import UnsupportedMapError, normalize_match
from lod_data.riot.writer import normalize_bronze
from lod_data.schema import SCHEMA_VERSION, TABLES


def fixture() -> tuple[dict, dict]:
    participants = []
    participant_frames = {}
    for participant_id in range(1, 11):
        team_id = 100 if participant_id <= 5 else 200
        participants.append(
            {
                "participantId": participant_id,
                "teamId": team_id,
                "championId": participant_id,
                "championName": f"Champion{participant_id}",
                "teamPosition": "TOP",
                "win": team_id == 100,
                "kills": 1 if participant_id == 1 else 0,
                "deaths": 1 if participant_id == 6 else 0,
                "assists": 0,
                "goldEarned": 10_000,
                "goldSpent": 9_000,
                "champLevel": 18,
            }
        )
        participant_frames[str(participant_id)] = {
            "participantId": participant_id,
            "totalGold": 500 + participant_id,
            "currentGold": 100,
            "xp": 200,
            "level": 1,
            "minionsKilled": 0,
            "jungleMinionsKilled": 0,
            "position": {"x": 1000, "y": 1000},
        }
    match = {
        "metadata": {"matchId": "KR_1"},
        "info": {
            "platformId": "KR1",
            "queueId": 420,
            "gameVersion": "26.18.1",
            "gameDuration": 1800,
            "mapId": 11,
            "participants": participants,
            "teams": [
                {"teamId": 100, "win": True, "objectives": {"champion": {"first": True}}},
                {"teamId": 200, "win": False, "objectives": {"champion": {"first": False}}},
            ],
        },
    }
    timeline = {
        "info": {
            "frames": [
                {
                    "timestamp": 600_000,
                    "participantFrames": participant_frames,
                    "events": [
                        {
                            "type": "CHAMPION_KILL",
                            "timestamp": 300_000,
                            "killerId": 1,
                            "victimId": 6,
                            "position": {"x": 2000, "y": 3000},
                        },
                        {
                            "type": "BUILDING_KILL",
                            "timestamp": 500_000,
                            "killerId": 1,
                            "teamId": 200,
                            "buildingType": "TOWER_BUILDING",
                            "towerType": "OUTER_TURRET",
                            "laneType": "TOP_LANE",
                        },
                    ],
                }
            ]
        }
    }
    return match, timeline


def test_riot_payload_normalizes_to_all_shared_schemas() -> None:
    match, timeline = fixture()
    dataset = normalize_match(match, timeline)
    assert set(dataset.tables) == set(TABLES)
    for name, table in dataset.tables.items():
        assert table.schema == TABLES[name]
    assert dataset.tables["participants"].num_rows == 10
    assert dataset.tables["timeline_team_frames"].num_rows == 2
    assert dataset.tables["matches"].to_pylist()[0]["tier"] == "UNRANKED"


def test_rank_enrichment_produces_match_tier_and_participant_rank() -> None:
    match, timeline = fixture()
    tiers = ["SILVER"] * 5 + ["GOLD"] * 5
    for participant, tier in zip(match["info"]["participants"], tiers, strict=True):
        participant.update(_lodRankTier=tier, _lodRankDivision="II", _lodLeaguePoints=50)
    dataset = normalize_match(match, timeline)
    assert dataset.tables["matches"].to_pylist()[0]["tier"] == "GOLD"
    first = dataset.tables["participants"].to_pylist()[0]
    assert (first["rank_tier"], first["rank_division"], first["rank_league_points"]) == (
        "SILVER",
        "II",
        50,
    )


def test_building_owner_team_is_inverted_to_actor_team() -> None:
    match, timeline = fixture()
    rows = normalize_match(match, timeline).tables["events"].to_pylist()
    kill = next(row for row in rows if row["event_type"] == "kill")
    tower = next(row for row in rows if row["event_type"] == "turret_destroy")
    assert kill["team_id"] == 100
    assert kill["victim_team_id"] == 200
    assert tower["team_id"] == 100, (
        "Riot teamId identifies the destroyed building owner and must be inverted"
    )


def test_match_result_materializes_a_winner_scoped_game_end_event() -> None:
    match, timeline = fixture()
    rows = normalize_match(match, timeline).tables["events"].to_pylist()
    game_end = next(row for row in rows if row["event_type"] == "game_end")
    assert game_end["team_id"] == 100
    assert game_end["timestamp_ms"] == 1_800_000
    assert game_end["event_subtype"] == "MATCH_RESULT"


def test_roles_and_event_names_use_canonical_values() -> None:
    match, timeline = fixture()
    roles = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] * 2
    for participant, role in zip(match["info"]["participants"], roles, strict=True):
        participant["teamPosition"] = role
        participant["individualPosition"] = role
    timeline["info"]["frames"][0]["events"].extend(
        [
            {
                "type": "WARD_PLACED",
                "timestamp": 100_000,
                "creatorId": 2,
                "wardType": "YELLOW_TRINKET",
            },
            {
                "type": "WARD_KILL",
                "timestamp": 110_000,
                "killerId": 2,
                "wardType": "YELLOW_TRINKET",
            },
            {"type": "LEVEL_UP", "timestamp": 120_000, "participantId": 2, "level": 2},
        ]
    )
    dataset = normalize_match(match, timeline)
    assert set(dataset.tables["participants"]["role"].to_pylist()) == {
        "TOP",
        "JUNGLE",
        "MID",
        "BOT",
        "SUPPORT",
    }
    event_rows = dataset.tables["events"].to_pylist()
    event_types = {row["event_type"] for row in event_rows}
    assert {"ward_placed", "ward_destroyed", "champion_level_up"} <= event_types
    ward = next(row for row in event_rows if row["event_type"] == "ward_placed")
    assert (ward["participant_id"], ward["team_id"], ward["role"]) == (2, 100, "JUNGLE")


def test_first_of_type_is_global_for_kills_and_per_team_for_turrets() -> None:
    match, timeline = fixture()
    timeline["info"]["frames"][0]["events"].append(
        {
            "type": "BUILDING_KILL",
            "timestamp": 550_000,
            "killerId": 6,
            "teamId": 100,
            "buildingType": "TOWER_BUILDING",
            "towerType": "OUTER_TURRET",
            "laneType": "BOT_LANE",
        }
    )
    rows = normalize_match(match, timeline).tables["events"].to_pylist()
    first_kills = [row for row in rows if row["event_type"] == "kill" and row["is_first_of_type"]]
    first_turrets = [
        row for row in rows if row["event_type"] == "turret_destroy" and row["is_first_of_type"]
    ]
    assert len(first_kills) == 1
    assert {row["team_id"] for row in first_turrets} == {100, 200}


def test_missing_spawn_events_are_inferred_with_current_patch_rules() -> None:
    match, timeline = fixture()
    rows = normalize_match(match, timeline).tables["events"].to_pylist()
    spawns = {row["event_type"]: row for row in rows if row["event_type"].endswith("_spawn")}
    assert spawns["dragon_spawn"]["timestamp_ms"] == 300_000
    assert spawns["herald_spawn"]["timestamp_ms"] == 900_000
    assert spawns["baron_spawn"]["timestamp_ms"] == 1_200_000
    assert spawns["dragon_spawn"]["event_subtype"] == "INFERRED_RULE"
    assert spawns["dragon_spawn"]["event_origin"] == "inferred_rule"
    assert {row["event_origin"] for row in rows if not row["event_type"].endswith("_spawn")} == {
        "observed"
    }
    assert all(row["event_id"] == index for index, row in enumerate(rows))


def test_short_matches_do_not_get_post_game_spawn_events() -> None:
    match, timeline = fixture()
    match["info"]["gameDuration"] = 600
    rows = normalize_match(match, timeline).tables["events"].to_pylist()
    assert {row["event_type"] for row in rows if row["event_type"].endswith("_spawn")} == {
        "dragon_spawn"
    }


def test_spawn_rules_follow_historical_patch_boundaries() -> None:
    match, timeline = fixture()
    expected = {
        "14.19.1": (840_000, 1_200_000),
        "25.8.1": (960_000, 1_500_000),
        "25.9.1": (900_000, 1_500_000),
        "26.1.1": (900_000, 1_200_000),
    }
    for version, (herald_ms, baron_ms) in expected.items():
        match["info"]["gameVersion"] = version
        rows = normalize_match(match, timeline).tables["events"].to_pylist()
        spawns = {row["event_type"]: row["timestamp_ms"] for row in rows}
        assert spawns["herald_spawn"] == herald_ms
        assert spawns["baron_spawn"] == baron_ms


def test_bronze_batch_writes_all_partitioned_tables(tmp_path) -> None:
    match, timeline = fixture()
    bronze = tmp_path / "bronze/riot/KR_1"
    bronze.mkdir(parents=True)
    for name, value in (("match", match), ("timeline", timeline)):
        with gzip.open(bronze / f"{name}.json.gz", "wt", encoding="utf-8") as stream:
            json.dump(value, stream)
    manifest = normalize_bronze(tmp_path)
    assert manifest["source"] == "riot_v5"
    assert manifest["schemaVersion"] == SCHEMA_VERSION
    assert manifest["eventOrigins"] == ["observed", "inferred_rule"]
    assert manifest["inferredEventTypes"] == ["baron_spawn", "dragon_spawn", "herald_spawn"]
    assert manifest["n_matches"] == 1
    assert manifest["spatialMapId"] == 11
    assert manifest["normalizationQuality"] == {
        "attempted": 1,
        "completed": 1,
        "failed": 0,
        "excluded": 0,
        "completionRate": 1.0,
        "failureRate": 0.0,
        "excludedByReason": {},
    }
    assert manifest["normalizationFailures"] == []
    assert manifest["normalizationExclusions"] == []
    assert set(manifest["tables"]) == set(TABLES)


def test_item_undo_preserves_before_and_after_ids_for_inventory_reconstruction() -> None:
    match, timeline = fixture()
    timeline["info"]["frames"][0]["events"].append(
        {
            "type": "ITEM_UNDO",
            "timestamp": 450_000,
            "participantId": 1,
            "beforeId": 3165,
            "afterId": 3108,
        }
    )

    rows = normalize_match(match, timeline).tables["events"].to_pylist()
    undo = next(row for row in rows if row["event_type"] == "item_undo")

    assert undo["item_id"] == 3165
    assert undo["item_after_id"] == 3108


def test_swiftplay_item_ids_and_empty_ban_sentinels_are_normalized() -> None:
    match, timeline = fixture()
    match["info"]["queueId"] = 480
    match["info"]["teams"][1]["bans"] = [
        {"championId": 101, "pickTurn": 1},
        {"championId": -1, "pickTurn": 2},
    ]
    match["info"]["participants"][0]["item0"] = 323_190
    timeline["info"]["frames"][0]["events"].append(
        {
            "type": "ITEM_UNDO",
            "timestamp": 450_000,
            "participantId": 1,
            "beforeId": 326_657,
            "afterId": 323_075,
        }
    )

    dataset = normalize_match(match, timeline)

    assert dataset.tables["participants"].schema.field("items").type == pa.list_(pa.uint32())
    assert dataset.tables["participants"].to_pylist()[0]["items"] == [323_190]
    assert dataset.tables["teams"].to_pylist()[1]["bans"] == [101]
    undo = next(
        row for row in dataset.tables["events"].to_pylist() if row["event_type"] == "item_undo"
    )
    assert (undo["item_id"], undo["item_after_id"]) == (326_657, 323_075)


def test_normalizing_after_a_later_crawl_keeps_previous_matches(tmp_path) -> None:
    def store(match_id: str) -> None:
        match, timeline = fixture()
        match["metadata"]["matchId"] = match_id
        bronze = tmp_path / "bronze" / "riot" / match_id
        bronze.mkdir(parents=True)
        for name, value in (("match", match), ("timeline", timeline)):
            with gzip.open(bronze / f"{name}.json.gz", "wt", encoding="utf-8") as stream:
                json.dump(value, stream)

    store("KR_1")
    assert normalize_bronze(tmp_path)["n_matches"] == 1

    store("KR_2")
    manifest = normalize_bronze(tmp_path)

    assert manifest["n_matches"] == 2
    assert manifest["tables"]["matches"]["rows"] == 2


def test_bronze_normalization_filters_queue_ids(tmp_path) -> None:
    match, timeline = fixture()
    bronze = tmp_path / "bronze/riot/KR_1"
    bronze.mkdir(parents=True)
    for name, value in (("match", match), ("timeline", timeline)):
        with gzip.open(bronze / f"{name}.json.gz", "wt", encoding="utf-8") as stream:
            json.dump(value, stream)

    manifest = normalize_bronze(tmp_path, queue_ids={480})

    assert manifest["n_matches"] == 0
    assert manifest["normalizationQuality"]["excludedByReason"] == {"queue": 1}
    assert manifest["normalizationExclusions"] == [
        {"match": "KR_1", "reason": "queue", "queueId": 420}
    ]


def test_non_summoners_rift_match_is_rejected_before_spatial_normalization() -> None:
    match, timeline = fixture()
    match["info"]["mapId"] = 12
    match["info"]["queueId"] = 450

    with pytest.raises(UnsupportedMapError, match="unsupported map 12"):
        normalize_match(match, timeline)


def test_normalization_quality_separates_failures_and_unsupported_maps(tmp_path) -> None:
    valid_match, valid_timeline = fixture()
    unsupported_match, unsupported_timeline = fixture()
    unsupported_match["metadata"]["matchId"] = "KR_2"
    unsupported_match["info"]["mapId"] = 12
    unsupported_match["info"]["queueId"] = 450
    missing_timeline_match, _ = fixture()
    missing_timeline_match["metadata"]["matchId"] = "KR_3"

    for match_id, match, timeline in (
        ("KR_1", valid_match, valid_timeline),
        ("KR_2", unsupported_match, unsupported_timeline),
    ):
        bronze = tmp_path / "bronze" / "riot" / match_id
        bronze.mkdir(parents=True)
        for name, value in (("match", match), ("timeline", timeline)):
            with gzip.open(bronze / f"{name}.json.gz", "wt", encoding="utf-8") as stream:
                json.dump(value, stream)

    missing = tmp_path / "bronze" / "riot" / "KR_3"
    missing.mkdir(parents=True)
    with gzip.open(missing / "match.json.gz", "wt", encoding="utf-8") as stream:
        json.dump(missing_timeline_match, stream)

    progress = []
    manifest = normalize_bronze(tmp_path, workers=2, batch_size=1, progress=progress.append)
    quality = manifest["normalizationQuality"]
    assert quality == {
        "attempted": 3,
        "completed": 1,
        "failed": 1,
        "excluded": 1,
        "completionRate": pytest.approx(1 / 3),
        "failureRate": pytest.approx(1 / 3),
        "excludedByReason": {"unsupported_map": 1},
    }
    assert manifest["normalizationFailures"] == [{"match": "KR_3", "error": "timeline missing"}]
    assert manifest["normalizationExclusions"] == [
        {"match": "KR_2", "reason": "unsupported_map", "mapId": 12}
    ]
    assert manifest["tables"]["matches"]["rows"] == 1
    assert progress[0].processed == 0
    assert progress[-1].processed == progress[-1].total == 3
    assert progress[-1].completed == 1
    assert progress[-1].failed == 1
    assert progress[-1].excluded == 1
    assert progress[-1].workers == 2


def test_bronze_normalization_rejects_invalid_worker_count(tmp_path) -> None:
    with pytest.raises(ValueError, match="workers must be greater than zero"):
        normalize_bronze(tmp_path, workers=0)
