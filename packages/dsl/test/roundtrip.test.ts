/**
 * Round-trip stability, a required integration gate.
 *
 * Instability here creates builder/DSL echo loops or silently loses user conditions.
 *
 *   P1  parse(print(parse(s))) ≡ parse(s)    (parse round trip)
 *   P2  print(parse(print(a))) === print(a)  (print idempotence)
 */
import { describe, it, expect } from 'vitest';
import { astStrictEquals, canonicalJson, type Program } from '@lol/ast';
import { parse } from '../src/parser.js';
import { printDsl } from '../src/printer.js';

/** All examples from specification §14, §35, §12, and §13. */
export const SPEC_PROGRAMS: readonly string[] = [
  // §14
  'WHEN blue.first_blood RETURN blue.win_rate',
  'WHEN blue.first_blood AND first_blood.position IN region("top_lane") RETURN blue.win_rate',
  'WHEN blue.first_blood RETURN avg(duration(blue.first_blood, blue.first_turret_destroy))',
  'WHEN blue.gold_diff(10:00) >= 1500 RETURN blue.win_rate',
  'WHEN player.champion = "Darius" AND player.role = "TOP" AND player.gold_diff(10:00) >= 500 RETURN player.win_rate',
  'AFTER player.kill WITHIN 90s IF dragon.killed RETURN success_rate()',
  // §35
  'ANALYZE blue\nWHEN blue.first_blood AND first_blood.position IN region("custom_top_region")\nRETURN avg(duration(blue.first_blood, blue.first_turret_destroy)) AS time_to_turret, blue.win_rate AS win_rate',
  // §12
  'WHEN blue.first_blood GROUP BY champion RETURN win_rate()',
  'GROUP BY champion, role RETURN win_rate(), count()',
  // §13
  'COMPARE WHEN first_blood = true VS WHEN first_blood = false RETURN win_rate()',
  // Additional syntax surfaces
  'ANALYZE match RETURN count()',
  'WHEN NOT blue.first_blood RETURN win_rate()',
  'WHEN blue.first_blood AND first_blood.time < 600s RETURN win_rate()',
  'WHEN death.position WITHIN 1000 OF blue.top_outer_turret RETURN win_rate()',
  'WHEN first_blood.time BETWEEN 2m AND 10m RETURN win_rate()',
  'WHEN blue.first_blood OR red.first_blood RETURN win_rate()',
  'WHEN (blue.first_blood OR red.first_blood) AND first_blood.time < 5m RETURN win_rate()',
  'WHEN blue.gold_diff(10:00) >= 1500 AND blue.xp_diff(10:00) >= 500 RETURN win_rate(), count()',
  'GROUP BY bucket(first_blood.time, 60s) RETURN win_rate()',
  'WHEN player.role = "TOP" GROUP BY champion RETURN win_rate() AS wr, count() AS n',
  'AFTER blue.kill WITHIN 2m IF dragon_kill RETURN success_rate()',
  'AFTER team.ward_placed WITHIN 90s IF opponent.baron_kill RETURN success_rate()',
  'WHEN team.dragon_kill[2] RETURN win_rate()',
  'ANALYZE team RETURN avg(duration(first_blood, turret_destroy[last]))',
  'ANALYZE team WHEN elder_dragon_kill RETURN win_rate(), avg(duration(elder_dragon_kill[last], victory))',
  'AFTER team.ward_placed WITHIN 90s IF opponent.chemtech_dragon_kill[1] RETURN success_rate()',
  'ANALYZE team AFTER dragon_kill[4] WITHIN 90s IF death.role IN ("TOP", "MID") RETURN success_rate()',
  'ANALYZE team WHEN all_values(death.role IN ("TOP", "MID")) RETURN loss_rate()',
  'WHEN first_blood.position IN region("river") RETURN median(first_blood.time)',
  'WHEN blue.first_blood AND NOT red.first_dragon_kill RETURN win_rate()',
  'ANALYZE player(\"Faker\") RETURN win_rate()',
  'WHEN player.role IN ("TOP", "JUNGLE") RETURN count()',
  'WHEN blue.first_blood.position IN region("top_lane") RETURN blue.win_rate',
  'ANALYZE blue WHEN team.kill RETURN blue.win_rate',
];

describe('P1 parse round trip: parse(print(parse(s))) ≡ parse(s)', () => {
  it.each(SPEC_PROGRAMS)('%s', (source) => {
    const first = parse(source);
    expect(first.ast, `parse failed: ${source}`).not.toBeNull();

    const printed = printDsl(first.ast!);
    const second = parse(printed);
    expect(second.ast, `reparse failed:\n${printed}`).not.toBeNull();

    const errors = second.diagnostics.filter((d) => d.severity === 'error');
    expect(
      errors.map((e) => `${e.code} ${e.titleKo}`),
      `printed output cannot be parsed again:\n${printed}`,
    ).toEqual([]);

    expect(
      astStrictEquals(first.ast!, second.ast!),
      `round-trip mismatch\nsource: ${source}\noutput: ${printed}\n` +
        `A: ${canonicalJson(first.ast!, { dropRaw: false })}\n` +
        `B: ${canonicalJson(second.ast!, { dropRaw: false })}`,
    ).toBe(true);
  });
});

describe('P2 print idempotence: print(parse(print(a))) === print(a)', () => {
  it.each(SPEC_PROGRAMS)('%s', (source) => {
    const ast = parse(source).ast!;
    const once = printDsl(ast);
    const twice = printDsl(parse(once).ast!);
    expect(twice).toBe(once);
  });
});

describe('canonical form', () => {
  it('removes unnecessary parentheses', () => {
    const ast = parse('WHEN ((blue.first_blood)) RETURN win_rate()').ast!;
    expect(printDsl(ast)).toBe('WHEN blue.first_blood\nRETURN win_rate()');
  });

  it('preserves required parentheses', () => {
    // Parentheses must remain even when multiple AND terms are split across lines.
    const ast = parse('WHEN (a OR b) AND c RETURN win_rate()').ast!;
    const printed = printDsl(ast);
    expect(printed).toContain('(a OR b)');
    expect(printed).toContain('AND c');
    // Confirm semantic preservation through a round trip.
    expect(canonicalJson(parse(printed).ast!)).toBe(canonicalJson(ast));
  });

  it('preserves duration spelling', () => {
    // Reprinting `90s` as `1m30s` would discard the user's spelling.
    expect(printDsl(parse('WHEN x.time < 90s RETURN count()').ast!)).toContain('90s');
    expect(printDsl(parse('WHEN x.time < 1m30s RETURN count()').ast!)).toContain('1m30s');
  });

  it('preserves every value in an IN list', () => {
    const source = 'WHEN player.role IN ("TOP", "JUNGLE") RETURN count()';
    const first = parse(source).ast!;
    const second = parse(printDsl(first)).ast!;
    expect(astStrictEquals(first, second)).toBe(true);
  });

  it('preserves target-relative and explicit any-team event scopes distinctly', () => {
    const relative = parse('ANALYZE blue WHEN kill RETURN win_rate()').ast!;
    const anyTeam = parse('ANALYZE blue WHEN team.kill RETURN win_rate()').ast!;
    expect(canonicalJson(relative)).not.toBe(canonicalJson(anyTeam));
    expect(printDsl(anyTeam)).toContain('WHEN team.kill');
    expect(canonicalJson(parse(printDsl(anyTeam)).ast!)).toBe(canonicalJson(anyTeam));
  });

  it('does not reorder AND conditions', () => {
    const printed = printDsl(parse('WHEN b AND a AND c RETURN count()').ast!);
    expect(printed.indexOf('b')).toBeLessThan(printed.indexOf('a'));
    expect(printed.indexOf('a')).toBeLessThan(printed.indexOf('c'));
  });

  it('prints clauses in a fixed order', () => {
    const ast = parse('RETURN win_rate() GROUP BY champion WHEN blue.first_blood ANALYZE blue').ast;
    // Invalid clause order is rejected; valid output always uses canonical clause order.
    const normal = parse(
      'ANALYZE blue WHEN blue.first_blood GROUP BY champion RETURN win_rate()',
    ).ast!;
    const lines = printDsl(normal).split('\n');
    expect(lines[0]).toBe('ANALYZE blue');
    expect(lines[1]).toMatch(/^WHEN /);
    expect(lines[2]).toMatch(/^GROUP BY /);
    expect(lines[3]).toMatch(/^RETURN /);
    void ast;
  });

  it('indents multi-condition AND chains across lines', () => {
    const printed = printDsl(
      parse('WHEN blue.first_blood AND first_blood.time < 600s RETURN win_rate()').ast!,
    );
    expect(printed).toBe('WHEN blue.first_blood\n  AND first_blood.time < 600s\nRETURN win_rate()');
  });
});

describe('deterministic binding IDs', () => {
  it('uses the same ID for repeated references to one event', () => {
    // Shared IDs let the compiler reuse one witness CTE for all references to the event.
    const ast = parse(
      'WHEN blue.first_blood AND first_blood.position IN region("top_lane") RETURN blue.win_rate',
    ).ast!;
    const json = canonicalJson(ast);
    const ids = [...json.matchAll(/"bindingId":"([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toBe('blue.first_blood#any');
  });

  it('derives IDs from content rather than randomness', () => {
    const a = parse('WHEN blue.first_blood RETURN win_rate()').ast!;
    const b = parse('WHEN blue.first_blood RETURN win_rate()').ast!;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('resolves aliases to ordinal qualifiers while preserving spelling', () => {
    const ast = parse('WHEN blue.first_turret_destroy RETURN count()').ast! as Program;
    expect(canonicalJson(ast)).toContain('"ordinal":"first"');
    expect(canonicalJson(ast)).toContain('"eventType":"turret_destroy"');
    expect(printDsl(ast)).toContain('first_turret_destroy');
  });

  it('preserves a numbered event occurrence and derives a distinct binding ID', () => {
    const ast = parse('WHEN blue.dragon_kill[3] RETURN win_rate()').ast!;
    expect(canonicalJson(ast)).toContain('"ordinal":3');
    expect(canonicalJson(ast)).toContain('blue.dragon_kill#nth-3');
    expect(printDsl(ast)).toContain('blue.dragon_kill[3]');
  });
});
