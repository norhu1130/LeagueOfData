"""Lower ASTs to PhysicalPlan using a flagged base join.

Conditions become boolean columns over base rows and the original tree is rebuilt over those
columns. This supports nested logic and per-condition funnels in one scan. Event names and SQL
predicates come exclusively from the catalog.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from lod_api.canonical import canonical_hash
from lod_api.catalog import Catalog, load_effective_catalog
from lod_api.korean import eul_reul, i_ga

from .plan import (
    Atom,
    AtomKind,
    BoolNode,
    ChainSpec,
    CompareArm,
    DatasetFilter,
    EventBinding,
    FrameProbe,
    Grain,
    GroupKey,
    Measure,
    PhysicalPlan,
    RegionShape,
)


class PlanError(Exception):
    """AST that cannot be planned and should have been rejected by validation."""

    def __init__(self, message_ko: str, code: str = "E-PLAN-001") -> None:
        super().__init__(message_ko)
        self.message_ko = message_ko
        self.code = code


GRAIN_UNIT_KO: dict[str, str] = {
    "match": "경기",
    "team": "팀-경기",
    "player": "선수-경기",
    "event": "사건",
}


class PlanBuilder:
    def __init__(self, catalog: Catalog | None = None) -> None:
        self.catalog = catalog or load_effective_catalog()
        self._bindings: dict[str, EventBinding] = {}
        self._probes: dict[str, FrameProbe] = {}
        self._atoms: list[Atom] = []
        self._regions: dict[str, RegionShape] = {}
        self._player_selector: str | None = None
        self._grain: Grain = "match"
        self._building_chain = False

    # ------------------------------------------------------------------ Entry

    def build(
        self,
        ast: dict[str, Any],
        *,
        regions: dict[str, dict[str, Any]] | None = None,
        dataset: DatasetFilter | None = None,
    ) -> PhysicalPlan:
        self._bindings.clear()
        self._probes.clear()
        self._atoms.clear()
        self._regions.clear()
        self._player_selector = None

        for name, shape in (regions or {}).items():
            self._regions[name] = RegionShape(id=name, kind=shape["kind"], payload=dict(shape))

        body = ast["body"]
        grain, team_side, player_selector = self._infer_grain(ast)
        self._grain = grain
        self._player_selector = player_selector

        self._building_chain = bool(body.get("chain"))
        try:
            chain = self._build_chain(body, team_side) if body.get("chain") else None
        finally:
            self._building_chain = False
        if chain is not None:
            grain = "event"

        condition = BoolNode.always_true()
        compare_arms: tuple[CompareArm, ...] = ()

        if body["kind"] == "CompareStmt":
            arms = []
            for index, arm in enumerate(body["arms"]):
                node = self._lower_condition(arm["when"], team_side)
                label = arm.get("label") or f"조건 {index + 1}"
                arms.append(CompareArm(id=f"arm{index}", label_ko=label, condition=node))
            compare_arms = tuple(arms)
        else:
            if body.get("when"):
                condition = self._lower_condition(body["when"], team_side)
            if chain is not None and body["chain"].get("condition"):
                # The IF clause is a chain success condition and is handled separately.
                pass

        measures = self._build_measures(body["returns"], grain, team_side)
        chain_as_filter = chain is not None and not any(
            measure.function == "success_rate" for measure in measures
        )
        if any(measure.function == "success_rate" for measure in measures) and (
            chain is None or chain.target is None
        ):
            raise PlanError(
                "성공률을 계산하려면 이어지는 사건 조건이 필요합니다.", code="E-SEM-034"
            )
        group_keys = self._build_group_keys(body.get("groupBy", []), grain, team_side)
        if compare_arms and group_keys:
            raise PlanError(
                "비교 분석과 그룹 나누기는 아직 함께 사용할 수 없습니다.", code="E-SEM-054"
            )
        return PhysicalPlan(
            grain=grain,
            grain_unit_ko=GRAIN_UNIT_KO[grain],
            team_side=team_side,
            player_selector=player_selector,
            dataset=dataset or DatasetFilter(),
            bindings=tuple(self._bindings.values()),
            probes=tuple(self._probes.values()),
            regions=tuple(self._regions.values()),
            atoms=tuple(self._atoms),
            condition=condition,
            measures=measures,
            group_keys=group_keys,
            chain=chain,
            chain_as_filter=chain_as_filter,
            compare_arms=compare_arms,
            result_shape=self._result_shape(measures, group_keys, compare_arms),
            denominator_ko=self._denominator(grain, team_side),
            ast_hash=canonical_hash(ast),
        )

    # -------------------------------------------------------------- Analysis grain

    def _infer_grain(self, ast: dict[str, Any]) -> tuple[Grain, str | None, str | None]:
        analyze = ast.get("analyze")
        if analyze:
            entity = analyze["entity"]
            if entity == "team":
                return "team", analyze.get("side"), None
            if entity == "player":
                return "player", None, analyze.get("selector")
            return "match", None, None

        side = self._find_team_side(ast)
        if side is not None:
            return "team", side, None
        player_selector = self._find_player_selector(ast)
        if player_selector is not None:
            return "player", None, player_selector
        return "match", None, None

    def _find_team_side(self, node: Any) -> str | None:
        if isinstance(node, dict):
            if node.get("kind") == "ScopeRef" and node.get("entity") == "team":
                return node.get("side")
            for value in node.values():
                found = self._find_team_side(value)
                if found is not None:
                    return found
        elif isinstance(node, list):
            for item in node:
                found = self._find_team_side(item)
                if found is not None:
                    return found
        return None

    def _find_player_selector(self, node: Any) -> str | None:
        if isinstance(node, dict):
            if node.get("kind") == "ScopeRef" and node.get("entity") == "player":
                return node.get("selector", "")
            for value in node.values():
                found = self._find_player_selector(value)
                if found is not None:
                    return found
        elif isinstance(node, list):
            for item in node:
                found = self._find_player_selector(item)
                if found is not None:
                    return found
        return None

    def _denominator(self, grain: Grain, team_side: str | None) -> str:
        unit = GRAIN_UNIT_KO[grain]
        if grain == "team" and team_side:
            side_ko = "블루팀" if team_side == "blue" else "레드팀"
            return f"조건을 만족한 {side_ko} {unit}"
        return f"조건을 만족한 {unit}"

    # ------------------------------------------------------------------ Bindings

    def _bind_event(self, event_ref: dict[str, Any], default_side: str | None) -> EventBinding:
        """Register one event witness, reusing an existing binding ID."""
        binding_id = event_ref["bindingId"]
        existing = self._bindings.get(binding_id)
        if existing is not None:
            return existing

        event = self.catalog.event(event_ref["eventType"])
        if not event.available:
            raise PlanError(f"{event.label_ko}은(는) 이 데이터에 없습니다.", code="E-SEM-020")

        scope = event_ref.get("scope")
        side = scope.get("side") if scope else None
        relation = scope.get("relation") if scope else None
        if relation and not self._building_chain:
            raise PlanError(
                "시작 사건의 상대팀은 이어지는 사건에서만 사용할 수 있습니다.",
                code="E-SEM-056",
            )
        any_team = bool(scope and scope.get("entity") == "team" and side is None)
        participant_scoped = bool(scope and scope.get("entity") == "player")
        participant_selector = scope.get("selector") if participant_scoped else None
        if participant_scoped and self._grain != "player" and not self._building_chain:
            raise PlanError(
                "선수 사건은 선수 단위 분석에서만 사용할 수 있습니다.", code="E-SEM-052"
            )
        if (
            participant_selector is not None
            and self._player_selector is not None
            and participant_selector != self._player_selector
            and not self._building_chain
        ):
            raise PlanError("분석 대상 선수와 사건의 선수가 서로 다릅니다.", code="E-SEM-052")
        ordinal = event_ref.get("ordinal", "any")
        if not (
            isinstance(ordinal, str)
            and ordinal in {"first", "last", "any"}
            or isinstance(ordinal, int)
            and not isinstance(ordinal, bool)
            and 1 <= ordinal <= 255
        ):
            raise PlanError("사건 순서는 1부터 255 사이의 정수여야 합니다.", code="E-SEM-010")

        # An unscoped event is target-relative. At team/player grain its witness must stay
        # correlated to the base row's team, including match-unique winner events such as victory.
        per_team = "team" in event.context and scope is None and self._grain in ("team", "player")

        binding = EventBinding(
            id=f"e{len(self._bindings)}",
            binding_id=binding_id,
            event_id=event.id,
            table=event.table,
            where=event.where,
            ordinal=ordinal,
            team_side=side,
            any_team=any_team,
            per_team=per_team,
            participant_scoped=participant_scoped,
            participant_selector=participant_selector,
            label_ko=(
                f"{ordinal}번째 {event.label_ko}"
                if isinstance(ordinal, int)
                else f"마지막 {event.label_ko}"
                if ordinal == "last"
                else event.label_ko
            ),
        )
        self._bindings[binding_id] = binding
        return binding

    def _bind_probe(self, measure_node: dict[str, Any], default_side: str | None) -> FrameProbe:
        measure = measure_node["measure"]
        at = measure_node["at"]["seconds"]
        scope = measure_node.get("scope")
        side = scope.get("side") if scope else default_side
        if side is not None and side != default_side:
            raise PlanError("시점 측정의 진영이 분석 대상 진영과 다릅니다.", code="E-SEM-052")
        key = f"{measure}@{at}@{side}"
        existing = self._probes.get(key)
        if existing is not None:
            return existing

        fn = self.catalog.function(measure)
        if self._grain not in fn.get("validGrains", []):
            raise PlanError(
                "이 시점 측정은 현재 분석 단위에서 사용할 수 없습니다.", code="E-SEM-051"
            )
        column = fn.get("frameColumn")
        if not column:
            raise PlanError(f"{fn['labelKo']}은(는) 시점 측정이 아닙니다.")

        probe = FrameProbe(
            id=f"g{len(self._probes)}",
            measure=measure,
            column=column,
            at_seconds=float(at),
            team_side=side,
            label_ko=fn["labelKo"],
        )
        self._probes[key] = probe
        return probe

    # -------------------------------------------------------------- Condition flattening

    def _add_atom(self, kind: AtomKind, label_ko: str, dsl: str, **params: Any) -> BoolNode:
        atom = Atom(
            id=f"f{len(self._atoms)}",
            kind=kind,
            label_ko=label_ko,
            dsl=dsl,
            params=params,
        )
        self._atoms.append(atom)
        return BoolNode(op="atom", atom=atom.id)

    def _lower_condition(self, node: dict[str, Any], side: str | None) -> BoolNode:
        kind = node["kind"]

        if kind == "BinaryExpr" and node["op"] in ("AND", "OR"):
            grouped = self._lower_event_location_group(node, side)
            if grouped is not None:
                return grouped
            return BoolNode(
                op="and" if node["op"] == "AND" else "or",
                children=(
                    self._lower_condition(node["left"], side),
                    self._lower_condition(node["right"], side),
                ),
            )

        if kind == "UnaryExpr" and node["op"] == "NOT":
            return BoolNode(op="not", children=(self._lower_condition(node["operand"], side),))

        if kind == "EventPredicate":
            binding = self._bind_event(node["event"], side)
            negated = bool(node.get("negated"))
            return self._add_atom(
                AtomKind.EVENT_EXISTS,
                f"{self._side_ko(binding.team_side)}{eul_reul(binding.label_ko)} "
                + ("기록하지 않았습니다" if negated else "기록했습니다"),
                f"{binding.event_id}",
                binding=binding.id,
                negated=negated,
            )

        if kind == "SpatialPredicate":
            return self._lower_spatial(node, side)

        if kind == "BinaryExpr":
            return self._lower_comparison(node, side)

        if kind == "InExpr":
            return self._lower_membership(node, side)

        if kind == "CallExpr" and node.get("callee") == "all_values":
            args = node.get("args", [])
            if len(args) != 1 or args[0].get("kind") != "InExpr":
                raise PlanError(
                    "선택한 값 모두 조건에는 목록 조건 하나가 필요합니다.", code="E-SEM-033"
                )
            return self._lower_membership(args[0], side, require_all=True)

        if kind == "CallExpr" and node.get("callee") in {
            "opponent_has_champion",
            "ally_has_champion",
            "opponent_has_champion_in_role",
        }:
            callee = node["callee"]
            if self._grain not in (
                {"team", "player"} if callee == "opponent_has_champion" else {"player"}
            ):
                raise PlanError(
                    "이 로스터 조건은 현재 분석 단위에서 사용할 수 없습니다.",
                    code="E-SEM-051",
                )
            args = node.get("args", [])
            role = None
            if callee == "opponent_has_champion_in_role":
                if len(args) != 2:
                    raise PlanError("챔피언과 포지션이 필요합니다.", code="E-SEM-033")
                role = str(self._literal_value(args[1])).upper()
                args = args[:1]
                if role not in {"TOP", "JUNGLE", "MID", "BOT", "SUPPORT"}:
                    raise PlanError("포지션 값이 올바르지 않습니다.", code="E-SEM-043")
            champions = [self._literal_value(arg) for arg in args]
            if (
                not champions
                or len(champions) > 5
                or not all(isinstance(champion, str) and champion for champion in champions)
            ):
                raise PlanError(
                    "팀 챔피언 조건에는 챔피언 이름을 1개부터 5개까지 넣어 주세요.",
                    code="E-SEM-033",
                )
            if callee == "ally_has_champion":
                label_ko = f"같은 팀에 {', '.join(champions)} 챔피언이 있습니다"
            elif callee == "opponent_has_champion_in_role":
                label_ko = f"상대팀 {role} 포지션에 {', '.join(champions)} 챔피언이 있습니다"
            else:
                label_ko = f"상대팀에 {', '.join(champions)} 챔피언이 있습니다"
            return self._add_atom(
                AtomKind.ROSTER,
                label_ko,
                f"{callee}({', '.join(champions)}"
                + (f", {role}" if role is not None else "")
                + ")",
                relation="ally" if callee == "ally_has_champion" else "opponent",
                champions=champions,
                role=role,
            )

        if kind == "CallExpr" and node.get("callee") in {
            "purchased_item_by",
            "owns_item_at",
        }:
            return self._lower_item_state(node)

        if kind == "TemporalPredicate":
            return self._lower_temporal(node, side)

        if kind == "BoolLit":
            return (
                BoolNode.always_true()
                if node["value"]
                else BoolNode(op="not", children=(BoolNode.always_true(),))
            )

        raise PlanError(f"아직 실행할 수 없는 조건입니다: {kind}")

    def _lower_item_state(self, node: dict[str, Any]) -> BoolNode:
        if self._grain not in {"team", "player"}:
            raise PlanError(
                "시점 아이템 조건은 팀 또는 선수 단위 분석에서만 사용할 수 있습니다.",
                code="E-SEM-051",
            )
        args = node.get("args", [])
        if not 2 <= len(args) <= 21:
            raise PlanError(
                "시점 아이템 조건에는 판정 시점과 아이템을 1개부터 20개까지 넣어 주세요.",
                code="E-SEM-033",
            )
        at_node = args[0]
        if at_node.get("kind") != "ClockLit":
            raise PlanError("아이템 판정 시점은 15:00처럼 입력해 주세요.", code="E-SEM-043")
        at_seconds = float(self._literal_value(at_node))
        if not 0 <= at_seconds <= 86_400:
            raise PlanError("아이템 판정 시점이 올바른 범위를 벗어났습니다.", code="E-SEM-043")
        item_ids = [self._literal_value(arg) for arg in args[1:]]
        if not all(
            isinstance(item_id, int)
            and not isinstance(item_id, bool)
            and 0 < item_id <= 0xFFFF_FFFF
            for item_id in item_ids
        ):
            raise PlanError("아이템 ID는 1 이상의 정수여야 합니다.", code="E-SEM-043")
        item_ids = list(dict.fromkeys(item_ids))

        scope = node.get("scope")
        scope_side = scope.get("side") if scope else None
        relation = scope.get("relation") if scope else None
        scope_entity = scope.get("entity") if scope else None
        if relation and self._grain not in {"team", "player"}:
            raise PlanError(
                "상대팀 아이템 조건을 적용할 수 없는 분석 단위입니다.", code="E-SEM-052"
            )
        if scope_side is not None:
            raise PlanError(
                "시점 아이템 조건은 분석 대상 또는 opponent 기준으로 사용해 주세요.",
                code="E-SEM-052",
            )
        allowed_scope_entities = {None, self._grain}
        if relation:
            allowed_scope_entities.add("team")
        if scope_entity not in allowed_scope_entities:
            raise PlanError("아이템 조건의 대상이 분석 단위와 다릅니다.", code="E-SEM-052")

        callee = node["callee"]
        mode = "purchased_by" if callee == "purchased_item_by" else "owned_at"
        at_label = at_node.get("raw") or f"{int(at_seconds // 60)}:{int(at_seconds % 60):02d}"
        subject = "상대팀이" if relation else "분석 대상이"
        action = "구매했습니다" if mode == "purchased_by" else "보유 중입니다"
        return self._add_atom(
            AtomKind.ITEM_STATE,
            f"{at_label}에 {subject} 선택 아이템 중 하나를 {action}",
            f"{callee}({at_label}, {', '.join(map(str, item_ids))})",
            mode=mode,
            at_seconds=at_seconds,
            item_ids=item_ids,
            relation="opponent" if relation else "target",
        )

    def _lower_event_location_group(
        self, node: dict[str, Any], side: str | None
    ) -> BoolNode | None:
        """Keep an occurrence and its location qualifier on one repeated event row."""
        if node.get("op") != "AND":
            return None
        occurrence = next(
            (
                part
                for part in (node["left"], node["right"])
                if part.get("kind") == "EventPredicate"
            ),
            None,
        )
        spatial = next(
            (
                part
                for part in (node["left"], node["right"])
                if part.get("kind") == "SpatialPredicate"
            ),
            None,
        )
        if not occurrence or not spatial or occurrence.get("negated"):
            return None
        position = spatial.get("position", {})
        spatial_event = position.get("object", {}) if position.get("kind") == "FieldAccess" else {}

        def effective_event_side(event: dict[str, Any]) -> str | None:
            scope = event.get("scope")
            if scope and scope.get("entity") == "team":
                return scope.get("side", "any")
            return side

        if (
            spatial.get("relation") != "IN_REGION"
            or spatial.get("target", {}).get("kind") != "RegionRef"
            or position.get("field") != "position"
            or spatial_event.get("kind") != "EventRef"
            or occurrence["event"].get("eventType") != spatial_event.get("eventType")
            or occurrence["event"].get("ordinal") != spatial_event.get("ordinal")
            or effective_event_side(occurrence["event"]) != effective_event_side(spatial_event)
        ):
            return None
        binding = self._bind_event(occurrence["event"], side)
        self._require_event_context(binding, "position")
        region_name = spatial["target"]["name"]
        if region_name not in self._regions:
            raise PlanError(f'"{region_name}" 영역이 이 분석에 없습니다.', code="E-SEM-041")
        return self._add_atom(
            AtomKind.EVENT_GROUP,
            f'{i_ga(binding.label_ko)} "{region_name}" 영역 안에서 발생했습니다',
            f'{binding.event_id} AND {binding.event_id}.position IN region("{region_name}")',
            binding=binding.id,
            region=region_name,
        )

    def _lower_spatial(self, node: dict[str, Any], side: str | None) -> BoolNode:
        position = node["position"]
        binding = self._position_binding(position, side)
        self._require_event_context(binding, "position")
        target = node["target"]

        if node["relation"] == "IN_REGION":
            if target["kind"] != "RegionRef":
                raise PlanError("영역 조건에는 영역이 필요합니다.")
            region_name = target["name"]
            if region_name not in self._regions:
                raise PlanError(f'"{region_name}" 영역이 이 분석에 없습니다.', code="E-SEM-041")
            return self._add_atom(
                AtomKind.SPATIAL_REGION,
                f'{i_ga(binding.label_ko)} "{region_name}" 영역 안입니다',
                f'{binding.event_id}.position IN region("{region_name}")',
                binding=binding.id,
                region=region_name,
            )

        if node["relation"] == "WITHIN_RADIUS":
            radius = node.get("radius")
            if not radius:
                raise PlanError("거리 조건에 반경이 없습니다.")
            target_x, target_y, target_label = self._landmark_position(target)
            return self._add_atom(
                AtomKind.SPATIAL_RADIUS,
                f"{i_ga(binding.label_ko)} {target_label}에서 {radius['value']} 이내입니다",
                f"{binding.event_id}.position WITHIN {radius['value']} OF ...",
                binding=binding.id,
                radius=float(radius["value"]),
                target_x=target_x,
                target_y=target_y,
            )

        raise PlanError("아직 실행할 수 없는 위치 조건입니다.")

    def _landmark_position(self, target: dict[str, Any]) -> tuple[float, float, str]:
        if target.get("kind") != "FieldAccess":
            raise PlanError("거리 조건의 기준 지점을 알 수 없습니다.")
        obj = target["object"]
        if obj.get("kind") != "Identifier":
            raise PlanError("거리 조건의 기준 지점을 알 수 없습니다.")
        landmark_id = f"{obj['name']}.{target['field']}"
        try:
            landmark = self.catalog.landmark(landmark_id)
        except KeyError as exc:
            raise PlanError(f'"{landmark_id}" 기준 지점이 없습니다.', code="E-SEM-010") from exc
        return float(landmark["xRaw"]), float(landmark["yRaw"]), str(landmark["labelKo"])

    def _position_binding(self, position: dict[str, Any], side: str | None) -> EventBinding:
        """Find and bind the event referenced by `first_blood.position`."""
        if position.get("kind") == "FieldAccess":
            obj = position["object"]
            if obj.get("kind") == "EventRef":
                return self._bind_event(obj, side)
            if obj.get("kind") == "Identifier":
                event_id, ordinal = self.catalog.resolve_surface(obj["name"])
                implicit_scope = (
                    {"kind": "ScopeRef", "entity": "team", "side": side} if side else None
                )
                return self._bind_event(
                    {
                        "bindingId": f"{side or 'any'}.{event_id}#{ordinal}",
                        "eventType": event_id,
                        "ordinal": ordinal,
                        "scope": implicit_scope,
                        "surface": obj["name"],
                    },
                    side,
                )
        raise PlanError("위치 조건이 어떤 사건의 위치인지 알 수 없습니다.")

    def _lower_comparison(self, node: dict[str, Any], side: str | None) -> BoolNode:
        left = node["left"]
        right = node["right"]
        op = node["op"]
        if op not in {"=", "!=", ">", ">=", "<", "<="}:
            raise PlanError("허용되지 않는 비교 연산자입니다.", code="E-SEM-043")

        if left.get("kind") == "MeasureAt":
            probe = self._bind_probe(left, side)
            value = self._literal_value(right)
            minutes = int(probe.at_seconds // 60)
            return self._add_atom(
                AtomKind.FRAME_MEASURE,
                f"{minutes}분 시점 {i_ga(probe.label_ko)} {value:,.0f} {self._op_ko(op)}",
                f"{probe.measure}({minutes}:00) {op} {value}",
                probe=probe.id,
                op=op,
                value=value,
            )

        if left.get("kind") == "FieldAccess":
            obj = left["object"]
            field = left["field"]
            # Event-field comparison such as `first_blood.time < 600s`.
            if obj.get("kind") in ("EventRef", "Identifier"):
                try:
                    binding = self._position_binding({"kind": "FieldAccess", "object": obj}, side)
                except (PlanError, KeyError):
                    # Subject property rather than event property, such as `player.champion`.
                    binding = None
                if binding is not None:
                    self._require_event_context(binding, field)
                    field_def = self.catalog.context_field(field)
                    value = self._literal_value(right)
                    self._validate_context_values(field_def, [value])
                    return self._add_atom(
                        AtomKind.EVENT_FIELD,
                        f"{binding.label_ko}의 {i_ga(field_def['labelKo'])} "
                        f"{self._format_value(right)} {self._op_ko(op)}",
                        f"{binding.event_id}.{field} {op} {self._format_value(right)}",
                        binding=binding.id,
                        field=field,
                        sql=field_def["sql"],
                        op=op,
                        value=value,
                    )
            # Subject-property comparison such as `player.role = "TOP"`.
            return self._lower_attribute(obj, field, op, right)

        raise PlanError("아직 실행할 수 없는 비교입니다.")

    def _lower_membership(
        self, node: dict[str, Any], side: str | None, *, require_all: bool = False
    ) -> BoolNode:
        left = node["value"]
        values = [self._literal_value(item) for item in node.get("set", [])]
        if not values:
            raise PlanError("목록 조건에는 값을 하나 이상 넣어 주세요.", code="E-SEM-043")
        op = "NOT IN" if node.get("negated") else "IN"

        if left.get("kind") == "FieldAccess":
            obj = left["object"]
            field = left["field"]
            if obj.get("kind") in ("EventRef", "Identifier"):
                try:
                    binding = self._position_binding({"kind": "FieldAccess", "object": obj}, side)
                except (PlanError, KeyError):
                    binding = None
                if binding is not None:
                    if require_all and self._ambiguous_repeatable(binding) is False:
                        raise PlanError(
                            "선택한 값 모두 조건에는 반복될 수 있는 사건이 필요합니다.",
                            code="E-SEM-035",
                        )
                    self._require_event_context(binding, field)
                    field_def = self.catalog.context_field(field)
                    self._validate_context_values(field_def, values)
                    return self._add_atom(
                        AtomKind.EVENT_FIELD,
                        f"{binding.label_ko}의 {i_ga(field_def['labelKo'])} 선택한 목록에 "
                        + (
                            "모두 있습니다"
                            if require_all
                            else "없습니다"
                            if node.get("negated")
                            else "있습니다"
                        ),
                        f"{binding.event_id}.{field} {op} (...)",
                        binding=binding.id,
                        field=field,
                        sql=field_def["sql"],
                        op="CONTAINS ALL" if require_all else op,
                        values=values,
                    )
            if require_all:
                raise PlanError("선택한 값 모두 조건은 반복 사건의 속성에만 사용할 수 있습니다.")
            definition = self._attribute_definition(obj, field)
            value = {
                "kind": "StringLit",
                "value": ", ".join(str(item) for item in values),
            }
            return self._add_atom(
                AtomKind.ATTRIBUTE,
                f"{field} 값이 선택한 목록에 "
                + ("없습니다" if node.get("negated") else "있습니다"),
                f"{obj.get('name', '')}.{field} {op} (...)",
                sql=definition["sql"],
                op=op,
                values=values,
                value=value["value"],
            )

        raise PlanError("목록 조건의 왼쪽에는 사건 속성이나 분석 대상 속성이 필요합니다.")

    def _lower_attribute(
        self, obj: dict[str, Any], field: str, op: str, right: dict[str, Any]
    ) -> BoolNode:
        value = self._literal_value(right)
        definition = self._attribute_definition(obj, field)
        label = definition["labelKo"]
        return self._add_atom(
            AtomKind.ATTRIBUTE,
            f"{i_ga(label)} {self._format_value(right)} {self._op_ko(op)}",
            f"{obj.get('name', '')}.{field} {op} {self._format_value(right)}",
            sql=definition["sql"],
            op=op,
            value=value,
        )

    def _attribute_definition(self, obj: dict[str, Any], field: str) -> dict[str, Any]:
        if obj.get("kind") != "Identifier":
            raise PlanError("분석 대상의 속성만 사용할 수 있습니다.", code="E-SEM-043")
        entity = str(obj.get("name") or "").lower()
        entity_grain = "team" if entity in {"blue", "red", "team"} else entity
        if entity_grain != self._grain:
            raise PlanError("속성의 분석 단위가 현재 대상과 다릅니다.", code="E-SEM-052")
        raw = self.catalog.as_dict()
        definition = raw.get("subjectFields", {}).get(field) or raw.get("groupKeys", {}).get(field)
        if definition is None or self._grain not in definition.get("validGrains", []):
            raise PlanError("이 분석 대상에는 해당 속성이 없습니다.", code="E-SEM-010")
        return definition

    def _lower_temporal(self, node: dict[str, Any], side: str | None) -> BoolNode:
        relation = node["relation"]
        if relation in ("AFTER", "BEFORE") and node.get("right"):
            left = self._as_binding(node["left"], side)
            right = self._as_binding(node["right"], side)
            start, end = (right, left) if relation == "AFTER" else (left, right)
            window = node.get("window")
            seconds = window["seconds"] if window else None
            return self._add_atom(
                AtomKind.TEMPORAL_GAP,
                f"{i_ga(end.label_ko)} {start.label_ko} "
                + (f"이후 {int(seconds)}초 안에" if seconds else "이후에")
                + " 일어났습니다",
                f"{end.event_id} AFTER {start.event_id}",
                start=start.id,
                end=end.id,
                window=seconds,
                direction=relation,
            )
        if relation in ("WITHIN", "AT"):
            event_node = node["left"]
            binding = self._as_binding(event_node, side)
            self._require_event_context(binding, "time")
            time_node = node.get("window") if relation == "WITHIN" else node.get("right")
            if not time_node:
                raise PlanError("시간 값이 필요합니다.")
            seconds = self._literal_value(time_node)
            op = "<=" if relation == "WITHIN" else "="
            return self._add_atom(
                AtomKind.EVENT_FIELD,
                f"{binding.label_ko}의 시간이 {self._format_value(time_node)} "
                + ("이내입니다" if relation == "WITHIN" else "입니다"),
                f"{binding.event_id}.time {op} {self._format_value(time_node)}",
                binding=binding.id,
                field="time",
                sql=self.catalog.context_field("time")["sql"],
                op=op,
                value=seconds,
            )
        if relation == "BETWEEN" and node.get("right") and node.get("rightUpper"):
            left = node["left"]
            if left.get("kind") != "FieldAccess":
                raise PlanError("범위 조건은 사건의 시간에만 쓸 수 있습니다.")
            binding = self._position_binding(
                {"kind": "FieldAccess", "object": left["object"]}, side
            )
            field = left["field"]
            self._require_event_context(binding, field)
            field_def = self.catalog.context_field(field)
            lower = self._literal_value(node["right"])
            upper = self._literal_value(node["rightUpper"])
            return self._add_atom(
                AtomKind.EVENT_FIELD,
                f"{binding.label_ko}의 {i_ga(field_def['labelKo'])} "
                f"{self._format_value(node['right'])}부터 "
                f"{self._format_value(node['rightUpper'])} 사이입니다",
                f"{binding.event_id}.{field} BETWEEN ...",
                binding=binding.id,
                field=field,
                sql=field_def["sql"],
                op="BETWEEN",
                value=lower,
                upper=upper,
            )

        raise PlanError("아직 실행할 수 없는 시간 조건입니다.")

    def _as_binding(self, node: dict[str, Any], side: str | None) -> EventBinding:
        if node.get("kind") == "EventRef":
            return self._bind_event(node, side)
        if node.get("kind") == "EventPredicate":
            return self._bind_event(node["event"], side)
        raise PlanError("사건이 필요한 자리입니다.")

    # ------------------------------------------------------------------ Chains

    def _build_chain(self, body: dict[str, Any], side: str | None) -> ChainSpec:
        chain = body["chain"]
        if (chain["trigger"].get("scope") or {}).get("relation"):
            raise PlanError("시작 사건에는 상대팀 관계를 사용할 수 없습니다.", code="E-SEM-056")
        trigger = self._bind_event(chain["trigger"], side)
        window = chain.get("window")
        target = None
        target_filters: tuple[dict[str, Any], ...] = ()
        condition = chain.get("condition")
        if condition:
            target, target_filters = self._chain_target(condition, side)
        target_scope = (
            self._event_node_from_chain_condition(condition).get("scope") if condition else None
        )
        opponent_team = bool(target_scope and target_scope.get("relation") == "opponent-of-trigger")
        return ChainSpec(
            trigger=trigger,
            window_seconds=window["seconds"] if window else None,
            target=target,
            same_team=not opponent_team,
            opponent_team=opponent_team,
            target_filters=target_filters,
        )

    def _event_node_from_chain_condition(self, node: dict[str, Any]) -> dict[str, Any]:
        kind = node.get("kind")
        if kind == "CallExpr" and node.get("callee") == "all_values":
            args = node.get("args", [])
            if len(args) == 1:
                return self._event_node_from_chain_condition(args[0])
        if kind == "EventPredicate":
            return node["event"]
        if kind == "EventRef":
            return node
        if kind == "BinaryExpr" and node.get("op") == "AND":
            return self._event_node_from_chain_condition(node["left"])
        if kind == "BinaryExpr" and node.get("left", {}).get("kind") == "FieldAccess":
            return node["left"]["object"]
        if kind == "InExpr" and node.get("value", {}).get("kind") == "FieldAccess":
            return node["value"]["object"]
        raise PlanError(
            "이어지는 끝 사건에는 사건 또는 그 사건의 속성 조건이 필요합니다.",
            code="E-SEM-034",
        )

    def _chain_target(
        self, node: dict[str, Any], side: str | None
    ) -> tuple[EventBinding, tuple[dict[str, Any], ...]]:
        kind = node.get("kind")
        require_all = kind == "CallExpr" and node.get("callee") == "all_values"
        if require_all:
            args = node.get("args", [])
            if len(args) != 1 or args[0].get("kind") != "InExpr":
                raise PlanError(
                    "선택한 값 모두 조건에는 목록 조건 하나가 필요합니다.", code="E-SEM-033"
                )
            node = args[0]
            kind = "InExpr"
        if kind in {"EventRef", "EventPredicate"}:
            event = node["event"] if kind == "EventPredicate" else node
            return self._bind_event(event, side), ()
        if kind == "BinaryExpr" and node.get("op") == "AND":
            left_target, left_filters = self._chain_target(node["left"], side)
            right_target, right_filters = self._chain_target(node["right"], side)
            if left_target.binding_id != right_target.binding_id:
                raise PlanError(
                    "하나의 이어지는 사건 카드에서는 같은 사건의 속성만 함께 고를 수 있습니다.",
                    code="E-SEM-034",
                )
            return left_target, (*left_filters, *right_filters)

        event_node = self._event_node_from_chain_condition(node)
        target = self._bind_event(event_node, side)
        field_access = node.get("left") if kind == "BinaryExpr" else node.get("value")
        if not field_access or field_access.get("kind") != "FieldAccess":
            raise PlanError("끝 사건의 속성 조건을 읽을 수 없습니다.", code="E-SEM-034")
        field = field_access["field"]
        self._require_event_context(target, field)
        field_def = self.catalog.context_field(field)
        if not isinstance(field_def["sql"], str):
            raise PlanError("끝 사건의 위치는 영역 조건 카드로 지정해 주세요.", code="E-SEM-034")

        if kind == "InExpr":
            values = tuple(self._literal_value(item) for item in node.get("set", []))
            if not values:
                raise PlanError("끝 사건의 목록에는 값을 하나 이상 넣어 주세요.")
            self._validate_context_values(field_def, values)
            return target, (
                {
                    "field": field,
                    "sql": field_def["sql"],
                    "op": (
                        "CONTAINS ALL" if require_all else "NOT IN" if node.get("negated") else "IN"
                    ),
                    "values": values,
                },
            )

        op = node.get("op")
        if op not in {"=", "!=", ">", ">=", "<", "<="}:
            raise PlanError("끝 사건에 사용할 수 없는 비교 방식입니다.", code="E-SEM-043")
        value = self._literal_value(node["right"])
        self._validate_context_values(field_def, [value])
        return target, (
            {
                "field": field,
                "sql": field_def["sql"],
                "op": op,
                "value": value,
            },
        )

    @staticmethod
    def _validate_context_values(field_def: dict[str, Any], values: Any) -> None:
        allowed = field_def.get("allowedValues")
        if not allowed:
            return
        invalid = [value for value in values if value not in allowed]
        if invalid:
            choices = ", ".join(str(value) for value in allowed)
            raise PlanError(
                f"{field_def['labelKo']} 값 {invalid[0]!r}은 사용할 수 없습니다. "
                f"가능한 값: {choices}",
                code="E-SEM-043",
            )

    # ------------------------------------------------------------------ Measures

    def _build_measures(
        self, returns: list[dict[str, Any]], grain: Grain, side: str | None
    ) -> tuple[Measure, ...]:
        measures: list[Measure] = []
        for index, item in enumerate(returns):
            expr = item["expr"]
            alias = item.get("alias")
            measure = self._lower_measure(expr, f"m{index}", grain, side)
            if alias:
                measure = replace(measure, alias=alias)
            measures.append(measure)
        return tuple(measures)

    def _lower_measure(
        self, expr: dict[str, Any], measure_id: str, grain: Grain, side: str | None
    ) -> Measure:
        if expr.get("kind") != "CallExpr":
            raise PlanError("결과는 측정값이어야 합니다.", code="E-SEM-035")

        fn = self.catalog.function(expr["callee"])
        if fn["kind"] == "scalar":
            raise PlanError("결과는 집계 측정값이어야 합니다.", code="E-SEM-035")
        if grain not in fn.get("validGrains", []):
            raise PlanError("이 측정값은 현재 분석 단위에서 사용할 수 없습니다.", code="E-SEM-051")
        fmt = fn.get("resultFormat") or {}
        params: dict[str, Any] = {}

        scope = expr.get("scope")
        measure_side = (scope or {}).get("side")
        if measure_side is not None and (side is None or measure_side != side):
            raise PlanError("측정값의 진영이 분석 대상 진영과 다릅니다.", code="E-SEM-052")

        args = expr.get("args", [])
        function = expr["callee"]
        if function in {"win_rate", "loss_rate", "success_rate"} and args:
            raise PlanError("이 측정값에는 인수를 넣을 수 없습니다.", code="E-SEM-033")
        if function in {"pick_rate", "ban_rate", "champion_win_rate", "champion_games"}:
            if len(args) != 1 or args[0].get("kind") != "StringLit":
                raise PlanError("챔피언 지표에는 챔피언 이름 하나가 필요합니다.", code="E-SEM-033")
            champion = str(args[0].get("value") or "").strip()
            if not champion:
                raise PlanError("챔피언 이름은 비워 둘 수 없습니다.", code="E-SEM-033")
            params = {"champion": champion}
        elif function == "role_pick_rate":
            if len(args) != 2 or any(arg.get("kind") != "StringLit" for arg in args):
                raise PlanError(
                    "포지션 내 픽률에는 챔피언과 포지션이 필요합니다.", code="E-SEM-033"
                )
            champion = str(args[0].get("value") or "").strip()
            role = str(args[1].get("value") or "").strip().upper()
            if not champion or role not in {"TOP", "JUNGLE", "MID", "BOT", "SUPPORT"}:
                raise PlanError("챔피언 또는 포지션 값이 올바르지 않습니다.", code="E-SEM-043")
            params = {"champion": champion, "role": role}
        elif function == "rate":
            if len(args) != 1:
                raise PlanError("발생 비율에는 조건 하나가 필요합니다.", code="E-SEM-033")
            params = {"condition": self._lower_condition(args[0], side)}
        elif function in {"avg", "median", "sum", "min", "max"}:
            if len(args) != 1:
                raise PlanError("집계 측정값에는 값 하나가 필요합니다.", code="E-SEM-033")
            params = self._lower_measure_value(args[0], side)
        elif function == "count":
            if len(args) > 1:
                raise PlanError("개수에는 값을 하나까지만 넣을 수 있습니다.", code="E-SEM-033")
            if args:
                params = self._lower_measure_value(args[0], side)
        elif function == "success_rate":
            if args:
                raise PlanError("성공률에는 인수를 넣을 수 없습니다.", code="E-SEM-033")
        elif args:
            raise PlanError("이 측정값의 인수를 실행할 수 없습니다.", code="E-SEM-033")

        if args:
            value = args[0]
            if params.get("duration"):
                fmt = self.catalog.function("duration").get("resultFormat") or fmt
            elif value.get("kind") == "MeasureAt":
                fmt = self.catalog.function(value["measure"]).get("resultFormat") or fmt
            elif value.get("kind") == "FieldAccess":
                if params.get("subject"):
                    fmt = params["subject"].get("format") or fmt
                else:
                    field = self.catalog.context_field(value["field"])
                    if field["type"] == "duration":
                        fmt = {"unit": "seconds", "decimals": 0}
                    elif field["type"] == "int":
                        fmt = {"unit": "count", "decimals": 0}

        return Measure(
            id=measure_id,
            function=expr["callee"],
            label_ko=fn["labelKo"],
            alias=measure_id,
            unit=fmt.get("unit"),
            decimals=fmt.get("decimals"),
            params={**params, "scope_side": (scope or {}).get("side") or side},
        )

    def _lower_measure_value(self, node: dict[str, Any], side: str | None) -> dict[str, Any]:
        if node.get("kind") == "CallExpr" and node.get("callee") == "duration":
            args = node.get("args", [])
            if len(args) != 2:
                raise PlanError("시간 간격에는 시작 사건과 끝 사건이 필요합니다.", code="E-SEM-031")
            start = self._as_binding(args[0], side)
            end = self._as_binding(args[1], side)
            if self._ambiguous_repeatable(start) or self._ambiguous_repeatable(end):
                raise PlanError(
                    "반복되는 사건의 시간 간격에는 첫 번째 또는 마지막 사건을 지정해야 합니다.",
                    code="E-SEM-035",
                )
            return {"duration": {"start": start.id, "end": end.id}}
        if node.get("kind") == "FieldAccess":
            obj = node["object"]
            if obj.get("kind") == "Identifier":
                definition = self._attribute_definition(obj, node["field"])
                if definition.get("type") not in {"int", "float", "duration"}:
                    raise PlanError(
                        "숫자가 아닌 값은 이 방식으로 집계할 수 없습니다.", code="E-SEM-035"
                    )
                return {
                    "subject": {
                        "sql": definition["sql"],
                        "field": node["field"],
                        "format": definition.get("resultFormat"),
                    }
                }
            binding = self._position_binding(
                {"kind": "FieldAccess", "object": node["object"]}, side
            )
            self._require_event_context(binding, node["field"])
            if self._ambiguous_repeatable(binding):
                raise PlanError(
                    "반복되는 사건의 값을 집계하려면 첫 번째 또는 마지막 사건을 지정해야 합니다.",
                    code="E-SEM-035",
                )
            field_def = self.catalog.context_field(node["field"])
            if isinstance(field_def["sql"], dict):
                raise PlanError("위치는 숫자 집계에 사용할 수 없습니다.", code="E-SEM-035")
            if field_def["type"] not in {"int", "float", "duration"}:
                raise PlanError(
                    "숫자가 아닌 값은 이 방식으로 집계할 수 없습니다.", code="E-SEM-035"
                )
            return {"field": {"binding": binding.id, "sql": field_def["sql"]}}
        if node.get("kind") == "MeasureAt":
            probe = self._bind_probe(node, side)
            return {"probe": probe.id}
        if node.get("kind") in {"NumberLit", "DurationLit", "ClockLit"}:
            return {"literal": self._literal_value(node)}
        if node.get("kind") in {"EventRef", "EventPredicate"}:
            binding = self._as_binding(node, side)
            if self._ambiguous_repeatable(binding):
                raise PlanError(
                    "반복되는 사건의 개수를 이 방식으로 집계할 수 없습니다.", code="E-SEM-035"
                )
            return {"field": {"binding": binding.id, "sql": "timestamp_ms"}}
        raise PlanError("아직 집계할 수 없는 값입니다.", code="E-SEM-035")

    def _ambiguous_repeatable(self, binding: EventBinding) -> bool:
        event = self.catalog.event(binding.event_id)
        return binding.ordinal == "any" and not event.at_most_once_per_match

    def _build_group_keys(
        self, group_by: list[dict[str, Any]], grain: Grain, side: str | None
    ) -> tuple[GroupKey, ...]:
        keys: list[GroupKey] = []
        for index, key in enumerate(group_by):
            expr = key["expr"]
            if expr.get("kind") == "CallExpr" and expr.get("callee") == "bucket":
                keys.append(self._build_bucket_key(expr, index, side, key.get("alias")))
                continue
            if expr.get("kind") == "FieldAccess":
                binding = self._position_binding(
                    {"kind": "FieldAccess", "object": expr["object"]}, side
                )
                field = expr["field"]
                self._require_event_context(binding, field)
                if self._ambiguous_repeatable(binding):
                    raise PlanError(
                        "반복되는 사건으로 나누려면 몇 번째 사건인지 먼저 지정해 주세요.",
                        code="E-SEM-035",
                    )
                field_def = self.catalog.context_field(field)
                column = field_def["sql"]
                if not isinstance(column, str):
                    raise PlanError("위치는 분류 기준으로 사용할 수 없습니다.")
                keys.append(
                    GroupKey(
                        id=f"k{index}",
                        label_ko=field_def["labelKo"],
                        sql=f"{binding.id}__{column}",
                        alias=key.get("alias") or field,
                        params={"binding": binding.id, "column": column},
                    )
                )
                continue
            if expr.get("kind") != "Identifier":
                raise PlanError("아직 실행할 수 없는 분류 기준입니다.")
            definition = self.catalog.group_key(expr["name"])
            if grain not in definition["validGrains"]:
                raise PlanError(
                    f"{definition['labelKo']}(으)로는 이 분석 단위를 나눌 수 없습니다.",
                    code="E-SEM-053",
                )
            keys.append(
                GroupKey(
                    id=f"k{index}",
                    label_ko=definition["labelKo"],
                    sql=definition["sql"],
                    alias=key.get("alias") or expr["name"],
                    min_sample=definition.get("minSample"),
                )
            )
        return tuple(keys)

    def _build_bucket_key(
        self, expr: dict[str, Any], index: int, side: str | None, alias: str | None
    ) -> GroupKey:
        args = expr.get("args", [])
        if len(args) != 2 or args[0].get("kind") != "FieldAccess":
            raise PlanError("구간 분류에는 값과 구간 크기가 필요합니다.")
        field = args[0]
        if field.get("field") != "time":
            raise PlanError("현재는 사건 시간만 구간으로 나눌 수 있습니다.")
        binding = self._position_binding({"kind": "FieldAccess", "object": field["object"]}, side)
        self._require_event_context(binding, "time")
        size = float(self._literal_value(args[1]))
        if size <= 0:
            raise PlanError("구간 크기는 0보다 커야 합니다.")
        carried = f"{binding.id}__timestamp_ms"
        sql = f"floor(({carried} / 1000.0) / {size}) * {size}"
        return GroupKey(
            id=f"k{index}",
            label_ko="사건 시간 구간",
            sql=sql,
            alias=alias or "bucket",
            params={"binding": binding.id, "column": "timestamp_ms"},
        )

    def _require_event_context(self, binding: EventBinding, field: str) -> None:
        if field not in self.catalog.event(binding.event_id).context:
            field_label = self.catalog.context_field(field).get("labelKo", field)
            raise PlanError(
                f"{binding.label_ko}에는 {field_label} 정보를 사용할 수 없습니다.",
                code="E-SEM-021",
            )

    def _result_shape(
        self,
        measures: tuple[Measure, ...],
        group_keys: tuple[GroupKey, ...],
        compare_arms: tuple[CompareArm, ...],
    ) -> str:
        if compare_arms:
            return "comparison"
        if group_keys:
            return "table"
        return "scalar" if len(measures) == 1 else "table"

    # ------------------------------------------------------------------ Helpers

    @staticmethod
    def _literal_value(node: dict[str, Any]) -> Any:
        kind = node.get("kind")
        if kind == "NumberLit":
            return node["value"]
        if kind in ("DurationLit", "ClockLit"):
            return node["seconds"]
        if kind == "StringLit":
            return node["value"]
        if kind == "BoolLit":
            return node["value"]
        raise PlanError("조건의 오른쪽에는 값이 필요합니다.")

    @staticmethod
    def _format_value(node: dict[str, Any]) -> str:
        kind = node.get("kind")
        if kind in ("DurationLit", "ClockLit"):
            return node.get("raw") or f"{node['seconds']}s"
        if kind == "StringLit":
            return f'"{node["value"]}"'
        return str(node.get("value", ""))

    @staticmethod
    def _op_ko(op: str) -> str:
        return {
            "=": "입니다",
            "!=": "아닙니다",
            ">": "초과입니다",
            ">=": "이상입니다",
            "<": "미만입니다",
            "<=": "이하입니다",
        }.get(op, op)

    @staticmethod
    def _side_ko(side: str | None) -> str:
        if side == "blue":
            return "블루팀이 "
        if side == "red":
            return "레드팀이 "
        return ""


def build_plan(
    ast: dict[str, Any],
    *,
    regions: dict[str, dict[str, Any]] | None = None,
    dataset: DatasetFilter | None = None,
    catalog: Catalog | None = None,
) -> PhysicalPlan:
    return PlanBuilder(catalog).build(ast, regions=regions, dataset=dataset)
