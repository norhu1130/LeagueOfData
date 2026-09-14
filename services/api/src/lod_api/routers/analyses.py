"""Analysis execution, progress, cancellation, explanation, and drill-down API."""

from __future__ import annotations

import json
import math
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from lod_api.bias import audit_plan
from lod_api.catalog import load_effective_catalog
from lod_api.compile.plan import DatasetFilter
from lod_api.compile.planner import PlanBuilder, PlanError
from lod_api.compile.sql import SqlCompiler
from lod_api.config import settings
from lod_api.engine.duckdb_engine import AmbiguousMatchedUnit, DuckDBEngine
from lod_api.runs import RunQueueFull, manager

router = APIRouter(prefix="/api/v1", tags=["analyses"])

_BINARY_OPERATORS = frozenset(
    {"AND", "OR", "=", "!=", ">", ">=", "<", "<=", "+", "-", "*", "/", "%"}
)
_UNARY_OPERATORS = frozenset({"NOT", "-"})
_SPATIAL_RELATIONS = frozenset({"IN_REGION", "WITHIN_RADIUS", "NEAR"})
_TEMPORAL_RELATIONS = frozenset({"BEFORE", "AFTER", "WITHIN", "UNTIL", "DURING", "BETWEEN", "AT"})
_REGION_ID = re.compile(r"^[a-z_][a-z0-9_]{0,127}$")
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_EXPRESSION_KINDS = frozenset(
    {
        "NumberLit",
        "StringLit",
        "BoolLit",
        "NullLit",
        "DurationLit",
        "ClockLit",
        "Identifier",
        "RegionRef",
        "EventRef",
        "EventPredicate",
        "FieldAccess",
        "CallExpr",
        "MeasureAt",
        "BinaryExpr",
        "UnaryExpr",
        "InExpr",
        "SpatialPredicate",
        "TemporalPredicate",
    }
)

_NODE_KEYS: dict[str, tuple[set[str], set[str]]] = {
    "Program": ({"kind", "analyze", "body"}, {"span"}),
    "ScopeRef": ({"kind", "entity"}, {"side", "relation", "selector", "span"}),
    "SimpleStmt": ({"kind", "chain", "when", "groupBy", "returns"}, {"span"}),
    "CompareStmt": ({"kind", "arms", "groupBy", "returns"}, {"span"}),
    "CompareArm": ({"kind", "label", "when"}, {"span"}),
    "ChainClause": ({"kind", "trigger", "window", "condition"}, {"span"}),
    "GroupKey": ({"kind", "expr", "alias"}, {"span"}),
    "ReturnItem": ({"kind", "expr", "alias"}, {"span"}),
    "NumberLit": ({"kind", "value"}, {"span"}),
    "StringLit": ({"kind", "value"}, {"span"}),
    "BoolLit": ({"kind", "value"}, {"span"}),
    "NullLit": ({"kind"}, {"span"}),
    "DurationLit": ({"kind", "seconds", "raw"}, {"span"}),
    "ClockLit": ({"kind", "seconds", "raw"}, {"span"}),
    "Identifier": ({"kind", "name"}, {"span"}),
    "RegionRef": ({"kind", "name"}, {"span"}),
    "EventRef": (
        {"kind", "bindingId", "scope", "eventType", "ordinal", "surface"},
        {"span"},
    ),
    "EventPredicate": ({"kind", "event", "negated"}, {"span"}),
    "FieldAccess": ({"kind", "object", "field"}, {"span"}),
    "CallExpr": ({"kind", "callee", "scope", "args"}, {"span"}),
    "MeasureAt": ({"kind", "measure", "scope", "at"}, {"span"}),
    "BinaryExpr": ({"kind", "op", "left", "right"}, {"span"}),
    "UnaryExpr": ({"kind", "op", "operand"}, {"span"}),
    "InExpr": ({"kind", "value", "set", "negated"}, {"span"}),
    "SpatialPredicate": (
        {"kind", "relation", "position", "target", "radius"},
        {"span"},
    ),
    "TemporalPredicate": (
        {"kind", "relation", "left", "right", "rightUpper", "window"},
        {"span"},
    ),
}


def _invalid_request(message: str) -> ValueError:
    return ValueError(f"올바르지 않은 분석 요청입니다: {message}")


def _json_size(value: Any, limit: int, label: str) -> None:
    try:
        size = len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    except (TypeError, ValueError) as exc:
        raise _invalid_request(f"{label}에 JSON으로 표현할 수 없는 값이 있습니다.") from exc
    if size > limit:
        raise _invalid_request(f"{label}의 크기가 허용 범위를 넘었습니다.")


def _require_string(
    value: Any, field: str, *, nullable: bool = False, allow_empty: bool = False
) -> None:
    if nullable and value is None:
        return
    if (
        not isinstance(value, str)
        or (not allow_empty and not value)
        or len(value) > settings.max_ast_string_length
    ):
        raise _invalid_request(f"{field} 문자열이 비어 있거나 너무 깁니다.")


def _require_identifier(value: Any, field: str, *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    _require_string(value, field)
    if not _IDENTIFIER.fullmatch(value):
        raise _invalid_request(f"{field} 식별자 형식이 올바르지 않습니다.")


def _require_number(value: Any, field: str, *, nonnegative: bool = False) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise _invalid_request(f"{field}에는 유한한 숫자가 필요합니다.")
    if nonnegative and value < 0:
        raise _invalid_request(f"{field}에는 0 이상의 숫자가 필요합니다.")
    magnitude = abs(value)
    if magnitude != 0 and (magnitude < 1e-6 or magnitude >= 1e21):
        raise _invalid_request(f"{field} 숫자가 지원 범위를 벗어났습니다.")


def validate_analysis_ast(ast: Any) -> None:
    """Validate the executable AST boundary independently from browser-side validation."""
    _json_size(ast, settings.max_ast_bytes, "분석")
    if not isinstance(ast, dict) or ast.get("kind") != "Program":
        raise _invalid_request("최상위 형식은 Program이어야 합니다.")

    stack: list[tuple[dict[str, Any], int]] = [(ast, 1)]
    count = 0
    bindings: dict[str, tuple[str, str, str]] = {}

    def add_node(
        value: Any,
        depth: int,
        field: str,
        *,
        nullable: bool = False,
        kinds: set[str] | frozenset[str] | None = None,
    ) -> None:
        if nullable and value is None:
            return
        if not isinstance(value, dict):
            raise _invalid_request(f"{field}에는 분석 노드가 필요합니다.")
        if kinds is not None and value.get("kind") not in kinds:
            raise _invalid_request(f"{field}에 사용할 수 없는 분석 노드입니다.")
        stack.append((value, depth))

    def add_nodes(
        value: Any,
        depth: int,
        field: str,
        *,
        minimum: int = 0,
        kinds: set[str] | frozenset[str] | None = None,
    ) -> None:
        if not isinstance(value, list) or len(value) < minimum:
            raise _invalid_request(f"{field} 목록의 항목 수가 올바르지 않습니다.")
        for item in value:
            add_node(item, depth, field, kinds=kinds)

    while stack:
        node, depth = stack.pop()
        count += 1
        if count > settings.max_ast_nodes:
            raise _invalid_request("분석 노드 수가 허용 범위를 넘었습니다.")
        if depth > settings.max_ast_depth:
            raise _invalid_request("분석 구조가 너무 깊습니다.")

        kind = node.get("kind")
        if not isinstance(kind, str) or kind not in _NODE_KEYS:
            raise _invalid_request("지원하지 않는 분석 노드가 포함되어 있습니다.")
        required, optional = _NODE_KEYS[kind]
        keys = set(node)
        if not required <= keys or keys - required - optional:
            raise _invalid_request(f"{kind} 노드의 필드 구성이 올바르지 않습니다.")
        span = node.get("span")
        if span is not None and (
            not isinstance(span, list)
            or len(span) != 2
            or any(type(item) is not int or item < 0 for item in span)
        ):
            raise _invalid_request("텍스트 범위 정보가 올바르지 않습니다.")

        child_depth = depth + 1
        if kind == "Program":
            add_node(node["analyze"], child_depth, "analyze", nullable=True, kinds={"ScopeRef"})
            add_node(node["body"], child_depth, "body", kinds={"SimpleStmt", "CompareStmt"})
        elif kind == "ScopeRef":
            if node["entity"] not in {"match", "team", "player"}:
                raise _invalid_request("지원하지 않는 분석 단위입니다.")
            if "side" in node and node["side"] not in {"blue", "red"}:
                raise _invalid_request("지원하지 않는 진영입니다.")
            if "relation" in node and node["relation"] != "opponent-of-trigger":
                raise _invalid_request("지원하지 않는 팀 관계입니다.")
            if "relation" in node and (node["entity"] != "team" or "side" in node):
                raise _invalid_request("팀 관계와 고정 진영을 함께 지정할 수 없습니다.")
            if "selector" in node:
                _require_string(node["selector"], "selector")
        elif kind == "SimpleStmt":
            add_node(node["chain"], child_depth, "chain", nullable=True, kinds={"ChainClause"})
            add_node(node["when"], child_depth, "when", nullable=True, kinds=_EXPRESSION_KINDS)
            add_nodes(node["groupBy"], child_depth, "groupBy", kinds={"GroupKey"})
            add_nodes(node["returns"], child_depth, "returns", minimum=1, kinds={"ReturnItem"})
        elif kind == "CompareStmt":
            add_nodes(node["arms"], child_depth, "arms", minimum=2, kinds={"CompareArm"})
            add_nodes(node["groupBy"], child_depth, "groupBy", kinds={"GroupKey"})
            add_nodes(node["returns"], child_depth, "returns", minimum=1, kinds={"ReturnItem"})
        elif kind == "CompareArm":
            _require_string(node["label"], "label", nullable=True, allow_empty=True)
            add_node(node["when"], child_depth, "when", kinds=_EXPRESSION_KINDS)
        elif kind == "ChainClause":
            add_node(node["trigger"], child_depth, "trigger", kinds={"EventRef"})
            add_node(node["window"], child_depth, "window", nullable=True, kinds={"DurationLit"})
            add_node(
                node["condition"],
                child_depth,
                "condition",
                nullable=True,
                kinds=_EXPRESSION_KINDS,
            )
        elif kind in {"GroupKey", "ReturnItem"}:
            _require_identifier(node["alias"], "alias", nullable=True)
            add_node(node["expr"], child_depth, "expr", kinds=_EXPRESSION_KINDS)
        elif kind == "NumberLit":
            _require_number(node["value"], "value")
        elif kind == "StringLit":
            _require_string(node["value"], "value", allow_empty=True)
        elif kind == "BoolLit":
            if type(node["value"]) is not bool:
                raise _invalid_request("불리언 값이 올바르지 않습니다.")
        elif kind in {"DurationLit", "ClockLit"}:
            _require_number(node["seconds"], "seconds", nonnegative=True)
            _require_string(node["raw"], "raw")
        elif kind == "Identifier":
            _require_identifier(node["name"], "name")
        elif kind == "RegionRef":
            _require_string(node["name"], "name")
            if not _REGION_ID.fullmatch(node["name"]):
                raise _invalid_request("영역 식별자는 영문 snake_case여야 합니다.")
        elif kind == "EventRef":
            _require_string(node["bindingId"], "bindingId")
            _require_identifier(node["eventType"], "eventType")
            _require_identifier(node["surface"], "surface")
            add_node(node["scope"], child_depth, "scope", nullable=True, kinds={"ScopeRef"})
            ordinal = node["ordinal"]
            valid_named_ordinal = isinstance(ordinal, str) and ordinal in {"first", "last", "any"}
            valid_numbered_ordinal = (
                isinstance(ordinal, int) and not isinstance(ordinal, bool) and 1 <= ordinal <= 255
            )
            if not valid_named_ordinal and not valid_numbered_ordinal:
                raise _invalid_request("사건 순서 지정이 올바르지 않습니다.")
            scope = node["scope"]
            scope_identity = (
                ""
                if scope is None
                else json.dumps(
                    {
                        "entity": scope.get("entity"),
                        "side": scope.get("side"),
                        "relation": scope.get("relation"),
                        "selector": scope.get("selector"),
                    },
                    sort_keys=True,
                    ensure_ascii=False,
                )
            )
            descriptor = (
                node["eventType"],
                scope_identity,
                json.dumps(ordinal, sort_keys=True, ensure_ascii=False),
            )
            previous = bindings.setdefault(node["bindingId"], descriptor)
            if previous != descriptor:
                raise _invalid_request("같은 사건 바인딩이 서로 다른 사건을 가리킵니다.")
        elif kind == "EventPredicate":
            if type(node["negated"]) is not bool:
                raise _invalid_request("사건 부정 값이 올바르지 않습니다.")
            add_node(node["event"], child_depth, "event", kinds={"EventRef"})
        elif kind == "FieldAccess":
            _require_identifier(node["field"], "field")
            add_node(node["object"], child_depth, "object", kinds=_EXPRESSION_KINDS)
        elif kind == "CallExpr":
            _require_identifier(node["callee"], "callee")
            add_node(node["scope"], child_depth, "scope", nullable=True, kinds={"ScopeRef"})
            add_nodes(node["args"], child_depth, "args", kinds=_EXPRESSION_KINDS)
        elif kind == "MeasureAt":
            _require_identifier(node["measure"], "measure")
            add_node(node["scope"], child_depth, "scope", nullable=True, kinds={"ScopeRef"})
            add_node(node["at"], child_depth, "at", kinds={"ClockLit", "DurationLit"})
        elif kind == "BinaryExpr":
            if node["op"] not in _BINARY_OPERATORS:
                raise _invalid_request("지원하지 않는 비교 또는 계산 연산자입니다.")
            add_node(node["left"], child_depth, "left", kinds=_EXPRESSION_KINDS)
            add_node(node["right"], child_depth, "right", kinds=_EXPRESSION_KINDS)
        elif kind == "UnaryExpr":
            if node["op"] not in _UNARY_OPERATORS:
                raise _invalid_request("지원하지 않는 단항 연산자입니다.")
            add_node(node["operand"], child_depth, "operand", kinds=_EXPRESSION_KINDS)
        elif kind == "InExpr":
            if type(node["negated"]) is not bool:
                raise _invalid_request("포함 조건의 부정 값이 올바르지 않습니다.")
            add_node(node["value"], child_depth, "value", kinds=_EXPRESSION_KINDS)
            add_nodes(node["set"], child_depth, "set", kinds=_EXPRESSION_KINDS)
        elif kind == "SpatialPredicate":
            if node["relation"] not in _SPATIAL_RELATIONS:
                raise _invalid_request("지원하지 않는 공간 관계입니다.")
            add_node(node["position"], child_depth, "position", kinds=_EXPRESSION_KINDS)
            add_node(node["target"], child_depth, "target", kinds=_EXPRESSION_KINDS)
            add_node(node["radius"], child_depth, "radius", nullable=True, kinds={"NumberLit"})
        elif kind == "TemporalPredicate":
            if node["relation"] not in _TEMPORAL_RELATIONS:
                raise _invalid_request("지원하지 않는 시간 관계입니다.")
            add_node(node["left"], child_depth, "left", kinds=_EXPRESSION_KINDS)
            add_node(node["right"], child_depth, "right", nullable=True, kinds=_EXPRESSION_KINDS)
            add_node(
                node["rightUpper"],
                child_depth,
                "rightUpper",
                nullable=True,
                kinds=_EXPRESSION_KINDS,
            )
            add_node(node["window"], child_depth, "window", nullable=True, kinds={"DurationLit"})


def _validate_regions(regions: Any) -> None:
    _json_size(regions, settings.max_region_bytes, "영역")
    if not isinstance(regions, dict) or len(regions) > settings.max_regions:
        raise _invalid_request("영역 수가 허용 범위를 넘었습니다.")

    vertices = 0

    def coordinate(value: Any) -> None:
        _require_number(value, "영역 좌표")
        if not 0 <= float(value) <= 1:
            raise _invalid_request("영역 좌표는 0과 1 사이여야 합니다.")

    def shape(value: Any, depth: int = 1) -> None:
        nonlocal vertices
        if not isinstance(value, dict) or depth > 8:
            raise _invalid_request("영역 도형 구조가 올바르지 않습니다.")
        kind = value.get("kind")
        if kind == "polygon":
            if set(value) != {"kind", "points"} or not isinstance(value["points"], list):
                raise _invalid_request("다각형 필드가 올바르지 않습니다.")
            if len(value["points"]) < 3:
                raise _invalid_request("다각형에는 점이 세 개 이상 필요합니다.")
            vertices += len(value["points"])
            if vertices > settings.max_region_vertices:
                raise _invalid_request("영역 꼭짓점 수가 허용 범위를 넘었습니다.")
            for point in value["points"]:
                if not isinstance(point, list) or len(point) != 2:
                    raise _invalid_request("다각형 좌표가 올바르지 않습니다.")
                coordinate(point[0])
                coordinate(point[1])
        elif kind == "rect":
            if set(value) != {"kind", "x0", "y0", "x1", "y1"}:
                raise _invalid_request("사각형 필드가 올바르지 않습니다.")
            vertices += 4
            for field in ("x0", "y0", "x1", "y1"):
                coordinate(value[field])
        elif kind == "circle":
            if set(value) != {"kind", "cx", "cy", "r"}:
                raise _invalid_request("원 필드가 올바르지 않습니다.")
            vertices += 1
            coordinate(value["cx"])
            coordinate(value["cy"])
            _require_number(value["r"], "원의 반경")
            if not 0 < float(value["r"]) <= 2:
                raise _invalid_request("원의 반경이 허용 범위를 벗어났습니다.")
        elif kind == "multi":
            if (
                set(value) != {"kind", "parts"}
                or not isinstance(value["parts"], list)
                or not value["parts"]
            ):
                raise _invalid_request("복합 영역 필드가 올바르지 않습니다.")
            for part in value["parts"]:
                shape(part, depth + 1)
        else:
            raise _invalid_request("지원하지 않는 영역 도형입니다.")
        if vertices > settings.max_region_vertices:
            raise _invalid_request("영역 꼭짓점 수가 허용 범위를 넘었습니다.")

    for region_id, definition in regions.items():
        if not isinstance(region_id, str) or not _REGION_ID.fullmatch(region_id):
            raise _invalid_request("영역 식별자는 영문 snake_case여야 합니다.")
        if not isinstance(definition, dict):
            raise _invalid_request("영역 정의가 올바르지 않습니다.")
        shape(definition.get("shape", definition))


class DatasetInput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    patch: str | None = Field(default=None, max_length=64)
    queue: str | None = Field(default=None, max_length=64)
    tier: str | None = Field(default=None, max_length=32)
    region: str | None = Field(default=None, max_length=64)
    exclude_remakes: bool = Field(default=True, alias="excludeRemakes")


class AnalysisRunInput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ast: dict[str, Any]
    regions: dict[str, dict[str, Any]] = Field(default_factory=dict)
    dataset: DatasetInput | None = None
    catalog_hash: str = Field(alias="catalogHash", min_length=1, max_length=128)

    @field_validator("ast")
    @classmethod
    def validate_ast(cls, value: dict[str, Any]) -> dict[str, Any]:
        validate_analysis_ast(value)
        return value

    @field_validator("regions")
    @classmethod
    def validate_regions(cls, value: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        _validate_regions(value)
        return value


@router.post("/analyses/bias-audit")
def bias_audit(body: AnalysisRunInput) -> dict[str, Any]:
    """Inspect a valid analysis without changing its cohort or running statistics."""
    catalog = load_effective_catalog()
    if body.catalog_hash != catalog.hash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "E-SEM-060",
                "messageKo": "분석 카탈로그가 바뀌었습니다. 화면을 새로고침해 주세요.",
                "catalogHash": catalog.hash,
            },
        )
    dataset = DatasetFilter(**body.dataset.model_dump()) if body.dataset else None
    shapes = {region_id: value.get("shape", value) for region_id, value in body.regions.items()}
    try:
        plan = PlanBuilder(catalog).build(body.ast, regions=shapes, dataset=dataset)
    except PlanError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": exc.code, "messageKo": exc.message_ko},
        ) from exc
    return audit_plan(plan, dataset_source=catalog.as_dict().get("datasetSource"))


@router.post("/analyses/run", status_code=status.HTTP_202_ACCEPTED)
def run_analysis(body: AnalysisRunInput) -> dict[str, str]:
    catalog = load_effective_catalog()
    if body.catalog_hash != catalog.hash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "E-SEM-060",
                "messageKo": "분석 카탈로그가 바뀌었습니다. 화면을 새로고침해 주세요.",
                "catalogHash": catalog.hash,
            },
        )
    dataset = DatasetFilter(**body.dataset.model_dump()) if body.dataset else None
    shapes = {region_id: value.get("shape", value) for region_id, value in body.regions.items()}
    try:
        # Reject structurally valid but non-executable ASTs before they consume queue capacity.
        plan = PlanBuilder(catalog).build(body.ast, regions=shapes, dataset=dataset)
        SqlCompiler(plan, catalog, has_spatial=False).compile_combined()
    except PlanError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": exc.code, "messageKo": exc.message_ko},
        ) from exc
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "E-SEM-001",
                "messageKo": "분석에서 사용할 수 없는 사건, 측정값 또는 조건을 발견했습니다.",
            },
        ) from exc
    try:
        run_id = manager.submit(body.ast, regions=body.regions, dataset=dataset)
    except RunQueueFull as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "E-RUN-001",
                "messageKo": "실행 대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요.",
            },
        ) from exc
    return {"runId": run_id}


@router.get("/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    record = manager.get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="실행을 찾을 수 없습니다.")
    return {
        "runId": run_id,
        "status": record.status,
        "result": record.response,
        "diagnostic": record.diagnostic,
    }


@router.get("/runs/{run_id}/events")
def run_events(run_id: str) -> StreamingResponse:
    if manager.get(run_id) is None:
        raise HTTPException(status_code=404, detail="실행을 찾을 수 없습니다.")

    def stream():
        index = 0
        while True:
            events, terminal = manager.wait_events(run_id, index)
            if not events and not terminal:
                yield ": keep-alive\n\n"
                continue
            for event in events:
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            index += len(events)
            if terminal:
                return

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_run(run_id: str) -> Response:
    record = manager.get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="실행을 찾을 수 없습니다.")
    manager.cancel(run_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/runs/{run_id}/explain")
def explain_run(run_id: str) -> dict[str, Any]:
    record = manager.get(run_id)
    if record is None or record.plan is None:
        raise HTTPException(status_code=404, detail="실행 계획을 찾을 수 없습니다.")
    engine = manager.engine
    return {
        "sql": engine.explain(record.plan),
        "conditions": [
            {"id": atom.id, "dsl": atom.dsl, "labelKo": atom.label_ko} for atom in record.plan.atoms
        ],
        "astHash": record.plan.ast_hash,
        "cacheKey": record.cache_key,
        "snapshotId": record.snapshot_id,
    }


@router.get("/runs/{run_id}/matches")
def matched_matches(
    run_id: str,
    cursor: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict[str, Any]:
    record = manager.get(run_id)
    if record is None or record.plan is None:
        raise HTTPException(status_code=404, detail="실행 계획을 찾을 수 없습니다.")
    if record.status != "completed":
        raise HTTPException(status_code=409, detail="완료된 분석에서만 경기 목록을 볼 수 있습니다.")
    engine = manager.engine
    if not isinstance(engine, DuckDBEngine):
        raise HTTPException(status_code=501, detail="이 엔진은 경기 목록을 제공하지 않습니다.")
    table = engine.matched_matches(record.plan, run_id=run_id, limit=limit, offset=cursor)
    rows = []
    for raw in table.to_pylist():
        row = {
            key: value
            for key, value in raw.items()
            if not key.startswith("truth_") and not key.startswith("arm_")
        }
        arms = [
            {"id": arm.id, "labelKo": arm.label_ko}
            for arm in record.plan.compare_arms
            if raw.get(f"arm_{arm.id}") is True
        ]
        if arms:
            row["arms"] = arms
        if len(arms) == 1:
            row["arm"] = arms[0]["labelKo"]
        rows.append(row)
    return {
        "items": rows,
        "nextCursor": cursor + len(rows) if len(rows) == limit else None,
    }


@router.get("/matches/{match_id}")
def match_detail(
    match_id: str,
    run_id: str = Query(alias="runId"),
    team_id: int | None = Query(default=None, alias="teamId"),
    participant_id: int | None = Query(default=None, alias="participantId"),
    event_id: int | None = Query(default=None, alias="eventId"),
) -> dict[str, Any]:
    record = manager.get(run_id)
    if record is None or record.plan is None:
        raise HTTPException(status_code=404, detail="실행 계획을 찾을 수 없습니다.")
    if record.status != "completed":
        raise HTTPException(status_code=409, detail="완료된 분석에서만 경기 상세를 볼 수 있습니다.")
    engine = manager.engine
    if not isinstance(engine, DuckDBEngine):
        raise HTTPException(status_code=501, detail="이 엔진은 경기 상세를 제공하지 않습니다.")
    try:
        detail = engine.match_detail(
            record.plan,
            run_id=run_id,
            match_id=match_id,
            team_id=team_id,
            participant_id=participant_id,
            event_id=event_id,
        )
    except AmbiguousMatchedUnit as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                "이 경기에는 여러 분석 단위가 포함되어 있습니다. 팀이나 선수 단위를 선택해 주세요."
            ),
        ) from exc
    if detail is None:
        raise HTTPException(status_code=404, detail="이 분석에 포함된 경기가 아닙니다.")
    return detail
