import type { BuilderCard } from '@lol/visual-builder';
import type { ItemOption } from './analysis-types.js';

export const FRAME_METRIC_OPTIONS = [
  ['gold_diff', '골드 차이', '골드', 100],
  ['xp_diff', '경험치 차이', '경험치', 100],
  ['kill_diff', '킬 차이', '킬', 1],
] as const;

export const GRIEVOUS_WOUNDS_ITEMS: readonly ItemOption[] = [
  { id: 3011, name: '화학공학 부패기' },
  { id: 3033, name: '필멸자의 운명' },
  { id: 3075, name: '가시 갑옷' },
  { id: 3076, name: '덤불 조끼' },
  { id: 3123, name: '처형인의 대검' },
  { id: 3165, name: '모렐로노미콘' },
  { id: 3916, name: '망각의 구' },
  { id: 6609, name: '화공 펑크 사슬검' },
];

export const CARD_TYPE_LABELS: Readonly<Record<BuilderCard['type'], string>> = {
  target: '분석 대상',
  event: '사건 조건',
  location: '위치 조건',
  condition: '수치 조건',
  itemResponse: '아이템 대응 조건',
  counterItem: '아이템 대응 조건',
  sequence: '사건 연결',
  groupBy: '분류 기준',
  compare: '비교 조건',
  measure: '결과',
  advanced: '고급 조건',
};
