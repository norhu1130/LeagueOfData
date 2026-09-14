from __future__ import annotations

import gzip
import json

import httpx
import pytest
from lod_data.riot.checkpoint import Checkpoint
from lod_data.riot.client import RiotApiClient
from lod_data.riot.collector import RiotCollector
from lod_data.riot.crawler import RiotCrawler
from lod_data.riot.rate_limit import HeaderRateLimiter, parse_windows


def test_rate_limit_header_parser_ignores_malformed_entries() -> None:
    assert parse_windows("20:1,100:120,bad") == [(20, 1.0), (100, 120.0)]


def test_rate_limiter_does_not_seed_local_window_from_server_count() -> None:
    waits: list[float] = []
    limiter = HeaderRateLimiter(on_wait=waits.append)
    limiter.update("app", "20:1,100:120", "20:1,100:120")

    limiter.wait(("app",))

    assert waits == []


def test_client_uses_token_header_and_updates_from_server_counts() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json=["KR_1"],
            headers={
                "X-App-Rate-Limit": "20:1,100:120",
                "X-App-Rate-Limit-Count": "1:1,1:120",
            },
        )

    with RiotApiClient("secret", transport=httpx.MockTransport(handler)) as client:
        assert client.match_ids("player") == ["KR_1"]
    assert seen[0].headers["X-Riot-Token"] == "secret"
    assert "secret" not in str(seen[0].url)


def test_client_resolves_riot_id_and_filters_match_ids_by_queue() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if "/accounts/by-riot-id/" in request.url.path:
            return httpx.Response(200, json={"puuid": "player"})
        return httpx.Response(200, json=["KR_1"])

    with RiotApiClient("secret", transport=httpx.MockTransport(handler)) as client:
        assert client.account_by_riot_id("Hide on bush", "KR1")["puuid"] == "player"
        assert client.match_ids("player", count=2, queue=480) == ["KR_1"]

    assert seen[0].url.raw_path.endswith(b"/Hide%20on%20bush/KR1")
    assert seen[1].url.params["queue"] == "480"
    assert seen[1].url.params["count"] == "2"


def test_client_separates_regional_and_platform_rate_limit_scopes() -> None:
    class RecordingLimiter:
        def __init__(self) -> None:
            self.waits: list[tuple[str, ...]] = []
            self.updates: list[str] = []

        def wait(self, scopes: tuple[str, ...]) -> None:
            self.waits.append(scopes)

        def update(self, scope: str, _limits: str | None, _counts: str | None) -> None:
            self.updates.append(scope)

        def block(self, _scope: str, _retry_after: float) -> None:
            pass

        def reset(self, _scope: str) -> None:
            pass

    def handler(request: httpx.Request) -> httpx.Response:
        if "/entries/by-puuid/" in request.url.path:
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=["KR_1"])

    limiter = RecordingLimiter()
    with RiotApiClient(
        "secret",
        routing="asia",
        platform="kr",
        transport=httpx.MockTransport(handler),
        limiter=limiter,  # type: ignore[arg-type]
    ) as client:
        client.match_ids("player")
        client.league_entries("player")

    assert limiter.waits == [
        ("app", "asia:method:match_ids"),
        ("app", "kr:method:league_entries"),
    ]
    assert limiter.updates.count("app") == 2
    assert "asia:method:match_ids" in limiter.updates
    assert "kr:method:league_entries" in limiter.updates


def test_429_is_retried_as_normal_control_flow() -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(200, json={"metadata": {"matchId": "KR_1"}})

    with RiotApiClient("secret", transport=httpx.MockTransport(handler)) as client:
        assert client.match("KR_1")["metadata"]["matchId"] == "KR_1"
    assert attempts == 2


def test_429_retry_after_replaces_predicted_application_window() -> None:
    class RetryLimiter:
        def __init__(self) -> None:
            self.updates: list[str] = []
            self.resets: list[str] = []
            self.blocks: list[tuple[str, float]] = []

        def wait(self, _scopes: tuple[str, ...]) -> None:
            pass

        def update(self, scope: str, _limits: str | None, _counts: str | None) -> None:
            self.updates.append(scope)

        def reset(self, scope: str) -> None:
            self.resets.append(scope)

        def block(self, scope: str, retry_after: float) -> None:
            self.blocks.append((scope, retry_after))

    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(
                429,
                headers={
                    "Retry-After": "71",
                    "X-Rate-Limit-Type": "application",
                    "X-App-Rate-Limit": "20:1,100:120",
                    "X-App-Rate-Limit-Count": "100:120,0:1",
                },
            )
        return httpx.Response(200, json={"metadata": {"matchId": "KR_1"}})

    limiter = RetryLimiter()
    with RiotApiClient(
        "secret",
        transport=httpx.MockTransport(handler),
        limiter=limiter,  # type: ignore[arg-type]
    ) as client:
        assert client.match("KR_1")["metadata"]["matchId"] == "KR_1"

    assert limiter.resets == ["app"]
    assert limiter.blocks == [("app", 71.0)]
    assert limiter.updates == ["app", "asia:method:match"]


class FakeClient:
    calls = 0

    def match(self, match_id: str) -> dict:
        self.calls += 1
        return {"metadata": {"matchId": match_id}}

    def timeline(self, match_id: str) -> dict:
        self.calls += 1
        return {"metadata": {"matchId": match_id}, "info": {"frames": []}}


def test_collector_preserves_gzip_bronze_and_resumes(tmp_path) -> None:
    client = FakeClient()
    collector = RiotCollector(client, tmp_path)  # type: ignore[arg-type]
    assert collector.collect(["KR_1", "KR_1"]) == {
        "completed": 1,
        "skipped": 0,
        "excluded": 0,
        "failed": 0,
    }
    assert collector.collect(["KR_1"]) == {
        "completed": 0,
        "skipped": 1,
        "excluded": 0,
        "failed": 0,
    }
    assert client.calls == 2
    with gzip.open(tmp_path / "bronze/riot/KR_1/match.json.gz", "rt") as stream:
        assert json.load(stream)["metadata"]["matchId"] == "KR_1"
    with Checkpoint(tmp_path / "bronze/checkpoint.sqlite3") as checkpoint:
        assert checkpoint.status("KR_1") == "completed"


@pytest.mark.parametrize("match_id", ["../KR_1", "KR/1", "KR_1/../../escape", "KR_1!"])
def test_collector_rejects_noncanonical_match_ids(tmp_path, match_id: str) -> None:
    collector = RiotCollector(FakeClient(), tmp_path)  # type: ignore[arg-type]
    assert collector.collect([match_id]) == {
        "completed": 0,
        "skipped": 0,
        "excluded": 0,
        "failed": 1,
    }
    assert not (tmp_path / "escape").exists()


def test_collector_excludes_surrenders_before_fetching_timeline(tmp_path) -> None:
    class SurrenderClient(FakeClient):
        def match(self, match_id: str) -> dict:
            self.calls += 1
            return {
                "metadata": {"matchId": match_id},
                "info": {"participants": [{"gameEndedInSurrender": True}]},
            }

    client = SurrenderClient()
    result = RiotCollector(client, tmp_path).collect(["KR_1"])
    assert result["excluded"] == 1
    assert result["completed"] == 0
    assert client.calls == 1
    assert not (tmp_path / "bronze/riot/KR_1").exists()


def test_crawler_expands_participant_puuids_and_enriches_rank(tmp_path) -> None:
    class CrawlClient:
        def match_ids(self, puuid: str, *, start: int, count: int, queue: int) -> list[str]:
            assert start == 0
            assert count == 5
            return ["KR_1"] if puuid == "seed" and queue == 420 else []

        def match(self, match_id: str) -> dict:
            return {
                "metadata": {"matchId": match_id},
                "info": {
                    "queueId": 420,
                    "participants": [{"puuid": "seed"}, {"puuid": "next"}],
                },
            }

        def timeline(self, match_id: str) -> dict:
            return {"metadata": {"matchId": match_id}, "info": {"frames": []}}

        def league_entries(self, puuid: str) -> list[dict]:
            return [
                {
                    "queueType": "RANKED_SOLO_5x5",
                    "tier": "CHALLENGER" if puuid == "seed" else "MASTER",
                    "rank": "I",
                    "leaguePoints": 500,
                }
            ]

    crawler = RiotCrawler(CrawlClient(), tmp_path)  # type: ignore[arg-type]
    result = crawler.crawl(
        "seed",
        queue_ids=(420,),
        matches_per_player=5,
        max_players=2,
        max_matches=2,
        max_depth=1,
    )

    assert result.players_visited == 2
    assert result.players_discovered == 2
    assert result.matches_completed == 1
    with gzip.open(tmp_path / "bronze/riot/KR_1/match.json.gz", "rt") as stream:
        stored = json.load(stream)
    assert stored["info"]["participants"][0]["_lodRankTier"] == "CHALLENGER"


def test_crawler_continues_with_the_next_match_page_across_runs(tmp_path) -> None:
    class PagingClient:
        starts: list[int] = []

        def match_ids(self, _puuid: str, *, start: int, count: int, queue: int) -> list[str]:
            assert count == 1
            assert queue == 420
            self.starts.append(start)
            return [f"KR_{start + 1}"]

        def match(self, match_id: str) -> dict:
            return {
                "metadata": {"matchId": match_id},
                "info": {"queueId": 420, "participants": [{"puuid": "seed"}]},
            }

        def timeline(self, match_id: str) -> dict:
            return {"metadata": {"matchId": match_id}, "info": {"frames": []}}

    client = PagingClient()
    crawler = RiotCrawler(client, tmp_path)  # type: ignore[arg-type]

    first = crawler.crawl(
        "seed",
        queue_ids=(420,),
        matches_per_player=1,
        max_players=1,
        max_depth=0,
        fetch_tiers=False,
    )
    second = crawler.crawl(
        "seed",
        queue_ids=(420,),
        matches_per_player=1,
        max_players=1,
        max_depth=0,
        fetch_tiers=False,
    )

    assert client.starts == [0, 0, 1]
    assert first.matches_completed == second.matches_completed == 1
    assert (tmp_path / "bronze/riot/KR_1/match.json.gz").exists()
    assert (tmp_path / "bronze/riot/KR_2/match.json.gz").exists()
