"""Bounded breadth-first Match-V5 crawl through participant PUUIDs."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .checkpoint import Checkpoint
from .client import RiotApiClient
from .collector import RiotCollector, is_surrendered


@dataclass(frozen=True, slots=True)
class CrawlResult:
    players_visited: int
    players_discovered: int
    matches_completed: int
    matches_skipped: int
    matches_excluded: int
    matches_failed: int


class RiotCrawler:
    def __init__(self, client: RiotApiClient, data_dir: Path) -> None:
        self.client = client
        self.collector = RiotCollector(client, data_dir)
        self.checkpoint_path = data_dir / "bronze" / "checkpoint.sqlite3"

    def crawl(
        self,
        seed_puuids: str | Iterable[str],
        *,
        queue_ids: tuple[int, ...] = (420, 480),
        matches_per_player: int = 20,
        max_players: int = 25,
        max_matches: int | None = None,
        max_depth: int = 2,
        exclude_surrenders: bool = True,
        fetch_tiers: bool = True,
        progress: Callable[[str], None] | None = None,
    ) -> CrawlResult:
        seeds = [seed_puuids] if isinstance(seed_puuids, str) else list(seed_puuids)
        seeds = list(dict.fromkeys(puuid for puuid in seeds if puuid))
        if not seeds or not queue_ids:
            raise ValueError("시작 PUUID와 큐를 하나 이상 지정해야 합니다.")
        if min(matches_per_player, max_players) < 1 or (
            max_matches is not None and max_matches < 1
        ):
            raise ValueError("수집 한도는 양수이고 깊이는 0 이상이어야 합니다.")
        if max_depth < 0:
            raise ValueError("수집 한도는 양수이고 깊이는 0 이상이어야 합니다.")

        pending = deque((puuid, 0) for puuid in seeds)
        discovered = set(seeds)
        visited: set[str] = set()
        seen_matches: set[str] = set()
        rank_cache: dict[str, dict[str, Any] | None] = {}
        completed = skipped = excluded = failed = 0

        def report(message: str) -> None:
            if progress is not None:
                progress(message)

        report(
            f"수집 시작 · 시작 계정 {len(seeds)}명 · 큐 {', '.join(map(str, queue_ids))} · "
            f"플레이어 한도 {max_players}명 · 매치 한도 "
            f"{'없음' if max_matches is None else f'{max_matches}경기'}"
        )

        with Checkpoint(self.checkpoint_path) as checkpoint:
            while (
                pending
                and len(visited) < max_players
                and (max_matches is None or completed < max_matches)
            ):
                puuid, depth = pending.popleft()
                if puuid in visited:
                    continue
                visited.add(puuid)
                report(
                    f"플레이어 {len(visited)}/{max_players} 조회 · 깊이 {depth} · "
                    f"PUUID {self._short_puuid(puuid)}"
                )
                match_ids: list[str] = []
                fetched_pages: list[tuple[int, int, int]] = []
                try:
                    for queue_id in queue_ids:
                        start = checkpoint.crawl_start(puuid, queue_id)
                        page_size = min(matches_per_player, 100)
                        if start > 0:
                            recent_matches = self.client.match_ids(
                                puuid,
                                start=0,
                                count=page_size,
                                queue=queue_id,
                            )
                            match_ids.extend(recent_matches)
                            report(
                                f"큐 {queue_id} · 새 경기 확인 {len(recent_matches)}개 · "
                                f"이어서 과거 목록 {start + 1}번째부터 수집"
                            )
                        while True:
                            queue_matches = self.client.match_ids(
                                puuid,
                                start=start,
                                count=page_size,
                                queue=queue_id,
                            )
                            known_page = bool(queue_matches) and all(
                                checkpoint.status(match_id) == "excluded"
                                or (
                                    checkpoint.status(match_id) == "completed"
                                    and self.collector.paths_exist(match_id)
                                )
                                for match_id in queue_matches
                            )
                            if not known_page or len(queue_matches) < page_size:
                                break
                            start += len(queue_matches)
                            checkpoint.advance_crawl(puuid, queue_id, start)
                            report(
                                f"큐 {queue_id} · 이미 저장된 목록 {len(queue_matches)}개를 "
                                f"지나 다음 페이지로 이동"
                            )
                        match_ids.extend(queue_matches)
                        fetched_pages.append((queue_id, start, len(queue_matches)))
                        report(
                            f"큐 {queue_id} · 목록 {start + 1}번째부터 "
                            f"매치 ID {len(queue_matches)}개 발견"
                        )
                except Exception as exc:  # noqa: BLE001 — one player must not terminate the crawl
                    failed += 1
                    report(f"플레이어 조회 실패 · {type(exc).__name__}: {exc}")
                    continue

                processed_all = True
                player_had_failure = False
                for match_id in dict.fromkeys(match_ids):
                    if max_matches is not None and completed >= max_matches:
                        processed_all = False
                        break
                    if match_id in seen_matches:
                        continue
                    seen_matches.add(match_id)
                    previous = checkpoint.status(match_id)
                    if previous == "excluded":
                        skipped += 1
                        report(f"{match_id} · 이전에 제외됨, 건너뜀")
                        continue
                    if previous == "completed" and self.collector.paths_exist(match_id):
                        stored_match = self.collector.load_match(match_id)
                        missing_ranks = sum(
                            1
                            for participant in stored_match.get("info", {}).get("participants", [])
                            if isinstance(participant, dict)
                            and participant.get("puuid")
                            and not participant.get("_lodRankTier")
                        )
                        report(
                            f"{match_id} · 이미 저장됨 · "
                            f"티어 보충 대상 {missing_ranks if fetch_tiers else 0}명"
                        )
                        if depth < max_depth:
                            self._enqueue_participants(stored_match, depth, discovered, pending)
                        if fetch_tiers and self._enrich_ranks(stored_match, rank_cache, progress):
                            self.collector.store_match(match_id, stored_match)
                        skipped += 1
                        report(f"{match_id} · 저장 데이터 재사용 완료")
                        continue
                    checkpoint.mark(match_id, "running")
                    report(f"{match_id} · 매치 메타데이터 요청")
                    try:
                        match = self.client.match(match_id)
                        info = match.get("info", {})
                        if int(info.get("queueId") or 0) not in queue_ids:
                            checkpoint.mark(match_id, "excluded", "queue")
                            excluded += 1
                            report(f"{match_id} · 대상 큐가 아니어서 제외")
                            continue
                        if depth < max_depth:
                            self._enqueue_participants(match, depth, discovered, pending)
                        if exclude_surrenders and is_surrendered(match):
                            checkpoint.mark(match_id, "excluded", "surrender")
                            excluded += 1
                            report(f"{match_id} · 서렌/조기 종료로 제외")
                            continue
                        if fetch_tiers:
                            self._enrich_ranks(match, rank_cache, progress)
                        report(f"{match_id} · 타임라인 요청")
                        timeline = self.client.timeline(match_id)
                        self.collector.store(match_id, match, timeline)
                        checkpoint.mark(match_id, "completed")
                        completed += 1
                        report(f"{match_id} · 저장 완료 ({completed}경기)")
                    except Exception as exc:  # noqa: BLE001 — checkpoint and continue
                        checkpoint.mark(match_id, "failed", str(exc))
                        failed += 1
                        player_had_failure = True
                        report(f"{match_id} · 실패 · {type(exc).__name__}: {exc}")

                if processed_all and not player_had_failure:
                    for queue_id, start, fetched_count in fetched_pages:
                        checkpoint.advance_crawl(puuid, queue_id, start + fetched_count)
                elif fetched_pages:
                    report("완료하지 못한 매치가 있어 다음 실행을 위해 목록 위치를 유지합니다")

        return CrawlResult(
            players_visited=len(visited),
            players_discovered=len(discovered),
            matches_completed=completed,
            matches_skipped=skipped,
            matches_excluded=excluded,
            matches_failed=failed,
        )

    def _solo_rank(self, puuid: str) -> dict[str, Any] | None:
        entries = self.client.league_entries(puuid)
        return next(
            (entry for entry in entries if entry.get("queueType") == "RANKED_SOLO_5x5"),
            {"tier": "UNRANKED", "rank": None, "leaguePoints": None},
        )

    def _enrich_ranks(
        self,
        match: dict[str, Any],
        cache: dict[str, dict[str, Any] | None],
        progress: Callable[[str], None] | None = None,
    ) -> bool:
        changed = False
        for participant in match.get("info", {}).get("participants", []):
            if not isinstance(participant, dict):
                continue
            puuid = participant.get("puuid")
            if not isinstance(puuid, str) or not puuid:
                continue
            if participant.get("_lodRankTier"):
                continue
            if puuid not in cache:
                if progress is not None:
                    progress(f"티어 조회 · PUUID {self._short_puuid(puuid)}")
                try:
                    cache[puuid] = self._solo_rank(puuid)
                except Exception as exc:  # noqa: BLE001 — tier metadata remains best-effort
                    cache[puuid] = None
                    if progress is not None:
                        progress(f"티어 조회 실패 · {type(exc).__name__}: {exc}")
                    continue
                if progress is not None:
                    rank = cache[puuid]
                    label = (
                        "UNRANKED"
                        if rank and rank["tier"] == "UNRANKED"
                        else f"{rank['tier']} {rank['rank']}"
                        if rank
                        else "조회 실패"
                    )
                    progress(f"티어 확인 · {label}")
            rank = cache[puuid]
            if rank:
                participant["_lodRankTier"] = rank["tier"]
                participant["_lodRankDivision"] = rank["rank"]
                participant["_lodLeaguePoints"] = rank["leaguePoints"]
                changed = True
        return changed

    @staticmethod
    def _short_puuid(puuid: str) -> str:
        return f"{puuid[:8]}…{puuid[-4:]}" if len(puuid) > 14 else puuid

    @staticmethod
    def _enqueue_participants(
        match: dict[str, Any],
        depth: int,
        discovered: set[str],
        pending: deque[tuple[str, int]],
    ) -> None:
        for participant in match.get("info", {}).get("participants", []):
            if not isinstance(participant, dict):
                continue
            puuid = participant.get("puuid")
            if isinstance(puuid, str) and puuid and puuid not in discovered:
                discovered.add(puuid)
                pending.append((puuid, depth + 1))
