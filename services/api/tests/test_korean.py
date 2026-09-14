from __future__ import annotations

import pytest
from lod_api.korean import eul_reul, eun_neun, euro_ro, gwa_wa, has_final_consonant, i_ga


@pytest.mark.parametrize(
    ("word", "has_final"),
    [("블러드", False), ("킬", True), ("Ahri", False), ("Jhin", True), ("2", False), ("3", True)],
)
def test_has_final_consonant(word: str, has_final: bool) -> None:
    assert has_final_consonant(word) is has_final


def test_particles_follow_the_final_consonant() -> None:
    assert eul_reul("퍼스트 블러드") == "퍼스트 블러드를"
    assert eul_reul("킬") == "킬을"
    assert i_ga("위치") == "위치가"
    assert eun_neun("사건") == "사건은"
    assert gwa_wa("승률") == "승률과"
    assert euro_ro("라인") == "라인으로"
    assert euro_ro("결과") == "결과로"
    assert euro_ro("킬") == "킬로"
