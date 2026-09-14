"""Deterministic bias guardrails for observational analyses.

The rules in this module never change a cohort or calculate a causal effect. They expose
reproducible risks that the UI and optional AI interpreter can explain to the user.
"""

from __future__ import annotations

from typing import Any

from lod_api.compile.plan import AtomKind, PhysicalPlan


def _warning(
    code: str,
    severity: str,
    title: str,
    message: str,
    mitigation: str,
) -> dict[str, str]:
    return {
        "code": code,
        "severity": severity,
        "titleKo": title,
        "messageKo": message,
        "mitigationKo": mitigation,
    }


def audit_plan(
    plan: PhysicalPlan,
    *,
    dataset_source: str | None = None,
    result_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return conservative, explainable warnings from a validated physical plan."""
    binding_events = {binding.id: binding.event_id for binding in plan.bindings}
    has_untimed_item_purchase = any(
        binding_events.get(str(atom.params.get("binding"))) == "item_purchase"
        or "item_purchase" in atom.dsl
        for atom in plan.atoms
    )
    has_point_in_time_item = any(atom.kind == AtomKind.ITEM_STATE for atom in plan.atoms)
    has_item_condition = has_untimed_item_purchase or has_point_in_time_item
    has_roster_proxy = any(atom.kind == AtomKind.ROSTER for atom in plan.atoms)
    warnings: list[dict[str, str]] = []

    if has_untimed_item_purchase:
        warnings.append(
            _warning(
                "ITEM_POST_OUTCOME",
                "high",
                "아이템 조건에 판정 시점이 없습니다",
                (
                    "현재 조건은 경기 전체의 구매 기록을 사용합니다. 경기 상황이 구매를 "
                    "결정하는 역인과와, 일찍 끝난 경기의 미구매 편향이 섞일 수 있습니다."
                ),
                (
                    "구매 효과로 해석하지 마세요. 판정 시점과 시점별 보유 상태가 지원되면 "
                    "10분·15분 같은 동일 시점 기준으로 다시 비교하세요."
                ),
            )
        )
    if has_point_in_time_item:
        landmarks = sorted(
            {
                int(float(atom.params["at_seconds"]) // 60)
                for atom in plan.atoms
                if atom.kind == AtomKind.ITEM_STATE
            }
        )
        warnings.append(
            _warning(
                "ITEM_LANDMARK_ELIGIBILITY",
                "low",
                "판정 시점까지 진행된 경기만 비교합니다",
                f"{', '.join(f'{minute}분' for minute in landmarks)} 판정 전에 끝난 경기는 "
                "미구매로 세지 않고 분석 모집단에서 제외합니다.",
                "서로 다른 조건을 비교할 때 같은 판정 시점을 유지하세요.",
            )
        )
    if has_item_condition and has_roster_proxy:
        warnings.append(
            _warning(
                "CHAMPION_EXPOSURE_PROXY",
                "medium",
                "챔피언 존재가 실제 위협을 대신하고 있습니다",
                (
                    "상대 챔피언의 존재만으로는 성장도, 회복량, 교전 참여와 아이템 필요성을 "
                    "구분할 수 없습니다."
                ),
                "가능하면 판정 시점의 골드·레벨 또는 실제 회복 위협별 결과를 함께 확인하세요.",
            )
        )
    if plan.dataset.patch is None:
        warnings.append(
            _warning(
                "PATCH_UNCONTROLLED",
                "medium",
                "패치를 고정하지 않았습니다",
                "여러 패치가 포함되면 챔피언과 아이템 성능 변화가 관찰 차이에 섞일 수 있습니다.",
                "단일 패치로 제한하거나 패치별 결과가 같은 방향인지 확인하세요.",
            )
        )
    if plan.dataset.tier is None:
        warnings.append(
            _warning(
                "TIER_UNCONTROLLED",
                "medium",
                "티어를 고정하지 않았습니다",
                "티어별 구매 판단과 챔피언 활용 차이가 전체 결과에 섞일 수 있습니다.",
                "티어별로 나누거나 동일 티어 범위에서 결과를 재확인하세요.",
            )
        )
    if plan.grain == "player":
        warnings.append(
            _warning(
                "DEPENDENT_UNITS",
                "medium",
                "선수 표본이 서로 독립적이지 않습니다",
                "같은 경기와 같은 플레이어가 여러 선수-경기 표본에 반복될 수 있습니다.",
                "경기·플레이어 단위 군집 신뢰구간을 지원하기 전에는 구간을 보수적으로 해석하세요.",
            )
        )
    if plan.group_keys:
        warnings.append(
            _warning(
                "MULTIPLE_COMPARISONS",
                "low",
                "여러 집단을 동시에 탐색합니다",
                "많은 하위 집단 중 극단적인 값이 우연히 나타날 가능성이 커집니다.",
                "발견된 패턴을 다른 기간이나 별도 표본에서 재검증하세요.",
            )
        )
    if dataset_source == "riot_v5":
        warnings.append(
            _warning(
                "NETWORK_SAMPLE",
                "high",
                "전체 서버의 무작위 표본이 아닙니다",
                "Riot 경기는 시작 계정의 참가자 관계를 따라 수집한 네트워크 표본입니다.",
                "다양한 티어·시간대의 시작 계정을 늘리고 수집 깊이를 낮춰 재확인하세요.",
            )
        )

    comparison = (result_payload or {}).get("comparison")
    groups = comparison.get("groups", []) if isinstance(comparison, dict) else []
    sizes = [group.get("n") for group in groups if isinstance(group, dict)]
    sizes = [size for size in sizes if isinstance(size, int) and size >= 0]
    positive_sizes = [size for size in sizes if size > 0]
    if len(positive_sizes) >= 2 and max(positive_sizes) >= 5 * min(positive_sizes):
        warnings.append(
            _warning(
                "GROUP_IMBALANCE",
                "high",
                "비교 집단의 크기가 크게 다릅니다",
                "가장 큰 집단과 작은 집단의 표본 차이가 "
                f"{max(positive_sizes) / min(positive_sizes):.1f}배입니다.",
                "집단별 조건 분포를 확인하고 더 작은 집단의 신뢰구간을 우선 확인하세요.",
            )
        )

    rank = {"low": 0, "medium": 1, "high": 2}
    risk_level = max((item["severity"] for item in warnings), key=rank.get, default="low")
    return {
        "riskLevel": risk_level,
        "warnings": warnings,
        "limitationsKo": (
            "편향 검토는 위험 신호를 찾지만 편향의 부재나 인과관계를 증명하지 않습니다. "
            "어떤 조건이나 경기도 자동으로 변경·제외하지 않았습니다."
        ),
    }
