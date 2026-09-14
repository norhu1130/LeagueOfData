import type { EventDef } from '@lol/catalog';
import type { RegionDefinition } from '@lol/data-model';
import { RoleMultiSelect } from '../AnalysisInputs.js';
import { EventQualifierSlots } from '../EventConditionEditors.js';
import { eventFamilyId, teamPrompt, type EventScopeChoice } from '../../features/analysis-dsl.js';
import type { CardLibraryDraftState } from './useCardLibraryDrafts.js';

type Finish = (action: () => void) => void;
type DraftProps<K extends keyof CardLibraryDraftState> = Pick<CardLibraryDraftState, K>;

type EventDraftProps = DraftProps<
  | 'eventId'
  | 'setEventId'
  | 'eventOrdinal'
  | 'setEventOrdinal'
  | 'eventSide'
  | 'setEventSide'
  | 'eventOccurred'
  | 'setEventOccurred'
  | 'eventRegion'
  | 'setEventRegion'
  | 'eventDeathRoles'
  | 'setEventDeathRoles'
  | 'eventDeathRoleMode'
  | 'setEventDeathRoleMode'
>;

export function EventConditionForm({
  primaryEvents,
  selectedEvent,
  regions,
  eventConditionDsl,
  finish,
  onAddCondition,
  ...draft
}: EventDraftProps & {
  primaryEvents: readonly EventDef[];
  selectedEvent: EventDef | undefined;
  regions: readonly RegionDefinition[];
  eventConditionDsl: string;
  finish: Finish;
  onAddCondition: (source: string) => void;
}) {
  const {
    eventId,
    setEventId,
    eventOrdinal,
    setEventOrdinal,
    eventSide,
    setEventSide,
    eventOccurred,
    setEventOccurred,
    eventRegion,
    setEventRegion,
    eventDeathRoles,
    setEventDeathRoles,
    eventDeathRoleMode,
    setEventDeathRoleMode,
  } = draft;
  return (
    <div className="card-picker__form">
      <span className="picker-step">사건 조건</span>
      <h3>어떤 사건이 발생한 경기를 찾을까요?</h3>
      <p>사건의 팀은 승률을 계산할 분석 대상과 별도로 선택할 수 있습니다.</p>
      <label>
        <span>발생 여부</span>
        <select
          aria-label="추가할 사건 발생 여부"
          value={eventOccurred ? 'occurred' : 'missing'}
          onChange={(event) => {
            const occurred = event.target.value === 'occurred';
            setEventOccurred(occurred);
            if (!occurred) setEventRegion('');
          }}
        >
          <option value="occurred">발생함</option>
          <option value="missing">발생하지 않음</option>
        </select>
      </label>
      <label>
        <span>{teamPrompt(eventId)}</span>
        <select
          aria-label="추가할 사건 팀"
          value={eventSide}
          disabled={!selectedEvent?.context.includes('team')}
          onChange={(event) => setEventSide(event.target.value as EventScopeChoice)}
        >
          <option value="target">분석 대상 팀</option>
          <option value="blue">블루팀</option>
          <option value="red">레드팀</option>
          <option value="any">어느 팀이든</option>
        </select>
      </label>
      <label>
        <span>사건</span>
        <select
          aria-label="추가할 사건"
          value={eventFamilyId(eventId)}
          onChange={(event) => {
            setEventId(event.target.value);
            if (event.target.value !== 'dragon_kill') setEventOrdinal('any');
            if (event.target.value !== 'death') setEventDeathRoles([]);
          }}
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
        ordinal={eventOrdinal}
        prefix="추가할 사건"
        onChange={(nextEventId, ordinal) => {
          setEventId(nextEventId);
          setEventOrdinal(ordinal);
        }}
      />
      {eventOccurred && selectedEvent?.context.includes('position') && (
        <label>
          <span>위치 조건</span>
          <select
            aria-label="추가할 사건 위치 영역"
            value={eventRegion}
            onChange={(event) => setEventRegion(event.target.value)}
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
          prefix="추가할 사망 포지션"
          selected={eventDeathRoles}
          onChange={setEventDeathRoles}
          mode={eventDeathRoleMode}
          onModeChange={setEventDeathRoleMode}
        />
      )}
      <button
        className="picker-primary"
        onClick={() => finish(() => onAddCondition(eventConditionDsl))}
      >
        사건 조건 추가
      </button>
    </div>
  );
}
