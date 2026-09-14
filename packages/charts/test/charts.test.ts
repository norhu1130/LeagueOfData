import { describe, expect, it } from 'vitest';
import { chartAvailability, pickChart, rateAxis } from '../src/index.js';

describe('automatic visualization', () => {
  it.each([
    ['scalar', 'kpi'],
    ['comparison', 'comparison_bar'],
    ['timeseries', 'line'],
    ['distribution', 'histogram'],
    ['map', 'heatmap'],
  ] as const)('%s → %s', (type, chart) =>
    expect(pickChart({ type, rows: [] }).primary).toBe(chart),
  );
  it('selects a table for more than 30 rows', () =>
    expect(pickChart({ type: 'table', rows: Array.from({ length: 31 }, () => ({})) }).primary).toBe(
      'table',
    ));
  it('provides a next action for an invalid chart', () => {
    const choice = chartAvailability('line', { type: 'scalar', rows: [{}] });
    expect(choice.enabled).toBe(false);
    expect(choice.actionKo).toContain('시간대별');
    expect(chartAvailability('bar', { type: 'scalar', rows: [{}] }).actionKo).toContain(
      '분류 기준',
    );
  });
  it('uses the full 0–100% range for rate axes', () =>
    expect(rateAxis).toEqual({ min: 0, max: 1 }));
});
