import type { SubjectFieldDef } from './types.js';

let nextRank = 1;

export const SUBJECT_FIELDS: Record<string, SubjectFieldDef> = {
  duration_s: field('duration_s', '경기 시간', 'duration', ['match', 'team', 'player'], 'matches', [
    'duration_s',
  ]),
  ended_in_surrender: field('ended_in_surrender', '항복 종료', 'bool', ['match'], 'matches', [
    'ended_in_surrender',
  ]),
  kills: playerField('kills', '킬'),
  deaths: playerField('deaths', '데스'),
  assists: playerField('assists', '어시스트'),
  kda: playerField('kda', 'KDA', '(kills + assists)::DOUBLE / greatest(deaths, 1)', [
    'kills',
    'assists',
    'deaths',
  ]),
  gold_earned: playerField('gold_earned', '획득 골드', undefined, undefined, 'gold'),
  damage_dealt: playerField(
    'damage_dealt',
    '챔피언 대상 피해량',
    'total_damage_dealt_to_champions',
    ['total_damage_dealt_to_champions'],
  ),
  damage_taken: playerField('damage_taken', '받은 피해량', 'total_damage_taken', [
    'total_damage_taken',
  ]),
  vision_score: playerField('vision_score', '시야 점수'),
  wards_placed: playerField('wards_placed', '설치한 와드'),
  wards_killed: playerField('wards_killed', '제거한 와드'),
  cs: playerField('cs', 'CS', 'total_minions_killed + neutral_minions_killed', [
    'total_minions_killed',
    'neutral_minions_killed',
  ]),
  cs_per_minute: playerField(
    'cs_per_minute',
    '분당 CS',
    '(total_minions_killed + neutral_minions_killed) * 60.0 / nullif(duration_s, 0)',
    ['total_minions_killed', 'neutral_minions_killed'],
  ),
  champion_level: playerField('champion_level', '종료 레벨', 'champ_level', ['champ_level']),
  tower_kills: teamField('tower_kills', '포탑 파괴 수'),
  dragon_kills: teamField('dragon_kills', '드래곤 처치 수'),
  baron_kills: teamField('baron_kills', '바론 처치 수'),
  total_kills: teamField('total_kills', '팀 처치 수'),
};

function field(
  id: string,
  labelKo: string,
  type: SubjectFieldDef['type'],
  validGrains: SubjectFieldDef['validGrains'],
  table: string,
  columns: readonly string[],
  sql = id,
  unit: SubjectFieldDef['resultFormat']['unit'] = type === 'duration' ? 'seconds' : 'count',
): SubjectFieldDef {
  return {
    id,
    labelKo,
    descriptionKo: `${labelKo} 값입니다.`,
    type,
    validGrains,
    table,
    columns,
    sql,
    resultFormat: { unit, decimals: type === 'float' ? 2 : 0 },
    rank: nextRank++,
  };
}

function playerField(
  id: string,
  labelKo: string,
  sql = id,
  columns: readonly string[] = [sql],
  unit: SubjectFieldDef['resultFormat']['unit'] = 'count',
): SubjectFieldDef {
  return field(
    id,
    labelKo,
    id === 'kda' || id === 'cs_per_minute' ? 'float' : 'int',
    ['player'],
    'participants',
    columns,
    sql,
    unit,
  );
}

function teamField(id: string, labelKo: string): SubjectFieldDef {
  return field(id, labelKo, 'int', ['team'], 'match_summary', [id]);
}
