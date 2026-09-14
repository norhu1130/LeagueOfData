import type { Expr, Node, Program } from '@lol/ast';

export type CardType =
  | 'target'
  | 'event'
  | 'location'
  | 'condition'
  | 'itemResponse'
  | 'counterItem'
  | 'sequence'
  | 'groupBy'
  | 'compare'
  | 'measure'
  | 'advanced';

export type AstPath = readonly (string | number)[];

export interface BuilderCard {
  readonly id: string;
  readonly type: CardType;
  readonly labelKo: string;
  readonly path: AstPath;
  readonly node: Node;
  readonly editable: boolean;
  /** Whether removing this whole AST fragment preserves a valid program. */
  readonly removable: boolean;
  readonly advancedReasonKo?: string;
}

export interface BuilderProjection {
  readonly ast: Program;
  readonly cards: readonly BuilderCard[];
  readonly full: boolean;
  readonly advancedCount: number;
}

export type BuilderPatch =
  | { readonly kind: 'replace'; readonly path: AstPath; readonly value: Node | null }
  | { readonly kind: 'removeCondition'; readonly path: AstPath }
  | { readonly kind: 'setGroupBy'; readonly value: Program['body']['groupBy'] }
  | { readonly kind: 'setAnalyze'; readonly value: Program['analyze'] }
  | { readonly kind: 'compareWithOpposite' };

export interface SyncDocument {
  readonly ast: Program;
  readonly dslText: string;
  readonly state: 'synced' | 'advanced' | 'stale';
  readonly origin: 'dsl' | 'builder';
  readonly dslRev: number;
  readonly diagnostics: readonly import('@lol/dsl').Diagnostic[];
}

export function conditionCardType(expr: Expr): CardType {
  if (expr.kind === 'EventPredicate') return 'event';
  if (expr.kind === 'SpatialPredicate') return 'location';
  if (expr.kind === 'TemporalPredicate') return 'sequence';
  return 'condition';
}
