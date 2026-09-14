import { parse } from '@lol/dsl';
import { describe, expect, it } from 'vitest';
import { championMetricDsl, championMetricSelection } from './champion-analysis.js';

describe('champion analysis feature', () => {
  it('round-trips a champion metric selection', () => {
    const parsed = parse('ANALYZE match RETURN role_pick_rate("Ahri", "MID")');
    const item = parsed.ast?.body.returns[0];
    if (!item) throw new Error('fixture did not parse');
    const selection = championMetricSelection(item);
    expect(selection).toEqual({ metric: 'role_pick_rate', champion: 'Ahri', role: 'MID' });
    expect(championMetricDsl(selection!)).toBe('role_pick_rate("Ahri", "MID")');
  });
});
