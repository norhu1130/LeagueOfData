import type { BinaryExpr, EventRef, GroupKey, Ordinal } from '@lol/ast';
import { applyCardEdit, createSyncDocument, type SyncDocument } from '@lol/visual-builder';
import type { CounterItemSelection } from '@lol/validate';
import {
  chainFromDsl,
  conditionFromDsl,
  counterItemDsl,
  itemResponseDsl,
  parsedProgram,
  returnItem,
  type EventScopeChoice,
  type ItemResponseDraft,
} from './analysis-dsl.js';
import { playerRosterDsl, rosterRelationDsl, type RosterRelation } from './roster-analysis.js';

export interface ChampionAnalysisSelection {
  readonly champion: string;
  readonly role: string;
  readonly relation: RosterRelation | 'none';
  readonly relatedChampion: string;
  readonly relatedRole: string;
}

export interface SequenceSelection {
  readonly startEvent: string;
  readonly endEvent: string;
  readonly seconds: number;
  readonly startScope: EventScopeChoice;
  readonly endScope: EventScopeChoice;
  readonly startOrdinal: Ordinal;
  readonly endOrdinal: Ordinal;
  readonly endRoles: readonly string[];
  readonly endRoleMode: 'any' | 'all';
}

export interface AnalysisDocumentDraft {
  readonly document: SyncDocument;
  readonly title: string;
}

export type AnalysisTargetChoice = 'match' | 'player' | 'team' | 'blue' | 'red';

export function appendCondition(sync: SyncDocument, source: string): SyncDocument {
  if (sync.ast.body.kind !== 'SimpleStmt') return sync;
  const side = sync.ast.analyze?.side ?? 'blue';
  const added = conditionFromDsl(side, source);
  const when: BinaryExpr | typeof added = sync.ast.body.when
    ? { kind: 'BinaryExpr', op: 'AND', left: sync.ast.body.when, right: added }
    : added;
  return applyCardEdit(sync, { kind: 'replace', path: ['body', 'when'], value: when });
}

export function createItemResponseDraft(selection: ItemResponseDraft): AnalysisDocumentDraft {
  const dsl = itemResponseDsl(selection);
  return {
    document: createSyncDocument(parsedProgram(dsl), dsl),
    title: `${selection.actor === 'champion' ? selection.champion : '상대 팀'} 아이템 대응 승률`,
  };
}

export function createCounterItemDraft(selection: CounterItemSelection): AnalysisDocumentDraft {
  const dsl = `ANALYZE team
WHEN ${counterItemDsl(selection)}
RETURN win_rate() AS our_win_rate,
  count() AS sample_size`;
  return {
    document: createSyncDocument(parsedProgram(dsl), dsl),
    title: '상대 챔피언 대응 아이템 승률',
  };
}

export function createChampionDraft(selection: ChampionAnalysisSelection): AnalysisDocumentDraft {
  const conditions = [
    playerRosterDsl({ field: 'champion', value: selection.champion }),
    playerRosterDsl({ field: 'role', value: selection.role }),
  ];
  if (selection.relation !== 'none') {
    conditions.push(
      rosterRelationDsl({
        relation: selection.relation,
        champion: selection.relatedChampion,
        role: selection.relatedRole,
      }),
    );
  }
  const dsl = `ANALYZE player
WHEN ${conditions.join('\n  AND ')}
RETURN win_rate() AS win_rate,
  count() AS games`;
  return {
    document: createSyncDocument(parsedProgram(dsl), dsl),
    title: `${selection.champion} ${selection.role} 픽 성과`,
  };
}

export function appendSequence(sync: SyncDocument, selection: SequenceSelection): SyncDocument {
  if (sync.ast.body.kind !== 'SimpleStmt') return sync;
  const side = sync.ast.analyze?.side ?? 'blue';
  let next = applyCardEdit(sync, {
    kind: 'replace',
    path: ['body', 'chain'],
    value: chainFromDsl(
      selection.startScope,
      selection.startEvent,
      selection.endScope,
      selection.endEvent,
      selection.seconds,
      selection.startOrdinal,
      selection.endOrdinal,
      selection.endRoles,
      selection.endRoleMode,
    ),
  });
  next = applyCardEdit(next, {
    kind: 'replace',
    path: ['body', 'returns', 0],
    value: returnItem(side, 'success_rate()'),
  });
  return next;
}

export function compareWithOpposite(sync: SyncDocument): SyncDocument {
  if (sync.ast.body.kind !== 'SimpleStmt' || !sync.ast.body.when) return sync;
  return applyCardEdit(sync, { kind: 'compareWithOpposite' });
}

export function appendGroupKey(sync: SyncDocument, id: string): SyncDocument {
  const value: GroupKey = {
    kind: 'GroupKey',
    expr: { kind: 'Identifier', name: id },
    alias: null,
  };
  return applyCardEdit(sync, {
    kind: 'setGroupBy',
    value: [...sync.ast.body.groupBy, value],
  });
}

export function appendDragonTypeGroup(sync: SyncDocument, numberedDragon: EventRef): SyncDocument {
  const value: GroupKey = {
    kind: 'GroupKey',
    expr: {
      kind: 'FieldAccess',
      object: { ...numberedDragon },
      field: 'monster_subtype',
    },
    alias: null,
  };
  return applyCardEdit(sync, {
    kind: 'setGroupBy',
    value: [...sync.ast.body.groupBy, value],
  });
}

export function changeAnalysisTarget(
  sync: SyncDocument,
  choice: AnalysisTargetChoice,
): SyncDocument {
  const value =
    choice === 'match' || choice === 'player'
      ? {
          kind: 'ScopeRef' as const,
          entity: choice,
          ...(choice === 'player' &&
          sync.ast.analyze?.entity === 'player' &&
          sync.ast.analyze.selector !== undefined
            ? { selector: sync.ast.analyze.selector }
            : {}),
        }
      : choice === 'team'
        ? { kind: 'ScopeRef' as const, entity: 'team' as const }
        : { kind: 'ScopeRef' as const, entity: 'team' as const, side: choice };
  let next = applyCardEdit(sync, {
    kind: 'setAnalyze',
    value,
  });
  if (
    (choice === 'team' || choice === 'match' || choice === 'player') &&
    next.ast.body.returns.length > 0
  ) {
    next.ast.body.returns.forEach((item, index) => {
      if (
        item.expr.kind === 'CallExpr' &&
        (item.expr.callee === 'win_rate' || item.expr.callee === 'loss_rate')
      ) {
        const expression = choice === 'match' ? 'count()' : `${item.expr.callee}()`;
        const replacement = returnItem('blue', expression);
        next = applyCardEdit(next, {
          kind: 'replace',
          path: ['body', 'returns', index],
          value: {
            ...replacement,
            // A win/loss alias would make the match count look like a rate after this
            // intentionally semantic conversion.
            alias: choice === 'match' && item.alias !== null ? 'games' : item.alias,
          },
        });
      }
    });
  }
  return next;
}

export function changePlayerSelector(sync: SyncDocument, selector: string): SyncDocument {
  if (sync.ast.analyze?.entity !== 'player') return sync;
  const trimmed = selector.trim();
  return applyCardEdit(sync, {
    kind: 'setAnalyze',
    value: {
      kind: 'ScopeRef',
      entity: 'player',
      ...(trimmed ? { selector: trimmed } : {}),
    },
  });
}
