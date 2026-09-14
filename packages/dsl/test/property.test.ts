import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { astStrictEquals, canonicalJson } from '@lol/ast';
import { parse } from '../src/parser.js';
import { printDsl } from '../src/printer.js';
import { programArb } from './arbitrary.js';

const RUNS = 500;

describe('property-based round trips', () => {
  it('P1: preserves an arbitrary AST after printing and parsing', () => {
    fc.assert(
      fc.property(programArb, (ast) => {
        const printed = printDsl(ast);
        const reparsed = parse(printed);

        const errors = reparsed.diagnostics.filter((d) => d.severity === 'error');
        expect(
          errors.map((e) => e.code),
          `printed output cannot be parsed:\n${printed}`,
        ).toEqual([]);
        expect(reparsed.ast).not.toBeNull();

        expect(
          astStrictEquals(ast, reparsed.ast!),
          `round-trip mismatch\noutput: ${printed}\nA: ${canonicalJson(ast, { dropRaw: false })}\nB: ${canonicalJson(reparsed.ast!, { dropRaw: false })}`,
        ).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('P2: makes printing idempotent', () => {
    fc.assert(
      fc.property(programArb, (ast) => {
        const once = printDsl(ast);
        const twice = printDsl(parse(once).ast!);
        expect(twice, `printing is not idempotent\nfirst: ${once}\nsecond: ${twice}`).toBe(once);
      }),
      { numRuns: RUNS },
    );
  });

  it('gives semantically equal ASTs the same hash', () => {
    fc.assert(
      fc.property(programArb, (ast) => {
        const reparsed = parse(printDsl(ast)).ast!;
        expect(canonicalJson(reparsed)).toBe(canonicalJson(ast));
      }),
      { numRuns: RUNS },
    );
  });
});
