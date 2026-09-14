"""Load the TypeScript-generated semantic catalog.

Event names and SQL predicates are never redefined here. Generated-artifact checks, request hash
validation, and startup schema checks form three independent drift defenses.
"""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass
from functools import lru_cache
from hashlib import sha256
from importlib import resources
from pathlib import Path
from typing import Any

import duckdb

RIOT_SOURCE = "riot_v5"

# These restrictions describe only omissions confirmed by the current Riot normalizer. Keep the
# list deliberately narrow: Riot timelines do not emit recall events, and their ward events do
# not contain map coordinates. Synthetic data continues to expose the complete static catalog.
_RIOT_UNAVAILABLE_EVENTS = {
    "recall": "Riot 타임라인에는 귀환 사건이 제공되지 않습니다.",
}
_RIOT_UNAVAILABLE_CONTEXTS = {
    "ward_placed": {
        "position": "Riot 타임라인의 와드 설치 사건에는 위치 좌표가 제공되지 않습니다."
    },
    "ward_destroyed": {
        "position": "Riot 타임라인의 와드 제거 사건에는 위치 좌표가 제공되지 않습니다."
    },
}


def _default_path() -> Path:
    return Path(__file__).resolve().parents[4] / "data" / "reference" / "catalog.json"


@dataclass(frozen=True, slots=True)
class EventBinding:
    """Complete event metadata required for SQL lowering."""

    id: str
    label_ko: str
    table: str
    where: str
    columns: tuple[str, ...]
    available: bool
    at_most_once_per_match: bool
    context: tuple[str, ...]


class Catalog:
    """Catalog lookup and the compiler's only semantic source."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    @property
    def hash(self) -> str:
        return self._data["hash"]

    @property
    def version(self) -> str:
        return self._data["catalogVersion"]

    @property
    def map_min(self) -> float:
        return float(self._data["map"]["min"])

    @property
    def map_span(self) -> float:
        return float(self._data["map"]["span"])

    @property
    def forbidden_phrases(self) -> tuple[str, ...]:
        return tuple(self._data["forbiddenPhrases"])

    def event(self, event_id: str) -> EventBinding:
        raw = self._data["events"].get(event_id)
        if raw is None:
            raise KeyError(f"Unknown event: {event_id}")
        b = raw["sqlBinding"]
        return EventBinding(
            id=raw["id"],
            label_ko=raw["labelKo"],
            table=b["table"],
            where=b["where"],
            columns=tuple(b["columns"]),
            available=raw["available"],
            at_most_once_per_match=raw["atMostOncePerMatch"],
            context=tuple(raw["context"]),
        )

    def events(self, *, include_unavailable: bool = False) -> list[EventBinding]:
        out = [self.event(eid) for eid in self._data["events"]]
        if not include_unavailable:
            out = [e for e in out if e.available]
        return out

    def resolve_surface(self, surface: str) -> tuple[str, str]:
        """Resolve a surface name to an event ID and ordinal qualifier."""
        if surface in self._data["events"]:
            return surface, "any"
        for eid, raw in self._data["events"].items():
            alias = (raw.get("aliases") or {}).get(surface)
            if alias:
                return eid, alias["ordinal"]
        raise KeyError(f"Unknown event surface: {surface}")

    def context_field(self, field_id: str) -> dict[str, Any]:
        field = self._data["contextFields"].get(field_id)
        if field is None:
            raise KeyError(f"Unknown context field: {field_id}")
        return field

    def landmark(self, landmark_id: str) -> dict[str, Any]:
        landmark = self._data.get("landmarks", {}).get(landmark_id)
        if landmark is None:
            raise KeyError(f"Unknown landmark: {landmark_id}")
        return landmark

    def function(self, fn_id: str) -> dict[str, Any]:
        fn = self._data["functions"].get(fn_id)
        if fn is None:
            raise KeyError(f"Unknown function: {fn_id}")
        return fn

    def subject_field(self, field_id: str) -> dict[str, Any]:
        field = self._data.get("subjectFields", {}).get(field_id)
        if field is None:
            raise KeyError(f"Unknown subject field: {field_id}")
        return field

    def group_key(self, key_id: str) -> dict[str, Any]:
        key = self._data["groupKeys"].get(key_id)
        if key is None:
            raise KeyError(f"Unknown grouping key: {key_id}")
        return key

    def grain(self, grain_id: str) -> dict[str, Any]:
        return self._data["grains"][grain_id]

    def diagnostic(self, code: str) -> dict[str, Any] | None:
        return self._data["diagnostics"].get(code)

    @property
    def referenced_columns(self) -> dict[str, list[str]]:
        return self._data["referencedColumns"]

    def as_dict(self) -> dict[str, Any]:
        return self._data

    def for_source(self, source: str | None) -> Catalog:
        """Return the effective catalog for one manifested dataset source.

        The generated TypeScript catalog remains the source-independent definition. Dataset
        capability restrictions are applied at runtime so synthetic-only features do not get
        disabled globally.
        """
        if source != RIOT_SOURCE:
            return self

        data = deepcopy(self._data)
        events = data["events"]
        for event_id, reason in _RIOT_UNAVAILABLE_EVENTS.items():
            event = events.get(event_id)
            if event is None:
                continue
            event["available"] = False
            event["unavailableReasonKo"] = reason

        context_restrictions: dict[str, dict[str, dict[str, Any]]] = {}
        for event_id, fields in _RIOT_UNAVAILABLE_CONTEXTS.items():
            event = events.get(event_id)
            if event is None:
                continue
            event["context"] = [field for field in event["context"] if field not in fields]
            context_restrictions[event_id] = {
                field: {"available": False, "reasonKo": reason} for field, reason in fields.items()
            }

        base_hash = self.hash
        capability_payload = json.dumps(
            {
                "baseCatalogHash": base_hash,
                "datasetSource": source,
                "unavailableEvents": _RIOT_UNAVAILABLE_EVENTS,
                "unavailableContexts": _RIOT_UNAVAILABLE_CONTEXTS,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        data["baseCatalogHash"] = base_hash
        data["datasetSource"] = source
        data["sourceCapabilities"] = {
            "events": {
                event_id: {"available": False, "reasonKo": reason}
                for event_id, reason in _RIOT_UNAVAILABLE_EVENTS.items()
            },
            "contexts": context_restrictions,
        }
        data["hash"] = "sha256:" + sha256(capability_payload.encode("utf-8")).hexdigest()
        return Catalog(data)


@lru_cache(maxsize=16)
def _load_catalog_file(path: str, mtime_ns: int, size: int) -> Catalog:
    """Cache one immutable catalog revision, keyed by its filesystem fingerprint."""
    del mtime_ns, size
    return Catalog(json.loads(Path(path).read_text(encoding="utf-8")))


def load_catalog(path: Path | None = None) -> Catalog:
    generated = path or _default_path()
    if generated.exists():
        resolved = generated.resolve()
        stat = resolved.stat()
        return _load_catalog_file(str(resolved), stat.st_mtime_ns, stat.st_size)

    bundled = resources.files("lod_api").joinpath("catalog.json")
    if not bundled.is_file():
        raise FileNotFoundError(
            f"{generated} does not exist and the package has no bundled catalog. "
            "Run `pnpm -F @lol/catalog build:json` before building."
        )
    return Catalog(json.loads(bundled.read_text(encoding="utf-8")))


def dataset_source() -> str | None:
    """Return the source declared by the active dataset manifest, if one exists."""
    from lod_api.data_sources import active_dataset_metadata

    return active_dataset_metadata()[0]


def load_effective_catalog() -> Catalog:
    """Load static semantics with active-dataset capability restrictions applied."""
    return load_catalog().for_source(dataset_source())


@dataclass(frozen=True, slots=True)
class SchemaCheck:
    ok: bool
    missing_tables: tuple[str, ...]
    missing_columns: tuple[tuple[str, str], ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "missingTables": list(self.missing_tables),
            "missingColumns": [{"table": t, "column": c} for t, c in self.missing_columns],
            "hintKo": None
            if self.ok
            else (
                "카탈로그가 참조하는 컬럼이 데이터에 없습니다. 데이터를 다시 생성하거나 "
                "`packages/catalog`의 sqlBinding을 실제 스키마에 맞추세요."
            ),
        }


def verify_against_schema(con: duckdb.DuckDBPyConnection, catalog: Catalog) -> SchemaCheck:
    """Verify that every catalog-referenced table and column exists physically."""
    missing_tables: list[str] = []
    missing_columns: list[tuple[str, str]] = []

    for table, columns in catalog.referenced_columns.items():
        try:
            actual = {row[0] for row in con.execute(f'DESCRIBE "{table}"').fetchall()}
        except duckdb.Error:
            missing_tables.append(table)
            continue
        for column in columns:
            if column not in actual:
                missing_columns.append((table, column))

    return SchemaCheck(
        ok=not missing_tables and not missing_columns,
        missing_tables=tuple(missing_tables),
        missing_columns=tuple(missing_columns),
    )
