import { type Expr, type Node, type Program } from '@lol/ast';
import { catalog } from '@lol/catalog';
import {
  coverage,
  counterItemSelection,
  describeCondition,
  eventCardSelection,
  itemResponseSelection,
} from '@lol/validate';
import {
  conditionCardType,
  type AstPath,
  type BuilderCard,
  type BuilderProjection,
} from './model.js';
import { canRemoveNode } from './patch.js';

function idFor(type: string, path: AstPath): string {
  return `${type}:${path.map((part) => encodeURIComponent(String(part))).join('/')}`;
}

function card(
  type: BuilderCard['type'],
  labelKo: string,
  path: AstPath,
  node: Node,
  editable = true,
  removable = false,
  advancedReasonKo?: string,
): BuilderCard {
  return {
    id: idFor(type, path),
    type,
    labelKo,
    path,
    node,
    editable,
    removable,
    ...(advancedReasonKo ? { advancedReasonKo } : {}),
  };
}

function flattenConditions(
  expr: Expr,
  path: AstPath,
  targetSide?: 'blue' | 'red',
): Array<{ expr: Expr; path: AstPath }> {
  if (
    itemResponseSelection(expr) ||
    counterItemSelection(expr) ||
    eventCardSelection(expr, targetSide)
  )
    return [{ expr, path }];
  if (expr.kind === 'BinaryExpr' && expr.op === 'AND') {
    return [
      ...flattenConditions(expr.left, [...path, 'left'], targetSide),
      ...flattenConditions(expr.right, [...path, 'right'], targetSide),
    ];
  }
  return [{ expr, path }];
}

export function project(program: Program): BuilderProjection {
  const result = coverage(program);
  const unsupported = new Map(result.unsupported.map((item) => [item.node, item]));
  const cards: BuilderCard[] = [];
  const body = program.body;
  const eventGrain = body.kind === 'SimpleStmt' && body.chain !== null;
  if (program.analyze) {
    const fragment = unsupported.get(program.analyze);
    const side =
      program.analyze.side === 'blue' ? '블루팀' : program.analyze.side === 'red' ? '레드팀' : null;
    const itemResponse =
      body.kind === 'SimpleStmt' && body.when ? itemResponseSelection(body.when) : null;
    cards.push(
      fragment
        ? card(
            'advanced',
            `분석 대상: ${eventGrain ? '사건' : itemResponse ? `상대 ${itemResponse.champion}` : (side ?? catalog.grains[program.analyze.entity].labelKo)}`,
            ['analyze'],
            program.analyze,
            false,
            false,
            fragment.reasonKo,
          )
        : card(
            'target',
            `분석 대상: ${eventGrain ? '사건' : itemResponse ? `상대 ${itemResponse.champion}` : (side ?? catalog.grains[program.analyze.entity].labelKo)}`,
            ['analyze'],
            program.analyze,
          ),
    );
  } else if (eventGrain) {
    cards.push(card('target', '분석 대상: 사건', ['body', 'chain'], body.chain!, false));
  }
  if (body.kind === 'SimpleStmt') {
    if (body.chain) {
      const fragment =
        unsupported.get(body.chain) ??
        (body.chain.condition ? unsupported.get(body.chain.condition) : undefined);
      cards.push(
        fragment
          ? card(
              'advanced',
              '이어지는 사건',
              ['body', 'chain'],
              body.chain,
              false,
              canRemoveNode(program, ['body', 'chain']),
              fragment.reasonKo,
            )
          : card(
              'sequence',
              '이어지는 사건',
              ['body', 'chain'],
              body.chain,
              true,
              canRemoveNode(program, ['body', 'chain']),
            ),
      );
    }
    if (body.when) {
      for (const item of flattenConditions(body.when, ['body', 'when'], program.analyze?.side)) {
        const fragment = unsupported.get(item.expr);
        cards.push(
          fragment
            ? card(
                'advanced',
                describeCondition(item.expr),
                item.path,
                item.expr,
                false,
                canRemoveNode(program, item.path),
                fragment.reasonKo,
              )
            : card(
                counterItemSelection(item.expr)
                  ? 'counterItem'
                  : itemResponseSelection(item.expr)
                    ? 'itemResponse'
                    : eventCardSelection(item.expr, program.analyze?.side)
                      ? 'event'
                      : conditionCardType(item.expr),
                describeCondition(item.expr),
                item.path,
                item.expr,
                true,
                canRemoveNode(program, item.path),
              ),
        );
      }
    }
  } else {
    body.arms.forEach((arm, index) => {
      const fragment = unsupported.get(arm) ?? unsupported.get(arm.when);
      const path: AstPath = unsupported.has(arm)
        ? ['body', 'arms', index]
        : ['body', 'arms', index, 'when'];
      cards.push(
        fragment
          ? card(
              'advanced',
              arm.label ?? `비교 조건 ${index + 1}`,
              path,
              unsupported.has(arm) ? arm : arm.when,
              false,
              canRemoveNode(program, path),
              fragment.reasonKo,
            )
          : card(
              'compare',
              arm.label ?? describeCondition(arm.when),
              ['body', 'arms', index],
              arm,
              true,
            ),
      );
    });
  }
  body.groupBy.forEach((group, index) => {
    const fragment = unsupported.get(group);
    cards.push(
      fragment
        ? card(
            'advanced',
            '분류 기준',
            ['body', 'groupBy', index],
            group,
            false,
            canRemoveNode(program, ['body', 'groupBy', index]),
            fragment.reasonKo,
          )
        : card(
            'groupBy',
            '분류 기준',
            ['body', 'groupBy', index],
            group,
            true,
            canRemoveNode(program, ['body', 'groupBy', index]),
          ),
    );
  });
  body.returns.forEach((item, index) => {
    const fragment = unsupported.get(item);
    const label =
      item.expr.kind === 'CallExpr'
        ? (catalog.functions[item.expr.callee]?.labelKo ?? item.expr.callee)
        : '결과';
    cards.push(
      fragment
        ? card(
            'advanced',
            label,
            ['body', 'returns', index],
            item,
            false,
            canRemoveNode(program, ['body', 'returns', index]),
            fragment.reasonKo,
          )
        : card(
            'measure',
            `결과: ${label}`,
            ['body', 'returns', index],
            item,
            true,
            canRemoveNode(program, ['body', 'returns', index]),
          ),
    );
  });
  return {
    ast: program,
    cards,
    full: result.full,
    advancedCount: cards.filter((item) => item.type === 'advanced').length,
  };
}
