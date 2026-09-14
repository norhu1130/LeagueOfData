import { describe, it, expect } from 'vitest';
import {
  catalog,
  listEvents,
  listFunctions,
  listGroupKeys,
  propertiesOf,
  referencedColumns,
  resolveEventSurface,
  stableStringify,
  suggestEventNames,
  FORBIDDEN_PHRASES,
} from '../src/index.js';

describe('catalog structure', () => {
  it('provides spatial landmarks in raw game coordinates', () => {
    expect(catalog.landmarks['blue.top_outer_turret']).toMatchObject({
      xRaw: 981,
      yRaw: 10441,
    });
  });

  it('matches every item ID to its key', () => {
    for (const [key, def] of Object.entries(catalog.events)) expect(def.id).toBe(key);
    for (const [key, def] of Object.entries(catalog.functions)) expect(def.id).toBe(key);
    for (const [key, def] of Object.entries(catalog.contextFields)) expect(def.id).toBe(key);
    for (const [key, def] of Object.entries(catalog.groupKeys)) expect(def.id).toBe(key);
  });

  it('defines every contextual event field', () => {
    for (const event of Object.values(catalog.events)) {
      for (const field of event.context) {
        expect(catalog.contextFields[field], `${event.id}.${field}`).toBeDefined();
      }
    }
  });

  it('provides a reason for unavailable events', () => {
    for (const event of Object.values(catalog.events)) {
      if (!event.available) {
        expect(event.unavailableReasonKo, event.id).toBeTruthy();
      }
    }
  });

  it('restricts every function to valid analysis grains', () => {
    for (const fn of Object.values(catalog.functions)) {
      expect(fn.validGrains.length).toBeGreaterThan(0);
      for (const grain of fn.validGrains) expect(catalog.grains[grain]).toBeDefined();
    }
  });

  it('publishes parser, engine, builder, and AI support separately', () => {
    const byId = Object.fromEntries(catalog.dslLanguage.constructs.map((item) => [item.id, item]));
    expect(byId.region_containment).toMatchObject({
      parser: true,
      engine: true,
      visualBuilder: 'full',
      aiGenerate: true,
    });
    expect(byId.membership).toMatchObject({
      parser: true,
      engine: true,
      visualBuilder: 'partial',
      aiGenerate: true,
    });
    expect(byId.near?.syntax).toContain('event.position NEAR landmark');
  });

  it('documents every lexer keyword in the language manifest', () => {
    const manifest = JSON.stringify(catalog.dslLanguage);
    for (const keyword of [
      'ANALYZE',
      'WHEN',
      'RETURN',
      'GROUP',
      'BY',
      'COMPARE',
      'VS',
      'AS',
      'IF',
      'AND',
      'OR',
      'NOT',
      'IN',
      'BEFORE',
      'AFTER',
      'WITHIN',
      'UNTIL',
      'DURING',
      'BETWEEN',
      'AT',
      'OF',
      'NEAR',
      'true',
      'false',
      'null',
    ]) {
      expect(manifest, keyword).toContain(keyword);
    }
  });

  it('references only tables in the table contract', () => {
    for (const event of Object.values(catalog.events)) {
      expect(catalog.tables[event.sqlBinding.table], event.id).toBeDefined();
    }
  });

  it('disallows champion grouping at team grain', () => {
    // Five champions per team would multiply rows, which E-SEM-051 prevents.
    expect(catalog.groupKeys.champion!.validGrains).toEqual(['player']);
  });
});

describe('hashing', () => {
  it('is stable across source key reordering', () => {
    const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('uses a stable hash format', () => {
    expect(catalog.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('ignores undefined fields', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe('lookup', () => {
  it('hides unavailable events by default', () => {
    const ids = listEvents().map((e) => e.id);
    expect(ids).not.toContain('turret_damage');
    expect(listEvents({ includeUnavailable: true }).map((e) => e.id)).toContain('turret_damage');
  });

  it('resolves aliases with ordinal qualifiers', () => {
    expect(resolveEventSurface('first_turret_destroy')).toEqual({
      event: catalog.events.turret_destroy,
      ordinal: 'first',
    });
    expect(resolveEventSurface('kill')?.ordinal).toBe('any');
    expect(resolveEventSurface('없는사건')).toBeNull();
  });

  it('ranks field suggestions after first_blood', () => {
    const props = propertiesOf('first_blood');
    expect(props?.map((p) => p.id)).toEqual([
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
    ]);
  });

  it('filters functions by analysis grain', () => {
    const eventFns = listFunctions('event').map((f) => f.id);
    expect(eventFns).toContain('success_rate');
    expect(listFunctions('match').map((f) => f.id)).not.toContain('success_rate');
    expect(listGroupKeys('team').map((g) => g.id)).not.toContain('champion');
  });

  it('defines pick rate at match grain', () => {
    expect(catalog.functions.pick_rate).toMatchObject({
      labelKo: '픽률',
      validGrains: ['match'],
      params: [{ name: 'champion', type: 'string' }],
      resultFormat: { unit: 'percent', decimals: 1 },
    });
  });

  it('suggests names close to a typo', () => {
    expect(suggestEventNames('firstblood')).toContain('first_blood');
    expect(suggestEventNames('drgaon_kill')).toContain('dragon_kill');
    expect(suggestEventNames('완전히다른것')).toEqual([]);
  });
});

describe('referenced columns', () => {
  it('collects columns only from available events', () => {
    const cols = referencedColumns();
    expect(cols.events).toContain('is_first_of_type');
    expect(cols.v_deaths).toContain('killer_id');
    // `turret_damage` is unavailable, so its binding is excluded.
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(['events', 'v_deaths']));
  });
});

describe('statistical copy (§23)', () => {
  const korean = (value: unknown, path: string[] = []): Array<[string, string]> => {
    if (typeof value === 'string') {
      const key = path[path.length - 1] ?? '';
      return key.endsWith('Ko') ? [[path.join('.'), value]] : [];
    }
    if (Array.isArray(value)) return value.flatMap((v, i) => korean(v, [...path, String(i)]));
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([k, v]) => korean(v, [...path, k]));
    }
    return [];
  };

  it('keeps causal language out of Korean catalog copy', () => {
    // Mechanically prevent the system from making causal claims.
    const strings = korean(catalog).filter(([p]) => !p.startsWith('forbiddenPhrases'));
    const violations: string[] = [];
    for (const [path, text] of strings) {
      for (const phrase of FORBIDDEN_PHRASES) {
        if (text.includes(phrase)) violations.push(`${path}: "${text}" 에 '${phrase}'`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('keeps implementation terms out of diagnostic messages', () => {
    // Users should not need to understand ASTs or parsers (§3.1).
    const jargon = ['AST', '파싱', '토큰', '파서', 'SQL', '쿼리', '컴파일'];
    const violations: string[] = [];
    for (const d of Object.values(catalog.diagnostics)) {
      for (const term of jargon) {
        if (d.titleKo.includes(term) || d.bodyKo.includes(term)) {
          violations.push(`${d.code}: '${term}'`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('gives every diagnostic a title and body', () => {
    for (const d of Object.values(catalog.diagnostics)) {
      expect(d.titleKo.length, d.code).toBeGreaterThan(4);
      expect(d.bodyKo.length, d.code).toBeGreaterThan(10);
    }
  });
});
