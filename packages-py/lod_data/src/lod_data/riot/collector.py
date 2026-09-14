"""Resumable collector that preserves original match and timeline JSON as gzip bronze data."""

from __future__ import annotations

import gzip
import json
import re
from collections.abc import Iterable
from pathlib import Path

from .checkpoint import Checkpoint
from .client import RiotApiClient

_MATCH_ID = re.compile(r"^[A-Z0-9]+_[0-9]+$")


class RiotCollector:
    def __init__(self, client: RiotApiClient, data_dir: Path) -> None:
        self.client = client
        self.bronze = data_dir / "bronze" / "riot"
        self.checkpoint_path = data_dir / "bronze" / "checkpoint.sqlite3"

    def collect(
        self, match_ids: Iterable[str], *, exclude_surrenders: bool = True
    ) -> dict[str, int]:
        counts = {"completed": 0, "skipped": 0, "excluded": 0, "failed": 0}
        with Checkpoint(self.checkpoint_path) as checkpoint:
            for match_id in dict.fromkeys(match_ids):
                try:
                    self._path(match_id, "match")
                    self._path(match_id, "timeline")
                except ValueError:
                    counts["failed"] += 1
                    continue
                previous = checkpoint.status(match_id)
                if previous == "excluded" or (
                    previous == "completed" and self.paths_exist(match_id)
                ):
                    counts["skipped"] += 1
                    continue
                checkpoint.mark(match_id, "running")
                try:
                    match = self.client.match(match_id)
                    if exclude_surrenders and is_surrendered(match):
                        checkpoint.mark(match_id, "excluded", "surrender")
                        counts["excluded"] += 1
                        continue
                    timeline = self.client.timeline(match_id)
                    self.store(match_id, match, timeline)
                except Exception as exc:  # noqa: BLE001 — record failure and continue collecting
                    checkpoint.mark(match_id, "failed", str(exc))
                    counts["failed"] += 1
                    continue
                checkpoint.mark(match_id, "completed")
                counts["completed"] += 1
        return counts

    def store(self, match_id: str, match: dict, timeline: dict) -> None:
        """Persist one already-fetched pair after the caller applies collection policy."""
        self._write(match_id, "match", match)
        self._write(match_id, "timeline", timeline)

    def store_match(self, match_id: str, match: dict) -> None:
        """Replace preserved match metadata while keeping its existing timeline."""
        self._write(match_id, "match", match)

    def load_match(self, match_id: str) -> dict:
        with gzip.open(self._path(match_id, "match"), "rt", encoding="utf-8") as stream:
            payload = json.load(stream)
        if not isinstance(payload, dict):
            raise TypeError("저장된 Riot 매치 형식이 올바르지 않습니다.")
        return payload

    def _path(self, match_id: str, kind: str) -> Path:
        if not _MATCH_ID.fullmatch(match_id):
            raise ValueError(f"Invalid Match-V5 match ID: {match_id!r}")
        if kind not in {"match", "timeline"}:
            raise ValueError(f"Invalid bronze record kind: {kind!r}")
        path = (self.bronze / match_id / f"{kind}.json.gz").resolve(strict=False)
        if not path.is_relative_to(self.bronze.resolve(strict=False)):
            raise ValueError(f"Bronze path escapes its root: {path}")
        return path

    def paths_exist(self, match_id: str) -> bool:
        return self._path(match_id, "match").exists() and self._path(match_id, "timeline").exists()

    def _write(self, match_id: str, kind: str, payload: object) -> None:
        path = self._path(match_id, kind)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        with gzip.open(temporary, "wt", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
        temporary.replace(path)


def is_surrendered(match: dict) -> bool:
    participants = match.get("info", {}).get("participants", [])
    return any(
        participant.get("gameEndedInSurrender") or participant.get("gameEndedInEarlySurrender")
        for participant in participants
        if isinstance(participant, dict)
    )
