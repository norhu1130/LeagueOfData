/**
 * AST to DSL text.
 *
 * Canonical-form rules:
 *   1. Print clauses in a fixed order, one per line.
 *   2. Uppercase keywords and preserve name/string spelling.
 *   3. Emit only precedence-required parentheses.
 *   4. Preserve `raw` duration spelling.
 *   5. Flatten `AND`/`OR` while preserving operand order.
 *
 * Parser and printer share one precedence table to preserve round trips.
 */
import type {
  BinaryOp,
  CompareStmt,
  ChainClause,
  Expr,
  GroupKey,
  Node,
  Program,
  ReturnItem,
  ScopeRef,
  SimpleStmt,
} from '@lol/ast';

/** Matches parser levels; larger values bind more tightly. */
const PRECEDENCE = {
  OR: 1,
  AND: 2,
  NOT: 3,
  RELATIONAL: 4,
  ADDITIVE: 5,
  MULTIPLICATIVE: 6,
  UNARY: 7,
  POSTFIX: 8,
  PRIMARY: 9,
} as const;

const BINARY_PRECEDENCE: Record<BinaryOp, number> = {
  OR: PRECEDENCE.OR,
  AND: PRECEDENCE.AND,
  '=': PRECEDENCE.RELATIONAL,
  '!=': PRECEDENCE.RELATIONAL,
  '>': PRECEDENCE.RELATIONAL,
  '>=': PRECEDENCE.RELATIONAL,
  '<': PRECEDENCE.RELATIONAL,
  '<=': PRECEDENCE.RELATIONAL,
  '+': PRECEDENCE.ADDITIVE,
  '-': PRECEDENCE.ADDITIVE,
  '*': PRECEDENCE.MULTIPLICATIVE,
  '/': PRECEDENCE.MULTIPLICATIVE,
  '%': PRECEDENCE.MULTIPLICATIVE,
};

export interface PrintOptions {
  /** Whether to indent AND conditions on separate lines; defaults to multiple conditions. */
  readonly multilineConditions?: boolean;
}

export function printDsl(node: Program, options: PrintOptions = {}): string {
  const lines: string[] = [];

  if (node.analyze) lines.push(`ANALYZE ${printScope(node.analyze)}`);

  if (node.body.kind === 'SimpleStmt') {
    printSimple(node.body, lines, options);
  } else {
    printCompare(node.body, lines, options);
  }

  return lines.join('\n');
}

function printSimple(stmt: SimpleStmt, lines: string[], options: PrintOptions): void {
  if (stmt.chain) lines.push(printChain(stmt.chain));
  if (stmt.when) lines.push(`WHEN ${printCondition(stmt.when, options)}`);
  if (stmt.groupBy.length) lines.push(`GROUP BY ${stmt.groupBy.map(printGroupKey).join(', ')}`);
  lines.push(printReturns(stmt.returns));
}

function printCompare(stmt: CompareStmt, lines: string[], options: PrintOptions): void {
  const arms = stmt.arms.map((arm) => {
    const label = arm.label ? ` AS ${arm.label}` : '';
    return `WHEN ${printExpr(arm.when, PRECEDENCE.OR)}${label}`;
  });
  lines.push(`COMPARE ${arms.join('\nVS ')}`);
  if (stmt.groupBy.length) lines.push(`GROUP BY ${stmt.groupBy.map(printGroupKey).join(', ')}`);
  lines.push(printReturns(stmt.returns));
  void options;
}

function printChain(chain: ChainClause): string {
  const parts = [`AFTER ${printExpr(chain.trigger, PRECEDENCE.POSTFIX)}`];
  if (chain.window) parts.push(`WITHIN ${chain.window.raw}`);
  if (chain.condition) parts.push(`IF ${printExpr(chain.condition, PRECEDENCE.OR)}`);
  return parts.join(' ');
}

function printReturns(items: readonly ReturnItem[]): string {
  if (!items.length) return 'RETURN';
  const parts = items.map((item) => {
    const alias = item.alias ? ` AS ${item.alias}` : '';
    return `${printExpr(item.expr, PRECEDENCE.OR)}${alias}`;
  });
  return `RETURN ${parts.join(', ')}`;
}

function printGroupKey(key: GroupKey): string {
  const alias = key.alias ? ` AS ${key.alias}` : '';
  return `${printExpr(key.expr, PRECEDENCE.POSTFIX)}${alias}`;
}

/**
 * Prints a WHEN condition. Multiple AND terms use separate indented lines to align visually
 * with condition cards in the builder.
 */
function printCondition(expr: Expr, options: PrintOptions): string {
  const conjuncts = flattenAnd(expr);
  const multiline = options.multilineConditions ?? conjuncts.length > 1;
  if (!multiline || conjuncts.length < 2) return printExpr(expr, PRECEDENCE.OR);
  const [head, ...rest] = conjuncts;
  return [
    printExpr(head!, PRECEDENCE.AND),
    ...rest.map((c) => `  AND ${printExpr(c, PRECEDENCE.AND)}`),
  ].join('\n');
}

/** Flattens a left-associated AND chain without changing order. */
function flattenAnd(expr: Expr): Expr[] {
  if (expr.kind === 'BinaryExpr' && expr.op === 'AND') {
    return [...flattenAnd(expr.left), ...flattenAnd(expr.right)];
  }
  return [expr];
}

function printScope(scope: ScopeRef): string {
  if (scope.entity === 'team') {
    if (scope.relation === 'opponent-of-trigger') return 'opponent';
    return scope.side ?? 'team';
  }
  if (scope.entity === 'player' && scope.selector !== undefined) {
    return `player(${JSON.stringify(scope.selector)})`;
  }
  return scope.entity;
}

function scopePrefix(scope: ScopeRef | null): string {
  return scope ? `${printScope(scope)}.` : '';
}

/**
 * Prints an expression and adds parentheses only below `parentPrecedence`.
 */
export function printExpr(expr: Expr, parentPrecedence: number): string {
  const text = printExprRaw(expr);
  const own = precedenceOf(expr);
  return own < parentPrecedence ? `(${text})` : text;
}

function precedenceOf(expr: Expr): number {
  switch (expr.kind) {
    case 'BinaryExpr':
      return BINARY_PRECEDENCE[expr.op];
    case 'UnaryExpr':
      return expr.op === 'NOT' ? PRECEDENCE.NOT : PRECEDENCE.UNARY;
    case 'InExpr':
    case 'SpatialPredicate':
    case 'TemporalPredicate':
      return PRECEDENCE.RELATIONAL;
    default:
      return PRECEDENCE.PRIMARY;
  }
}

function printExprRaw(expr: Expr): string {
  switch (expr.kind) {
    case 'NumberLit':
      return String(expr.value);
    case 'StringLit':
      return JSON.stringify(expr.value);
    case 'BoolLit':
      return expr.value ? 'true' : 'false';
    case 'NullLit':
      return 'null';
    case 'DurationLit':
    case 'ClockLit':
      return expr.raw;
    case 'Identifier':
      return expr.name;
    case 'RegionRef':
      return `region(${JSON.stringify(expr.name)})`;

    case 'EventRef':
      // Restore the surface alias instead of exposing its lowered ordinal representation.
      return `${scopePrefix(expr.scope)}${expr.surface}${
        typeof expr.ordinal === 'number'
          ? `[${expr.ordinal}]`
          : expr.surface === expr.eventType && ['first', 'last'].includes(expr.ordinal)
            ? `[${expr.ordinal}]`
            : ''
      }`;

    case 'EventPredicate':
      return expr.negated
        ? `NOT ${printExpr(expr.event, PRECEDENCE.NOT)}`
        : printExprRaw(expr.event);

    case 'FieldAccess':
      return `${printExpr(expr.object, PRECEDENCE.POSTFIX)}.${expr.field}`;

    case 'CallExpr':
      return `${scopePrefix(expr.scope)}${expr.callee}(${expr.args
        .map((a) => printExpr(a, PRECEDENCE.OR))
        .join(', ')})`;

    case 'MeasureAt':
      return `${scopePrefix(expr.scope)}${expr.measure}(${expr.at.raw})`;

    case 'BinaryExpr': {
      const p = BINARY_PRECEDENCE[expr.op];
      // Left association requires one stronger precedence level on the right.
      return `${printExpr(expr.left, p)} ${expr.op} ${printExpr(expr.right, p + 1)}`;
    }

    case 'UnaryExpr':
      return expr.op === 'NOT'
        ? `NOT ${printExpr(expr.operand, PRECEDENCE.NOT)}`
        : `-${printExpr(expr.operand, PRECEDENCE.UNARY)}`;

    case 'InExpr': {
      const keyword = expr.negated ? 'NOT IN' : 'IN';
      const set = expr.set.map((e) => printExpr(e, PRECEDENCE.OR));
      return `${printExpr(expr.value, PRECEDENCE.ADDITIVE)} ${keyword} (${set.join(', ')})`;
    }

    case 'SpatialPredicate': {
      const position = printExpr(expr.position, PRECEDENCE.ADDITIVE);
      const target = printExpr(expr.target, PRECEDENCE.ADDITIVE);
      switch (expr.relation) {
        case 'IN_REGION':
          return `${position} IN ${target}`;
        case 'WITHIN_RADIUS':
          return `${position} WITHIN ${expr.radius ? printExprRaw(expr.radius) : '0'} OF ${target}`;
        case 'NEAR':
          return `${position} NEAR ${target}`;
      }
      break;
    }

    case 'TemporalPredicate': {
      const left = printExpr(expr.left, PRECEDENCE.ADDITIVE);
      const right = expr.right ? printExpr(expr.right, PRECEDENCE.ADDITIVE) : '';
      switch (expr.relation) {
        case 'BETWEEN':
          return `${left} BETWEEN ${right} AND ${
            expr.rightUpper ? printExpr(expr.rightUpper, PRECEDENCE.ADDITIVE) : ''
          }`;
        case 'WITHIN':
          return `${left} WITHIN ${expr.window?.raw ?? ''}`;
        case 'BEFORE':
        case 'AFTER': {
          if (expr.window && !expr.right) return `${left} WITHIN ${expr.window.raw}`;
          const window = expr.window ? ` WITHIN ${expr.window.raw}` : '';
          return `${left} ${expr.relation} ${right}${window}`;
        }
        default:
          return `${left} ${expr.relation} ${right}`;
      }
    }

    case 'ErrorExpr':
      return expr.rawText;
  }
  return '';
}

/** Parses source and rewrites it in canonical form. */
export function formatSource(
  source: string,
  parseFn: (s: string) => { ast: Program | null },
): string {
  const { ast } = parseFn(source);
  return ast ? printDsl(ast) : source;
}

export function printNode(node: Node): string {
  if (node.kind === 'Program') return printDsl(node);
  return printExpr(node as Expr, PRECEDENCE.OR);
}
