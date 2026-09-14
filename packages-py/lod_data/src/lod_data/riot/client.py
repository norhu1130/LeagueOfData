"""Match-V5 HTTP client that keeps API keys only in request headers."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

import httpx

from .rate_limit import HeaderRateLimiter


class RiotApiError(RuntimeError):
    def __init__(self, status_code: int, path: str) -> None:
        self.status_code = status_code
        super().__init__(f"Riot API 요청 실패 ({status_code}): {path}")


class RiotApiClient:
    def __init__(
        self,
        api_key: str,
        *,
        routing: str = "asia",
        platform: str = "kr",
        transport: httpx.BaseTransport | None = None,
        limiter: HeaderRateLimiter | None = None,
        max_retries: int = 5,
        on_rate_limit: Callable[[str], None] | None = None,
        on_wait: Callable[[float], None] | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("RIOT_API_KEY가 필요합니다.")
        headers = {"X-Riot-Token": api_key, "Accept": "application/json"}
        self._regional = httpx.Client(
            base_url=f"https://{routing}.api.riotgames.com",
            headers=headers,
            timeout=30,
            transport=transport,
        )
        self._platform = httpx.Client(
            base_url=f"https://{platform}.api.riotgames.com",
            headers=headers,
            timeout=30,
            transport=transport,
        )
        self._limiter = limiter or HeaderRateLimiter(on_wait=on_wait)
        self._max_retries = max_retries
        self._on_rate_limit = on_rate_limit
        self._regional_scope = routing.lower()
        self._platform_scope = platform.lower()

    def get_json(
        self,
        path: str,
        *,
        method_scope: str,
        platform: bool = False,
    ) -> dict[str, Any] | list[Any]:
        region_scope = self._platform_scope if platform else self._regional_scope
        # Riot may account platform and regional routes serving the same shard together. A shared
        # application bucket is conservative; endpoint buckets remain host-specific.
        app_scope = "app"
        endpoint_scope = f"{region_scope}:method:{method_scope}"
        for attempt in range(self._max_retries + 1):
            client = self._platform if platform else self._regional
            self._limiter.wait((app_scope, endpoint_scope))
            response = client.get(path)
            if response.status_code == 200:
                self._update_limits(response, app_scope, endpoint_scope)
                return response.json()
            if response.status_code == 429:
                retry = float(response.headers.get("Retry-After", "1"))
                limit_type = response.headers.get("X-Rate-Limit-Type", "service/unknown")
                if self._on_rate_limit is not None:
                    app_count = response.headers.get("X-App-Rate-Limit-Count", "-")
                    method_count = response.headers.get("X-Method-Rate-Limit-Count", "-")
                    self._on_rate_limit(
                        f"429 수신 · {region_scope}/{method_scope} · 종류 {limit_type} · "
                        f"Retry-After {retry:.1f}초 · app {app_count} · method {method_count}"
                    )
                blocked_scope = endpoint_scope if limit_type.lower() == "method" else app_scope
                self._limiter.reset(blocked_scope)
                self._limiter.block(blocked_scope, retry)
                continue
            self._update_limits(response, app_scope, endpoint_scope)
            if response.status_code >= 500 and attempt < self._max_retries:
                time.sleep(min(2**attempt, 8))
                continue
            raise RiotApiError(response.status_code, path)
        raise RiotApiError(429, path)

    def _update_limits(
        self,
        response: httpx.Response,
        app_scope: str,
        endpoint_scope: str,
    ) -> None:
        headers = response.headers
        self._limiter.update(
            app_scope,
            headers.get("X-App-Rate-Limit"),
            headers.get("X-App-Rate-Limit-Count"),
        )
        self._limiter.update(
            endpoint_scope,
            headers.get("X-Method-Rate-Limit"),
            headers.get("X-Method-Rate-Limit-Count"),
        )

    def account_by_riot_id(self, game_name: str, tag_line: str) -> dict[str, Any]:
        result = self.get_json(
            f"/riot/account/v1/accounts/by-riot-id/{quote(game_name, safe='')}/"
            f"{quote(tag_line, safe='')}",
            method_scope="account_by_riot_id",
        )
        if not isinstance(result, dict) or not isinstance(result.get("puuid"), str):
            raise TypeError("ACCOUNT-V1 Riot ID 응답 형식이 올바르지 않습니다.")
        return result

    def match_ids(
        self,
        puuid: str,
        *,
        start: int = 0,
        count: int = 100,
        queue: int | None = None,
    ) -> list[str]:
        query = f"start={start}&count={count}"
        if queue is not None:
            query += f"&queue={queue}"
        result = self.get_json(
            f"/lol/match/v5/matches/by-puuid/{quote(puuid, safe='')}/ids?{query}",
            method_scope="match_ids",
        )
        if not isinstance(result, list) or not all(isinstance(item, str) for item in result):
            raise TypeError("Match-V5 경기 목록 응답 형식이 올바르지 않습니다.")
        return result

    def match(self, match_id: str) -> dict[str, Any]:
        result = self.get_json(f"/lol/match/v5/matches/{match_id}", method_scope="match")
        if not isinstance(result, dict):
            raise TypeError("Match-V5 경기 응답 형식이 올바르지 않습니다.")
        return result

    def timeline(self, match_id: str) -> dict[str, Any]:
        result = self.get_json(
            f"/lol/match/v5/matches/{match_id}/timeline",
            method_scope="timeline",
        )
        if not isinstance(result, dict):
            raise TypeError("Match-V5 타임라인 응답 형식이 올바르지 않습니다.")
        return result

    def league_entries(self, puuid: str) -> list[dict[str, Any]]:
        result = self.get_json(
            f"/lol/league/v4/entries/by-puuid/{quote(puuid, safe='')}",
            method_scope="league_entries",
            platform=True,
        )
        if not isinstance(result, list) or not all(isinstance(item, dict) for item in result):
            raise TypeError("LEAGUE-V4 티어 응답 형식이 올바르지 않습니다.")
        return result

    def close(self) -> None:
        self._regional.close()
        self._platform.close()

    def __enter__(self) -> RiotApiClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()
