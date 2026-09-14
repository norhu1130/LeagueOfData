import type { Expr } from '@lol/ast';
import { listSubjectFields, type EventDef } from '@lol/catalog';
import type { RegionDefinition } from '@lol/data-model';
import type { BuilderCard, SyncDocument } from '@lol/visual-builder';
import { counterItemSelection, itemResponseSelection } from '@lol/validate';
import type { ItemOption } from './AnalysisInputs.js';
import {
  durationEventLabel,
  durationMeasureSelection,
  locationEventSide,
  locationEventType,
} from '../features/analysis-dsl.js';
import { GRIEVOUS_WOUNDS_ITEMS } from '../features/analysis-options.js';
import { CHAMPION_METRICS, championMetricSelection } from '../features/champion-analysis.js';
import {
  playerRosterLabelKo,
  playerRosterSelection,
  rosterRelationLabelKo,
  rosterRelationSelection,
} from '../features/roster-analysis.js';
import { AGGREGATE_OPTIONS, subjectAggregateSelection } from '../features/statistics.js';

export function getCardDisplayLabel({
  card,
  sync,
  events,
  regions,
  items,
}: {
  card: BuilderCard;
  sync: SyncDocument;
  events: readonly EventDef[];
  regions: readonly RegionDefinition[];
  items: readonly ItemOption[];
}): string {
  if (card.type === 'condition') {
    const player = playerRosterSelection(card.node as Expr);
    if (player) return playerRosterLabelKo(player);
    const relation = rosterRelationSelection(card.node as Expr);
    if (relation) return rosterRelationLabelKo(relation);
  }
  const itemResponse =
    card.type === 'itemResponse' ? itemResponseSelection(card.node as Expr) : null;
  const counterItem = card.type === 'counterItem' ? counterItemSelection(card.node as Expr) : null;
  const options = [
    ...items,
    ...GRIEVOUS_WOUNDS_ITEMS.filter((item) => !items.some((candidate) => candidate.id === item.id)),
  ].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const itemName = (itemId: number) =>
    options.find((item) => item.id === itemId)?.name ?? `아이템 #${itemId}`;
  if (counterItem) {
    const mode = {
      any: '중 하나 이상 구매',
      all: '모두 구매',
      none: '하나도 구매하지 않음',
      notAll: '전부 구매하지는 않음',
    }[counterItem.teamMode];
    const time =
      (counterItem.itemBasis ?? 'wholeMatch') !== 'wholeMatch'
        ? `${Math.floor((counterItem.atSeconds ?? 900) / 60)}분 ${counterItem.itemBasis === 'purchasedBy' ? '까지' : '시점'}`
        : '경기 전체';
    return `상대 ${counterItem.champions.join(', ')} 중 하나 · ${time} 우리 팀 ${counterItem.teamItems.map(itemName).join(', ')} ${mode}`;
  }
  if (itemResponse)
    return `${itemResponse.actor === 'champion' ? `상대 ${itemResponse.champion}` : '상대 팀원 중 한 명 이상'} · ${itemResponse.opponentItems.map(itemName).join(', ')} · 우리 팀 ${itemResponse.teamItems.map(itemName).join(', ')}`;
  if (card.node.kind === 'ReturnItem') {
    const duration = durationMeasureSelection(card.node);
    if (duration)
      return `결과: ${durationEventLabel(duration.start, events)} → ${durationEventLabel(duration.end, events)} 평균 시간`;
    const championMetric = championMetricSelection(card.node);
    if (championMetric)
      return `결과: ${championMetric.champion} ${CHAMPION_METRICS.find((metric) => metric.id === championMetric.metric)?.label ?? '챔피언 지표'}`;
    const aggregate = subjectAggregateSelection(card.node);
    if (aggregate) {
      const fields = listSubjectFields(
        sync.ast.analyze?.entity === 'match' ||
          sync.ast.analyze?.entity === 'team' ||
          sync.ast.analyze?.entity === 'player'
          ? sync.ast.analyze.entity
          : undefined,
      );
      return `결과: ${fields.find((field) => field.id === aggregate.field)?.labelKo ?? aggregate.field} ${AGGREGATE_OPTIONS.find(([id]) => id === aggregate.aggregate)?.[1] ?? ''}`;
    }
  }
  if (card.type === 'location' && card.node.kind === 'SpatialPredicate') {
    const eventId = locationEventType(card.node);
    const side = locationEventSide(card.node);
    const regionId = card.node.target.kind === 'RegionRef' ? card.node.target.name : null;
    const region = regionId ? regions.find((candidate) => candidate.id === regionId) : null;
    const prefix =
      side === 'blue'
        ? '블루팀 '
        : side === 'red'
          ? '레드팀 '
          : side === 'any'
            ? '어느 팀이든 '
            : '분석 대상 팀 ';
    return `${prefix}${events.find((event) => event.id === eventId)?.labelKo ?? '사건'} 위치 · ${region?.label ?? '선택한 영역'}`;
  }
  return card.labelKo;
}
