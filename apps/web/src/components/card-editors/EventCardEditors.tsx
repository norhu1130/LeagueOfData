import type { Expr, Ordinal, SpatialPredicate } from '@lol/ast';
import type { EventDef } from '@lol/catalog';
import type { RegionDefinition } from '@lol/data-model';
import { applyCardEdit, type BuilderCard, type SyncDocument } from '@lol/visual-builder';
import { eventCardSelection } from '@lol/validate';
import { RoleMultiSelect } from '../AnalysisInputs.js';
import { EventQualifierSlots } from '../EventConditionEditors.js';
import {
  conditionFromDsl,
  eventCardCondition,
  eventFamilyId,
  eventScopePrefix,
  locationCondition,
  locationEventRef,
  locationEventSide,
  locationEventType,
  teamPrompt,
  type EventScopeChoice,
} from '../../features/analysis-dsl.js';

export function EventCardEditor({
  card,
  sync,
  events,
  regions,
  onChange,
}: {
  card: BuilderCard;
  sync: SyncDocument;
  events: readonly EventDef[];
  regions: readonly RegionDefinition[];
  onChange: (next: SyncDocument) => void;
}) {
  if (card.type !== 'event') return null;
  const selection = eventCardSelection(card.node as Expr, sync.ast.analyze?.side);
  if (!selection) return null;
  const side = sync.ast.analyze?.side ?? 'blue';
  const eventRef = selection.event;
  const eventId = eventRef.eventType;
  const eventSide: EventScopeChoice =
    eventRef.scope?.side === 'blue' || eventRef.scope?.side === 'red'
      ? eventRef.scope.side
      : eventRef.scope?.entity === 'team'
        ? 'any'
        : 'target';
  const hasTeam = events.find((event) => event.id === eventId)?.context.includes('team') ?? false;
  const primaryEvents = events.filter((event) => !event.variantOf);
  const replace = (
    nextSide: EventScopeChoice = eventSide,
    nextEventId: string = eventId,
    ordinal: Ordinal = eventRef.ordinal,
    occurred: boolean = selection.occurred,
    region: string | undefined = selection.region,
  ) =>
    onChange(
      applyCardEdit(sync, {
        kind: 'replace',
        path: card.path,
        value: eventCardCondition(nextSide, nextEventId, ordinal, occurred, region),
      }),
    );

  return (
    <div className="event-editor">
      <label className="select-slot">
        <span>발생 여부</span>
        <select
          aria-label="사건 발생 여부"
          value={selection.occurred ? 'occurred' : 'missing'}
          onChange={(event) =>
            replace(
              undefined,
              undefined,
              undefined,
              event.target.value === 'occurred',
              event.target.value === 'occurred' ? selection.region : undefined,
            )
          }
        >
          <option value="occurred">발생함</option>
          <option value="missing">발생하지 않음</option>
        </select>
      </label>
      <label className="select-slot">
        <span>{teamPrompt(eventId)}</span>
        <select
          aria-label="사건 팀"
          value={eventSide}
          disabled={!hasTeam}
          onChange={(event) => replace(event.target.value as EventScopeChoice)}
        >
          <option value="target">분석 대상 팀</option>
          <option value="blue">블루팀</option>
          <option value="red">레드팀</option>
          <option value="any">어느 팀이든</option>
        </select>
      </label>
      <label className="select-slot">
        <span>어떤 사건인가요?</span>
        <select
          aria-label="사건 조건"
          value={eventFamilyId(eventId)}
          onChange={(event) =>
            replace(
              eventSide,
              event.target.value,
              event.target.value === 'dragon_kill' ? eventRef.ordinal : 'any',
              undefined,
              events
                .find((definition) => definition.id === event.target.value)
                ?.context.includes('position')
                ? selection.region
                : undefined,
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
        eventId={eventId}
        ordinal={eventRef.ordinal}
        prefix="사건 조건"
        onChange={(nextEventId, ordinal) => replace(eventSide, nextEventId, ordinal)}
      />
      {selection.occurred &&
        events.find((event) => event.id === eventId)?.context.includes('position') && (
          <label className="select-slot">
            <span>위치 조건</span>
            <select
              aria-label="사건 위치 영역"
              value={selection.region ?? ''}
              onChange={(event) =>
                replace(undefined, undefined, undefined, true, event.target.value || undefined)
              }
            >
              <option value="">어디서든</option>
              {regions.map((region) => (
                <option key={region.id} value={region.id}>
                  {region.label}
                </option>
              ))}
            </select>
          </label>
        )}
      {eventId === 'death' && (
        <RoleMultiSelect
          prefix="사건 조건 포지션"
          selected={[]}
          onChange={(roles) => {
            if (!roles.length) return;
            const ref = `${eventScopePrefix(eventSide)}death`;
            const value = conditionFromDsl(
              side,
              `${ref}.role IN (${roles.map((role) => `"${role}"`).join(', ')})`,
            );
            onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));
          }}
        />
      )}
    </div>
  );
}

export function LocationCardEditor({
  card,
  sync,
  events,
  regions,
  onChange,
  onActivate,
}: {
  card: BuilderCard;
  sync: SyncDocument;
  events: readonly EventDef[];
  regions: readonly RegionDefinition[];
  onChange: (next: SyncDocument) => void;
  onActivate?: () => void;
}) {
  if (card.type !== 'location' || card.node.kind !== 'SpatialPredicate') return null;
  const node = card.node;
  const eventId = locationEventType(node);
  const eventRef = locationEventRef(node);
  const eventSide = locationEventSide(node);
  const regionId = node.target.kind === 'RegionRef' ? node.target.name : 'top_lane';
  const replace = (value: SpatialPredicate) =>
    onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));

  return (
    <div className="location-editor">
      <label className="select-slot">
        <span>{teamPrompt(eventId)}</span>
        <select
          aria-label="위치 사건 팀"
          value={eventSide}
          disabled={
            !eventId || !events.find((event) => event.id === eventId)?.context.includes('team')
          }
          onChange={(event) => {
            if (!eventId) return;
            replace(
              locationCondition(
                eventId,
                regionId,
                event.target.value as EventScopeChoice,
                eventRef?.ordinal,
              ),
            );
          }}
        >
          <option value="target">분석 대상 팀</option>
          <option value="blue">블루팀</option>
          <option value="red">레드팀</option>
          <option value="any">어느 팀이든</option>
        </select>
      </label>
      <label className="select-slot">
        <span>어떤 사건의 위치인가요?</span>
        <select
          aria-label="위치 사건"
          value={eventFamilyId(eventId ?? '')}
          onChange={(event) =>
            replace(
              locationCondition(
                event.target.value,
                regionId,
                eventSide,
                event.target.value === 'dragon_kill' ? eventRef?.ordinal : 'any',
              ),
            )
          }
        >
          {events
            .filter((event) => event.context.includes('position') && !event.variantOf)
            .map((event) => (
              <option key={event.id} value={event.id}>
                {event.labelKo}
              </option>
            ))}
        </select>
      </label>
      {eventRef && (
        <EventQualifierSlots
          eventId={eventRef.eventType}
          ordinal={eventRef.ordinal}
          prefix="위치 조건"
          onChange={(nextEventId, ordinal) =>
            replace(locationCondition(nextEventId, regionId, eventSide, ordinal))
          }
        />
      )}
      <label className="select-slot">
        <span>어느 영역인가요?</span>
        <select
          aria-label="위치 영역"
          value={node.target.kind === 'RegionRef' ? node.target.name : ''}
          onChange={(event) =>
            replace({ ...node, target: { kind: 'RegionRef', name: event.target.value } })
          }
        >
          {regions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.label}
            </option>
          ))}
        </select>
      </label>
      <button className="utility-button" onClick={onActivate}>
        이 카드에 새 영역 그리기
      </button>
    </div>
  );
}
