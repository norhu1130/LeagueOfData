import type { CompareArm } from '@lol/ast';
import type { EventDef } from '@lol/catalog';
import type { RegionDefinition } from '@lol/data-model';
import { ROLE_OPTIONS } from '../AnalysisInputs.js';
import { CompareConditionEditor } from '../EventConditionEditors.js';
import { FRAME_METRIC_OPTIONS } from '../../features/analysis-options.js';
import type {
  PlayerRosterSelection,
  RosterRelationSelection,
} from '../../features/roster-analysis.js';
import type { AnalysisTargetChoice } from '../../features/builder-commands.js';

export function TargetCardEditor({
  entity,
  side,
  selector,
  lockedToEvent,
  disabledReasons,
  onSelect,
  onPlayerSelectorChange,
}: {
  entity: string | undefined;
  side: string | undefined;
  selector: string | undefined;
  lockedToEvent: boolean;
  disabledReasons: Partial<Record<AnalysisTargetChoice, string>>;
  onSelect: (choice: AnalysisTargetChoice) => void;
  onPlayerSelectorChange: (selector: string) => void;
}) {
  const effectiveEntity = lockedToEvent ? 'event' : entity;
  return (
    <div className="target-editor">
      <div className="slot-row" role="group" aria-label="분석 단위">
        {(
          [
            ['match', '경기'],
            ['team', '팀'],
            ['player', '선수'],
            ['event', '사건'],
          ] as const
        ).map(([choice, label]) => (
          <button
            key={choice}
            aria-pressed={effectiveEntity === choice}
            disabled={
              choice === 'event' || Boolean(disabledReasons[choice as AnalysisTargetChoice])
            }
            title={
              choice === 'event'
                ? lockedToEvent
                  ? '사건 연결의 기준 사건 하나가 표본 하나입니다.'
                  : '이어지는 사건 카드를 추가하면 사건 단위로 전환됩니다.'
                : disabledReasons[choice]
            }
            onClick={() => choice !== 'event' && onSelect(choice)}
          >
            {label}
          </button>
        ))}
      </div>
      {!lockedToEvent && entity === 'team' && (
        <div className="slot-row" role="group" aria-label="분석 팀 범위">
          {(
            [
              ['team', '전체 팀'],
              ['blue', '블루팀'],
              ['red', '레드팀'],
            ] as const
          ).map(([choice, label]) => (
            <button
              key={choice}
              disabled={Boolean(disabledReasons[choice])}
              title={disabledReasons[choice]}
              aria-pressed={choice === 'team' ? !side : side === choice}
              onClick={() => onSelect(choice)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {!lockedToEvent && entity === 'player' && (
        <label className="select-slot target-player-selector">
          <span>특정 선수 (선택)</span>
          <input
            aria-label="분석 대상 선수 이름"
            value={selector ?? ''}
            placeholder="소환사명 또는 Riot ID · 비우면 전체 선수"
            onChange={(event) => onPlayerSelectorChange(event.target.value)}
          />
        </label>
      )}
      <div className="coachmark">
        {lockedToEvent
          ? '기준 사건 하나를 표본 하나로 사용합니다. 사건의 팀 범위는 이어지는 사건 카드에서 선택합니다.'
          : entity === 'player'
            ? '선수 한 명의 한 경기를 표본 하나로 사용합니다. 챔피언·포지션·선수 지표를 분석할 수 있습니다.'
            : entity === 'match'
              ? '한 경기를 표본 하나로 사용합니다. 픽률의 분모는 현재 데이터셋의 경기 수입니다.'
              : '한 팀의 한 경기를 표본 하나로 사용합니다. 전체 팀 또는 블루·레드 진영을 선택할 수 있습니다.'}
      </div>
    </div>
  );
}

export function NumericConditionEditor({
  measure,
  threshold,
  scope,
  operator,
  targetEntity,
  onChange,
}: {
  measure: string;
  threshold: number;
  scope: 'target' | 'blue' | 'red';
  operator: '>' | '>=' | '<' | '<=';
  targetEntity: 'team' | 'player';
  onChange: (
    measure: string,
    threshold: number,
    operator: '>' | '>=' | '<' | '<=',
    scope: 'target' | 'blue' | 'red',
  ) => void;
}) {
  const availableOptions = FRAME_METRIC_OPTIONS.filter(
    ([value]) => targetEntity === 'team' || value !== 'kill_diff',
  );
  const option = availableOptions.find(([value]) => value === measure);
  return (
    <div className="numeric-editor">
      <label className="select-slot">
        <span>비교할 수치</span>
        <select
          aria-label="수치 조건 종류"
          value={measure}
          onChange={(event) => onChange(event.target.value, threshold, operator, scope)}
        >
          {availableOptions.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="select-slot">
        <span>비교 기준</span>
        <select
          aria-label="수치 조건 팀"
          value={scope}
          onChange={(event) =>
            onChange(measure, threshold, operator, event.target.value as 'target' | 'blue' | 'red')
          }
        >
          <option value="target">분석 대상 {targetEntity === 'player' ? '선수' : '팀'}</option>
          {scope === 'blue' && <option value="blue">블루팀</option>}
          {scope === 'red' && <option value="red">레드팀</option>}
        </select>
      </label>
      <label className="select-slot">
        <span>비교 방식</span>
        <select
          aria-label="수치 조건 비교 방식"
          value={operator}
          onChange={(event) =>
            onChange(measure, threshold, event.target.value as '>' | '>=' | '<' | '<=', scope)
          }
        >
          <option value=">=">이상</option>
          <option value=">">초과</option>
          <option value="<=">이하</option>
          <option value="<">미만</option>
        </select>
      </label>
      <label className="numeric-slot">
        <span>
          {threshold.toLocaleString()} {option?.[2] ?? ''}
        </span>
        <input
          aria-label="수치 우위 기준"
          type="number"
          min={measure === 'kill_diff' ? -50 : -20000}
          max={measure === 'kill_diff' ? 50 : 20000}
          step={measure === 'kill_diff' ? 1 : 100}
          value={threshold}
          onChange={(event) => onChange(measure, Number(event.target.value), operator, scope)}
        />
      </label>
    </div>
  );
}

export function PlayerRosterConditionEditor({
  selection,
  champions,
  onChange,
}: {
  selection: PlayerRosterSelection;
  champions: readonly { readonly id: number; readonly name: string }[];
  onChange: (selection: PlayerRosterSelection) => void;
}) {
  return (
    <div className="event-editor">
      <label className="select-slot">
        <span>{selection.field === 'champion' ? '분석할 챔피언' : '분석할 포지션'}</span>
        <select
          aria-label={selection.field === 'champion' ? '분석 대상 챔피언' : '분석 대상 포지션'}
          value={selection.value}
          onChange={(event) => onChange({ ...selection, value: event.target.value })}
        >
          {selection.field === 'champion'
            ? champions.map((champion) => (
                <option key={champion.id} value={champion.name}>
                  {champion.name}
                </option>
              ))
            : ROLE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
        </select>
      </label>
    </div>
  );
}

export function RosterRelationConditionEditor({
  selection,
  champions,
  onChange,
}: {
  selection: RosterRelationSelection;
  champions: readonly { readonly id: number; readonly name: string }[];
  onChange: (selection: RosterRelationSelection) => void;
}) {
  return (
    <div className="event-editor">
      <label className="select-slot">
        <span>관계</span>
        <select
          aria-label="챔피언 관계"
          value={selection.relation}
          onChange={(event) =>
            onChange({
              ...selection,
              relation: event.target.value as RosterRelationSelection['relation'],
            })
          }
        >
          <option value="opponent_has_champion">상대팀에 포함</option>
          <option value="ally_has_champion">같은 팀에 포함</option>
          <option value="opponent_has_champion_in_role">상대 포지션에서 만남</option>
        </select>
      </label>
      <label className="select-slot">
        <span>챔피언</span>
        <select
          aria-label="관계 조건 챔피언"
          value={selection.champion}
          onChange={(event) => onChange({ ...selection, champion: event.target.value })}
        >
          {champions.map((champion) => (
            <option key={champion.id} value={champion.name}>
              {champion.name}
            </option>
          ))}
        </select>
      </label>
      {selection.relation === 'opponent_has_champion_in_role' && (
        <label className="select-slot">
          <span>상대 포지션</span>
          <select
            aria-label="상대 챔피언 포지션"
            value={selection.role ?? 'MID'}
            onChange={(event) => onChange({ ...selection, role: event.target.value })}
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
  );
}

export function CompareCardEditor({
  label,
  arm,
  events,
  regions,
  onChange,
}: {
  label: string;
  arm: CompareArm;
  events: readonly EventDef[];
  regions: readonly RegionDefinition[];
  onChange: (arm: CompareArm) => void;
}) {
  return (
    <div className="compare-editor">
      <div className="compare-editor__heading">
        <b>{label}</b>
        <span>이 집단에 포함될 조건을 카드에서 직접 바꿀 수 있습니다.</span>
      </div>
      <CompareConditionEditor
        expression={arm.when}
        events={events}
        regions={regions}
        onChange={(when) => onChange({ ...arm, when })}
      />
    </div>
  );
}

export function AdvancedCardEditor({
  reason,
  span,
  removable,
  onOpenDsl,
  onRemove,
}: {
  reason: string | undefined;
  span: readonly [number, number] | undefined;
  removable: boolean;
  onOpenDsl: (span?: readonly [number, number]) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <small>{reason}</small>
      <div className="slot-row">
        <button onClick={() => onOpenDsl(span)}>DSL에서 편집</button>
        {removable && <button onClick={onRemove}>이 조건 삭제</button>}
      </div>
    </>
  );
}
