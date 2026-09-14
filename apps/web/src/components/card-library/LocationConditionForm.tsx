import type { EventDef } from '@lol/catalog';
import type { RegionDefinition } from '@lol/data-model';
import { EventQualifierSlots } from '../EventConditionEditors.js';
import {
  eventFamilyId,
  eventScopePrefix,
  eventSource,
  teamPrompt,
  type EventScopeChoice,
} from '../../features/analysis-dsl.js';
import type { CardLibraryDraftState } from './useCardLibraryDrafts.js';

type Finish = (action: () => void) => void;
type DraftProps<K extends keyof CardLibraryDraftState> = Pick<CardLibraryDraftState, K>;

type LocationDraftProps = DraftProps<
  | 'positionEventId'
  | 'setPositionEventId'
  | 'positionOrdinal'
  | 'setPositionOrdinal'
  | 'positionSide'
  | 'setPositionSide'
  | 'regionId'
  | 'setRegionId'
>;

export function LocationConditionForm({
  positionEvents,
  regions,
  finish,
  onAddCondition,
  ...draft
}: LocationDraftProps & {
  positionEvents: readonly EventDef[];
  regions: readonly RegionDefinition[];
  finish: Finish;
  onAddCondition: (source: string) => void;
}) {
  const {
    positionEventId,
    setPositionEventId,
    positionOrdinal,
    setPositionOrdinal,
    positionSide,
    setPositionSide,
    regionId,
    setRegionId,
  } = draft;
  return (
    <div className="card-picker__form">
      <span className="picker-step">위치 조건</span>
      <h3>어떤 사건이 어느 영역에서 일어났나요?</h3>
      <p>팀, 사건, 영역을 선택하면 한 장의 위치 카드가 만들어집니다.</p>
      <label>
        <span>{teamPrompt(positionEventId)}</span>
        <select
          aria-label="추가할 위치 사건 팀"
          value={positionSide}
          disabled={
            !positionEvents.find((event) => event.id === positionEventId)?.context.includes('team')
          }
          onChange={(event) => setPositionSide(event.target.value as EventScopeChoice)}
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
          aria-label="위치를 확인할 사건"
          value={eventFamilyId(positionEventId)}
          onChange={(event) => {
            setPositionEventId(event.target.value);
            if (event.target.value !== 'dragon_kill') setPositionOrdinal('any');
          }}
        >
          {positionEvents.map((event) => (
            <option key={event.id} value={event.id}>
              {event.labelKo}
            </option>
          ))}
        </select>
      </label>
      <EventQualifierSlots
        eventId={positionEventId}
        ordinal={positionOrdinal}
        prefix="추가할 위치 사건"
        onChange={(nextEventId, ordinal) => {
          setPositionEventId(nextEventId);
          setPositionOrdinal(ordinal);
        }}
      />
      <label>
        <span>영역</span>
        <select
          aria-label="추가할 위치 영역"
          value={regionId}
          onChange={(event) => setRegionId(event.target.value)}
        >
          {regions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.label}
            </option>
          ))}
        </select>
      </label>
      <button
        className="picker-primary"
        onClick={() =>
          finish(() =>
            onAddCondition(
              `${eventScopePrefix(positionSide)}${eventSource(positionEventId, positionOrdinal)}.position IN region("${regionId}")`,
            ),
          )
        }
      >
        위치 조건 추가
      </button>
    </div>
  );
}
