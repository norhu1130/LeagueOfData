import type { EventRef, Ordinal } from '@lol/ast';
import type { AiStatus, AnalysisResponse, BiasAudit, EffectiveCatalog } from '@lol/analysis-client';
import { listGroupKeys, type EventDef } from '@lol/catalog';
import type { RegionDefinition } from '@lol/data-model';
import { project, type AstPath, type SyncDocument } from '@lol/visual-builder';
import { validate, type CounterItemSelection } from '@lol/validate';
import { useEffect, useRef, useState } from 'react';
import { MapPanel } from '../MapPanel.js';
import type { EventScopeChoice, ItemResponseDraft } from '../features/analysis-dsl.js';
import type { RosterRelation } from '../features/roster-analysis.js';
import { AnalysisTitleInput, type ItemOption } from './AnalysisInputs.js';
import { CardLibrary } from './CardLibrary.js';
import { CardView } from './CardView.js';
import { occurrenceNumber } from './EventConditionEditors.js';

type EditorMode = 'builder' | 'dsl' | 'split';
type Projection = ReturnType<typeof project>;
type SemanticDiagnostics = ReturnType<typeof validate>['diagnostics'];
type GroupOption = ReturnType<typeof listGroupKeys>[number];

interface ChampionAnalysisSelection {
  champion: string;
  role: string;
  relation: RosterRelation | 'none';
  relatedChampion: string;
  relatedRole: string;
}

interface AnalysisBuilderPaneProps {
  title: string;
  sync: SyncDocument;
  projection: Projection;
  firstResultCardIndex: number;
  mode: EditorMode;
  catalogReady: boolean;
  effectiveCatalog: EffectiveCatalog | null;
  events: readonly EventDef[];
  items: readonly ItemOption[];
  regions: readonly RegionDefinition[];
  customRegions: readonly RegionDefinition[];
  activeRegionId: string | null;
  activeExampleId: string | null;
  resultMapPoints: AnalysisResponse['result']['mapPoints'] | undefined;
  biasAudit: BiasAudit | null;
  biasAuditLoading: boolean;
  biasAuditError: string | null;
  aiStatus: AiStatus | null;
  hasSemanticErrors: boolean;
  semanticDiagnostics: SemanticDiagnostics;
  unconditional: boolean;
  comparisonActionVisible: boolean;
  groupingDisabledReason: string | null;
  dragonTypeGroupAvailable: boolean;
  numberedDragon: EventRef | null;
  availableGroupKeys: readonly GroupOption[];
  datasetPatch: string;
  datasetQueue: string;
  datasetTier: string;
  datasetRegion: string;
  excludeRemakes: boolean;
  onTitleChange: (title: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onReviewBias: () => void;
  onOpenAi: () => void;
  onMakeComparison: () => void;
  onAddDragonTypeGroup: () => void;
  onAddGroupKey: (id: string) => void;
  onDatasetPatchChange: (patch: string) => void;
  onDatasetQueueChange: (queue: string) => void;
  onDatasetTierChange: (tier: string) => void;
  onDatasetRegionChange: (region: string) => void;
  onExcludeRemakesChange: (exclude: boolean) => void;
  onAddCondition: (source: string) => void;
  onCreateItemResponse: (selection: ItemResponseDraft) => void;
  onCreateCounterItem: (selection: CounterItemSelection) => void;
  onCreateChampionAnalysis: (selection: ChampionAnalysisSelection) => void;
  onAddSequence: (
    startEvent?: string,
    endEvent?: string,
    seconds?: number,
    startScope?: EventScopeChoice,
    endScope?: EventScopeChoice,
    startOrdinal?: Ordinal,
    endOrdinal?: Ordinal,
    endRoles?: readonly string[],
    endRoleMode?: 'any' | 'all',
  ) => void;
  onCommitDocument: (next: SyncDocument) => void;
  onActivateLocation: (path: AstPath) => void;
  onSaveRegion: (region: RegionDefinition) => void;
  onDeleteRegion: (region: RegionDefinition) => void;
}

export function AnalysisBuilderPane({
  title,
  sync,
  projection,
  firstResultCardIndex,
  mode,
  catalogReady,
  effectiveCatalog,
  events,
  items,
  regions,
  customRegions,
  activeRegionId,
  activeExampleId,
  resultMapPoints,
  biasAudit,
  biasAuditLoading,
  biasAuditError,
  aiStatus,
  hasSemanticErrors,
  semanticDiagnostics,
  unconditional,
  comparisonActionVisible,
  groupingDisabledReason,
  dragonTypeGroupAvailable,
  numberedDragon,
  availableGroupKeys,
  datasetPatch,
  datasetQueue,
  datasetTier,
  datasetRegion,
  excludeRemakes,
  onTitleChange,
  onModeChange,
  onReviewBias,
  onOpenAi,
  onMakeComparison,
  onAddDragonTypeGroup,
  onAddGroupKey,
  onDatasetPatchChange,
  onDatasetQueueChange,
  onDatasetTierChange,
  onDatasetRegionChange,
  onExcludeRemakesChange,
  onAddCondition,
  onCreateItemResponse,
  onCreateCounterItem,
  onCreateChampionAnalysis,
  onAddSequence,
  onCommitDocument,
  onActivateLocation,
  onSaveRegion,
  onDeleteRegion,
}: AnalysisBuilderPaneProps) {
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const groupPicker = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!groupPickerOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') {
        setGroupPickerOpen(false);
        return;
      }
      if (event instanceof MouseEvent && !groupPicker.current?.contains(event.target as Node)) {
        setGroupPickerOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [groupPickerOpen]);

  const addGroupKey = (id: string) => {
    onAddGroupKey(id);
    setGroupPickerOpen(false);
  };
  const addDragonTypeGroup = () => {
    onAddDragonTypeGroup();
    setGroupPickerOpen(false);
  };

  return (
    <section className="builder-pane">
      <div className="pane-heading">
        <div>
          <span>VISUAL QUERY</span>
          <AnalysisTitleInput value={title} onChange={onTitleChange} />
        </div>
        <b>카드 {projection.cards.length}개</b>
      </div>
      <div className="builder-actions">
        <button
          disabled={biasAuditLoading || !catalogReady || hasSemanticErrors}
          title="조건을 바꾸지 않고 분석 설계의 편향 위험을 검사합니다."
          onClick={onReviewBias}
        >
          {biasAuditLoading ? '편향 검토 중…' : '편향 검토'}
        </button>
        {aiStatus?.enabled && (
          <button
            className="ai-dsl-button"
            title="질문을 분석 DSL과 카드로 만듭니다."
            onClick={onOpenAi}
          >
            AI로 DSL 만들기
          </button>
        )}
        <div
          className={`builder-action-group${comparisonActionVisible ? ' builder-action-group--joined' : ''}`}
        >
          {comparisonActionVisible && (
            <button
              disabled={sync.ast.body.groupBy.length > 0}
              title={
                sync.ast.body.groupBy.length
                  ? '분류 기준을 삭제한 뒤 비교할 수 있습니다.'
                  : '조건을 만족한 집단과 만족하지 않은 집단을 비교합니다.'
              }
              onClick={onMakeComparison}
            >
              조건과 반대 비교
            </button>
          )}
          <div className="grouping-control" ref={groupPicker}>
            <button
              aria-expanded={groupPickerOpen}
              aria-haspopup="menu"
              disabled={Boolean(groupingDisabledReason)}
              title={groupingDisabledReason ?? '결과를 분류할 기준을 추가합니다.'}
              onClick={() => setGroupPickerOpen((open) => !open)}
            >
              분류 기준 추가
            </button>
            {groupPickerOpen && !groupingDisabledReason && (
              <div className="grouping-menu" role="menu" aria-label="추가할 분류 기준">
                <strong>어떤 기준으로 결과를 나눌까요?</strong>
                {dragonTypeGroupAvailable && numberedDragon && (
                  <button role="menuitem" onClick={addDragonTypeGroup}>
                    <b>{occurrenceNumber(numberedDragon.ordinal)}번째 용 종류</b>
                    <span>해당 용을 원소 종류별로 나눕니다.</span>
                  </button>
                )}
                {availableGroupKeys.map((group) => (
                  <button key={group.id} role="menuitem" onClick={() => addGroupKey(group.id)}>
                    <b>{group.labelKo}</b>
                    <span>{group.descriptionKo}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="analysis-scope-bar" aria-label="분석 데이터 범위">
        <div>
          <span className="eyebrow">DATASET</span>
          <b>분석할 경기</b>
        </div>
        <label>
          <span>패치</span>
          <select
            aria-label="패치 필터"
            value={datasetPatch}
            onChange={(event) => onDatasetPatchChange(event.target.value)}
          >
            <option value="">전체 패치</option>
            {effectiveCatalog?.patches.map((patch) => (
              <option key={patch} value={patch}>
                {patch}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>게임 모드</span>
          <select
            aria-label="게임 모드 필터"
            value={datasetQueue}
            onChange={(event) => onDatasetQueueChange(event.target.value)}
          >
            <option value="">전체 게임 모드</option>
            {effectiveCatalog?.queues.map((queue) => (
              <option key={queue} value={queue}>
                {queue === 'RANKED_SOLO_5x5'
                  ? '솔로 랭크'
                  : queue === 'SWIFTPLAY'
                    ? '신속 대전'
                    : queue === 'QUICKPLAY'
                      ? '빠른 대전'
                      : queue}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>티어 (수집 시점)</span>
          <select
            aria-label="티어 필터"
            value={datasetTier}
            onChange={(event) => onDatasetTierChange(event.target.value)}
          >
            <option value="">전체 티어</option>
            {effectiveCatalog?.tiers.map((tier) => (
              <option key={tier} value={tier}>
                {tier === 'UNRANKED' ? '언랭크' : tier}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>서버</span>
          <select
            aria-label="서버 필터"
            value={datasetRegion}
            onChange={(event) => onDatasetRegionChange(event.target.value)}
          >
            <option value="">전체 서버</option>
            {effectiveCatalog?.platformRegions.map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
          </select>
        </label>
        <label className="dataset-checkbox">
          <input
            type="checkbox"
            checked={excludeRemakes}
            onChange={(event) => onExcludeRemakesChange(event.target.checked)}
          />
          <span>리메이크 제외</span>
        </label>
      </div>
      {(biasAudit || biasAuditError) && (
        <section
          className={`bias-audit bias-audit--${biasAudit?.riskLevel ?? 'medium'}`}
          aria-label="분석 편향 검토"
        >
          <div className="bias-audit__heading">
            <div>
              <span className="eyebrow">BIAS REVIEW</span>
              <b>
                {biasAudit
                  ? `편향 위험 ${
                      biasAudit.riskLevel === 'high'
                        ? '높음'
                        : biasAudit.riskLevel === 'medium'
                          ? '주의'
                          : '낮음'
                    }`
                  : '편향 검토 오류'}
              </b>
            </div>
            {biasAudit && <span>{biasAudit.warnings.length}개 신호</span>}
          </div>
          {biasAuditError && <p>{biasAuditError}</p>}
          {biasAudit?.warnings.map((warning) => (
            <details key={warning.code} open={warning.severity === 'high'}>
              <summary>
                <i>
                  {warning.severity === 'high'
                    ? '높음'
                    : warning.severity === 'medium'
                      ? '주의'
                      : '참고'}
                </i>
                {warning.titleKo}
              </summary>
              <p>{warning.messageKo}</p>
              <small>권장 · {warning.mitigationKo}</small>
            </details>
          ))}
          {biasAudit && <small>{biasAudit.limitationsKo}</small>}
        </section>
      )}
      {unconditional && (
        <div className="incomplete-card" role="status">
          <b>조건 없이 전체 경기를 분석합니다</b>
          <span>범위를 좁히려면 ‘조건 카드 추가’를 눌러 조건을 선택하세요.</span>
        </div>
      )}
      {sync.state === 'advanced' && (
        <div className="banner banner--advanced">
          <div className="banner__copy">
            <b>⚡ 고급 DSL 사용 중</b>
            <span>카드로 표현할 수 없는 부분 {projection.advancedCount}개</span>
          </div>
          <button onClick={() => onModeChange(mode === 'builder' ? 'split' : 'builder')}>
            {mode === 'builder' ? 'DSL 함께 보기' : '카드만 보기'}
          </button>
        </div>
      )}
      {sync.state === 'stale' && (
        <div className="banner banner--stale">
          DSL 입력이 아직 완성되지 않았습니다. 마지막 성공 카드를 유지합니다.
        </div>
      )}
      {sync.state !== 'stale' && hasSemanticErrors && (
        <div className="banner banner--stale" role="alert">
          {semanticDiagnostics
            .filter((diagnostic) => diagnostic.severity === 'error')
            .map((diagnostic) => diagnostic.titleKo)
            .join(' · ')}
        </div>
      )}
      <div className={sync.state === 'stale' ? 'card-flow card-flow--stale' : 'card-flow'}>
        {projection.cards.map((card, index) => (
          <div className="logic-block" key={card.id}>
            {index === firstResultCardIndex && (
              <CardLibrary
                entity={sync.ast.analyze?.entity}
                side={sync.ast.analyze?.side ?? null}
                events={events}
                champions={effectiveCatalog?.champions ?? []}
                items={items}
                regions={regions}
                disabled={sync.ast.body.kind !== 'SimpleStmt'}
                onAddCondition={onAddCondition}
                onCreateItemResponse={onCreateItemResponse}
                onCreateCounterItem={onCreateCounterItem}
                onCreateChampionAnalysis={onCreateChampionAnalysis}
                onAddSequence={onAddSequence}
              />
            )}
            {index > 0 && (
              <div className="logic-connector" aria-hidden="true">
                {card.path[0] === 'body' && card.path[1] === 'returns'
                  ? index === firstResultCardIndex
                    ? '결과로'
                    : '함께'
                  : card.type === 'sequence'
                    ? '그 후'
                    : card.type === 'groupBy'
                      ? '나누어'
                      : '그리고'}
              </div>
            )}
            <CardView
              card={card}
              sync={sync}
              onChange={onCommitDocument}
              regions={regions}
              events={events}
              champions={effectiveCatalog?.champions ?? []}
              items={items}
              onActivateLocation={(path) => {
                onActivateLocation(path);
                window.setTimeout(
                  () =>
                    document
                      .getElementById('region-editor')
                      ?.scrollIntoView({ behavior: 'smooth' }),
                  0,
                );
              }}
              onOpenDsl={(span) => {
                onModeChange('dsl');
                window.setTimeout(
                  () => window.dispatchEvent(new CustomEvent('lod-reveal-dsl', { detail: span })),
                  80,
                );
              }}
              coachText={
                activeExampleId === 'd' && card.type === 'condition'
                  ? '숫자를 바꿔 결과가 어떻게 달라지는지 확인해 보세요.'
                  : activeExampleId === 'f' && card.type === 'sequence'
                    ? '시간 창을 움직여 보세요.'
                    : ['b', 'e'].includes(activeExampleId ?? '') && card.type === 'location'
                      ? '프리셋을 고르거나 미니맵에 직접 그려 보세요.'
                      : undefined
              }
            />
          </div>
        ))}
      </div>
      {projection.cards.some((card) => card.type === 'location') && (
        <MapPanel
          regions={customRegions}
          activeRegionId={activeRegionId}
          heatmapPoints={resultMapPoints}
          onSave={onSaveRegion}
          onDelete={onDeleteRegion}
        />
      )}
    </section>
  );
}
