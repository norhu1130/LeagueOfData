/**
 * Analysis AST: the single source of truth shared by the visual builder and DSL.
 *
 * Four design rules protect builder/DSL synchronization (§28):
 *
 * 1. **Do not store formatting, comments, or parentheses.** The guaranteed round trip is
 *    AST to text to AST, not text to text. Builder edits normalize user formatting.
 *
 * 2. **Derive IDs from content, not randomness.** Random IDs break print/parse equality
 *    and force the builder to recreate cards.
 *
 * 3. **Preserve syntax sugar.** Lowering `blue.first_blood` to `exists(event(...))`
 *    prevents the printer from restoring the original form. Only PlanBuilder desugars.
 *
 * 4. **Spans are incidental metadata.** Equality and canonical serialization ignore them
 *    so whitespace changes do not invalidate caches.
 */

/** Half-open source range `[start, end)`, used only for diagnostics and editor navigation. */
export type Span = readonly [start: number, end: number];

export interface NodeBase {
  readonly span?: Span;
}

export type Side = 'blue' | 'red';

/** Event occurrence qualifier. A positive number selects that occurrence in match order. */
export type Ordinal = 'first' | 'last' | 'any' | number;

// ---------------------------------------------------------------- Top level

export interface Program extends NodeBase {
  readonly kind: 'Program';
  /** `ANALYZE blue`. When null, validation infers the grain from conditions. */
  readonly analyze: ScopeRef | null;
  readonly body: SimpleStmt | CompareStmt;
}

export interface ScopeRef extends NodeBase {
  readonly kind: 'ScopeRef';
  readonly entity: 'match' | 'team' | 'player';
  /** Team grain only. Absence means both teams. */
  readonly side?: Side;
  /** Team relation resolved from the trigger row of a temporal chain. */
  readonly relation?: 'opponent-of-trigger';
  /** `player("Hide on bush")` */
  readonly selector?: string;
}

export interface SimpleStmt extends NodeBase {
  readonly kind: 'SimpleStmt';
  /** `AFTER kill WITHIN 90s IF dragon.killed` */
  readonly chain: ChainClause | null;
  readonly when: Expr | null;
  readonly groupBy: readonly GroupKey[];
  /** At least one; validation emits E-SYN-001 when empty. */
  readonly returns: readonly ReturnItem[];
}

export interface CompareStmt extends NodeBase {
  readonly kind: 'CompareStmt';
  /** At least two. */
  readonly arms: readonly CompareArm[];
  readonly groupBy: readonly GroupKey[];
  readonly returns: readonly ReturnItem[];
}

export interface CompareArm extends NodeBase {
  readonly kind: 'CompareArm';
  readonly label: string | null;
  readonly when: Expr;
}

export interface ChainClause extends NodeBase {
  readonly kind: 'ChainClause';
  /** Reference event in `AFTER player.kill`. */
  readonly trigger: EventRef;
  /** `WITHIN 90s` */
  readonly window: DurationLit | null;
  /** `IF dragon.killed` */
  readonly condition: Expr | null;
}

export interface GroupKey extends NodeBase {
  readonly kind: 'GroupKey';
  readonly expr: Expr;
  readonly alias: string | null;
}

export interface ReturnItem extends NodeBase {
  readonly kind: 'ReturnItem';
  readonly expr: Expr;
  readonly alias: string | null;
}

// ---------------------------------------------------------------- Expressions

export type Expr =
  | NumberLit
  | StringLit
  | BoolLit
  | NullLit
  | DurationLit
  | ClockLit
  | Identifier
  | EventRef
  | EventPredicate
  | FieldAccess
  | CallExpr
  | MeasureAt
  | RegionRef
  | BinaryExpr
  | UnaryExpr
  | InExpr
  | SpatialPredicate
  | TemporalPredicate
  | ErrorExpr;

export interface NumberLit extends NodeBase {
  readonly kind: 'NumberLit';
  readonly value: number;
}

export interface StringLit extends NodeBase {
  readonly kind: 'StringLit';
  readonly value: string;
}

export interface BoolLit extends NodeBase {
  readonly kind: 'BoolLit';
  readonly value: boolean;
}

export interface NullLit extends NodeBase {
  readonly kind: 'NullLit';
}

/**
 * `90s` or `1m30s`. Values are always normalized to seconds.
 * `raw` lets the printer restore the original spelling.
 */
export interface DurationLit extends NodeBase {
  readonly kind: 'DurationLit';
  readonly seconds: number;
  readonly raw: string;
}

/** `10:00` to 600 seconds. Semantically a duration, but stored separately to retain spelling. */
export interface ClockLit extends NodeBase {
  readonly kind: 'ClockLit';
  readonly seconds: number;
  readonly raw: string;
}

export interface Identifier extends NodeBase {
  readonly kind: 'Identifier';
  readonly name: string;
}

/**
 * Event reference such as `blue.first_blood`, `first_turret_destroy`, or `dragon.kill`.
 *
 * `bindingId` is derived deterministically from content. Repeated references to one event
 * must share an ID so the compiler reuses one witness CTE.
 */
export interface EventRef extends NodeBase {
  readonly kind: 'EventRef';
  readonly bindingId: string;
  /** null means match-wide scope across both teams. */
  readonly scope: ScopeRef | null;
  /** Catalog event ID. */
  readonly eventType: string;
  readonly ordinal: Ordinal;
  /** Surface name from source, used to restore aliases such as `first_turret_destroy`. */
  readonly surface: string;
}

/** A bare event in condition position becomes an occurrence predicate. */
export interface EventPredicate extends NodeBase {
  readonly kind: 'EventPredicate';
  readonly event: EventRef;
  readonly negated: boolean;
}

export interface FieldAccess extends NodeBase {
  readonly kind: 'FieldAccess';
  readonly object: Expr;
  readonly field: string;
}

export interface CallExpr extends NodeBase {
  readonly kind: 'CallExpr';
  /** Catalog function ID. */
  readonly callee: string;
  /** `blue.win_rate` → scope=blue, callee='win_rate' */
  readonly scope: ScopeRef | null;
  readonly args: readonly Expr[];
}

/** `gold_diff(10:00)`: a point-in-time measure requiring a frame lookup. */
export interface MeasureAt extends NodeBase {
  readonly kind: 'MeasureAt';
  readonly measure: string;
  readonly scope: ScopeRef | null;
  readonly at: ClockLit | DurationLit;
}

/** `region("top_lane")`. Geometry lives in `envelope.regions`, outside the AST. */
export interface RegionRef extends NodeBase {
  readonly kind: 'RegionRef';
  readonly name: string;
}

export type BinaryOp =
  'AND' | 'OR' | '=' | '!=' | '>' | '>=' | '<' | '<=' | '+' | '-' | '*' | '/' | '%';

export interface BinaryExpr extends NodeBase {
  readonly kind: 'BinaryExpr';
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

export interface UnaryExpr extends NodeBase {
  readonly kind: 'UnaryExpr';
  readonly op: 'NOT' | '-';
  readonly operand: Expr;
}

export interface InExpr extends NodeBase {
  readonly kind: 'InExpr';
  readonly value: Expr;
  readonly set: readonly Expr[];
  readonly negated: boolean;
}

export type SpatialRelation = 'IN_REGION' | 'WITHIN_RADIUS' | 'NEAR';

export interface SpatialPredicate extends NodeBase {
  readonly kind: 'SpatialPredicate';
  readonly relation: SpatialRelation;
  /** `first_blood.position` */
  readonly position: Expr;
  readonly target: Expr;
  /** `WITHIN 1000 OF ...`, measured in game units. */
  readonly radius: NumberLit | null;
}

export type TemporalRelation =
  'BEFORE' | 'AFTER' | 'WITHIN' | 'UNTIL' | 'DURING' | 'BETWEEN' | 'AT';

export interface TemporalPredicate extends NodeBase {
  readonly kind: 'TemporalPredicate';
  readonly relation: TemporalRelation;
  readonly left: Expr;
  readonly right: Expr | null;
  /** The upper operand in `BETWEEN a AND b`. */
  readonly rightUpper: Expr | null;
  /** `AFTER x WITHIN 90s` */
  readonly window: DurationLit | null;
}

/**
 * Node inserted during parser recovery. Validation does not descend into it and compilation
 * rejects it. It keeps a partial AST available during intermediate typing states.
 */
export interface ErrorExpr extends NodeBase {
  readonly kind: 'ErrorExpr';
  readonly rawText: string;
  readonly diagnosticCode: string;
}

export type Node =
  | Program
  | ScopeRef
  | SimpleStmt
  | CompareStmt
  | CompareArm
  | ChainClause
  | GroupKey
  | ReturnItem
  | Expr;

export type NodeKind = Node['kind'];

/** Visits child nodes in source order. */
export function children(node: Node): Node[] {
  switch (node.kind) {
    case 'Program':
      return [...(node.analyze ? [node.analyze] : []), node.body];
    case 'SimpleStmt':
      return [
        ...(node.chain ? [node.chain] : []),
        ...(node.when ? [node.when] : []),
        ...node.groupBy,
        ...node.returns,
      ];
    case 'CompareStmt':
      return [...node.arms, ...node.groupBy, ...node.returns];
    case 'CompareArm':
      return [node.when];
    case 'ChainClause':
      return [
        node.trigger,
        ...(node.window ? [node.window] : []),
        ...(node.condition ? [node.condition] : []),
      ];
    case 'GroupKey':
    case 'ReturnItem':
      return [node.expr];
    case 'EventRef':
      return node.scope ? [node.scope] : [];
    case 'EventPredicate':
      return [node.event];
    case 'FieldAccess':
      return [node.object];
    case 'CallExpr':
      return [...(node.scope ? [node.scope] : []), ...node.args];
    case 'MeasureAt':
      return [...(node.scope ? [node.scope] : []), node.at];
    case 'BinaryExpr':
      return [node.left, node.right];
    case 'UnaryExpr':
      return [node.operand];
    case 'InExpr':
      return [node.value, ...node.set];
    case 'SpatialPredicate':
      return [node.position, node.target, ...(node.radius ? [node.radius] : [])];
    case 'TemporalPredicate':
      return [
        node.left,
        ...(node.right ? [node.right] : []),
        ...(node.rightUpper ? [node.rightUpper] : []),
        ...(node.window ? [node.window] : []),
      ];
    default:
      return [];
  }
}

/** Preorder traversal used by validation and coverage calculation. */
export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

export function findFirst<T extends Node>(
  root: Node,
  predicate: (node: Node) => node is T,
): T | null {
  let found: T | null = null;
  walk(root, (n) => {
    if (found === null && predicate(n)) found = n as T;
  });
  return found;
}

export function collect<T extends Node>(root: Node, predicate: (node: Node) => node is T): T[] {
  const out: T[] = [];
  walk(root, (n) => {
    if (predicate(n)) out.push(n as T);
  });
  return out;
}

export const isEventRef = (n: Node): n is EventRef => n.kind === 'EventRef';
export const isRegionRef = (n: Node): n is RegionRef => n.kind === 'RegionRef';
export const isErrorExpr = (n: Node): n is ErrorExpr => n.kind === 'ErrorExpr';
