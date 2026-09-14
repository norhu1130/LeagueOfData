import type { CounterItemSelection, ItemResponseSelection } from '@lol/validate';
import { ChampionMultiSelect, ItemMultiSelect, type ItemOption } from '../AnalysisInputs.js';
import type { ItemResponseDraft } from '../../features/analysis-dsl.js';
import type { CardLibraryDraftState } from './useCardLibraryDrafts.js';

type Finish = (action: () => void) => void;
type DraftProps<K extends keyof CardLibraryDraftState> = Pick<CardLibraryDraftState, K>;
type ChampionOption = { readonly id: number; readonly name: string };

type ItemDraftProps = DraftProps<
  | 'itemChampion'
  | 'setItemChampion'
  | 'itemScenario'
  | 'setItemScenario'
  | 'counterChampions'
  | 'setCounterChampions'
  | 'counterTeamItemMode'
  | 'setCounterTeamItemMode'
  | 'counterTeamItems'
  | 'setCounterTeamItems'
  | 'counterItemBasis'
  | 'setCounterItemBasis'
  | 'counterItemMinute'
  | 'setCounterItemMinute'
  | 'itemActor'
  | 'setItemActor'
  | 'itemBasis'
  | 'setItemBasis'
  | 'itemMinute'
  | 'setItemMinute'
  | 'opponentItemMode'
  | 'setOpponentItemMode'
  | 'opponentItems'
  | 'setOpponentItems'
  | 'teamItemMode'
  | 'setTeamItemMode'
  | 'teamItems'
  | 'setTeamItems'
>;

export function ItemConditionForm({
  champions,
  items,
  finish,
  onCreateCounterItem,
  onCreateItemResponse,
  ...draft
}: ItemDraftProps & {
  champions: readonly ChampionOption[];
  items: readonly ItemOption[];
  finish: Finish;
  onCreateCounterItem: (selection: CounterItemSelection) => void;
  onCreateItemResponse: (selection: ItemResponseDraft) => void;
}) {
  const {
    itemChampion,
    setItemChampion,
    itemScenario,
    setItemScenario,
    counterChampions,
    setCounterChampions,
    counterTeamItemMode,
    setCounterTeamItemMode,
    counterTeamItems,
    setCounterTeamItems,
    counterItemBasis,
    setCounterItemBasis,
    counterItemMinute,
    setCounterItemMinute,
    itemActor,
    setItemActor,
    itemBasis,
    setItemBasis,
    itemMinute,
    setItemMinute,
    opponentItemMode,
    setOpponentItemMode,
    opponentItems,
    setOpponentItems,
    teamItemMode,
    setTeamItemMode,
    teamItems,
    setTeamItems,
  } = draft;
  return (
    <div className="card-picker__form card-picker__form--item">
      <span className="picker-step">아이템 조건</span>
      <h3>어떤 상황의 아이템 구매를 볼까요?</h3>
      <p className="picker-replace-note" role="note">
        이 템플릿을 만들면 현재 카드 구성이 새 아이템 분석으로 교체됩니다.
      </p>
      <div className="item-scenario-toggle" role="group" aria-label="아이템 조건 유형">
        <button
          aria-pressed={itemScenario === 'championPresence'}
          onClick={() => setItemScenario('championPresence')}
        >
          <b>상대 챔피언 기준</b>
          <span>상대 조합에 특정 챔피언이 있을 때</span>
        </button>
        <button
          aria-pressed={itemScenario === 'enemyPurchase'}
          onClick={() => setItemScenario('enemyPurchase')}
        >
          <b>상대 구매 기준</b>
          <span>상대가 특정 아이템을 샀을 때</span>
        </button>
      </div>

      {itemScenario === 'championPresence' ? (
        <>
          <ChampionMultiSelect
            selected={counterChampions}
            champions={champions}
            onChange={setCounterChampions}
          />
          <div className="picker-response-section">
            <div className="picker-fields">
              <label>
                <span>판정 기준</span>
                <select
                  aria-label="추가할 대응 아이템 판정 기준"
                  value={counterItemBasis}
                  onChange={(event) => {
                    const basis = event.target.value as NonNullable<
                      CounterItemSelection['itemBasis']
                    >;
                    setCounterItemBasis(basis);
                    if (basis !== 'wholeMatch' && counterTeamItemMode === 'all')
                      setCounterTeamItemMode('any');
                    if (basis !== 'wholeMatch' && counterTeamItemMode === 'notAll')
                      setCounterTeamItemMode('none');
                  }}
                >
                  <option value="ownedAt">시점에 보유 중</option>
                  <option value="purchasedBy">시점까지 구매함</option>
                  <option value="wholeMatch">경기 중 한 번이라도 구매</option>
                </select>
              </label>
              {counterItemBasis !== 'wholeMatch' && (
                <label>
                  <span>판정 시점</span>
                  <span className="number-with-unit">
                    <input
                      aria-label="추가할 대응 아이템 판정 시점"
                      type="number"
                      min={0}
                      max={90}
                      value={counterItemMinute}
                      onChange={(event) =>
                        setCounterItemMinute(
                          Math.max(0, Math.min(90, Number(event.target.value) || 0)),
                        )
                      }
                    />
                    분
                  </span>
                </label>
              )}
            </div>
            <label>
              <span>우리 팀은 선택 아이템을</span>
              <select
                aria-label="추가할 우리 팀 대응 아이템 구매 방식"
                value={counterTeamItemMode}
                onChange={(event) =>
                  setCounterTeamItemMode(event.target.value as CounterItemSelection['teamMode'])
                }
              >
                <option value="any">하나 이상 구매</option>
                {counterItemBasis === 'wholeMatch' && <option value="all">모두 구매</option>}
                <option value="none">하나도 구매 안 함</option>
                {counterItemBasis === 'wholeMatch' && (
                  <option value="notAll">전부 구매하진 않음</option>
                )}
              </select>
            </label>
            <ItemMultiSelect
              label="확인할 우리 팀 아이템"
              prefix="추가할 우리 팀 대응 아이템"
              selected={counterTeamItems}
              items={items}
              onChange={setCounterTeamItems}
            />
          </div>
          <button
            className="picker-primary"
            disabled={!counterChampions.length || !counterTeamItems.length}
            onClick={() =>
              finish(() =>
                onCreateCounterItem({
                  champions: counterChampions,
                  teamMode: counterTeamItemMode,
                  teamItems: counterTeamItems,
                  itemBasis: counterItemBasis,
                  atSeconds: counterItemMinute * 60,
                }),
              )
            }
          >
            아이템 조건 만들기
          </button>
        </>
      ) : (
        <>
          <div className="picker-fields">
            <label>
              <span>판정 기준</span>
              <select
                aria-label="추가할 아이템 대응 판정 기준"
                value={itemBasis}
                onChange={(event) => {
                  const basis = event.target.value as NonNullable<
                    ItemResponseSelection['itemBasis']
                  >;
                  setItemBasis(basis);
                  if (basis !== 'wholeMatch' && opponentItemMode === 'all')
                    setOpponentItemMode('any');
                  if (basis !== 'wholeMatch' && opponentItemMode === 'notAll')
                    setOpponentItemMode('none');
                  if (basis !== 'wholeMatch' && teamItemMode === 'notAll') setTeamItemMode('none');
                }}
              >
                <option value="ownedAt">시점에 보유 중</option>
                <option value="purchasedBy">시점까지 구매함</option>
                <option value="wholeMatch">경기 중 한 번이라도 구매</option>
              </select>
            </label>
            {itemBasis !== 'wholeMatch' && (
              <label>
                <span>판정 시점</span>
                <span className="number-with-unit">
                  <input
                    aria-label="추가할 아이템 대응 판정 시점"
                    type="number"
                    min={0}
                    max={90}
                    value={itemMinute}
                    onChange={(event) =>
                      setItemMinute(Math.max(0, Math.min(90, Number(event.target.value) || 0)))
                    }
                  />
                  분
                </span>
              </label>
            )}
          </div>
          <div className="picker-fields">
            <label>
              <span>상대 구매자</span>
              <select
                aria-label="추가할 아이템 대응 상대 구매자"
                value={itemActor}
                onChange={(event) =>
                  setItemActor(event.target.value as ItemResponseSelection['actor'])
                }
              >
                <option value="anyEnemy">상대 팀원 중 한 명 이상</option>
                <option value="champion">특정 상대 챔피언</option>
              </select>
            </label>
            <label>
              <span>상대의 구매 조건</span>
              <select
                aria-label="추가할 상대 아이템 구매 방식"
                value={opponentItemMode}
                onChange={(event) =>
                  setOpponentItemMode(event.target.value as ItemResponseSelection['opponentMode'])
                }
              >
                <option value="any">하나 이상 구매</option>
                {itemBasis === 'wholeMatch' && <option value="all">모두 구매</option>}
                <option value="none">하나도 구매 안 함</option>
                {itemBasis === 'wholeMatch' && <option value="notAll">전부 구매하진 않음</option>}
              </select>
            </label>
          </div>
          {itemActor === 'champion' && (
            <label>
              <span>상대 챔피언</span>
              <select
                aria-label="추가할 아이템 대응 상대 챔피언"
                value={itemChampion}
                onChange={(event) => setItemChampion(event.target.value)}
              >
                {champions.map((champion) => (
                  <option key={champion.id} value={champion.name}>
                    {champion.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ItemMultiSelect
            label="상대 아이템"
            prefix="추가할 상대 아이템"
            selected={opponentItems}
            items={items}
            onChange={setOpponentItems}
          />
          <div className="picker-response-section">
            <label>
              <span>우리 팀은 선택 아이템을</span>
              <select
                aria-label="추가할 우리 팀 아이템 미구매 방식"
                value={teamItemMode}
                onChange={(event) =>
                  setTeamItemMode(event.target.value as ItemResponseSelection['teamMode'])
                }
              >
                <option value="none">하나도 구매 안 함</option>
                {itemBasis === 'wholeMatch' && <option value="notAll">전부 구매하진 않음</option>}
              </select>
            </label>
            <ItemMultiSelect
              label="확인할 우리 팀 아이템"
              prefix="추가할 우리 팀 아이템"
              selected={teamItems}
              items={items}
              onChange={setTeamItems}
            />
          </div>
          <button
            className="picker-primary"
            disabled={
              !items.length ||
              !opponentItems.length ||
              !teamItems.length ||
              (itemActor === 'champion' && !champions.length)
            }
            onClick={() =>
              finish(() =>
                onCreateItemResponse({
                  actor: itemActor,
                  champion: itemChampion,
                  opponentMode: opponentItemMode,
                  opponentItems,
                  teamMode: teamItemMode,
                  teamItems,
                  itemBasis,
                  atSeconds: itemMinute * 60,
                }),
              )
            }
          >
            아이템 조건 만들기
          </button>
        </>
      )}
    </div>
  );
}
