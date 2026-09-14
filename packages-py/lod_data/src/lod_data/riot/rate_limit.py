"""Multi-window rate limiter reconciled with Riot response headers."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable


def parse_windows(value: str | None) -> list[tuple[int, float]]:
    """Parse `20:1,100:120` into `(allowance, seconds)` pairs."""
    if not value:
        return []
    windows: list[tuple[int, float]] = []
    for item in value.split(","):
        try:
            count, seconds = item.strip().split(":", 1)
            limit = int(count)
            span = float(seconds)
        except (TypeError, ValueError):
            continue
        if limit > 0 and span > 0:
            windows.append((limit, span))
    return windows


class HeaderRateLimiter:
    """Honor authoritative Riot 429 Retry-After barriers without predicting server windows."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        on_wait: Callable[[float], None] | None = None,
    ) -> None:
        self._clock = clock
        self._on_wait = on_wait
        self._blocked_until: dict[str, float] = {}
        self._condition = threading.Condition()

    def wait(self, scopes: Iterable[str]) -> None:
        active_scopes = tuple(scopes)
        with self._condition:
            while True:
                now = self._clock()
                delay = max(
                    (
                        max(0.0, self._blocked_until.get(scope, 0.0) - now)
                        for scope in active_scopes
                    ),
                    default=0.0,
                )
                if delay <= 0:
                    return
                if self._on_wait is not None:
                    self._on_wait(delay)
                self._condition.wait(timeout=delay)

    def block(self, scope: str, retry_after: float) -> None:
        with self._condition:
            self._blocked_until[scope] = max(
                self._blocked_until.get(scope, 0.0),
                self._clock() + max(0.0, retry_after),
            )
            self._condition.notify_all()

    def reset(self, scope: str) -> None:
        """Discard an earlier Retry-After barrier before applying a newer one."""
        with self._condition:
            self._blocked_until.pop(scope, None)
            self._condition.notify_all()

    def update(self, scope: str, limit_header: str | None, count_header: str | None) -> None:
        """Accept response headers for API compatibility; no local window is inferred."""
        del scope, limit_header, count_header
