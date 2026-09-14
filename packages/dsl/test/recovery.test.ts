/**
 * Error recovery, central to §28 and §29.
 *
 * Intermediate typing states are routinely invalid. The parser must return a partial AST
 * instead of throwing so the visual builder can retain existing cards.
 */
import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser.js';

const codes = (src: string) => parse(src).diagnostics.map((d) => d.code);

describe('partial AST recovery', () => {
  it.each([
    'WHEN blue.f',
    'WHEN blue.first_blood AND',
    'WHEN blue.first_blood RETURN',
    'WHEN',
    'ANALYZE',
    'WHEN blue.first_blood AND first_blood.position IN region(',
    'RETURN avg(',
    'COMPARE WHEN a VS',
  ])('returns an AST for intermediate input %s', (src) => {
    const result = parse(src);
    expect(result.ast, 'the builder requires an AST during intermediate input').not.toBeNull();
  });

  it('does not throw', () => {
    const nasty = ['((((', '))))', 'WHEN ) RETURN (', '@@@', 'WHEN 1 1 1 RETURN', ''];
    for (const src of nasty) expect(() => parse(src)).not.toThrow();
  });

  it('continues parsing other clauses after one clause fails', () => {
    // RETURN must survive an invalid condition so its result card remains visible.
    const result = parse('WHEN @@@ RETURN win_rate()');
    const body = result.ast!.body;
    expect(body.kind).toBe('SimpleStmt');
    if (body.kind === 'SimpleStmt') {
      expect(body.returns).toHaveLength(1);
    }
  });
});

describe('diagnostic quality (§29)', () => {
  it('explains a missing RETURN clause and provides a fix', () => {
    const [diagnostic] = parse('WHEN blue.first_blood').diagnostics;
    expect(diagnostic?.code).toBe('E-SYN-001');
    expect(diagnostic?.need?.items.length).toBeGreaterThan(0);
    expect(diagnostic?.quickFixes?.[0]?.newText).toContain('win_rate()');
  });

  it('explains how to split chained comparisons', () => {
    const diagnostics = parse('WHEN a < b < c RETURN count()').diagnostics;
    const d = diagnostics.find((x) => x.code === 'E-SYN-012');
    expect(d).toBeDefined();
    expect(d?.need?.items).toContain('AND 로 나누기');
  });

  it('offers two fixes when WITHIN has no reference', () => {
    const d = parse('WHEN death.position WITHIN 1000 RETURN count()').diagnostics.find(
      (x) => x.code === 'E-SYN-021',
    );
    expect(d).toBeDefined();
    // Spatial use needs OF; temporal use needs a unit.
    expect(d?.need?.items.join(' ')).toMatch(/OF/);
    expect(d?.need?.items.join(' ')).toMatch(/90s|시간/);
  });

  it('repairs a duration unit separated by whitespace', () => {
    const d = parse('WHEN x.time < 90 s RETURN count()').diagnostics.find(
      (x) => x.code === 'E-LEX-003',
    );
    expect(d?.quickFixes?.[0]?.newText).toBe('90s');
  });

  it('identifies an unknown side', () => {
    expect(codes('ANALYZE purple RETURN count()')).toContain('E-SEM-050');
  });

  it('rejects COMPARE with only one branch', () => {
    expect(codes('COMPARE WHEN a RETURN win_rate()')).toContain('E-SYN-030');
  });

  it('requires WHEN before every comparison branch', () => {
    expect(codes('COMPARE a VS WHEN b RETURN win_rate()')).toContain('E-SYN-002');
  });

  it('requires a name after AS', () => {
    expect(codes('RETURN count() AS')).toContain('E-SYN-002');
  });

  it('requires a member name after a trailing dot', () => {
    expect(codes('RETURN blue.')).toContain('E-SYN-002');
  });

  it('rejects tokens left after a complete analysis', () => {
    expect(codes('RETURN win_rate() garbage')).toContain('E-SYN-002');
  });

  it('keeps implementation terms out of diagnostics', () => {
    const jargon = ['AST', '파싱', '토큰', '파서', 'SQL', '쿼리'];
    const sources = ['WHEN', 'WHEN a < b < c RETURN x', 'RETURN', 'ANALYZE purple RETURN count()'];
    for (const src of sources) {
      for (const d of parse(src).diagnostics) {
        for (const term of jargon) {
          expect(`${d.titleKo} ${d.bodyKo}`, `${d.code}: '${term}'`).not.toContain(term);
        }
      }
    }
  });

  it('gives every diagnostic a source range', () => {
    for (const src of ['WHEN', 'WHEN a < b < c RETURN x', 'ANALYZE purple RETURN count()']) {
      for (const d of parse(src).diagnostics) {
        expect(d.span[0]).toBeGreaterThanOrEqual(0);
        expect(d.span[1]).toBeGreaterThanOrEqual(d.span[0]);
      }
    }
  });
});

describe('valid input', () => {
  it('emits no error diagnostics for specification examples', () => {
    const clean = [
      'WHEN blue.first_blood RETURN blue.win_rate',
      'WHEN blue.gold_diff(10:00) >= 1500 RETURN blue.win_rate',
      'AFTER player.kill WITHIN 90s IF dragon.killed RETURN success_rate()',
      'COMPARE WHEN first_blood = true VS WHEN first_blood = false RETURN win_rate()',
    ];
    for (const src of clean) {
      const errors = parse(src).diagnostics.filter((d) => d.severity === 'error');
      expect(
        errors.map((e) => `${e.code} ${e.titleKo}`),
        src,
      ).toEqual([]);
    }
  });
});
