export interface ExampleDefinition {
  readonly id: string;
  readonly title: string;
  readonly dsl: string;
}

export const EXAMPLES: readonly ExampleDefinition[] = [
  {
    id: 'a',
    title: '퍼블을 먹은 팀 승률',
    dsl: `ANALYZE team
WHEN first_blood
RETURN win_rate()`,
  },
  {
    id: 'b',
    title: '탑 퍼스트 블러드 승률',
    dsl: `ANALYZE team
WHEN first_blood
  AND first_blood.position IN region("top_lane")
RETURN win_rate()`,
  },
  {
    id: 'c',
    title: '블루팀 퍼블에서 첫 타워까지',
    dsl: `ANALYZE blue
WHEN blue.first_blood
RETURN avg(duration(blue.first_blood, blue.first_turret_destroy))`,
  },
  {
    id: 'd',
    title: '블루팀 10분 1500골드 리드',
    dsl: `ANALYZE blue
WHEN blue.gold_diff(10:00) >= 1500
RETURN blue.win_rate`,
  },
  {
    id: 'e',
    title: '특정 영역에서 사망한 팀',
    dsl: `ANALYZE team
WHEN death.position IN region("custom_region_1")
RETURN win_rate()`,
  },
  {
    id: 'f',
    title: '블루팀 킬 후 90초 내 드래곤',
    dsl: `AFTER blue.kill WITHIN 90s IF blue.dragon_kill
RETURN success_rate()`,
  },
  {
    id: 'g',
    title: '장로용 처치 후 승률과 승리 시간',
    dsl: `ANALYZE team
WHEN elder_dragon_kill
RETURN win_rate() AS win_rate,
  avg(duration(elder_dragon_kill[last], victory)) AS time_to_victory`,
  },
  {
    id: 'h',
    title: '챔피언 픽·밴·승률 한눈에 보기',
    dsl: `ANALYZE match
RETURN pick_rate("Ahri") AS pick_rate,
  ban_rate("Ahri") AS ban_rate,
  champion_win_rate("Ahri") AS win_rate,
  champion_games("Ahri") AS games`,
  },
  {
    id: 'i',
    title: '포지션별 챔피언 픽률',
    dsl: `ANALYZE match
RETURN role_pick_rate("Ahri", "MID") AS role_pick_rate`,
  },
  {
    id: 'j',
    title: '챔피언별 KDA·CS·피해량·시야',
    dsl: `ANALYZE player
GROUP BY champion
RETURN win_rate() AS win_rate,
  count() AS games,
  avg(player.kda) AS avg_kda,
  median(player.cs_per_minute) AS median_cs_per_minute,
  avg(player.damage_dealt) AS avg_damage,
  avg(player.vision_score) AS avg_vision`,
  },
  {
    id: 'k',
    title: '미드 챔피언 상대 매치업 승률',
    dsl: `ANALYZE player
WHEN player.champion = "Ahri"
  AND player.role = "MID"
  AND opponent_has_champion_in_role("LeBlanc", "MID")
RETURN win_rate() AS win_rate,
  count() AS games`,
  },
  {
    id: 'l',
    title: '같은 팀 챔피언 조합 승률',
    dsl: `ANALYZE player
WHEN player.champion = "Xayah"
  AND ally_has_champion("Rakan")
RETURN win_rate() AS win_rate,
  count() AS games`,
  },
  {
    id: 'm',
    title: '10분 경험치 우위 승률과 표본',
    dsl: `ANALYZE blue
WHEN blue.xp_diff(10:00) >= 1000
RETURN win_rate() AS win_rate,
  count() AS games`,
  },
  {
    id: 'n',
    title: '퍼스트 블러드 여부 승률 비교',
    dsl: `ANALYZE blue
COMPARE WHEN blue.first_blood AS secured
VS WHEN NOT blue.first_blood AS missed
RETURN win_rate() AS win_rate,
  count() AS games`,
  },
];
