import { describe, it, expect } from 'vitest';
import { parse } from '@lol/dsl';
import type { Program } from '@lol/ast';
import { PRESET_REGIONS } from '@lol/data-model';
import {
  validate,
  inferGrain,
  coverage,
  describeCondition,
  type ValidationContext,
} from '../src/index.js';

const REGIONS = PRESET_REGIONS.map((r) => r.id);
const ctx: ValidationContext = { regionIds: [...REGIONS, 'custom_region_1'] };

const check = (src: string, context: ValidationContext = ctx) => {
  const { ast } = parse(src);
  if (!ast) throw new Error(`parse failed: ${src}`);
  return validate(ast, context);
};
const codes = (src: string, context?: ValidationContext) =>
  check(src, context).diagnostics.map((d) => d.code);

describe('analysis grain inference', () => {
  it.each([
    ['ANALYZE blue WHEN blue.first_blood RETURN win_rate()', 'team'],
    ['ANALYZE match RETURN count()', 'match'],
    ['ANALYZE player WHEN player.role = "TOP" RETURN win_rate()', 'player'],
    ['AFTER blue.kill WITHIN 90s RETURN success_rate()', 'event'],
    ['RETURN count()', 'match'],
  ])('%s → %s', (src, expected) => {
    expect(check(src).grain.grain).toBe(expected);
  });

  it('gives a chain clause precedence over ANALYZE', () => {
    // Each reference event is one row, so the grain is event.
    expect(check('ANALYZE blue AFTER blue.kill WITHIN 90s RETURN success_rate()').grain.grain).toBe(
      'event',
    );
  });

  it('describes the denominator in Korean', () => {
    // Section 22 requires the denominator to distinguish match and team rates.
    const result = check('ANALYZE blue WHEN blue.first_blood RETURN blue.win_rate');
    expect(result.denominatorKo).toContain('팀-경기');
    expect(result.denominatorKo).toContain('블루팀');
  });

  it('distinguishes explicit from inferred grain', () => {
    expect(inferGrain(parse('ANALYZE blue RETURN win_rate()').ast!).explicit).toBe(true);
    expect(inferGrain(parse('RETURN count()').ast!).explicit).toBe(false);
  });
});

describe('event validation', () => {
  it('reports no errors for specification examples', () => {
    const clean = [
      'ANALYZE blue WHEN blue.first_blood RETURN blue.win_rate',
      'ANALYZE blue WHEN blue.first_blood AND first_blood.position IN region("top_lane") RETURN blue.win_rate',
      'ANALYZE blue WHEN blue.gold_diff(10:00) >= 1500 RETURN blue.win_rate',
      'ANALYZE player WHEN player.champion = "Darius" AND player.role = "TOP" RETURN player.win_rate',
      'ANALYZE team WHEN opponent_has_champion("Trundle", "Briar", "Vladimir", "Aatrox") AND NOT (item_purchase.item IN (3011, 3033, 3075, 3076, 3123, 3165, 3916, 6609)) RETURN win_rate(), count()',
      'ANALYZE team WHEN opponent_has_champion("Trundle", "Briar") AND NOT owns_item_at(15:00, 3165, 6609) RETURN win_rate(), count()',
      'ANALYZE team WHEN NOT opponent.owns_item_at(15:00, 1001) AND NOT owns_item_at(15:00, 1004) RETURN win_rate(), count()',
      'AFTER blue.kill WITHIN 90s IF dragon_kill RETURN success_rate()',
      'ANALYZE player GROUP BY champion RETURN win_rate(), count()',
    ];
    for (const src of clean) {
      const errors = check(src).diagnostics.filter((d) => d.severity === 'error');
      expect(
        errors.map((e) => `${e.code} ${e.titleKo}`),
        src,
      ).toEqual([]);
    }
  });

  it('accepts direct first and last occurrence selectors', () => {
    for (const src of [
      'ANALYZE team RETURN avg(duration(dragon_kill[first], baron_kill[last]))',
      'ANALYZE team WHEN elder_dragon_kill RETURN avg(duration(elder_dragon_kill[last], victory))',
    ]) {
      expect(
        check(src).diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
      ).toEqual([]);
    }
  });

  it('identifies a typo and suggests candidates', () => {
    const [d] = check('WHEN firstblood RETURN count()').diagnostics;
    expect(d?.code).toBe('E-SEM-010');
    expect(d?.need?.items).toContain('first_blood');
    expect(d?.quickFixes?.[0]?.newText).toBe('first_blood');
  });

  it('rejects unavailable events and suggests alternatives', () => {
    const d = check('WHEN turret_damage RETURN count()').diagnostics.find(
      (x) => x.code === 'E-SEM-020',
    );
    expect(d).toBeDefined();
    // Explain unavailability instead of silently returning an empty result.
    expect(d?.bodyKo).toContain('포탑 방패');
  });

  it('identifies an invalid event field and lists valid fields', () => {
    const d = check('WHEN dragon_spawn.player = 1 RETURN count()').diagnostics.find(
      (x) => x.code === 'E-SEM-011',
    );
    expect(d).toBeDefined();
    expect(d?.need?.items).toContain('시간');
  });

  it('honors dataset-specific event availability and context fields', () => {
    const parsed = parse('WHEN ward_placed.position IN region("top_lane") RETURN count()');
    expect(parsed.ast).not.toBeNull();
    const diagnostics = validate(parsed.ast!, {
      regionIds: ['top_lane'],
      eventCapabilities: {
        ward_placed: {
          available: true,
          context: ['time', 'team', 'player'],
          unavailableReasonKo: null,
        },
      },
    }).diagnostics;
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('E-SEM-011');

    const unavailable = validate(parse('WHEN ward_placed RETURN count()').ast!, {
      regionIds: [],
      eventCapabilities: {
        ward_placed: {
          available: false,
          context: [],
          unavailableReasonKo: 'This dataset does not provide wards.',
        },
      },
    }).diagnostics;
    expect(unavailable.find((diagnostic) => diagnostic.code === 'E-SEM-020')?.bodyKo).toBe(
      'This dataset does not provide wards.',
    );
  });

  it.each([
    'WHEN frobnicate RETURN count()',
    'WHEN first_blood.banana = 1 RETURN count()',
    'WHEN player.banana = 1 RETURN count()',
    'WHEN blue.banana = 1 RETURN count()',
  ])('fails closed for unresolved input: %s', (source) => {
    expect(check(source).diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(
      true,
    );
  });
});

describe('type validation', () => {
  it('offers two fixes when a position is compared with time (§29)', () => {
    const d = check('WHEN first_blood.position < 600s RETURN count()').diagnostics.find(
      (x) => x.code === 'E-SEM-040',
    );
    expect(d).toBeDefined();
    expect(d?.got?.items.join(' ')).toContain('위치');
    expect(d?.need?.items.join(' ')).toContain('IN region');
    expect(d?.need?.items.join(' ')).toContain('first_blood.time');
  });

  it('suggests the time field when averaging an event', () => {
    const d = check('WHEN blue.first_blood RETURN avg(first_blood)').diagnostics.find(
      (x) => x.code === 'E-SEM-032',
    );
    expect(d?.quickFixes?.[0]?.newText).toBe('first_blood.time');
  });

  it('explains a missing event in a duration measure as specified in §29', () => {
    const d = check(
      'WHEN blue.first_blood RETURN avg(duration(blue.first_turret_destroy))',
    ).diagnostics.find((x) => x.code === 'E-SEM-031');
    expect(d).toBeDefined();
    expect(d?.got?.items).toContain('first_turret_destroy');
    expect(d?.need?.items).toEqual(['시작 사건', '끝 사건']);
  });

  it('rejects returning an event directly', () => {
    expect(codes('WHEN blue.first_blood RETURN first_blood')).toContain('E-SEM-035');
  });

  it.each([
    'RETURN win_rate(123)',
    'RETURN avg("oops")',
    'RETURN bucket("x", true)',
    'WHEN 42 RETURN count()',
    'WHEN 1 AND 2 RETURN count()',
  ])('rejects invalid arity or types: %s', (source) => {
    expect(check(source).diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(
      true,
    );
  });

  it.each([
    'ANALYZE team WHEN death.role IN ("TOP", "MID") RETURN loss_rate()',
    'ANALYZE team WHEN all_values(death.role IN ("TOP", "MID")) RETURN loss_rate()',
    'ANALYZE team AFTER dragon_kill[4] WITHIN 90s IF death.role IN ("TOP") RETURN success_rate()',
  ])('accepts executable victim-role analysis: %s', (source) => {
    expect(check(source).diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  });

  it('rejects unknown victim roles before execution', () => {
    const result = check('ANALYZE team WHEN death.role IN ("MIDDLE") RETURN loss_rate()');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'E-SEM-043', titleKo: '역할 값이 올바르지 않습니다' }),
      ]),
    );
  });
});

describe('boundary AST validation', () => {
  it.each([
    {
      kind: 'Program',
      analyze: null,
      body: { kind: 'SimpleStmt', chain: null, when: null, groupBy: [], returns: [] },
    },
    {
      kind: 'Program',
      analyze: null,
      body: { kind: 'CompareStmt', arms: [], groupBy: [], returns: [] },
    },
    {
      kind: 'Program',
      analyze: null,
      body: {
        kind: 'SimpleStmt',
        chain: null,
        when: { kind: 'ErrorExpr', rawText: '?', diagnosticCode: 'E-SYN-002' },
        groupBy: [],
        returns: [
          {
            kind: 'ReturnItem',
            alias: null,
            expr: { kind: 'CallExpr', callee: 'count', scope: null, args: [] },
          },
        ],
      },
    },
  ] as Program[])('rejects incomplete or recovered programs', (program) => {
    expect(
      validate(program, ctx).diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    ).toBe(true);
  });

  it('rejects grouping inside a comparison but allows multiple results', () => {
    expect(
      codes(
        'ANALYZE blue\nCOMPARE blue.first_blood VS red.first_blood\nGROUP BY side\nRETURN blue.win_rate',
      ),
    ).toContain('E-SEM-054');
    expect(
      codes(
        'ANALYZE blue\nCOMPARE blue.first_blood VS red.first_blood\nRETURN blue.win_rate, count()',
      ),
    ).not.toContain('E-SEM-055');
  });
});

describe('regions and coordinate spaces', () => {
  it('identifies an undefined region and lists available regions', () => {
    const d = check(
      'WHEN first_blood.position IN region("없는영역") RETURN count()',
    ).diagnostics.find((x) => x.code === 'E-SEM-041');
    expect(d).toBeDefined();
    expect(d?.need?.items.length).toBeGreaterThan(0);
  });

  it('accepts a user-defined region', () => {
    expect(codes('WHEN death.position IN region("custom_region_1") RETURN count()')).not.toContain(
      'E-SEM-041',
    );
  });

  it('rejects mixed coordinate spaces', () => {
    // Minimap regions are normalized; `WITHIN 1000` uses game units.
    expect(codes('WHEN death.position WITHIN 1000 OF region("top_lane") RETURN count()')).toContain(
      'E-SEM-042',
    );
  });
});

describe('analysis grains, functions, and grouping', () => {
  it('rejects champion grouping at team grain and provides fixes', () => {
    const d = check('ANALYZE blue GROUP BY champion RETURN win_rate()').diagnostics.find(
      (x) => x.code === 'E-SEM-051',
    );
    expect(d).toBeDefined();
    expect(d?.bodyKo).toContain('5명');
    expect(d?.quickFixes?.[0]?.newText).toContain('ANALYZE player');
  });

  it('allows champion grouping at player grain', () => {
    expect(codes('ANALYZE player GROUP BY champion RETURN win_rate()')).not.toContain('E-SEM-051');
  });

  it('allows catalog-backed player statistics in conditions and aggregates', () => {
    expect(
      codes(
        'ANALYZE player WHEN player.kda >= 3 RETURN avg(player.damage_dealt), median(player.cs_per_minute)',
      ),
    ).toEqual([]);
    expect(codes('ANALYZE team RETURN avg(team.kda)')).toContain('E-SEM-011');
  });

  it('rejects subject attributes from a different analysis grain', () => {
    expect(codes('ANALYZE team WHEN player.champion = "Ahri" RETURN win_rate()')).toContain(
      'E-SEM-052',
    );
    expect(codes('ANALYZE player RETURN avg(team.total_kills)')).toContain('E-SEM-052');
  });

  it('allows champion pick rate only at match grain', () => {
    expect(codes('ANALYZE match RETURN pick_rate("Ahri")')).toEqual([]);
    expect(codes('ANALYZE player RETURN pick_rate("Ahri")')).toContain('E-SEM-052');
    expect(codes('ANALYZE match RETURN pick_rate()')).toContain('E-SEM-033');
  });

  it('explains the missing reference event for a success rate', () => {
    const d = check('ANALYZE blue RETURN success_rate()').diagnostics.find(
      (x) => x.code === 'E-SEM-060',
    );
    expect(d).toBeDefined();
    expect(d?.need?.items).toContain('기준 사건');
    expect(d?.quickFixes?.[0]?.newText).toContain('AFTER');
  });

  it('rejects gold difference at match grain', () => {
    // Gold difference compares teams or players; match grain has no opponent.
    expect(codes('ANALYZE match WHEN gold_diff(10:00) >= 1500 RETURN count()')).toContain(
      'E-SEM-052',
    );
  });
});

describe('statistical pitfalls (§23)', () => {
  it('warns when a condition includes an outcome', () => {
    // Filtering to winners before measuring win rate always produces 100%.
    const d = check('ANALYZE blue WHEN win = true RETURN win_rate()').diagnostics.find(
      (x) => x.code === 'W-SEM-080',
    );
    expect(d).toBeDefined();
    expect(d?.severity).toBe('warning');
  });

  it('warns when win_rate is called inside a condition', () => {
    expect(codes('ANALYZE blue WHEN blue.win_rate() > 0.5 RETURN count()')).toContain('W-SEM-080');
  });

  it('warns when a probe time exceeds most match durations', () => {
    const d = check('ANALYZE blue WHEN blue.gold_diff(45:00) >= 1500 RETURN win_rate()', {
      ...ctx,
      medianMatchDurationS: 27 * 60,
    }).diagnostics.find((x) => x.code === 'E-SEM-070');
    expect(d?.severity).toBe('warning');
  });
});

describe('condition descriptions (§22)', () => {
  it('renders a condition as a Korean sentence', () => {
    const ast = parse(
      'ANALYZE blue WHEN blue.first_blood AND first_blood.position IN region("top_lane") RETURN win_rate()',
    ).ast!;
    const body = ast.body;
    if (body.kind !== 'SimpleStmt' || !body.when) throw new Error('condition is absent');
    const text = describeCondition(body.when);
    expect(text).toContain('블루팀이 퍼스트 블러드를 기록했습니다');
    expect(text).not.toContain('을(를)');
    expect(text).toContain('top_lane');
    expect(text).not.toMatch(/[이가을를]\([가-힣]+\)/);
  });

  it('avoids placeholder particles in numeric summaries', () => {
    const ast = parse('ANALYZE blue WHEN blue.gold_diff(10:00) >= 1500 RETURN blue.win_rate').ast!;
    const body = ast.body;
    if (body.kind !== 'SimpleStmt' || !body.when) throw new Error('condition is absent');
    expect(describeCondition(body.when)).not.toMatch(/[이가을를]\([가-힣]+\)/);
  });

  it('describes a negated condition correctly', () => {
    const ast = parse('ANALYZE blue WHEN NOT blue.first_blood RETURN win_rate()').ast!;
    const body = ast.body;
    if (body.kind !== 'SimpleStmt' || !body.when) throw new Error('condition is absent');
    expect(describeCondition(body.when)).toContain('퍼스트 블러드를 기록하지 않았습니다');
  });
});

describe('diagnostic quality', () => {
  it('keeps implementation terms out of all diagnostics', () => {
    const jargon = ['AST', '파싱', '토큰', '파서', 'SQL', '쿼리', '컴파일'];
    const sources = [
      'WHEN firstblood RETURN count()',
      'WHEN first_blood.position < 600s RETURN count()',
      'ANALYZE blue GROUP BY champion RETURN win_rate()',
      'ANALYZE blue RETURN success_rate()',
      'WHEN region("없음") RETURN count()',
    ];
    for (const src of sources) {
      for (const d of check(src).diagnostics) {
        for (const term of jargon) {
          expect(`${d.titleKo} ${d.bodyKo}`, `${d.code}: '${term}'`).not.toContain(term);
        }
      }
    }
  });

  it('includes current or required context in every error diagnostic', () => {
    const sources = [
      'WHEN firstblood RETURN count()',
      'ANALYZE blue GROUP BY champion RETURN win_rate()',
      'ANALYZE blue RETURN success_rate()',
    ];
    for (const src of sources) {
      for (const d of check(src).diagnostics.filter((x) => x.severity === 'error')) {
        expect(d.got || d.need, `${d.code} does not explain what to fix`).toBeTruthy();
      }
    }
  });
});

describe('diagnostic-code catalog consistency', () => {
  it('defines every validator diagnostic code in the catalog', async () => {
    // Inline copy would bypass the §23 forbidden-phrase linter.
    const { catalog } = await import('@lol/catalog');
    const sources = [
      'WHEN firstblood RETURN count()',
      'WHEN turret_damage RETURN count()',
      'WHEN dragon_spawn.player = 1 RETURN count()',
      'WHEN first_blood.position < 600s RETURN count()',
      'WHEN blue.first_blood RETURN avg(first_blood)',
      'WHEN blue.first_blood RETURN avg(duration(blue.first_turret_destroy))',
      'WHEN blue.first_blood RETURN first_blood',
      'WHEN first_blood.position IN region("없음") RETURN count()',
      'WHEN death.position WITHIN 1000 OF region("top_lane") RETURN count()',
      'ANALYZE blue GROUP BY champion RETURN win_rate()',
      'ANALYZE blue RETURN success_rate()',
      'ANALYZE match WHEN gold_diff(10:00) >= 1500 RETURN count()',
      'ANALYZE blue WHEN win = true RETURN win_rate()',
      'ANALYZE player GROUP BY 없는기준 RETURN win_rate()',
      'ANALYZE blue RETURN 없는측정값()',
    ];
    const missing = new Set<string>();
    for (const src of sources) {
      for (const d of check(src).diagnostics) {
        if (!catalog.diagnostics[d.code]) missing.add(d.code);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('keeps causal language out of catalog copy', async () => {
    const { catalog, FORBIDDEN_PHRASES } = await import('@lol/catalog');
    const violations: string[] = [];
    for (const d of Object.values(catalog.diagnostics)) {
      for (const phrase of FORBIDDEN_PHRASES) {
        if (`${d.titleKo}${d.bodyKo}`.includes(phrase)) violations.push(`${d.code}: ${phrase}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
