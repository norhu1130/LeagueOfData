/**
 * Enforces the canonical AST shape.
 *
 * Multiple shapes for one meaning make the builder and DSL continually rewrite each other.
 * For example, `NOT first_blood` has two possible representations:
 *
 *   EventPredicate{negated: true}
 *   UnaryExpr{NOT, EventPredicate{negated: false}}
 *
 * They print identically but hash differently, creating false changes and echo loops.
 *
 * **Every AST producer (parser, visual builder, examples, and imports) must call this function.**
 * Property tests enforce the rule.
 */
import type { Expr, Node, Program } from './nodes.js';

/** Flattens a chain of one operator while preserving source order. */
function flattenChain(expr: Expr, op: 'AND' | 'OR'): Expr[] {
  if (expr.kind === 'BinaryExpr' && expr.op === op) {
    return [...flattenChain(expr.left, op), ...flattenChain(expr.right, op)];
  }
  return [expr];
}

export function normalizeExpr(expr: Expr): Expr {
  switch (expr.kind) {
    case 'UnaryExpr': {
      const operand = normalizeExpr(expr.operand);

      // Represent negated event predicates only through EventPredicate.negated.
      if (expr.op === 'NOT' && operand.kind === 'EventPredicate') {
        return { ...operand, negated: !operand.negated, span: expr.span };
      }
      // Fold unary minus into numeric literals.
      if (expr.op === '-' && operand.kind === 'NumberLit') {
        return { kind: 'NumberLit', value: -operand.value, span: expr.span };
      }
      return operand === expr.operand ? expr : { ...expr, operand };
    }

    case 'BinaryExpr': {
      // Normalize AND/OR chains to left association. Equivalent association can otherwise
      // produce different trees across the parser and builder. These operators are associative,
      // so meaning is preserved; operand order is not changed.
      if (expr.op === 'AND' || expr.op === 'OR') {
        const parts = flattenChain(expr, expr.op).map(normalizeExpr);
        let acc = parts[0]!;
        for (let i = 1; i < parts.length; i++) {
          acc = { kind: 'BinaryExpr', op: expr.op, left: acc, right: parts[i]! };
        }
        return { ...acc, span: expr.span } as Expr;
      }
      const left = normalizeExpr(expr.left);
      const right = normalizeExpr(expr.right);
      return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
    }

    case 'EventPredicate': {
      const event = normalizeExpr(expr.event);
      return event === expr.event ? expr : { ...expr, event: event as typeof expr.event };
    }

    case 'FieldAccess': {
      const object = normalizeExpr(expr.object);
      return object === expr.object ? expr : { ...expr, object };
    }

    case 'CallExpr': {
      const args = expr.args.map(normalizeExpr);
      return args.every((a, i) => a === expr.args[i]) ? expr : { ...expr, args };
    }

    case 'InExpr': {
      const value = normalizeExpr(expr.value);
      const set = expr.set.map(normalizeExpr);
      return value === expr.value && set.every((s, i) => s === expr.set[i])
        ? expr
        : { ...expr, value, set };
    }

    case 'SpatialPredicate': {
      const position = normalizeExpr(expr.position);
      const target = normalizeExpr(expr.target);
      return position === expr.position && target === expr.target
        ? expr
        : { ...expr, position, target };
    }

    case 'TemporalPredicate': {
      const left = normalizeExpr(expr.left);
      const right = expr.right ? normalizeExpr(expr.right) : null;
      const rightUpper = expr.rightUpper ? normalizeExpr(expr.rightUpper) : null;
      return left === expr.left && right === expr.right && rightUpper === expr.rightUpper
        ? expr
        : { ...expr, left, right, rightUpper };
    }

    default:
      return expr;
  }
}

/**
 * Converts a bare event into an occurrence predicate where a boolean is required.
 *
 * `WHEN blue.first_blood` asks whether the event occurred, while `first_blood` inside
 * `RETURN avg(first_blood.time)` refers to the event itself. Wrapping is context-sensitive.
 */
export function coerceBoolean(expr: Expr): Expr {
  if (expr.kind === 'EventRef') {
    return { kind: 'EventPredicate', event: expr, negated: false, span: expr.span };
  }
  if (expr.kind === 'BinaryExpr' && (expr.op === 'AND' || expr.op === 'OR')) {
    return { ...expr, left: coerceBoolean(expr.left), right: coerceBoolean(expr.right) };
  }
  if (expr.kind === 'UnaryExpr' && expr.op === 'NOT') {
    return { ...expr, operand: coerceBoolean(expr.operand) };
  }
  return expr;
}

/** Normalizes an entire program. */
export function normalizeProgram(program: Program): Program {
  const body = program.body;

  if (body.kind === 'SimpleStmt') {
    return {
      ...program,
      body: {
        ...body,
        ...(body.chain
          ? {
              chain: {
                ...body.chain,
                condition: body.chain.condition
                  ? normalizeExpr(coerceBoolean(body.chain.condition))
                  : null,
              },
            }
          : {}),
        when: body.when ? normalizeExpr(coerceBoolean(body.when)) : null,
        groupBy: body.groupBy.map((g) => ({ ...g, expr: normalizeExpr(g.expr) })),
        returns: body.returns.map((r) => ({ ...r, expr: normalizeExpr(r.expr) })),
      },
    };
  }

  return {
    ...program,
    body: {
      ...body,
      arms: body.arms.map((arm) => ({ ...arm, when: normalizeExpr(coerceBoolean(arm.when)) })),
      groupBy: body.groupBy.map((g) => ({ ...g, expr: normalizeExpr(g.expr) })),
      returns: body.returns.map((r) => ({ ...r, expr: normalizeExpr(r.expr) })),
    },
  };
}

export function normalize(node: Program): Program;
export function normalize(node: Expr): Expr;
export function normalize(node: Node): Node {
  return node.kind === 'Program' ? normalizeProgram(node) : normalizeExpr(node as Expr);
}
