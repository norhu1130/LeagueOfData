/** Token kinds and keyword table. */

export type TokenType =
  // Clause keywords
  | 'ANALYZE'
  | 'WHEN'
  | 'RETURN'
  | 'GROUP'
  | 'BY'
  | 'COMPARE'
  | 'VS'
  | 'AS'
  | 'IF'
  // Logic
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'IN'
  // Time
  | 'BEFORE'
  | 'AFTER'
  | 'WITHIN'
  | 'UNTIL'
  | 'DURING'
  | 'BETWEEN'
  | 'AT'
  // Space
  | 'OF'
  | 'NEAR'
  // Literal keywords
  | 'TRUE'
  | 'FALSE'
  | 'NULL'
  // Literals
  | 'IDENT'
  | 'STRING'
  | 'NUMBER'
  | 'DURATION'
  | 'CLOCK'
  | 'PERCENT'
  // Operators and punctuation
  | 'EQ'
  | 'NEQ'
  | 'GT'
  | 'GTE'
  | 'LT'
  | 'LTE'
  | 'PLUS'
  | 'MINUS'
  | 'STAR'
  | 'SLASH'
  | 'PERCENT_OP'
  | 'DOT'
  | 'COMMA'
  | 'LPAREN'
  | 'RPAREN'
  | 'LBRACKET'
  | 'RBRACKET'
  // End of input
  | 'EOF'
  // Character not recognized by the lexer
  | 'INVALID';

export interface Token {
  readonly type: TokenType;
  /** Exact source spelling. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** NUMBER/PERCENT value or DURATION/CLOCK seconds. */
  readonly value?: number;
  /** Interpreted STRING value. */
  readonly stringValue?: string;
}

export const KEYWORDS: Readonly<Record<string, TokenType>> = {
  ANALYZE: 'ANALYZE',
  WHEN: 'WHEN',
  RETURN: 'RETURN',
  GROUP: 'GROUP',
  BY: 'BY',
  COMPARE: 'COMPARE',
  VS: 'VS',
  AS: 'AS',
  IF: 'IF',
  AND: 'AND',
  OR: 'OR',
  NOT: 'NOT',
  IN: 'IN',
  BEFORE: 'BEFORE',
  AFTER: 'AFTER',
  WITHIN: 'WITHIN',
  UNTIL: 'UNTIL',
  DURING: 'DURING',
  BETWEEN: 'BETWEEN',
  AT: 'AT',
  OF: 'OF',
  NEAR: 'NEAR',
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  NULL: 'NULL',
};

/** Parser-recovery boundary where parsing can safely resume. */
export const SYNC_TOKENS: ReadonlySet<TokenType> = new Set<TokenType>([
  'ANALYZE',
  'WHEN',
  'RETURN',
  'GROUP',
  'COMPARE',
  'VS',
  'COMMA',
  'RPAREN',
  'EOF',
]);

export function isKeyword(type: TokenType): boolean {
  return type in KEYWORDS;
}

/** User-facing token names that keep implementation terminology out of diagnostics. */
export const TOKEN_LABEL_KO: Readonly<Partial<Record<TokenType, string>>> = {
  IDENT: '이름',
  STRING: '문자열',
  NUMBER: '숫자',
  DURATION: '시간',
  CLOCK: '시각',
  PERCENT: '백분율',
  LPAREN: '여는 괄호',
  RPAREN: '닫는 괄호',
  COMMA: '쉼표',
  EOF: '끝',
};

export function describeToken(token: Token): string {
  return TOKEN_LABEL_KO[token.type] ?? `'${token.text}'`;
}
