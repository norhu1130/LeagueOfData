"""Service settings for a local-first, loopback-bound application."""

from __future__ import annotations

import ipaddress
import os
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from lod_api.runtime_profile import is_public_instance


def _repo_root() -> Path:
    # Walk four levels from the module directory to the repository root.
    return Path(__file__).resolve().parents[4]


def _memory_limit() -> str:
    """Use 60% of physical memory for a local instance."""
    try:
        total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        return f"{max(1, int(total * 0.6 / 1e9))}GB"
    except (ValueError, OSError, AttributeError):
        return "4GB"


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
        if self.public_instance:
            # The dedicated public executable ignores LOD_HOST and always binds to loopback.
            return self
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
        if self.public_instance:
            # The public process remains loopback-bound; the edge proxy owns the external hostname.
            return ["*"]
        return [host.strip() for host in self.trusted_hosts.split(",") if host.strip()]

    @property
    def allowed_origin_set(self) -> set[str]:
        if self.public_instance:
            # The public server is same-origin only. Ambient local configuration must not widen
            # the browser request boundary of an internet-facing process.
            return set()
        return {
            origin.strip().rstrip("/")
            for origin in self.allowed_origins.split(",")
            if origin.strip()
        }

    @property
    def public_instance(self) -> bool:
        return is_public_instance()

    @property
    def public_requests_per_minute(self) -> int:
        return 120

    @property
    def effective_max_request_body_bytes(self) -> int:
        return (
            min(self.max_request_body_bytes, 1_048_576)
            if self.public_instance
            else self.max_request_body_bytes
        )

    @property
    def effective_max_ast_bytes(self) -> int:
        return min(self.max_ast_bytes, 256_000) if self.public_instance else self.max_ast_bytes

    @property
    def effective_max_ast_nodes(self) -> int:
        return min(self.max_ast_nodes, 1_000) if self.public_instance else self.max_ast_nodes

    @property
    def effective_max_ast_depth(self) -> int:
        return min(self.max_ast_depth, 64) if self.public_instance else self.max_ast_depth

    @property
    def effective_max_ast_string_length(self) -> int:
        return (
            min(self.max_ast_string_length, 4_096)
            if self.public_instance
            else self.max_ast_string_length
        )

    @property
    def effective_max_regions(self) -> int:
        return min(self.max_regions, 64) if self.public_instance else self.max_regions

    @property
    def effective_max_region_bytes(self) -> int:
        return (
            min(self.max_region_bytes, 512_000) if self.public_instance else self.max_region_bytes
        )

    @property
    def effective_max_region_vertices(self) -> int:
        return (
            min(self.max_region_vertices, 512) if self.public_instance else self.max_region_vertices
        )

    @property
    def effective_max_concurrent_runs(self) -> int:
        return (
            min(self.max_concurrent_runs, 2) if self.public_instance else self.max_concurrent_runs
        )

    @property
    def effective_max_queued_runs(self) -> int:
        return min(self.max_queued_runs, 8) if self.public_instance else self.max_queued_runs

    @property
    def effective_run_ttl_seconds(self) -> int:
        return min(self.run_ttl_seconds, 600) if self.public_instance else self.run_ttl_seconds

    @property
    def effective_max_cache_entries(self) -> int:
        return 16 if self.public_instance else 64

    @property
    def effective_query_timeout_seconds(self) -> float | None:
        return 30.0 if self.public_instance else None

    @property
    def effective_duckdb_threads(self) -> int:
        cpu = os.cpu_count() or 4
        normal = max(1, cpu // 2)
        return min(normal, 2) if self.public_instance else normal

    @property
    def effective_duckdb_memory_limit(self) -> str:
        return "1024MB" if self.public_instance else _memory_limit()

    @property
    def effective_duckdb_temp_directory_limit(self) -> str | None:
        return "2GB" if self.public_instance else None

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
