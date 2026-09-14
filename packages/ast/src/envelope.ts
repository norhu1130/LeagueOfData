/**
 * Analysis serialization envelope (§25, §26).
 *
 * Persist and share the analysis definition, AST, region definitions, and visual state,
 * not computed results. The same analysis must be runnable against new match data.
 *
 * Store both `dsl` and `ast`. DSL source provides a recovery path after AST schema changes.
 */
import { z } from 'zod';
import { canonicalHash } from './canonical.js';
import type { Program } from './nodes.js';
import { programSchema } from './schema.js';

/** Envelope version; increment and register a migration when structure changes. */
export const ENVELOPE_VERSION = 1;
/** AST node schema version; increment when nodes change. */
export const AST_SCHEMA_VERSION = 1;

const normXY = z.tuple([z.number(), z.number()]);

const regionShape: z.ZodType<RegionShapeJson> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('polygon'), points: z.array(normXY).min(3) }),
    z.object({
      kind: z.literal('rect'),
      x0: z.number(),
      y0: z.number(),
      x1: z.number(),
      y1: z.number(),
    }),
    z.object({ kind: z.literal('circle'), cx: z.number(), cy: z.number(), r: z.number() }),
    z.object({ kind: z.literal('multi'), parts: z.array(regionShape).min(1) }),
  ]),
);

export type RegionShapeJson =
  | { kind: 'polygon'; points: [number, number][] }
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'multi'; parts: RegionShapeJson[] };

export const regionDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'DSL에서 쓰는 영역 id는 영문 snake_case여야 합니다'),
  label: z.string().min(1),
  origin: z.enum(['preset', 'user']),
  coordSpace: z.literal('norm-v1'),
  shape: regionShape,
  createdAt: z.string().optional(),
});

export const envelopeSchema = z.object({
  format: z.literal('loldsl.analysis'),
  version: z.literal(ENVELOPE_VERSION),
  astSchemaVersion: z.number().int().positive(),
  catalogVersion: z.string(),
  catalogHash: z.string(),
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** Human-readable source of record; must equal `print(ast)`. */
  dsl: z.string(),
  ast: programSchema,
  /** AST integrity check. */
  astHash: z.string(),
  /**
   * Regions referenced by this analysis. Built-ins are embedded so exports remain portable
   * and reproduce the geometry used when the analysis was saved.
   */
  regions: z.record(z.string(), regionDefinitionSchema).default({}),
  /** Visual-builder-only state; ignored by the compiler. */
  visualState: z.record(z.string(), z.unknown()).default({}),
  dataset: z
    .object({
      snapshotId: z.string().optional(),
      filters: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AnalysisEnvelope = z.infer<typeof envelopeSchema>;
export type RegionDefinitionJson = z.infer<typeof regionDefinitionSchema>;

export interface CreateEnvelopeInput {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly dsl: string;
  readonly ast: Program;
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly regions?: Record<string, RegionDefinitionJson>;
  readonly visualState?: Record<string, unknown>;
  readonly dataset?: { snapshotId?: string; filters?: Record<string, unknown> };
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export function createEnvelope(input: CreateEnvelopeInput): AnalysisEnvelope {
  const now = new Date().toISOString();
  return envelopeSchema.parse({
    format: 'loldsl.analysis',
    version: ENVELOPE_VERSION,
    astSchemaVersion: AST_SCHEMA_VERSION,
    catalogVersion: input.catalogVersion,
    catalogHash: input.catalogHash,
    id: input.id,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    dsl: input.dsl,
    ast: input.ast,
    astHash: canonicalHash(input.ast),
    regions: input.regions ?? {},
    visualState: input.visualState ?? {},
    ...(input.dataset ? { dataset: input.dataset } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  });
}

export type EnvelopeLoadResult =
  | { readonly ok: true; readonly envelope: AnalysisEnvelope; readonly astHashMatches: boolean }
  | { readonly ok: false; readonly errorKo: string; readonly issues: string[] };

/**
 * Loads an envelope. An AST hash mismatch is reported but is not a hard failure because the
 * caller may recover by reparsing the DSL source.
 */
export function loadEnvelope(raw: unknown): EnvelopeLoadResult {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errorKo: '저장된 분석의 형식을 읽을 수 없습니다.',
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(최상위)'}: ${i.message}`),
    };
  }
  const envelope = parsed.data;
  const actual = canonicalHash(envelope.ast);
  return { ok: true, envelope, astHashMatches: actual === envelope.astHash };
}

/** Indented, human-readable JSON for export. */
export function serializeEnvelope(envelope: AnalysisEnvelope): string {
  return JSON.stringify(envelope, null, 2) + '\n';
}
