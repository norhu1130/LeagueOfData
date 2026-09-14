import { describe, it, expect } from 'vitest';
import {
  astEquals,
  astStrictEquals,
  canonicalHash,
  canonicalJson,
  canonicalize,
  canonicalStringify,
  makeBindingId,
  normalizeExpr,
  sha256Hex,
  type Expr,
  type Program,
} from '../src/index.js';

describe('browser-compatible SHA-256', () => {
  it('matches the standard vector', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

const program = (when: Expr | null): Program => ({
  kind: 'Program',
  analyze: null,
  body: {
    kind: 'SimpleStmt',
    chain: null,
    when,
    groupBy: [],
    returns: [
      {
        kind: 'ReturnItem',
        expr: { kind: 'CallExpr', callee: 'win_rate', scope: null, args: [] },
        alias: null,
      },
    ],
  },
});

const num = (value: number): Expr => ({ kind: 'NumberLit', value });

describe('canonicalization rules', () => {
  it('R1: removes spans', () => {
    // Whitespace differences must not produce different cache entries.
    const a = program({ kind: 'NumberLit', value: 1, span: [0, 1] });
    const b = program({ kind: 'NumberLit', value: 1, span: [50, 51] });
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('R2: excludes raw spelling from hashes', () => {
    // `90s` and `1m30s` are equivalent and must share a cache entry.
    const a = program({ kind: 'DurationLit', seconds: 90, raw: '90s' });
    const b = program({ kind: 'DurationLit', seconds: 90, raw: '1m30s' });
    expect(canonicalHash(a)).toBe(canonicalHash(b));
    // Structural comparison still includes spelling.
    expect(astStrictEquals(a, b)).toBe(false);
    expect(astEquals(a, b)).toBe(true);
  });

  it('R3: treats undefined and absent keys equally', () => {
    expect(canonicalStringify(canonicalize({ a: 1, b: undefined }))).toBe(
      canonicalStringify(canonicalize({ a: 1 })),
    );
  });

  it('R4: is independent of key order', () => {
    expect(canonicalStringify(canonicalize({ b: 1, a: 2 }))).toBe(
      canonicalStringify(canonicalize({ a: 2, b: 1 })),
    );
  });

  it('R5: folds integral floats into integers', () => {
    // JavaScript emits `1` while Python normally emits `1.0`; folding keeps hashes equal.
    expect(canonicalStringify(canonicalize(1.0))).toBe('1');
    expect(canonicalStringify(canonicalize(1))).toBe('1');
    expect(canonicalStringify(canonicalize(1.5))).toBe('1.5');
    expect(canonicalStringify(canonicalize(-0))).toBe('0');
  });

  it('R6: preserves array order', () => {
    // Preserve user order because the printer does not reorder `A AND B`.
    expect(canonicalStringify(canonicalize([1, 2]))).not.toBe(
      canonicalStringify(canonicalize([2, 1])),
    );
  });

  it('uses a stable hash format', () => {
    expect(canonicalHash(program(null))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces the same hash for the same content', () => {
    expect(canonicalHash(program(num(1)))).toBe(canonicalHash(program(num(1))));
    expect(canonicalHash(program(num(1)))).not.toBe(canonicalHash(program(num(2))));
  });

  it('hashes commutative boolean operands independently of order', () => {
    const a = num(1);
    const b = num(2);
    const left = program({ kind: 'BinaryExpr', op: 'AND', left: a, right: b });
    const right = program({ kind: 'BinaryExpr', op: 'AND', left: b, right: a });
    expect(canonicalHash(left)).toBe(canonicalHash(right));
    expect(canonicalJson(left)).not.toBe(canonicalJson(right));
  });

  it('rejects numbers outside the cross-language canonical range', () => {
    expect(() => canonicalize(1e-7)).toThrow(/canonical range/);
    expect(() => canonicalize(1e21)).toThrow(/canonical range/);
    expect(canonicalStringify(canonicalize(1e-6))).toBe('0.000001');
  });
});

describe('canonical shape enforcement', () => {
  const ev = (negated: boolean): Expr => ({
    kind: 'EventPredicate',
    negated,
    event: {
      kind: 'EventRef',
      bindingId: 'any.first_blood#any',
      scope: null,
      eventType: 'first_blood',
      ordinal: 'any',
      surface: 'first_blood',
    },
  });

  it('folds negated event predicates into one shape', () => {
    const wrapped: Expr = { kind: 'UnaryExpr', op: 'NOT', operand: ev(false) };
    expect(normalizeExpr(wrapped)).toEqual(ev(true));
  });

  it('eliminates double negation', () => {
    const doubled: Expr = {
      kind: 'UnaryExpr',
      op: 'NOT',
      operand: { kind: 'UnaryExpr', op: 'NOT', operand: ev(false) },
    };
    expect(normalizeExpr(doubled)).toEqual(ev(false));
  });

  it('folds unary minus into numeric literals', () => {
    const negated: Expr = { kind: 'UnaryExpr', op: '-', operand: num(5) };
    expect(normalizeExpr(negated)).toEqual({ kind: 'NumberLit', value: -5 });
  });

  it('left-associates AND chains while preserving order', () => {
    const a = num(1),
      b = num(2),
      c = num(3);
    const rightLeaning: Expr = {
      kind: 'BinaryExpr',
      op: 'AND',
      left: a,
      right: { kind: 'BinaryExpr', op: 'AND', left: b, right: c },
    };
    const leftLeaning: Expr = {
      kind: 'BinaryExpr',
      op: 'AND',
      left: { kind: 'BinaryExpr', op: 'AND', left: a, right: b },
      right: c,
    };
    expect(canonicalStringify(canonicalize(normalizeExpr(rightLeaning)))).toBe(
      canonicalStringify(canonicalize(normalizeExpr(leftLeaning))),
    );
  });

  it('does not merge chains of different operators', () => {
    // Absorbing OR into the AND chain would change the meaning of `(a OR b) AND c`.
    const mixed: Expr = {
      kind: 'BinaryExpr',
      op: 'AND',
      left: { kind: 'BinaryExpr', op: 'OR', left: num(1), right: num(2) },
      right: num(3),
    };
    const result = normalizeExpr(mixed);
    expect(result.kind).toBe('BinaryExpr');
    if (result.kind === 'BinaryExpr') {
      expect(result.op).toBe('AND');
      expect(result.left.kind).toBe('BinaryExpr');
      if (result.left.kind === 'BinaryExpr') expect(result.left.op).toBe('OR');
    }
  });
});

describe('binding IDs', () => {
  it('derives identifiers deterministically from content', () => {
    const id = makeBindingId({ scope: 'blue', eventType: 'first_blood', ordinal: 'any' });
    expect(id).toBe('blue.first_blood#any');
    expect(makeBindingId({ scope: null, eventType: 'kill', ordinal: 'first' })).toBe(
      'any.kill#first',
    );
  });
});
