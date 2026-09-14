import type { ReturnItem } from '@lol/ast';

export type AggregateId = 'avg' | 'median' | 'sum' | 'min' | 'max';

export interface SubjectAggregateSelection {
  readonly aggregate: AggregateId;
  readonly entity: 'match' | 'team' | 'player';
  readonly field: string;
}

const aggregates = new Set<AggregateId>(['avg', 'median', 'sum', 'min', 'max']);

export function subjectAggregateSelection(item: ReturnItem): SubjectAggregateSelection | null {
  const expression = item.expr;
  const value = expression.kind === 'CallExpr' ? expression.args[0] : null;
  if (
    expression.kind !== 'CallExpr' ||
    !aggregates.has(expression.callee as AggregateId) ||
    expression.args.length !== 1 ||
    value?.kind !== 'FieldAccess' ||
    value.object.kind !== 'Identifier' ||
    !['match', 'team', 'player'].includes(value.object.name)
  )
    return null;
  return {
    aggregate: expression.callee as AggregateId,
    entity: value.object.name as SubjectAggregateSelection['entity'],
    field: value.field,
  };
}

export function subjectAggregateDsl(selection: SubjectAggregateSelection): string {
  return `${selection.aggregate}(${selection.entity}.${selection.field})`;
}

export const AGGREGATE_OPTIONS = [
  ['avg', '평균'],
  ['median', '중앙값'],
  ['sum', '합계'],
  ['min', '최솟값'],
  ['max', '최댓값'],
] as const;
