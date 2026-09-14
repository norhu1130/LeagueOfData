import type {
  AiInterpretation,
  AnalysisResponse,
  MatchDetail,
  ProgressEvent,
} from '@lol/analysis-client';
import { AnalysisApiError, AnalysisClient } from '@lol/analysis-client';
import { chartAvailability, pickChart, type ChartType } from '@lol/charts';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { routePath, type AppRoute } from '../routes.js';

const ResultChart = lazy(() => import('../ResultChart.js'));
const analysisClient = new AnalysisClient();

type ColorTheme = 'light' | 'dark';

function formatMeasureValue(
  value: unknown,
  unit: AnalysisResponse['result']['measures'][number]['unit'],
  decimals = 1,
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (unit === 'percent') return `${(value * 100).toFixed(decimals)}%`;
  if (unit === 'seconds') {
    const absolute = Math.abs(value);
    return `${value < 0 ? '-' : ''}${Math.floor(absolute / 60)}분 ${Math.round(absolute % 60)}초`;
  }
  const suffix = unit === 'gold' ? ' 골드' : unit === 'count' ? '건' : '';
  return `${value.toLocaleString(undefined, { maximumFractionDigits: decimals })}${suffix}`;
}

export function ResultPane({
  result,
  phase,
  error,
  documentId,
  route,
  navigate,
  datasetSource,
  colorTheme,
  dsl,
  aiEnabled,
  onRefreshRun,
}: {
  result: AnalysisResponse | null;
  phase: ProgressEvent['phase'] | null;
  error: string | null;
  documentId: string;
  route: AppRoute;
  navigate: (route: AppRoute, replace?: boolean) => void;
  datasetSource: string | null;
  colorTheme: ColorTheme;
  dsl: string;
  aiEnabled: boolean;
  onRefreshRun: () => Promise<void>;
}) {
  const [matches, setMatches] = useState<
    Awaited<ReturnType<AnalysisClient['matches']>>['items'] | null
  >(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const attemptedDrilldownRecovery = useRef(false);
  const [detail, setDetail] = useState<MatchDetail | null>(null);
  const recommended = result ? pickChart(result.result) : null;
  const [selectedChart, setSelectedChart] = useState<ChartType | null>(null);
  const [aiInterpretation, setAiInterpretation] = useState<AiInterpretation | null>(null);
  const [aiInterpretationLoading, setAiInterpretationLoading] = useState(false);
  const [aiInterpretationError, setAiInterpretationError] = useState<string | null>(null);
  const requestedPath = routePath(route);
  useEffect(() => {
    setMatches(null);
    setMatchError(null);
    setDetail(null);
    setSelectedChart(result ? pickChart(result.result).primary : null);
    setAiInterpretation(null);
    setAiInterpretationError(null);
  }, [result?.runId]);
  const interpretResult = async () => {
    if (!result) return;
    setAiInterpretationLoading(true);
    setAiInterpretationError(null);
    try {
      setAiInterpretation(await analysisClient.interpret({ dsl, result, datasetSource }));
    } catch (interpretError) {
      setAiInterpretationError(
        interpretError instanceof Error ? interpretError.message : 'AI 해석을 완료하지 못했습니다.',
      );
    } finally {
      setAiInterpretationLoading(false);
    }
  };
  const loadMatches = async () => {
    if (!result) return;
    try {
      setMatches((await analysisClient.matches(result.runId, 0, 20)).items);
      attemptedDrilldownRecovery.current = false;
    } catch (loadError) {
      if (loadError instanceof AnalysisApiError && loadError.status === 404) {
        if (!attemptedDrilldownRecovery.current) {
          attemptedDrilldownRecovery.current = true;
          setMatchError('포함 경기 정보가 만료되어 현재 조건으로 다시 계산하고 있습니다…');
          await onRefreshRun();
          return;
        }
        setMatchError('포함 경기 API가 응답하지 않습니다. 개발 서버를 한 번 재시작해 주세요.');
        return;
      }
      setMatchError(
        loadError instanceof Error ? loadError.message : '경기 목록을 불러오지 못했습니다.',
      );
    }
  };
  const loadMatch = async (matchId: string) => {
    if (!result) return;
    try {
      setDetail(await analysisClient.match(result.runId, matchId));
      attemptedDrilldownRecovery.current = false;
    } catch (loadError) {
      if (loadError instanceof AnalysisApiError && loadError.status === 404) {
        if (!attemptedDrilldownRecovery.current) {
          attemptedDrilldownRecovery.current = true;
          setMatchError('경기 상세 정보가 만료되어 현재 조건으로 다시 계산하고 있습니다…');
          await onRefreshRun();
          return;
        }
        setMatchError('경기 상세 API가 응답하지 않습니다. 개발 서버를 한 번 재시작해 주세요.');
        return;
      }
      setMatchError(
        loadError instanceof Error ? loadError.message : '경기 상세를 불러오지 못했습니다.',
      );
    }
  };
  useEffect(() => {
    if (
      !result ||
      route.kind !== 'analysis' ||
      route.documentId !== documentId ||
      route.view !== 'matches'
    )
      return;
    if (route.matchId) void loadMatch(route.matchId);
    else void loadMatches();
    // Run and route identity are sufficient; the loaders update local view state themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, requestedPath, result?.runId]);
  const row = result?.result.rows[0];
  const definition = result?.result.measures[0];
  const comparison = result?.result.comparison;
  const formatted = comparison
    ? comparison.unit === 'percent'
      ? comparison.differencePoints === null
        ? '비교할 값 없음'
        : `${comparison.differencePoints >= 0 ? '+' : ''}${comparison.differencePoints.toFixed(1)}%p`
      : comparison.difference === null
        ? '비교할 값 없음'
        : `${comparison.difference >= 0 ? '+' : ''}${formatMeasureValue(
            comparison.difference,
            comparison.unit,
            definition?.decimals ?? 1,
          )}`
    : result?.result.type === 'scalar' && result.result.measures.length === 1 && definition && row
      ? formatMeasureValue(row[definition.alias], definition.unit, definition.decimals ?? 1)
      : result
        ? `${result.result.rows.length.toLocaleString()}개 결과`
        : '—';
  const chart = recommended;
  const chartOptions = chart
    ? ([
        ...new Set([chart.primary, ...chart.alternatives, 'bar', 'line', 'heatmap', 'table']),
      ] as ChartType[])
    : [];
  const highlightedEvents = new Set(
    detail?.matchReason.conditions.flatMap((condition) =>
      condition.witnesses.map((witness) => witness.event_id),
    ) ?? [],
  );
  return (
    <aside
      className="result-pane"
      aria-live="polite"
      aria-busy={Boolean(phase && !['completed', 'failed', 'cancelled'].includes(phase))}
    >
      <span className="eyebrow">LIVE RESULT</span>
      {phase && phase !== 'completed' && <p className="run-phase">{phase}</p>}
      {error && <div className="banner banner--stale">{error}</div>}
      {result ? (
        <>
          {datasetSource?.startsWith('synthetic') && (
            <div className="synthetic-notice synthetic-notice--compact">
              <b>합성 데이터 결과</b>
              <span>실제 Riot 경기 통계가 아닙니다.</span>
            </div>
          )}
          <h2>{formatted}</h2>
          <p>
            표본 {result.provenance.matchedUnits.toLocaleString()} {result.provenance.grainLabelKo}
          </p>
          {comparison && (
            <div className="comparison-summary">
              {comparison.groups.map((group) => (
                <p key={group.id}>
                  {group.labelKo}{' '}
                  {formatMeasureValue(group.value, comparison.unit, definition?.decimals ?? 1)} ·{' '}
                  {group.n.toLocaleString()}건
                  {group.defined !== undefined && group.defined !== group.n
                    ? ` 중 측정 가능 ${group.defined.toLocaleString()}건`
                    : ''}
                  {group.confidenceInterval95 && (
                    <small>
                      {' '}
                      (95% {(group.confidenceInterval95.low * 100).toFixed(1)}–
                      {(group.confidenceInterval95.high * 100).toFixed(1)}%)
                    </small>
                  )}
                </p>
              ))}
              <small>두 집단에서 관찰된 차이입니다.</small>
            </div>
          )}
          {!comparison &&
            result.result.type === 'scalar' &&
            result.result.measures.length > 1 &&
            row && (
              <div className="measure-grid">
                {result.result.measures.map((measure) => (
                  <div key={measure.alias}>
                    <small>{measure.labelKo}</small>
                    <b>
                      {formatMeasureValue(row[measure.alias], measure.unit, measure.decimals ?? 1)}
                    </b>
                  </div>
                ))}
              </div>
            )}
          {result.result.type !== 'scalar' && (
            <p className="visually-hidden" aria-label="차트 측정값 요약">
              {result.result.rows
                .flatMap((resultRow) =>
                  result.result.measures.map(
                    (measure) =>
                      `${measure.labelKo} ${formatMeasureValue(
                        resultRow[measure.alias],
                        measure.unit,
                        measure.decimals ?? 1,
                      )}`,
                  ),
                )
                .join(', ')}
            </p>
          )}
          {result.result.baseline && (
            <p className="baseline-summary">
              전체 {(result.result.baseline.value * 100).toFixed(1)}% 대비{' '}
              {result.result.baseline.differencePoints >= 0 ? '+' : ''}
              {result.result.baseline.differencePoints.toFixed(1)}%p (관찰된 차이)
            </p>
          )}
          {result.result.confidenceInterval95 && (
            <p className="confidence-summary">
              95% 신뢰구간 {(result.result.confidenceInterval95.low * 100).toFixed(1)}–
              {(result.result.confidenceInterval95.high * 100).toFixed(1)}%
            </p>
          )}
          {result.provenance.biasAudit && result.provenance.biasAudit.warnings.length > 0 && (
            <section
              className={`result-bias result-bias--${result.provenance.biasAudit.riskLevel}`}
              aria-label="결과 편향 주의사항"
            >
              <div>
                <span className="eyebrow">BIAS REVIEW</span>
                <b>
                  편향 위험{' '}
                  {result.provenance.biasAudit.riskLevel === 'high'
                    ? '높음'
                    : result.provenance.biasAudit.riskLevel === 'medium'
                      ? '주의'
                      : '낮음'}
                </b>
              </div>
              {result.provenance.biasAudit.warnings.map((warning) => (
                <details key={warning.code} open={warning.severity === 'high'}>
                  <summary>{warning.titleKo}</summary>
                  <p>{warning.messageKo}</p>
                  <small>권장 · {warning.mitigationKo}</small>
                </details>
              ))}
              <small>{result.provenance.biasAudit.limitationsKo}</small>
            </section>
          )}
          {aiEnabled && (
            <section className="ai-interpretation" aria-label="AI 결과 해석">
              <div className="ai-interpretation__heading">
                <div>
                  <span className="eyebrow">AI INTERPRETATION</span>
                  <b>관찰 결과와 편향 해석</b>
                </div>
                <button disabled={aiInterpretationLoading} onClick={() => void interpretResult()}>
                  {aiInterpretationLoading
                    ? '해석 중…'
                    : aiInterpretation
                      ? '다시 해석'
                      : 'AI로 해석'}
                </button>
              </div>
              {aiInterpretation && (
                <div className="ai-interpretation__content">
                  <p>{aiInterpretation.summaryKo}</p>
                  {aiInterpretation.findingsKo.map((finding) => (
                    <span key={finding}>• {finding}</span>
                  ))}
                  {aiInterpretation.cautionsKo.map((caution) => (
                    <small key={caution}>주의 · {caution}</small>
                  ))}
                </div>
              )}
              {aiInterpretationError && <small>{aiInterpretationError}</small>}
            </section>
          )}
          {chart && (
            <div className="chart-choice" title={chart.reasonKo}>
              <span>자동 시각화 · {chart.primary}</span>
              <div className="chart-options">
                {chartOptions.map((option) => {
                  const availability = chartAvailability(option, result.result);
                  return (
                    <button
                      key={option}
                      disabled={!availability.enabled}
                      title={availability.reasonKo}
                      aria-pressed={selectedChart === option}
                      onClick={() => setSelectedChart(option)}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {selectedChart === 'table' && <ResultTable result={result.result} />}
          {chart && selectedChart && selectedChart !== 'kpi' && selectedChart !== 'table' && (
            <Suspense fallback={<div className="chart-loading">차트를 불러오는 중…</div>}>
              <ResultChart
                result={result.result}
                chart={selectedChart}
                sampleSize={result.provenance.matchedUnits}
                colorTheme={colorTheme}
              />
            </Suspense>
          )}
          <div className="funnel">
            <b>조건별 표본</b>
            <span>전체 {result.provenance.totalUnits.toLocaleString()}</span>
            {result.provenance.conditions.map((condition) => (
              <span key={condition.id}>
                {condition.labelKo}{' '}
                {(condition.matchedCumulative ?? condition.matchedAlone).toLocaleString()}
              </span>
            ))}
          </div>
          {(result.provenance.measureCoverage.length > 0 ||
            result.provenance.excluded.length > 0) && (
            <section className="coverage-panel" aria-label="측정 범위와 제외 내역">
              <b>측정 범위</b>
              {result.provenance.measureCoverage.map((coverage) => (
                <span key={coverage.measureId}>
                  {coverage.labelKo}: {coverage.defined.toLocaleString()}/
                  {coverage.eligible.toLocaleString()}건 ({(coverage.ratio * 100).toFixed(1)}%)
                </span>
              ))}
              {result.provenance.excluded.map((excluded) => (
                <span key={excluded.reasonKo}>
                  제외 · {excluded.reasonKo}: {excluded.count.toLocaleString()}건
                </span>
              ))}
            </section>
          )}
          <section className="dataset-provenance" aria-label="데이터셋 정보">
            <b>데이터셋</b>
            <span>
              출처{' '}
              {datasetSource?.startsWith('synthetic')
                ? '합성 데이터'
                : datasetSource === 'riot_v5'
                  ? 'Riot API'
                  : (datasetSource ?? '확인되지 않음')}
            </span>
            <span>스냅샷 {result.provenance.dataset.snapshotId ?? '없음'}</span>
            {Object.entries(result.provenance.dataset.filters)
              .filter(([, value]) => value !== null && value !== undefined && value !== '')
              .map(([key, value]) => (
                <span key={key}>
                  {key}: {Array.isArray(value) ? value.join(', ') : String(value)}
                </span>
              ))}
          </section>
          {route.kind === 'analysis' && route.view === 'editor' && (
            <button
              className="matches-button"
              onClick={() => navigate({ kind: 'analysis', documentId, view: 'matches' })}
            >
              포함 경기 보기
            </button>
          )}
          {matchError && <p className="map-warning">{matchError}</p>}
          {matches && (
            <div className="match-list">
              <b>포함 경기 {matches.length}개 미리보기</b>
              {matches.map((match, index) => (
                <button
                  className="match-row"
                  key={`${match.match_id}-${match.team_id ?? index}`}
                  onClick={() =>
                    navigate({
                      kind: 'analysis',
                      documentId,
                      view: 'matches',
                      matchId: match.match_id,
                    })
                  }
                >
                  {match.match_id}
                  {match.team_id ? ` · 팀 ${match.team_id}` : ''}
                  {match.arm ? ` · ${match.arm}` : ''}
                </button>
              ))}
            </div>
          )}
          {detail && (
            <section className="match-detail">
              <div className="match-detail__heading">
                <b>{String(detail.match?.match_id ?? '경기 상세')}</b>
                <button
                  onClick={() => {
                    setDetail(null);
                    navigate({ kind: 'analysis', documentId, view: 'matches' });
                  }}
                >
                  닫기
                </button>
              </div>
              <p>{detail.matchReason.summaryKo}</p>
              <span>
                {Math.round(Number(detail.match?.duration_s ?? 0) / 60)}분 · 선수{' '}
                {detail.participants.length}명 · 사건 {detail.events.length}개
              </span>
              <div className="match-detail__conditions">
                {detail.matchReason.conditions.map((condition) => (
                  <small key={condition.id}>
                    ✓ {condition.labelKo}
                    {condition.witnesses.length > 0
                      ? ` · 근거 사건 ${condition.witnesses.length}개`
                      : ''}
                  </small>
                ))}
              </div>
              <div className="match-timeline" aria-label="경기 사건 타임라인">
                {detail.events.slice(0, 120).map((event) => (
                  <div
                    className={
                      highlightedEvents.has(Number(event.event_id))
                        ? 'timeline-event timeline-event--matched'
                        : 'timeline-event'
                    }
                    key={String(event.event_id)}
                  >
                    <time>
                      {Math.floor(Number(event.timestamp_ms) / 60_000)}:
                      {String(Math.floor((Number(event.timestamp_ms) % 60_000) / 1000)).padStart(
                        2,
                        '0',
                      )}
                    </time>
                    <span>{String(event.event_type)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {result.caveats.map((caveat) => (
            <small key={caveat.code}>{caveat.messageKo}</small>
          ))}
        </>
      ) : (
        <p>카드나 DSL을 편집한 뒤 분석을 실행하세요.</p>
      )}
    </aside>
  );
}

function ResultTable({ result }: { result: AnalysisResponse['result'] }) {
  return (
    <div className="result-table-wrap">
      <table className="result-table">
        <thead>
          <tr>
            {result.columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.slice(0, 100).map((row, index) => (
            <tr key={index}>
              {result.columns.map((column) => (
                <td key={column}>{String(row[column] ?? '—')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
