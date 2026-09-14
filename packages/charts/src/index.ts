export type ChartType =
  'kpi' | 'bar' | 'grouped_bar' | 'line' | 'histogram' | 'heatmap' | 'table' | 'comparison_bar';

export interface ResultShapeInput {
  readonly type: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly columns?: readonly string[];
}

export interface ChartChoice {
  readonly primary: ChartType;
  readonly alternatives: readonly ChartType[];
  readonly reasonKo: string;
}

/** Pure result-shape decision that presentation code must not override arbitrarily. */
export function pickChart(result: ResultShapeInput): ChartChoice {
  if (result.type === 'scalar')
    return { primary: 'kpi', alternatives: ['table'], reasonKo: '결과가 하나의 값입니다.' };
  if (result.type === 'comparison')
    return {
      primary: 'comparison_bar',
      alternatives: ['table'],
      reasonKo: '비교할 조건이 둘 이상입니다.',
    };
  if (result.type === 'timeseries')
    return { primary: 'line', alternatives: ['table'], reasonKo: '시간의 흐름에 따른 결과입니다.' };
  if (result.type === 'distribution')
    return { primary: 'histogram', alternatives: ['table'], reasonKo: '값의 분포를 보여 줍니다.' };
  if (result.type === 'map')
    return {
      primary: 'heatmap',
      alternatives: ['table'],
      reasonKo: '위치 좌표가 포함된 결과입니다.',
    };
  if (result.rows.length > 30)
    return { primary: 'table', alternatives: ['bar'], reasonKo: '항목이 많아 표가 읽기 쉽습니다.' };
  const dimensions = Math.max(
    0,
    (result.columns?.length ?? Object.keys(result.rows[0] ?? {}).length) - 2,
  );
  return dimensions >= 2
    ? {
        primary: 'grouped_bar',
        alternatives: ['table'],
        reasonKo: '두 분류 기준을 함께 비교합니다.',
      }
    : { primary: 'bar', alternatives: ['table'], reasonKo: '분류별 값을 비교합니다.' };
}

export function chartAvailability(
  chart: ChartType,
  result: ResultShapeInput,
): { enabled: boolean; reasonKo?: string; actionKo?: string } {
  if ((chart === 'bar' || chart === 'grouped_bar') && result.type === 'scalar')
    return {
      enabled: false,
      reasonKo: '막대 그래프에는 분류별 결과가 필요합니다.',
      actionKo: '분류 기준 추가',
    };
  if (chart === 'line' && result.type !== 'timeseries')
    return {
      enabled: false,
      reasonKo: '선 그래프는 시간 기준 결과에만 사용할 수 있습니다.',
      actionKo: '시간대별로 나누기',
    };
  if (chart === 'heatmap' && result.type !== 'map')
    return {
      enabled: false,
      reasonKo: '히트맵에는 위치 결과가 필요합니다.',
      actionKo: '위치 결과 추가',
    };
  return { enabled: true };
}

export const rateAxis = { min: 0, max: 1 } as const;
export const barAxis = { min: 0 } as const;
