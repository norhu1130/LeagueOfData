import type { Ordinal } from '@lol/ast';
import { catalog, listSubjectFields, type EventDef } from '@lol/catalog';
import { applyCardEdit, type BuilderCard, type SyncDocument } from '@lol/visual-builder';
import { useState } from 'react';
import { ROLE_OPTIONS } from '../AnalysisInputs.js';
import { DurationEventOptions } from '../EventConditionEditors.js';
import {
  durationEventSource,
  durationMeasureSelection,
  eventFamilyId,
  returnItem,
} from '../../features/analysis-dsl.js';
import {
  CHAMPION_METRICS,
  championMetricDsl,
  championMetricSelection,
} from '../../features/champion-analysis.js';
import {
  AGGREGATE_OPTIONS,
  subjectAggregateDsl,
  subjectAggregateSelection,
} from '../../features/statistics.js';

export function MeasureCardEditor({
  card,
  sync,
  events,
  champions,
  onChange,
}: {
  card: BuilderCard;
  sync: SyncDocument;
  events: readonly EventDef[];
  champions: readonly { readonly id: number; readonly name: string }[];
  onChange: (next: SyncDocument) => void;
}) {
  const [durationDraft, setDurationDraft] = useState(false);
  const [durationStartEvent, setDurationStartEvent] = useState('first_blood');
  const [durationEndEvent, setDurationEndEvent] = useState('turret_destroy');
  const [durationStartOrdinal, setDurationStartOrdinal] = useState<Ordinal>('any');
  const [durationEndOrdinal, setDurationEndOrdinal] = useState<Ordinal>(1);
  if (card.type !== 'measure' || card.node.kind !== 'ReturnItem') return null;

  const targetSide = sync.ast.analyze?.side;
  const side = targetSide ?? 'blue';
  const selectedDuration = durationMeasureSelection(card.node);
  const selectedChampionMetric = championMetricSelection(card.node);
  const selectedSubjectAggregate = subjectAggregateSelection(card.node);
  const replacementReturn = (expression: string) => ({
    ...returnItem(side, expression),
    alias: card.node.kind === 'ReturnItem' ? card.node.alias : null,
  });
  const subjectFields = listSubjectFields(
    sync.ast.analyze?.entity === 'match' ||
      sync.ast.analyze?.entity === 'team' ||
      sync.ast.analyze?.entity === 'player'
      ? sync.ast.analyze.entity
      : undefined,
  ).filter((field) => ['int', 'float', 'duration'].includes(field.type));
  const durationEvents = events.filter(
    (event) => !event.variantOf && event.context.includes('time'),
  );
  const activeDurationStartEvent = selectedDuration?.start.eventType ?? durationStartEvent;
  const activeDurationEndEvent = selectedDuration?.end.eventType ?? durationEndEvent;
  const activeDurationStartOrdinal = selectedDuration?.start.ordinal ?? durationStartOrdinal;
  const activeDurationEndOrdinal = selectedDuration?.end.ordinal ?? durationEndOrdinal;
  const changeDuration = (
    startEvent: string,
    endEvent: string,
    startOrdinal: Ordinal,
    endOrdinal: Ordinal,
  ) => {
    const value = replacementReturn(
      `avg(duration(${durationEventSource(startEvent, startOrdinal, targetSide)}, ${durationEventSource(endEvent, endOrdinal, targetSide)}))`,
    );
    onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));
    setDurationDraft(false);
  };
  const updateDurationStart = (eventId: string, ordinal: Ordinal) => {
    if (selectedDuration) {
      changeDuration(eventId, activeDurationEndEvent, ordinal, activeDurationEndOrdinal);
      return;
    }
    setDurationStartEvent(eventId);
    setDurationStartOrdinal(ordinal);
  };
  const updateDurationEnd = (eventId: string, ordinal: Ordinal) => {
    if (selectedDuration) {
      changeDuration(activeDurationStartEvent, eventId, activeDurationStartOrdinal, ordinal);
      return;
    }
    setDurationEndEvent(eventId);
    setDurationEndOrdinal(ordinal);
  };

  return (
    <>
      <div className="slot-row">
        {sync.ast.analyze?.entity !== 'match' && (
          <>
            <button
              aria-pressed={
                card.node.expr.kind === 'CallExpr' && card.node.expr.callee === 'win_rate'
              }
              onClick={() => {
                setDurationDraft(false);
                onChange(
                  applyCardEdit(sync, {
                    kind: 'replace',
                    path: card.path,
                    value: replacementReturn(targetSide ? `${targetSide}.win_rate` : 'win_rate()'),
                  }),
                );
              }}
            >
              승률
            </button>
            <button
              aria-pressed={
                card.node.expr.kind === 'CallExpr' && card.node.expr.callee === 'loss_rate'
              }
              onClick={() => {
                setDurationDraft(false);
                onChange(
                  applyCardEdit(sync, {
                    kind: 'replace',
                    path: card.path,
                    value: replacementReturn(
                      targetSide ? `${targetSide}.loss_rate` : 'loss_rate()',
                    ),
                  }),
                );
              }}
            >
              패배율
            </button>
          </>
        )}
        <button
          aria-pressed={card.node.expr.kind === 'CallExpr' && card.node.expr.callee === 'count'}
          onClick={() => {
            setDurationDraft(false);
            onChange(
              applyCardEdit(sync, {
                kind: 'replace',
                path: card.path,
                value: replacementReturn('count()'),
              }),
            );
          }}
        >
          표본 수
        </button>
        {(sync.ast.body.kind === 'SimpleStmt' && sync.ast.body.chain) ||
        (card.node.expr.kind === 'CallExpr' && card.node.expr.callee === 'success_rate') ? (
          <button
            aria-pressed={
              card.node.expr.kind === 'CallExpr' && card.node.expr.callee === 'success_rate'
            }
            onClick={() => {
              setDurationDraft(false);
              onChange(
                applyCardEdit(sync, {
                  kind: 'replace',
                  path: card.path,
                  value: replacementReturn('success_rate()'),
                }),
              );
            }}
          >
            성공률
          </button>
        ) : null}
        {sync.ast.analyze?.entity === 'match' &&
          CHAMPION_METRICS.map((metric) => (
            <button
              key={metric.id}
              aria-pressed={selectedChampionMetric?.metric === metric.id}
              onClick={() => {
                setDurationDraft(false);
                onChange(
                  applyCardEdit(sync, {
                    kind: 'replace',
                    path: card.path,
                    value: replacementReturn(
                      championMetricDsl({
                        metric: metric.id,
                        champion: selectedChampionMetric?.champion ?? champions[0]?.name ?? 'Ahri',
                        role: selectedChampionMetric?.role ?? 'MID',
                      }),
                    ),
                  }),
                );
              }}
            >
              {metric.label}
            </button>
          ))}
        <button
          aria-pressed={Boolean(selectedDuration) || durationDraft}
          onClick={() => setDurationDraft(true)}
        >
          두 사건 사이의 시간
        </button>
        {subjectFields.length > 0 &&
          AGGREGATE_OPTIONS.map(([aggregate, label]) => (
            <button
              key={aggregate}
              aria-pressed={selectedSubjectAggregate?.aggregate === aggregate}
              onClick={() => {
                setDurationDraft(false);
                const entity =
                  sync.ast.analyze?.entity === 'match' || sync.ast.analyze?.entity === 'player'
                    ? sync.ast.analyze.entity
                    : 'team';
                onChange(
                  applyCardEdit(sync, {
                    kind: 'replace',
                    path: card.path,
                    value: replacementReturn(
                      subjectAggregateDsl({
                        aggregate,
                        entity,
                        field: selectedSubjectAggregate?.field ?? subjectFields[0]!.id,
                      }),
                    ),
                  }),
                );
              }}
            >
              {label}
            </button>
          ))}
      </div>
      {selectedChampionMetric && (
        <div className="numeric-editor">
          <label className="select-slot">
            <span>분석할 챔피언</span>
            <select
              aria-label="챔피언 지표 챔피언"
              value={selectedChampionMetric.champion}
              onChange={(event) =>
                onChange(
                  applyCardEdit(sync, {
                    kind: 'replace',
                    path: card.path,
                    value: replacementReturn(
                      championMetricDsl({
                        ...selectedChampionMetric,
                        champion: event.target.value,
                      }),
                    ),
                  }),
                )
              }
            >
              {!champions.some((champion) => champion.name === selectedChampionMetric.champion) && (
                <option value={selectedChampionMetric.champion}>
                  {selectedChampionMetric.champion}
                </option>
              )}
              {champions.map((champion) => (
                <option key={champion.id} value={champion.name}>
                  {champion.name}
                </option>
              ))}
            </select>
          </label>
          {selectedChampionMetric.metric === 'role_pick_rate' && (
            <label className="select-slot">
              <span>포지션</span>
              <select
                aria-label="챔피언 지표 포지션"
                value={selectedChampionMetric.role ?? 'MID'}
                onChange={(event) =>
                  onChange(
                    applyCardEdit(sync, {
                      kind: 'replace',
                      path: card.path,
                      value: replacementReturn(
                        championMetricDsl({
                          ...selectedChampionMetric,
                          role: event.target.value,
                        }),
                      ),
                    }),
                  )
                }
              >
                {ROLE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {selectedSubjectAggregate && (
        <label className="select-slot">
          <span>집계할 값</span>
          <select
            aria-label="집계할 선수 또는 경기 지표"
            value={selectedSubjectAggregate.field}
            onChange={(event) =>
              onChange(
                applyCardEdit(sync, {
                  kind: 'replace',
                  path: card.path,
                  value: replacementReturn(
                    subjectAggregateDsl({
                      ...selectedSubjectAggregate,
                      field: event.target.value,
                    }),
                  ),
                }),
              )
            }
          >
            {subjectFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.labelKo}
              </option>
            ))}
          </select>
        </label>
      )}
      {(durationDraft || selectedDuration) && (
        <div className="duration-config" aria-label="두 사건 사이의 시간 설정">
          <div className="duration-config__heading">
            <b>시간을 잴 두 사건</b>
            <span>
              두 사건 모두 분석 대상 팀 기준입니다. 조건 카드는 분석할 경기·팀을 추가로 좁힐 때만
              사용합니다.
            </span>
          </div>
          <div className="sequence-editor duration-editor">
            <div className="sequence-step">
              <b>1</b>
              <span>시작 사건</span>
              <select
                aria-label="시간 측정 시작 사건"
                value={eventFamilyId(activeDurationStartEvent)}
                onChange={(event) => {
                  const eventId = event.target.value;
                  updateDurationStart(
                    eventId,
                    catalog.events[eventId]?.atMostOncePerMatch ? 'any' : 1,
                  );
                }}
              >
                {durationEvents.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.labelKo}
                  </option>
                ))}
              </select>
              <DurationEventOptions
                eventId={activeDurationStartEvent}
                ordinal={activeDurationStartOrdinal}
                prefix="시간 측정 시작 사건"
                onChange={updateDurationStart}
              />
            </div>
            <div className="sequence-arrow" aria-hidden="true">
              부터
            </div>
            <div className="sequence-step">
              <b>2</b>
              <span>끝 사건</span>
              <select
                aria-label="시간 측정 끝 사건"
                value={eventFamilyId(activeDurationEndEvent)}
                onChange={(event) => {
                  const eventId = event.target.value;
                  updateDurationEnd(
                    eventId,
                    catalog.events[eventId]?.atMostOncePerMatch ? 'any' : 1,
                  );
                }}
              >
                {durationEvents.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.labelKo}
                  </option>
                ))}
              </select>
              <DurationEventOptions
                eventId={activeDurationEndEvent}
                ordinal={activeDurationEndOrdinal}
                prefix="시간 측정 끝 사건"
                onChange={updateDurationEnd}
              />
            </div>
          </div>
          {!selectedDuration && (
            <div className="duration-config__actions">
              <button type="button" onClick={() => setDurationDraft(false)}>
                취소
              </button>
              <button
                type="button"
                className="picker-primary"
                onClick={() =>
                  changeDuration(
                    activeDurationStartEvent,
                    activeDurationEndEvent,
                    activeDurationStartOrdinal,
                    activeDurationEndOrdinal,
                  )
                }
              >
                시간 측정 적용
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
