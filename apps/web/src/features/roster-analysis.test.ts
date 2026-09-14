import { describe, expect, it } from 'vitest';
import { parse } from '@lol/dsl';
import {
  playerRosterDsl,
  playerRosterLabelKo,
  playerRosterSelection,
  rosterRelationDsl,
  rosterRelationLabelKo,
  rosterRelationSelection,
} from './roster-analysis.js';

function condition(source: string) {
  const body = parse(`ANALYZE player WHEN ${source} RETURN win_rate()`).ast?.body;
  if (!body) throw new Error('fixture did not parse');
  if (body.kind !== 'SimpleStmt' || !body.when) throw new Error('missing condition');
  return body.when;
}

describe('roster analysis selections', () => {
  it('round-trips a player champion condition', () => {
    const selected = playerRosterSelection(condition('player.champion = "Ahri"'));
    expect(selected).toEqual({ field: 'champion', value: 'Ahri' });
    expect(playerRosterDsl(selected!)).toBe('player.champion = "Ahri"');
    expect(playerRosterLabelKo(selected!)).toBe('분석 대상 선수의 챔피언: Ahri');
  });

  it('round-trips a role-specific opponent condition', () => {
    const selected = rosterRelationSelection(
      condition('opponent_has_champion_in_role("LeBlanc", "MID")'),
    );
    expect(selected).toEqual({
      relation: 'opponent_has_champion_in_role',
      champion: 'LeBlanc',
      role: 'MID',
    });
    expect(rosterRelationDsl(selected!)).toBe('opponent_has_champion_in_role("LeBlanc", "MID")');
  });

  it('uses the actual ally relation in the user-facing label', () => {
    const selected = rosterRelationSelection(condition('ally_has_champion("Rakan")'));
    expect(selected).toEqual({ relation: 'ally_has_champion', champion: 'Rakan' });
    expect(rosterRelationLabelKo(selected!)).toBe('같은 팀에 Rakan 챔피언이 있습니다');
  });
});
