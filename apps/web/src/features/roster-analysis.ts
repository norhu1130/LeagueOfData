import type { Expr } from '@lol/ast';

export type PlayerRosterField = 'champion' | 'role';
export type RosterRelation =
  'opponent_has_champion' | 'ally_has_champion' | 'opponent_has_champion_in_role';

export interface PlayerRosterSelection {
  readonly field: PlayerRosterField;
  readonly value: string;
}

export interface RosterRelationSelection {
  readonly relation: RosterRelation;
  readonly champion: string;
  readonly role?: string;
}

export function playerRosterSelection(expr: Expr): PlayerRosterSelection | null {
  if (
    expr.kind !== 'BinaryExpr' ||
    expr.op !== '=' ||
    expr.left.kind !== 'FieldAccess' ||
    expr.left.object.kind !== 'Identifier' ||
    expr.left.object.name !== 'player' ||
    (expr.left.field !== 'champion' && expr.left.field !== 'role') ||
    expr.right.kind !== 'StringLit'
  )
    return null;
  return { field: expr.left.field, value: expr.right.value };
}

export function rosterRelationSelection(expr: Expr): RosterRelationSelection | null {
  if (
    expr.kind !== 'CallExpr' ||
    !['opponent_has_champion', 'ally_has_champion', 'opponent_has_champion_in_role'].includes(
      expr.callee,
    ) ||
    expr.args[0]?.kind !== 'StringLit' ||
    (expr.callee === 'opponent_has_champion_in_role'
      ? expr.args.length !== 2
      : expr.args.length !== 1)
  )
    return null;
  const role = expr.args[1];
  if (expr.callee === 'opponent_has_champion_in_role' && role?.kind !== 'StringLit') return null;
  return {
    relation: expr.callee as RosterRelation,
    champion: expr.args[0].value,
    role: role?.kind === 'StringLit' ? role.value : undefined,
  };
}

export function playerRosterDsl(selection: PlayerRosterSelection): string {
  return `player.${selection.field} = ${JSON.stringify(selection.value)}`;
}

export function rosterRelationDsl(selection: RosterRelationSelection): string {
  const champion = JSON.stringify(selection.champion);
  return selection.relation === 'opponent_has_champion_in_role'
    ? `${selection.relation}(${champion}, ${JSON.stringify(selection.role ?? 'MID')})`
    : `${selection.relation}(${champion})`;
}

export function playerRosterLabelKo(selection: PlayerRosterSelection): string {
  return selection.field === 'champion'
    ? `분석 대상 선수의 챔피언: ${selection.value}`
    : `분석 대상 선수의 포지션: ${selection.value}`;
}

export function rosterRelationLabelKo(selection: RosterRelationSelection): string {
  if (selection.relation === 'ally_has_champion') {
    return `같은 팀에 ${selection.champion} 챔피언이 있습니다`;
  }
  if (selection.relation === 'opponent_has_champion_in_role') {
    return `상대팀 ${selection.role ?? 'MID'} 포지션에 ${selection.champion} 챔피언이 있습니다`;
  }
  return `상대팀에 ${selection.champion} 챔피언이 있습니다`;
}
