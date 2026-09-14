/**
 * Generates conformance golden files.
 *
 * TypeScript and Python read the same case directory:
 *   TS     : input.dsl → expected.ast.json / expected.print.dsl / expected.diag.json
 *   Python : expected.ast.json / expected.hash.json → hash checks and engine integration
 *
 * Python consumes the AST produced by TypeScript, validating the cross-language contract in
 * every case.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash, canonicalJson, canonicalize } from '@lol/ast';
import { parse } from '../src/parser.js';
import { printDsl } from '../src/printer.js';
import { CONFORMANCE_CASES } from './cases.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../tests/conformance/cases');

if (existsSync(root)) rmSync(root, { recursive: true });
mkdirSync(root, { recursive: true });

let written = 0;
for (const testCase of CONFORMANCE_CASES) {
  const dir = resolve(root, testCase.name);
  mkdirSync(dir, { recursive: true });

  const result = parse(testCase.dsl);
  writeFileSync(resolve(dir, 'input.dsl'), testCase.dsl + '\n', 'utf8');
  writeFileSync(
    resolve(dir, 'expected.ast.json'),
    JSON.stringify(canonicalize(result.ast, { dropRaw: false }), null, 2) + '\n',
    'utf8',
  );
  writeFileSync(
    resolve(dir, 'expected.print.dsl'),
    result.ast ? printDsl(result.ast) + '\n' : '',
    'utf8',
  );
  writeFileSync(
    resolve(dir, 'expected.diag.json'),
    JSON.stringify(
      result.diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        titleKo: d.titleKo,
        ...(d.got ? { got: d.got } : {}),
        ...(d.need ? { need: d.need } : {}),
      })),
      null,
      2,
    ) + '\n',
    'utf8',
  );
  // Python must produce the same hash so cache keys and drill-down tokens agree.
  writeFileSync(
    resolve(dir, 'expected.hash.json'),
    JSON.stringify(
      result.ast
        ? { hash: canonicalHash(result.ast), canonicalJson: canonicalJson(result.ast) }
        : { hash: null, canonicalJson: null },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeFileSync(
    resolve(dir, 'meta.json'),
    JSON.stringify(
      {
        name: testCase.name,
        descriptionKo: testCase.descriptionKo,
        ...(testCase.dod ? { dod: testCase.dod } : {}),
        tags: testCase.tags,
        expectsErrors: testCase.expectsErrors ?? false,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  written++;
}

console.log(`wrote ${written} conformance cases to ${root}`);
