import type { Ordinal } from '@lol/ast';
import type { EventDef } from '@lol/catalog';
import type { RegionDefinition } from '@lol/data-model';
import type { CounterItemSelection } from '@lol/validate';
import { useEffect, useState } from 'react';
import type { ItemOption } from './AnalysisInputs.js';
import {
  deathRoleDsl,
  eventFamilyId,
  eventScopePrefix,
  eventSource,
  teamPrompt,
  type EventScopeChoice,
  type ItemResponseDraft,
} from '../features/analysis-dsl.js';
import type { RosterRelation } from '../features/roster-analysis.js';
import { ChampionAnalysisForm } from './card-library/ChampionAnalysisForm.js';
import { EventConditionForm } from './card-library/EventConditionForm.js';
import { ItemConditionForm } from './card-library/ItemConditionForm.js';
import { LocationConditionForm } from './card-library/LocationConditionForm.js';
import { NumericConditionForm } from './card-library/NumericConditionForm.js';
import { SequenceConditionForm } from './card-library/SequenceConditionForm.js';
import { useCardLibraryDrafts } from './card-library/useCardLibraryDrafts.js';

export function CardLibrary({
  entity,
  side,
  events,
  champions,
  items,
  regions,
  disabled,
  onAddCondition,
  onCreateItemResponse,
  onCreateCounterItem,
  onCreateChampionAnalysis,
  onAddSequence,
}: {
  entity: 'match' | 'team' | 'player' | undefined;
  side: 'blue' | 'red' | null;
  events: readonly EventDef[];
  champions: readonly { readonly id: number; readonly name: string }[];
  items: readonly ItemOption[];
  regions: readonly RegionDefinition[];
  disabled: boolean;
  onAddCondition: (source: string) => void;
  onCreateItemResponse: (selection: ItemResponseDraft) => void;
  onCreateCounterItem: (selection: CounterItemSelection) => void;
  onCreateChampionAnalysis: (selection: {
    champion: string;
    role: string;
    relation: RosterRelation | 'none';
    relatedChampion: string;
    relatedRole: string;
  }) => void;
  onAddSequence: (
    startEvent: string,
    endEvent: string,
    seconds: number,
    startScope: EventScopeChoice,
    endScope: EventScopeChoice,
    startOrdinal?: Ordinal,
    endOrdinal?: Ordinal,
    endRoles?: readonly string[],
    endRoleMode?: 'any' | 'all',
  ) => void;
}) {
  const primaryEvents = events.filter((event) => !event.variantOf);
  const teamEvents = primaryEvents.filter((event) => event.context.includes('team'));
  const positionEvents = primaryEvents.filter((event) => event.context.includes('position'));
  const drafts = useCardLibraryDrafts(champions, items);
  const {
    eventId,
    eventOrdinal,
    eventSide,
    eventOccurred,
    eventRegion,
    eventDeathRoles,
    eventDeathRoleMode,
    setEventSide,
  } = drafts;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<
    'event' | 'champion' | 'item' | 'location' | 'gold' | 'sequence'
  >('event');
  const selectedEvent = events.find((event) => event.id === eventId);
  const eventDsl = selectedEvent?.context.includes('team')
    ? `${eventScopePrefix(eventSide)}${eventSource(eventId, eventOrdinal)}`
    : eventSource(eventId, eventOrdinal);
  const eventBaseDsl =
    eventId === 'death' && eventDeathRoles.length
      ? deathRoleDsl(eventDsl, eventDeathRoles, eventDeathRoleMode)
      : eventDsl;
  const eventConditionDsl = eventOccurred
    ? `${eventBaseDsl}${eventRegion && selectedEvent?.context.includes('position') ? ` AND ${eventDsl}.position IN region(${JSON.stringify(eventRegion)})` : ''}`
    : `NOT ${eventDsl}`;
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const finish = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <>
      <button
        className="add-card-button"
        disabled={disabled}
        title={disabled ? '비교 분석은 DSL에서 조건을 편집할 수 있습니다.' : undefined}
        onClick={() => {
          setEventSide('target');
          setOpen(true);
        }}
      >
        <b>+</b> 조건 카드 추가
      </button>
      {open && (
        <div
          className="card-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            className="card-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="card-picker-title"
          >
            <header>
              <div>
                <span>새 조건</span>
                <h2 id="card-picker-title">무엇을 분석에 추가할까요?</h2>
              </div>
              <button aria-label="카드 선택 닫기" onClick={() => setOpen(false)}>
                닫기
              </button>
            </header>
            <nav className="card-kind-tabs" aria-label="카드 종류">
              {(
                [
                  ['event', '사건'],
                  ['champion', '챔피언'],
                  ['item', '아이템 대응'],
                  ['location', '위치'],
                  ['gold', '수치 차이'],
                  ['sequence', '이어지는 사건'],
                ] as const
              ).map(([value, label]) => (
                <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>
                  {label}
                </button>
              ))}
            </nav>
            {kind === 'event' && (
              <EventConditionForm
                {...drafts}
                primaryEvents={primaryEvents}
                selectedEvent={selectedEvent}
                regions={regions}
                eventConditionDsl={eventConditionDsl}
                finish={finish}
                onAddCondition={onAddCondition}
              />
            )}
            {kind === 'champion' && (
              <ChampionAnalysisForm
                {...drafts}
                champions={champions}
                finish={finish}
                onCreateChampionAnalysis={onCreateChampionAnalysis}
              />
            )}
            {kind === 'item' && (
              <ItemConditionForm
                {...drafts}
                champions={champions}
                items={items}
                finish={finish}
                onCreateCounterItem={onCreateCounterItem}
                onCreateItemResponse={onCreateItemResponse}
              />
            )}
            {kind === 'location' && (
              <LocationConditionForm
                {...drafts}
                positionEvents={positionEvents}
                regions={regions}
                finish={finish}
                onAddCondition={onAddCondition}
              />
            )}
            {kind === 'gold' && (
              <NumericConditionForm
                {...drafts}
                entity={entity}
                side={side}
                finish={finish}
                onAddCondition={onAddCondition}
              />
            )}
            {kind === 'sequence' && (
              <SequenceConditionForm
                {...drafts}
                teamEvents={teamEvents}
                finish={finish}
                onAddSequence={onAddSequence}
              />
            )}
          </section>
        </div>
      )}
    </>
  );
}
