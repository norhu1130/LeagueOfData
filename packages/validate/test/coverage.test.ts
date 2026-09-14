/**
 * Visual-builder representability (§28).
 *
 * Unsupported DSL must not destroy the builder. Supported fragments remain cards and the rest
 * is preserved as locked advanced conditions.
 */
import { describe, it, expect } from 'vitest';
import { parse, printNode } from '@lol/dsl';
import { coverage, BUILDER_LIMITS } from '../src/index.js';

const cov = (src: string) => {
  const { ast } = parse(src);
  if (!ast) throw new Error(`parse failed: ${src}`);
  return coverage(ast);
};

describe('card-representable analyses', () => {
  it('keeps the symmetric item-response query in one editable card', () => {
    const result = cov(`ANALYZE player
WHEN player.champion = "Aatrox"
  AND player.item_purchase.item = 3071
  AND ((player.side = "BLUE" AND NOT red.item_purchase.item = 3123)
    OR (player.side = "RED" AND NOT blue.item_purchase.item = 3123))
RETURN loss_rate(), count()`);
    expect(result.full).toBe(true);
    expect(result.conditions).toHaveLength(1);
  });

  it('supports any enemy member, absence, and multiple response items in one card', () => {
    const source = `ANALYZE team
WHEN ((team.side = "BLUE" AND NOT (red.item_purchase.item IN (3071, 3153))
    AND NOT (item_purchase.item IN (3123, 3075)))
  OR (team.side = "RED" AND NOT (blue.item_purchase.item IN (3071, 3153))
    AND NOT (item_purchase.item IN (3123, 3075))))
RETURN win_rate(), count()`;
    const result = cov(source);
    expect(result.full).toBe(true);
    expect(result.conditions).toHaveLength(1);
  });

  it('keeps an opponent champion set and missing counter items in one editable card', () => {
    const result = cov(`ANALYZE team
WHEN opponent_has_champion("Trundle", "Briar", "Vladimir", "Aatrox")
  AND NOT (item_purchase.item IN (3011, 3033, 3075, 3076, 3123, 3165, 3916, 6609))
RETURN win_rate(), count()`);
    expect(result.full).toBe(true);
    expect(result.conditions).toHaveLength(1);
    expect(result.unsupported).toHaveLength(0);
  });

  it('also exposes a positive team purchase condition instead of locking it', () => {
    const result = cov(`ANALYZE team
WHEN opponent_has_champion("Trundle", "Briar", "Vladimir", "Aatrox", "Volibear")
  AND item_purchase.item IN (3011, 3033, 3075, 3076, 3123, 3165, 3916, 6609)
RETURN win_rate()`);
    expect(result.full).toBe(true);
    expect(result.conditions).toHaveLength(1);
  });

  it('keeps a point-in-time inventory counter condition in one editable card', () => {
    const result = cov(`ANALYZE team
WHEN opponent_has_champion("Trundle", "Briar")
  AND NOT owns_item_at(15:00, 3165, 6609)
RETURN win_rate(), count()`);
    expect(result.full).toBe(true);
    expect(result.conditions).toHaveLength(1);
    expect(result.unsupported).toHaveLength(0);
  });

  it('keeps point-in-time enemy purchase and team response in one editable card', () => {
    const result = cov(`ANALYZE team
WHEN opponent.owns_item_at(15:00, 3071)
  AND NOT owns_item_at(15:00, 3165, 6609)
RETURN win_rate(), count()`);
    expect(result.full).toBe(true);
    expect(result.conditions).toHaveLength(1);
  });

  it.each([
    'ANALYZE blue WHEN blue.first_blood RETURN blue.win_rate',
    'ANALYZE blue WHEN blue.first_blood AND first_blood.position IN region("top_lane") RETURN blue.win_rate',
    'ANALYZE blue WHEN blue.gold_diff(10:00) >= 1500 RETURN blue.win_rate',
    'ANALYZE team WHEN gold_diff(10:00) < -500 RETURN win_rate()',
    'ANALYZE player WHEN player.xp_diff(12:00) > 300 RETURN win_rate()',
    'ANALYZE blue WHEN blue.first_blood RETURN avg(duration(blue.first_blood, blue.first_turret_destroy))',
    'AFTER blue.kill WITHIN 90s IF blue.dragon_kill RETURN success_rate()',
    'ANALYZE team WHEN first_blood RETURN win_rate()',
    'ANALYZE blue WHEN team.kill RETURN win_rate()',
    'ANALYZE blue WHEN team.kill.position IN region("river") RETURN win_rate()',
    'AFTER blue.kill WITHIN 90s IF red.dragon_kill RETURN success_rate()',
    'AFTER team.ward_placed WITHIN 90s IF opponent.baron_kill RETURN success_rate()',
  ])('%s', (src) => {
    const result = cov(src);
    expect(
      result.full,
      `expected card representation but classified as advanced: ${result.unsupported.map((u) => u.reason).join(', ')}`,
    ).toBe(true);
  });

  it('represents every DoD A–F analysis as cards', () => {
    // Section 38 requires non-developers to answer all questions through the UI.
    const dod = [
      'ANALYZE blue WHEN blue.first_blood RETURN blue.win_rate',
      'ANALYZE blue WHEN blue.first_blood AND first_blood.position IN region("top_lane") RETURN blue.win_rate',
      'ANALYZE blue WHEN blue.first_blood RETURN avg(duration(blue.first_blood, blue.first_turret_destroy))',
      'ANALYZE blue WHEN blue.gold_diff(10:00) >= 1500 RETURN blue.win_rate',
      'ANALYZE blue WHEN death.position IN region("custom_region_1") RETURN blue.win_rate',
      'AFTER blue.kill WITHIN 90s IF blue.dragon_kill RETURN success_rate()',
    ];
    for (const src of dod) expect(cov(src).full, src).toBe(true);
  });

  it('keeps event qualifiers together while splitting unrelated conditions', () => {
    const result = cov(
      'ANALYZE blue WHEN blue.first_blood AND first_blood.position IN region("top_lane") AND blue.gold_diff(10:00) >= 1500 RETURN win_rate()',
    );
    expect(result.conditions).toHaveLength(2);
    expect(result.full).toBe(true);
  });
});

describe('advanced DSL features', () => {
  it('classifies a top-level OR as advanced', () => {
    const result = cov('ANALYZE blue WHEN blue.first_blood OR red.first_blood RETURN win_rate()');
    expect(result.full).toBe(false);
    expect(result.unsupported[0]?.reason).toBe('or_at_top_level');
    expect(result.unsupported[0]?.reasonKo).toContain('또는');
  });

  it('retains supported cards alongside an advanced fragment', () => {
    // One advanced condition must not lock the entire builder (§28).
    const result = cov(
      'ANALYZE blue WHEN blue.first_blood AND (first_blood.time < 600s OR first_blood.position IN region("river")) RETURN win_rate()',
    );
    expect(result.full).toBe(false);
    expect(result.conditions).toHaveLength(1);
    expect(result.unsupported).toHaveLength(1);
  });

  it('preserves the original condition in an advanced fragment', () => {
    // Locked cards show DSL source so users can identify the unsupported fragment.
    const result = cov('ANALYZE blue WHEN blue.first_blood AND (a OR b) RETURN win_rate()');
    const fragment = result.unsupported[0]!;
    expect(printNode(fragment.node as never)).toContain('OR');
    expect(fragment.span).not.toBeNull();
  });

  it('classifies unsupported radius and proximity conditions as advanced', () => {
    const result = cov(
      'ANALYZE blue WHEN death.position WITHIN 1000 OF blue.top_outer_turret RETURN win_rate()',
    );
    expect(result.unsupported[0]?.reason).toBe('unsupported_spatial');
  });

  it('classifies excess return values as advanced', () => {
    const returns = Array.from({ length: BUILDER_LIMITS.maxReturns + 3 }, () => 'count()').join(
      ', ',
    );
    const result = cov(`ANALYZE blue RETURN ${returns}`);
    expect(result.unsupported.filter((u) => u.reason === 'too_many_returns')).toHaveLength(3);
  });

  it('classifies excess grouping keys as advanced', () => {
    const result = cov('ANALYZE player GROUP BY champion, role, side, patch RETURN win_rate()');
    expect(result.unsupported.filter((u) => u.reason === 'too_many_group_keys')).toHaveLength(2);
  });

  it('keeps a match-level champion pick rate editable', () => {
    expect(cov('ANALYZE match RETURN pick_rate("Ahri")').full).toBe(true);
  });

  it('classifies unsupported negated conditions as advanced', () => {
    // NOT folds into event predicates, but negated compound conditions lack a card.
    const result = cov('ANALYZE blue WHEN NOT (a AND b) RETURN win_rate()');
    expect(result.full).toBe(false);
  });

  it('keeps conditions without matching card controls advanced', () => {
    const sources = [
      'ANALYZE blue WHEN first_blood.time < 300s RETURN win_rate()',
      'ANALYZE player WHEN role IN ("TOP", "MID") RETURN win_rate()',
      'ANALYZE blue WHEN a AFTER b WITHIN 90s RETURN win_rate()',
    ];
    for (const src of sources) {
      expect(cov(src).full, src).toBe(false);
    }
  });

  it('keeps player roster and matchup conditions editable', () => {
    expect(cov('ANALYZE player WHEN player.role = "TOP" RETURN win_rate()').full).toBe(true);
    expect(
      cov(
        'ANALYZE player WHEN player.champion = "Ahri" AND opponent_has_champion_in_role("LeBlanc", "MID") RETURN win_rate(), count()',
      ).full,
    ).toBe(true);
    expect(
      cov(
        'ANALYZE player WHEN player.champion = "Xayah" AND ally_has_champion("Rakan") RETURN win_rate()',
      ).full,
    ).toBe(true);
  });

  it.each([
    'ANALYZE team WHEN death.role IN ("TOP", "MID") RETURN loss_rate()',
    'ANALYZE team WHEN all_values(death.role IN ("TOP", "MID")) RETURN loss_rate()',
    'ANALYZE team AFTER dragon_kill[4] WITHIN 90s IF death.role IN ("TOP") RETURN success_rate()',
  ])('keeps victim-role conditions editable as cards: %s', (source) => {
    expect(cov(source).full).toBe(true);
  });

  it('provides a Korean explanation for every advanced reason', () => {
    const sources = [
      'ANALYZE blue WHEN a OR b RETURN win_rate()',
      'ANALYZE blue WHEN death.position WITHIN 1000 OF x RETURN win_rate()',
      'ANALYZE player GROUP BY champion, role, side RETURN win_rate()',
    ];
    for (const src of sources) {
      for (const fragment of cov(src).unsupported) {
        expect(fragment.reasonKo.length, fragment.reason).toBeGreaterThan(10);
        // User-facing reasons avoid implementation terminology.
        expect(fragment.reasonKo).not.toContain('AST');
        expect(fragment.reasonKo).not.toContain('노드');
      }
    }
  });
});

describe('exact card-shape boundaries', () => {
  it('keeps a negated event editable through the occurrence selector', () => {
    const result = cov('ANALYZE blue WHEN NOT blue.first_blood RETURN win_rate()');
    expect(result.full).toBe(true);
    expect(result.conditions).toHaveLength(1);
  });

  it('preserves target-relative and explicit any-team event scopes as editable distinct shapes', () => {
    expect(cov('ANALYZE blue WHEN kill RETURN win_rate()').full).toBe(true);
    const explicitAnyTeam = cov('ANALYZE blue WHEN team.kill RETURN win_rate()');
    expect(explicitAnyTeam.full).toBe(true);
    expect(
      cov('ANALYZE blue WHEN team.kill.position IN region("river") RETURN win_rate()').full,
    ).toBe(true);
  });

  it('keeps catalog-backed duration endpoints editable', () => {
    expect(cov('ANALYZE team RETURN avg(duration(first_dragon_kill, baron_kill[1]))').full).toBe(
      true,
    );
  });

  it.each([
    'ANALYZE blue WHEN blue.first_turret_destroy RETURN win_rate()',
    'ANALYZE blue WHEN blue.first_turret_destroy.position IN region("top_lane") RETURN win_rate()',
    'ANALYZE player RETURN player.win_rate',
    'AFTER blue.kill WITHIN 90s IF blue.dragon_kill AND blue.first_blood RETURN success_rate()',
    'RETURN avg(duration(red.first_blood, blue.first_turret_destroy))',
  ])('locks a shape that the current card controls cannot preserve: %s', (source) => {
    expect(cov(source).full).toBe(false);
  });

  it('represents nested comparison conditions with visual cards', () => {
    expect(
      cov(
        'COMPARE WHEN blue.first_blood AND blue.gold_diff(10:00) >= 1500 VS WHEN NOT red.first_blood RETURN win_rate()',
      ).full,
    ).toBe(true);
    expect(
      cov(
        'ANALYZE team WHEN elder_dragon_kill RETURN win_rate(), avg(duration(elder_dragon_kill[last], victory))',
      ).full,
    ).toBe(true);
  });
});
