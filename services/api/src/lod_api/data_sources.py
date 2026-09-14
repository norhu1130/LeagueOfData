"""Session-scoped object-storage data sources for the local DuckDB engine."""

from __future__ import annotations

import hashlib
import re
import threading
import uuid
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import urlsplit

import duckdb
from lod_data.duckdb_views import DERIVED_VIEWS, register_views
from lod_data.layout import read_manifest
from lod_data.schema import TABLES
from pydantic import BaseModel, Field, SecretStr, model_validator

from lod_api.config import settings

_SAFE_ID = re.compile(r"^[a-z][a-z0-9_]{0,62}$")


class DataSourceInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    provider: Literal["s3", "gcs"]
    uri: str = Field(min_length=6, max_length=2048)
    auth_mode: Literal["access_key", "anonymous"] = "access_key"
    access_key_id: SecretStr | None = None
    secret_access_key: SecretStr | None = None
    session_token: SecretStr | None = None
    region: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def validate_connection(self) -> DataSourceInput:
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("표시 이름을 입력하세요.")
        self.uri = self.uri.strip().rstrip("/")
        parsed = urlsplit(self.uri)
        schemes = {"s3"} if self.provider == "s3" else {"gs", "gcs"}
        if parsed.scheme not in schemes or not parsed.netloc:
            expected = "s3://bucket/prefix" if self.provider == "s3" else "gs://bucket/prefix"
            raise ValueError(f"{self.provider.upper()} 경로는 {expected} 형식이어야 합니다.")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("경로에는 자격 증명, 쿼리 또는 fragment를 넣을 수 없습니다.")
        if "'" in self.uri or any(char in self.uri for char in "*?[]"):
            raise ValueError("데이터 루트 경로에는 따옴표나 glob 문자를 넣을 수 없습니다.")
        if self.auth_mode == "access_key" and (
            self.access_key_id is None or self.secret_access_key is None
        ):
            raise ValueError("액세스 키 인증에는 키 ID와 비밀 키가 모두 필요합니다.")
        if self.provider == "gcs" and self.session_token is not None:
            raise ValueError("GCS HMAC 인증에는 세션 토큰을 사용할 수 없습니다.")
        return self


@dataclass(slots=True)
class StoredDataSource:
    id: str
    config: DataSourceInput
    snapshot_id: str
    source: str | None
    match_count: int
    tables: tuple[str, ...]
    connected_at: str

    def public(self, *, active: bool) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.config.name,
            "provider": self.config.provider,
            "uri": self.config.uri,
            "authMode": self.config.auth_mode,
            "region": self.config.region,
            "snapshotId": self.snapshot_id,
            "datasetSource": self.source,
            "matchCount": self.match_count,
            "tables": list(self.tables),
            "connectedAt": self.connected_at,
            "active": active,
            "persistent": False,
        }


class DataSourceConnectionError(Exception):
    """A safe, user-facing remote connection failure."""


class DataSourceManager:
    def __init__(self) -> None:
        self._sources: dict[str, StoredDataSource] = {}
        self._active_id = "local"
        self._lock = threading.RLock()

    @property
    def active_id(self) -> str:
        with self._lock:
            return self._active_id

    def active_metadata(self) -> tuple[str | None, str | None]:
        with self._lock:
            if self._active_id == "local":
                manifest = read_manifest(settings.silver_dir)
                if not isinstance(manifest, dict):
                    return None, None
                source = manifest.get("source")
                snapshot = manifest.get("snapshot_id")
                return (
                    source if isinstance(source, str) else None,
                    snapshot if isinstance(snapshot, str) else None,
                )
            item = self._sources.get(self._active_id)
            return (item.source, item.snapshot_id) if item else (None, None)

    def list_public(self) -> list[dict[str, object]]:
        with self._lock:
            try:
                manifest = read_manifest(settings.silver_dir)
            except (OSError, ValueError):
                manifest = None
            tables = manifest.get("tables", {}) if isinstance(manifest, dict) else {}
            matches = tables.get("matches", {}) if isinstance(tables, dict) else {}
            local = {
                "id": "local",
                "name": "로컬 데이터",
                "provider": "local",
                "uri": "data/silver",
                "authMode": "local",
                "region": None,
                "snapshotId": manifest.get("snapshot_id") if isinstance(manifest, dict) else None,
                "datasetSource": manifest.get("source") if isinstance(manifest, dict) else None,
                "matchCount": matches.get("rows", 0) if isinstance(matches, dict) else 0,
                "tables": sorted(tables) if isinstance(tables, dict) else [],
                "connectedAt": None,
                "active": self._active_id == "local",
                "persistent": True,
            }
            remote = [
                source.public(active=source.id == self._active_id)
                for source in self._sources.values()
            ]
            return [local, *remote]

    def connect(self, config: DataSourceInput) -> dict[str, object]:
        source_id = f"source_{uuid.uuid4().hex[:12]}"
        secret_name = self._secret_name(source_id)
        probe = duckdb.connect(":memory:")
        try:
            self._configure_remote(probe, secret_name, config)
            created = register_views(probe, config.uri)
            missing_tables, missing_columns = self._schema_gaps(probe, created)
            if missing_tables or missing_columns:
                detail = []
                if missing_tables:
                    detail.append("없는 테이블: " + ", ".join(missing_tables))
                if missing_columns:
                    detail.append("없는 컬럼: " + ", ".join(missing_columns[:12]))
                raise DataSourceConnectionError(
                    "League of Data 표준 Parquet 스키마와 일치하지 않습니다. " + " · ".join(detail)
                )
            manifest = self._remote_manifest(probe, config.uri)
        except DataSourceConnectionError:
            raise
        except duckdb.Error as exc:
            message = str(exc)
            if "Extension" in message and "httpfs" in message:
                raise DataSourceConnectionError(
                    "DuckDB httpfs 확장이 설치되지 않았습니다. 분석 서버 환경에 `INSTALL httpfs`를 "
                    "한 번 실행한 뒤 다시 연결하세요."
                ) from exc
            raise DataSourceConnectionError(
                "원격 Parquet를 읽지 못했습니다. 경로, 읽기 권한, 리전과 표준 폴더 "
                "구조를 확인하세요."
            ) from exc
        finally:
            probe.close()

        snapshot = manifest.get("snapshot_id")
        if not isinstance(snapshot, str) or not snapshot:
            raise DataSourceConnectionError(
                "데이터 루트의 `_manifest.json`에 snapshot_id가 없습니다."
            )
        source = manifest.get("source")
        source = source if isinstance(source, str) else None
        manifest_tables = manifest.get("tables", {})
        matches = manifest_tables.get("matches", {}) if isinstance(manifest_tables, dict) else {}
        match_count = matches.get("rows", 0) if isinstance(matches, dict) else 0
        item = StoredDataSource(
            id=source_id,
            config=config,
            snapshot_id=snapshot,
            source=source,
            match_count=int(match_count) if isinstance(match_count, int) else 0,
            tables=tuple(sorted(TABLES)),
            connected_at=datetime.now(UTC).isoformat(),
        )
        with self._lock:
            self._activate_remote(item)
            self._sources[item.id] = item
            self._active_id = item.id
        return item.public(active=True)

    def activate(self, source_id: str) -> dict[str, object]:
        with self._lock:
            if source_id == "local":
                from lod_api.db import get_database

                con = get_database()
                con.execute("BEGIN TRANSACTION")
                try:
                    register_views(con, settings.silver_dir)
                    con.execute("COMMIT")
                except BaseException:
                    con.execute("ROLLBACK")
                    raise
                self._active_id = "local"
                return self.list_public()[0]
            item = self._sources.get(source_id)
            if item is None:
                raise KeyError(source_id)
            self._activate_remote(item)
            self._active_id = item.id
            return item.public(active=True)

    def delete(self, source_id: str) -> None:
        if source_id == "local":
            raise ValueError("로컬 데이터 소스는 삭제할 수 없습니다.")
        with self._lock:
            if source_id not in self._sources:
                raise KeyError(source_id)
            if self._active_id == source_id:
                self.activate("local")
            del self._sources[source_id]
            self._drop_secret(self._secret_name(source_id))

    def _activate_remote(self, item: StoredDataSource) -> None:
        from lod_api.db import get_database

        con = get_database()
        self._configure_remote(con, self._secret_name(item.id), item.config)
        con.execute("BEGIN TRANSACTION")
        try:
            created = register_views(con, item.config.uri)
            missing = sorted((set(TABLES) | set(DERIVED_VIEWS)) - set(created))
            if missing:
                raise DataSourceConnectionError(
                    "원격 테이블 뷰를 활성화하지 못했습니다: " + ", ".join(missing)
                )
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise

    @staticmethod
    def _load_httpfs(con: duckdb.DuckDBPyConnection) -> None:
        # Deliberately never INSTALL executable extensions at request time. Production images and
        # local installations should preinstall the version-matched extension once.
        con.execute("LOAD httpfs")

    @classmethod
    def _configure_remote(
        cls, con: duckdb.DuckDBPyConnection, secret_name: str, config: DataSourceInput
    ) -> None:
        cls._load_httpfs(con)
        con.execute(f"DROP SECRET IF EXISTS {secret_name}")
        values = [f"TYPE {config.provider}", f"SCOPE {cls._literal(config.uri)}"]
        if config.auth_mode == "anonymous":
            values.append("PROVIDER config")
            values.append("KEY_ID ''")
            values.append("SECRET ''")
        else:
            values.extend(
                [
                    "PROVIDER config",
                    f"KEY_ID {cls._literal(config.access_key_id.get_secret_value())}",
                    f"SECRET {cls._literal(config.secret_access_key.get_secret_value())}",
                ]
            )
            if config.session_token is not None:
                token = config.session_token.get_secret_value()
                values.append(f"SESSION_TOKEN {cls._literal(token)}")
        if config.provider == "s3" and config.region:
            values.append(f"REGION {cls._literal(config.region)}")
        con.execute(f"CREATE SECRET {secret_name} (" + ", ".join(values) + ")")

    @staticmethod
    def _remote_manifest(con: duckdb.DuckDBPyConnection, uri: str) -> dict[str, object]:
        try:
            result = con.execute(
                "SELECT * FROM read_json_auto($path) LIMIT 1", {"path": f"{uri}/_manifest.json"}
            )
            row = result.fetchone()
            if row is None:
                return {}
            return dict(zip((column[0] for column in result.description), row, strict=True))
        except duckdb.Error as exc:
            raise DataSourceConnectionError(
                "데이터 루트에서 `_manifest.json`을 읽지 못했습니다. 표준 데이터셋 "
                "루트를 선택하세요."
            ) from exc

    @staticmethod
    def _schema_gaps(
        con: duckdb.DuckDBPyConnection, created: list[str]
    ) -> tuple[list[str], list[str]]:
        missing_tables = sorted(set(TABLES) - set(created))
        missing_columns: list[str] = []
        for table, schema in TABLES.items():
            if table in missing_tables:
                continue
            actual = {row[0] for row in con.execute(f"DESCRIBE {table}").fetchall()}
            missing_columns.extend(
                f"{table}.{field.name}" for field in schema if field.name not in actual
            )
        return missing_tables, missing_columns

    @staticmethod
    def _literal(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    @staticmethod
    def _secret_name(source_id: str) -> str:
        name = "lod_" + hashlib.sha256(source_id.encode()).hexdigest()[:20]
        if not _SAFE_ID.fullmatch(name):
            raise ValueError("Invalid secret identifier")
        return name

    @staticmethod
    def _drop_secret(secret_name: str) -> None:
        from lod_api.db import get_database

        with suppress(duckdb.Error):
            get_database().execute(f"DROP SECRET IF EXISTS {secret_name}")


manager = DataSourceManager()


def active_dataset_metadata() -> tuple[str | None, str | None]:
    return manager.active_metadata()
