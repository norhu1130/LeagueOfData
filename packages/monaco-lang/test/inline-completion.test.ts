import { describe, expect, it } from 'vitest';
import { inlineCompletionAt } from '../src/index.js';

describe('DSL inline completion', () => {
  it('offers a complete starter analysis for an empty document', () => {
    expect(inlineCompletionAt('', 0)?.insertText).toBe(
      'ANALYZE team\nWHEN first_blood\nRETURN win_rate()',
    );
  });

  it.each([
    ['AN', 'ANALYZE'],
    ['ANALYZE ', 'team'],
    ['ANALYZE team\nWHEN first_', 'first_blood'],
    ['ANALYZE team\nRETURN win_', 'win_rate()'],
    ['ANALYZE team\nGROUP BY pos', 'position_region'],
  ])('completes %s with %s', (source, expected) => {
    expect(inlineCompletionAt(source, source.length)?.insertText).toBe(expected);
  });

  it('offers event fields after a dot', () => {
    const source = 'ANALYZE team\nWHEN first_blood.po';
    expect(inlineCompletionAt(source, source.length)?.insertText).toBe('position');
  });
});
