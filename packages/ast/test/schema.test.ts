import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProgram, safeParseProgram } from '../src/index.js';

const CASES = resolve(import.meta.dirname, '../../../tests/conformance/cases');

describe('AST runtime schema', () => {
  it('accepts every valid conformance AST', () => {
    for (const name of readdirSync(CASES)) {
      const ast = JSON.parse(readFileSync(resolve(CASES, name, 'expected.ast.json'), 'utf8'));
      // Recovery ASTs must remain structurally valid across worker and builder boundaries.
      expect(() => parseProgram(ast), name).not.toThrow();
    }
  });

  it('rejects unknown nodes and missing required structure', () => {
    expect(
      safeParseProgram({ kind: 'Program', analyze: null, body: { kind: 'SqlStmt' } }).success,
    ).toBe(false);
    expect(
      safeParseProgram({
        kind: 'Program',
        analyze: null,
        body: { kind: 'SimpleStmt', chain: null, when: null, groupBy: [] },
      }).success,
    ).toBe(false);
  });

  it('rejects non-JSON numbers such as NaN and infinity', () => {
    const base = {
      kind: 'Program',
      analyze: null,
      body: {
        kind: 'SimpleStmt',
        chain: null,
        when: null,
        groupBy: [],
        returns: [
          {
            kind: 'ReturnItem',
            alias: null,
            expr: { kind: 'CallExpr', callee: 'count', scope: null, args: [] },
          },
        ],
      },
    };
    const broken = structuredClone(base);
    broken.body.when = { kind: 'NumberLit', value: Number.NaN } as never;
    expect(safeParseProgram(broken).success).toBe(false);
  });

  it('rejects AST states that cannot round-trip through the DSL', () => {
    const base = {
      kind: 'Program',
      analyze: null,
      body: {
        kind: 'SimpleStmt',
        chain: null,
        when: null,
        groupBy: [],
        returns: [
          {
            kind: 'ReturnItem',
            alias: null,
            expr: { kind: 'CallExpr', callee: 'count', scope: null, args: [] },
          },
        ],
      },
    };
    const tiny = structuredClone(base);
    tiny.body.when = { kind: 'NumberLit', value: 1e-7 } as never;
    expect(safeParseProgram(tiny).success).toBe(false);

    const emptySet = structuredClone(base);
    emptySet.body.when = {
      kind: 'InExpr',
      value: { kind: 'Identifier', name: 'role' },
      set: [],
      negated: false,
    } as never;
    expect(safeParseProgram(emptySet).success).toBe(false);

    const mismatchedDuration = structuredClone(base);
    mismatchedDuration.body.when = { kind: 'DurationLit', seconds: 60, raw: '90s' } as never;
    expect(safeParseProgram(mismatchedDuration).success).toBe(false);
  });
});
