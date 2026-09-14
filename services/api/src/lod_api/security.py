"""Small ASGI guards for the local analytics service request boundary."""

from __future__ import annotations

import ipaddress
from collections.abc import Callable
from urllib.parse import urlsplit

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _is_loopback_origin(origin: str) -> bool:
    """Accept browser origins hosted on localhost, independent of their dev-server port."""
    try:
        parsed = urlsplit(origin)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        if parsed.hostname.lower() == "localhost":
            return True
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return False


class RequestBoundaryMiddleware:
    """Reject hostile browser origins and oversized analysis bodies before JSON decoding."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        max_body_bytes: Callable[[], int],
        allowed_origins: Callable[[], set[str]],
    ) -> None:
        self.app = app
        self._max_body_bytes = max_body_bytes
        self._allowed_origins = allowed_origins

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        method = scope.get("method", "GET").upper()
        origin = headers.get("origin")
        if method in _MUTATING_METHODS and origin is not None:
            configured = self._allowed_origins()
            if origin.rstrip("/") not in configured and not _is_loopback_origin(origin):
                await JSONResponse(
                    status_code=403,
                    content={
                        "detail": {
                            "code": "E-SEC-001",
                            "messageKo": "허용되지 않은 웹 출처의 요청입니다.",
                        }
                    },
                )(scope, receive, send)
                return

        if method not in {"POST", "PUT", "PATCH"} or not scope.get("path", "").startswith(
            "/api/v1/"
        ):
            await self.app(scope, receive, send)
            return

        limit = self._max_body_bytes()
        content_length = headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > limit:
                    await self._too_large(scope, receive, send)
                    return
            except ValueError:
                await JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})(
                    scope, receive, send
                )
                return

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > limit:
                await self._too_large(scope, receive, send)
                return
            if not message.get("more_body", False):
                break

        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if delivered:
                return {"type": "http.disconnect"}
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)

    @staticmethod
    async def _too_large(scope: Scope, receive: Receive, send: Send) -> None:
        await JSONResponse(
            status_code=413,
            content={
                "detail": {
                    "code": "E-SEC-002",
                    "messageKo": "요청의 크기가 허용 범위를 넘었습니다.",
                }
            },
        )(scope, receive, send)
