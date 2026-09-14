"""Small ASGI guards for the local analytics service request boundary."""

from __future__ import annotations

import ipaddress
import re
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from urllib.parse import urlsplit

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_PUBLIC_BLOCKED_PATHS = frozenset({"/api/v1/catalog/health", "/docs", "/redoc", "/openapi.json"})
_PUBLIC_API_ROUTES = frozenset(
    {
        ("GET", "/api/v1/ai/status"),
        ("POST", "/api/v1/ai/dsl"),
        ("POST", "/api/v1/ai/interpret"),
        ("GET", "/api/v1/catalog"),
        ("POST", "/api/v1/analyses/bias-audit"),
        ("POST", "/api/v1/analyses/run"),
    }
)
_PUBLIC_RUN_ROUTE = re.compile(r"^/api/v1/runs/[0-9a-f]{32}(?:/events)?$")
_PUBLIC_WEB_PATHS = frozenset({"/", "/regions", "/settings", "/data-sources"})
_PUBLIC_COMMON_HEADERS = (
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
)
_PUBLIC_API_CSP = (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'")
_PUBLIC_NO_STORE = (b"cache-control", b"no-store")
_PUBLIC_WEB_CSP = (
    b"content-security-policy",
    b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    b"img-src 'self' data: blob: https://ddragon.leagueoflegends.com; "
    b"font-src 'self' data:; connect-src 'self' https://ddragon.leagueoflegends.com; "
    b"worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
)


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


def _is_same_origin(origin: str, host: str | None, scheme: str) -> bool:
    if not host:
        return False
    try:
        parsed = urlsplit(origin)
        return (
            parsed.scheme == scheme
            and parsed.scheme in {"http", "https"}
            and parsed.netloc.lower() == host.lower()
        )
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
        allow_same_origin: Callable[[], bool],
    ) -> None:
        self.app = app
        self._max_body_bytes = max_body_bytes
        self._allowed_origins = allowed_origins
        self._allow_same_origin = allow_same_origin

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
            strict_same_origin = self._allow_same_origin()
            accepted = (
                _is_same_origin(origin, headers.get("host"), scope.get("scheme", "http"))
                if strict_same_origin
                else origin.rstrip("/") in configured or _is_loopback_origin(origin)
            )
            if not accepted:
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


class PublicInstanceMiddleware:
    """Apply the fail-closed API profile used by an internet-facing demo instance."""

    _MAX_TRACKED_CLIENTS = 10_000

    def __init__(
        self,
        app: ASGIApp,
        *,
        enabled: Callable[[], bool],
        requests_per_minute: Callable[[], int],
    ) -> None:
        self.app = app
        self._enabled = enabled
        self._requests_per_minute = requests_per_minute
        self._requests: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self._enabled():
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        method = scope.get("method", "GET").upper()
        security_headers = self._security_headers(path)
        api_request = path == "/api" or path.startswith("/api/")
        if api_request and not self._admit(scope):
            await self._response(
                429,
                "공개 데모의 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.",
                scope,
                receive,
                send,
                security_headers=security_headers,
                extra_headers=[(b"retry-after", b"60")],
            )
            return

        if not self._allowed(method, path):
            await self._response(
                404,
                "공개 데모에서는 사용할 수 없는 기능입니다.",
                scope,
                receive,
                send,
                security_headers=security_headers,
            )
            return

        async def secure_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                present = {key.lower() for key, _ in headers}
                headers.extend(
                    (key, value) for key, value in security_headers if key not in present
                )
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, secure_send)

    @staticmethod
    def _allowed(method: str, path: str) -> bool:
        if path in _PUBLIC_BLOCKED_PATHS:
            return False
        if path in {"/healthz", "/readyz"}:
            return method in {"GET", "HEAD"}
        if path == "/api" or path.startswith("/api/"):
            if (method, path) in _PUBLIC_API_ROUTES:
                return True
            if not _PUBLIC_RUN_ROUTE.fullmatch(path):
                return False
            return method == "GET" or (method == "DELETE" and not path.endswith("/events"))
        web_path = (
            path in _PUBLIC_WEB_PATHS or path.startswith("/a/") or path.startswith("/assets/")
        )
        return web_path and method in {"GET", "HEAD"}

    @staticmethod
    def _security_headers(path: str) -> tuple[tuple[bytes, bytes], ...]:
        api_response = path.startswith("/api/") or path in {
            "/healthz",
            "/readyz",
            "/docs",
            "/redoc",
            "/openapi.json",
        }
        if api_response:
            return (*_PUBLIC_COMMON_HEADERS, _PUBLIC_API_CSP, _PUBLIC_NO_STORE)
        return (*_PUBLIC_COMMON_HEADERS, _PUBLIC_WEB_CSP)

    def _admit(self, scope: Scope) -> bool:
        client = scope.get("client")
        address = str(client[0]) if client else "unknown"
        now = time.monotonic()
        cutoff = now - 60.0
        limit = self._requests_per_minute()
        with self._lock:
            requests = self._requests.get(address)
            if requests is None:
                if len(self._requests) >= self._MAX_TRACKED_CLIENTS:
                    self._requests.popitem(last=False)
                requests = deque()
                self._requests[address] = requests
            else:
                self._requests.move_to_end(address)
            while requests and requests[0] <= cutoff:
                requests.popleft()
            if len(requests) >= limit:
                return False
            requests.append(now)
            return True

    @staticmethod
    async def _response(
        status_code: int,
        message_ko: str,
        scope: Scope,
        receive: Receive,
        send: Send,
        *,
        security_headers: tuple[tuple[bytes, bytes], ...],
        extra_headers: list[tuple[bytes, bytes]] | None = None,
    ) -> None:
        response = JSONResponse(
            status_code=status_code,
            content={"detail": {"code": "E-PUBLIC-INSTANCE", "messageKo": message_ko}},
        )
        response.raw_headers.extend(security_headers)
        response.raw_headers.extend(extra_headers or [])
        await response(scope, receive, send)
