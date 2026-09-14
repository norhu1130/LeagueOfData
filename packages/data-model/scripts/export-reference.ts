/**
 * Exports coordinate constants and built-in regions to `data/reference`.
 *
 * TypeScript is authoritative and Python reads the generated artifacts. CI reruns this script
 * and checks the diff to prevent cross-language coordinate drift.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MAP_MIN, MAP_SPAN } from '../src/coords.js';
import { PRESET_REGIONS, REGION_COORD_SPACE } from '../src/regions.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../../data/reference');
mkdirSync(outDir, { recursive: true });
const packageDir = resolve(here, '../../../packages-py/lod_data/src/lod_data');

const payload = {
  $generated: 'packages/data-model/scripts/export-reference.ts — 직접 수정하지 마세요',
  coordSpace: REGION_COORD_SPACE,
  map: { min: MAP_MIN, span: MAP_SPAN },
  regions: PRESET_REGIONS,
};

const contents = JSON.stringify(payload, null, 2) + '\n';
const files = [
  resolve(outDir, 'regions_builtin.json'),
  resolve(packageDir, 'regions_builtin.json'),
];
for (const file of files) writeFileSync(file, contents, 'utf8');
console.log(`wrote ${files.join(', ')} (${PRESET_REGIONS.length} regions)`);
