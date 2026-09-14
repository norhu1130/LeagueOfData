import {
  astEquals,
  canonicalHash,
  canonicalStringify,
  canonicalize,
  createEnvelope,
  loadEnvelope,
  programSchema,
  serializeEnvelope,
  sha256Hex,
  type RegionDefinitionJson,
  type Program,
} from '@lol/ast';
import { catalog } from '@lol/catalog';
import type { AnalysisDatasetFilters, AnalysisResponse } from '@lol/analysis-client';
import { PRESET_REGIONS_BY_ID, type NormXY, type RegionDefinition } from '@lol/data-model';
import { parse, printDsl } from '@lol/dsl';
import { validatePolygon } from '@lol/map-editor';

const DATABASE = 'leagueofdata';
const STORE = 'documents';
const REGION_STORE = 'regions';
const RESULT_STORE = 'resultCache';
const DOCUMENT_ID = 'current';
const DATABASE_VERSION = 2;
const RESULT_CACHE_VERSION = 1;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface AnalysisResultCacheIdentity {
  /** Canonical hash of the executable AST. */
  readonly queryHash?: string;
  /** Canonical hash of region IDs, coordinate spaces, and geometry. */
  readonly regionsHash?: string;
  /** Semantic catalog hash used to compile the query. */
  readonly catalogHash?: string;
  /** Dataset snapshot used to produce the result. */
  readonly snapshotId?: string | null;
  /** Canonical hash of queue, tier, patch, region, and exclusion filters. */
  readonly datasetFiltersHash?: string;
}

interface CachedAnalysisResult {
  readonly cacheVersion: typeof RESULT_CACHE_VERSION;
  readonly id: string;
  readonly result: AnalysisResponse;
  readonly identity: AnalysisResultCacheIdentity;
  readonly updatedAt: number;
}

export interface StoredAnalysis {
  readonly format: 'loldsl.analysis';
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly dsl: string;
  readonly ast: Program;
  readonly regions: readonly RegionDefinition[];
  /** Dataset slice used by this analysis. Optional for documents saved before filters existed. */
  readonly datasetFilters?: AnalysisDatasetFilters;
  readonly updatedAt: string;
  readonly createdAt?: string;
  readonly syncState?: 'synced' | 'advanced' | 'stale';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      for (const name of ['regions', 'resultCache', 'prefs']) {
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveAnalysis(document: StoredAnalysis): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(toEnvelope(document));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function deleteAnalysis(id: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([STORE, RESULT_STORE], 'readwrite');
    transaction.objectStore(STORE).delete(id);
    transaction.objectStore(RESULT_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function loadAnalysis(id = DOCUMENT_ID): Promise<StoredAnalysis | null> {
  const database = await openDatabase();
  const result = await new Promise<unknown>((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return parseImportedAnalysis(result);
}

export async function listAnalyses(): Promise<StoredAnalysis[]> {
  const database = await openDatabase();
  const result = await new Promise<unknown[]>((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return result
    .map(parseImportedAnalysis)
    .filter((item): item is StoredAnalysis => item !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveRegionDefinition(region: RegionDefinition): Promise<void> {
  if (!isUserRegionDefinition(region))
    throw new Error('유효하지 않거나 예약된 영역은 저장할 수 없습니다.');
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(REGION_STORE, 'readwrite');
    transaction.objectStore(REGION_STORE).put(region);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function deleteRegionDefinition(id: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(REGION_STORE, 'readwrite');
    transaction.objectStore(REGION_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function listRegionDefinitions(): Promise<RegionDefinition[]> {
  const database = await openDatabase();
  const values = await new Promise<unknown[]>((resolve, reject) => {
    const request = database.transaction(REGION_STORE).objectStore(REGION_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return values.filter(isUserRegionDefinition);
}

export async function saveAnalysisResult(
  documentId: string,
  result: AnalysisResponse,
  identity: AnalysisResultCacheIdentity = {},
): Promise<void> {
  const resultSnapshot = result.provenance.dataset.snapshotId;
  if (identity.snapshotId !== undefined && identity.snapshotId !== resultSnapshot)
    throw new Error('Result cache identity does not match the result dataset snapshot.');
  const cacheIdentity = validateCacheIdentity({
    ...identity,
    snapshotId: resultSnapshot,
  });
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(RESULT_STORE, 'readwrite');
    transaction.objectStore(RESULT_STORE).put({
      cacheVersion: RESULT_CACHE_VERSION,
      id: documentId,
      result,
      identity: cacheIdentity,
      updatedAt: Date.now(),
    } satisfies CachedAnalysisResult);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function loadAnalysisResult(
  documentId: string,
  expectedIdentity?: AnalysisResultCacheIdentity,
): Promise<AnalysisResponse | null> {
  const database = await openDatabase();
  const value = await new Promise<unknown>((resolve, reject) => {
    const request = database.transaction(RESULT_STORE).objectStore(RESULT_STORE).get(documentId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return parseCachedAnalysisResult(value, expectedIdentity);
}

/** Build the semantic identity callers should provide when saving and loading a cached result. */
export function analysisResultCacheIdentity(
  ast: Program,
  regions: readonly RegionDefinition[],
  catalogHash: string,
  snapshotId: string | null,
  datasetFilters: Readonly<Record<string, unknown>> = {},
): AnalysisResultCacheIdentity {
  return {
    queryHash: canonicalHash(ast),
    regionsHash: semanticRegionsHash(regions),
    catalogHash,
    snapshotId,
    datasetFiltersHash: 'sha256:' + sha256Hex(canonicalStringify(canonicalize(datasetFilters))),
  };
}

/** Compare every identity field requested by the caller; missing stored fields are never fresh. */
export function isAnalysisResultCacheFresh(
  stored: AnalysisResultCacheIdentity,
  expected: AnalysisResultCacheIdentity,
): boolean {
  return (Object.keys(expected) as (keyof AnalysisResultCacheIdentity)[]).every(
    (key) => expected[key] === undefined || stored[key] === expected[key],
  );
}

/** Parse a versioned cache record. Pre-versioned records are deliberately treated as stale. */
export function parseCachedAnalysisResult(
  value: unknown,
  expectedIdentity?: AnalysisResultCacheIdentity,
): AnalysisResponse | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CachedAnalysisResult>;
  if (
    record.cacheVersion !== RESULT_CACHE_VERSION ||
    typeof record.id !== 'string' ||
    !Number.isFinite(record.updatedAt) ||
    !isAnalysisResponse(record.result)
  )
    return null;
  const identity = parseCacheIdentity(record.identity);
  if (!identity) return null;
  if (identity.snapshotId !== record.result.provenance.dataset.snapshotId) return null;
  if (expectedIdentity) {
    const expected = parseCacheIdentity(expectedIdentity);
    if (!expected || !isAnalysisResultCacheFresh(identity, expected)) return null;
  }
  return record.result;
}

function isAnalysisResponse(value: unknown): value is AnalysisResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AnalysisResponse>;
  return (
    candidate.format === 'loldsl.result' &&
    candidate.version === 1 &&
    typeof candidate.runId === 'string' &&
    !!candidate.result &&
    typeof candidate.result === 'object' &&
    Array.isArray(candidate.result.rows) &&
    !!candidate.provenance?.dataset &&
    (typeof candidate.provenance.dataset.snapshotId === 'string' ||
      candidate.provenance.dataset.snapshotId === null)
  );
}

function parseCacheIdentity(value: unknown): AnalysisResultCacheIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (
    Object.keys(identity).some(
      (key) =>
        !['queryHash', 'regionsHash', 'catalogHash', 'snapshotId', 'datasetFiltersHash'].includes(
          key,
        ),
    )
  )
    return null;
  for (const key of ['queryHash', 'regionsHash', 'catalogHash', 'datasetFiltersHash'] as const) {
    const hash = identity[key];
    if (hash !== undefined && (typeof hash !== 'string' || !HASH_PATTERN.test(hash))) return null;
  }
  if (
    identity.snapshotId !== undefined &&
    identity.snapshotId !== null &&
    typeof identity.snapshotId !== 'string'
  )
    return null;
  return identity as AnalysisResultCacheIdentity;
}

function validateCacheIdentity(value: AnalysisResultCacheIdentity): AnalysisResultCacheIdentity {
  const identity = parseCacheIdentity(value);
  if (!identity) throw new Error('Invalid result cache identity.');
  return identity;
}

export function parseImportedAnalysis(value: unknown): StoredAnalysis | null {
  const loaded = loadEnvelope(value);
  if (loaded.ok) {
    const envelope = loaded.envelope;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(envelope.id)) return null;
    const regionEntries = Object.entries(envelope.regions);
    const regions = regionEntries.map(([, region]) => region);
    if (
      !regionEntries.every(
        ([key, region]) =>
          key === region.id &&
          !PRESET_REGIONS_BY_ID.has(region.id) &&
          isUserRegionDefinition(region),
      )
    )
      return null;
    const storedRegionsHash = envelope.visualState.regionsHash;
    if (
      storedRegionsHash !== undefined &&
      (typeof storedRegionsHash !== 'string' ||
        storedRegionsHash !== semanticRegionsHash(regions as RegionDefinition[]))
    )
      return null;
    const source =
      typeof envelope.visualState.dslSource === 'string'
        ? envelope.visualState.dslSource
        : envelope.dsl;
    const sourceResult = parse(source);
    const sourceValid =
      !!sourceResult.ast && !sourceResult.diagnostics.some((item) => item.severity === 'error');
    const canonicalResult = parse(envelope.dsl);
    const canonicalValid =
      !!canonicalResult.ast &&
      !canonicalResult.diagnostics.some((item) => item.severity === 'error');
    const ast =
      loaded.astHashMatches && canonicalValid && astEquals(canonicalResult.ast!, envelope.ast)
        ? envelope.ast
        : canonicalValid
          ? canonicalResult.ast!
          : sourceValid
            ? sourceResult.ast!
            : null;
    if (!ast) return null;
    const sourceEquivalent = sourceValid && astEquals(sourceResult.ast!, ast);
    const requestedState = envelope.visualState.syncState;
    const syncState = !sourceEquivalent
      ? 'stale'
      : requestedState === 'advanced'
        ? 'advanced'
        : 'synced';
    return {
      format: 'loldsl.analysis',
      version: 1,
      id: envelope.id,
      title: envelope.title,
      dsl: source,
      ast,
      regions: regions as RegionDefinition[],
      datasetFilters: parseDatasetFilters(envelope.dataset?.filters),
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
      syncState,
    };
  }

  // Read the pre-envelope MVP shape so existing local documents can be upgraded on next save.
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const ast = programSchema.safeParse(item.ast);
  if (
    item.format !== 'loldsl.analysis' ||
    item.version !== 1 ||
    typeof item.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ||
    typeof item.title !== 'string' ||
    typeof item.dsl !== 'string' ||
    typeof item.updatedAt !== 'string' ||
    !ast.success ||
    !Array.isArray(item.regions) ||
    !item.regions.every((region) => isUserRegionDefinition(region)) ||
    new Set(item.regions.map((region) => (region as RegionDefinition).id)).size !==
      item.regions.length
  )
    return null;
  const source = parse(item.dsl);
  if (
    !source.ast ||
    source.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ||
    !astEquals(source.ast, ast.data)
  )
    return null;
  return {
    ...(item as unknown as StoredAnalysis),
    ast: ast.data,
    datasetFilters: parseDatasetFilters(item.datasetFilters),
  };
}

function parseDatasetFilters(value: unknown): AnalysisDatasetFilters {
  if (!value || typeof value !== 'object') return { excludeRemakes: true };
  const filters = value as Record<string, unknown>;
  const cleanString = (key: 'patch' | 'queue' | 'tier' | 'region') => {
    const candidate = filters[key];
    return typeof candidate === 'string' && candidate.length <= 100 && candidate.trim()
      ? candidate
      : undefined;
  };
  return {
    ...(cleanString('patch') ? { patch: cleanString('patch') } : {}),
    ...(cleanString('queue') ? { queue: cleanString('queue') } : {}),
    ...(cleanString('tier') ? { tier: cleanString('tier') } : {}),
    ...(cleanString('region') ? { region: cleanString('region') } : {}),
    excludeRemakes: typeof filters.excludeRemakes === 'boolean' ? filters.excludeRemakes : true,
  };
}

export function renameRegionRefs(
  program: Program,
  names: Readonly<Record<string, string>>,
): Program {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    const copy = Object.fromEntries(
      Object.entries(object).map(([key, child]) => [key, visit(child)]),
    );
    if (object.kind === 'RegionRef' && typeof object.name === 'string' && names[object.name])
      copy.name = names[object.name];
    return copy;
  };
  return programSchema.parse(visit(program));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPoint(value: unknown): value is NormXY {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((coordinate) => isFiniteNumber(coordinate) && coordinate >= 0 && coordinate <= 1)
  );
}

function isShape(
  value: unknown,
  depth = 0,
  budget: { vertices: number; parts: number } = { vertices: 0, parts: 0 },
): boolean {
  if (depth > 8) return false;
  if (!value || typeof value !== 'object') return false;
  const shape = value as Record<string, unknown>;
  if (shape.kind === 'polygon') {
    if (!Array.isArray(shape.points) || !shape.points.every(isPoint)) return false;
    budget.vertices += shape.points.length;
    return budget.vertices <= 512 && validatePolygon(shape.points) === null;
  }
  if (shape.kind === 'rect')
    return (
      ['x0', 'y0', 'x1', 'y1'].every(
        (key) =>
          isFiniteNumber(shape[key]) && (shape[key] as number) >= 0 && (shape[key] as number) <= 1,
      ) &&
      shape.x0 !== shape.x1 &&
      shape.y0 !== shape.y1
    );
  if (shape.kind === 'circle')
    return (
      isFiniteNumber(shape.cx) &&
      isFiniteNumber(shape.cy) &&
      isFiniteNumber(shape.r) &&
      shape.cx >= 0 &&
      shape.cx <= 1 &&
      shape.cy >= 0 &&
      shape.cy <= 1 &&
      shape.r > 0 &&
      shape.r <= 2
    );
  if (shape.kind !== 'multi' || !Array.isArray(shape.parts) || shape.parts.length === 0)
    return false;
  budget.parts += shape.parts.length;
  return budget.parts <= 32 && shape.parts.every((part) => isShape(part, depth + 1, budget));
}

function isRegionDefinition(value: unknown): value is RegionDefinition {
  if (!value || typeof value !== 'object') return false;
  const region = value as Record<string, unknown>;
  return (
    typeof region.id === 'string' &&
    region.id.length <= 128 &&
    /^[a-z][a-z0-9_]*$/.test(region.id) &&
    typeof region.label === 'string' &&
    region.label.trim().length > 0 &&
    region.label.length <= 200 &&
    (region.origin === 'preset' || region.origin === 'user') &&
    region.coordSpace === 'norm-v1' &&
    isShape(region.shape)
  );
}

function isUserRegionDefinition(value: unknown): value is RegionDefinition {
  return (
    isRegionDefinition(value) && value.origin === 'user' && !PRESET_REGIONS_BY_ID.has(value.id)
  );
}

export function currentAnalysis(
  title: string,
  dsl: string,
  ast: Program,
  regions: readonly RegionDefinition[],
  id = DOCUMENT_ID,
  syncState: StoredAnalysis['syncState'] = 'synced',
  datasetFilters: AnalysisDatasetFilters = { excludeRemakes: true },
): StoredAnalysis {
  return {
    format: 'loldsl.analysis',
    version: 1,
    id,
    title,
    dsl,
    ast,
    regions,
    datasetFilters,
    syncState,
    updatedAt: new Date().toISOString(),
  };
}

export function serializeAnalysis(document: StoredAnalysis): string {
  return serializeEnvelope(toEnvelope(document));
}

function toEnvelope(document: StoredAnalysis) {
  const regionMap = Object.fromEntries(document.regions.map((region) => [region.id, region]));
  return createEnvelope({
    id: document.id,
    title: document.title,
    dsl: printDsl(document.ast),
    ast: document.ast,
    catalogVersion: catalog.catalogVersion,
    catalogHash: catalog.hash,
    regions: regionMap as unknown as Record<string, RegionDefinitionJson>,
    dataset: { filters: { ...(document.datasetFilters ?? { excludeRemakes: true }) } },
    visualState: {
      dslSource: document.dsl,
      syncState: document.syncState ?? 'synced',
      regionsHash: semanticRegionsHash(document.regions),
    },
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  });
}

function semanticRegionsHash(regions: readonly RegionDefinition[]): string {
  const semanticRegions = Object.fromEntries(
    [...regions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((region) => [region.id, { coordSpace: region.coordSpace, shape: region.shape }]),
  );
  return 'sha256:' + sha256Hex(canonicalStringify(canonicalize(semanticRegions)));
}

export function downloadAnalysis(document: StoredAnalysis): void {
  const blob = new Blob([serializeAnalysis(document)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = `${document.title.replaceAll(/[^\p{L}\p{N}_-]+/gu, '_')}.lolq.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
