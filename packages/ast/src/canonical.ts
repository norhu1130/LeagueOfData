/**
 * AST canonicalization and content hashing.
 *
 * This hash is both the result-cache key and drill-down token. **The Python compiler must
 * produce the same value for the same AST.** Conformance tests enforce these rules.
 *
 * Canonical-form rules:
 *   R1. Remove `span`.
 *   R2. Remove `raw` by default so equivalent duration spellings share a cache entry.
 *   R3. Treat `undefined` and absent keys equally.
 *   R4. Sort object keys lexicographically.
 *   R5. Serialize integral floating-point values as integers.
 *   R6. Preserve array order because `A AND B` and `B AND A` retain source ordering.
 */
import type { Node } from './nodes.js';
import { sha256Hex } from './sha256.js';

export interface CanonicalizeOptions {
  /** Whether to remove original spelling (`raw`); hashes remove it and round-trip checks retain it. */
  readonly dropRaw?: boolean;
}

/** Keys always removed from canonical form. */
const ALWAYS_DROP = new Set(['span']);
/** Additional keys removed when `dropRaw` is enabled. */
const PRESENTATION_KEYS = new Set(['raw']);

export function canonicalize(value: unknown, options: CanonicalizeOptions = {}): unknown {
  const dropRaw = options.dropRaw ?? true;
  return normalize(value, dropRaw);
}

function normalize(value: unknown, dropRaw: boolean): unknown {
  if (value === null) return null;
  if (typeof value === 'number') return normalizeNumber(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => normalize(v, dropRaw));

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (ALWAYS_DROP.has(key)) continue;
    if (dropRaw && PRESENTATION_KEYS.has(key)) continue;
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = normalize(v, dropRaw);
  }
  return out;
}

/**
 * R5. Fold `1.0` into `1`.
 *
 * JavaScript serializes `1.0` as `"1"`, while Python normally emits `"1.0"`.
 * Folding prevents cross-language hash differences.
 */
function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error(`Cannot normalize a non-finite number: ${value}`);
  if (value !== 0 && (Math.abs(value) < 1e-6 || Math.abs(value) >= 1e21)) {
    throw new Error(`Cannot normalize a number outside the canonical range: ${value}`);
  }
  return Number.isInteger(value) ? Math.trunc(value) : value;
}

/** Key-sorted serialization of an already normalized value. */
export function canonicalStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return numberToJson(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalStringify(v)).join(',') + '}'
    );
  }
  throw new Error(`Cannot serialize value: ${String(value)}`);
}

function numberToJson(value: number): string {
  // Normalization has already folded integral values. JavaScript and Python both use a
  // shortest round-trippable representation for the remaining floats.
  return Object.is(value, -0) ? '0' : String(value);
}

/** Canonical JSON string; Python must produce the identical string. */
export function canonicalJson(node: Node, options?: CanonicalizeOptions): string {
  return canonicalStringify(canonicalize(node, options));
}

/** Content hash used by cache keys and drill-down tokens. */
export function canonicalHash(node: Node): string {
  return 'sha256:' + sha256Hex(canonicalStringify(normalizeCommutativeBoolean(canonicalize(node))));
}

/** Sorts only commutative boolean operands for cache hashing; presentation order stays intact. */
function normalizeCommutativeBoolean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCommutativeBoolean);
  if (value === null || typeof value !== 'object') return value;

  const object = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      normalizeCommutativeBoolean(child),
    ]),
  );
  if (
    object.kind !== 'BinaryExpr' ||
    (object.op !== 'AND' && object.op !== 'OR') ||
    object.left === undefined ||
    object.right === undefined
  ) {
    return object;
  }

  const op = object.op;
  const flatten = (node: unknown): unknown[] => {
    if (
      node !== null &&
      typeof node === 'object' &&
      !Array.isArray(node) &&
      (node as Record<string, unknown>).kind === 'BinaryExpr' &&
      (node as Record<string, unknown>).op === op
    ) {
      const binary = node as Record<string, unknown>;
      return [...flatten(binary.left), ...flatten(binary.right)];
    }
    return [node];
  };
  const operands = flatten(object).sort((a, b) => {
    const left = canonicalStringify(a);
    const right = canonicalStringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  let result = operands[0]!;
  for (let index = 1; index < operands.length; index++) {
    result = { kind: 'BinaryExpr', op, left: result, right: operands[index]! };
  }
  return result;
}

/**
 * Semantic equality ignoring spans and original spelling. Used to suppress no-op commits
 * in bidirectional builder/DSL synchronization.
 */
export function astEquals(a: Node, b: Node): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Structural equality including original spelling. This stricter comparison is used by
 * round-trip property P1 to detect printer spelling changes.
 */
export function astStrictEquals(a: Node, b: Node): boolean {
  return canonicalJson(a, { dropRaw: false }) === canonicalJson(b, { dropRaw: false });
}

/**
 * Deterministic binding ID.
 *
 * Random IDs break print/parse equality and card identity. Repeated references to the same
 * event must share an ID so the compiler can reuse one witness CTE.
 */
export function makeBindingId(parts: {
  readonly scope: string | null;
  readonly eventType: string;
  readonly ordinal: string | number;
}): string {
  const scope = parts.scope ?? 'any';
  const ordinal = typeof parts.ordinal === 'number' ? `nth-${parts.ordinal}` : parts.ordinal;
  return `${scope}.${parts.eventType}#${ordinal}`;
}
