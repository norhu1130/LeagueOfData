"""FastAPI application accepting only AST JSON and never arbitrary SQL."""

from __future__ import annotations

from fastapi import FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware

from lod_api.config import settings
from lod_api.routers import ai, analyses, catalog, data_sources, health
from lod_api.security import RequestBoundaryMiddleware


def create_app() -> FastAPI:
    app = FastAPI(
        title="LoL Analysis Engine",
        version="0.0.0",
        description="Execute validated ASTs with DuckDB and return results with provenance.",
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.trusted_host_list)
    app.add_middleware(
        RequestBoundaryMiddleware,
        max_body_bytes=lambda: settings.max_request_body_bytes,
        allowed_origins=lambda: settings.allowed_origin_set,
    )
    app.include_router(health.router)
    app.include_router(catalog.router)
    app.include_router(data_sources.router)
    app.include_router(analyses.router)
    app.include_router(ai.router)
    return app


app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run(
        "lod_api.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.reload and settings.environment == "development",
    )
