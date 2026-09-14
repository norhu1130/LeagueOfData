"""Service settings for a local-first, loopback-bound application."""

from __future__ import annotations

import ipaddress
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _repo_root() -> Path:
    # Walk four levels from the module directory to the repository root.
    return Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LOD_", env_file=".env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65_535)
    environment: Literal["development", "test", "production"] = "development"
    reload: bool = False
    allow_remote_bind: bool = False
    trusted_hosts: str = "127.0.0.1,localhost,::1,testserver"
    allowed_origins: str = ""

    #: Optional server-side OpenRouter configuration. The API key is never returned to clients.
    openrouter_api_key: SecretStr | None = None
    openrouter_model: str = "openai/gpt-5.6-luna"
    openrouter_timeout_seconds: float = Field(default=45.0, ge=1.0, le=120.0)

    data_dir: Path = _repo_root() / "data"

    #: Concurrent analysis limit. DuckDB already parallelizes each query, so excessive
    #: concurrency causes thread contention; additional runs wait in the queue.
    max_concurrent_runs: int = Field(default=4, ge=1)

    #: Bound work waiting behind active DuckDB queries. This prevents an accidental request burst
    #: from retaining an unbounded number of ASTs and futures in memory.
    max_queued_runs: int = Field(default=32, ge=0)

    #: Retention period for completed runs and their drill-down state.
    run_ttl_seconds: int = Field(default=600, ge=1)

    #: Public request-complexity limits. These are enforced before a run enters the executor.
    max_ast_bytes: int = Field(default=256_000, ge=1)
    max_ast_nodes: int = Field(default=1_000, ge=1)
    max_ast_depth: int = Field(default=64, ge=1)
    max_ast_string_length: int = Field(default=4_096, ge=1)
    max_regions: int = Field(default=64, ge=0)
    max_region_bytes: int = Field(default=512_000, ge=1)
    max_region_vertices: int = Field(default=512, ge=3)
    max_request_body_bytes: int = Field(default=1_048_576, ge=1)

    @model_validator(mode="after")
    def require_explicit_remote_bind(self) -> Settings:
        try:
            loopback = ipaddress.ip_address(self.host).is_loopback
        except ValueError:
            loopback = self.host.lower() == "localhost"
        if not loopback and not self.allow_remote_bind:
            raise ValueError(
                "A non-loopback LOD_HOST requires the explicit LOD_ALLOW_REMOTE_BIND=true opt-in."
            )
        return self

    @property
    def trusted_host_list(self) -> list[str]:
        return [host.strip() for host in self.trusted_hosts.split(",") if host.strip()]

    @property
    def allowed_origin_set(self) -> set[str]:
        return {
            origin.strip().rstrip("/")
            for origin in self.allowed_origins.split(",")
            if origin.strip()
        }

    @property
    def silver_dir(self) -> Path:
        return self.data_dir / "silver"

    @property
    def reference_dir(self) -> Path:
        return self.data_dir / "reference"

    @property
    def runs_dir(self) -> Path:
        return self.data_dir / "runs"


settings = Settings()
