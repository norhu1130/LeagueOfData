from __future__ import annotations

from fastapi.testclient import TestClient
from lod_api.data_sources import DataSourceInput, StoredDataSource
from lod_api.main import app
from pydantic import ValidationError

client = TestClient(app)


def test_source_input_accepts_only_matching_object_storage_uri() -> None:
    source = DataSourceInput(
        name="Production",
        provider="s3",
        uri="s3://match-bucket/lol/silver/",
        auth_mode="anonymous",
    )
    assert source.uri == "s3://match-bucket/lol/silver"

    for uri in ("https://match-bucket.example/silver", "gs://bucket/silver", "s3://bucket/a*"):
        try:
            DataSourceInput(name="Invalid", provider="s3", uri=uri, auth_mode="anonymous")
        except ValidationError:
            pass
        else:
            raise AssertionError(f"unsafe URI accepted: {uri}")


def test_access_key_mode_requires_both_keys() -> None:
    try:
        DataSourceInput(
            name="Private", provider="gcs", uri="gs://bucket/silver", auth_mode="access_key"
        )
    except ValidationError as exc:
        assert "키 ID와 비밀 키" in str(exc)
    else:
        raise AssertionError("missing credentials accepted")


def test_public_source_never_exposes_credentials() -> None:
    config = DataSourceInput(
        name="Private",
        provider="s3",
        uri="s3://bucket/silver",
        auth_mode="access_key",
        access_key_id="access-id",
        secret_access_key="super-secret",
    )
    public = StoredDataSource(
        id="source_1",
        config=config,
        snapshot_id="sha256:test",
        source="riot_v5",
        match_count=10,
        tables=("matches",),
        connected_at="2026-01-01T00:00:00Z",
    ).public(active=True)

    assert public["active"] is True
    assert "access-id" not in str(public)
    assert "super-secret" not in str(public)


def test_list_endpoint_contains_builtin_local_source() -> None:
    response = client.get("/api/v1/data-sources")
    assert response.status_code == 200
    body = response.json()
    local = next(item for item in body["items"] if item["id"] == "local")
    assert local["provider"] == "local"
    assert local["persistent"] is True
