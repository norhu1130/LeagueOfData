/**
 * Recursive-descent clause parser with a Pratt expression parser.
 *
 * A hand-written parser is required for the following product behavior:
 *
 *   · Error tolerance (§28): invalid intermediate input returns a partial AST with ErrorExpr.
 *   · Domain-specific diagnostics (§29): each parse point controls its expected constructs.
 *   · Cursor-aware completion: incomplete member access still exposes an expected set.
 *   · Printer symmetry: a shared precedence table makes round trips testable.
 */
import {
  makeBindingId,
  normalizeProgram,
  type BinaryOp,
  type CompareArm,
  type CompareStmt,
  type ChainClause,
  type ClockLit,
  type DurationLit,
  type Expr,
  type EventRef,
  type GroupKey,
  type Ordinal,
  type Program,
  type ReturnItem,
  type ScopeRef,
  type SimpleStmt,
  type Span,
} from '@lol/ast';
import { catalog, resolveEventSurface } from '@lol/catalog';
import { lex } from './lexer.js';
import { SYNC_TOKENS, describeToken, type Token, type TokenType } from './tokens.js';
import { errorAt, got, need, normalizeDiagnostics, type Diagnostic } from './diagnostics.js';

export interface ParseResult {
  /** A partial AST survives failure; null is reserved for empty input. */
  readonly ast: Program | null;
  readonly diagnostics: Diagnostic[];
  /** Expected constructs used for cursor-aware completion. */
  readonly tokens: readonly Token[];
}

/** Comparison, temporal, and spatial operators are non-associative. */
const COMPARISON_OPS: Partial<Record<TokenType, BinaryOp>> = {
  EQ: '=',
  NEQ: '!=',
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
};

const ADDITIVE_OPS: Partial<Record<TokenType, BinaryOp>> = { PLUS: '+', MINUS: '-' };
const MULTIPLICATIVE_OPS: Partial<Record<TokenType, BinaryOp>> = {
  STAR: '*',
  SLASH: '/',
  PERCENT_OP: '%',
};

const TEAM_SURFACES: Record<string, 'blue' | 'red'> = { blue: 'blue', red: 'red' };

class Parser {
  private pos = 0;
  private readonly diagnostics: Diagnostic[] = [];

  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  // ------------------------------------------------------------ Token operations

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private at(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.type !== 'EOF') this.pos++;
    return token;
  }

  private match(...types: TokenType[]): Token | null {
    if (types.includes(this.peek().type)) return this.advance();
    return null;
  }

  private span(from: Token, to: Token = this.tokens[this.pos - 1] ?? from): Span {
    return [from.start, to.end];
  }

  private report(d: Diagnostic): void {
    this.diagnostics.push(d);
  }

  /** Skips to a recovery boundary so later clauses can still be parsed. */
  private recover(): void {
    while (!SYNC_TOKENS.has(this.peek().type)) this.advance();
  }

  private expect(type: TokenType, code: string, titleKo: string, bodyKo: string): Token | null {
    if (this.at(type)) return this.advance();
    const token = this.peek();
    this.report(
      errorAt(code, [token.start, token.end], titleKo, bodyKo, {
        got: got('현재', describeToken(token)),
      }),
    );
    return null;
  }

  private errorExpr(token: Token, code: string): Expr {
    return {
      kind: 'ErrorExpr',
      rawText: this.source.slice(token.start, token.end),
      diagnosticCode: code,
      span: [token.start, token.end],
    };
  }

  // -------------------------------------------------------------- Top level

  parseProgram(): Program | null {
    if (this.at('EOF')) return null;
    const start = this.peek();

    let analyze: ScopeRef | null = null;
    if (this.match('ANALYZE')) {
      analyze = this.parseScope();
    }

    const body = this.at('COMPARE') ? this.parseCompare() : this.parseSimple();
    if (!this.at('EOF')) {
      const trailing = this.peek();
      const alreadyReported = this.diagnostics.some(
        (diagnostic) => diagnostic.span[0] <= trailing.start && diagnostic.span[1] >= trailing.end,
      );
      if (!alreadyReported) {
        const last = this.tokens.at(-2) ?? trailing;
        this.report(
          errorAt(
            'E-SYN-002',
            [trailing.start, last.end],
            '완성된 분석 뒤에 읽을 수 없는 내용이 있습니다',
            '분석의 각 부분은 정해진 순서에 한 번씩만 적어야 합니다.',
            {
              got: got('현재', this.source.slice(trailing.start, last.end)),
              need: need('필요', '뒤에 남은 내용 제거', '절 순서 확인'),
            },
          ),
        );
      }
    }
    return { kind: 'Program', analyze, body, span: this.span(start) };
  }

  private parseScope(): ScopeRef {
    const start = this.peek();
    const token = this.advance();

    if (token.type === 'IDENT') {
      const name = token.text.toLowerCase();
      const side = TEAM_SURFACES[name];
      if (side) return { kind: 'ScopeRef', entity: 'team', side, span: this.span(start) };
      if (name === 'match') return { kind: 'ScopeRef', entity: 'match', span: this.span(start) };
      if (name === 'opponent') {
        return {
          kind: 'ScopeRef',
          entity: 'team',
          relation: 'opponent-of-trigger',
          span: this.span(start),
        };
      }
      if (name === 'team') {
        if (this.match('DOT')) {
          const sideToken = this.advance();
          const resolved = TEAM_SURFACES[sideToken.text.toLowerCase()];
          if (resolved) {
            return { kind: 'ScopeRef', entity: 'team', side: resolved, span: this.span(start) };
          }
          this.report(
            errorAt(
              'E-SEM-013',
              [sideToken.start, sideToken.end],
              '알 수 없는 진영입니다',
              '진영은 블루 또는 레드입니다.',
              { got: got('현재', sideToken.text), need: need('가능', 'blue', 'red') },
            ),
          );
        }
        return { kind: 'ScopeRef', entity: 'team', span: this.span(start) };
      }
      if (name === 'player') {
        let selector: string | undefined;
        if (this.match('LPAREN')) {
          const nameToken = this.match('STRING');
          selector = nameToken?.stringValue;
          this.expect(
            'RPAREN',
            'E-SYN-003',
            '괄호가 닫히지 않았습니다',
            '여는 괄호에 대응하는 닫는 괄호가 필요합니다.',
          );
        }
        return {
          kind: 'ScopeRef',
          entity: 'player',
          ...(selector !== undefined ? { selector } : {}),
          span: this.span(start),
        };
      }
    }

    this.report(
      errorAt(
        'E-SEM-050',
        [token.start, token.end],
        catalog.diagnostics['E-SEM-050']!.titleKo,
        catalog.diagnostics['E-SEM-050']!.bodyKo,
        {
          got: got('현재', token.text || '(비어 있음)'),
          need: need('가능', 'match', 'blue', 'red', 'team', 'player'),
        },
      ),
    );
    return { kind: 'ScopeRef', entity: 'match', span: this.span(start) };
  }

  // ---------------------------------------------------------------- Statements

  private parseSimple(): SimpleStmt {
    const start = this.peek();
    let chain: ChainClause | null = null;
    let when: Expr | null = null;

    if (this.at('AFTER')) chain = this.parseChain();
    if (this.match('WHEN')) when = this.parseExpr();

    const groupBy = this.parseGroupBy();
    const returns = this.parseReturn();

    return { kind: 'SimpleStmt', chain, when, groupBy, returns, span: this.span(start) };
  }

  private parseCompare(): CompareStmt {
    const start = this.peek();
    this.advance(); // COMPARE
    const arms: CompareArm[] = [this.parseCompareArm()];
    while (this.match('VS')) arms.push(this.parseCompareArm());

    if (arms.length < 2) {
      const def = catalog.diagnostics['E-SYN-030']!;
      this.report(
        errorAt('E-SYN-030', this.span(start), def.titleKo, def.bodyKo, {
          got: got('현재', '조건 1개'),
          need: need('필요', '비교할 다른 조건'),
        }),
      );
    }

    const groupBy = this.parseGroupBy();
    const returns = this.parseReturn();
    return { kind: 'CompareStmt', arms, groupBy, returns, span: this.span(start) };
  }

  private parseCompareArm(): CompareArm {
    const start = this.peek();
    this.expect(
      'WHEN',
      'E-SYN-002',
      '비교 조건은 WHEN으로 시작해야 합니다',
      '비교할 각 조건 앞에 `WHEN`을 적어 주세요.',
    );
    const when = this.parseExpr();
    const label = this.parseAlias();
    return { kind: 'CompareArm', label, when, span: this.span(start) };
  }

  private parseChain(): ChainClause {
    const start = this.peek();
    this.advance(); // AFTER
    const triggerExpr = this.parseUnary();
    const trigger = this.asEventRef(triggerExpr, start);

    let window: DurationLit | null = null;
    if (this.match('WITHIN')) {
      const token = this.match('DURATION');
      if (token) {
        window = {
          kind: 'DurationLit',
          seconds: token.value!,
          raw: token.text,
          span: [token.start, token.end],
        };
      } else {
        const bad = this.peek();
        this.report(
          errorAt(
            'E-SYN-022',
            [bad.start, bad.end],
            '시간이 필요합니다',
            '얼마 안에 일어난 일을 볼지 정해 주세요.',
            { got: got('현재', describeToken(bad)), need: need('예', '90s', '2m') },
          ),
        );
      }
    }

    const condition = this.match('IF') ? this.parseExpr() : null;
    return { kind: 'ChainClause', trigger, window, condition, span: this.span(start) };
  }

  private parseGroupBy(): GroupKey[] {
    if (!this.at('GROUP')) return [];
    this.advance();
    this.expect(
      'BY',
      'E-SYN-004',
      '무엇으로 나눌지 필요합니다',
      '`GROUP BY` 뒤에 기준을 적어 주세요.',
    );
    const keys: GroupKey[] = [];
    do {
      const start = this.peek();
      const expr = this.parsePostfix();
      const alias = this.parseAlias();
      keys.push({ kind: 'GroupKey', expr, alias, span: this.span(start) });
    } while (this.match('COMMA'));
    return keys;
  }

  private parseReturn(): ReturnItem[] {
    if (!this.match('RETURN')) {
      const token = this.peek();
      const def = catalog.diagnostics['E-SYN-001']!;
      this.report(
        errorAt('E-SYN-001', [token.start, token.end], def.titleKo, def.bodyKo, {
          got: got('현재', '결과가 정해지지 않음'),
          need: need('필요', '승률', '경기 수', '발생 비율'),
          quickFixes: [
            {
              titleKo: '승률 계산 추가',
              span: [token.start, token.start],
              newText: 'RETURN win_rate()\n',
            },
          ],
        }),
      );
      return [];
    }

    const items: ReturnItem[] = [];
    do {
      const start = this.peek();
      const expr = this.parseExpr();
      const alias = this.parseAlias();
      items.push({ kind: 'ReturnItem', expr, alias, span: this.span(start) });
    } while (this.match('COMMA'));
    return items;
  }

  private parseAlias(): string | null {
    if (!this.match('AS')) return null;
    const alias = this.expect(
      'IDENT',
      'E-SYN-002',
      '이름이 필요합니다',
      '`AS` 뒤에 결과나 분류에 붙일 이름을 적어 주세요.',
    );
    return alias?.text ?? null;
  }

  // ------------------------------------------------------------------ Expressions

  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.at('OR')) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: 'BinaryExpr', op: 'OR', left, right, span: [left.span![0], right.span![1]] };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.at('AND')) {
      this.advance();
      const right = this.parseNot();
      left = { kind: 'BinaryExpr', op: 'AND', left, right, span: [left.span![0], right.span![1]] };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.at('NOT')) {
      const start = this.advance();
      const operand = this.parseNot();
      // `normalizeProgram` enforces canonical shape once at the end.
      return { kind: 'UnaryExpr', op: 'NOT', operand, span: [start.start, operand.span![1]] };
    }
    return this.parseRelational();
  }

  /** Level 4, non-associative: consume at most one trailing operator. */
  private parseRelational(): Expr {
    const left = this.parseAdditive();
    const tail = this.parseRelationalTail(left);
    if (tail === null) return this.maybeEventPredicate(left);

    // Report a second comparison immediately because the level is non-associative.
    const next = this.peek();
    if (COMPARISON_OPS[next.type]) {
      const def = catalog.diagnostics['E-SYN-012']!;
      this.report(
        errorAt('E-SYN-012', [next.start, next.end], def.titleKo, def.bodyKo, {
          got: got('현재', `${next.text} 이 연달아 있음`),
          need: need('필요', 'AND 로 나누기', '괄호로 묶기'),
        }),
      );
    }
    return tail;
  }

  private parseRelationalTail(left: Expr): Expr | null {
    const token = this.peek();
    const comparison = COMPARISON_OPS[token.type];
    if (comparison) {
      this.advance();
      const right = this.parseAdditive();
      return {
        kind: 'BinaryExpr',
        op: comparison,
        left,
        right,
        span: [left.span![0], right.span![1]],
      };
    }

    if (token.type === 'NOT' && this.peek(1).type === 'IN') {
      this.advance();
      this.advance();
      return this.parseInTail(left, true);
    }
    if (token.type === 'IN') {
      this.advance();
      return this.parseInTail(left, false);
    }

    if (token.type === 'WITHIN') return this.parseWithinTail(left);
    if (token.type === 'NEAR') {
      this.advance();
      const target = this.parseAdditive();
      return {
        kind: 'SpatialPredicate',
        relation: 'NEAR',
        position: left,
        target,
        radius: null,
        span: [left.span![0], target.span![1]],
      };
    }

    if (token.type === 'BEFORE' || token.type === 'AFTER') {
      this.advance();
      const right = this.parseAdditive();
      let window: DurationLit | null = null;
      if (this.at('WITHIN') && this.peek(1).type === 'DURATION') {
        this.advance();
        const d = this.advance();
        window = { kind: 'DurationLit', seconds: d.value!, raw: d.text, span: [d.start, d.end] };
      }
      return {
        kind: 'TemporalPredicate',
        relation: token.type,
        left,
        right,
        rightUpper: null,
        window,
        span: [left.span![0], (window ?? right).span![1]],
      };
    }

    if (token.type === 'DURING' || token.type === 'UNTIL') {
      this.advance();
      const right = this.parseAdditive();
      return {
        kind: 'TemporalPredicate',
        relation: token.type,
        left,
        right,
        rightUpper: null,
        window: null,
        span: [left.span![0], right.span![1]],
      };
    }

    if (token.type === 'BETWEEN') {
      this.advance();
      // Parse the upper bound at additive precedence so trailing AND binds outside BETWEEN.
      const lower = this.parseAdditive();
      this.expect(
        'AND',
        'E-SYN-023',
        '범위의 끝이 필요합니다',
        '`BETWEEN 시작 AND 끝` 형태로 적어 주세요.',
      );
      const upper = this.parseAdditive();
      return {
        kind: 'TemporalPredicate',
        relation: 'BETWEEN',
        left,
        right: lower,
        rightUpper: upper,
        window: null,
        span: [left.span![0], upper.span![1]],
      };
    }

    if (token.type === 'AT') {
      this.advance();
      const right = this.parseAdditive();
      return {
        kind: 'TemporalPredicate',
        relation: 'AT',
        left,
        right,
        rightUpper: null,
        window: null,
        span: [left.span![0], right.span![1]],
      };
    }

    return null;
  }

  private parseInTail(left: Expr, negated: boolean): Expr {
    if (this.match('LPAREN')) {
      const set: Expr[] = [];
      if (!this.at('RPAREN')) {
        do {
          set.push(this.parseExpr());
        } while (this.match('COMMA'));
      }
      const close = this.expect(
        'RPAREN',
        'E-SYN-003',
        '괄호가 닫히지 않았습니다',
        '여는 괄호에 대응하는 닫는 괄호가 필요합니다.',
      );
      if (!set.length) {
        const token = close ?? this.peek();
        this.report(
          errorAt(
            'E-SYN-002',
            [token.start, token.end],
            '비어 있는 목록은 쓸 수 없습니다',
            '`IN` 뒤에 하나 이상의 값을 적어 주세요.',
            { need: need('예', 'role IN ("TOP", "JUNGLE")') },
          ),
        );
      }
      return {
        kind: 'InExpr',
        value: left,
        set,
        negated,
        span: [left.span![0], close?.end ?? set.at(-1)?.span?.[1] ?? left.span![1]],
      };
    }
    const target = this.parseAdditive();
    // `IN region(...)` is spatial; other IN expressions are set membership.
    if (target.kind === 'RegionRef') {
      return {
        kind: 'SpatialPredicate',
        relation: 'IN_REGION',
        position: left,
        target,
        radius: null,
        span: [left.span![0], target.span![1]],
      };
    }
    const set: Expr[] = [target];
    return { kind: 'InExpr', value: left, set, negated, span: [left.span![0], target.span![1]] };
  }

  /** The operand following `WITHIN` distinguishes temporal from spatial use. */
  private parseWithinTail(left: Expr): Expr {
    const withinToken = this.advance();
    if (this.at('DURATION')) {
      const d = this.advance();
      const window: DurationLit = {
        kind: 'DurationLit',
        seconds: d.value!,
        raw: d.text,
        span: [d.start, d.end],
      };
      let right: Expr | null = null;
      const relation = this.match('BEFORE', 'AFTER');
      if (relation) right = this.parseAdditive();
      return {
        kind: 'TemporalPredicate',
        relation: relation ? (relation.type as 'BEFORE' | 'AFTER') : 'WITHIN',
        left,
        right,
        rightUpper: null,
        window,
        span: [left.span![0], (right ?? window).span![1]],
      };
    }

    const radius = this.parseAdditive();
    if (!this.match('OF')) {
      const def = catalog.diagnostics['E-SYN-021']!;
      const token = this.peek();
      this.report(
        errorAt('E-SYN-021', [withinToken.start, token.end], def.titleKo, def.bodyKo, {
          got: got('현재', this.source.slice(withinToken.start, token.start).trim()),
          need: need('필요', 'OF 기준 위치', '또는 시간 단위 (90s)'),
        }),
      );
    }
    const target = this.parseAdditive();
    return {
      kind: 'SpatialPredicate',
      relation: 'WITHIN_RADIUS',
      position: left,
      target,
      radius: radius.kind === 'NumberLit' ? radius : null,
      span: [left.span![0], target.span![1]],
    };
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      const op = ADDITIVE_OPS[this.peek().type];
      if (!op) return left;
      this.advance();
      const right = this.parseMultiplicative();
      left = { kind: 'BinaryExpr', op, left, right, span: [left.span![0], right.span![1]] };
    }
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const op = MULTIPLICATIVE_OPS[this.peek().type];
      if (!op) return left;
      this.advance();
      const right = this.parseUnary();
      left = { kind: 'BinaryExpr', op, left, right, span: [left.span![0], right.span![1]] };
    }
  }

  private parseUnary(): Expr {
    if (this.at('MINUS')) {
      const start = this.advance();
      const operand = this.parseUnary();
      return { kind: 'UnaryExpr', op: '-', operand, span: [start.start, operand.span![1]] };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.at('DOT')) {
        this.advance();
        const field = this.expect(
          'IDENT',
          'E-SYN-002',
          '점 뒤에 항목 이름이 필요합니다',
          '점 뒤에 사건이나 값의 항목 이름을 적어 주세요.',
        );
        if (!field) return expr;
        // Resolve an event before attaching its context field. Without this step,
        // `blue.first_blood.position` prints from a valid EventRef AST but parses back as a
        // nested generic FieldAccess, breaking round-trip identity and binding reuse.
        const object = this.tryEventRef(expr) ?? expr;
        expr = {
          kind: 'FieldAccess',
          object,
          field: field.text,
          span: [object.span![0], field.end],
        };
        continue;
      }
      if (this.at('LPAREN')) {
        this.advance();
        const args: Expr[] = [];
        if (!this.at('RPAREN')) {
          do {
            args.push(this.parseExpr());
          } while (this.match('COMMA'));
        }
        const close = this.expect(
          'RPAREN',
          'E-SYN-003',
          '괄호가 닫히지 않았습니다',
          '여는 괄호에 대응하는 닫는 괄호가 필요합니다.',
        );
        expr = this.makeCall(expr, args, [expr.span![0], (close ?? this.peek()).end]);
        continue;
      }
      if (this.at('LBRACKET')) {
        const open = this.advance();
        const occurrence = this.peek();
        const namedOrdinal =
          occurrence.type === 'IDENT' && ['first', 'last'].includes(occurrence.text.toLowerCase())
            ? (occurrence.text.toLowerCase() as 'first' | 'last')
            : null;
        if (occurrence.type !== 'NUMBER' && namedOrdinal === null) {
          this.report(
            errorAt(
              'E-SYN-002',
              [open.start, occurrence.end],
              '사건 순서를 지정해야 합니다',
              '대괄호 안에 first, last 또는 1 이상의 사건 순서를 적어 주세요.',
              { need: need('예', 'dragon_kill[last]', 'dragon_kill[2]') },
            ),
          );
          return expr;
        }
        this.advance();
        const close = this.expect(
          'RBRACKET',
          'E-SYN-003',
          '대괄호가 닫히지 않았습니다',
          '사건 순서 뒤에 닫는 대괄호가 필요합니다.',
        );
        const ordinal: Ordinal = namedOrdinal ?? occurrence.value!;
        const ref = this.tryEventRef(expr);
        if (
          !ref ||
          (typeof ordinal === 'number' &&
            (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 255))
        ) {
          this.report(
            errorAt(
              'E-SEM-010',
              [expr.span![0], (close ?? occurrence).end],
              '사건 순서를 적용할 수 없습니다',
              '반복될 수 있는 사건 뒤에 first, last 또는 1부터 255 사이의 순서를 적어 주세요.',
              { need: need('예', 'dragon_kill[last]', 'dragon_kill[2]') },
            ),
          );
          return expr;
        }
        const scopeKey = ref.scope
          ? (ref.scope.relation ?? ref.scope.side ?? ref.scope.entity)
          : null;
        expr = {
          ...ref,
          ordinal,
          bindingId: makeBindingId({ scope: scopeKey, eventType: ref.eventType, ordinal }),
          span: [ref.span![0], (close ?? occurrence).end],
        };
        continue;
      }
      return expr;
    }
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    switch (token.type) {
      case 'NUMBER':
        this.advance();
        return { kind: 'NumberLit', value: token.value!, span: [token.start, token.end] };
      case 'PERCENT':
        this.advance();
        return { kind: 'NumberLit', value: token.value!, span: [token.start, token.end] };
      case 'STRING':
        this.advance();
        return {
          kind: 'StringLit',
          value: token.stringValue ?? '',
          span: [token.start, token.end],
        };
      case 'DURATION':
        this.advance();
        return {
          kind: 'DurationLit',
          seconds: token.value!,
          raw: token.text,
          span: [token.start, token.end],
        };
      case 'CLOCK':
        this.advance();
        return {
          kind: 'ClockLit',
          seconds: token.value!,
          raw: token.text,
          span: [token.start, token.end],
        };
      case 'TRUE':
      case 'FALSE':
        this.advance();
        return { kind: 'BoolLit', value: token.type === 'TRUE', span: [token.start, token.end] };
      case 'NULL':
        this.advance();
        return { kind: 'NullLit', span: [token.start, token.end] };
      case 'LPAREN': {
        this.advance();
        const inner = this.parseExpr();
        this.expect(
          'RPAREN',
          'E-SYN-003',
          '괄호가 닫히지 않았습니다',
          '여는 괄호에 대응하는 닫는 괄호가 필요합니다.',
        );
        return inner;
      }
      case 'IDENT':
        this.advance();
        return { kind: 'Identifier', name: token.text, span: [token.start, token.end] };
      default: {
        this.advance();
        this.report(
          errorAt(
            'E-SYN-002',
            [token.start, token.end],
            '여기에 올 수 없는 것입니다',
            '조건이나 값이 와야 하는 자리입니다.',
            { got: got('현재', describeToken(token)) },
          ),
        );
        this.recover();
        return this.errorExpr(token, 'E-SYN-002');
      }
    }
  }

  // ------------------------------------------------------------ Semantic conversion

  /**
   * Builds a call. `region("top")` becomes RegionRef, `gold_diff(10:00)` MeasureAt,
   * and `blue.win_rate()` a scoped CallExpr.
   */
  private makeCall(callee: Expr, args: readonly Expr[], span: Span): Expr {
    const { name, scope } = this.splitScopedName(callee);

    if (name === 'region') {
      const arg = args[0];
      const regionName = arg?.kind === 'StringLit' ? arg.value : '';
      if (!regionName) {
        this.report(
          errorAt(
            'E-SEM-041',
            span,
            catalog.diagnostics['E-SEM-041']!.titleKo,
            '영역 이름이 필요합니다.',
            {
              need: need('예', 'region("top_lane")'),
            },
          ),
        );
      }
      return { kind: 'RegionRef', name: regionName, span };
    }

    const fn = catalog.functions[name];
    if (fn?.kind === 'frame-measure') {
      const at = args[0];
      if (at && (at.kind === 'ClockLit' || at.kind === 'DurationLit')) {
        return { kind: 'MeasureAt', measure: name, scope, at, span };
      }
      this.report(
        errorAt('E-SYN-024', span, '시점이 필요합니다', '언제를 기준으로 잴지 정해 주세요.', {
          got: got('현재', args.length ? '시점이 아닌 값' : '비어 있음'),
          need: need('예', '10:00', '600s'),
        }),
      );
    }

    return { kind: 'CallExpr', callee: name, scope, args: [...args], span };
  }

  /** Splits `blue.win_rate` into scope `blue` and name `win_rate`. */
  private splitScopedName(expr: Expr): { name: string; scope: ScopeRef | null } {
    if (expr.kind === 'Identifier') return { name: expr.name, scope: null };
    if (expr.kind === 'FieldAccess' && expr.object.kind === 'Identifier') {
      const base = expr.object.name.toLowerCase();
      const side = TEAM_SURFACES[base];
      if (side) {
        return {
          name: expr.field,
          scope: { kind: 'ScopeRef', entity: 'team', side, span: expr.object.span },
        };
      }
      if (base === 'opponent') {
        return {
          name: expr.field,
          scope: {
            kind: 'ScopeRef',
            entity: 'team',
            relation: 'opponent-of-trigger',
            span: expr.object.span,
          },
        };
      }
      if (base === 'player' || base === 'match' || base === 'team') {
        return {
          name: expr.field,
          scope: {
            kind: 'ScopeRef',
            entity: base as 'player' | 'match' | 'team',
            span: expr.object.span,
          },
        };
      }
    }
    return { name: exprToName(expr), scope: null };
  }

  /**
   * Resolves two forms of surface sugar:
   *
   *  1. A bare event in boolean position becomes an occurrence predicate.
   *  2. A zero-argument function without parentheses becomes a call.
   *     `RETURN blue.win_rate` → `blue.win_rate()`
   *
   * The second rule gives `blue.win_rate` and `blue.win_rate()` one AST shape.
   */
  private maybeEventPredicate(expr: Expr): Expr {
    // Keep events as EventRef here. `normalizeProgram` wraps them only in boolean positions;
    // unconditional wrapping would destroy event-valued function arguments.
    const ref = this.tryEventRef(expr);
    if (ref) return ref;

    if (expr.kind === 'FieldAccess') {
      const { name, scope } = this.splitScopedName(expr);
      const fn = catalog.functions[name];
      if (fn && fn.params.length === 0 && scope !== null) {
        return { kind: 'CallExpr', callee: name, scope, args: [], span: expr.span };
      }
    }
    return expr;
  }

  private tryEventRef(expr: Expr): EventRef | null {
    if (expr.kind === 'EventRef') return expr;
    if (expr.kind === 'Identifier') return this.buildEventRef(expr.name, null, expr.span);
    if (expr.kind === 'FieldAccess' && expr.object.kind === 'Identifier') {
      const base = expr.object.name.toLowerCase();
      const side = TEAM_SURFACES[base];
      const scope: ScopeRef | null = side
        ? { kind: 'ScopeRef', entity: 'team', side, span: expr.object.span }
        : base === 'opponent'
          ? {
              kind: 'ScopeRef',
              entity: 'team',
              relation: 'opponent-of-trigger',
              span: expr.object.span,
            }
          : base === 'player' || base === 'match' || base === 'team'
            ? {
                kind: 'ScopeRef',
                entity: base as 'player' | 'match' | 'team',
                span: expr.object.span,
              }
            : null;
      if (scope) return this.buildEventRef(expr.field, scope, expr.span);
    }
    return null;
  }

  private buildEventRef(surface: string, scope: ScopeRef | null, span?: Span): EventRef | null {
    const resolved = resolveEventSurface(surface);
    if (!resolved) return null;
    const ordinal: Ordinal = resolved.ordinal;
    const scopeKey = scope ? (scope.relation ?? scope.side ?? scope.entity) : null;
    return {
      kind: 'EventRef' as const,
      bindingId: makeBindingId({
        scope: scopeKey,
        eventType: resolved.event.id,
        ordinal: ordinalKey(ordinal),
      }),
      scope,
      eventType: resolved.event.id,
      ordinal,
      surface,
      span,
    };
  }

  /** A chain reference must be an event. */
  private asEventRef(expr: Expr, start: Token) {
    const ref = this.tryEventRef(expr);
    if (ref) return ref;
    this.report(
      errorAt(
        'E-SEM-010',
        expr.span ?? [start.start, start.end],
        catalog.diagnostics['E-SEM-010']!.titleKo,
        catalog.diagnostics['E-SEM-010']!.bodyKo,
        { got: got('현재', exprToName(expr)), need: need('필요', '사건') },
      ),
    );
    return this.buildEventRef('kill', null, expr.span)!;
  }

  getDiagnostics(): Diagnostic[] {
    return this.diagnostics;
  }
}

/** Ordinal spelling used in deterministic binding IDs. */
function ordinalKey(ordinal: Ordinal): string {
  return typeof ordinal === 'number' ? `nth-${ordinal}` : ordinal;
}

function exprToName(expr: Expr): string {
  if (expr.kind === 'Identifier') return expr.name;
  if (expr.kind === 'FieldAccess') return `${exprToName(expr.object)}.${expr.field}`;
  return expr.kind;
}

export function parse(source: string): ParseResult {
  const { tokens, diagnostics: lexDiagnostics } = lex(source);
  const parser = new Parser(tokens, source);
  const parsed = parser.parseProgram();
  // Every AST producer, including the parser, must pass through normalization.
  const ast = parsed ? normalizeProgram(parsed) : null;

  const lexAsDiagnostics: Diagnostic[] = lexDiagnostics.map((d) => {
    const def = catalog.diagnostics[d.code];
    return {
      code: d.code,
      severity: 'error' as const,
      span: d.span as Span,
      titleKo: def?.titleKo ?? '읽을 수 없는 부분이 있습니다',
      bodyKo: def?.bodyKo ?? '이 부분을 이해할 수 없습니다.',
      ...(d.fixText
        ? {
            quickFixes: [
              { titleKo: `${d.fixText} 로 고치기`, span: d.span as Span, newText: d.fixText },
            ],
          }
        : {}),
    };
  });

  return {
    ast,
    diagnostics: normalizeDiagnostics([...lexAsDiagnostics, ...parser.getDiagnostics()]),
    tokens,
  };
}
