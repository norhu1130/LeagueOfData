import type { AnalysisResponse } from '@lol/analysis-client';
import type { RegionDefinition } from '@lol/data-model';
import { parse } from '@lol/dsl';
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './App.js';
import {
  analysisResultCacheIdentity,
  currentAnalysis,
  isAnalysisResultCacheFresh,
  parseCachedAnalysisResult,
  parseImportedAnalysis,
  renameRegionRefs,
  serializeAnalysis,
} from './storage.js';

const CATALOG_HASH = `sha256:${'c'.repeat(64)}`;

function region(
  shape: RegionDefinition['shape'] = {
    kind: 'polygon',
    points: [
      [0.1, 0.1],
      [0.4, 0.1],
      [0.4, 0.4],
      [0.1, 0.4],
    ],
  },
): RegionDefinition {
  return {
    id: 'mine',
    label: 'My region',
    origin: 'user',
    coordSpace: 'norm-v1',
    shape,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function analysisResult(snapshotId = 'snapshot-a'): AnalysisResponse {
  return {
    format: 'loldsl.result',
    version: 1,
    runId: 'run-1',
    result: {
      type: 'scalar',
      columns: ['win_rate', 'n'],
      rows: [{ win_rate: 0.6, n: 100 }],
      measures: [
        {
          id: 'm0',
          alias: 'win_rate',
          labelKo: '승률',
          unit: 'percent',
          decimals: 1,
        },
      ],
      mapPoints: [],
    },
    provenance: {
      grain: 'team',
      grainLabelKo: '팀-경기',
      totalMatches: 100,
      totalUnits: 100,
      matchedMatches: 100,
      matchedUnits: 100,
      denominatorKo: '조건을 만족한 팀-경기',
      conditions: [],
      excluded: [],
      measureCoverage: [],
      dataset: { snapshotId, filters: {}, matchCount: 100 },
      drilldown: { token: 'token', expiresAt: null },
    },
    caveats: [],
    viz: { primary: 'kpi', alternatives: [], reasonKo: 'Test result.' },
    timing: { compileMs: 1, executeMs: 2, cacheHit: false, engineVersion: 'test' },
  };
}

function program() {
  const parsed = parse('ANALYZE blue\nWHEN blue.first_blood\nRETURN blue.win_rate');
  if (!parsed.ast) throw new Error('test fixture failed to parse');
  return parsed.ast;
}

describe('analysis files and onboarding examples', () => {
  it('parses all onboarding examples without errors', () => {
    expect(EXAMPLES).toHaveLength(14);
    for (const example of EXAMPLES) {
      const parsed = parse(example.dsl);
      expect(parsed.ast, example.id).not.toBeNull();
      expect(
        parsed.diagnostics.filter((item) => item.severity === 'error'),
        example.id,
      ).toEqual([]);
    }
    expect(EXAMPLES.find((example) => example.id === 'h')).toMatchObject({
      title: '챔피언 픽·밴·승률 한눈에 보기',
      dsl: expect.stringContaining('pick_rate("Ahri")'),
    });
  });

  it('round-trips a valid analysis file', () => {
    const document = currentAnalysis('테스트', 'dsl', program(), [], 'analysis_1', 'synced', {
      patch: '26.18',
      queue: 'RANKED_SOLO_5x5',
      tier: 'CHALLENGER',
      region: 'KR',
      excludeRemakes: false,
    });
    const restored = parseImportedAnalysis(JSON.parse(serializeAnalysis(document)));
    expect(restored?.title).toBe('테스트');
    expect(restored?.id).toBe('analysis_1');
    expect(restored?.ast).toEqual(document.ast);
    expect(restored?.datasetFilters).toEqual(document.datasetFilters);
  });

  it('preserves an invalid DSL draft as stale without replacing the last valid AST', () => {
    const document = currentAnalysis(
      'Draft',
      'ANALYZE blue WHEN',
      program(),
      [],
      'analysis_stale',
      'stale',
    );
    const restored = parseImportedAnalysis(JSON.parse(serializeAnalysis(document)));
    expect(restored?.dsl).toBe('ANALYZE blue WHEN');
    expect(restored?.syncState).toBe('stale');
    expect(restored?.ast).toEqual(document.ast);
  });

  it('recovers from a corrupted AST by reparsing the canonical DSL', () => {
    const envelope = JSON.parse(
      serializeAnalysis(currentAnalysis('Recovery', 'dsl', program(), [], 'analysis_recovery')),
    ) as Record<string, unknown>;
    envelope.ast = { ...(envelope.ast as Record<string, unknown>), analyze: null };
    const restored = parseImportedAnalysis(envelope);
    expect(restored?.ast.analyze).toMatchObject({ entity: 'team', side: 'blue' });
  });

  it('rejects malformed ASTs and unsafe region shapes', () => {
    const document = currentAnalysis('테스트', 'dsl', program(), []);
    expect(parseImportedAnalysis({ ...document, ast: { kind: 'Program' } })).toBeNull();
    expect(
      parseImportedAnalysis({
        ...document,
        regions: [
          {
            id: 'bad',
            label: '잘못된 영역',
            origin: 'user',
            coordSpace: 'norm-v1',
            shape: { kind: 'polygon', points: [[-1, 2]] },
          },
        ],
      }),
    ).toBeNull();
  });

  it('rejects legacy files whose DSL and AST describe different analyses', () => {
    const document = currentAnalysis('Legacy', 'dsl', program(), [], 'legacy_mismatch');
    expect(
      parseImportedAnalysis({
        ...document,
        dsl: 'ANALYZE red\nWHEN red.first_blood\nRETURN red.win_rate',
      }),
    ).toBeNull();
  });

  it('rejects reserved region IDs and mismatched region record keys', () => {
    const document = currentAnalysis('Import', 'dsl', program(), [region()], 'analysis_regions');
    const reserved = JSON.parse(serializeAnalysis(document)) as Record<string, any>;
    const importedRegion = reserved.regions.mine;
    importedRegion.id = 'top_lane';
    reserved.regions = { top_lane: importedRegion };
    delete reserved.visualState.regionsHash;
    expect(parseImportedAnalysis(reserved)).toBeNull();

    const mismatched = JSON.parse(serializeAnalysis(document)) as Record<string, any>;
    mismatched.regions = { another_key: mismatched.regions.mine };
    delete mismatched.visualState.regionsHash;
    expect(parseImportedAnalysis(mismatched)).toBeNull();
  });

  it('detects changed region geometry and rejects ambiguous polygons', () => {
    const document = currentAnalysis('Import', 'dsl', program(), [region()], 'analysis_geometry');
    const changed = JSON.parse(serializeAnalysis(document)) as Record<string, any>;
    changed.regions.mine.shape.points[1] = [0.45, 0.1];
    expect(parseImportedAnalysis(changed)).toBeNull();

    const crossing = JSON.parse(serializeAnalysis(document)) as Record<string, any>;
    crossing.regions.mine.shape.points = [
      [0.1, 0.1],
      [0.4, 0.4],
      [0.1, 0.4],
      [0.4, 0.1],
    ];
    delete crossing.visualState.regionsHash;
    expect(parseImportedAnalysis(crossing)).toBeNull();
  });

  it('renames AST region references when resolving an import name conflict', () => {
    const parsed = parse(
      'ANALYZE blue WHEN first_blood.position IN region("mine") RETURN blue.win_rate',
    );
    if (!parsed.ast) throw new Error('test fixture failed to parse');
    expect(JSON.stringify(renameRegionRefs(parsed.ast, { mine: 'mine_imported' }))).toContain(
      'mine_imported',
    );
  });
});

describe('analysis result cache identity', () => {
  it('hashes query and region semantics without presentation metadata', () => {
    const first = analysisResultCacheIdentity(program(), [region()], CATALOG_HASH, 'snapshot-a');
    const relabeled = analysisResultCacheIdentity(
      program(),
      [{ ...region(), label: 'Renamed', createdAt: '2026-02-01T00:00:00.000Z' }],
      CATALOG_HASH,
      'snapshot-a',
    );
    const reshaped = analysisResultCacheIdentity(
      program(),
      [region({ kind: 'rect', x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 })],
      CATALOG_HASH,
      'snapshot-a',
    );

    expect(first).toEqual(relabeled);
    expect(first.regionsHash).not.toBe(reshaped.regionsHash);
    expect(first.queryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('separates cached results produced with different dataset filters', () => {
    const solo = analysisResultCacheIdentity(program(), [], CATALOG_HASH, 'snapshot-a', {
      queue: 'RANKED_SOLO_5x5',
      tier: 'GOLD',
    });
    const swiftplay = analysisResultCacheIdentity(program(), [], CATALOG_HASH, 'snapshot-a', {
      queue: 'SWIFTPLAY',
      tier: 'GOLD',
    });
    expect(solo.datasetFiltersHash).not.toBe(swiftplay.datasetFiltersHash);
  });

  it('accepts only versioned cache records with matching semantic identity', () => {
    const result = analysisResult();
    const identity = analysisResultCacheIdentity(program(), [region()], CATALOG_HASH, 'snapshot-a');
    const record = {
      cacheVersion: 1,
      id: 'analysis-1',
      result,
      identity,
      updatedAt: 1,
    };

    expect(parseCachedAnalysisResult(record, identity)).toBe(result);
    expect(parseCachedAnalysisResult(record, { ...identity, snapshotId: 'snapshot-b' })).toBeNull();
    expect(
      parseCachedAnalysisResult(record, { ...identity, catalogHash: `sha256:${'d'.repeat(64)}` }),
    ).toBeNull();
    expect(isAnalysisResultCacheFresh(identity, identity)).toBe(true);
  });

  it('treats legacy, malformed, and internally inconsistent cache records as stale', () => {
    const result = analysisResult();
    expect(parseCachedAnalysisResult({ id: 'legacy', result, updatedAt: 1 })).toBeNull();
    expect(
      parseCachedAnalysisResult({
        cacheVersion: 1,
        id: 'bad-hash',
        result,
        identity: { queryHash: 'not-a-hash', snapshotId: 'snapshot-a' },
        updatedAt: 1,
      }),
    ).toBeNull();
    expect(
      parseCachedAnalysisResult({
        cacheVersion: 1,
        id: 'wrong-snapshot',
        result,
        identity: { snapshotId: 'snapshot-b' },
        updatedAt: 1,
      }),
    ).toBeNull();
  });
});
