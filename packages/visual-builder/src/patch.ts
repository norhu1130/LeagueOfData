import {
  makeBindingId,
  normalizeExpr,
  normalizeProgram,
  type Expr,
  type Node,
  type Program,
  type ScopeRef,
  type Side,
} from '@lol/ast';
import type { AstPath, BuilderPatch } from './model.js';

function valueAt(root: unknown, path: AstPath): unknown {
  return path.reduce<unknown>(
    (value, key) => (value as Record<string | number, unknown>)[key],
    root,
  );
}

function replaceAt(root: unknown, path: AstPath, value: unknown): unknown {
  if (!path.length) return value;
  const [head, ...tail] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[head as number] = replaceAt(copy[head as number], tail, value);
    return copy;
  }
  const object = root as Record<string, unknown>;
  return { ...object, [head!]: replaceAt(object[head as string], tail, value) };
}

function removeCondition(root: Expr, target: Expr): Expr | null {
  if (root === target) return null;
  if (root.kind !== 'BinaryExpr' || root.op !== 'AND') return root;
  const left = removeCondition(root.left, target);
  const right = removeCondition(root.right, target);
  if (!left) return right;
  if (!right) return left;
  if (left === root.left && right === root.right) return root;
  return { ...root, left, right };
}

function rebindValue(value: unknown, from: Side, to: Side): unknown {
  if (Array.isArray(value)) return value.map((item) => rebindValue(item, from, to));
  if (!value || typeof value !== 'object') return value;

  const original = value as Record<string, unknown>;
  if (original.kind === 'ScopeRef') {
    const scope = original as unknown as ScopeRef;
    return scope.entity === 'team' && scope.side === from ? { ...scope, side: to } : scope;
  }

  const rebound = Object.fromEntries(
    Object.entries(original).map(([key, child]) => [key, rebindValue(child, from, to)]),
  ) as Record<string, unknown>;
  if (rebound.kind === 'EventRef') {
    const scope = rebound.scope as ScopeRef | null;
    rebound.bindingId = makeBindingId({
      scope: scope ? (scope.relation ?? scope.side ?? scope.entity) : null,
      eventType: rebound.eventType as string,
      ordinal: rebound.ordinal as import('@lol/ast').Ordinal,
    });
  }
  return rebound;
}

/** Retargets only target-relative references inside result expressions. */
function retargetResultValue(
  value: unknown,
  from: Side | undefined,
  to: Side | undefined,
): unknown {
  if (Array.isArray(value)) return value.map((item) => retargetResultValue(item, from, to));
  if (!value || typeof value !== 'object') return value;

  const original = value as Record<string, unknown>;
  const rebound = Object.fromEntries(
    Object.entries(original).map(([key, child]) => [
      key,
      key === 'scope' ? child : retargetResultValue(child, from, to),
    ]),
  ) as Record<string, unknown>;

  if (['CallExpr', 'MeasureAt', 'EventRef'].includes(String(original.kind))) {
    const scope = original.scope as ScopeRef | null;
    if (from !== undefined && scope?.entity === 'team' && scope.side === from) {
      rebound.scope =
        to === undefined ? null : { ...scope, kind: 'ScopeRef', entity: 'team', side: to };
    } else if (from === undefined && to !== undefined && scope === null) {
      rebound.scope = { kind: 'ScopeRef', entity: 'team', side: to };
    }
  }

  if (rebound.kind === 'EventRef') {
    const scope = rebound.scope as ScopeRef | null;
    rebound.bindingId = makeBindingId({
      scope: scope ? (scope.relation ?? scope.side ?? scope.entity) : null,
      eventType: rebound.eventType as string,
      ordinal: rebound.ordinal as import('@lol/ast').Ordinal,
    });
  }
  return rebound;
}

/** Rebinds references owned by the current team target and refreshes event binding IDs. */
export function rebindTeamSide(program: Program, from: Side, to: Side): Program {
  if (from === to) return program;
  return normalizeProgram(rebindValue(program, from, to) as Program);
}

/** Converts a filtered analysis to condition-versus-opposite without losing measures or groups. */
export function compareWithOpposite(program: Program): Program {
  if (program.body.kind !== 'SimpleStmt' || !program.body.when) return program;
  const condition = program.body.when;
  const opposite = normalizeExpr({ kind: 'UnaryExpr', op: 'NOT', operand: condition });
  return normalizeProgram({
    ...program,
    body: {
      kind: 'CompareStmt',
      arms: [
        { kind: 'CompareArm', label: null, when: condition },
        { kind: 'CompareArm', label: null, when: opposite },
      ],
      groupBy: program.body.groupBy,
      returns: program.body.returns,
    },
  });
}

/** Whether a whole card fragment can be removed while keeping the program structurally valid. */
export function canRemoveNode(program: Program, path: AstPath): boolean {
  const body = program.body;
  if (body.kind === 'SimpleStmt' && path[0] === 'body' && path[1] === 'when') return true;
  if (path[0] !== 'body') return false;
  if (path[1] === 'groupBy') return typeof path[2] === 'number';
  if (path[1] === 'returns') return typeof path[2] === 'number' && body.returns.length > 1;
  if (body.kind === 'CompareStmt' && path[1] === 'arms') {
    return typeof path[2] === 'number' && body.arms.length > 2;
  }
  return body.kind === 'SimpleStmt' && path.length === 2 && path[1] === 'chain';
}

function removeAtPath(program: Program, path: AstPath): Program {
  if (!canRemoveNode(program, path)) return program;
  const body = program.body;

  if (body.kind === 'SimpleStmt' && path[1] === 'when' && body.when) {
    const target = valueAt(program, path) as Expr;
    const when = removeCondition(body.when, target);
    return normalizeProgram({ ...program, body: { ...body, when } });
  }
  if (body.kind === 'SimpleStmt' && path[1] === 'chain') {
    return normalizeProgram({ ...program, body: { ...body, chain: null } });
  }
  if (path[1] === 'groupBy') {
    const index = path[2] as number;
    return normalizeProgram({
      ...program,
      body: { ...body, groupBy: body.groupBy.filter((_, current) => current !== index) },
    });
  }
  if (path[1] === 'returns') {
    const index = path[2] as number;
    return normalizeProgram({
      ...program,
      body: { ...body, returns: body.returns.filter((_, current) => current !== index) },
    });
  }
  if (body.kind === 'CompareStmt' && path[1] === 'arms') {
    const index = path[2] as number;
    return normalizeProgram({
      ...program,
      body: { ...body, arms: body.arms.filter((_, current) => current !== index) },
    });
  }
  return program;
}

export function applyBuilderPatch(program: Program, patch: BuilderPatch): Program {
  if (patch.kind === 'setAnalyze') {
    const previousIsTeam = program.analyze?.entity === 'team';
    const nextIsTeam = patch.value?.entity === 'team';
    const previousSide = previousIsTeam ? program.analyze?.side : undefined;
    const nextSide = patch.value?.entity === 'team' ? patch.value.side : undefined;
    const withRetargetedMeasures =
      previousIsTeam && nextIsTeam && previousSide !== nextSide
        ? {
            ...program,
            body: {
              ...program.body,
              returns: program.body.returns.map((item) =>
                retargetResultValue(item, previousSide, nextSide),
              ) as Program['body']['returns'],
            },
          }
        : program;
    return normalizeProgram({ ...withRetargetedMeasures, analyze: patch.value } as Program);
  }
  if (patch.kind === 'compareWithOpposite') return compareWithOpposite(program);
  if (patch.kind === 'setGroupBy')
    return normalizeProgram({
      ...program,
      body: { ...program.body, groupBy: patch.value },
    });
  if (patch.kind === 'replace')
    return normalizeProgram(replaceAt(program, patch.path, patch.value) as Program);
  return removeAtPath(program, patch.path);
}

export function nodeAt(program: Program, path: AstPath): Node | null {
  return (valueAt(program, path) as Node | undefined) ?? null;
}
