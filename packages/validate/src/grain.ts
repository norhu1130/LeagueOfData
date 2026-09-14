/**
 * Analysis-grain inference.
 *
 * Grain determines the denominator of `win_rate()`:
 *
 *   match  — matching matches
 *   team   — matching team-matches; one match can count twice
 *   player — matching player-matches
 *   event  — matching events
 *
 * Results must state this denominator explicitly (§22).
 */
import { collect, isEventRef, walk, type Expr, type Node, type Program } from '@lol/ast';
import { catalog } from '@lol/catalog';
import type { GrainId } from '@lol/catalog';

export interface GrainInference {
  readonly grain: GrainId;
  /** Why this grain was selected, used in result explanations and diagnostics. */
  readonly reasonKo: string;
  /** Whether the user selected it explicitly; inferred grains may need ambiguity warnings. */
  readonly explicit: boolean;
}

const GRAIN_LABEL: Record<GrainId, string> = {
  match: '경기',
  team: '팀-경기',
  player: '선수-경기',
  event: '사건',
};

export function grainUnitKo(grain: GrainId): string {
  return GRAIN_LABEL[grain] ?? grain;
}

/**
 * Selects the analysis grain in priority order:
 *
 *   1. A chain clause uses event grain because each reference event is one row.
 *   2. An explicit `ANALYZE` clause wins next.
 *   3. Player-property references imply player grain.
 *   4. Team references imply team grain.
 *   5. Otherwise use match grain.
 */
export function inferGrain(program: Program): GrainInference {
  const body = program.body;

  if (body.kind === 'SimpleStmt' && body.chain) {
    return {
      grain: 'event',
      reasonKo: '기준 사건 하나하나를 세기 때문입니다',
      explicit: true,
    };
  }

  if (program.analyze) {
    const scope = program.analyze;
    if (scope.entity === 'team') {
      return {
        grain: 'team',
        reasonKo: scope.side
          ? `${scope.side === 'blue' ? '블루' : '레드'}팀을 기준으로 분석하기 때문입니다`
          : '팀을 기준으로 분석하기 때문입니다',
        explicit: true,
      };
    }
    if (scope.entity === 'player') {
      return { grain: 'player', reasonKo: '선수를 기준으로 분석하기 때문입니다', explicit: true };
    }
    return { grain: 'match', reasonKo: '경기를 기준으로 분석하기 때문입니다', explicit: true };
  }

  const scopes = collectScopeEntities(program);
  if (scopes.has('player')) {
    return { grain: 'player', reasonKo: '선수 정보를 참조하기 때문입니다', explicit: false };
  }
  if (scopes.has('team')) {
    return { grain: 'team', reasonKo: '팀을 지칭하기 때문입니다', explicit: false };
  }

  return { grain: 'match', reasonKo: '경기 전체를 세기 때문입니다', explicit: false };
}

function collectScopeEntities(program: Program): Set<string> {
  const entities = new Set<string>();
  walk(program, (node: Node) => {
    if (node.kind === 'ScopeRef') entities.add(node.entity);
    if (node.kind === 'Identifier' && (node.name === 'player' || node.name === 'team')) {
      entities.add(node.name);
    }
  });
  return entities;
}

/** Events referenced by the analysis, for which the compiler creates witness CTEs. */
export function referencedEvents(program: Program): string[] {
  const ids = new Set(collect(program, isEventRef).map((e) => e.eventType));
  return [...ids].sort();
}

/** Whether a function is valid at this grain. */
export function functionAllowedInGrain(functionId: string, grain: GrainId): boolean {
  const fn = catalog.functions[functionId];
  return fn ? fn.validGrains.includes(grain) : false;
}

/** Whether a grouping key is valid at this grain. */
export function groupKeyAllowedInGrain(keyId: string, grain: GrainId): boolean {
  const key = catalog.groupKeys[keyId];
  return key ? key.validGrains.includes(grain) : false;
}

/** Whether an expression contains an event, used for duration argument validation. */
export function isEventExpr(expr: Expr): boolean {
  return expr.kind === 'EventRef' || expr.kind === 'EventPredicate';
}
