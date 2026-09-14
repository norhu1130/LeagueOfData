"""Manage local and object-storage analysis datasets."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status

from lod_api.data_sources import DataSourceConnectionError, DataSourceInput, manager

router = APIRouter(prefix="/api/v1/data-sources", tags=["data-sources"])


@router.get("")
def list_data_sources() -> dict[str, Any]:
    return {"items": manager.list_public(), "activeId": manager.active_id}


@router.post("", status_code=status.HTTP_201_CREATED)
def connect_data_source(payload: DataSourceInput) -> dict[str, object]:
    try:
        return manager.connect(payload)
    except DataSourceConnectionError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "E-DATA-SOURCE", "messageKo": str(exc)},
        ) from exc


@router.put("/{source_id}/active")
def activate_data_source(source_id: str) -> dict[str, object]:
    try:
        return manager.activate(source_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="데이터 소스를 찾을 수 없습니다.") from exc
    except DataSourceConnectionError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "E-DATA-SOURCE", "messageKo": str(exc)}
        ) from exc


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_data_source(source_id: str) -> None:
    try:
        manager.delete(source_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="데이터 소스를 찾을 수 없습니다.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
