/**
 * Expression type inference.
 *
 * Detects mismatches such as comparing a position with time before SQL execution.
 */
import type { Expr } from '@lol/ast';
import { catalog, resolveEventSurface, type ValueType } from '@lol/catalog';

/** Inference result retaining event/field context for diagnostics. */
export interface InferredType {
  readonly type: ValueType;
  /** Korean user-facing name. */
  readonly labelKo: string;
  /** Owning event when the expression was a FieldAccess. */
  readonly eventId?: string;
  readonly fieldId?: string;
  /** Coordinate space for a position; normalized and game coordinates cannot be mixed. */
  readonly coordSpace?: 'normalized' | 'raw';
}

const TYPE_LABEL: Partial<Record<ValueType, string>> = {
  bool: '참/거짓',
  int: '숫자',
  float: '숫자',
  rate: '비율',
  duration: '시간',
  time: '시각',
  category: '분류',
  champion: '챔피언',
  role: '역할',
  team: '팀',
  player: '선수',
  'player[]': '선수 목록',
  position: '위치',
  region: '영역',
  event: '사건',
  string: '문자열',
  any: '값',
};

export function typeLabelKo(type: ValueType): string {
  return TYPE_LABEL[type] ?? String(type);
}

const t = (type: ValueType, extra: Partial<InferredType> = {}): InferredType => ({
  type,
  labelKo: typeLabelKo(type),
  ...extra,
});

/** Types that support numeric comparison. */
const NUMERIC: ReadonlySet<ValueType> = new Set<ValueType>([
  'int',
  'float',
  'rate',
  'duration',
  'time',
]);

export function isNumericType(type: ValueType): boolean {
  return NUMERIC.has(type);
}

/** Whether two types are comparable. */
export function comparable(a: ValueType, b: ValueType): boolean {
  if (a === 'any' || b === 'any') return true;
  if (a === b) return true;
  if (isNumericType(a) && isNumericType(b)) return true;
  // Champions, roles, and categories may be compared with strings.
  const stringy: ReadonlySet<ValueType> = new Set<ValueType>([
    'string',
    'champion',
    'role',
    'category',
    'team',
  ]);
  return stringy.has(a) && stringy.has(b);
}

export function inferType(expr: Expr): InferredType {
  switch (expr.kind) {
    case 'NumberLit':
      return t(Number.isInteger(expr.value) ? 'int' : 'float');
    case 'StringLit':
      return t('string');
    case 'BoolLit':
      return t('bool');
    case 'NullLit':
      return t('any');
    case 'DurationLit':
      return t('duration');
    case 'ClockLit':
      return t('time');

    case 'RegionRef':
      return t('region');

    case 'EventRef':
      return t('event', { eventId: expr.eventType });

    case 'EventPredicate':
      return t('bool');

    case 'Identifier': {
      // A bare event name has event type.
      const resolved = resolveEventSurface(expr.name);
      if (resolved) return t('event', { eventId: resolved.event.id });
      // The name may instead be a grouping key.
      const groupKey = catalog.groupKeys[expr.name];
      if (groupKey) return t(groupKey.type);
      return t('any');
    }

    case 'FieldAccess': {
      const objectType = inferType(expr.object);
      if (objectType.type === 'event' && objectType.eventId) {
        const event = catalog.events[objectType.eventId];
        const field = catalog.contextFields[expr.field];
        if (event && field && event.context.includes(expr.field)) {
          return t(field.type, {
            eventId: objectType.eventId,
            fieldId: expr.field,
            // Region containment uses normalized space; distances use game space.
            ...(field.type === 'position' ? { coordSpace: 'normalized' as const } : {}),
          });
        }
      }
      if (expr.object.kind === 'Identifier') {
        const entity = expr.object.name.toLowerCase();
        const grain = entity === 'blue' || entity === 'red' || entity === 'team' ? 'team' : entity;
        const subjectField = catalog.subjectFields[expr.field];
        if (
          (grain === 'match' || grain === 'team' || grain === 'player') &&
          subjectField?.validGrains.includes(grain)
        ) {
          return t(subjectField.type, { fieldId: expr.field });
        }
        const groupKey = catalog.groupKeys[expr.field];
        if (
          (grain === 'match' || grain === 'team' || grain === 'player') &&
          groupKey?.validGrains.includes(grain) &&
          groupKey.sql === expr.field
        ) {
          return t(groupKey.type, { fieldId: expr.field });
        }
      }
      return t('any', { fieldId: expr.field });
    }

    case 'CallExpr': {
      const fn = catalog.functions[expr.callee];
      if (!fn) return t('any');
      if (fn.returns === 'same-as-arg') {
        const first = expr.args[0];
        return first ? inferType(first) : t('any');
      }
      return t(fn.returns);
    }

    case 'MeasureAt':
      return t('int');

    case 'BinaryExpr': {
      if (expr.op === 'AND' || expr.op === 'OR') return t('bool');
      if (['=', '!=', '>', '>=', '<', '<='].includes(expr.op)) return t('bool');
      // Subtracting time values produces a duration.
      const left = inferType(expr.left);
      const right = inferType(expr.right);
      if (left.type === 'duration' || right.type === 'duration') return t('duration');
      if (left.type === 'float' || right.type === 'float') return t('float');
      return t('int');
    }

    case 'UnaryExpr':
      return expr.op === 'NOT' ? t('bool') : inferType(expr.operand);

    case 'InExpr':
    case 'SpatialPredicate':
    case 'TemporalPredicate':
      return t('bool');

    case 'ErrorExpr':
      return t('any');
  }
}

/** Human-readable expression name used in diagnostic current-value context. */
export function describeExpr(expr: Expr): string {
  switch (expr.kind) {
    case 'Identifier':
      return expr.name;
    case 'EventRef':
      return expr.surface;
    case 'EventPredicate':
      return expr.event.surface;
    case 'FieldAccess':
      return `${describeExpr(expr.object)}.${expr.field}`;
    case 'CallExpr':
      return `${expr.callee}(…)`;
    case 'MeasureAt':
      return `${expr.measure}(${expr.at.raw})`;
    case 'RegionRef':
      return `region("${expr.name}")`;
    case 'NumberLit':
      return String(expr.value);
    case 'StringLit':
      return `"${expr.value}"`;
    case 'DurationLit':
    case 'ClockLit':
      return expr.raw;
    case 'BoolLit':
      return expr.value ? 'true' : 'false';
    default:
      return typeLabelKo(inferType(expr).type);
  }
}
