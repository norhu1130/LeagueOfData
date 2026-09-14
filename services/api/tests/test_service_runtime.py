from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from lod_api import runtime_profile
from lod_api.config import Settings, settings
from lod_api.main import app, create_app, run
from lod_api.runs import manager
from lod_api.security import PublicInstanceMiddleware
from pydantic import ValidationError


def test_default_server_host_is_loopback() -> None:
    assert settings.host in {"127.0.0.1", "::1", "localhost"}


def test_untrusted_host_header_is_rejected() -> None:
    response = TestClient(app).get("/healthz", headers={"Host": "attacker.example"})

    assert response.status_code == 400


def test_remote_bind_requires_explicit_opt_in() -> None:
    with pytest.raises(ValidationError):
        Settings(host="0.0.0.0", allow_remote_bind=False, _env_file=None)

    configured = Settings(host="0.0.0.0", allow_remote_bind=True, _env_file=None)
    assert configured.host == "0.0.0.0"


def test_public_profile_cannot_be_enabled_by_environment(monkeypatch) -> None:
    monkeypatch.setattr(runtime_profile, "_public_instance", False)
    monkeypatch.setenv("PUBLIC_INSTANCE", "true")
    monkeypatch.setenv("LOD_PUBLIC_INSTANCE", "true")
    configured = Settings(_env_file=None)

    assert configured.public_instance is False


def test_public_profile_uses_fixed_resource_limits(monkeypatch) -> None:
    monkeypatch.setattr(runtime_profile, "_public_instance", True)
    configured = Settings(
        allowed_origins="https://attacker.example",
        max_request_body_bytes=8_000_000,
        max_ast_bytes=8_000_000,
        max_ast_nodes=8_000,
        max_ast_depth=800,
        max_ast_string_length=80_000,
        max_regions=800,
        max_region_bytes=8_000_000,
        max_region_vertices=8_000,
        run_ttl_seconds=8_000,
        _env_file=None,
    )

    assert configured.public_instance is True
    assert configured.effective_max_concurrent_runs == 2
    assert configured.effective_max_queued_runs == 8
    assert configured.effective_query_timeout_seconds == 30
    assert configured.effective_duckdb_threads <= 2
    assert configured.effective_duckdb_memory_limit == "1024MB"
    assert configured.effective_duckdb_temp_directory_limit == "2GB"
    assert configured.allowed_origin_set == set()
    assert configured.effective_max_request_body_bytes == 1_048_576
    assert configured.effective_max_ast_bytes == 256_000
    assert configured.effective_max_ast_nodes == 1_000
    assert configured.effective_max_ast_depth == 64
    assert configured.effective_max_ast_string_length == 4_096
    assert configured.effective_max_regions == 64
    assert configured.effective_max_region_bytes == 512_000
    assert configured.effective_max_region_vertices == 512
    assert configured.effective_run_ttl_seconds == 600
    assert configured.effective_max_cache_entries == 16


def test_public_executable_profile_ignores_remote_bind_configuration(monkeypatch) -> None:
    monkeypatch.setattr(runtime_profile, "_public_instance", True)

    configured = Settings(host="0.0.0.0", allow_remote_bind=False, _env_file=None)

    assert configured.public_instance is True


def test_public_instance_blocks_management_and_diagnostics(monkeypatch) -> None:
    monkeypatch.setattr(runtime_profile, "_public_instance", True)
    client = TestClient(create_app())

    for path in (
        "/docs",
        "/openapi.json",
        "/api/v1/data-sources",
        "/api/v1/catalog/health",
        "/api/v1/runs/not-a-run/explain",
        "/api/v1/runs/not-a-run/matches",
        "/api/v1/matches/KR_1?runId=not-a-run",
    ):
        assert client.get(path).status_code == 404

    assert client.get("/api/v1/ai/status").status_code == 200
    assert (
        client.put("/api/v1/ai/config", json={"api_key": "sk-or-v1-visitor-key"}).status_code == 404
    )
    assert client.delete("/api/v1/ai/config").status_code == 404

    health = client.get("/healthz")
    assert health.json() == {"status": "ok"}
    assert health.headers["x-content-type-options"] == "nosniff"
    assert health.headers["x-frame-options"] == "DENY"
    assert health.headers["cache-control"] == "no-store"


def test_public_api_allowlist_is_fail_closed() -> None:
    allowed = PublicInstanceMiddleware._allowed

    assert allowed("GET", "/api/v1/catalog") is True
    assert allowed("POST", "/api/v1/analyses/bias-audit") is True
    assert allowed("POST", "/api/v1/analyses/run") is True
    assert allowed("GET", "/api/v1/ai/status") is True
    assert allowed("POST", "/api/v1/ai/dsl") is True
    assert allowed("POST", "/api/v1/ai/interpret") is True
    assert allowed("GET", f"/api/v1/runs/{'a' * 32}") is True
    assert allowed("GET", f"/api/v1/runs/{'a' * 32}/events") is True
    assert allowed("DELETE", f"/api/v1/runs/{'a' * 32}") is True
    assert allowed("GET", "/") is True
    assert allowed("GET", "/regions") is True
    assert allowed("GET", "/assets/index.js") is True
    assert allowed("GET", "/readyz") is True

    assert allowed("GET", "/api/v1/future-sensitive-endpoint") is False
    assert allowed("PUT", "/api/v1/ai/config") is False
    assert allowed("DELETE", "/api/v1/ai/config") is False
    assert allowed("GET", f"/api/v1/runs/{'a' * 32}/explain") is False
    assert allowed("DELETE", f"/api/v1/runs/{'a' * 32}/events") is False
    assert allowed("GET", "/metrics") is False
    assert allowed("POST", "/future-admin") is False


def test_public_profile_rejects_websockets() -> None:
    downstream = Mock()
    sent = []
    middleware = PublicInstanceMiddleware(
        app=downstream, enabled=lambda: True, requests_per_minute=lambda: 120
    )

    async def receive():
        return {"type": "websocket.connect"}

    async def send(message):
        sent.append(message)

    asyncio.run(
        middleware(
            {"type": "websocket", "path": "/api/v1/future"},
            receive,
            send,
        )
    )

    downstream.assert_not_called()
    assert sent == [{"type": "websocket.close", "code": 1008}]


def test_public_instance_rate_limits_api_clients(monkeypatch) -> None:
    monkeypatch.setattr(runtime_profile, "_public_instance", True)
    monkeypatch.setattr(Settings, "public_requests_per_minute", property(lambda _self: 2))
    client = TestClient(create_app())

    assert client.get("/api/v1/unknown").status_code == 404
    assert client.get("/api/v1/unknown").status_code == 404
    limited = client.get("/api/v1/unknown")

    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "60"


def test_public_rate_limiter_bounds_tracked_client_memory(monkeypatch) -> None:
    monkeypatch.setattr(PublicInstanceMiddleware, "_MAX_TRACKED_CLIENTS", 2)
    middleware = PublicInstanceMiddleware(
        app=Mock(), enabled=lambda: True, requests_per_minute=lambda: 120
    )

    for address in ("192.0.2.1", "192.0.2.2", "192.0.2.3"):
        assert middleware._admit({"client": (address, 1234)}) is True

    assert list(middleware._requests) == ["192.0.2.2", "192.0.2.3"]


def test_public_instance_accepts_only_same_origin_browser_writes(monkeypatch) -> None:
    monkeypatch.setattr(runtime_profile, "_public_instance", True)
    client = TestClient(create_app(), base_url="https://demo.example")

    same_origin = client.post(
        "/api/v1/analyses/run", headers={"Origin": "https://demo.example"}, json={}
    )
    foreign_origin = client.post(
        "/api/v1/analyses/run", headers={"Origin": "https://attacker.example"}, json={}
    )
    foreign_loopback_origin = client.post(
        "/api/v1/analyses/run", headers={"Origin": "http://localhost:5173"}, json={}
    )
    wrong_scheme = client.post(
        "/api/v1/analyses/run", headers={"Origin": "http://demo.example"}, json={}
    )

    assert same_origin.status_code == 422
    assert foreign_origin.status_code == 403
    assert foreign_loopback_origin.status_code == 403
    assert wrong_scheme.status_code == 403


def test_global_run_manager_uses_configured_capacity() -> None:
    assert manager._max_workers == settings.effective_max_concurrent_runs
    assert manager._max_queued_runs == settings.effective_max_queued_runs
    assert manager._max_cache_entries == settings.effective_max_cache_entries
    assert manager._run_ttl_seconds == settings.effective_run_ttl_seconds


def test_reload_is_disabled_outside_development(monkeypatch) -> None:
    uvicorn_run = Mock()
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(run=uvicorn_run))
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "reload", True)

    run()

    uvicorn_run.assert_called_once_with(
        "lod_api.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


def test_public_server_has_fixed_network_boundaries(monkeypatch) -> None:
    from lod_api import public

    uvicorn_run = Mock()
    public_app = Mock()
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(run=uvicorn_run))
    monkeypatch.setattr(public, "create_public_app", lambda: public_app)

    public.run()

    uvicorn_run.assert_called_once_with(
        public_app,
        host="127.0.0.1",
        port=8000,
        reload=False,
        proxy_headers=True,
        forwarded_allow_ips="127.0.0.1",
        limit_concurrency=100,
        backlog=128,
        timeout_keep_alive=5,
        timeout_graceful_shutdown=10,
        server_header=False,
    )
