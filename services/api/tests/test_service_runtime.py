from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from lod_api.config import Settings, settings
from lod_api.main import app, run
from lod_api.runs import manager
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


def test_global_run_manager_uses_configured_capacity() -> None:
    assert manager._max_workers == settings.max_concurrent_runs
    assert manager._max_queued_runs == settings.max_queued_runs


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
