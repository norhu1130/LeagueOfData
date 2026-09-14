/**
 * Semantic catalog content: the only hand-edited source.
 *
 * The build generates `catalog.json` for TypeScript tooling and Python compilation.
 * Reference checks detect stale artifacts and backend health checks validate SQL columns.
 */
import type {
  ContextFieldDef,
  DiagnosticDef,
  EntityDef,
  EventDef,
  FunctionDef,
  GrainDef,
  GrainId,
  GroupKeyDef,
  LandmarkDef,
  TableContract,
} from './types.js';

export const CATALOG_VERSION = '2026.09.12';

/** Complete set of logical tables available to generated SQL. */
export const TABLES: Record<string, TableContract> = {
  matches: {
    name: 'matches',
    isView: false,
    grain: 'match',
    keyColumns: ['match_id'],
    descriptionKo: '경기 1행',
  },
  participants: {
    name: 'participants',
    isView: false,
    grain: 'player',
    keyColumns: ['match_id', 'participant_id'],
    descriptionKo: '경기당 참가자 10행',
  },
  teams: {
    name: 'teams',
    isView: false,
    grain: 'team',
    keyColumns: ['match_id', 'team_id'],
    descriptionKo: '경기당 팀 2행',
  },
  events: {
    name: 'events',
    isView: false,
    grain: 'event',
    keyColumns: ['match_id', 'event_id'],
    descriptionKo: '타임라인 사건',
  },
  timeline_team_frames: {
    name: 'timeline_team_frames',
    isView: false,
    grain: 'team',
    keyColumns: ['match_id', 'frame_idx', 'team_id'],
    descriptionKo: '1분 간격 팀 집계. gold_diff 등이 저장 시점에 계산되어 있다',
  },
  timeline_participant_frames: {
    name: 'timeline_participant_frames',
    isView: false,
    grain: 'player',
    keyColumns: ['match_id', 'frame_idx', 'participant_id'],
    descriptionKo: '1분 간격 참가자 상태',
  },
  match_summary: {
    name: 'match_summary',
    isView: false,
    grain: 'team',
    keyColumns: ['match_id', 'team_id'],
    descriptionKo: '팀-경기 파생 요약. 흔한 질문을 단일 스캔으로 답하기 위한 gold 레이어',
  },
  v_deaths: {
    name: 'v_deaths',
    isView: true,
    grain: 'event',
    keyColumns: ['match_id', 'event_id'],
    descriptionKo: '킬을 피해자 관점으로 투영한 뷰. 물리 행이 아니다',
  },
  v_event_assists: {
    name: 'v_event_assists',
    isView: true,
    grain: 'event',
    keyColumns: ['match_id', 'event_id'],
    descriptionKo: 'assist_ids LIST를 펼친 뷰',
  },
  v_dragon_soul_acquired: {
    name: 'v_dragon_soul_acquired',
    isView: true,
    grain: 'event',
    keyColumns: ['match_id', 'event_id'],
    descriptionKo: '팀별 네 번째 원소 드래곤 처치로 파생한 용 영혼 획득 사건',
  },
};

export const GRAINS: Record<GrainId, GrainDef> = {
  match: {
    id: 'match',
    labelKo: '경기',
    unitKo: '경기',
    keyColumns: ['match_id'],
    baseTable: 'matches',
  },
  team: {
    id: 'team',
    labelKo: '팀',
    unitKo: '팀-경기',
    keyColumns: ['match_id', 'team_id'],
    baseTable: 'match_summary',
  },
  player: {
    id: 'player',
    labelKo: '선수',
    unitKo: '선수-경기',
    keyColumns: ['match_id', 'participant_id'],
    baseTable: 'participants',
  },
  event: {
    id: 'event',
    labelKo: '사건',
    unitKo: '사건',
    keyColumns: ['match_id', 'event_id'],
    baseTable: 'events',
  },
};

export const ENTITIES: Record<string, EntityDef> = {
  match: {
    id: 'match',
    labelKo: '경기',
    descriptionKo: '한 판의 게임',
    surfaces: ['match'],
  },
  team: {
    id: 'team',
    labelKo: '팀',
    descriptionKo: '블루 또는 레드 진영',
    surfaces: ['team', 'blue', 'red', 'team.blue', 'team.red'],
  },
  player: {
    id: 'player',
    labelKo: '선수',
    descriptionKo: '한 경기에 참여한 한 명',
    surfaces: ['player'],
  },
  champion: {
    id: 'champion',
    labelKo: '챔피언',
    descriptionKo: '선수가 선택한 챔피언',
    surfaces: ['champion'],
  },
  event: {
    id: 'event',
    labelKo: '사건',
    descriptionKo: '경기 중 일어난 일',
    surfaces: ['event'],
  },
  objective: {
    id: 'objective',
    labelKo: '오브젝트',
    descriptionKo: '드래곤·바론·전령·포탑 등 중립 목표물',
    surfaces: ['objective', 'dragon', 'baron', 'herald', 'turret'],
  },
  item: { id: 'item', labelKo: '아이템', descriptionKo: '구매·판매하는 장비', surfaces: ['item'] },
  position: {
    id: 'position',
    labelKo: '위치',
    descriptionKo: '맵 위의 좌표',
    surfaces: ['position'],
  },
  region: {
    id: 'region',
    labelKo: '지역',
    descriptionKo: '미니맵에서 지정한 영역',
    surfaces: ['region'],
  },
};

/**
 * Fixed landmarks in raw Riot Summoner's Rift coordinates. Keys match DSL FieldAccess spelling
 * so parser and compiler do not duplicate building names.
 */
export const LANDMARKS: Record<string, LandmarkDef> = {
  'blue.top_outer_turret': {
    id: 'blue.top_outer_turret',
    labelKo: '블루팀 탑 외곽 포탑',
    xRaw: 981,
    yRaw: 10441,
  },
  'red.top_outer_turret': {
    id: 'red.top_outer_turret',
    labelKo: '레드팀 탑 외곽 포탑',
    xRaw: 4318,
    yRaw: 13875,
  },
};

/**
 * Event context fields, such as `position` in `first_blood.position`.
 *
 * Positions expose normalized coordinates for region containment and raw coordinates for
 * distance expressions such as `WITHIN 1000 OF ...`.
 */
export const CONTEXT_FIELDS: Record<string, ContextFieldDef> = {
  time: {
    id: 'time',
    labelKo: '시간',
    descriptionKo: '경기 시작부터 이 사건까지 걸린 시간',
    type: 'duration',
    temporality: 'in_game_at_t',
    sql: 'timestamp_ms / 1000.0',
    rank: 1,
  },
  position: {
    id: 'position',
    labelKo: '위치',
    descriptionKo: '이 사건이 일어난 맵 좌표',
    type: 'position',
    temporality: 'in_game_at_t',
    sql: { xNorm: 'x_norm', yNorm: 'y_norm', xRaw: 'x_raw', yRaw: 'y_raw' },
    rank: 2,
  },
  team: {
    id: 'team',
    labelKo: '팀',
    descriptionKo: '이 사건을 일으킨 팀',
    type: 'team',
    temporality: 'in_game_at_t',
    sql: 'team_id',
    rank: 3,
  },
  player: {
    id: 'player',
    labelKo: '선수',
    descriptionKo: '이 사건을 일으킨 선수',
    type: 'player',
    temporality: 'in_game_at_t',
    sql: 'participant_id',
    rank: 4,
  },
  champion: {
    id: 'champion',
    labelKo: '챔피언',
    descriptionKo: '이 사건을 일으킨 선수의 챔피언',
    type: 'champion',
    temporality: 'in_game_at_t',
    sql: 'champion_id',
    rank: 5,
  },
  role: {
    id: 'role',
    labelKo: '역할',
    descriptionKo: '이 사건을 일으킨 선수의 라인 역할',
    type: 'role',
    temporality: 'in_game_at_t',
    allowedValues: ['TOP', 'JUNGLE', 'MID', 'BOT', 'SUPPORT'],
    sql: 'role',
    rank: 6,
  },
  killer: {
    id: 'killer',
    labelKo: '처치자',
    descriptionKo: '처치한 선수',
    type: 'player',
    temporality: 'in_game_at_t',
    sql: 'participant_id',
    rank: 7,
  },
  victim: {
    id: 'victim',
    labelKo: '피해자',
    descriptionKo: '처치당한 선수',
    type: 'player',
    temporality: 'in_game_at_t',
    sql: 'victim_id',
    rank: 8,
  },
  assistants: {
    id: 'assistants',
    labelKo: '어시스트',
    descriptionKo: '처치를 도운 선수들',
    type: 'player[]',
    temporality: 'in_game_at_t',
    sql: 'assist_ids',
    rank: 9,
  },
  assist_count: {
    id: 'assist_count',
    labelKo: '어시스트 수',
    descriptionKo: '0이면 솔로킬',
    type: 'int',
    temporality: 'in_game_at_t',
    sql: 'assist_count',
    rank: 10,
  },
  lane: {
    id: 'lane',
    labelKo: '라인',
    descriptionKo: '건물이 속한 라인',
    type: 'category',
    temporality: 'in_game_at_t',
    sql: 'lane_type',
    rank: 11,
  },
  tower_type: {
    id: 'tower_type',
    labelKo: '포탑 종류',
    descriptionKo: '외곽·내부·억제기 앞·쌍둥이 포탑',
    type: 'category',
    temporality: 'in_game_at_t',
    sql: 'tower_type',
    rank: 12,
  },
  monster_subtype: {
    id: 'monster_subtype',
    labelKo: '드래곤 속성',
    descriptionKo: '화염·바람·대지·바다 등',
    type: 'category',
    temporality: 'in_game_at_t',
    allowedValues: [
      'FIRE_DRAGON',
      'AIR_DRAGON',
      'EARTH_DRAGON',
      'WATER_DRAGON',
      'HEXTECH_DRAGON',
      'CHEMTECH_DRAGON',
      'ELDER_DRAGON',
      'OTHER_DRAGON',
    ],
    sql: 'event_subtype',
    rank: 13,
  },
  item: {
    id: 'item',
    labelKo: '아이템',
    descriptionKo: '구매·판매한 아이템',
    type: 'int',
    temporality: 'in_game_at_t',
    sql: 'item_id',
    rank: 14,
  },
  ward_type: {
    id: 'ward_type',
    labelKo: '와드 종류',
    descriptionKo: '설치한 와드의 종류',
    type: 'category',
    temporality: 'in_game_at_t',
    sql: 'ward_type',
    rank: 15,
  },
  level: {
    id: 'level',
    labelKo: '레벨',
    descriptionKo: '레벨업 후 레벨',
    type: 'int',
    temporality: 'in_game_at_t',
    sql: 'level',
    rank: 16,
  },
};

const KILL_CONTEXT = [
  'time',
  'position',
  'team',
  'player',
  'champion',
  'role',
  'killer',
  'victim',
  'assistants',
  'assist_count',
];

const OBJECTIVE_CONTEXT = ['time', 'position', 'team', 'player', 'champion'];
const BUILDING_CONTEXT = ['time', 'position', 'team', 'player', 'lane'];

export const DIAGNOSTICS: Record<string, DiagnosticDef> = {
  'E-LEX-003': {
    code: 'E-LEX-003',
    severity: 'error',
    titleKo: '시간 단위는 숫자에 붙여 쓰세요',
    bodyKo: '`90 s`는 인식되지 않습니다. `90s`처럼 공백 없이 써 주세요.',
  },
  'E-LEX-007': {
    code: 'E-LEX-007',
    severity: 'error',
    titleKo: '따옴표가 닫히지 않았습니다',
    bodyKo: '문자열은 큰따옴표로 열고 닫아야 합니다.',
  },
  'E-SYN-001': {
    code: 'E-SYN-001',
    severity: 'error',
    titleKo: '무엇을 계산할지 정해 주세요',
    bodyKo: '분석은 결과가 있어야 합니다. 승률이나 경기 수 같은 측정값을 하나 고르세요.',
  },
  'E-SYN-012': {
    code: 'E-SYN-012',
    severity: 'error',
    titleKo: '비교를 연달아 쓸 수 없습니다',
    bodyKo: '`a < b < c` 형태는 지원하지 않습니다. `a < b 그리고 b < c`로 나눠 주세요.',
  },
  'E-SYN-021': {
    code: 'E-SYN-021',
    severity: 'error',
    titleKo: '무엇을 기준으로 할지 필요합니다',
    bodyKo:
      '거리 조건은 기준이 되는 위치가 있어야 합니다. 시간을 뜻했다면 `90s`처럼 단위를 붙이세요.',
  },
  'E-SYN-030': {
    code: 'E-SYN-030',
    severity: 'error',
    titleKo: '비교하려면 대상이 둘 이상 필요합니다',
    bodyKo: '비교 분석은 서로 다른 두 조건을 나란히 놓습니다.',
  },
  'E-SEM-010': {
    code: 'E-SEM-010',
    severity: 'error',
    titleKo: '알 수 없는 사건입니다',
    bodyKo: '이 이름의 사건은 없습니다. 아래 후보 중에서 골라 주세요.',
  },
  'E-SEM-011': {
    code: 'E-SEM-011',
    severity: 'error',
    titleKo: '이 사건에는 없는 정보입니다',
    bodyKo: '이 사건이 가진 정보만 쓸 수 있습니다.',
  },
  'E-SEM-020': {
    code: 'E-SEM-020',
    severity: 'error',
    titleKo: '이 데이터에는 없는 사건입니다',
    bodyKo: '데이터 출처가 이 사건을 제공하지 않아 분석에 쓸 수 없습니다.',
  },
  'E-SEM-012': {
    code: 'E-SEM-012',
    severity: 'error',
    titleKo: '알 수 없는 측정값입니다',
    bodyKo: '이 이름의 측정값은 없습니다. 아래 목록에서 골라 주세요.',
  },
  'E-SEM-013': {
    code: 'E-SEM-013',
    severity: 'error',
    titleKo: '알 수 없는 진영입니다',
    bodyKo: '진영은 블루 또는 레드입니다.',
  },
  'E-SEM-014': {
    code: 'E-SEM-014',
    severity: 'error',
    titleKo: '알 수 없는 분류 기준입니다',
    bodyKo: '이 이름으로는 나눌 수 없습니다.',
  },
  'E-SEM-033': {
    code: 'E-SEM-033',
    severity: 'error',
    titleKo: '필요한 값이 빠졌습니다',
    bodyKo: '이 측정값을 계산하려면 값이 더 필요합니다.',
  },
  'E-SEM-034': {
    code: 'E-SEM-034',
    severity: 'error',
    titleKo: '사건이 와야 하는 자리입니다',
    bodyKo: '이 자리에는 경기 중 일어난 일이 들어갑니다.',
  },
  'E-SEM-035': {
    code: 'E-SEM-035',
    severity: 'error',
    titleKo: '사건 자체는 결과가 될 수 없습니다',
    bodyKo: '사건이 몇 번 일어났는지, 얼마나 걸렸는지 같은 측정값을 골라 주세요.',
  },
  'E-SEM-043': {
    code: 'E-SEM-043',
    severity: 'error',
    titleKo: '서로 비교할 수 없는 값입니다',
    bodyKo: '같은 종류의 값끼리만 비교할 수 있습니다.',
  },
  'E-SEM-052': {
    code: 'E-SEM-052',
    severity: 'error',
    titleKo: '이 분석 단위에서는 쓸 수 없는 측정값입니다',
    bodyKo: '측정값마다 계산할 수 있는 분석 단위가 정해져 있습니다.',
  },
  'E-SEM-053': {
    code: 'E-SEM-053',
    severity: 'error',
    titleKo: '이 분석 단위를 그 기준으로 나눌 수 없습니다',
    bodyKo: '분류 기준마다 쓸 수 있는 분석 단위가 정해져 있습니다.',
  },
  'E-SEM-054': {
    code: 'E-SEM-054',
    severity: 'error',
    titleKo: '비교와 분류를 동시에 실행할 수 없습니다',
    bodyKo: '비교 조건 또는 분류 기준 중 하나만 사용해 주세요.',
  },
  'E-SEM-056': {
    code: 'E-SEM-056',
    severity: 'error',
    titleKo: '상대팀의 기준 사건이 필요합니다',
    bodyKo: '시작 사건의 상대팀은 이어지는 사건의 끝 팀에서만 사용할 수 있습니다.',
  },
  'E-SYN-002': {
    code: 'E-SYN-002',
    severity: 'error',
    titleKo: '여기에 올 수 없는 것입니다',
    bodyKo: '조건이나 값이 와야 하는 자리입니다.',
  },
  'E-SYN-003': {
    code: 'E-SYN-003',
    severity: 'error',
    titleKo: '괄호가 닫히지 않았습니다',
    bodyKo: '여는 괄호에 대응하는 닫는 괄호가 필요합니다.',
  },
  'E-SYN-004': {
    code: 'E-SYN-004',
    severity: 'error',
    titleKo: '무엇으로 나눌지 필요합니다',
    bodyKo: '어떤 기준으로 나눌지 정해 주세요.',
  },
  'E-SYN-022': {
    code: 'E-SYN-022',
    severity: 'error',
    titleKo: '시간이 필요합니다',
    bodyKo: '얼마 안에 일어난 일을 볼지 정해 주세요.',
  },
  'E-SYN-023': {
    code: 'E-SYN-023',
    severity: 'error',
    titleKo: '범위의 끝이 필요합니다',
    bodyKo: '시작과 끝을 모두 정해 주세요.',
  },
  'E-SYN-024': {
    code: 'E-SYN-024',
    severity: 'error',
    titleKo: '시점이 필요합니다',
    bodyKo: '언제를 기준으로 잴지 정해 주세요.',
  },
  'E-LEX-001': {
    code: 'E-LEX-001',
    severity: 'error',
    titleKo: '읽을 수 없는 문자가 있습니다',
    bodyKo: '이 문자는 분석에서 쓸 수 없습니다.',
  },
  'E-LEX-008': {
    code: 'E-LEX-008',
    severity: 'error',
    titleKo: '설명이 닫히지 않았습니다',
    bodyKo: '`/*` 로 시작한 설명은 `*/` 로 닫아야 합니다.',
  },
  'E-SEM-031': {
    code: 'E-SEM-031',
    severity: 'error',
    titleKo: '시간을 재려면 시작 사건이 필요합니다',
    bodyKo: '"걸린 시간"은 두 사건 사이의 간격을 계산합니다. 지금은 끝나는 사건만 정해져 있습니다.',
  },
  'E-SEM-032': {
    code: 'E-SEM-032',
    severity: 'error',
    titleKo: '평균을 낼 값이 필요합니다',
    bodyKo: '평균은 숫자나 시간에만 쓸 수 있습니다. 사건 자체는 평균을 낼 수 없습니다.',
  },
  'E-SEM-040': {
    code: 'E-SEM-040',
    severity: 'error',
    titleKo: '위치는 시간과 비교할 수 없습니다',
    bodyKo: '위치에는 영역 조건을, 시간에는 시간 조건을 쓰세요.',
  },
  'E-SEM-041': {
    code: 'E-SEM-041',
    severity: 'error',
    titleKo: '정의되지 않은 영역입니다',
    bodyKo: '이 영역은 이 분석에 없습니다. 미니맵에서 새로 그리거나 기본 영역을 쓰세요.',
  },
  'E-SEM-042': {
    code: 'E-SEM-042',
    severity: 'error',
    titleKo: '좌표계가 섞였습니다',
    bodyKo: '미니맵에서 그린 영역과 게임 좌표 거리를 함께 쓸 수 없습니다.',
  },
  'E-SEM-050': {
    code: 'E-SEM-050',
    severity: 'error',
    titleKo: '분석 단위가 모호합니다',
    bodyKo: '승률이 경기 기준인지 팀 기준인지 알 수 없습니다. 분석 대상을 정해 주세요.',
  },
  'E-SEM-051': {
    code: 'E-SEM-051',
    severity: 'error',
    titleKo: '팀 단위 분석은 챔피언으로 묶을 수 없습니다',
    bodyKo: '한 팀에는 챔피언이 5명입니다. 선수 단위로 바꾸면 챔피언별로 나눌 수 있습니다.',
  },
  'E-SEM-060': {
    code: 'E-SEM-060',
    severity: 'error',
    titleKo: '성공률은 기준 사건이 필요합니다',
    bodyKo: '무엇 이후에 무엇이 일어났는지를 물어야 성공률을 셀 수 있습니다.',
  },
  'E-SEM-070': {
    code: 'E-SEM-070',
    severity: 'warning',
    titleKo: '시점이 대부분의 경기보다 깁니다',
    bodyKo: '이 시각까지 이어진 경기가 적어 표본이 크게 줄어듭니다.',
  },
  'W-SEM-080': {
    code: 'W-SEM-080',
    severity: 'warning',
    titleKo: '조건에 결과가 섞여 있습니다',
    bodyKo:
      '경기가 끝나야 정해지는 값을 조건으로 쓰면, 결과가 조건 안에 미리 들어가 승률이 부풀려집니다.',
  },
  'E-EXE-001': {
    code: 'E-EXE-001',
    severity: 'error',
    titleKo: '분석 정의가 현재 버전과 맞지 않습니다',
    bodyKo: '앱이 업데이트되어 분석을 다시 열어야 합니다.',
  },
  'E-EXE-010': {
    code: 'E-EXE-010',
    severity: 'hint',
    titleKo: '분석을 취소했습니다',
    bodyKo: '실행 중이던 분석을 중단했습니다.',
  },
};

/**
 * Causal phrases forbidden in result copy (§23). Tests scan all Korean product copy against it.
 */
export const FORBIDDEN_PHRASES: readonly string[] = [
  '만든다',
  '만듭니다',
  '이끈다',
  '이끕니다',
  '때문에',
  '영향을 준다',
  '영향을 줍니다',
  '덕분에',
  '효과',
  '유발',
  '좌우한다',
  '좌우합니다',
  '결정한다',
  '결정합니다',
  '원인',
  '보장',
];
