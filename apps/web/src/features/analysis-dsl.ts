import type {
  ChainClause,
  EventPredicate,
  EventRef,
  Expr,
  Ordinal,
  Program,
  ReturnItem,
  SpatialPredicate,
} from '@lol/ast';
import { catalog, type EventDef } from '@lol/catalog';
import { parse } from '@lol/dsl';
import { createSyncDocument, type SyncDocument } from '@lol/visual-builder';
import type { CounterItemSelection, ItemResponseSelection } from '@lol/validate';

export type EventScopeChoice = 'target' | 'blue' | 'red' | 'any' | 'opponent';
export type ItemResponseDraft = ItemResponseSelection & { readonly champion?: string };

export function parsedProgram(source: string): Program {
  const result = parse(source);
  if (!result.ast || result.diagnostics.some((item) => item.severity === 'error'))
    throw new Error('카드 선택을 분석 문장으로 바꾸지 못했습니다.');
  return result.ast;
}

export function eventScopePrefix(scope: EventScopeChoice): string {
  if (scope === 'target') return '';
  if (scope === 'any') return 'team.';
  if (scope === 'opponent') return 'opponent.';
  return `${scope}.`;
}

export function eventSource(event: string, ordinal: Ordinal = 'any'): string {
  const occurrence =
    typeof ordinal === 'number'
      ? String(ordinal)
      : ordinal === 'first'
        ? '1'
        : ordinal === 'last'
          ? 'last'
          : null;
  return `${event}${occurrence !== null ? `[${occurrence}]` : ''}`;
}

export function eventFamilyId(eventId: string): string {
  return catalog.events[eventId]?.variantOf ?? eventId;
}

export function dragonVariantValue(eventId: string): string {
  return catalog.events[eventId]?.qualifierValue ?? '';
}

export function dragonEventId(value: string): string {
  if (!value) return 'dragon_kill';
  return (
    catalog.events.dragon_kill?.qualifiers?.[0]?.options.find((option) => option.value === value)
      ?.eventId ?? 'dragon_kill'
  );
}

export function eventPredicate(
  eventSide: EventScopeChoice,
  event: string,
  ordinal: Ordinal = 'any',
): EventPredicate {
  const scope = catalog.events[event]?.context.includes('team') ? eventScopePrefix(eventSide) : '';
  const program = parsedProgram(
    `ANALYZE blue WHEN ${scope}${eventSource(event, ordinal)} RETURN blue.win_rate`,
  );
  if (program.body.kind !== 'SimpleStmt' || program.body.when?.kind !== 'EventPredicate')
    throw new Error('사건 조건을 만들지 못했습니다.');
  return program.body.when;
}

export function eventCardCondition(
  eventSide: EventScopeChoice,
  event: string,
  ordinal: Ordinal = 'any',
  occurred = true,
  region?: string,
): Expr {
  const scope = catalog.events[event]?.context.includes('team') ? eventScopePrefix(eventSide) : '';
  const ref = `${scope}${eventSource(event, ordinal)}`;
  const occurrence = occurred ? ref : `NOT ${ref}`;
  const location =
    occurred && region ? ` AND ${ref}.position IN region(${JSON.stringify(region)})` : '';
  const program = parsedProgram(`ANALYZE blue WHEN ${occurrence}${location} RETURN blue.win_rate`);
  if (program.body.kind !== 'SimpleStmt' || !program.body.when)
    throw new Error('사건 조건 카드를 만들지 못했습니다.');
  return program.body.when;
}

export function returnItem(side: 'blue' | 'red', expression: string): ReturnItem {
  const program = parsedProgram(`ANALYZE ${side} RETURN ${expression}`);
  const item = program.body.returns[0];
  if (!item) throw new Error('결과 측정값을 만들지 못했습니다.');
  return item;
}

export interface DurationMeasureSelection {
  readonly start: EventRef;
  readonly end: EventRef;
}

export function durationMeasureSelection(item: ReturnItem): DurationMeasureSelection | null {
  if (item.expr.kind !== 'CallExpr' || item.expr.callee !== 'avg' || item.expr.args.length !== 1) {
    return null;
  }
  const duration = item.expr.args[0];
  if (
    duration?.kind !== 'CallExpr' ||
    duration.callee !== 'duration' ||
    duration.args.length !== 2
  ) {
    return null;
  }
  const [start, end] = duration.args;
  return start?.kind === 'EventRef' && end?.kind === 'EventRef' ? { start, end } : null;
}

export function durationEventSource(
  eventId: string,
  ordinal: Ordinal,
  targetSide: 'blue' | 'red' | undefined,
): string {
  const definition = catalog.events[eventId];
  const scope = definition?.context.includes('team') && targetSide ? `${targetSide}.` : '';
  const resolvedOrdinal = !definition?.atMostOncePerMatch && ordinal === 'any' ? 1 : ordinal;
  const firstAlias =
    resolvedOrdinal === 'first' || resolvedOrdinal === 1
      ? Object.entries(definition?.aliases ?? {}).find(
          ([, alias]) => alias.ordinal === 'first',
        )?.[0]
      : undefined;
  return `${scope}${firstAlias ?? eventSource(eventId, resolvedOrdinal)}`;
}

export function durationEventLabel(ref: EventRef, events: readonly EventDef[]): string {
  const definition =
    events.find((event) => event.id === ref.eventType) ?? catalog.events[ref.eventType];
  const label = definition?.labelKo ?? ref.eventType;
  if (definition?.atMostOncePerMatch) return label;
  if (ref.ordinal === 'last') return `마지막 ${label}`;
  if (ref.ordinal === 'first' || ref.ordinal === 1) return `첫 번째 ${label}`;
  if (typeof ref.ordinal === 'number') return `${ref.ordinal}번째 ${label}`;
  return label;
}

export function documentFromDsl(dsl: string): SyncDocument {
  const parsed = parse(dsl);
  if (!parsed.ast || parsed.diagnostics.some((item) => item.severity === 'error'))
    throw new Error('기본 분석을 읽을 수 없습니다');
  return createSyncDocument(parsed.ast, dsl);
}

export function conditionFromDsl(
  side: 'blue' | 'red',
  condition: string,
): NonNullable<Extract<Program['body'], { kind: 'SimpleStmt' }>['when']> {
  const program = parsedProgram(`ANALYZE ${side} WHEN ${condition} RETURN ${side}.win_rate`);
  if (program.body.kind !== 'SimpleStmt' || !program.body.when)
    throw new Error('조건 카드를 만들지 못했습니다.');
  return program.body.when;
}

function itemList(items: readonly number[]): string {
  return items.join(', ');
}

function itemPurchaseDsl(
  ref: string,
  items: readonly number[],
  mode: ItemResponseSelection['opponentMode'],
): string {
  const membership = `${ref}.item IN (${itemList(items)})`;
  if (mode === 'all') return `all_values(${membership})`;
  if (mode === 'none') return `NOT (${membership})`;
  if (mode === 'notAll') return `NOT all_values(${membership})`;
  return membership;
}

export function itemResponseDsl(selection: ItemResponseDraft): string {
  const champion = selection.champion ?? 'Aatrox';
  const basis = selection.itemBasis ?? 'wholeMatch';
  if (basis !== 'wholeMatch') {
    const seconds = selection.atSeconds ?? 900;
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const fn = basis === 'ownedAt' ? 'owns_item_at' : 'purchased_item_by';
    const timed = (
      scope: 'player' | 'opponent' | '',
      values: readonly number[],
      mode: ItemResponseSelection['opponentMode'],
    ) => {
      const prefix = scope ? `${scope}.` : '';
      const anyCall = `${prefix}${fn}(${clock}, ${itemList(values)})`;
      if (mode === 'none') return `NOT ${anyCall}`;
      const every = values.map((value) => `${prefix}${fn}(${clock}, ${value})`).join(' AND ');
      if (mode === 'all') return `(${every})`;
      if (mode === 'notAll') return `NOT (${every})`;
      return anyCall;
    };
    const opponentCondition = timed(
      selection.actor === 'champion' ? 'player' : 'opponent',
      selection.opponentItems,
      selection.opponentMode,
    );
    const teamCondition = timed(
      selection.actor === 'champion' ? 'opponent' : '',
      selection.teamItems,
      selection.teamMode,
    );
    return `ANALYZE ${selection.actor === 'champion' ? 'player' : 'team'}
WHEN ${selection.actor === 'champion' ? `player.champion = ${JSON.stringify(champion)}\n  AND ` : ''}${opponentCondition}
  AND ${teamCondition}
RETURN ${selection.actor === 'champion' ? 'loss_rate()' : 'win_rate()'} AS our_win_rate,
  count() AS sample_size`;
  }
  const actorCondition =
    selection.actor === 'champion'
      ? `player.champion = ${JSON.stringify(champion)}\n  AND ${itemPurchaseDsl('player.item_purchase', selection.opponentItems, selection.opponentMode)}\n  AND `
      : '';
  const opponentFor = (side: 'blue' | 'red') =>
    selection.actor === 'champion'
      ? ''
      : ` AND ${itemPurchaseDsl(`${side}.item_purchase`, selection.opponentItems, selection.opponentMode)}`;
  const teamCondition = itemPurchaseDsl('item_purchase', selection.teamItems, selection.teamMode);
  return `ANALYZE ${selection.actor === 'champion' ? 'player' : 'team'}
WHEN ${actorCondition}(
    (player.side = "BLUE"${opponentFor('red')} AND ${teamCondition})
    OR
    (player.side = "RED"${opponentFor('blue')} AND ${teamCondition})
  )
RETURN ${selection.actor === 'champion' ? 'loss_rate()' : 'win_rate()'} AS our_win_rate,
  count() AS sample_size`.replaceAll(
    'player.side',
    selection.actor === 'champion' ? 'player.side' : 'team.side',
  );
}

export function itemResponseCondition(selection: ItemResponseDraft): Expr {
  const program = parsedProgram(itemResponseDsl(selection));
  if (program.body.kind !== 'SimpleStmt' || !program.body.when)
    throw new Error('아이템 대응 조건을 만들지 못했습니다.');
  return program.body.when;
}

export function counterItemDsl(selection: CounterItemSelection): string {
  const champions = selection.champions.map((champion) => JSON.stringify(champion)).join(', ');
  const basis = selection.itemBasis ?? 'wholeMatch';
  let itemCondition: string;
  if (basis === 'wholeMatch') {
    itemCondition = itemPurchaseDsl('item_purchase', selection.teamItems, selection.teamMode);
  } else {
    const seconds = selection.atSeconds ?? 900;
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const fn = basis === 'ownedAt' ? 'owns_item_at' : 'purchased_item_by';
    const call = `${fn}(${clock}, ${itemList(selection.teamItems)})`;
    itemCondition = selection.teamMode === 'none' ? `NOT ${call}` : call;
  }
  return `opponent_has_champion(${champions}) AND ${itemCondition}`;
}

export function counterItemCondition(selection: CounterItemSelection): Expr {
  return conditionFromDsl('blue', counterItemDsl(selection));
}

export function locationCondition(
  event: string,
  region: string,
  eventSide: EventScopeChoice = 'target',
  ordinal: Ordinal = 'any',
): SpatialPredicate {
  const scope = eventScopePrefix(eventSide);
  const program = parsedProgram(
    `ANALYZE blue WHEN ${scope}${eventSource(event, ordinal)}.position IN region("${region}") RETURN blue.win_rate`,
  );
  if (program.body.kind !== 'SimpleStmt' || program.body.when?.kind !== 'SpatialPredicate')
    throw new Error('위치 조건 카드를 만들지 못했습니다.');
  return program.body.when;
}

export function locationEventType(predicate: SpatialPredicate): string | null {
  return predicate.position.kind === 'FieldAccess' && predicate.position.object.kind === 'EventRef'
    ? predicate.position.object.eventType
    : null;
}

export function locationEventRef(predicate: SpatialPredicate) {
  return predicate.position.kind === 'FieldAccess' && predicate.position.object.kind === 'EventRef'
    ? predicate.position.object
    : null;
}

export function locationEventSide(predicate: SpatialPredicate): EventScopeChoice {
  if (predicate.position.kind !== 'FieldAccess' || predicate.position.object.kind !== 'EventRef')
    return 'any';
  const side = predicate.position.object.scope?.side;
  if (side === 'blue' || side === 'red') return side;
  return predicate.position.object.scope?.entity === 'team' ? 'any' : 'target';
}

export function chainFromDsl(
  startSide: EventScopeChoice,
  startEvent: string,
  endSide: EventScopeChoice,
  endEvent: string,
  seconds: number,
  startOrdinal: Ordinal = 'any',
  endOrdinal: Ordinal = 'any',
  endRoles: readonly string[] = [],
  endRoleMode: 'any' | 'all' = 'any',
): ChainClause {
  const endRef = `${eventScopePrefix(endSide)}${eventSource(endEvent, endOrdinal)}`;
  const endCondition =
    endEvent === 'death' && endRoles.length ? deathRoleDsl(endRef, endRoles, endRoleMode) : endRef;
  const program = parsedProgram(
    `AFTER ${eventScopePrefix(startSide)}${eventSource(startEvent, startOrdinal)} WITHIN ${seconds}s IF ${endCondition} RETURN success_rate()`,
  );
  if (program.body.kind !== 'SimpleStmt' || !program.body.chain)
    throw new Error('이어지는 사건 카드를 만들지 못했습니다.');
  return program.body.chain;
}

export function eventRefSide(expression: ChainClause['trigger']): EventScopeChoice {
  if (expression.scope?.relation === 'opponent-of-trigger') return 'opponent';
  if (expression.scope?.side === 'blue' || expression.scope?.side === 'red') {
    return expression.scope.side;
  }
  return expression.scope?.entity === 'team' ? 'any' : 'target';
}

export function chainedEventType(expression: ChainClause['condition']): string | null {
  return chainedEventRef(expression)?.eventType ?? null;
}

export function chainedEventRef(expression: ChainClause['condition']): EventRef | null {
  if (expression?.kind === 'EventRef') return expression;
  if (expression?.kind === 'EventPredicate') return expression.event;
  if (expression?.kind === 'FieldAccess' && expression.object.kind === 'EventRef')
    return expression.object;
  if (expression?.kind === 'InExpr') return chainedEventRef(expression.value);
  if (expression?.kind === 'BinaryExpr')
    return chainedEventRef(expression.left) ?? chainedEventRef(expression.right);
  if (expression?.kind === 'CallExpr' && expression.callee === 'all_values')
    return chainedEventRef(expression.args[0] ?? null);
  return null;
}

export function deathRoleValues(expression: Expr | null): string[] {
  if (!expression) return [];
  if (expression.kind === 'CallExpr' && expression.callee === 'all_values')
    return deathRoleValues(expression.args[0] ?? null);
  if (
    expression.kind === 'InExpr' &&
    expression.value.kind === 'FieldAccess' &&
    expression.value.field === 'role' &&
    expression.value.object.kind === 'EventRef' &&
    expression.value.object.eventType === 'death'
  ) {
    return expression.set.flatMap((item) => (item.kind === 'StringLit' ? [item.value] : []));
  }
  if (
    expression.kind === 'BinaryExpr' &&
    expression.op === '=' &&
    expression.left.kind === 'FieldAccess' &&
    expression.left.field === 'role' &&
    expression.left.object.kind === 'EventRef' &&
    expression.left.object.eventType === 'death' &&
    expression.right.kind === 'StringLit'
  ) {
    return [expression.right.value];
  }
  return [];
}

export function deathRoleMode(expression: Expr | null): 'any' | 'all' {
  return expression?.kind === 'CallExpr' && expression.callee === 'all_values' ? 'all' : 'any';
}

export function deathRoleDsl(ref: string, roles: readonly string[], mode: 'any' | 'all'): string {
  const membership = `${ref}.role IN (${roles.map((role) => `"${role}"`).join(', ')})`;
  return mode === 'all' ? `all_values(${membership})` : membership;
}

export function teamPrompt(eventId: string | null): string {
  const perspective = eventId ? catalog.events[eventId]?.teamPerspective : null;
  if (perspective === 'victim') return '사망한 선수의 팀';
  if (perspective === 'owner') return '소유한 팀';
  if (perspective === 'affected') return '영향받은 팀';
  return '사건을 일으킨 팀';
}
