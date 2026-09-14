/**
 * Exports the catalog as JSON for the Python compiler.
 *
 * CI reruns this script and checks the diff to detect stale generated artifacts.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, referencedColumns, stableStringify } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../../data/reference');
mkdirSync(outDir, { recursive: true });
const packageDir = resolve(here, '../../../services/api/src/lod_api');

const payload = {
  $generated: 'packages/catalog/scripts/build-json.ts — 직접 수정하지 마세요',
  ...catalog,
  // Columns the backend validates against the physical DuckDB schema.
  referencedColumns: referencedColumns(),
};

// Key-sorted serialization prevents diffs caused only by source reordering.
const contents = JSON.stringify(JSON.parse(stableStringify(payload)), null, 2) + '\n';
const files = [resolve(outDir, 'catalog.json'), resolve(packageDir, 'catalog.json')];
for (const file of files) writeFileSync(file, contents, 'utf8');

const events = Object.values(catalog.events);
console.log(
  `wrote ${files.join(', ')}\n  hash=${catalog.hash}\n  events=${events.length} (사용 가능 ${events.filter((e) => e.available).length})` +
    `\n  functions=${Object.keys(catalog.functions).length} groupKeys=${Object.keys(catalog.groupKeys).length}` +
    `\n  diagnostics=${Object.keys(catalog.diagnostics).length}`,
);
