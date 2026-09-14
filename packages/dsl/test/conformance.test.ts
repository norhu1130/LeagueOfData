/**
 * TypeScript-side conformance golden verification.
 *
 * Python consumes `expected.ast.json` and `expected.hash.json` from the same directory to verify
 * canonical serialization, then executes supported ASTs in engine integration tests.
 *
 * Update goldens with `pnpm -F @lol/dsl build:conformance`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalize } from '@lol/ast';
import { parse } from '../src/parser.js';
import { printDsl } from '../src/printer.js';

const ROOT = resolve(import.meta.dirname, '../../../tests/conformance/cases');
const CASES = readdirSync(ROOT).sort();

const read = (name: string, file: string) => readFileSync(resolve(ROOT, name, file), 'utf8');

describe('conformance cases', () => {
  it('contains cases', () => {
    expect(CASES.length).toBeGreaterThan(15);
  });

  it.each(CASES)('%s', (name) => {
    const meta = JSON.parse(read(name, 'meta.json'));
    const source = read(name, 'input.dsl').replace(/\n$/, '');
    const result = parse(source);

    // AST golden
    expect(canonicalize(result.ast, { dropRaw: false })).toEqual(
      JSON.parse(read(name, 'expected.ast.json')),
    );

    // Printer golden
    expect(result.ast ? printDsl(result.ast) + '\n' : '').toBe(read(name, 'expected.print.dsl'));

    // Diagnostic golden
    const diagnostics = result.diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      titleKo: d.titleKo,
      ...(d.got ? { got: d.got } : {}),
      ...(d.need ? { need: d.need } : {}),
    }));
    expect(diagnostics).toEqual(JSON.parse(read(name, 'expected.diag.json')));

    // Error expectations must match case metadata.
    const hasErrors = result.diagnostics.some((d) => d.severity === 'error');
    expect(hasErrors, `${name}: expects errors=${meta.expectsErrors}`).toBe(meta.expectsErrors);
  });

  it('covers every definition-of-done question', () => {
    const covered = new Set(
      CASES.map((name) => JSON.parse(read(name, 'meta.json')).dod).filter(Boolean),
    );
    expect([...covered].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('retains a partial AST for error cases', () => {
    for (const name of CASES) {
      const meta = JSON.parse(read(name, 'meta.json'));
      if (!meta.expectsErrors) continue;
      const ast = JSON.parse(read(name, 'expected.ast.json'));
      expect(ast, `${name}: error recovery must retain an AST for the builder`).not.toBeNull();
    }
  });
});
