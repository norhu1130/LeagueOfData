import type { CounterItemSelection, ItemResponseSelection } from '@lol/validate';
import { ChampionMultiSelect, ItemMultiSelect, type ItemOption } from '../AnalysisInputs.js';
import { GRIEVOUS_WOUNDS_ITEMS } from '../../features/analysis-options.js';
import type { ItemResponseDraft } from '../../features/analysis-dsl.js';

type Champion = { readonly id: number; readonly name: string };

function PurchaseBasis({
  prefix,
  basis,
  atSeconds,
  onBasisChange,
  onSecondsChange,
}: {
  prefix: string;
  basis: NonNullable<ItemResponseSelection['itemBasis']>;
  atSeconds: number;
  onBasisChange: (basis: NonNullable<ItemResponseSelection['itemBasis']>) => void;
  onSecondsChange: (seconds: number) => void;
}) {
  return (
    <>
      <label className="select-slot">
        <span>판정 기준</span>
        <select
          aria-label={`${prefix} 판정 기준`}
          value={basis}
          onChange={(event) =>
            onBasisChange(event.target.value as NonNullable<ItemResponseSelection['itemBasis']>)
          }
        >
          <option value="ownedAt">시점에 보유 중</option>
          <option value="purchasedBy">시점까지 구매함</option>
          <option value="wholeMatch">경기 중 한 번이라도 구매</option>
        </select>
      </label>
      {basis !== 'wholeMatch' && (
        <label className="select-slot">
          <span>판정 시점</span>
          <span className="number-with-unit">
            <input
              aria-label={`${prefix} 판정 시점`}
              type="number"
              min={0}
              max={90}
              value={Math.floor(atSeconds / 60)}
              onChange={(event) =>
                onSecondsChange(Math.max(0, Number(event.target.value) || 0) * 60)
              }
            />
            분
          </span>
        </label>
      )}
    </>
  );
}

function BasisHelp({ basis }: { basis: NonNullable<ItemResponseSelection['itemBasis']> }) {
  return (
    <small>
      {basis === 'ownedAt'
        ? '구매·판매·파괴·구매 취소를 반영합니다. 판정 시점 전에 끝난 경기는 제외합니다.'
        : basis === 'purchasedBy'
          ? '시점까지의 구매 기록을 확인합니다. 판정 시점 전에 끝난 경기는 제외합니다.'
          : '판매하거나 구매를 취소했더라도 경기 중 구매 기록이 있으면 구매로 셉니다.'}
    </small>
  );
}

export function ItemResponseCardEditor({
  selection,
  champions,
  items,
  onChange,
}: {
  selection: ItemResponseSelection;
  champions: readonly Champion[];
  items: readonly ItemOption[];
  onChange: (selection: ItemResponseDraft) => void;
}) {
  const basis = selection.itemBasis ?? 'wholeMatch';
  return (
    <div className="event-editor" aria-label="아이템 대응 조건 설정">
      <PurchaseBasis
        prefix="아이템 대응"
        basis={basis}
        atSeconds={selection.atSeconds ?? 900}
        onBasisChange={(itemBasis) =>
          onChange({
            ...selection,
            itemBasis,
            atSeconds: selection.atSeconds ?? 900,
            opponentMode:
              itemBasis !== 'wholeMatch' && selection.opponentMode === 'all'
                ? 'any'
                : itemBasis !== 'wholeMatch' && selection.opponentMode === 'notAll'
                  ? 'none'
                  : selection.opponentMode,
            teamMode:
              itemBasis !== 'wholeMatch' && selection.teamMode === 'notAll'
                ? 'none'
                : selection.teamMode,
          })
        }
        onSecondsChange={(atSeconds) => onChange({ ...selection, atSeconds })}
      />
      <label className="select-slot">
        <span>상대 구매자</span>
        <select
          aria-label="아이템 대응 상대 구매자"
          value={selection.actor}
          onChange={(event) =>
            onChange({
              ...selection,
              actor: event.target.value as ItemResponseSelection['actor'],
              champion: selection.champion ?? champions[0]?.name,
            })
          }
        >
          <option value="anyEnemy">상대 팀원 중 한 명 이상</option>
          <option value="champion">특정 상대 챔피언</option>
        </select>
      </label>
      {selection.actor === 'champion' && (
        <label className="select-slot">
          <span>상대 챔피언</span>
          <select
            aria-label="아이템 대응 상대 챔피언"
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
      )}
      <label className="select-slot">
        <span>상대의 구매 조건</span>
        <select
          aria-label="상대 아이템 구매 방식"
          value={selection.opponentMode}
          onChange={(event) =>
            onChange({
              ...selection,
              opponentMode: event.target.value as ItemResponseSelection['opponentMode'],
            })
          }
        >
          <option value="any">선택한 것 중 하나 이상 구매</option>
          {basis === 'wholeMatch' && <option value="all">선택한 것을 모두 구매</option>}
          <option value="none">선택한 것을 하나도 구매 안 함</option>
          {basis === 'wholeMatch' && <option value="notAll">선택한 것을 전부 구매하진 않음</option>}
        </select>
      </label>
      <ItemMultiSelect
        label="상대 아이템"
        prefix="상대 아이템"
        selected={selection.opponentItems}
        items={items}
        onChange={(opponentItems) => onChange({ ...selection, opponentItems })}
      />
      <label className="select-slot">
        <span>우리 팀의 미구매 조건</span>
        <select
          aria-label="우리 팀 아이템 미구매 방식"
          value={selection.teamMode}
          onChange={(event) =>
            onChange({
              ...selection,
              teamMode: event.target.value as ItemResponseSelection['teamMode'],
            })
          }
        >
          <option value="none">선택한 것을 하나도 구매 안 함</option>
          {basis === 'wholeMatch' && <option value="notAll">선택한 것을 전부 구매하진 않음</option>}
        </select>
      </label>
      <ItemMultiSelect
        label="우리 팀 미구매 확인 아이템"
        prefix="우리 팀 아이템"
        selected={selection.teamItems}
        items={items}
        onChange={(teamItems) => onChange({ ...selection, teamItems })}
      />
      <BasisHelp basis={basis} />
    </div>
  );
}

export function CounterItemCardEditor({
  selection,
  champions,
  items,
  onChange,
}: {
  selection: CounterItemSelection;
  champions: readonly Champion[];
  items: readonly ItemOption[];
  onChange: (selection: CounterItemSelection) => void;
}) {
  const basis = selection.itemBasis ?? 'wholeMatch';
  const options = [
    ...items,
    ...GRIEVOUS_WOUNDS_ITEMS.filter((item) => !items.some((candidate) => candidate.id === item.id)),
  ].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return (
    <div className="counter-item-editor" aria-label="상대 챔피언과 대응 아이템 조건 설정">
      <ChampionMultiSelect
        selected={selection.champions}
        champions={champions}
        onChange={(selectedChampions) => onChange({ ...selection, champions: selectedChampions })}
      />
      <section className="counter-item-response">
        <div className="picker-fields">
          <PurchaseBasis
            prefix="대응 아이템"
            basis={basis}
            atSeconds={selection.atSeconds ?? 900}
            onBasisChange={(itemBasis) =>
              onChange({
                ...selection,
                itemBasis,
                atSeconds: selection.atSeconds ?? 900,
                teamMode:
                  itemBasis !== 'wholeMatch' && selection.teamMode === 'all'
                    ? 'any'
                    : itemBasis !== 'wholeMatch' && selection.teamMode === 'notAll'
                      ? 'none'
                      : selection.teamMode,
              })
            }
            onSecondsChange={(atSeconds) => onChange({ ...selection, atSeconds })}
          />
        </div>
        <label className="select-slot">
          <span>우리 팀은 선택 아이템을</span>
          <select
            aria-label="우리 팀 대응 아이템 구매 방식"
            value={selection.teamMode}
            onChange={(event) =>
              onChange({
                ...selection,
                teamMode: event.target.value as CounterItemSelection['teamMode'],
              })
            }
          >
            <option value="any">하나 이상 구매</option>
            {basis === 'wholeMatch' && <option value="all">모두 구매</option>}
            <option value="none">하나도 구매 안 함</option>
            {basis === 'wholeMatch' && <option value="notAll">전부 구매하진 않음</option>}
          </select>
        </label>
        <ItemMultiSelect
          label="확인할 대응 아이템"
          prefix="우리 팀 대응 아이템"
          selected={selection.teamItems}
          items={options}
          onChange={(teamItems) => onChange({ ...selection, teamItems })}
        />
      </section>
      <BasisHelp basis={basis} />
    </div>
  );
}
