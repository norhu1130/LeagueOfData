import { describe, expect, it } from 'vitest';
import { documentFromDsl } from './analysis-dsl.js';
import {
  appendCondition,
  appendSequence,
  changeAnalysisTarget,
  createChampionDraft,
} from './builder-commands.js';

describe('builder commands', () => {
  it('appends a condition without mutating the input document', () => {
    const source = documentFromDsl('ANALYZE blue\nRETURN blue.win_rate');
    const next = appendCondition(source, 'blue.first_blood');

    expect(next).not.toBe(source);
    expect(source.ast.body.kind).toBe('SimpleStmt');
    expect(next.ast.body.kind).toBe('SimpleStmt');
    if (next.ast.body.kind === 'SimpleStmt') expect(next.ast.body.when).not.toBeNull();
  });

  it('creates a champion analysis as a player-grain document', () => {
    const draft = createChampionDraft({
      champion: 'Ahri',
      role: 'MID',
      relation: 'opponent_has_champion_in_role',
      relatedChampion: 'LeBlanc',
      relatedRole: 'MID',
    });

    expect(draft.title).toBe('Ahri MID 픽 성과');
    expect(draft.document.ast.analyze?.entity).toBe('player');
    expect(draft.document.dslText).toContain('opponent_has_champion_in_role');
  });

  it('adds a timed event sequence and success-rate result', () => {
    const source = documentFromDsl('ANALYZE blue\nRETURN blue.win_rate');
    const next = appendSequence(source, {
      startEvent: 'kill',
      endEvent: 'dragon_kill',
      seconds: 90,
      startScope: 'target',
      endScope: 'opponent',
      startOrdinal: 'any',
      endOrdinal: 'first',
      endRoles: [],
      endRoleMode: 'any',
    });

    expect(next.ast.body.kind).toBe('SimpleStmt');
    if (next.ast.body.kind === 'SimpleStmt') {
      expect(next.ast.body.chain?.window?.seconds).toBe(90);
      expect(next.ast.body.returns[0]?.expr.kind).toBe('CallExpr');
    }
  });

  it('normalizes a side-specific win rate when switching to all teams', () => {
    const source = documentFromDsl('ANALYZE blue\nRETURN blue.win_rate');
    const next = changeAnalysisTarget(source, 'team');

    expect(next.ast.analyze).toMatchObject({ kind: 'ScopeRef', entity: 'team' });
    expect(next.dslText).toContain('RETURN win_rate()');
  });

  it('switches between match and player analysis grains', () => {
    const source = documentFromDsl('ANALYZE blue\nRETURN blue.win_rate');
    const player = changeAnalysisTarget(source, 'player');
    expect(player.ast.analyze).toMatchObject({ kind: 'ScopeRef', entity: 'player' });
    expect(player.dslText).toContain('ANALYZE player');
    expect(player.dslText).toContain('RETURN win_rate()');

    const match = changeAnalysisTarget(player, 'match');
    expect(match.ast.analyze).toMatchObject({ kind: 'ScopeRef', entity: 'match' });
    expect(match.dslText).toContain('ANALYZE match');
    expect(match.dslText).toContain('RETURN count()');
  });

  it('preserves a selected player while editing the player target', () => {
    const source = documentFromDsl('ANALYZE player("Faker")\nRETURN win_rate() AS wins');
    const next = changeAnalysisTarget(source, 'player');

    expect(next.ast.analyze).toMatchObject({ entity: 'player', selector: 'Faker' });
    expect(next.dslText).toContain('player("Faker")');
  });

  it('does not label a match count as a win rate after switching grains', () => {
    const source = documentFromDsl('ANALYZE blue\nRETURN blue.win_rate AS win_rate');
    const next = changeAnalysisTarget(source, 'match');

    expect(next.dslText).toContain('RETURN count() AS games');
  });
});
