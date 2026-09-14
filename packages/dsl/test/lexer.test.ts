import { describe, it, expect } from 'vitest';
import { lex } from '../src/lexer.js';
import type { TokenType } from '../src/tokens.js';

const types = (src: string): TokenType[] => lex(src).tokens.map((t) => t.type);
const first = (src: string) => lex(src).tokens[0]!;

describe('duration literals', () => {
  it('reads units attached to numbers as durations', () => {
    expect(first('90s').type).toBe('DURATION');
    expect(first('90s').value).toBe(90);
    expect(first('2m').value).toBe(120);
    expect(first('1m30s').value).toBe(90);
    expect(first('1h2m3s').value).toBe(3723);
    expect(first('500ms').value).toBe(0.5);
  });

  it('rejects a whitespace-separated unit and suggests joining it', () => {
    const result = lex('90 s');
    expect(result.tokens.map((t) => t.type)).toEqual(['NUMBER', 'IDENT', 'EOF']);
    expect(result.diagnostics[0]?.code).toBe('E-LEX-003');
    expect(result.diagnostics[0]?.fixText).toBe('90s');
  });

  it('does not combine units in reverse order', () => {
    // Splitting `30s1m` into two durations lets the parser expose the typo.
    const tokens = lex('30s1m').tokens;
    expect(tokens.map((t) => t.type)).toEqual(['DURATION', 'DURATION', 'EOF']);
    expect(tokens[0]!.text).toBe('30s');
    expect(tokens[0]!.value).toBe(30);
    expect(tokens[1]!.value).toBe(60);
  });

  it('does not treat an unknown unit as a duration', () => {
    // Unit letters are consumed together; unknown `sx` makes `90sx` a number plus name.
    const tokens = lex('90sx').tokens;
    expect(tokens.map((t) => t.type)).toEqual(['NUMBER', 'IDENT', 'EOF']);
  });
});

describe('clock literals', () => {
  it('combines mm:ss into one token', () => {
    expect(first('10:00').type).toBe('CLOCK');
    expect(first('10:00').value).toBe(600);
    expect(first('1:02:30').value).toBe(3750);
  });

  it('tokenizes gold_diff(10:00) correctly', () => {
    expect(types('gold_diff(10:00)')).toEqual(['IDENT', 'LPAREN', 'CLOCK', 'RPAREN', 'EOF']);
  });

  it.each(['10:60', '1:2', '1:02:03:04'])('rejects malformed clock %s', (source) => {
    const result = lex(source);
    expect(result.tokens[0]?.type).toBe('CLOCK');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('E-SYN-024');
  });
});

describe('keywords', () => {
  it('is case-insensitive', () => {
    expect(types('when WHEN When')).toEqual(['WHEN', 'WHEN', 'WHEN', 'EOF']);
  });

  it('reads keywords as names after a dot', () => {
    // Member names such as `event.at` and `team.in` may overlap keywords.
    expect(types('event.at')).toEqual(['IDENT', 'DOT', 'IDENT', 'EOF']);
    expect(types('team.in')).toEqual(['IDENT', 'DOT', 'IDENT', 'EOF']);
    expect(types('AT event')).toEqual(['AT', 'IDENT', 'EOF']);
  });
});

describe('strings', () => {
  it('interprets escapes', () => {
    expect(first('"a\\"b"').stringValue).toBe('a"b');
    expect(first('"a\\nb"').stringValue).toBe('a\nb');
  });

  it('reports an unterminated string', () => {
    const result = lex('"Dariu');
    expect(result.diagnostics[0]?.code).toBe('E-LEX-007');
    expect(result.tokens[0]?.stringValue).toBe('Dariu');
  });
});

describe('comments and whitespace', () => {
  it('skips line and block comments', () => {
    expect(types('WHEN -- 설명\nRETURN')).toEqual(['WHEN', 'RETURN', 'EOF']);
    expect(types('WHEN /* 설명 */ RETURN')).toEqual(['WHEN', 'RETURN', 'EOF']);
  });

  it('reports an unterminated block comment', () => {
    expect(lex('WHEN /* 설명').diagnostics[0]?.code).toBe('E-LEX-008');
  });
});

describe('operators', () => {
  it('reads two-character operators first', () => {
    expect(types('>= <= != <> = > <')).toEqual([
      'GTE',
      'LTE',
      'NEQ',
      'NEQ',
      'EQ',
      'GT',
      'LT',
      'EOF',
    ]);
  });

  it('converts percentage literals to rates', () => {
    expect(first('55%').type).toBe('PERCENT');
    expect(first('55%').value).toBeCloseTo(0.55);
  });
});

describe('source locations', () => {
  it('gives every token a source range', () => {
    const src = 'WHEN blue.first_blood';
    for (const token of lex(src).tokens) {
      expect(src.slice(token.start, token.end)).toBe(token.text);
    }
  });
});

describe('complete examples', () => {
  it('tokenizes §14 Example 4', () => {
    expect(types('WHEN blue.gold_diff(10:00) >= 1500 RETURN blue.win_rate')).toEqual([
      'WHEN',
      'IDENT',
      'DOT',
      'IDENT',
      'LPAREN',
      'CLOCK',
      'RPAREN',
      'GTE',
      'NUMBER',
      'RETURN',
      'IDENT',
      'DOT',
      'IDENT',
      'EOF',
    ]);
  });
});
