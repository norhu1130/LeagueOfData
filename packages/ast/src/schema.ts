/**
 * Runtime schema for ASTs crossing persistence and process boundaries.
 *
 * TypeScript types disappear after compilation. Values from storage, workers, and API
 * requests must pass this schema before they are treated as a `Program`.
 */
import { z } from 'zod';
import type { Expr, Program } from './nodes.js';

const span = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional();
const base = { span };
const identifierName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const canonicalNumber = z
  .number()
  .finite()
  .refine((value) => value === 0 || (Math.abs(value) >= 1e-6 && Math.abs(value) < 1e21), {
    message: 'Number is outside the cross-language canonical range',
  });
const canonicalNonnegativeNumber = z
  .number()
  .finite()
  .nonnegative()
  .refine((value) => value === 0 || (value >= 1e-6 && value < 1e21), {
    message: 'Number is outside the cross-language canonical range',
  });

function durationSeconds(raw: string): number | null {
  const match = raw.match(
    /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/,
  );
  if (!match || match.slice(1).every((part) => part === undefined)) return null;
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0) +
    Number(match[4] ?? 0) / 1000
  );
}

function clockSeconds(raw: string): number | null {
  const match = raw.match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return null;
  return match[3] === undefined
    ? Number(match[1]) * 60 + Number(match[2])
    : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

const secondsMatch = (actual: number, expected: number | null) =>
  expected !== null && Math.abs(actual - expected) <= Number.EPSILON * Math.max(1, actual);

export const scopeRefSchema = z
  .object({
    ...base,
    kind: z.literal('ScopeRef'),
    entity: z.enum(['match', 'team', 'player']),
    side: z.enum(['blue', 'red']).optional(),
    relation: z.literal('opponent-of-trigger').optional(),
    selector: z.string().optional(),
  })
  .strict();

const ordinalSchema = z.union([
  z.enum(['first', 'last', 'any']),
  z.number().int().positive().max(255),
]);

export const eventRefSchema = z
  .object({
    ...base,
    kind: z.literal('EventRef'),
    bindingId: z.string().min(1),
    scope: scopeRefSchema.nullable(),
    eventType: identifierName,
    ordinal: ordinalSchema,
    surface: identifierName,
  })
  .strict();

const numberLitSchema = z
  .object({ ...base, kind: z.literal('NumberLit'), value: canonicalNumber })
  .strict();
const stringLitSchema = z
  .object({ ...base, kind: z.literal('StringLit'), value: z.string() })
  .strict();
const boolLitSchema = z
  .object({ ...base, kind: z.literal('BoolLit'), value: z.boolean() })
  .strict();
const nullLitSchema = z.object({ ...base, kind: z.literal('NullLit') }).strict();
const durationLitSchema = z
  .object({
    ...base,
    kind: z.literal('DurationLit'),
    seconds: canonicalNonnegativeNumber,
    raw: z
      .string()
      .min(1)
      .regex(
        /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/,
      ),
  })
  .strict();
const clockLitSchema = z
  .object({
    ...base,
    kind: z.literal('ClockLit'),
    seconds: canonicalNonnegativeNumber,
    raw: z.string().regex(/^\d+:[0-5]\d(?::[0-5]\d)?$/),
  })
  .strict();
const identifierSchema = z
  .object({ ...base, kind: z.literal('Identifier'), name: identifierName })
  .strict();
const regionRefSchema = z
  .object({ ...base, kind: z.literal('RegionRef'), name: z.string().min(1) })
  .strict();
const errorExprSchema = z
  .object({
    ...base,
    kind: z.literal('ErrorExpr'),
    rawText: z.string(),
    diagnosticCode: z.string().min(1),
  })
  .strict();

export const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    numberLitSchema,
    stringLitSchema,
    boolLitSchema,
    nullLitSchema,
    durationLitSchema,
    clockLitSchema,
    identifierSchema,
    eventRefSchema,
    z
      .object({
        ...base,
        kind: z.literal('EventPredicate'),
        event: eventRefSchema,
        negated: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal('FieldAccess'),
        object: exprSchema,
        field: identifierName,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal('CallExpr'),
        callee: identifierName,
        scope: scopeRefSchema.nullable(),
        args: z.array(exprSchema),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal('MeasureAt'),
        measure: z.string().min(1),
        scope: scopeRefSchema.nullable(),
        at: z.union([clockLitSchema, durationLitSchema]),
      })
      .strict(),
    regionRefSchema,
    z
      .object({
        ...base,
        kind: z.literal('BinaryExpr'),
        op: z.enum(['AND', 'OR', '=', '!=', '>', '>=', '<', '<=', '+', '-', '*', '/', '%']),
        left: exprSchema,
        right: exprSchema,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal('UnaryExpr'),
        op: z.enum(['NOT', '-']),
        operand: exprSchema,
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal('InExpr'),
        value: exprSchema,
        set: z.array(exprSchema).min(1),
        negated: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal('SpatialPredicate'),
        relation: z.enum(['IN_REGION', 'WITHIN_RADIUS', 'NEAR']),
        position: exprSchema,
        target: exprSchema,
        radius: numberLitSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal('TemporalPredicate'),
        relation: z.enum(['BEFORE', 'AFTER', 'WITHIN', 'UNTIL', 'DURING', 'BETWEEN', 'AT']),
        left: exprSchema,
        right: exprSchema.nullable(),
        rightUpper: exprSchema.nullable(),
        window: durationLitSchema.nullable(),
      })
      .strict(),
    errorExprSchema,
  ]),
);

const groupKeySchema = z
  .object({
    ...base,
    kind: z.literal('GroupKey'),
    expr: exprSchema,
    alias: identifierName.nullable(),
  })
  .strict();
const returnItemSchema = z
  .object({
    ...base,
    kind: z.literal('ReturnItem'),
    expr: exprSchema,
    alias: identifierName.nullable(),
  })
  .strict();
const chainClauseSchema = z
  .object({
    ...base,
    kind: z.literal('ChainClause'),
    trigger: eventRefSchema,
    window: durationLitSchema.nullable(),
    condition: exprSchema.nullable(),
  })
  .strict();
const compareArmSchema = z
  .object({
    ...base,
    kind: z.literal('CompareArm'),
    label: identifierName.nullable(),
    when: exprSchema,
  })
  .strict();
const simpleStmtSchema = z
  .object({
    ...base,
    kind: z.literal('SimpleStmt'),
    chain: chainClauseSchema.nullable(),
    when: exprSchema.nullable(),
    groupBy: z.array(groupKeySchema),
    // Parser recovery may leave this empty; semantic validation reports completeness.
    returns: z.array(returnItemSchema),
  })
  .strict();
const compareStmtSchema = z
  .object({
    ...base,
    kind: z.literal('CompareStmt'),
    // A partial AST while typing `COMPARE WHEN ...` must still cross worker boundaries.
    arms: z.array(compareArmSchema),
    groupBy: z.array(groupKeySchema),
    returns: z.array(returnItemSchema),
  })
  .strict();

const programObjectSchema = z
  .object({
    ...base,
    kind: z.literal('Program'),
    analyze: scopeRefSchema.nullable(),
    body: z.discriminatedUnion('kind', [simpleStmtSchema, compareStmtSchema]),
  })
  .strict();

export const programSchema: z.ZodType<Program> = programObjectSchema.superRefine((program, ctx) => {
  const visit = (value: unknown, path: (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...path, index]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (
      node.kind === 'DurationLit' &&
      !secondsMatch(node.seconds as number, durationSeconds(node.raw as string))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: 'Duration spelling does not match its numeric value',
      });
    }
    if (
      node.kind === 'ClockLit' &&
      !secondsMatch(node.seconds as number, clockSeconds(node.raw as string))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: 'Clock spelling does not match its numeric value',
      });
    }
    if (node.kind === 'SpatialPredicate') {
      const relation = node.relation as string;
      const hasRadius = node.radius !== null;
      const hasRegionTarget =
        node.target !== null &&
        typeof node.target === 'object' &&
        (node.target as Record<string, unknown>).kind === 'RegionRef';
      if (
        (relation === 'WITHIN_RADIUS') !== hasRadius ||
        (relation === 'IN_REGION' && !hasRegionTarget)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: 'Spatial relation and radius do not form a printable DSL expression',
        });
      }
    }
    if (node.kind === 'TemporalPredicate') {
      const relation = node.relation as string;
      const hasRight = node.right !== null;
      const hasUpper = node.rightUpper !== null;
      const hasWindow = node.window !== null;
      const valid =
        (relation === 'BETWEEN' && hasRight && hasUpper && !hasWindow) ||
        (relation === 'WITHIN' && !hasRight && !hasUpper && hasWindow) ||
        ((relation === 'BEFORE' || relation === 'AFTER') && hasRight && !hasUpper) ||
        ((relation === 'UNTIL' || relation === 'DURING' || relation === 'AT') &&
          hasRight &&
          !hasUpper &&
          !hasWindow);
      if (!valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: 'Temporal relation operands do not form a printable DSL expression',
        });
      }
    }
    for (const [key, child] of Object.entries(node)) visit(child, [...path, key]);
  };
  visit(program, []);
});

export function parseProgram(value: unknown): Program {
  return programSchema.parse(value);
}

export function safeParseProgram(value: unknown) {
  return programSchema.safeParse(value);
}
