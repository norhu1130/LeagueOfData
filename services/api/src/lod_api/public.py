"""One-process public demo server for the built web application and restricted API."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from lod_api.runtime_profile import enable_public_instance


def _web_dist() -> Path:
    return Path(__file__).resolve().parents[4] / "apps" / "web" / "dist"


def create_public_app() -> FastAPI:
    enable_public_instance()

    # Import only after selecting the profile: settings, DuckDB, and the global run manager are
    # initialized while their modules are imported.
    from lod_api.main import create_app

    dist = _web_dist()
    index = dist / "index.html"
    assets = dist / "assets"
    if not index.is_file() or not assets.is_dir():
        raise RuntimeError("웹 빌드가 없습니다. `pnpm -F @lol/web build`를 먼저 실행하세요.")

    app = create_app()
    app.mount("/assets", StaticFiles(directory=assets), name="web-assets")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def web_application(path: str) -> FileResponse:
        if path.startswith("api/") or path in {
            "healthz",
            "readyz",
            "docs",
            "redoc",
            "openapi.json",
        }:
            raise HTTPException(status_code=404)
        target = (dist / path).resolve()
        if target.is_relative_to(dist) and target.is_file():
            return FileResponse(target)
        return FileResponse(index)

    return app


def run() -> None:
    import uvicorn

    uvicorn.run(
        create_public_app(),
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
