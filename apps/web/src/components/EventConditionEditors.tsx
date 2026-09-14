import type { BinaryExpr, EventRef, Expr, GroupKey, Ordinal } from '@lol/ast';
import { catalog, type EventDef } from '@lol/catalog';
import type { RegionDefinition } from '@lol/data-model';
import {
  dragonEventId,
  dragonVariantValue,
  eventFamilyId,
  eventPredicate,
  eventRefSide,
  locationCondition,
  locationEventSide,
  type EventScopeChoice,
} from '../features/analysis-dsl.js';

export function findNumberedDragonRef(value: unknown): EventRef | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumberedDragonRef(item);
      if (found) return found;
    }
    return null;
  }
  const node = value as Record<string, unknown>;
  if (
    node.kind === 'EventRef' &&
    node.eventType === 'dragon_kill' &&
    typeof node.ordinal === 'number'
  )
    return node as unknown as EventRef;
  for (const child of Object.values(node)) {
    const found = findNumberedDragonRef(child);
    if (found) return found;
  }
  return null;
}

export function containsEventRef(value: unknown, eventType: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsEventRef(item, eventType));
  const node = value as Record<string, unknown>;
  if (node.kind === 'EventRef' && node.eventType === eventType) return true;
  return Object.values(node).some((child) => containsEventRef(child, eventType));
}

export function isDragonTypeGroup(group: GroupKey): boolean {
  return group.expr.kind === 'FieldAccess' && group.expr.field === 'monster_subtype';
}

function occurrenceMode(ordinal: Ordinal): 'any' | 'first' | 'last' | 'nth' {
  if (ordinal === 'first' || ordinal === 'last' || ordinal === 'any') return ordinal;
  return 'nth';
}

export function occurrenceNumber(ordinal: Ordinal): number {
  return typeof ordinal === 'number' ? ordinal : 1;
}

export function EventQualifierSlots({
  eventId,
  ordinal,
  onChange,
  prefix,
}: {
  eventId: string;
  ordinal: Ordinal;
  onChange: (eventId: string, ordinal: Ordinal) => void;
  prefix: string;
}) {
  const definition = catalog.events[eventId];
  if (!definition) return null;
  const isDragon = eventFamilyId(eventId) === 'dragon_kill';
  const typeOptions = catalog.events.dragon_kill?.qualifiers?.[0]?.options ?? [];
  const mode = occurrenceMode(ordinal);
  return (
    <>
      {isDragon && (
        <label className="select-slot">
          <span>용 종류</span>
          <select
            aria-label={`${prefix} 용 종류`}
            value={dragonVariantValue(eventId)}
            onChange={(event) => onChange(dragonEventId(event.target.value), ordinal)}
          >
            <option value="">모든 용</option>
            {typeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.labelKo}
              </option>
            ))}
          </select>
        </label>
      )}
      {!definition.atMostOncePerMatch && (
        <label className="select-slot">
          <span>
            {isDragon
              ? dragonVariantValue(eventId)
                ? '선택한 종류 중 순서'
                : '전체 용 중 순서'
              : '발생 순서'}
          </span>
          <select
            aria-label={`${prefix} ${isDragon ? '용 순서 방식' : '발생 순서 방식'}`}
            value={mode}
            onChange={(event) => {
              const next = event.target.value as ReturnType<typeof occurrenceMode>;
              onChange(eventId, next === 'nth' ? 2 : next);
            }}
          >
            <option value="any">순서 무관</option>
            <option value="first">첫 번째</option>
            <option value="last">마지막</option>
            <option value="nth">n번째</option>
          </select>
        </label>
      )}
      {!definition.atMostOncePerMatch && mode === 'nth' && (
        <label className="numeric-input-slot">
          <span>몇 번째인가요?</span>
          <input
            aria-label={`${prefix} ${isDragon ? '용 순서' : '발생 순서'}`}
            type="number"
            min="2"
            max="255"
            value={Math.max(2, occurrenceNumber(ordinal))}
            onChange={(event) =>
              onChange(eventId, Math.max(2, Math.min(255, Number(event.target.value) || 2)))
            }
          />
        </label>
      )}
    </>
  );
}

export function DurationEventOptions({
  eventId,
  ordinal,
  prefix,
  onChange,
}: {
  eventId: string;
  ordinal: Ordinal;
  prefix: string;
  onChange: (eventId: string, ordinal: Ordinal) => void;
}) {
  const definition = catalog.events[eventId];
  if (!definition) return null;
  const isDragon = eventFamilyId(eventId) === 'dragon_kill';
  const typeOptions = catalog.events.dragon_kill?.qualifiers?.[0]?.options ?? [];
  const mode =
    ordinal === 'any'
      ? 'missing'
      : ordinal === 'last'
        ? 'last'
        : typeof ordinal === 'number' && ordinal > 1
          ? 'nth'
          : 'first';
  return (
    <>
      {isDragon && (
        <label className="select-slot">
          <span>용 종류</span>
          <select
            aria-label={`${prefix} 용 종류`}
            value={dragonVariantValue(eventId)}
            onChange={(event) => onChange(dragonEventId(event.target.value), ordinal)}
          >
            <option value="">모든 용</option>
            {typeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.labelKo}
              </option>
            ))}
          </select>
        </label>
      )}
      {!definition.atMostOncePerMatch && (
        <>
          <label className="select-slot">
            <span>발생 순서</span>
            <select
              aria-label={`${prefix} 순서 방식`}
              value={mode}
              onChange={(event) => {
                const next = event.target.value;
                onChange(eventId, next === 'last' ? 'last' : next === 'nth' ? 2 : 1);
              }}
            >
              <option value="missing" disabled>
                순서를 선택하세요
              </option>
              <option value="first">첫 번째 사건</option>
              <option value="last">마지막 사건</option>
              <option value="nth">n번째 사건</option>
            </select>
          </label>
          {mode === 'nth' && (
            <label className="numeric-input-slot">
              <span>몇 번째인가요?</span>
              <input
                aria-label={`${prefix} 순서`}
                type="number"
                min="2"
                max="255"
                value={Math.max(2, occurrenceNumber(ordinal))}
                onChange={(event) =>
                  onChange(eventId, Math.max(2, Math.min(255, Number(event.target.value) || 2)))
                }
              />
            </label>
          )}
        </>
      )}
    </>
  );
}

function withConditionNegation(expression: Expr, negated: boolean): Expr {
  if (expression.kind === 'EventPredicate') return { ...expression, negated };
  return negated ? { kind: 'UnaryExpr', op: 'NOT', operand: expression } : expression;
}

function conditionNegation(expression: Expr): { expression: Expr; negated: boolean } {
  if (expression.kind === 'EventPredicate' && expression.negated) {
    return { expression: { ...expression, negated: false }, negated: true };
  }
  if (expression.kind === 'UnaryExpr' && expression.op === 'NOT') {
    return { expression: expression.operand, negated: true };
  }
  return { expression, negated: false };
}

export function CompareConditionEditor({
  expression,
  onChange,
  events,
  regions,
}: {
  expression: Expr;
  onChange: (expression: Expr) => void;
  events: readonly EventDef[];
  regions: readonly RegionDefinition[];
}) {
  const state = conditionNegation(expression);
  const update = (next: Expr) => onChange(withConditionNegation(next, state.negated));
  return (
    <div className="compare-condition-editor">
      <label className="compare-negation">
        <input
          type="checkbox"
          checked={state.negated}
          onChange={(event) =>
            onChange(withConditionNegation(state.expression, event.target.checked))
          }
        />
        아래 조건을 만족하지 않는 집단
      </label>
      <CompareConditionCore
        expression={state.expression}
        onChange={update}
        events={events}
        regions={regions}
      />
    </div>
  );
}

function CompareConditionCore({
  expression,
  onChange,
  events,
  regions,
}: {
  expression: Expr;
  onChange: (expression: Expr) => void;
  events: readonly EventDef[];
  regions: readonly RegionDefinition[];
}) {
  if (expression.kind === 'BinaryExpr' && (expression.op === 'AND' || expression.op === 'OR')) {
    return (
      <div className="compare-condition-group">
        <label className="select-slot">
          <span>조건 연결</span>
          <select
            aria-label="비교 조건 연결 방식"
            value={expression.op}
            onChange={(event) =>
              onChange({ ...expression, op: event.target.value as 'AND' | 'OR' })
            }
          >
            <option value="AND">모두 만족</option>
            <option value="OR">하나 이상 만족</option>
          </select>
        </label>
        <CompareConditionEditor
          expression={expression.left}
          onChange={(left) => onChange({ ...expression, left })}
          events={events}
          regions={regions}
        />
        <CompareConditionEditor
          expression={expression.right}
          onChange={(right) => onChange({ ...expression, right })}
          events={events}
          regions={regions}
        />
      </div>
    );
  }

  if (expression.kind === 'EventPredicate') {
    const side = eventRefSide(expression.event);
    const selected = events.find((event) => event.id === expression.event.eventType);
    const primaryEvents = events.filter((event) => !event.variantOf);
    return (
      <div className="compare-leaf-editor">
        <label className="select-slot">
          <span>사건 팀</span>
          <select
            aria-label="비교 사건 팀"
            value={side}
            disabled={!selected?.context.includes('team')}
            onChange={(event) =>
              onChange(
                eventPredicate(
                  event.target.value as EventScopeChoice,
                  expression.event.eventType,
                  expression.event.ordinal,
                ),
              )
            }
          >
            <option value="target">분석 대상 팀</option>
            <option value="blue">블루팀</option>
            <option value="red">레드팀</option>
            <option value="any">어느 팀이든</option>
          </select>
        </label>
        <label className="select-slot">
          <span>사건</span>
          <select
            aria-label="비교 사건"
            value={eventFamilyId(expression.event.eventType)}
            onChange={(event) =>
              onChange(
                eventPredicate(
                  side,
                  event.target.value,
                  event.target.value === 'dragon_kill' ? expression.event.ordinal : 'any',
                ),
              )
            }
          >
            {primaryEvents.map((event) => (
              <option key={event.id} value={event.id}>
                {event.labelKo}
              </option>
            ))}
          </select>
        </label>
        <EventQualifierSlots
          eventId={expression.event.eventType}
          ordinal={expression.event.ordinal}
          prefix="비교 조건"
          onChange={(eventId, ordinal) => onChange(eventPredicate(side, eventId, ordinal))}
        />
      </div>
    );
  }

  if (
    expression.kind === 'SpatialPredicate' &&
    expression.target.kind === 'RegionRef' &&
    expression.position.kind === 'FieldAccess' &&
    expression.position.object.kind === 'EventRef'
  ) {
    const eventRef = expression.position.object;
    const event = eventRef.eventType;
    const side = locationEventSide(expression);
    const regionName = expression.target.name;
    return (
      <div className="compare-leaf-editor compare-leaf-editor--three">
        <label className="select-slot">
          <span>사건 팀</span>
          <select
            aria-label="비교 위치 사건 팀"
            value={side}
            onChange={(change) =>
              onChange(
                locationCondition(
                  event,
                  regionName,
                  change.target.value as EventScopeChoice,
                  eventRef.ordinal,
                ),
              )
            }
          >
            <option value="target">분석 대상 팀</option>
            <option value="blue">블루팀</option>
            <option value="red">레드팀</option>
            <option value="any">어느 팀이든</option>
          </select>
        </label>
        <label className="select-slot">
          <span>위치 사건</span>
          <select
            aria-label="비교 위치 사건"
            value={eventFamilyId(event)}
            onChange={(change) =>
              onChange(
                locationCondition(
                  change.target.value,
                  regionName,
                  side,
                  change.target.value === 'dragon_kill' ? eventRef.ordinal : 'any',
                ),
              )
            }
          >
            {events
              .filter((item) => item.context.includes('position') && !item.variantOf)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.labelKo}
                </option>
              ))}
          </select>
        </label>
        <label className="select-slot">
          <span>영역</span>
          <select
            aria-label="비교 위치 영역"
            value={regionName}
            onChange={(change) =>
              onChange(locationCondition(event, change.target.value, side, eventRef.ordinal))
            }
          >
            {regions.map((region) => (
              <option key={region.id} value={region.id}>
                {region.label}
              </option>
            ))}
          </select>
        </label>
        <EventQualifierSlots
          eventId={event}
          ordinal={eventRef.ordinal}
          prefix="비교 위치 조건"
          onChange={(eventId, ordinal) =>
            onChange(locationCondition(eventId, regionName, side, ordinal))
          }
        />
      </div>
    );
  }

  if (
    expression.kind === 'BinaryExpr' &&
    expression.left.kind === 'MeasureAt' &&
    expression.left.measure === 'gold_diff' &&
    expression.right.kind === 'NumberLit'
  ) {
    const condition = expression as BinaryExpr;
    const measure = expression.left as Extract<Expr, { kind: 'MeasureAt' }>;
    const threshold = expression.right as Extract<Expr, { kind: 'NumberLit' }>;
    const minute = Math.round(measure.at.seconds / 60);
    return (
      <div className="compare-leaf-editor compare-leaf-editor--numeric">
        <label className="select-slot">
          <span>팀</span>
          <select
            aria-label="비교 골드 차이 팀"
            value={measure.scope?.side ?? 'blue'}
            onChange={(event) =>
              onChange({
                ...condition,
                left: {
                  ...measure,
                  scope: {
                    kind: 'ScopeRef',
                    entity: 'team',
                    side: event.target.value as 'blue' | 'red',
                  },
                },
              })
            }
          >
            <option value="blue">블루팀</option>
            <option value="red">레드팀</option>
          </select>
        </label>
        <label className="numeric-input-slot">
          <span>시점(분)</span>
          <input
            aria-label="비교 골드 차이 시점"
            type="number"
            min="1"
            max="59"
            value={minute}
            onChange={(event) => {
              const nextMinute = Math.max(1, Math.min(59, Number(event.target.value)));
              onChange({
                ...condition,
                left: {
                  ...measure,
                  at: {
                    ...measure.at,
                    seconds: nextMinute * 60,
                    raw: `${nextMinute}:00`,
                  },
                },
              });
            }}
          />
        </label>
        <label className="select-slot">
          <span>비교</span>
          <select
            aria-label="비교 골드 차이 연산자"
            value={condition.op}
            onChange={(event) =>
              onChange({ ...condition, op: event.target.value as BinaryExpr['op'] })
            }
          >
            <option value=">=">이상</option>
            <option value=">">초과</option>
            <option value="<=">이하</option>
            <option value="<">미만</option>
          </select>
        </label>
        <label className="numeric-input-slot">
          <span>골드</span>
          <input
            aria-label="비교 골드 차이 기준"
            type="number"
            min="0"
            step="100"
            value={threshold.value}
            onChange={(event) =>
              onChange({
                ...condition,
                right: { ...threshold, value: Math.max(0, Number(event.target.value)) },
              })
            }
          />
        </label>
      </div>
    );
  }

  return <p className="compare-condition-summary">이 조건은 현재 카드에서 변경할 수 없습니다.</p>;
}
