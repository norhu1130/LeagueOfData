import { FRAME_METRIC_OPTIONS } from '../../features/analysis-options.js';
import type { CardLibraryDraftState } from './useCardLibraryDrafts.js';
import { useState } from 'react';

type Finish = (action: () => void) => void;
type DraftProps<K extends keyof CardLibraryDraftState> = Pick<CardLibraryDraftState, K>;

type NumericDraftProps = DraftProps<
  | 'goldMinute'
  | 'setGoldMinute'
  | 'goldThreshold'
  | 'setGoldThreshold'
  | 'numericMetric'
  | 'setNumericMetric'
>;

export function NumericConditionForm({
  entity,
  side,
  finish,
  onAddCondition,
  ...draft
}: NumericDraftProps & {
  entity: 'match' | 'team' | 'player' | undefined;
  side: 'blue' | 'red' | null;
  finish: Finish;
  onAddCondition: (source: string) => void;
}) {
  const [operator, setOperator] = useState('>=');
  const {
    goldMinute,
    setGoldMinute,
    goldThreshold,
    setGoldThreshold,
    numericMetric,
    setNumericMetric,
  } = draft;
  const supportedMetrics = FRAME_METRIC_OPTIONS.filter(
    ([value]) => entity === 'team' || (entity === 'player' && value !== 'kill_diff'),
  );
  const selectedMetric = supportedMetrics.some(([value]) => value === numericMetric)
    ? numericMetric
    : 'gold_diff';
  const scope = side ?? (entity === 'player' ? 'player' : entity === 'team' ? '' : null);
  return (
    <div className="card-picker__form">
      <span className="picker-step">수치 조건</span>
      <h3>언제, 어떤 수치의 우위를 볼까요?</h3>
      <p>차이는 현재 분석 대상 팀 또는 선수의 상대편을 기준으로 계산합니다.</p>
      <label>
        <span>비교할 수치</span>
        <select
          aria-label="추가할 수치 조건 종류"
          value={selectedMetric}
          onChange={(event) => {
            const metric = event.target.value as typeof numericMetric;
            setNumericMetric(metric);
            if (metric === 'kill_diff' && goldThreshold > 20) setGoldThreshold(1);
          }}
        >
          {supportedMetrics.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>비교 기준</span>
        <strong>
          {side === 'blue'
            ? '블루팀'
            : side === 'red'
              ? '레드팀'
              : entity === 'player'
                ? '분석 대상 선수'
                : entity === 'team'
                  ? '분석 대상 팀'
                  : '팀 또는 선수 분석 필요'}
        </strong>
      </label>
      <div className="picker-fields">
        <label>
          <span>경기 시점</span>
          <div>
            <input
              aria-label="수치 차이 시점"
              type="number"
              min="1"
              max="59"
              value={goldMinute}
              onChange={(event) => setGoldMinute(Number(event.target.value))}
            />
            <i>분</i>
          </div>
        </label>
        <label>
          <span>비교 방식</span>
          <select
            aria-label="수치 비교 방식"
            value={operator}
            onChange={(event) => setOperator(event.target.value)}
          >
            <option value=">=">이상</option>
            <option value=">">초과</option>
            <option value="<=">이하</option>
            <option value="<">미만</option>
          </select>
        </label>
        <label>
          <span>기준값</span>
          <div>
            <input
              aria-label="수치 차이 기준"
              type="number"
              min={selectedMetric === 'kill_diff' ? -50 : -20000}
              max={selectedMetric === 'kill_diff' ? 50 : 20000}
              step={selectedMetric === 'kill_diff' ? 1 : 100}
              value={goldThreshold}
              onChange={(event) => setGoldThreshold(Number(event.target.value))}
            />
            <i>{FRAME_METRIC_OPTIONS.find(([value]) => value === selectedMetric)?.[2]}</i>
          </div>
        </label>
      </div>
      <button
        className="picker-primary"
        disabled={scope === null || supportedMetrics.length === 0}
        onClick={() => {
          if (scope === null) return;
          finish(() =>
            onAddCondition(
              `${scope ? `${scope}.` : ''}${selectedMetric}(${Math.max(1, Math.min(59, goldMinute))}:00) ${operator} ${Math.max(selectedMetric === 'kill_diff' ? -50 : -20000, goldThreshold)}`,
            ),
          );
        }}
      >
        수치 조건 추가
      </button>
    </div>
  );
}
