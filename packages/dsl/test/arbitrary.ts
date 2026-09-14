/**
 * Arbitrary AST generator.
 *
 * Example tests are insufficient for language round trips. This generator selects real catalog
 * entries, builds only type-correct trees, and verifies P1 and P2 over them.
 */
import fc from 'fast-check';
import { makeBindingId, normalizeProgram, type Expr, type Program, type ScopeRef } from '@lol/ast';
import { catalog, listEvents } from '@lol/catalog';

const EVENT_IDS = listEvents()
  .filter((e) => e.context.includes('time'))
  .map((e) => e.id);

const POSITIONAL_EVENT_IDS = listEvents()
  .filter((e) => e.context.includes('position'))
  .map((e) => e.id);

const AGGREGATES = Object.values(catalog.functions)
  .filter((f) => f.kind === 'aggregate' && f.params.length === 0)
  .map((f) => f.id);

const FRAME_MEASURES = Object.values(catalog.functions)
  .filter((f) => f.kind === 'frame-measure')
  .map((f) => f.id);

const REGION_IDS = ['top_lane', 'mid_lane', 'bot_lane', 'river', 'custom_region_1'];

const teamScope = (side: 'blue' | 'red'): ScopeRef => ({ kind: 'ScopeRef', entity: 'team', side });

const scopeArb: fc.Arbitrary<ScopeRef | null> = fc.oneof(
  fc.constant(null),
  fc.constantFrom<'blue' | 'red'>('blue', 'red').map(teamScope),
);

/** Seconds and corresponding spelling, which must agree because the printer preserves `raw`. */
const durationArb = fc
  .constantFrom(30, 60, 90, 120, 300, 600)
  .map((seconds) => ({ kind: 'DurationLit' as const, seconds, raw: `${seconds}s` }));

const clockArb = fc.constantFrom(5, 10, 15, 20).map((minutes) => ({
  kind: 'ClockLit' as const,
  seconds: minutes * 60,
  raw: `${minutes}:00`,
}));

function eventRefArb(ids: readonly string[]): fc.Arbitrary<Expr> {
  return fc.tuple(fc.constantFrom(...ids), scopeArb).map(([eventType, scope]) => ({
    kind: 'EventRef' as const,
    bindingId: makeBindingId({
      scope: scope ? (scope.side ?? scope.entity) : null,
      eventType,
      ordinal: 'any',
    }),
    scope,
    eventType,
    ordinal: 'any' as const,
    surface: eventType,
  }));
}

const eventPredicateArb: fc.Arbitrary<Expr> = fc
  .tuple(eventRefArb(EVENT_IDS), fc.boolean())
  .map(([event, negated]) => ({
    kind: 'EventPredicate' as const,
    event: event as Extract<Expr, { kind: 'EventRef' }>,
    negated,
  }));

/** Time comparison such as `first_blood.time < 600s`. */
const timeComparisonArb: fc.Arbitrary<Expr> = fc
  .tuple(
    eventRefArb(EVENT_IDS),
    fc.constantFrom('<', '>', '<=', '>=') as fc.Arbitrary<'<' | '>' | '<=' | '>='>,
    durationArb,
  )
  .map(([event, op, duration]) => ({
    kind: 'BinaryExpr' as const,
    op,
    left: {
      kind: 'FieldAccess' as const,
      object: event,
      field: 'time',
    },
    right: duration,
  }));

/** `first_blood.position IN region("top_lane")` */
const spatialArb: fc.Arbitrary<Expr> = fc
  .tuple(eventRefArb(POSITIONAL_EVENT_IDS), fc.constantFrom(...REGION_IDS))
  .map(([event, region]) => ({
    kind: 'SpatialPredicate' as const,
    relation: 'IN_REGION' as const,
    position: {
      kind: 'FieldAccess' as const,
      object: event,
      field: 'position',
    },
    target: { kind: 'RegionRef' as const, name: region },
    radius: null,
  }));

/** `blue.gold_diff(10:00) >= 1500` */
const measureArb: fc.Arbitrary<Expr> = fc
  .tuple(
    fc.constantFrom(...FRAME_MEASURES),
    scopeArb,
    clockArb,
    fc.constantFrom('>=', '<=', '>', '<') as fc.Arbitrary<'>=' | '<=' | '>' | '<'>,
    fc.integer({ min: -5000, max: 5000 }),
  )
  .map(([measure, scope, at, op, value]) => ({
    kind: 'BinaryExpr' as const,
    op,
    left: { kind: 'MeasureAt' as const, measure, scope, at },
    right: { kind: 'NumberLit' as const, value },
  }));

const membershipArb: fc.Arbitrary<Expr> = fc
  .uniqueArray(fc.constantFrom('TOP', 'JUNGLE', 'MID', 'BOTTOM', 'UTILITY'), {
    minLength: 1,
    maxLength: 4,
  })
  .map((roles) => ({
    kind: 'InExpr' as const,
    value: {
      kind: 'FieldAccess' as const,
      object: { kind: 'Identifier' as const, name: 'player' },
      field: 'role',
    },
    set: roles.map((value) => ({ kind: 'StringLit' as const, value })),
    negated: false,
  }));

const atomArb: fc.Arbitrary<Expr> = fc.oneof(
  { weight: 3, arbitrary: eventPredicateArb },
  { weight: 2, arbitrary: timeComparisonArb },
  { weight: 2, arbitrary: spatialArb },
  { weight: 2, arbitrary: measureArb },
  { weight: 1, arbitrary: membershipArb },
);

/** Boolean tree with bounded depth to prevent runaway generation. */
const conditionArb: fc.Arbitrary<Expr> = fc.letrec<{ expr: Expr }>((tie) => ({
  expr: fc.oneof(
    { weight: 5, arbitrary: atomArb },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.constantFrom('AND', 'OR') as fc.Arbitrary<'AND' | 'OR'>, tie('expr'), tie('expr'))
        .map(([op, left, right]) => ({ kind: 'BinaryExpr' as const, op, left, right })),
    },
    {
      weight: 1,
      arbitrary: tie('expr').map((operand) => ({
        kind: 'UnaryExpr' as const,
        op: 'NOT' as const,
        operand,
      })),
    },
  ),
})).expr;

const returnItemArb = fc
  .tuple(
    fc.constantFrom(...AGGREGATES),
    scopeArb,
    fc.option(fc.constantFrom('wr', 'n', 'value'), { nil: null }),
  )
  .map(([callee, scope, alias]) => ({
    kind: 'ReturnItem' as const,
    expr: { kind: 'CallExpr' as const, callee, scope, args: [] },
    alias,
  }));

const groupKeyArb = fc.constantFrom(...Object.keys(catalog.groupKeys)).map((id) => ({
  kind: 'GroupKey' as const,
  expr: { kind: 'Identifier' as const, name: id },
  alias: null,
}));

export const programArb: fc.Arbitrary<Program> = fc
  .tuple(
    fc.option(fc.constantFrom<'blue' | 'red'>('blue', 'red').map(teamScope), { nil: null }),
    fc.option(conditionArb, { nil: null }),
    fc.array(groupKeyArb, { maxLength: 2 }),
    fc.array(returnItemArb, { minLength: 1, maxLength: 3 }),
  )
  .map(([analyze, when, groupBy, returns]) =>
    // Normalize generated trees so round-trip failures cannot be caused by unreachable shapes.
    normalizeProgram({
      kind: 'Program' as const,
      analyze,
      body: { kind: 'SimpleStmt' as const, chain: null, when, groupBy, returns },
    }),
  );
