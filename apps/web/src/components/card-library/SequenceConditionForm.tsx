import type { Ordinal } from '@lol/ast';
import type { EventDef } from '@lol/catalog';
import { RoleMultiSelect } from '../AnalysisInputs.js';
import { EventQualifierSlots } from '../EventConditionEditors.js';
import { eventFamilyId, teamPrompt, type EventScopeChoice } from '../../features/analysis-dsl.js';
import type { CardLibraryDraftState } from './useCardLibraryDrafts.js';

type Finish = (action: () => void) => void;
type DraftProps<K extends keyof CardLibraryDraftState> = Pick<CardLibraryDraftState, K>;

type SequenceDraftProps = DraftProps<
  | 'startEventId'
  | 'setStartEventId'
  | 'endEventId'
  | 'setEndEventId'
  | 'startOrdinal'
  | 'setStartOrdinal'
  | 'endOrdinal'
  | 'setEndOrdinal'
  | 'startEventSide'
  | 'setStartEventSide'
  | 'endEventSide'
  | 'setEndEventSide'
  | 'endDeathRoles'
  | 'setEndDeathRoles'
  | 'endDeathRoleMode'
  | 'setEndDeathRoleMode'
  | 'windowSeconds'
  | 'setWindowSeconds'
>;

export type AddSequence = (
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

export function SequenceConditionForm({
  teamEvents,
  finish,
  onAddSequence,
  ...draft
}: SequenceDraftProps & {
  teamEvents: readonly EventDef[];
  finish: Finish;
  onAddSequence: AddSequence;
}) {
  const {
    startEventId,
    setStartEventId,
    endEventId,
    setEndEventId,
    startOrdinal,
    setStartOrdinal,
    endOrdinal,
    setEndOrdinal,
    startEventSide,
    setStartEventSide,
    endEventSide,
    setEndEventSide,
    endDeathRoles,
    setEndDeathRoles,
    endDeathRoleMode,
    setEndDeathRoleMode,
    windowSeconds,
    setWindowSeconds,
  } = draft;
  return (
    <div className="card-picker__form">
      <span className="picker-step">사건 연결</span>
      <h3>어떤 두 사건을 시간 순서로 연결할까요?</h3>
      <p>시작 사건 뒤 제한 시간 안에 끝 사건이 발생했는지 측정합니다.</p>
      <div className="picker-sequence">
        <div className="picker-sequence-step">
          <div className="picker-sequence-step__heading">
            <b>1</b>
            <div>
              <strong>시작 사건</strong>
              <span>먼저 발생하는 사건</span>
            </div>
          </div>
          <div className="picker-sequence-step__fields">
            <label>
              <span>{teamPrompt(startEventId)}</span>
              <select
                aria-label="추가할 시작 사건 팀"
                value={startEventSide}
                onChange={(event) => setStartEventSide(event.target.value as EventScopeChoice)}
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
                aria-label="추가할 시작 사건"
                value={eventFamilyId(startEventId)}
                onChange={(event) => {
                  setStartEventId(event.target.value);
                  if (event.target.value !== 'dragon_kill') setStartOrdinal('any');
                }}
              >
                {teamEvents.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.labelKo}
                  </option>
                ))}
              </select>
            </label>
            <EventQualifierSlots
              eventId={startEventId}
              ordinal={startOrdinal}
              prefix="추가할 시작 사건"
              onChange={(nextEventId, ordinal) => {
                setStartEventId(nextEventId);
                setStartOrdinal(ordinal);
              }}
            />
          </div>
        </div>
        <div className="picker-sequence-connector" aria-label="사건 사이 시간 제한">
          <span>그 후</span>
          <label>
            <span>최대</span>
            <div>
              <input
                aria-label="추가할 시간 제한"
                type="number"
                min="15"
                max="600"
                step="15"
                value={windowSeconds}
                onChange={(event) => setWindowSeconds(Number(event.target.value))}
              />
              <i>초</i>
            </div>
          </label>
        </div>
        <div className="picker-sequence-step">
          <div className="picker-sequence-step__heading">
            <b>2</b>
            <div>
              <strong>끝 사건</strong>
              <span>제한 시간 안에 발생할 사건</span>
            </div>
          </div>
          <div className="picker-sequence-step__fields">
            <label>
              <span>{teamPrompt(endEventId)}</span>
              <select
                aria-label="추가할 끝 사건 팀"
                value={endEventSide}
                onChange={(event) => setEndEventSide(event.target.value as EventScopeChoice)}
              >
                <option value="target">시작 사건과 같은 팀</option>
                <option value="opponent">시작 사건의 상대팀</option>
                <option value="blue">블루팀</option>
                <option value="red">레드팀</option>
                <option value="any">어느 팀이든</option>
              </select>
            </label>
            <label>
              <span>사건</span>
              <select
                aria-label="추가할 끝 사건"
                value={eventFamilyId(endEventId)}
                onChange={(event) => {
                  setEndEventId(event.target.value);
                  if (event.target.value !== 'dragon_kill') setEndOrdinal('any');
                  if (event.target.value !== 'death') setEndDeathRoles([]);
                }}
              >
                {teamEvents.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.labelKo}
                  </option>
                ))}
              </select>
            </label>
            <EventQualifierSlots
              eventId={endEventId}
              ordinal={endOrdinal}
              prefix="추가할 끝 사건"
              onChange={(nextEventId, ordinal) => {
                setEndEventId(nextEventId);
                setEndOrdinal(ordinal);
              }}
            />
            {endEventId === 'death' && (
              <RoleMultiSelect
                prefix="추가할 끝 사건 포지션"
                selected={endDeathRoles}
                onChange={setEndDeathRoles}
                mode={endDeathRoleMode}
                onModeChange={setEndDeathRoleMode}
              />
            )}
          </div>
        </div>
      </div>
      <button
        className="picker-primary"
        onClick={() =>
          finish(() =>
            onAddSequence(
              startEventId,
              endEventId,
              Math.max(15, Math.min(600, windowSeconds)),
              startEventSide,
              endEventSide,
              startOrdinal,
              endOrdinal,
              endDeathRoles,
              endDeathRoleMode,
            ),
          )
        }
      >
        연결 조건 추가
      </button>
    </div>
  );
}
