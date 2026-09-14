import type { Ordinal } from '@lol/ast';
import type { EventDef } from '@lol/catalog';
import { applyCardEdit, type BuilderCard, type SyncDocument } from '@lol/visual-builder';
import { RoleMultiSelect } from '../AnalysisInputs.js';
import { EventQualifierSlots } from '../EventConditionEditors.js';
import {
  chainFromDsl,
  chainedEventRef,
  chainedEventType,
  deathRoleMode,
  deathRoleValues,
  eventFamilyId,
  eventRefSide,
  teamPrompt,
  type EventScopeChoice,
} from '../../features/analysis-dsl.js';

export function SequenceCardEditor({
  card,
  sync,
  events,
  onChange,
}: {
  card: BuilderCard;
  sync: SyncDocument;
  events: readonly EventDef[];
  onChange: (next: SyncDocument) => void;
}) {
  if (card.type !== 'sequence' || card.node.kind !== 'ChainClause' || !card.node.window)
    return null;
  const sequence = card.node;
  const window = card.node.window;
  const end = chainedEventRef(sequence.condition);
  const endRoles = deathRoleValues(sequence.condition);
  const endRoleMode = deathRoleMode(sequence.condition);
  const teamEvents = events.filter((event) => event.context.includes('team') && !event.variantOf);
  const replace = (
    startEvent: string,
    endEvent: string,
    seconds: number,
    startScope: EventScopeChoice = eventRefSide(sequence.trigger),
    endScope: EventScopeChoice = end ? eventRefSide(end) : 'target',
    startOrdinal: Ordinal = sequence.trigger.ordinal,
    endOrdinal: Ordinal = end?.ordinal ?? 'any',
    roles: readonly string[] = endEvent === 'death' ? endRoles : [],
    roleMode: 'any' | 'all' = endRoleMode,
  ) =>
    onChange(
      applyCardEdit(sync, {
        kind: 'replace',
        path: card.path,
        value: chainFromDsl(
          startScope,
          startEvent,
          endScope,
          endEvent,
          seconds,
          startOrdinal,
          endOrdinal,
          roles,
          roleMode,
        ),
      }),
    );

  return (
    <div className="sequence-editor" aria-label="이어지는 사건 설정">
      <div className="sequence-step">
        <b>1</b>
        <span>{teamPrompt(sequence.trigger.eventType)}</span>
        <select
          aria-label="이어지는 사건 시작 팀"
          value={eventRefSide(sequence.trigger)}
          onChange={(event) =>
            replace(
              sequence.trigger.eventType,
              chainedEventType(sequence.condition) ?? 'dragon_kill',
              sequence.window!.seconds,
              event.target.value as EventScopeChoice,
            )
          }
        >
          <option value="target">분석 대상 팀</option>
          <option value="blue">블루팀</option>
          <option value="red">레드팀</option>
          <option value="any">어느 팀이든</option>
        </select>
        <span>시작 사건</span>
        <select
          aria-label="이어지는 사건 시작"
          value={eventFamilyId(sequence.trigger.eventType)}
          onChange={(event) =>
            replace(
              event.target.value,
              chainedEventType(sequence.condition) ?? 'dragon_kill',
              sequence.window!.seconds,
            )
          }
        >
          {teamEvents.map((event) => (
            <option key={event.id} value={event.id}>
              {event.labelKo}
            </option>
          ))}
        </select>
        <EventQualifierSlots
          eventId={sequence.trigger.eventType}
          ordinal={sequence.trigger.ordinal}
          prefix="이어지는 사건 시작"
          onChange={(eventId, ordinal) =>
            replace(
              eventId,
              end?.eventType ?? 'dragon_kill',
              sequence.window!.seconds,
              undefined,
              undefined,
              ordinal,
            )
          }
        />
      </div>
      <div className="sequence-arrow" aria-hidden="true">
        이후
      </div>
      <div className="sequence-step">
        <b>2</b>
        <span>{teamPrompt(end?.eventType ?? null)}</span>
        <select
          aria-label="이어지는 사건 끝 팀"
          value={end ? eventRefSide(end) : 'target'}
          onChange={(event) =>
            replace(
              sequence.trigger.eventType,
              chainedEventType(sequence.condition) ?? 'dragon_kill',
              sequence.window!.seconds,
              undefined,
              event.target.value as EventScopeChoice,
            )
          }
        >
          <option value="target">시작 사건과 같은 팀</option>
          <option value="opponent">시작 사건의 상대팀</option>
          <option value="blue">블루팀</option>
          <option value="red">레드팀</option>
          <option value="any">어느 팀이든</option>
        </select>
        <span>끝 사건</span>
        <select
          aria-label="이어지는 사건 끝"
          value={eventFamilyId(chainedEventType(sequence.condition) ?? '')}
          onChange={(event) =>
            replace(sequence.trigger.eventType, event.target.value, sequence.window!.seconds)
          }
        >
          {teamEvents.map((event) => (
            <option key={event.id} value={event.id}>
              {event.labelKo}
            </option>
          ))}
        </select>
        {end && (
          <EventQualifierSlots
            eventId={end.eventType}
            ordinal={end.ordinal}
            prefix="이어지는 사건 끝"
            onChange={(eventId, ordinal) =>
              replace(
                sequence.trigger.eventType,
                eventId,
                sequence.window!.seconds,
                undefined,
                undefined,
                undefined,
                ordinal,
              )
            }
          />
        )}
        {end?.eventType === 'death' && (
          <RoleMultiSelect
            prefix="이어지는 사건 끝 포지션"
            selected={endRoles}
            mode={endRoleMode}
            onModeChange={(mode) =>
              replace(
                sequence.trigger.eventType,
                'death',
                sequence.window!.seconds,
                undefined,
                undefined,
                undefined,
                undefined,
                endRoles,
                mode,
              )
            }
            onChange={(roles) =>
              replace(
                sequence.trigger.eventType,
                'death',
                sequence.window!.seconds,
                undefined,
                undefined,
                undefined,
                undefined,
                roles,
                endRoleMode,
              )
            }
          />
        )}
      </div>
      <label className="sequence-window">
        <span>
          두 사건 사이의 최대 시간 <b>{window.seconds}초</b>
        </span>
        <input
          aria-label="이어지는 사건 시간 창"
          type="range"
          min="15"
          max="300"
          step="15"
          value={window.seconds}
          onChange={(event) =>
            onChange(
              applyCardEdit(sync, {
                kind: 'replace',
                path: card.path,
                value: {
                  ...sequence,
                  window: {
                    kind: 'DurationLit',
                    seconds: Number(event.target.value),
                    raw: `${event.target.value}s`,
                  },
                },
              }),
            )
          }
        />
      </label>
    </div>
  );
}
