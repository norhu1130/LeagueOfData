from __future__ import annotations

import json

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi.testclient import TestClient
from lod_api import runtime_profile
from lod_api.main import app
from lod_data.schema import TABLES

client = TestClient(app)


def _write_witness(path) -> None:
    pq.write_table(pa.table({"ready": [True]}), path)


def test_healthz_reports_engine() -> None:
    body = client.get("/healthz").json()
    assert body["status"] == "ok"
    assert body["engine"].startswith("duckdb-")


def test_health_probes_support_head_requests() -> None:
    for path in ("/healthz", "/readyz"):
        response = client.head(path)
        assert response.status_code == 200
        assert response.content == b""


def test_readyz_reports_reference_present() -> None:
    response = client.get("/readyz")
    assert response.status_code == 200
    body = response.json()
    assert body["checks"]["reference"]["ok"] is True


def test_public_readyz_checks_bounded_manifest_witnesses_without_scanning(
    tmp_path, monkeypatch
) -> None:
    from lod_api.config import settings
    from lod_api.routers import health

    data = tmp_path / "data"
    silver = data / "silver"
    reference = data / "reference"
    silver.mkdir(parents=True)
    reference.mkdir(parents=True)
    for name in ("catalog.json", "regions_builtin.json"):
        (reference / name).write_text("{}", encoding="utf-8")
    files = []
    for name in TABLES:
        path = silver / name / "part-0000.parquet"
        path.parent.mkdir()
        _write_witness(path)
        files.append({"path": f"{name}/part-0000.parquet", "rows": 1, "bytes": 1})
    manifest = {
        "snapshot_id": "sha256:test",
        "tables": {name: {"rows": 1, "files": 1, "bytes": 1} for name in TABLES},
        "files": files,
    }
    (silver / "_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(settings, "data_dir", data)
    monkeypatch.setattr(runtime_profile, "_public_instance", True)
    health._cached_public_witnesses.cache_clear()
    original_read_manifest = health.read_manifest
    reads = 0

    def counted_read_manifest(root):
        nonlocal reads
        reads += 1
        return original_read_manifest(root)

    monkeypatch.setattr(health, "read_manifest", counted_read_manifest)

    response = client.get("/readyz")
    cached_response = client.get("/readyz")
    (silver / "participants" / "part-0000.parquet").unlink()
    missing_response = client.get("/readyz")

    assert response.status_code == 200
    assert response.json() == {"ready": True}
    assert cached_response.status_code == 200
    assert reads == 1
    assert missing_response.status_code == 503
    assert missing_response.json() == {"ready": False}
    assert reads == 1


def test_public_readyz_rejects_a_missing_manifest_witness(tmp_path, monkeypatch) -> None:
    from lod_api.config import settings
    from lod_api.routers import health

    data = tmp_path / "data"
    silver = data / "silver"
    reference = data / "reference"
    silver.mkdir(parents=True)
    reference.mkdir(parents=True)
    for name in ("catalog.json", "regions_builtin.json"):
        (reference / name).write_text("{}", encoding="utf-8")
    files = []
    for name in TABLES:
        path = silver / name / "part-0000.parquet"
        path.parent.mkdir()
        if name != "participants":
            _write_witness(path)
        files.append({"path": f"{name}/part-0000.parquet", "rows": 1, "bytes": 1})
    manifest = {
        "tables": {name: {"rows": 1, "files": 1, "bytes": 1} for name in TABLES},
        "files": files,
    }
    (silver / "_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(settings, "data_dir", data)
    monkeypatch.setattr(runtime_profile, "_public_instance", True)
    health._cached_public_witnesses.cache_clear()

    response = client.get("/readyz")

    assert response.status_code == 503
    assert response.json() == {"ready": False}


def test_public_readyz_returns_503_for_invalid_reference_json(tmp_path, monkeypatch) -> None:
    from lod_api.config import settings
    from lod_api.routers import health

    data = tmp_path / "data"
    silver = data / "silver"
    reference = data / "reference"
    silver.mkdir(parents=True)
    reference.mkdir(parents=True)
    (reference / "catalog.json").write_bytes(b"\xff")
    (reference / "regions_builtin.json").write_text("{}", encoding="utf-8")
    manifest = {
        "tables": {name: {"rows": 1, "files": 1, "bytes": 1} for name in TABLES},
    }
    (silver / "_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(settings, "data_dir", data)
    monkeypatch.setattr(runtime_profile, "_public_instance", True)
    health._cached_public_witnesses.cache_clear()

    response = client.get("/readyz")

    assert response.status_code == 503
    assert response.json() == {"ready": False}


def test_readyz_is_not_ready_without_dataset(tmp_path, monkeypatch) -> None:
    """A data directory containing only placeholders must not report ready."""
    from lod_api.config import settings

    empty = tmp_path / "data"
    (empty / "silver").mkdir(parents=True)
    (empty / "silver" / ".gitkeep").touch()
    (empty / "reference").mkdir(parents=True)
    monkeypatch.setattr(settings, "data_dir", empty)

    response = client.get("/readyz")
    body = response.json()
    assert response.status_code == 503
    assert body["ready"] is False
    assert body["checks"]["dataset"]["ok"] is False
    assert body["checks"]["dataset"]["tables"] == []
    assert "synth" in body["checks"]["dataset"]["hintKo"]


def test_readyz_rejects_partial_or_unmanifested_dataset(tmp_path, monkeypatch) -> None:
    from lod_api.config import settings

    data = tmp_path / "data"
    (data / "silver" / "events").mkdir(parents=True)
    (data / "silver" / "events" / "part-0000.parquet").touch()
    (data / "reference").mkdir(parents=True)
    for name in ("catalog.json", "regions_builtin.json"):
        (data / "reference" / name).write_text("{}", encoding="utf-8")
    monkeypatch.setattr(settings, "data_dir", data)

    response = client.get("/readyz")

    assert response.status_code == 503
    dataset = response.json()["checks"]["dataset"]
    assert dataset["ok"] is False
    assert "matches" in dataset["missingTables"]
    assert dataset["snapshotId"] is None


def test_readyz_requires_every_manifested_table_to_have_parquet(tmp_path, monkeypatch) -> None:
    from lod_api.config import settings

    data = tmp_path / "data"
    silver = data / "silver"
    reference = data / "reference"
    reference.mkdir(parents=True)
    for name in ("catalog.json", "regions_builtin.json"):
        (reference / name).write_text("{}", encoding="utf-8")
    manifest = {
        "snapshot_id": "sha256:test",
        "tables": {name: {"rows": 1, "files": 1, "bytes": 1} for name in TABLES},
    }
    silver.mkdir(parents=True)
    (silver / "_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    for name in TABLES:
        (silver / name).mkdir()
        if name != "participants":
            (silver / name / "part-0000.parquet").touch()
    monkeypatch.setattr(settings, "data_dir", data)

    response = client.get("/readyz")

    assert response.status_code == 503
    assert response.json()["checks"]["dataset"]["missingTables"] == ["participants"]


def test_readyz_rejects_malformed_manifest_without_exposing_paths(tmp_path, monkeypatch) -> None:
    from lod_api.config import settings

    data = tmp_path / "private-dataset-name"
    silver = data / "silver"
    reference = data / "reference"
    silver.mkdir(parents=True)
    reference.mkdir(parents=True)
    for name in ("catalog.json", "regions_builtin.json"):
        (reference / name).write_text("{}", encoding="utf-8")
    (silver / "_manifest.json").write_text("{invalid", encoding="utf-8")
    monkeypatch.setattr(settings, "data_dir", data)

    response = client.get("/readyz")

    assert response.status_code == 503
    dataset = response.json()["checks"]["dataset"]
    assert dataset["manifestError"] == "JSONDecodeError"
    assert dataset["manifest"] == "_manifest.json"
    assert str(data) not in response.text
