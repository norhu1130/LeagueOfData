"""SQLite checkpoints for resumable collection."""

from __future__ import annotations

import sqlite3
from pathlib import Path


class Checkpoint:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.execute(
            """CREATE TABLE IF NOT EXISTS matches (
                match_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                error TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )"""
        )
        self.connection.execute(
            """CREATE TABLE IF NOT EXISTS crawl_cursors (
                puuid TEXT NOT NULL,
                queue_id INTEGER NOT NULL,
                next_start INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (puuid, queue_id)
            )"""
        )
        self.connection.commit()

    def status(self, match_id: str) -> str | None:
        row = self.connection.execute(
            "SELECT status FROM matches WHERE match_id = ?", (match_id,)
        ).fetchone()
        return None if row is None else str(row[0])

    def mark(self, match_id: str, status: str, error: str | None = None) -> None:
        self.connection.execute(
            """INSERT INTO matches(match_id, status, error) VALUES (?, ?, ?)
               ON CONFLICT(match_id) DO UPDATE SET
                 status=excluded.status, error=excluded.error, updated_at=CURRENT_TIMESTAMP""",
            (match_id, status, error),
        )
        self.connection.commit()

    def crawl_start(self, puuid: str, queue_id: int) -> int:
        """Return the next Match-V5 list offset for one player and queue."""
        row = self.connection.execute(
            "SELECT next_start FROM crawl_cursors WHERE puuid = ? AND queue_id = ?",
            (puuid, queue_id),
        ).fetchone()
        return 0 if row is None else max(0, int(row[0]))

    def advance_crawl(self, puuid: str, queue_id: int, next_start: int) -> None:
        """Persist a successfully processed Match-V5 list offset."""
        if next_start < 0:
            raise ValueError("crawl cursor cannot be negative")
        self.connection.execute(
            """INSERT INTO crawl_cursors(puuid, queue_id, next_start) VALUES (?, ?, ?)
               ON CONFLICT(puuid, queue_id) DO UPDATE SET
                 next_start=excluded.next_start, updated_at=CURRENT_TIMESTAMP""",
            (puuid, queue_id, next_start),
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> Checkpoint:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()
