/**
 * Visual-builder representability (§28).
 *
 * Unsupported DSL must not destroy the builder. Supported fragments become cards and unsupported
 * subtrees remain intact as locked advanced cards.
 *
 * This module alone defines the boundary so projection and coverage cannot disagree.
 */
import { type Expr, type Node, type Program, type Span } from '@lol/ast';
import { catalog } from '@lol/catalog';

export type UnsupportedReason =
  | 'unsupported_target'
  | 'event_modifiers'
  | 'or_at_top_level'
  | 'nested_logic'
  | 'arithmetic'
  | 'unknown_function'
  | 'too_many_returns'
  | 'too_many_group_keys'
  | 'unsupported_temporal'
  | 'unsupported_spatial'
  | 'unsupported_condition'
  | 'unsupported_sequence'
  | 'unsupported_group'
  | 'compare_arms'
  | 'unknown_node';

export interface UnsupportedFragment {
  readonly reason: UnsupportedReason;
  readonly reasonKo: string;
  readonly span: Span | null;
  /** Fragment printed verbatim in a locked card. */
  readonly node: Node;
}

export interface Coverage {
  /** Whether the entire analysis is card-representable. */
  readonly full: boolean;
  readonly unsupported: readonly UnsupportedFragment[];
  /** Conditions representable as cards at the top-level AND chain. */
  readonly conditions: readonly Expr[];
}

export interface ItemResponseSelection {
  readonly actor: 'champion' | 'anyEnemy';
  readonly champion?: string;
  readonly opponentMode: 'any' | 'all' | 'none' | 'notAll';
  readonly opponentItems: readonly number[];
  readonly teamMode: 'none' | 'notAll';
  readonly teamItems: readonly number[];
  /** Omitted for legacy whole-match purchase cards. */
  readonly itemBasis?: 'wholeMatch' | 'purchasedBy' | 'ownedAt';
  readonly atSeconds?: number;
}

/** A roster threat and the response items the analyzed team did not buy. */
export interface CounterItemSelection {
  readonly champions: readonly string[];
  readonly teamMode: 'any' | 'all' | 'none' | 'notAll';
  readonly teamItems: readonly number[];
  /** Omitted for legacy whole-match purchase cards. */
  readonly itemBasis?: 'wholeMatch' | 'purchasedBy' | 'ownedAt';
  readonly atSeconds?: number;
}

export interface EventCardSelection {
  readonly event: Extract<Expr, { kind: 'EventRef' }>;
  readonly occurred: boolean;
  readonly region?: string;
}

/** Builder limits; exceeding one enters advanced DSL state. */
export const BUILDER_LIMITS = {
  maxReturns: 6,
  maxGroupKeys: 2,
  maxCompareArms: 2,
} as const;

const REASON_KO: Record<UnsupportedReason, string> = {
  unsupported_target: '이 분석 대상은 아직 카드로 편집할 수 없습니다.',
  event_modifiers: '부정, 순서, 범위가 있는 사건은 고급 조건으로 보존됩니다.',
  or_at_top_level: '“또는” 조건은 아직 카드로 편집할 수 없습니다.',
  nested_logic: '괄호로 묶인 복합 조건은 아직 카드로 편집할 수 없습니다.',
  arithmetic: '값끼리 계산하는 식은 아직 카드로 편집할 수 없습니다.',
  unknown_function: '카드가 모르는 측정값입니다.',
  too_many_returns: `결과는 카드에서 ${BUILDER_LIMITS.maxReturns}개까지 다룰 수 있습니다.`,
  too_many_group_keys: `분류 기준은 카드에서 ${BUILDER_LIMITS.maxGroupKeys}개까지 다룰 수 있습니다.`,
  unsupported_temporal: '이 시간 조건은 아직 카드로 편집할 수 없습니다.',
  unsupported_spatial: '이 위치 조건은 아직 카드로 편집할 수 없습니다.',
  unsupported_condition: '이 조건은 아직 카드로 편집할 수 없습니다.',
  unsupported_sequence: '이 사건 연결은 현재 카드가 표현하는 형태보다 복잡합니다.',
  unsupported_group: '이 분류 기준은 아직 카드로 편집할 수 없습니다.',
  compare_arms: `비교는 카드에서 ${BUILDER_LIMITS.maxCompareArms}개까지 다룰 수 있습니다.`,
  unknown_node: '카드가 모르는 조건입니다.',
};

const fragment = (reason: UnsupportedReason, node: Node): UnsupportedFragment => ({
  reason,
  reasonKo: REASON_KO[reason],
  span: node.span ?? null,
  node,
});

export function coverage(program: Program): Coverage {
  const unsupported: UnsupportedFragment[] = [];
  const conditions: Expr[] = [];
  const body = program.body;
  const effectiveSide = program.analyze?.side;

  if (
    program.analyze &&
    ((program.analyze.entity !== 'team' &&
      program.analyze.entity !== 'match' &&
      program.analyze.entity !== 'player') ||
      program.analyze.relation !== undefined ||
      (program.analyze.side !== undefined &&
        program.analyze.side !== 'blue' &&
        program.analyze.side !== 'red'))
  ) {
    unsupported.push(fragment('unsupported_target', program.analyze));
  }

  if (body.kind === 'CompareStmt') {
    for (const arm of body.arms.slice(BUILDER_LIMITS.maxCompareArms)) {
      unsupported.push(fragment('compare_arms', arm));
    }
    for (const arm of body.arms) {
      if (!isEditableCompareArm(arm.when)) unsupported.push(fragment('unsupported_condition', arm));
      else conditions.push(arm.when);
    }
  } else {
    if (body.when) collectConditions(body.when, conditions, unsupported, effectiveSide);
    if (body.chain) {
      if (!isEditableChain(body.chain)) {
        unsupported.push(fragment('unsupported_sequence', body.chain));
      } else if (body.chain.condition) {
        conditions.push(body.chain.condition);
      }
    }
  }

  for (const group of body.groupBy.slice(BUILDER_LIMITS.maxGroupKeys)) {
    unsupported.push(fragment('too_many_group_keys', group));
  }
  for (const group of body.groupBy) {
    const builderGrain =
      body.kind === 'SimpleStmt' && body.chain
        ? 'event'
        : program.analyze?.entity === 'player'
          ? 'player'
          : 'team';
    if (!isEditableGroup(group, builderGrain)) {
      unsupported.push(fragment('unsupported_group', group));
    }
  }
  for (const item of body.returns.slice(BUILDER_LIMITS.maxReturns)) {
    unsupported.push(fragment('too_many_returns', item));
  }
  for (const item of body.returns) {
    if (!isSupportedReturn(item.expr, effectiveSide)) {
      unsupported.push(fragment('unknown_function', item));
    }
  }

  return { full: unsupported.length === 0, unsupported, conditions };
}

/**
 * Expands the top-level AND chain into cards. An OR or nested unsupported expression becomes one
 * complete advanced fragment so card edits cannot change hidden semantics.
 */
function collectConditions(
  expr: Expr,
  conditions: Expr[],
  unsupported: UnsupportedFragment[],
  effectiveSide?: 'blue' | 'red',
): void {
  if (
    itemResponseSelection(expr) ||
    counterItemSelection(expr) ||
    eventCardSelection(expr, effectiveSide)
  ) {
    conditions.push(expr);
    return;
  }
  if (expr.kind === 'BinaryExpr' && expr.op === 'AND') {
    collectConditions(expr.left, conditions, unsupported, effectiveSide);
    collectConditions(expr.right, conditions, unsupported, effectiveSide);
    return;
  }

  const reason = unsupportedReason(expr);
  if (reason) {
    unsupported.push(fragment(reason, expr));
    return;
  }
  conditions.push(expr);
}

/** Returns whether one condition is card-representable and, if not, why. */
function unsupportedReason(expr: Expr): UnsupportedReason | null {
  if (itemResponseSelection(expr) || counterItemSelection(expr) || eventCardSelection(expr))
    return null;
  switch (expr.kind) {
    case 'EventPredicate':
      return isEditableEventPredicate(expr) ? null : 'event_modifiers';

    case 'SpatialPredicate':
      // The current card edits only a named-region target.
      return expr.relation === 'IN_REGION' &&
        expr.target.kind === 'RegionRef' &&
        expr.position.kind === 'FieldAccess' &&
        expr.position.field === 'position' &&
        expr.position.object.kind === 'EventRef' &&
        isEditableEventRef(expr.position.object)
        ? null
        : 'unsupported_spatial';

    case 'BinaryExpr': {
      if (expr.op === 'OR') return 'or_at_top_level';
      if (expr.op === 'AND') return 'nested_logic';
      if (['+', '-', '*', '/', '%'].includes(expr.op)) return 'arithmetic';
      if (isEditableDeathRoleComparison(expr)) return null;
      if (isEditableSubjectComparison(expr)) return null;
      // The current condition card exposes a numeric slot for point-in-time measures only.
      return expr.left.kind === 'MeasureAt' &&
        ['gold_diff', 'xp_diff', 'kill_diff'].includes(expr.left.measure) &&
        (expr.left.scope === null ||
          expr.left.scope.entity === 'player' ||
          (expr.left.scope.entity === 'team' &&
            (expr.left.scope.side === undefined ||
              expr.left.scope.side === 'blue' ||
              expr.left.scope.side === 'red'))) &&
        ['>', '>=', '<', '<='].includes(expr.op) &&
        expr.right.kind === 'NumberLit'
        ? null
        : 'unsupported_condition';
    }

    case 'TemporalPredicate':
      // Sequence cards edit ChainClause, not standalone temporal predicates.
      return 'unsupported_temporal';

    case 'UnaryExpr':
      return expr.op === 'NOT' ? 'nested_logic' : 'arithmetic';

    case 'InExpr':
      return isEditableDeathRoleMembership(expr) ? null : 'unsupported_condition';

    case 'CallExpr':
      return isEditableAllValues(expr) || isEditableRosterCondition(expr)
        ? null
        : 'unknown_function';

    case 'ErrorExpr':
      return 'unknown_node';

    default:
      return 'unknown_node';
  }
}

/** Groups an event occurrence and its named-region qualifier into one editable card. */
export function eventCardSelection(
  expr: Expr,
  targetSide?: 'blue' | 'red',
): EventCardSelection | null {
  if (expr.kind === 'EventPredicate' && isEditableEventRef(expr.event)) {
    return { event: expr.event, occurred: !expr.negated };
  }
  if (expr.kind !== 'BinaryExpr' || expr.op !== 'AND') return null;
  const parts = [expr.left, expr.right];
  const occurrence = parts.find((part) => part.kind === 'EventPredicate');
  const spatial = parts.find((part) => part.kind === 'SpatialPredicate');
  if (
    !occurrence ||
    occurrence.kind !== 'EventPredicate' ||
    !spatial ||
    spatial.kind !== 'SpatialPredicate' ||
    occurrence.negated ||
    spatial.relation !== 'IN_REGION' ||
    spatial.target.kind !== 'RegionRef' ||
    spatial.position.kind !== 'FieldAccess' ||
    spatial.position.field !== 'position' ||
    spatial.position.object.kind !== 'EventRef' ||
    !sameEventCardReference(occurrence.event, spatial.position.object, targetSide) ||
    !isEditableEventRef(occurrence.event)
  )
    return null;
  return { event: occurrence.event, occurred: true, region: spatial.target.name };
}

function sameEventCardReference(
  left: Extract<Expr, { kind: 'EventRef' }>,
  right: Extract<Expr, { kind: 'EventRef' }>,
  targetSide?: 'blue' | 'red',
): boolean {
  if (left.eventType !== right.eventType || left.ordinal !== right.ordinal) return false;
  if (left.bindingId === right.bindingId) return true;
  if (!targetSide) return false;
  const side = (event: typeof left) =>
    event.scope?.entity === 'team' ? (event.scope.side ?? 'any') : targetSide;
  return side(left) === side(right);
}

function andParts(expr: Expr): Expr[] {
  return expr.kind === 'BinaryExpr' && expr.op === 'AND'
    ? [...andParts(expr.left), ...andParts(expr.right)]
    : [expr];
}

function subjectValue(expr: Expr, field: string): string | null {
  return expr.kind === 'BinaryExpr' &&
    expr.op === '=' &&
    expr.left.kind === 'FieldAccess' &&
    expr.left.object.kind === 'Identifier' &&
    (expr.left.object.name === 'player' || expr.left.object.name === 'team') &&
    expr.left.field === field &&
    expr.right.kind === 'StringLit'
    ? expr.right.value
    : null;
}

type ItemMode = ItemResponseSelection['opponentMode'];
type ItemScope = 'player' | 'target' | 'opponent' | 'blue' | 'red';

function itemMembership(expr: Expr): {
  mode: ItemMode;
  items: number[];
  scope: ItemScope;
  basis: 'wholeMatch' | 'purchasedBy' | 'ownedAt';
  atSeconds?: number;
} | null {
  let mode: ItemMode = 'any';
  let current = expr;
  if (current.kind === 'UnaryExpr' && current.op === 'NOT') {
    mode = 'none';
    current = current.operand;
  }
  if (current.kind === 'CallExpr' && current.callee === 'all_values' && current.args.length === 1) {
    mode = mode === 'none' ? 'notAll' : 'all';
    current = current.args[0]!;
  }

  let event: Extract<Expr, { kind: 'EventRef' }> | null = null;
  let values: number[] = [];
  if (
    current.kind === 'CallExpr' &&
    (current.callee === 'purchased_item_by' || current.callee === 'owns_item_at') &&
    current.args.length >= 2 &&
    current.args[0]?.kind === 'ClockLit' &&
    current.args.slice(1).every((value) => value.kind === 'NumberLit')
  ) {
    const scope: ItemScope = current.scope?.relation
      ? 'opponent'
      : current.scope?.entity === 'player'
        ? 'player'
        : 'target';
    return {
      mode,
      items: current.args
        .slice(1)
        .map((value) => (value as Extract<Expr, { kind: 'NumberLit' }>).value),
      scope,
      basis: current.callee === 'purchased_item_by' ? 'purchasedBy' : 'ownedAt',
      atSeconds: current.args[0].seconds,
    };
  }
  if (
    current.kind === 'InExpr' &&
    current.value.kind === 'FieldAccess' &&
    current.value.field === 'item' &&
    current.value.object.kind === 'EventRef' &&
    current.value.object.eventType === 'item_purchase' &&
    current.set.every((value) => value.kind === 'NumberLit')
  ) {
    event = current.value.object;
    values = current.set.map((value) => (value as Extract<Expr, { kind: 'NumberLit' }>).value);
  } else if (
    current.kind === 'BinaryExpr' &&
    current.op === '=' &&
    current.left.kind === 'FieldAccess' &&
    current.left.field === 'item' &&
    current.left.object.kind === 'EventRef' &&
    current.left.object.eventType === 'item_purchase' &&
    current.right.kind === 'NumberLit'
  ) {
    event = current.left.object;
    values = [current.right.value];
  }
  if (!event || !values.length) return null;
  const scope: ItemScope =
    event.scope?.entity === 'player'
      ? 'player'
      : event.scope?.side === 'blue' || event.scope?.side === 'red'
        ? event.scope.side
        : 'target';
  return { mode, items: values, scope, basis: 'wholeMatch' };
}

/** Recognizes “any named opponent champion + our missing response items”. */
export function counterItemSelection(expr: Expr): CounterItemSelection | null {
  const parts = andParts(expr);
  if (parts.length !== 2) return null;
  const roster = parts.find(
    (part): part is Extract<Expr, { kind: 'CallExpr' }> =>
      part.kind === 'CallExpr' && part.callee === 'opponent_has_champion',
  );
  const purchase = parts.map(itemMembership).find((value) => value?.scope === 'target') ?? null;
  if (
    !roster ||
    roster.args.length < 1 ||
    roster.args.length > 5 ||
    !roster.args.every((arg) => arg.kind === 'StringLit') ||
    !purchase
  ) {
    return null;
  }
  return {
    champions: roster.args.map((arg) => (arg as Extract<Expr, { kind: 'StringLit' }>).value),
    teamMode: purchase.mode,
    teamItems: purchase.items,
    itemBasis: purchase.basis,
    atSeconds: purchase.atSeconds,
  };
}

function responseBranch(expr: Expr): {
  baseSide: 'BLUE' | 'RED';
  opponent: ReturnType<typeof itemMembership>;
  team: ReturnType<typeof itemMembership>;
} | null {
  const parts = andParts(expr);
  const baseSide = parts.map((part) => subjectValue(part, 'side')).find(Boolean);
  if (baseSide !== 'BLUE' && baseSide !== 'RED') return null;
  const memberships = parts.map(itemMembership).filter((value) => value !== null);
  const enemySide = baseSide === 'BLUE' ? 'red' : 'blue';
  const target = memberships.find((value) => value!.scope === 'target') ?? null;
  const explicitEnemy = memberships.find((value) => value!.scope === enemySide) ?? null;
  const opponent = target ? explicitEnemy : null;
  const team = target ?? explicitEnemy;
  return team ? { baseSide, opponent, team } : null;
}

/** Recognizes the symmetric, both-sides item-response query emitted by the card builder. */
export function itemResponseSelection(expr: Expr): ItemResponseSelection | null {
  const parts = andParts(expr);
  const champion = parts.map((part) => subjectValue(part, 'champion')).find(Boolean);
  const directMemberships = parts.map(itemMembership).filter((value) => value !== null);
  const directOpponent = directMemberships.find((value) =>
    champion ? value!.scope === 'player' : value!.scope === 'opponent',
  );
  const directTeam = directMemberships.find((value) =>
    champion ? value!.scope === 'opponent' : value!.scope === 'target',
  );
  if (
    directOpponent &&
    directTeam &&
    directOpponent.basis !== 'wholeMatch' &&
    directOpponent.basis === directTeam.basis &&
    directOpponent.atSeconds === directTeam.atSeconds &&
    ['none', 'notAll'].includes(directTeam.mode)
  ) {
    return {
      actor: champion ? 'champion' : 'anyEnemy',
      ...(champion ? { champion } : {}),
      opponentMode: directOpponent.mode,
      opponentItems: directOpponent.items,
      teamMode: directTeam.mode as 'none' | 'notAll',
      teamItems: directTeam.items,
      itemBasis: directOpponent.basis,
      atSeconds: directOpponent.atSeconds,
    };
  }
  const sides = parts.find((part) => part.kind === 'BinaryExpr' && part.op === 'OR');
  if (!sides || sides.kind !== 'BinaryExpr') return null;
  const blue = responseBranch(sides.left);
  const red = responseBranch(sides.right);
  if (!blue || !red || blue.baseSide === red.baseSide) return null;

  const same = (
    left: NonNullable<ReturnType<typeof itemMembership>>,
    right: NonNullable<ReturnType<typeof itemMembership>>,
  ) =>
    left.mode === right.mode &&
    left.items.join(',') === right.items.join(',') &&
    left.basis === right.basis &&
    left.atSeconds === right.atSeconds;
  if (!same(blue.team!, red.team!)) return null;
  if (!['none', 'notAll'].includes(blue.team!.mode)) return null;

  if (champion) {
    const playerCondition = parts.map(itemMembership).find((value) => value?.scope === 'player');
    if (!playerCondition) return null;
    return {
      actor: 'champion',
      champion,
      opponentMode: playerCondition.mode,
      opponentItems: playerCondition.items,
      teamMode: blue.team!.mode as 'none' | 'notAll',
      teamItems: blue.team!.items,
      itemBasis: blue.team!.basis,
      atSeconds: blue.team!.atSeconds,
    };
  }
  if (!blue.opponent || !red.opponent || !same(blue.opponent, red.opponent)) return null;
  return {
    actor: 'anyEnemy',
    opponentMode: blue.opponent!.mode,
    opponentItems: blue.opponent!.items,
    teamMode: blue.team!.mode as 'none' | 'notAll',
    teamItems: blue.team!.items,
    itemBasis: blue.team!.basis,
    atSeconds: blue.team!.atSeconds,
  };
}

/** Whether a measure can be rendered by a result card. */
function isSupportedReturn(expr: Expr, effectiveSide: 'blue' | 'red' | undefined): boolean {
  if (expr.kind === 'CallExpr') {
    const fn = catalog.functions[expr.callee];
    if (!fn) return false;
    if (expr.args.length === 0) return isTargetRelativeScope(expr.scope, effectiveSide);
    if (
      ['pick_rate', 'ban_rate', 'champion_win_rate', 'champion_games'].includes(expr.callee) &&
      expr.scope === null &&
      expr.args.length === 1 &&
      expr.args[0]?.kind === 'StringLit'
    )
      return true;
    if (
      expr.callee === 'role_pick_rate' &&
      expr.scope === null &&
      expr.args.length === 2 &&
      expr.args.every((argument) => argument.kind === 'StringLit')
    )
      return true;
    if (
      ['avg', 'median', 'sum', 'min', 'max'].includes(expr.callee) &&
      expr.scope === null &&
      expr.args.length === 1 &&
      expr.args[0]?.kind === 'FieldAccess' &&
      expr.args[0].object.kind === 'Identifier' &&
      Boolean(catalog.subjectFields[expr.args[0].field])
    )
      return true;
    return isEditableDurationReturn(expr, effectiveSide);
  }
  return false;
}

function isEditableEventRef(expr: Extract<Expr, { kind: 'EventRef' }>): boolean {
  return (
    (expr.ordinal === 'any' ||
      expr.ordinal === 'first' ||
      expr.ordinal === 'last' ||
      typeof expr.ordinal === 'number') &&
    expr.surface === expr.eventType &&
    (expr.scope === null ||
      (expr.scope.entity === 'team' &&
        (expr.scope.relation === 'opponent-of-trigger' ||
          expr.scope.side === undefined ||
          expr.scope.side === 'blue' ||
          expr.scope.side === 'red')))
  );
}

function isEditableEventPredicate(expr: Extract<Expr, { kind: 'EventPredicate' }>): boolean {
  return !expr.negated && isEditableEventRef(expr.event);
}

function isEditableCompareArm(expr: Expr): boolean {
  if (expr.kind === 'BinaryExpr' && (expr.op === 'AND' || expr.op === 'OR')) {
    return isEditableCompareArm(expr.left) && isEditableCompareArm(expr.right);
  }
  if (expr.kind === 'UnaryExpr' && expr.op === 'NOT') return isEditableCompareArm(expr.operand);
  if (expr.kind === 'EventPredicate') return isEditableEventRef(expr.event);
  if (expr.kind === 'SpatialPredicate') return unsupportedReason(expr) === null;
  return (
    expr.kind === 'BinaryExpr' &&
    expr.left.kind === 'MeasureAt' &&
    expr.left.measure === 'gold_diff' &&
    expr.right.kind === 'NumberLit' &&
    ['>', '>=', '<', '<='].includes(expr.op) &&
    expr.left.scope?.entity === 'team' &&
    (expr.left.scope.side === 'blue' || expr.left.scope.side === 'red')
  );
}

function isEditableChain(chain: Extract<Node, { kind: 'ChainClause' }>) {
  return (
    chain.window !== null &&
    isEditableEventRef(chain.trigger) &&
    chain.condition !== null &&
    (chain.condition.kind === 'EventPredicate'
      ? isEditableEventPredicate(chain.condition)
      : chain.condition.kind === 'InExpr'
        ? isEditableDeathRoleMembership(chain.condition)
        : chain.condition.kind === 'CallExpr'
          ? isEditableAllValues(chain.condition)
          : chain.condition.kind === 'BinaryExpr' && isEditableDeathRoleComparison(chain.condition))
  );
}

function isDeathRoleField(expr: Expr): boolean {
  return (
    expr.kind === 'FieldAccess' &&
    expr.field === 'role' &&
    expr.object.kind === 'EventRef' &&
    expr.object.eventType === 'death' &&
    isEditableEventRef(expr.object)
  );
}

function isEditableDeathRoleComparison(expr: Extract<Expr, { kind: 'BinaryExpr' }>): boolean {
  return expr.op === '=' && isDeathRoleField(expr.left) && expr.right.kind === 'StringLit';
}

function isEditableSubjectComparison(expr: Extract<Expr, { kind: 'BinaryExpr' }>): boolean {
  return (
    expr.op === '=' &&
    expr.left.kind === 'FieldAccess' &&
    expr.left.object.kind === 'Identifier' &&
    expr.left.object.name === 'player' &&
    (expr.left.field === 'champion' || expr.left.field === 'role') &&
    expr.right.kind === 'StringLit'
  );
}

function isEditableRosterCondition(expr: Extract<Expr, { kind: 'CallExpr' }>): boolean {
  if (
    expr.callee !== 'opponent_has_champion' &&
    expr.callee !== 'ally_has_champion' &&
    expr.callee !== 'opponent_has_champion_in_role'
  )
    return false;
  if (!expr.args.length || !expr.args.every((arg) => arg.kind === 'StringLit')) return false;
  return expr.callee === 'opponent_has_champion_in_role'
    ? expr.args.length === 2
    : expr.args.length === 1;
}

function isEditableDeathRoleMembership(expr: Extract<Expr, { kind: 'InExpr' }>): boolean {
  return (
    !expr.negated &&
    isDeathRoleField(expr.value) &&
    expr.set.length > 0 &&
    expr.set.every((item) => item.kind === 'StringLit')
  );
}

function isEditableAllValues(expr: Extract<Expr, { kind: 'CallExpr' }>): boolean {
  const membership = expr.args[0];
  return (
    expr.callee === 'all_values' &&
    expr.args.length === 1 &&
    membership?.kind === 'InExpr' &&
    isEditableDeathRoleMembership(membership)
  );
}

function isTargetRelativeScope(
  scope: Extract<Expr, { kind: 'CallExpr' }>['scope'],
  side: 'blue' | 'red' | undefined,
): boolean {
  return (
    scope === null || (scope.entity === 'team' && scope.side !== undefined && scope.side === side)
  );
}

function isEditableDurationReturn(
  expr: Extract<Expr, { kind: 'CallExpr' }>,
  side: 'blue' | 'red' | undefined,
): boolean {
  if (expr.callee !== 'avg' || expr.args.length !== 1 || !isTargetRelativeScope(expr.scope, side)) {
    return false;
  }
  const duration = expr.args[0];
  if (
    duration?.kind !== 'CallExpr' ||
    duration.callee !== 'duration' ||
    duration.args.length !== 2
  ) {
    return false;
  }
  const [start, end] = duration.args;
  if (start?.kind !== 'EventRef' || end?.kind !== 'EventRef') return false;
  return (
    isEditableDurationEvent(start) &&
    isEditableDurationEvent(end) &&
    isTargetRelativeEvent(start, side) &&
    isTargetRelativeEvent(end, side)
  );
}

function isEditableDurationEvent(expr: Extract<Expr, { kind: 'EventRef' }>): boolean {
  const definition = catalog.events[expr.eventType];
  const surfaceIsEditable =
    expr.surface === expr.eventType || Object.hasOwn(definition?.aliases ?? {}, expr.surface);
  return Boolean(
    definition?.available &&
    definition.context.includes('time') &&
    definition.context.includes('team') &&
    (expr.ordinal === 'any' ||
      expr.ordinal === 'first' ||
      expr.ordinal === 'last' ||
      typeof expr.ordinal === 'number') &&
    surfaceIsEditable,
  );
}

function isTargetRelativeEvent(
  expr: Extract<Expr, { kind: 'EventRef' }>,
  side: 'blue' | 'red' | undefined,
): boolean {
  return (
    expr.scope === null ||
    (expr.scope.entity === 'team' && expr.scope.side !== undefined && expr.scope.side === side)
  );
}

function isEditableGroup(
  group: Extract<Node, { kind: 'GroupKey' }>,
  grain: 'team' | 'player' | 'event',
): boolean {
  if (group.alias !== null) return false;
  if (
    group.expr.kind === 'FieldAccess' &&
    group.expr.field === 'monster_subtype' &&
    group.expr.object.kind === 'EventRef'
  ) {
    return (
      eventFamilyIdForCoverage(group.expr.object.eventType) === 'dragon_kill' &&
      typeof group.expr.object.ordinal === 'number'
    );
  }
  if (group.expr.kind !== 'Identifier') return false;
  const definition = catalog.groupKeys[group.expr.name];
  return Boolean(definition?.validGrains.includes(grain));
}

function eventFamilyIdForCoverage(eventId: string): string {
  return catalog.events[eventId]?.variantOf ?? eventId;
}
