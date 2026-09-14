import type { AiRecipeDef } from './types.js';

/** Compact, executable examples used by AI clients; catalog generation keeps them in sync. */
export const AI_RECIPES: readonly AiRecipeDef[] = [
  {
    id: 'champion_overview',
    intentKo: '특정 챔피언의 픽률, 밴률, 승률, 경기 수',
    dsl: 'ANALYZE match RETURN pick_rate("Ahri"), ban_rate("Ahri"), champion_win_rate("Ahri"), champion_games("Ahri")',
  },
  {
    id: 'role_pick_rate',
    intentKo: '특정 포지션 안에서 챔피언 픽률',
    dsl: 'ANALYZE match RETURN role_pick_rate("Ahri", "MID")',
  },
  {
    id: 'role_matchup',
    intentKo: '같은 포지션 상대 챔피언과의 승률',
    dsl: 'ANALYZE player WHEN player.champion = "Ahri" AND player.role = "MID" AND opponent_has_champion_in_role("LeBlanc", "MID") RETURN win_rate(), count()',
  },
  {
    id: 'same_team_combo',
    intentKo: '같은 팀 두 챔피언 조합의 승률',
    dsl: 'ANALYZE player WHEN player.champion = "Xayah" AND ally_has_champion("Rakan") RETURN win_rate(), count()',
  },
  {
    id: 'player_metrics_by_champion',
    intentKo: '챔피언별 선수 지표',
    dsl: 'ANALYZE player GROUP BY champion RETURN win_rate(), count(), avg(player.kda), median(player.cs_per_minute), avg(player.damage_dealt), avg(player.vision_score)',
  },
  {
    id: 'frame_advantage',
    intentKo: '특정 시점 골드, 경험치, 킬 우위와 승률',
    dsl: 'ANALYZE team WHEN team.gold_diff(10:00) >= 1500 AND team.xp_diff(10:00) > 0 AND team.kill_diff(10:00) > 0 RETURN win_rate(), count()',
  },
  {
    id: 'time_buckets',
    intentKo: '사건 시간을 일정 구간으로 나눈 승률',
    dsl: 'ANALYZE team WHEN first_blood GROUP BY bucket(first_blood.time, 60s) RETURN win_rate(), count()',
  },
  {
    id: 'conditional_rate',
    intentKo: '분석 단위 중 조건을 만족한 비율',
    dsl: 'ANALYZE player RETURN rate(player.kda >= 3)',
  },
];
