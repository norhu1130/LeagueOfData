import type { Ordinal } from '@lol/ast';
import type { CounterItemSelection, ItemResponseSelection } from '@lol/validate';
import { useEffect, useState } from 'react';
import type { ItemOption } from '../AnalysisInputs.js';
import { FRAME_METRIC_OPTIONS } from '../../features/analysis-options.js';
import type { EventScopeChoice } from '../../features/analysis-dsl.js';
import type { RosterRelation } from '../../features/roster-analysis.js';

interface ChampionOption {
  readonly id: number;
  readonly name: string;
}

export function useCardLibraryDrafts(
  champions: readonly ChampionOption[],
  items: readonly ItemOption[],
) {
  const [eventId, setEventId] = useState('first_blood');
  const [eventOrdinal, setEventOrdinal] = useState<Ordinal>('any');
  const [eventSide, setEventSide] = useState<EventScopeChoice>('target');
  const [eventOccurred, setEventOccurred] = useState(true);
  const [eventRegion, setEventRegion] = useState('');
  const [eventDeathRoles, setEventDeathRoles] = useState<string[]>([]);
  const [eventDeathRoleMode, setEventDeathRoleMode] = useState<'any' | 'all'>('any');
  const [positionEventId, setPositionEventId] = useState('death');
  const [positionOrdinal, setPositionOrdinal] = useState<Ordinal>('any');
  const [positionSide, setPositionSide] = useState<EventScopeChoice>('target');
  const [regionId, setRegionId] = useState('top_lane');
  const [goldMinute, setGoldMinute] = useState(10);
  const [goldThreshold, setGoldThreshold] = useState(1500);
  const [numericMetric, setNumericMetric] =
    useState<(typeof FRAME_METRIC_OPTIONS)[number][0]>('gold_diff');
  const [startEventId, setStartEventId] = useState('kill');
  const [endEventId, setEndEventId] = useState('dragon_kill');
  const [startOrdinal, setStartOrdinal] = useState<Ordinal>('any');
  const [endOrdinal, setEndOrdinal] = useState<Ordinal>('any');
  const [startEventSide, setStartEventSide] = useState<EventScopeChoice>('target');
  const [endEventSide, setEndEventSide] = useState<EventScopeChoice>('target');
  const [endDeathRoles, setEndDeathRoles] = useState<string[]>([]);
  const [endDeathRoleMode, setEndDeathRoleMode] = useState<'any' | 'all'>('any');
  const [windowSeconds, setWindowSeconds] = useState(90);
  const [rosterChampion, setRosterChampion] = useState(champions[0]?.name ?? 'Ahri');
  const [rosterRole, setRosterRole] = useState('MID');
  const [rosterRelation, setRosterRelation] = useState<RosterRelation | 'none'>('none');
  const [relatedChampion, setRelatedChampion] = useState(champions[1]?.name ?? 'LeBlanc');
  const [relatedRole, setRelatedRole] = useState('MID');
  const [itemChampion, setItemChampion] = useState(champions[0]?.name ?? 'Aatrox');
  const [itemScenario, setItemScenario] = useState<'championPresence' | 'enemyPurchase'>(
    'championPresence',
  );
  const [counterChampions, setCounterChampions] = useState<string[]>([
    champions[0]?.name ?? 'Aatrox',
  ]);
  const [counterTeamItemMode, setCounterTeamItemMode] =
    useState<CounterItemSelection['teamMode']>('none');
  const [counterTeamItems, setCounterTeamItems] = useState<number[]>([items[0]?.id ?? 0]);
  const [counterItemBasis, setCounterItemBasis] =
    useState<NonNullable<CounterItemSelection['itemBasis']>>('ownedAt');
  const [counterItemMinute, setCounterItemMinute] = useState(15);
  const [itemActor, setItemActor] = useState<ItemResponseSelection['actor']>('anyEnemy');
  const [itemBasis, setItemBasis] =
    useState<NonNullable<ItemResponseSelection['itemBasis']>>('ownedAt');
  const [itemMinute, setItemMinute] = useState(15);
  const [opponentItemMode, setOpponentItemMode] =
    useState<ItemResponseSelection['opponentMode']>('any');
  const [opponentItems, setOpponentItems] = useState<number[]>([items[0]?.id ?? 0]);
  const [teamItemMode, setTeamItemMode] = useState<ItemResponseSelection['teamMode']>('none');
  const [teamItems, setTeamItems] = useState<number[]>([items[1]?.id ?? items[0]?.id ?? 0]);

  useEffect(() => {
    if (!champions.some((champion) => champion.name === itemChampion) && champions[0])
      setItemChampion(champions[0].name);
    if (!champions.some((champion) => champion.name === rosterChampion) && champions[0])
      setRosterChampion(champions[0].name);
    if (!champions.some((champion) => champion.name === relatedChampion) && champions[0])
      setRelatedChampion(champions[1]?.name ?? champions[0].name);
    if (!opponentItems.some((id) => items.some((item) => item.id === id)) && items[0])
      setOpponentItems([items[0].id]);
    if (!teamItems.some((id) => items.some((item) => item.id === id)) && items[0])
      setTeamItems([items[1]?.id ?? items[0].id]);
    if (
      champions[0] &&
      !counterChampions.some((name) => champions.some((champion) => champion.name === name))
    )
      setCounterChampions([champions[0].name]);
    if (!counterTeamItems.some((id) => items.some((item) => item.id === id)) && items[0])
      setCounterTeamItems([items[0].id]);
  }, [
    champions,
    counterChampions,
    counterTeamItems,
    itemChampion,
    items,
    opponentItems,
    relatedChampion,
    rosterChampion,
    teamItems,
  ]);

  return {
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
    positionEventId,
    setPositionEventId,
    positionOrdinal,
    setPositionOrdinal,
    positionSide,
    setPositionSide,
    regionId,
    setRegionId,
    goldMinute,
    setGoldMinute,
    goldThreshold,
    setGoldThreshold,
    numericMetric,
    setNumericMetric,
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
  };
}

export type CardLibraryDraftState = ReturnType<typeof useCardLibraryDrafts>;
