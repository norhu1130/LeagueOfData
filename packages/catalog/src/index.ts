/**
 * Semantic catalog assembly and lookup.
 *
 * TypeScript consumers import this module directly. Python reads generated `catalog.json`;
 * the content hash guarantees that both sides use the same catalog.
 */
import { sha256Hex } from '@lol/ast';
import { MAP_MIN, MAP_SPAN } from '@lol/data-model';
import {
  CATALOG_VERSION,
  CONTEXT_FIELDS,
  DIAGNOSTICS,
  ENTITIES,
  FORBIDDEN_PHRASES,
  GRAINS,
  LANDMARKS,
  TABLES,
} from './definitions.js';
import { EVENTS } from './events.js';
import { FUNCTIONS, GROUP_KEYS } from './functions.js';
import { DSL_LANGUAGE } from './language.js';
import { SUBJECT_FIELDS } from './subject-fields.js';
import type { Catalog, EventDef, FunctionDef, GrainId } from './types.js';

export * from './types.js';
export { CATALOG_VERSION, FORBIDDEN_PHRASES };

/** The entire catalog is contractual and participates in the hash. */
function computeHash(payload: unknown): string {
  return 'sha256:' + sha256Hex(stableStringify(payload));
}

/**
 * Key-sorted serialization prevents source reordering from invalidating persisted analyses.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
  );
}

const body = {
  catalogVersion: CATALOG_VERSION,
  map: { min: MAP_MIN, span: MAP_SPAN },
  tables: TABLES,
  grains: GRAINS,
  entities: ENTITIES,
  landmarks: LANDMARKS,
  events: EVENTS,
  contextFields: CONTEXT_FIELDS,
  subjectFields: SUBJECT_FIELDS,
  functions: FUNCTIONS,
  groupKeys: GROUP_KEYS,
  dslLanguage: DSL_LANGUAGE,
  diagnostics: DIAGNOSTICS,
  forbiddenPhrases: FORBIDDEN_PHRASES,
};

export const catalog: Catalog = { ...body, hash: computeHash(body) };

// --------------------------------------------------------------------- Lookup

/** Events available to completion and card choices; unavailable entries are excluded by default. */
export function listEvents(options: { includeUnavailable?: boolean } = {}): EventDef[] {
  return Object.values(catalog.events)
    .filter((e) => options.includeUnavailable || e.available)
    .sort((a, b) => a.rank - b.rank);
}

/** Resolves a surface name, including aliases, to an event and ordinal qualifier. */
export function resolveEventSurface(
  surface: string,
): { event: EventDef; ordinal: 'first' | 'last' | 'any' } | null {
  const direct = catalog.events[surface];
  if (direct) return { event: direct, ordinal: 'any' };
  for (const event of Object.values(catalog.events)) {
    const alias = event.aliases?.[surface];
    if (alias) return { event, ordinal: alias.ordinal };
  }
  return null;
}

/** Fields available after `first_blood.`, consumed directly by Monaco completion. */
export function propertiesOf(eventOrSurface: string) {
  const resolved = resolveEventSurface(eventOrSurface);
  if (!resolved) return null;
  return resolved.event.context
    .map((id) => catalog.contextFields[id])
    .filter((f): f is NonNullable<typeof f> => f !== undefined)
    .sort((a, b) => a.rank - b.rank);
}

export function listFunctions(grain?: GrainId): FunctionDef[] {
  return Object.values(catalog.functions)
    .filter((f) => !grain || f.validGrains.includes(grain))
    .sort((a, b) => a.rank - b.rank);
}

export function listSubjectFields(grain?: GrainId) {
  return Object.values(catalog.subjectFields)
    .filter((field) => !grain || field.validGrains.includes(grain))
    .sort((a, b) => a.rank - b.rank);
}

export function listGroupKeys(grain?: GrainId) {
  return Object.values(catalog.groupKeys)
    .filter((g) => !grain || g.validGrains.includes(grain))
    .sort((a, b) => a.rank - b.rank);
}

export function diagnostic(code: string) {
  return catalog.diagnostics[code] ?? null;
}

/**
 * Typo candidates within Damerau-Levenshtein distance two, returning at most three (§29).
 */
export function suggestEventNames(input: string, limit = 3): string[] {
  const candidates = [
    ...Object.keys(catalog.events),
    ...Object.values(catalog.events).flatMap((e) => Object.keys(e.aliases ?? {})),
  ];
  return candidates
    .map((name) => ({ name, distance: editDistance(input.toLowerCase(), name.toLowerCase()) }))
    .filter((c) => c.distance <= 2)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((c) => c.name);
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[m]![n]!;
}

/** Every catalog-referenced column, checked by the backend against the physical schema. */
export function referencedColumns(): Record<string, string[]> {
  const byTable: Record<string, Set<string>> = {};
  for (const event of Object.values(catalog.events)) {
    if (!event.available) continue;
    const set = (byTable[event.sqlBinding.table] ??= new Set());
    for (const col of event.sqlBinding.columns) set.add(col);
  }
  for (const field of Object.values(catalog.subjectFields)) {
    const set = (byTable[field.table] ??= new Set());
    for (const column of field.columns) set.add(column);
  }
  return Object.fromEntries(Object.entries(byTable).map(([t, s]) => [t, [...s].sort()]));
}
