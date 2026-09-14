import { describe, it, expect } from 'vitest';
import {
  canonicalHash,
  createEnvelope,
  loadEnvelope,
  serializeEnvelope,
  type Program,
} from '../src/index.js';

const ast: Program = {
  kind: 'Program',
  analyze: { kind: 'ScopeRef', entity: 'team', side: 'blue' },
  body: {
    kind: 'SimpleStmt',
    chain: null,
    when: null,
    groupBy: [],
    returns: [
      {
        kind: 'ReturnItem',
        expr: { kind: 'CallExpr', callee: 'win_rate', scope: null, args: [] },
        alias: null,
      },
    ],
  },
};

const base = {
  id: 'an_test',
  title: '탑 퍼스트 블러드 승률',
  dsl: 'ANALYZE blue\nRETURN win_rate()',
  ast,
  catalogVersion: '2026.09.1',
  catalogHash: 'sha256:abc',
};

describe('envelope creation', () => {
  it('includes the AST hash', () => {
    const envelope = createEnvelope(base);
    expect(envelope.astHash).toBe(canonicalHash(ast));
    expect(envelope.format).toBe('loldsl.analysis');
    expect(envelope.version).toBe(1);
  });

  it('includes regions and visual state', () => {
    const envelope = createEnvelope({
      ...base,
      regions: {
        custom_top_region: {
          id: 'custom_top_region',
          label: '탑 1차 앞',
          origin: 'user',
          coordSpace: 'norm-v1',
          shape: {
            kind: 'polygon',
            points: [
              [0.05, 0.62],
              [0.21, 0.62],
              [0.21, 0.88],
            ],
          },
        },
      },
      visualState: { mode: 'builder' },
    });
    expect(envelope.regions.custom_top_region?.label).toBe('탑 1차 앞');
    expect(envelope.visualState.mode).toBe('builder');
  });

  it('rejects region IDs that cannot be used in the DSL', () => {
    expect(() =>
      createEnvelope({
        ...base,
        regions: {
          '탑 지역': {
            id: '탑 지역',
            label: '탑',
            origin: 'user',
            coordSpace: 'norm-v1',
            shape: { kind: 'circle', cx: 0.5, cy: 0.5, r: 0.1 },
          },
        },
      }),
    ).toThrow();
  });
});

describe('envelope loading', () => {
  it('round-trips an envelope', () => {
    const envelope = createEnvelope(base);
    const loaded = loadEnvelope(JSON.parse(serializeEnvelope(envelope)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.astHashMatches).toBe(true);
      expect(loaded.envelope.title).toBe(base.title);
    }
  });

  it('reports an AST hash mismatch without treating it as a load failure', () => {
    // The caller can recover by reparsing DSL source. Treating this as a hard failure would
    // make every persisted analysis unreadable after a schema change.
    const envelope = { ...createEnvelope(base), astHash: 'sha256:다른값' };
    const loaded = loadEnvelope(envelope);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.astHashMatches).toBe(false);
  });

  it('describes malformed envelope data', () => {
    const loaded = loadEnvelope({ format: 'loldsl.analysis', version: 1 });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.errorKo).toContain('읽을 수 없습니다');
      expect(loaded.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects a malformed AST inside an envelope', () => {
    const envelope = createEnvelope(base);
    const loaded = loadEnvelope({
      ...envelope,
      ast: { kind: 'Program', analyze: null, body: { kind: 'SqlStmt', sql: 'SELECT 1' } },
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.issues.some((issue) => issue.startsWith('ast'))).toBe(true);
  });

  it('safely rejects unrelated input', () => {
    for (const bad of [null, 42, 'text', [], {}]) {
      expect(loadEnvelope(bad).ok).toBe(false);
    }
  });
});
