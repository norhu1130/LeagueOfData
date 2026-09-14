import { ROLE_OPTIONS } from '../AnalysisInputs.js';
import type { RosterRelation } from '../../features/roster-analysis.js';
import type { CardLibraryDraftState } from './useCardLibraryDrafts.js';

type Finish = (action: () => void) => void;
type DraftProps<K extends keyof CardLibraryDraftState> = Pick<CardLibraryDraftState, K>;
type ChampionOption = { readonly id: number; readonly name: string };

type ChampionDraftProps = DraftProps<
  | 'rosterChampion'
  | 'setRosterChampion'
  | 'rosterRole'
  | 'setRosterRole'
  | 'rosterRelation'
  | 'setRosterRelation'
  | 'relatedChampion'
  | 'setRelatedChampion'
  | 'relatedRole'
  | 'setRelatedRole'
>;
export interface ChampionAnalysisSelection {
  champion: string;
  role: string;
  relation: RosterRelation | 'none';
  relatedChampion: string;
  relatedRole: string;
}

export function ChampionAnalysisForm({
  champions,
  finish,
  onCreateChampionAnalysis,
  ...draft
}: ChampionDraftProps & {
  champions: readonly ChampionOption[];
  finish: Finish;
  onCreateChampionAnalysis: (selection: ChampionAnalysisSelection) => void;
}) {
  const {
    rosterChampion,
    setRosterChampion,
    rosterRole,
    setRosterRole,
    rosterRelation,
    setRosterRelation,
    relatedChampion,
    setRelatedChampion,
    relatedRole,
    setRelatedRole,
  } = draft;
  return (
    <div className="card-picker__form">
      <span className="picker-step">챔피언 분석</span>
      <h3>누구의 픽 성과를 어떤 관계에서 볼까요?</h3>
      <p>선수 단위 분석으로 전환하고 승률과 표본 수를 함께 반환합니다.</p>
      <p className="picker-replace-note" role="note">
        이 템플릿을 만들면 현재 카드 구성이 새 챔피언 분석으로 교체됩니다.
      </p>
      <label>
        <span>분석할 챔피언</span>
        <select
          aria-label="추가할 분석 대상 챔피언"
          value={rosterChampion}
          onChange={(event) => setRosterChampion(event.target.value)}
        >
          {champions.map((champion) => (
            <option key={champion.id} value={champion.name}>
              {champion.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>포지션</span>
        <select
          aria-label="추가할 분석 대상 포지션"
          value={rosterRole}
          onChange={(event) => setRosterRole(event.target.value)}
        >
          {ROLE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>함께 볼 관계</span>
        <select
          aria-label="추가할 챔피언 관계"
          value={rosterRelation}
          onChange={(event) => setRosterRelation(event.target.value as RosterRelation | 'none')}
        >
          <option value="none">관계 없이 이 픽만</option>
          <option value="opponent_has_champion_in_role">상대 포지션 매치업</option>
          <option value="ally_has_champion">같은 팀 조합</option>
          <option value="opponent_has_champion">상대팀에 포함</option>
        </select>
      </label>
      {rosterRelation !== 'none' && (
        <label>
          <span>관계 챔피언</span>
          <select
            aria-label="추가할 관계 챔피언"
            value={relatedChampion}
            onChange={(event) => setRelatedChampion(event.target.value)}
          >
            {champions.map((champion) => (
              <option key={champion.id} value={champion.name}>
                {champion.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {rosterRelation === 'opponent_has_champion_in_role' && (
        <label>
          <span>상대 포지션</span>
          <select
            aria-label="추가할 관계 챔피언 포지션"
            value={relatedRole}
            onChange={(event) => setRelatedRole(event.target.value)}
          >
            {ROLE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        className="picker-primary"
        disabled={!rosterChampion || (rosterRelation !== 'none' && !relatedChampion)}
        onClick={() =>
          finish(() =>
            onCreateChampionAnalysis({
              champion: rosterChampion,
              role: rosterRole,
              relation: rosterRelation,
              relatedChampion,
              relatedRole,
            }),
          )
        }
      >
        챔피언 분석 만들기
      </button>
    </div>
  );
}
