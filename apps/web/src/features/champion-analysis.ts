import type { ReturnItem } from '@lol/ast';

export type ChampionMetricId =
  'pick_rate' | 'ban_rate' | 'champion_win_rate' | 'champion_games' | 'role_pick_rate';

export interface ChampionMetricSelection {
  readonly metric: ChampionMetricId;
  readonly champion: string;
  readonly role?: string;
}

export const CHAMPION_METRICS: ReadonlyArray<{
  readonly id: ChampionMetricId;
  readonly label: string;
}> = [
  { id: 'pick_rate', label: '픽률' },
  { id: 'ban_rate', label: '밴률' },
  { id: 'champion_win_rate', label: '선택 시 승률' },
  { id: 'champion_games', label: '픽 경기 수' },
  { id: 'role_pick_rate', label: '포지션 내 픽률' },
];

const ids = new Set<ChampionMetricId>(CHAMPION_METRICS.map((metric) => metric.id));

export function championMetricSelection(item: ReturnItem): ChampionMetricSelection | null {
  const expression = item.expr;
  if (
    expression.kind !== 'CallExpr' ||
    !ids.has(expression.callee as ChampionMetricId) ||
    expression.scope !== null ||
    expression.args[0]?.kind !== 'StringLit'
  )
    return null;
  const metric = expression.callee as ChampionMetricId;
  const role = expression.args[1];
  if (metric === 'role_pick_rate' && role?.kind !== 'StringLit') return null;
  return {
    metric,
    champion: expression.args[0].value,
    role: role?.kind === 'StringLit' ? role.value : undefined,
  };
}

export function championMetricDsl(selection: ChampionMetricSelection): string {
  const champion = JSON.stringify(selection.champion);
  return selection.metric === 'role_pick_rate'
    ? `role_pick_rate(${champion}, ${JSON.stringify(selection.role ?? 'MID')})`
    : `${selection.metric}(${champion})`;
}
