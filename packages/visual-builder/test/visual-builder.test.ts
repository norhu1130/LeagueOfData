import { astEquals } from '@lol/ast';
import { parse } from '@lol/dsl';
import { describe, expect, it } from 'vitest';
import {
  applyBuilderPatch,
  applyCardEdit,
  applyDslEdit,
  createSyncDocument,
  project,
  shouldAcceptWorkerResult,
} from '../src/index.js';

function ast(source: string) {
  const result = parse(source);
  if (!result.ast) throw new Error('AST is absent');
  return result.ast;
}

describe('card projection', () => {
  it('projects an item-response analysis as an editable target and condition', () => {
    const projection = project(
      ast(`ANALYZE player
WHEN player.champion = "Aatrox"
  AND player.item_purchase.item = 3071
  AND ((player.side = "BLUE" AND NOT red.item_purchase.item = 3123)
    OR (player.side = "RED" AND NOT blue.item_purchase.item = 3123))
RETURN loss_rate(), count()`),
    );
    expect(projection.full).toBe(true);
    expect(projection.cards.map((card) => card.type)).toEqual([
      'target',
      'itemResponse',
      'measure',
      'measure',
    ]);
    expect(projection.cards[0]?.labelKo).toContain('Aatrox');
  });

  it('projects an opponent champion set and missing counter items as one card', () => {
    const projection = project(
      ast(`ANALYZE team
WHEN opponent_has_champion("Trundle", "Briar", "Vladimir", "Aatrox")
  AND NOT (item_purchase.item IN (3011, 3033, 3075, 3076, 3123, 3165, 3916, 6609))
RETURN win_rate(), count()`),
    );
    expect(projection.full).toBe(true);
    expect(projection.advancedCount).toBe(0);
    expect(projection.cards.map((card) => card.type)).toEqual([
      'target',
      'counterItem',
      'measure',
      'measure',
    ]);
  });

  it('projects the AI positive-purchase variant as the same editable card type', () => {
    const projection = project(
      ast(`ANALYZE team
WHEN opponent_has_champion("Trundle", "Briar", "Vladimir", "Aatrox", "Volibear")
  AND item_purchase.item IN (3011, 3033, 3075, 3076, 3123, 3165, 3916, 6609)
RETURN win_rate()`),
    );
    expect(projection.full).toBe(true);
    expect(projection.cards.map((card) => card.type)).toEqual(['target', 'counterItem', 'measure']);
  });

  it('projects a point-in-time inventory condition as a counter-item card', () => {
    const projection = project(
      ast(`ANALYZE team
WHEN opponent_has_champion("Trundle", "Briar")
  AND NOT owns_item_at(15:00, 3165, 6609)
RETURN win_rate(), count()`),
    );
    expect(projection.full).toBe(true);
    expect(projection.cards.map((card) => card.type)).toEqual([
      'target',
      'counterItem',
      'measure',
      'measure',
    ]);
  });

  it('projects point-in-time enemy and response items as one item-response card', () => {
    const projection = project(
      ast(`ANALYZE team
WHEN opponent.owns_item_at(15:00, 3071)
  AND NOT owns_item_at(15:00, 3165, 6609)
RETURN win_rate(), count()`),
    );
    expect(projection.full).toBe(true);
    expect(projection.cards.map((card) => card.type)).toEqual([
      'target',
      'itemResponse',
      'measure',
      'measure',
    ]);
  });

  it('projects an event and its location as one qualified event card', () => {
    const projection = project(
      ast(
        'ANALYZE blue WHEN blue.first_blood AND first_blood.position IN region("top_lane") RETURN win_rate()',
      ),
    );
    expect(projection.cards.map((card) => card.type)).toEqual(['target', 'event', 'measure']);
    expect(projection.full).toBe(true);
    expect(projection.cards.every((card) => card.id.length > 10)).toBe(true);
  });

  it('preserves an OR subtree as one locked advanced card outside comparison mode', () => {
    const projection = project(
      ast(
        'ANALYZE blue WHEN (blue.first_blood OR red.first_blood) AND blue.gold_diff(10:00) >= 1500 RETURN win_rate()',
      ),
    );
    const advanced = projection.cards.filter((card) => card.type === 'advanced');
    expect(advanced).toHaveLength(1);
    expect(advanced[0]?.editable).toBe(false);
    expect(advanced[0]?.removable).toBe(true);
    expect(advanced[0]?.advancedReasonKo).toContain('또는');
  });

  it('projects generated comparisons as editable cards without advanced fragments', () => {
    for (const source of [
      'ANALYZE blue COMPARE WHEN blue.first_blood VS WHEN NOT blue.first_blood RETURN win_rate()',
      'ANALYZE blue COMPARE WHEN blue.gold_diff(10:00) >= 1500 VS WHEN NOT blue.gold_diff(10:00) >= 1500 RETURN win_rate()',
      'ANALYZE blue COMPARE WHEN blue.first_blood AND red.turret_destroy VS WHEN NOT (blue.first_blood AND red.turret_destroy) RETURN win_rate()',
    ]) {
      const projection = project(ast(source));
      expect(projection.full, source).toBe(true);
      expect(projection.advancedCount, source).toBe(0);
      expect(projection.cards.filter((card) => card.type === 'compare')).toHaveLength(2);
    }
  });

  it('keeps card identity stable when an editable slot changes', () => {
    const original = ast('ANALYZE blue WHEN blue.gold_diff(10:00) >= 1500 RETURN win_rate()');
    const before = project(original).cards.find((card) => card.type === 'condition');
    if (!before || before.node.kind !== 'BinaryExpr') throw new Error('condition card is absent');
    const changed = applyBuilderPatch(original, {
      kind: 'replace',
      path: before.path,
      value: { ...before.node, right: { kind: 'NumberLit', value: 2000 } },
    });
    const after = project(changed).cards.find((card) => card.type === 'condition');
    expect(after?.id).toBe(before.id);
  });

  it('projects excess group keys and comparison arms as removable advanced cards', () => {
    const groups = project(ast('ANALYZE player GROUP BY champion, role, side RETURN win_rate()'));
    expect(groups.cards.at(-2)?.type).toBe('advanced');
    expect(groups.cards.at(-2)?.removable).toBe(true);

    const comparison = project(
      ast(
        'ANALYZE blue COMPARE WHEN blue.first_blood VS WHEN red.first_blood VS WHEN blue.first_turret_destroy RETURN win_rate()',
      ),
    );
    const excessArm = comparison.cards.find(
      (card) => card.type === 'advanced' && card.path.join('.') === 'body.arms.2',
    );
    expect(excessArm?.removable).toBe(true);
  });

  it('projects a comparison arm containing nested boolean conditions', () => {
    const projection = project(
      ast(
        'COMPARE WHEN blue.first_blood AND (red.first_blood OR kill) VS WHEN red.first_blood RETURN win_rate()',
      ),
    );
    expect(projection.full).toBe(true);
    expect(projection.advancedCount).toBe(0);
    expect(projection.cards[0]).toMatchObject({ type: 'compare', editable: true });
  });

  it('locks the whole sequence card when its hidden condition is unsupported', () => {
    const projection = project(
      ast('AFTER blue.kill WITHIN 90s IF role IN ("TOP", "MID") RETURN success_rate()'),
    );
    const sequence = projection.cards.find(
      (card) => card.path[1] === 'chain' && card.type !== 'target',
    );
    expect(sequence?.type).toBe('advanced');
    expect(sequence?.path).toEqual(['body', 'chain']);
    expect(sequence?.removable).toBe(true);
  });
});

describe('DSL and builder synchronization state machine', () => {
  it('retains the last successful AST while typing invalid input', () => {
    const original = ast('ANALYZE blue WHEN blue.first_blood RETURN win_rate()');
    const document = createSyncDocument(original);
    const stale = applyDslEdit(document, 'ANALYZE blue WHEN blue.first_blood AND');
    expect(stale.state).toBe('stale');
    expect(stale.ast).toBe(original);
    expect(stale.dslText).toContain('AND');
    expect(stale.diagnostics.some((item) => item.severity === 'error')).toBe(true);
  });

  it('preserves independently scoped advanced conditions when changing the result target', () => {
    const original = ast(
      'ANALYZE blue WHEN (blue.first_blood OR red.first_blood) AND first_blood.time < 5m RETURN win_rate()',
    );
    const fromDsl = applyDslEdit(
      createSyncDocument(original),
      'ANALYZE blue\nWHEN (blue.first_blood OR red.first_blood) AND first_blood.time < 5m\nRETURN win_rate()',
    );
    expect(fromDsl.state).toBe('advanced');
    const changed = applyCardEdit(fromDsl, {
      kind: 'setAnalyze',
      value: { kind: 'ScopeRef', entity: 'team', side: 'red' },
    });
    expect(changed.origin).toBe('builder');
    expect(changed.state).toBe('advanced');
    expect(changed.dslText).toContain('blue.first_blood OR red.first_blood');
  });

  it('removes only the selected subtree when deleting an advanced condition', () => {
    const original = ast(
      'ANALYZE blue WHEN (blue.first_blood OR red.first_blood) AND first_blood.time < 5m RETURN win_rate()',
    );
    const advanced = project(original).cards.find((card) => card.type === 'advanced');
    if (!advanced) throw new Error('advanced card is absent');
    const changed = applyCardEdit(createSyncDocument(original), {
      kind: 'removeCondition',
      path: advanced.path,
    });
    expect(changed.dslText).not.toContain(' OR ');
    expect(changed.dslText).toContain('first_blood.time < 5m');
    expect(astEquals(changed.ast, original)).toBe(false);
  });

  it('accepts only worker responses for the current revision', () => {
    expect(shouldAcceptWorkerResult(3, 3)).toBe(true);
    expect(shouldAcceptWorkerResult(2, 3)).toBe(false);
  });

  it('fails closed when a card patch cannot be reparsed without errors', () => {
    const original = createSyncDocument(
      ast('COMPARE WHEN blue.first_blood VS WHEN red.first_blood RETURN win_rate()'),
    );
    const arm = project(original.ast).cards.find((card) => card.type === 'compare');
    if (!arm || arm.node.kind !== 'CompareArm') throw new Error('comparison arm is absent');
    const changed = applyCardEdit(original, {
      kind: 'replace',
      path: arm.path,
      value: { ...arm.node, label: '블루' },
    });
    expect(changed).toBe(original);
    expect(changed.ast.body).toEqual(original.ast.body);
  });

  it('updates the DSL while preserving other conditions in a numeric slot patch', () => {
    const original = ast('ANALYZE blue WHEN blue.gold_diff(10:00) >= 1500 RETURN blue.win_rate');
    const condition = project(original).cards.find((card) => card.type === 'condition');
    if (!condition || condition.node.kind !== 'BinaryExpr')
      throw new Error('condition card is absent');
    const changed = applyCardEdit(createSyncDocument(original), {
      kind: 'replace',
      path: condition.path,
      value: { ...condition.node, right: { kind: 'NumberLit', value: 2000 } },
    });
    expect(changed.dslText).toContain('>= 2000');
    expect(changed.dslText).toContain('RETURN blue.win_rate');
  });

  it('can add and remove a grouping key', () => {
    const original = createSyncDocument(
      ast('ANALYZE blue WHEN blue.first_blood RETURN blue.win_rate'),
    );
    const grouped = applyCardEdit(original, {
      kind: 'setGroupBy',
      value: [
        {
          kind: 'GroupKey',
          expr: { kind: 'Identifier', name: 'position_region' },
          alias: null,
        },
      ],
    });
    expect(grouped.dslText).toContain('GROUP BY position_region');
    expect(project(grouped.ast).cards.some((card) => card.type === 'groupBy')).toBe(true);
    expect(applyCardEdit(grouped, { kind: 'setGroupBy', value: [] }).dslText).not.toContain(
      'GROUP BY',
    );
  });

  it('marks ordinary condition and sequence cards as removable', () => {
    const conditionProgram = ast(
      'ANALYZE blue WHEN blue.first_blood AND death.position IN region("top_lane") RETURN blue.win_rate',
    );
    const conditionCards = project(conditionProgram).cards.filter((card) =>
      ['event', 'location'].includes(card.type),
    );
    expect(conditionCards).toHaveLength(2);
    expect(conditionCards.every((card) => card.removable)).toBe(true);

    const sequenceProgram = ast(
      'AFTER blue.kill WITHIN 90s IF blue.dragon_kill RETURN success_rate()',
    );
    expect(project(sequenceProgram).cards.find((card) => card.type === 'sequence')?.removable).toBe(
      true,
    );
  });

  it('changes the result target without rewriting independently scoped conditions', () => {
    const original = ast(
      'ANALYZE blue WHEN blue.first_blood AND blue.gold_diff(10:00) >= 1500 RETURN blue.win_rate',
    );
    const changed = applyBuilderPatch(original, {
      kind: 'setAnalyze',
      value: { kind: 'ScopeRef', entity: 'team', side: 'red' },
    });
    const dsl = createSyncDocument(changed).dslText;
    expect(dsl).toContain('ANALYZE red');
    expect(dsl).toContain('blue.first_blood');
    expect(dsl).toContain('blue.gold_diff');
    expect(dsl).toContain('red.win_rate');
    if (changed.body.kind !== 'SimpleStmt' || changed.body.when?.kind !== 'BinaryExpr') {
      throw new Error('expected combined condition');
    }
    const event = changed.body.when.left;
    if (event.kind !== 'EventPredicate') throw new Error('expected event predicate');
    expect(event.event.bindingId).toMatch(/^blue\./);
  });

  it('retargets result-relative scopes across blue, any-team target, and red', () => {
    const blue = ast(
      'ANALYZE blue WHEN blue.first_blood RETURN blue.win_rate, avg(duration(blue.first_blood, blue.first_turret_destroy))',
    );
    const anyTeam = applyBuilderPatch(blue, {
      kind: 'setAnalyze',
      value: { kind: 'ScopeRef', entity: 'team' },
    });
    const anyDsl = createSyncDocument(anyTeam).dslText;
    expect(anyDsl).toContain('ANALYZE team');
    expect(anyDsl).toContain('RETURN win_rate()');
    expect(anyDsl).toContain('duration(first_blood, first_turret_destroy)');
    expect(anyDsl).toContain('WHEN blue.first_blood');

    const red = applyBuilderPatch(anyTeam, {
      kind: 'setAnalyze',
      value: { kind: 'ScopeRef', entity: 'team', side: 'red' },
    });
    const redDsl = createSyncDocument(red).dslText;
    expect(redDsl).toContain('RETURN red.win_rate()');
    expect(redDsl).toContain('duration(red.first_blood, red.first_turret_destroy)');
    expect(redDsl).toContain('WHEN blue.first_blood');
  });

  it('does not collapse explicit any-team scopes into target-relative scopes', () => {
    const anyTeam = ast('ANALYZE team RETURN win_rate(), team.count()');
    const blue = applyBuilderPatch(anyTeam, {
      kind: 'setAnalyze',
      value: { kind: 'ScopeRef', entity: 'team', side: 'blue' },
    });
    const dsl = createSyncDocument(blue).dslText;
    expect(dsl).toContain('blue.win_rate()');
    expect(dsl).toContain('team.count()');
  });

  it('projects hidden or lossy card shapes as locked advanced fragments', () => {
    const sources = [
      'ANALYZE player RETURN player.win_rate',
      'WHEN blue.first_turret_destroy RETURN win_rate()',
      'AFTER blue.kill WITHIN 90s IF blue.dragon_kill AND blue.first_blood RETURN success_rate()',
      'RETURN avg(duration(red.first_blood, blue.first_turret_destroy))',
    ];
    for (const source of sources) {
      const projection = project(ast(source));
      expect(projection.full, source).toBe(false);
      expect(
        projection.cards.some((card) => card.type === 'advanced'),
        source,
      ).toBe(true);
    }
  });

  it('projects cross-team sequence endpoints as one editable sequence card', () => {
    const projection = project(
      ast('AFTER blue.kill WITHIN 90s IF red.dragon_kill RETURN success_rate()'),
    );
    expect(projection.full).toBe(true);
    expect(projection.cards.filter((card) => card.type === 'sequence')).toHaveLength(1);
    expect(projection.cards.some((card) => card.type === 'advanced')).toBe(false);
  });

  it('creates a generic condition-versus-opposite comparison and preserves outputs', () => {
    const original = ast(
      'ANALYZE blue WHEN blue.gold_diff(10:00) >= 1500 GROUP BY position_region RETURN blue.win_rate, count()',
    );
    const changed = applyBuilderPatch(original, { kind: 'compareWithOpposite' });
    expect(changed.body.kind).toBe('CompareStmt');
    if (changed.body.kind !== 'CompareStmt') throw new Error('expected comparison');
    expect(changed.body.arms).toHaveLength(2);
    expect(changed.body.groupBy).toHaveLength(1);
    expect(changed.body.returns).toHaveLength(2);
    const dsl = createSyncDocument(changed).dslText;
    expect(dsl).toContain('WHEN blue.gold_diff(10:00) >= 1500');
    expect(dsl).toContain('VS WHEN NOT blue.gold_diff(10:00) >= 1500');
    expect(dsl).toContain('GROUP BY position_region');
    expect(dsl).toContain('RETURN blue.win_rate(), count()');
  });

  it('removes only structurally safe advanced fragments', () => {
    const excess = ast(
      'ANALYZE blue GROUP BY side, patch, position_region RETURN win_rate(), count(), loss_rate(), avg(team.duration_s), median(team.duration_s), min(team.duration_s), max(team.duration_s)',
    );
    const advanced = project(excess).cards.filter((card) => card.type === 'advanced');
    const changed = advanced.reduce(
      (current, card) => applyBuilderPatch(current, { kind: 'removeCondition', path: card.path }),
      excess,
    );
    expect(changed.body.groupBy).toHaveLength(2);
    expect(changed.body.returns).toHaveLength(6);

    const twoArms = ast(
      'ANALYZE blue COMPARE WHEN blue.first_blood OR red.first_blood VS WHEN blue.first_turret_destroy RETURN win_rate()',
    );
    const locked = project(twoArms).cards.find((card) => card.type === 'advanced');
    if (!locked) throw new Error('advanced comparison condition is absent');
    expect(locked.removable).toBe(false);
    expect(applyBuilderPatch(twoArms, { kind: 'removeCondition', path: locked.path })).toBe(
      twoArms,
    );
  });

  it('reparses canonical DSL after card edits so spans match the rendered text', () => {
    const original = createSyncDocument(
      ast('ANALYZE blue WHEN blue.gold_diff(10:00) >= 1500 RETURN win_rate()'),
    );
    const condition = project(original.ast).cards.find((card) => card.type === 'condition');
    if (!condition || condition.node.kind !== 'BinaryExpr') throw new Error('condition is absent');
    const changed = applyCardEdit(original, {
      kind: 'replace',
      path: condition.path,
      value: { ...condition.node, right: { kind: 'NumberLit', value: 2000 } },
    });
    const changedCondition = project(changed.ast).cards.find((card) => card.type === 'condition');
    expect(changedCondition?.node.span).toBeDefined();
    const [start, end] = changedCondition!.node.span!;
    expect(changed.dslText.slice(start, end)).toContain('2000');
  });
});
