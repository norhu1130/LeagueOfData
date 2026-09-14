/** Conformance cases covering every specification example and definition-of-done question. */
export interface ConformanceCase {
  readonly name: string;
  readonly descriptionKo: string;
  readonly dsl: string;
  readonly tags: readonly string[];
  /** Corresponding question from §38. */
  readonly dod?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  readonly expectsErrors?: boolean;
}

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  // ------------------------------------------------------------ DoD A~F
  {
    name: 'dod-a-first-blood-win-rate',
    descriptionKo: '퍼스트 블러드를 먹은 팀의 승률',
    dsl: 'ANALYZE blue\nWHEN blue.first_blood\nRETURN blue.win_rate',
    dod: 'A',
    tags: ['event', 'win_rate'],
  },
  {
    name: 'dod-b-top-lane-first-blood',
    descriptionKo: '탑에서 퍼스트 블러드를 먹은 팀의 승률',
    dsl: 'ANALYZE blue\nWHEN blue.first_blood\n  AND first_blood.position IN region("top_lane")\nRETURN blue.win_rate',
    dod: 'B',
    tags: ['event', 'spatial', 'win_rate'],
  },
  {
    name: 'dod-c-first-blood-to-turret',
    descriptionKo: '퍼스트 블러드 이후 첫 타워까지 평균 시간',
    dsl: 'ANALYZE blue\nWHEN blue.first_blood\nRETURN avg(duration(blue.first_blood, blue.first_turret_destroy))',
    dod: 'C',
    tags: ['event', 'duration'],
  },
  {
    name: 'dod-d-gold-lead-win-rate',
    descriptionKo: '10분에 1500골드 앞선 팀의 승률',
    dsl: 'ANALYZE blue\nWHEN blue.gold_diff(10:00) >= 1500\nRETURN blue.win_rate',
    dod: 'D',
    tags: ['frame-measure', 'win_rate'],
  },
  {
    name: 'dod-e-death-in-region',
    descriptionKo: '특정 영역에서 죽은 경우의 승률',
    dsl: 'ANALYZE blue\nWHEN death.position IN region("custom_region_1")\nRETURN blue.win_rate',
    dod: 'E',
    tags: ['event', 'spatial', 'win_rate'],
  },
  {
    name: 'dod-f-dragon-after-kill',
    descriptionKo: '킬 이후 90초 안에 용을 먹는 비율',
    dsl: 'AFTER blue.kill WITHIN 90s IF dragon_kill\nRETURN success_rate()',
    dod: 'F',
    tags: ['temporal-chain', 'success_rate'],
  },

  // ------------------------------------------------------- Specification §14 and §35
  {
    name: 'spec-14-ex5-player-champion',
    descriptionKo: '§14 Example 5 — 선수 단위 챔피언·역할·골드 조건',
    dsl: 'ANALYZE player\nWHEN player.champion = "Darius"\n  AND player.role = "TOP"\n  AND player.gold_diff(10:00) >= 500\nRETURN player.win_rate',
    tags: ['player-grain', 'frame-measure'],
  },
  {
    name: 'spec-35-end-to-end',
    descriptionKo: '§35 — 탑 퍼블 시 첫 타워까지 시간과 승률을 함께',
    dsl: 'ANALYZE blue\nWHEN blue.first_blood\n  AND first_blood.position IN region("custom_top_region")\nRETURN avg(duration(blue.first_blood, blue.first_turret_destroy)) AS time_to_turret, blue.win_rate AS win_rate',
    tags: ['spatial', 'duration', 'multi-return'],
  },

  // ---------------------------------------------------------- Grouping and comparison
  {
    name: 'group-by-champion',
    descriptionKo: '§12 — 챔피언별 승률',
    dsl: 'ANALYZE player\nGROUP BY champion\nRETURN win_rate(), count()',
    tags: ['group-by'],
  },
  {
    name: 'group-by-position-region',
    descriptionKo: '§40 — 퍼블 발생 영역별 승률',
    dsl: 'ANALYZE blue\nWHEN blue.first_blood\nGROUP BY position_region\nRETURN blue.win_rate',
    tags: ['group-by', 'spatial'],
  },
  {
    name: 'compare-first-blood',
    descriptionKo: '§13 — 퍼블 획득 여부 비교',
    dsl: 'ANALYZE blue\nCOMPARE WHEN blue.first_blood\nVS WHEN NOT blue.first_blood\nRETURN win_rate()',
    tags: ['compare'],
  },

  // ------------------------------------------------------------- Time and space
  {
    name: 'temporal-between',
    descriptionKo: '퍼블 시각이 특정 구간 안',
    dsl: 'ANALYZE blue\nWHEN blue.first_blood\n  AND first_blood.time BETWEEN 2m AND 10m\nRETURN win_rate()',
    tags: ['temporal'],
  },
  {
    name: 'spatial-within-radius',
    descriptionKo: '특정 건물 반경 안에서의 사망',
    dsl: 'ANALYZE blue\nWHEN death.position WITHIN 1000 OF blue.top_outer_turret\nRETURN win_rate()',
    tags: ['spatial'],
  },
  {
    name: 'bucket-time',
    descriptionKo: '퍼블 시각 구간별 승률',
    dsl: 'ANALYZE blue\nWHEN blue.first_blood\nGROUP BY bucket(first_blood.time, 60s)\nRETURN win_rate()',
    tags: ['group-by', 'bucket'],
  },
  {
    name: 'nested-or',
    descriptionKo: '중첩 OR — Visual Builder가 표현할 수 없는 고급 조건',
    dsl: 'ANALYZE blue\nWHEN (blue.first_blood OR red.first_blood)\n  AND first_blood.time < 5m\nRETURN win_rate()',
    tags: ['advanced', 'boolean'],
  },

  // --------------------------------------------------------------- Errors
  {
    name: 'error-missing-return',
    descriptionKo: '§29 — 결과를 정하지 않은 분석',
    dsl: 'WHEN blue.first_blood',
    tags: ['error'],
    expectsErrors: true,
  },
  {
    name: 'error-chained-comparison',
    descriptionKo: '§29 — 비교를 연달아 쓴 경우',
    dsl: 'WHEN first_blood.time < 300s < 600s\nRETURN win_rate()',
    tags: ['error'],
    expectsErrors: true,
  },
  {
    name: 'error-within-without-of',
    descriptionKo: '§29 — 거리 기준이 빠진 경우',
    dsl: 'WHEN death.position WITHIN 1000\nRETURN win_rate()',
    tags: ['error'],
    expectsErrors: true,
  },
  {
    name: 'error-spaced-duration',
    descriptionKo: '§29 — 시간 단위를 띄어 쓴 경우',
    dsl: 'WHEN first_blood.time < 90 s\nRETURN win_rate()',
    tags: ['error'],
    expectsErrors: true,
  },
  {
    name: 'error-partial-typing',
    descriptionKo: '§28 — 타이핑 중간 상태에서도 부분 AST가 나와야 한다',
    dsl: 'WHEN blue.first_blood AND',
    tags: ['error', 'recovery'],
    expectsErrors: true,
  },
];
