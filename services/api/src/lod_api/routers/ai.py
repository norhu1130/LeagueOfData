"""Optional AI endpoints backed by a server-side OpenRouter credential."""

from __future__ import annotations

import re
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError

from lod_api.ai import (
    DSL_RESPONSE_SCHEMA,
    INTERPRET_RESPONSE_SCHEMA,
    INTERPRET_SYSTEM_PROMPT,
    AiProviderError,
    AiUnavailableError,
    ai_gateway,
    dsl_system_prompt,
)
from lod_api.config import settings
from lod_api.routers.catalog import dataset_facets

router = APIRouter(prefix="/api/v1/ai", tags=["ai"])


class AiConfigRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    api_key: SecretStr = Field(min_length=16, max_length=512)


class RegionReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128, pattern=r"^[a-z_][a-z0-9_]*$")
    label: str = Field(min_length=1, max_length=200)


class ChampionReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str = Field(min_length=1, max_length=100)
    aliases: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(
        min_length=1, max_length=8
    )


class ItemReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: int = Field(ge=1, le=1_000_000)
    aliases: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        min_length=1, max_length=8
    )


class DatasetFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patch: str | None = Field(default=None, max_length=40)
    queue: str | None = Field(default=None, max_length=80)
    tier: str | None = Field(default=None, max_length=40)
    region: str | None = Field(default=None, max_length=40)
    excludeRemakes: bool = True


class DslGenerationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=3, max_length=4_000)
    current_dsl: str | None = Field(default=None, max_length=32_000)
    regions: list[RegionReference] = Field(default_factory=list, max_length=64)
    champion_references: list[ChampionReference] = Field(default_factory=list, max_length=32)
    item_references: list[ItemReference] = Field(default_factory=list, max_length=32)
    current_dataset_filters: DatasetFilters = Field(default_factory=DatasetFilters)


class InterpretationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dsl: str = Field(min_length=1, max_length=32_000)
    result: dict[str, Any]
    dataset_source: str | None = Field(default=None, max_length=128)


class DslGenerationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dsl: str = Field(max_length=32_000)
    titleKo: str = Field(max_length=200)
    explanationKo: str = Field(max_length=2_000)
    datasetFilters: DatasetFilters


class InterpretationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    summaryKo: str = Field(max_length=4_000)
    findingsKo: list[str] = Field(max_length=3)
    cautionsKo: list[str] = Field(max_length=3)


def _status() -> dict[str, Any]:
    return {
        "enabled": ai_gateway.enabled,
        "model": settings.openrouter_model,
        "provider": "OpenRouter",
        "persistent": ai_gateway.configured_from_environment,
        "sessionConfigured": ai_gateway.session_configured,
    }


def _provider_error(error: Exception) -> HTTPException:
    if isinstance(error, AiUnavailableError):
        return HTTPException(status_code=409, detail="OpenRouter 키를 먼저 설정해 주세요.")
    if isinstance(error, AiProviderError):
        return HTTPException(status_code=502, detail=error.public_message)
    if isinstance(error, ValidationError):
        return HTTPException(
            status_code=502,
            detail="AI 응답 형식이 예상과 다릅니다. 다시 시도해 주세요.",
        )
    return HTTPException(status_code=502, detail="AI 제공자 응답을 처리하지 못했습니다.")


def _safe_analysis_result(result: dict[str, Any], dataset_source: str | None) -> dict[str, Any]:
    """Drop bulky and unrelated fields before including an engine result in a prompt."""
    payload = result.get("result") if isinstance(result.get("result"), dict) else {}
    provenance = result.get("provenance") if isinstance(result.get("provenance"), dict) else {}
    rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    caveats = result.get("caveats") if isinstance(result.get("caveats"), list) else []
    return {
        "result": {
            key: payload.get(key)
            for key in (
                "type",
                "columns",
                "measures",
                "confidenceInterval95",
                "baseline",
                "comparison",
            )
        }
        | {"rows": rows[:50]},
        "provenance": {
            key: provenance.get(key)
            for key in (
                "grain",
                "grainLabelKo",
                "totalMatches",
                "totalUnits",
                "matchedMatches",
                "matchedUnits",
                "denominatorKo",
                "conditions",
                "excluded",
                "measureCoverage",
                "dataset",
                "biasAudit",
            )
        },
        "caveats": caveats[:20],
        "datasetSource": dataset_source,
    }


def _mention_matches(question: str, aliases: list[str]) -> bool:
    for raw_alias in aliases:
        alias = raw_alias.strip()
        if not alias:
            continue
        if alias.isascii() and re.fullmatch(r"[A-Za-z0-9_]+", alias):
            if re.search(rf"(?<![A-Za-z0-9_]){re.escape(alias)}(?![A-Za-z0-9_])", question, re.I):
                return True
        elif alias.casefold() in question.casefold():
            return True
    return False


def _ground_mentions(
    request: DslGenerationRequest, facets: dict[str, list[Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    champions = {entry["name"] for entry in facets["champions"]}
    item_ids = {entry["id"] for entry in facets["items"]}
    champion_mentions = [
        reference.model_dump()
        for reference in request.champion_references
        if reference.value in champions
        and _mention_matches(request.question, [reference.value, *reference.aliases])
    ]
    item_mentions = [
        reference.model_dump()
        for reference in request.item_references
        if reference.id in item_ids
        and _mention_matches(request.question, [str(reference.id), *reference.aliases])
    ]
    return champion_mentions, item_mentions


def _filter_options(facets: dict[str, list[Any]]) -> dict[str, list[str]]:
    return {
        "patches": facets["patches"],
        "queues": facets["queues"],
        "tiers": facets["tiers"],
        "regions": facets["platformRegions"],
    }


def _validate_generated_filters(filters: DatasetFilters, options: dict[str, list[str]]) -> None:
    selected = {
        "patch": (filters.patch, options["patches"]),
        "queue": (filters.queue, options["queues"]),
        "tier": (filters.tier, options["tiers"]),
        "region": (filters.region, options["regions"]),
    }
    if any(value is not None and value not in allowed for value, allowed in selected.values()):
        raise AiProviderError(
            "AI가 현재 데이터셋에 없는 필터 값을 반환했습니다. 다시 시도해 주세요."
        )


@router.get("/status")
def ai_status() -> dict[str, Any]:
    return _status()


@router.put("/config")
async def configure_ai(request: AiConfigRequest) -> dict[str, Any]:
    key = request.api_key.get_secret_value()
    try:
        await ai_gateway.validate_key(key)
    except AiProviderError as error:
        raise _provider_error(error) from error
    ai_gateway.configure_session(key)
    return _status()


@router.delete("/config")
def clear_ai_config() -> dict[str, Any]:
    ai_gateway.clear_session()
    return _status()


@router.post("/dsl")
async def generate_dsl(request: DslGenerationRequest) -> dict[str, Any]:
    facets = dataset_facets()
    champion_mentions, item_mentions = _ground_mentions(request, facets)
    filter_options = _filter_options(facets)
    payload = {
        "question": request.question,
        "currentDsl": request.current_dsl,
        "regions": [region.model_dump() for region in request.regions],
        "resolvedChampionMentions": champion_mentions,
        "resolvedItemMentions": item_mentions,
        "currentDatasetFilters": request.current_dataset_filters.model_dump(),
        "datasetFilterOptions": filter_options,
    }
    try:
        generated = await ai_gateway.complete(
            system_prompt=dsl_system_prompt(),
            input_payload=payload,
            response_schema=DSL_RESPONSE_SCHEMA,
            max_tokens=2_000,
        )
        response = DslGenerationResponse.model_validate(generated)
        _validate_generated_filters(response.datasetFilters, filter_options)
        return response.model_dump()
    except (AiUnavailableError, AiProviderError, ValidationError) as error:
        raise _provider_error(error) from error


@router.post("/interpret")
async def interpret_result(request: InterpretationRequest) -> dict[str, Any]:
    safe_result = _safe_analysis_result(request.result, request.dataset_source)
    try:
        interpreted = await ai_gateway.complete(
            system_prompt=INTERPRET_SYSTEM_PROMPT,
            input_payload={"dsl": request.dsl, "analysis": safe_result},
            response_schema=INTERPRET_RESPONSE_SCHEMA,
            max_tokens=1_200,
        )
        return InterpretationResponse.model_validate(interpreted).model_dump()
    except (AiUnavailableError, AiProviderError, ValidationError) as error:
        raise _provider_error(error) from error
