/**
 * Lexer.
 *
 * Three edge cases are handled here:
 *
 *   1. Duration units must touch their number; E-LEX-003 repairs whitespace-separated units.
 *   2. `10:00` is one CLOCK token, which is required by `gold_diff(10:00)`.
 *   3. Keywords immediately after `.` are names because member names may overlap keywords.
 */
import { KEYWORDS, type Token, type TokenType } from './tokens.js';

export interface LexDiagnostic {
  readonly code: string;
  readonly span: readonly [number, number];
  /** Replacement text for an automatic fix; absence requires manual editing. */
  readonly fixText?: string;
  /** Values interpolated into the diagnostic message. */
  readonly data?: Record<string, string>;
}

export interface LexResult {
  readonly tokens: Token[];
  readonly diagnostics: LexDiagnostic[];
}

const DURATION_UNITS: Readonly<Record<string, number>> = { ms: 0.001, s: 1, m: 60, h: 3600 };

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: LexDiagnostic[] = [];
  let i = 0;

  const peek = (offset = 0) => source[i + offset] ?? '';
  const push = (type: TokenType, start: number, extra: Partial<Token> = {}) => {
    tokens.push({ type, text: source.slice(start, i), start, end: i, ...extra });
  };

  while (i < source.length) {
    const start = i;
    const c = peek();

    // --- Whitespace ---
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // --- Comments ---
    if (c === '-' && peek(1) === '-') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && peek(1) === '*') {
      i += 2;
      while (i < source.length && !(peek() === '*' && peek(1) === '/')) i++;
      if (i >= source.length) {
        diagnostics.push({ code: 'E-LEX-008', span: [start, source.length] });
      } else {
        i += 2;
      }
      continue;
    }

    // --- Strings ---
    if (c === '"') {
      i++;
      let value = '';
      let closed = false;
      while (i < source.length) {
        const ch = source[i]!;
        if (ch === '\\') {
          const next = source[i + 1] ?? '';
          const mapped = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }[next];
          if (mapped !== undefined) {
            value += mapped;
            i += 2;
            continue;
          }
          value += ch;
          i++;
          continue;
        }
        if (ch === '"') {
          i++;
          closed = true;
          break;
        }
        if (ch === '\n') break;
        value += ch;
        i++;
      }
      if (!closed) diagnostics.push({ code: 'E-LEX-007', span: [start, i] });
      push('STRING', start, { stringValue: value });
      continue;
    }

    // --- Number-prefixed forms: CLOCK, DURATION, PERCENT, NUMBER ---
    if (isDigit(c)) {
      while (isDigit(peek())) i++;

      // (2) Combine clock forms such as `10:00` and `1:02:30` in the lexer.
      if (peek() === ':' && isDigit(peek(1))) {
        const partTexts = [source.slice(start, i)];
        while (peek() === ':' && isDigit(peek(1))) {
          i++;
          const partStart = i;
          while (isDigit(peek())) i++;
          partTexts.push(source.slice(partStart, i));
        }
        const parts = partTexts.map(Number);
        const validPartCount = parts.length === 2 || parts.length === 3;
        const fixedWidthTail = partTexts.slice(1).every((part) => part.length === 2);
        const validRanges = parts.slice(1).every((part) => part >= 0 && part < 60);
        if (!validPartCount || !fixedWidthTail || !validRanges) {
          diagnostics.push({ code: 'E-SYN-024', span: [start, i] });
        }
        const seconds =
          parts.length === 2
            ? parts[0]! * 60 + parts[1]!
            : parts[0]! * 3600 + parts[1]! * 60 + (parts[2] ?? 0);
        push('CLOCK', start, { value: seconds });
        continue;
      }

      if (peek() === '.' && isDigit(peek(1))) {
        i++;
        while (isDigit(peek())) i++;
      }

      // (1) Duration forms such as `90s` and `1m30s` require attached units.
      if (/[a-zA-Z]/.test(peek())) {
        const durationEnd = tryLexDuration(source, start);
        if (durationEnd !== null) {
          i = durationEnd.end;
          push('DURATION', start, { value: durationEnd.seconds });
          continue;
        }
      }

      if (peek() === '%') {
        const numberText = source.slice(start, i);
        i++;
        push('PERCENT', start, { value: Number(numberText) / 100 });
        continue;
      }

      push('NUMBER', start, { value: Number(source.slice(start, i)) });
      continue;
    }

    // --- Names and keywords ---
    if (isIdentStart(c)) {
      while (isIdentPart(peek())) i++;
      const text = source.slice(start, i);

      // (3) Force a keyword after `.` to be a name.
      const previous = tokens[tokens.length - 1];
      const afterDot = previous?.type === 'DOT';
      const keyword = KEYWORDS[text.toUpperCase()];
      if (keyword && !afterDot) {
        push(keyword, start);
      } else {
        push('IDENT', start);
        // Detect a detached unit such as `90 s` and offer an automatic fix.
        if (
          previous?.type === 'NUMBER' &&
          text in DURATION_UNITS &&
          /^\s+$/.test(source.slice(previous.end, start))
        ) {
          diagnostics.push({
            code: 'E-LEX-003',
            span: [previous.start, i],
            fixText: `${previous.text}${text}`,
          });
        }
      }
      continue;
    }

    // --- Operators and punctuation ---
    const two = source.slice(i, i + 2);
    if (two === '!=') {
      i += 2;
      push('NEQ', start);
      continue;
    }
    if (two === '>=') {
      i += 2;
      push('GTE', start);
      continue;
    }
    if (two === '<=') {
      i += 2;
      push('LTE', start);
      continue;
    }
    if (two === '<>') {
      i += 2;
      push('NEQ', start);
      continue;
    }

    const single: Partial<Record<string, TokenType>> = {
      '=': 'EQ',
      '>': 'GT',
      '<': 'LT',
      '+': 'PLUS',
      '-': 'MINUS',
      '*': 'STAR',
      '/': 'SLASH',
      '%': 'PERCENT_OP',
      '.': 'DOT',
      ',': 'COMMA',
      '(': 'LPAREN',
      ')': 'RPAREN',
      '[': 'LBRACKET',
      ']': 'RBRACKET',
    };
    const type = single[c];
    if (type) {
      i++;
      push(type, start);
      continue;
    }

    i++;
    push('INVALID', start);
    diagnostics.push({ code: 'E-LEX-001', span: [start, i], data: { char: c } });
  }

  tokens.push({ type: 'EOF', text: '', start: source.length, end: source.length });
  return { tokens, diagnostics };
}

/**
 * Reads `90s`, `1m30s`, or `1h2m3s`; returns null when no unit is attached.
 * Units must appear from largest to smallest, so `30s1m` is not one duration.
 */
function tryLexDuration(source: string, start: number): { end: number; seconds: number } | null {
  let i = start;
  let seconds = 0;
  let lastUnitScale = Infinity;
  // End of the last accepted unit; a malformed suffix does not invalidate the accepted prefix.
  let lastValidEnd = -1;

  while (i < source.length) {
    const numStart = i;
    while (i < source.length && isDigit(source[i]!)) i++;
    if (i < source.length && source[i] === '.' && isDigit(source[i + 1] ?? '')) {
      i++;
      while (i < source.length && isDigit(source[i]!)) i++;
    }
    if (i === numStart) break;
    const amount = Number(source.slice(numStart, i));

    const unitStart = i;
    while (i < source.length && /[a-zA-Z]/.test(source[i]!)) i++;
    const scale = DURATION_UNITS[source.slice(unitStart, i)];

    // Stop at an unknown or out-of-order unit. The remaining text becomes another token so
    // the parser can report adjacent durations instead of silently hiding the typo.
    if (scale === undefined || scale >= lastUnitScale) {
      return lastValidEnd >= 0 ? { end: lastValidEnd, seconds } : null;
    }

    seconds += amount * scale;
    lastUnitScale = scale;
    lastValidEnd = i;
  }

  return lastValidEnd >= 0 ? { end: lastValidEnd, seconds } : null;
}
