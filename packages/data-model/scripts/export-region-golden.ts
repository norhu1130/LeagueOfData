/**
 * Generates region-containment golden data over a deterministic grid. Python reads the same
 * artifact so point-in-polygon boundary behavior cannot drift between implementations.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PRESET_REGIONS, pointInRegion } from '../src/regions.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../../tests/conformance/regions');
mkdirSync(outDir, { recursive: true });

// A 41x41 grid plus points near boundaries and diagonals. The 0.025 spacing deliberately
// places some points exactly on polygon edges.
const points: [number, number][] = [];
for (let i = 0; i <= 40; i++) {
  for (let j = 0; j <= 40; j++) points.push([i / 40, j / 40]);
}
for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
  points.push([t, t]); // Main diagonal through mid lane.
  points.push([t, 1 - t]); // Opposite diagonal through the river.
}

const rows = points.map(([x, y]) => ({
  x,
  y,
  hits: PRESET_REGIONS.filter((r) => pointInRegion(x!, y!, r)).map((r) => r.id),
}));

const file = resolve(outDir, 'point_in_region.json');
writeFileSync(
  file,
  JSON.stringify(
    { $generated: 'packages/data-model/scripts/export-region-golden.ts', cases: rows },
    null,
    1,
  ) + '\n',
  'utf8',
);
console.log(`wrote ${file} (${rows.length} points)`);
