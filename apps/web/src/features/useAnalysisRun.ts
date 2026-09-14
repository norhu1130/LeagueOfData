import type {
  AnalysisClient,
  AnalysisResponse,
  BiasAudit,
  ProgressEvent,
} from '@lol/analysis-client';
import type { Program } from '@lol/ast';
import type { RegionDefinition } from '@lol/data-model';
import { useCallback, useEffect, useRef, useState } from 'react';
import { analysisResultCacheIdentity, saveAnalysisResult } from '../storage.js';
import { setResultStale } from '../app-preferences.js';

type DatasetFilters = NonNullable<Parameters<AnalysisClient['run']>[0]['dataset']>;

export interface AnalysisRunController {
  readonly runId: string | null;
  readonly runStarting: boolean;
  readonly runPhase: ProgressEvent['phase'] | null;
  readonly result: AnalysisResponse | null;
  readonly runError: string | null;
  readonly biasAudit: BiasAudit | null;
  readonly biasAuditLoading: boolean;
  readonly biasAuditError: string | null;
  readonly execute: (ast?: Program, targetDocumentId?: string) => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly stop: () => void;
  readonly clear: () => void;
  readonly invalidate: () => void;
  readonly reviewBias: (ast?: Program) => Promise<void>;
  readonly restoreResult: (result: AnalysisResponse | null) => void;
  readonly reportError: (message: string) => void;
}

export function useAnalysisRun({
  client,
  ast,
  documentId,
  catalogReady,
  catalogHash,
  datasetFilters,
  regions,
  cacheRegions,
}: {
  client: AnalysisClient;
  ast: Program;
  documentId: string;
  catalogReady: boolean;
  catalogHash: string;
  datasetFilters: DatasetFilters;
  regions: readonly RegionDefinition[];
  cacheRegions: readonly RegionDefinition[];
}): AnalysisRunController {
  const [runId, setRunId] = useState<string | null>(null);
  const [runStarting, setRunStarting] = useState(false);
  const [runPhase, setRunPhase] = useState<ProgressEvent['phase'] | null>(null);
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [biasAudit, setBiasAudit] = useState<BiasAudit | null>(null);
  const [biasAuditLoading, setBiasAuditLoading] = useState(false);
  const [biasAuditError, setBiasAuditError] = useState<string | null>(null);
  const runGeneration = useRef(0);
  const biasReviewGeneration = useRef(0);
  const activeRunId = useRef<string | null>(null);
  const unsubscribeRun = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    runGeneration.current += 1;
    biasReviewGeneration.current += 1;
    unsubscribeRun.current?.();
    unsubscribeRun.current = null;
    const id = activeRunId.current;
    activeRunId.current = null;
    if (id) void client.cancel(id).catch(() => undefined);
    setRunId(null);
    setRunStarting(false);
    setRunPhase(null);
    setBiasAuditLoading(false);
  }, [client]);

  const clear = useCallback(() => {
    stop();
    setResult(null);
    setRunError(null);
    setBiasAudit(null);
    setBiasAuditError(null);
  }, [stop]);

  const invalidate = useCallback(() => {
    clear();
    setResultStale(documentId, true);
  }, [clear, documentId]);

  const reviewBias = useCallback(
    async (targetAst: Program = ast) => {
      if (!catalogReady) return;
      const generation = ++biasReviewGeneration.current;
      setBiasAuditLoading(true);
      setBiasAuditError(null);
      try {
        const regionMap = Object.fromEntries(regions.map((region) => [region.id, region]));
        const audit = await client.biasAudit({
          ast: targetAst,
          regions: regionMap,
          catalogHash,
          dataset: datasetFilters,
        });
        if (generation === biasReviewGeneration.current) setBiasAudit(audit);
      } catch (error) {
        if (generation === biasReviewGeneration.current)
          setBiasAuditError(
            error instanceof Error ? error.message : '편향 검토를 완료하지 못했습니다.',
          );
      } finally {
        if (generation === biasReviewGeneration.current) setBiasAuditLoading(false);
      }
    },
    [ast, catalogHash, catalogReady, client, datasetFilters, regions],
  );

  const execute = useCallback(
    async (targetAst: Program = ast, targetDocumentId = documentId) => {
      if (!catalogReady) {
        setRunError('데이터 카탈로그를 불러오는 중입니다. 잠시 후 다시 실행해 주세요.');
        return;
      }
      const generation = ++runGeneration.current;
      unsubscribeRun.current?.();
      unsubscribeRun.current = null;
      const previousRun = activeRunId.current;
      activeRunId.current = null;
      if (previousRun) void client.cancel(previousRun).catch(() => undefined);
      setRunError(null);
      setResult(null);
      setBiasAudit(null);
      setBiasAuditError(null);
      setRunStarting(true);
      setRunId(null);
      setRunPhase('compiling');
      void reviewBias(targetAst);
      try {
        const regionMap = Object.fromEntries(regions.map((region) => [region.id, region]));
        const id = await client.run({
          ast: targetAst,
          regions: regionMap,
          catalogHash,
          dataset: datasetFilters,
        });
        if (generation !== runGeneration.current) {
          void client.cancel(id).catch(() => undefined);
          return;
        }
        setRunStarting(false);
        activeRunId.current = id;
        setRunId(id);
        unsubscribeRun.current = client.subscribe(
          id,
          (event) => {
            if (generation !== runGeneration.current || activeRunId.current !== id) return;
            setRunPhase(event.phase);
            if (event.result) {
              setResult(event.result);
              setResultStale(targetDocumentId, false);
              void saveAnalysisResult(
                targetDocumentId,
                event.result,
                analysisResultCacheIdentity(
                  targetAst,
                  cacheRegions,
                  catalogHash,
                  event.result.provenance.dataset.snapshotId,
                  { ...datasetFilters },
                ),
              ).catch(() => undefined);
            }
            if (event.diagnostic) setRunError(event.diagnostic.bodyKo);
            if (['completed', 'failed', 'cancelled'].includes(event.phase)) {
              activeRunId.current = null;
              setRunId(null);
              unsubscribeRun.current = null;
            }
          },
          {
            onError: () => {
              if (generation !== runGeneration.current || activeRunId.current !== id) return;
              activeRunId.current = null;
              setRunId(null);
              setRunPhase('failed');
              setRunError('분석 진행 연결이 끊겼습니다. 다시 실행해 주세요.');
              unsubscribeRun.current = null;
            },
          },
        );
      } catch (error) {
        if (generation !== runGeneration.current) return;
        setRunStarting(false);
        setRunPhase('failed');
        setRunError(error instanceof Error ? error.message : '분석을 시작하지 못했습니다');
      }
    },
    [
      ast,
      cacheRegions,
      catalogHash,
      catalogReady,
      client,
      datasetFilters,
      documentId,
      regions,
      reviewBias,
    ],
  );

  const cancel = useCallback(async () => {
    const id = activeRunId.current;
    if (!id) return;
    try {
      await client.cancel(id);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : '분석을 취소하지 못했습니다.');
    }
  }, [client]);

  useEffect(
    () => () => {
      runGeneration.current += 1;
      biasReviewGeneration.current += 1;
      unsubscribeRun.current?.();
    },
    [],
  );

  return {
    runId,
    runStarting,
    runPhase,
    result,
    runError,
    biasAudit,
    biasAuditLoading,
    biasAuditError,
    execute,
    cancel,
    stop,
    clear,
    invalidate,
    reviewBias,
    restoreResult: setResult,
    reportError: setRunError,
  };
}
