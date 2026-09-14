import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ItemOption } from '../features/analysis-types.js';

export const ROLE_OPTIONS = [
  ['TOP', '탑'],
  ['JUNGLE', '정글'],
  ['MID', '미드'],
  ['BOT', '원딜'],
  ['SUPPORT', '서포터'],
] as const;

export type { ItemOption } from '../features/analysis-types.js';

export function ItemSelect({
  label,
  ariaLabel,
  value,
  items,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  items: readonly ItemOption[];
  onChange: (itemId: number) => void;
}) {
  return (
    <label className="select-slot">
      <span>{label}</span>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} · {item.id}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ItemMultiSelect({
  label,
  prefix,
  selected,
  items,
  onChange,
}: {
  label: string;
  prefix: string;
  selected: readonly number[];
  items: readonly ItemOption[];
  onChange: (items: number[]) => void;
}) {
  const [nextItem, setNextItem] = useState(
    items.find((item) => !selected.includes(item.id))?.id ?? 0,
  );
  useEffect(() => {
    if (!items.some((item) => item.id === nextItem && !selected.includes(item.id)))
      setNextItem(items.find((item) => !selected.includes(item.id))?.id ?? 0);
  }, [items, nextItem, selected]);
  return (
    <fieldset className="role-multi-select item-multi-select">
      <legend>{label}</legend>
      <div className="selected-item-list">
        {selected.map((itemId) => {
          const item = items.find((candidate) => candidate.id === itemId);
          return (
            <button
              type="button"
              key={itemId}
              aria-label={`${prefix} ${item?.name ?? itemId} 제거`}
              onClick={() =>
                selected.length > 1 && onChange(selected.filter((id) => id !== itemId))
              }
              disabled={selected.length === 1}
            >
              {item?.name ?? `아이템 #${itemId}`} ×
            </button>
          );
        })}
      </div>
      <div className="slot-row">
        <select
          aria-label={`${prefix} 추가할 아이템`}
          value={nextItem}
          onChange={(event) => setNextItem(Number(event.target.value))}
        >
          {items
            .filter((item) => !selected.includes(item.id))
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.id}
              </option>
            ))}
        </select>
        <button
          type="button"
          disabled={!nextItem || selected.includes(nextItem)}
          onClick={() => onChange([...selected, nextItem])}
        >
          아이템 추가
        </button>
      </div>
    </fieldset>
  );
}

export function ChampionMultiSelect({
  selected,
  champions,
  onChange,
}: {
  selected: readonly string[];
  champions: readonly { readonly id: number; readonly name: string }[];
  onChange: (champions: string[]) => void;
}) {
  const available = champions.filter((champion) => !selected.includes(champion.name));
  const [nextChampion, setNextChampion] = useState(available[0]?.name ?? '');
  useEffect(() => {
    if (!available.some((champion) => champion.name === nextChampion))
      setNextChampion(available[0]?.name ?? '');
  }, [available, nextChampion]);
  return (
    <fieldset className="role-multi-select item-multi-select">
      <legend>상대 챔피언 · 하나라도 있으면</legend>
      <div className="selected-item-list">
        {selected.map((champion) => (
          <button
            type="button"
            key={champion}
            aria-label={`상대 챔피언 ${champion} 제거`}
            onClick={() =>
              selected.length > 1 && onChange(selected.filter((name) => name !== champion))
            }
            disabled={selected.length === 1}
          >
            {champion} ×
          </button>
        ))}
      </div>
      <div className="slot-row">
        <select
          aria-label="추가할 상대 챔피언"
          value={nextChampion}
          onChange={(event) => setNextChampion(event.target.value)}
        >
          {available.map((champion) => (
            <option key={champion.id} value={champion.name}>
              {champion.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!nextChampion || selected.length >= 5}
          onClick={() => onChange([...selected, nextChampion])}
        >
          챔피언 추가
        </button>
      </div>
      <small>최대 5명까지 선택할 수 있습니다.</small>
    </fieldset>
  );
}

export function AnalysisTitleInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  });
  return (
    <textarea
      ref={ref}
      rows={1}
      className="analysis-title"
      aria-label="분석 이름"
      value={value}
      onChange={(event) => onChange(event.target.value.replaceAll('\n', ' '))}
    />
  );
}

export function RoleMultiSelect({
  selected,
  onChange,
  mode = 'any',
  onModeChange,
  prefix,
}: {
  selected: readonly string[];
  onChange: (roles: string[]) => void;
  mode?: 'any' | 'all';
  onModeChange?: (mode: 'any' | 'all') => void;
  prefix: string;
}) {
  return (
    <fieldset className="role-multi-select">
      <legend>사망한 선수의 포지션</legend>
      <div className="slot-row slot-row--wrap">
        {ROLE_OPTIONS.map(([value, label]) => (
          <label key={value}>
            <input
              aria-label={`${prefix} ${label}`}
              type="checkbox"
              checked={selected.includes(value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, value]
                    : selected.filter((role) => role !== value),
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
      {selected.length > 1 && onModeChange && (
        <label className="select-slot">
          <span>여러 포지션을 판단하는 방식</span>
          <select
            aria-label={`${prefix} 선택 방식`}
            value={mode}
            onChange={(event) => onModeChange(event.target.value as 'any' | 'all')}
          >
            <option value="any">중 한 명 이상</option>
            <option value="all">각각 한 명 이상</option>
          </select>
        </label>
      )}
      <small>
        {mode === 'all'
          ? '선택한 포지션의 선수가 각각 한 번 이상 사망한 경우를 찾습니다.'
          : '선택한 포지션 중 한 명 이상 사망한 경우를 찾습니다.'}
      </small>
    </fieldset>
  );
}
