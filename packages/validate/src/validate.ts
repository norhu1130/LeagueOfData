/**
 * Semantic validation.
 *
 * Every diagnostic follows §29: structured current/required context, an automatic fix where
 * possible, and no implementation terminology in user-facing text.
 */
import { makeBindingId, walk, type Expr, type Node, type Program, type Span } from '@lol/ast';
import {
  catalog,
  resolveEventSurface,
  suggestEventNames,
  type GrainId,
  type ValueType,
} from '@lol/catalog';
import { errorAt, got, need, normalizeDiagnostics, type Diagnostic } from '@lol/dsl';
import { grainUnitKo, inferGrain, type GrainInference } from './grain.js';
import { comparable, describeExpr, inferType, isNumericType, typeLabelKo } from './infer.js';

export interface ValidationContext {
  /** Built-in and user-defined region IDs available to this analysis. */
  readonly regionIds: readonly string[];
  /** Median match duration in seconds, used to detect excessively late probes. */
  readonly medianMatchDurationS?: number;
  /** Dataset-specific availability and context fields returned by the execution service. */
  readonly eventCapabilities?: Readonly<
    Record<
      string,
      {
        readonly available: boolean;
        readonly context: readonly string[];
        readonly unavailableReasonKo?: string | null;
      }
    >
  >;
}

export interface ValidationResult {
  readonly diagnostics: Diagnostic[];
  readonly grain: GrainInference;
  /** Human-readable result denominator required by §22. */
  readonly denominatorKo: string;
}

const SPAN_ZERO: Span = [0, 0];
const spanOf = (node: Node): Span => node.span ?? SPAN_ZERO;

/** Appends the correct Korean object particle based on the final syllable. */
function eulReul(word: string): string {
  const last = [...word.trim()].at(-1);
  if (!last) return word;
  const code = last.charCodeAt(0);
  const hasFinal = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  return `${word}${hasFinal ? '을' : '를'}`;
}

function diag(code: string, span: Span, extra: Partial<Diagnostic> = {}): Diagnostic {
  const def = catalog.diagnostics[code];
  return errorAt(
    code,
    span,
    def?.titleKo ?? '분석을 확인해 주세요',
    def?.bodyKo ?? '이 부분을 다시 확인해 주세요.',
    { severity: def?.severity ?? 'error', ...extra },
  );
}

export function validate(program: Program, context: ValidationContext): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const grain = inferGrain(program);
  const known = new Set(context.regionIds);

  checkProgramCompleteness(program, diagnostics);
  checkEventReferences(program, diagnostics, context.eventCapabilities);
  checkRelativeTeamScopes(program, diagnostics);
  checkRegions(program, known, diagnostics);
  checkCoordinateSpaces(program, diagnostics);
  checkComparisons(program, diagnostics);
  checkEnumeratedContextValues(program, diagnostics);
  checkFunctions(program, grain.grain, diagnostics);
  checkSubjectAttributeGrains(program, grain.grain, diagnostics);
  checkGroupKeys(program, grain.grain, diagnostics);
  checkChainRequirements(program, diagnostics);
  checkReturns(program, diagnostics);
  checkPostOutcomeConditions(program, diagnostics);
  checkMeasureTiming(program, context, diagnostics);
  checkBooleanContexts(program, diagnostics);

  return {
    diagnostics: normalizeDiagnostics(diagnostics),
    grain,
    denominatorKo: `${grainUnitKo(grain.grain)} 기준 (${grain.reasonKo})`,
  };
}

/** Rejects categorical spellings that would otherwise produce a silent empty result. */
function checkEnumeratedContextValues(program: Program, out: Diagnostic[]): void {
  walk(program, (node) => {
    let field: Extract<Expr, { kind: 'FieldAccess' }> | null = null;
    let candidates: Extract<Expr, { kind: 'StringLit' }>[] = [];
    if (node.kind === 'InExpr' && node.value.kind === 'FieldAccess') {
      field = node.value;
      candidates = node.set.filter(
        (item): item is Extract<Expr, { kind: 'StringLit' }> => item.kind === 'StringLit',
      );
    } else if (
      node.kind === 'BinaryExpr' &&
      ['=', '!='].includes(node.op) &&
      node.left.kind === 'FieldAccess'
    ) {
      field = node.left;
      if (node.right.kind === 'StringLit') candidates = [node.right];
    }
    if (!field || inferType(field.object).type !== 'event') return;

    const definition = catalog.contextFields[field.field];
    if (!definition) return;
    const allowed = definition.allowedValues;
    if (!allowed?.length) return;

    for (const candidate of candidates) {
      if (allowed.includes(candidate.value)) continue;
      const normalized = candidate.value.toUpperCase();
      out.push(
        diag('E-SEM-043', spanOf(candidate), {
          titleKo: `${definition.labelKo} 값이 올바르지 않습니다`,
          bodyKo: `이 항목에는 정해진 ${definition.labelKo} 값만 사용할 수 있습니다.`,
          got: got('현재', candidate.value),
          need: need('사용 가능', ...allowed),
          quickFixes: allowed.includes(normalized)
            ? [
                {
                  titleKo: `${normalized} 로 바꾸기`,
                  span: spanOf(candidate),
                  newText: `"${normalized}"`,
                },
              ]
            : [],
        }),
      );
    }
  });
}

// --------------------------------------------------------------- Individual rules

/** Completeness checks that remain required for ASTs not produced by the parser. */
function checkProgramCompleteness(program: Program, out: Diagnostic[]): void {
  if (!program.body.returns.length) {
    out.push(
      diag('E-SYN-001', spanOf(program.body), {
        got: got('현재', '결과가 정해지지 않음'),
        need: need('필요', '승률', '경기 수', '발생 비율'),
      }),
    );
  }
  if (program.body.kind === 'CompareStmt' && program.body.arms.length < 2) {
    out.push(
      diag('E-SYN-030', spanOf(program.body), {
        got: got('현재', `조건 ${program.body.arms.length}개`),
        need: need('필요', '비교할 조건 2개 이상'),
      }),
    );
  }
  if (program.body.kind === 'CompareStmt' && program.body.groupBy.length > 0) {
    out.push(
      diag('E-SEM-054', spanOf(program.body.groupBy[0]!), {
        titleKo: '비교와 분류를 동시에 실행할 수 없습니다',
        bodyKo: '현재 엔진에서는 비교 조건과 그룹 나누기를 한 분석에 함께 사용할 수 없습니다.',
        got: got('현재', '비교 조건과 분류 기준이 함께 있음'),
        need: need('필요', '비교 조건만 사용', '분류 기준만 사용'),
      }),
    );
  }
  walk(program, (node) => {
    if (node.kind !== 'ErrorExpr') return;
    out.push(
      diag(node.diagnosticCode || 'E-SYN-002', spanOf(node), {
        got: got('현재', node.rawText || '(비어 있음)'),
        need: need('필요', '완성된 조건이나 값'),
      }),
    );
  });
}

/** Unknown events, invalid fields, and events unavailable in this dataset. */
function checkEventReferences(
  program: Program,
  out: Diagnostic[],
  capabilities?: ValidationContext['eventCapabilities'],
): void {
  walk(program, (node) => {
    if (node.kind === 'EventRef') {
      const event = catalog.events[node.eventType];
      const resolved = resolveEventSurface(node.surface);
      const ordinal = node.ordinal;
      const scopeKey = node.scope
        ? (node.scope.relation ?? node.scope.side ?? node.scope.entity)
        : null;
      const expectedBinding = makeBindingId({
        scope: scopeKey,
        eventType: node.eventType,
        ordinal,
      });
      const occurrenceMatches =
        typeof ordinal === 'number'
          ? node.surface === node.eventType &&
            Number.isInteger(ordinal) &&
            ordinal >= 1 &&
            ordinal <= 255
          : node.surface === node.eventType
            ? ordinal === 'any' || ordinal === 'first' || ordinal === 'last'
            : resolved?.ordinal === ordinal;
      if (
        !event ||
        !resolved ||
        resolved.event.id !== node.eventType ||
        !occurrenceMatches ||
        node.bindingId !== expectedBinding
      ) {
        out.push(
          diag('E-SEM-010', spanOf(node), {
            got: got('현재', node.surface),
            need: need('필요', '알려진 사건 이름'),
          }),
        );
        return;
      }
      const effective = capabilities?.[node.eventType];
      if (event && (!event.available || effective?.available === false)) {
        out.push(
          diag('E-SEM-020', spanOf(node), {
            got: got('현재', node.surface),
            bodyKo:
              effective?.unavailableReasonKo ??
              event.unavailableReasonKo ??
              catalog.diagnostics['E-SEM-020']!.bodyKo,
          }),
        );
      }
      return;
    }

    // A name such as `firstblood` that is neither an event nor a grouping key.
    if (node.kind === 'Identifier') {
      if (resolveEventSurface(node.name)) return;
      if (catalog.groupKeys[node.name]) return;
      if (catalog.functions[node.name]) return;
      if (KNOWN_IDENTIFIERS.has(node.name)) return;
      const suggestions = suggestEventNames(node.name);
      out.push(
        diag('E-SEM-010', spanOf(node), {
          got: got('현재', node.name),
          need: need(
            suggestions.length ? '혹시 이것인가요' : '필요',
            ...(suggestions.length ? suggestions : ['알려진 사건이나 값']),
          ),
          quickFixes: suggestions.map((s) => ({
            titleKo: `${s} 로 바꾸기`,
            span: spanOf(node),
            newText: s,
          })),
        }),
      );
      return;
    }

    // A field absent from the event, such as `dragon_spawn.player`.
    if (node.kind === 'FieldAccess') {
      const objectType = inferType(node.object);
      if (objectType.type === 'event' && objectType.eventId) {
        const event = catalog.events[objectType.eventId];
        if (!event) return;
        const context = capabilities?.[event.id]?.context ?? event.context;
        if (context.includes(node.field)) return;
        out.push(
          diag('E-SEM-011', spanOf(node), {
            got: got('현재', `${event.labelKo}의 ${node.field}`),
            need: need('사용 가능', ...context.map((f) => catalog.contextFields[f]?.labelKo ?? f)),
          }),
        );
        return;
      }

      const path = fieldPath(node);
      if (path && catalog.landmarks[path]) return;
      if (isKnownSubjectAttribute(node)) return;
      out.push(
        diag('E-SEM-011', spanOf(node), {
          titleKo: '알 수 없는 항목입니다',
          bodyKo: '이 대상에서 사용할 수 없는 항목입니다.',
          got: got('현재', path ?? node.field),
          need: need('필요', '알려진 항목 이름'),
        }),
      );
    }
  });
}

/** Relative team scopes are meaningful only for the follow-up event in a chain. */
function checkRelativeTeamScopes(program: Program, out: Diagnostic[]): void {
  const itemOpponentScopes = new Set<Node>();
  walk(program, (node) => {
    if (
      node.kind === 'CallExpr' &&
      (node.callee === 'owns_item_at' || node.callee === 'purchased_item_by') &&
      node.scope?.relation === 'opponent-of-trigger'
    )
      itemOpponentScopes.add(node.scope);
  });
  const chain = program.body.kind === 'SimpleStmt' ? program.body.chain : null;
  const conditionEvent =
    chain?.condition?.kind === 'EventPredicate'
      ? chain.condition.event
      : chain?.condition?.kind === 'EventRef'
        ? chain.condition
        : null;
  walk(program, (node) => {
    if (node.kind !== 'ScopeRef' || node.relation !== 'opponent-of-trigger') return;
    if (conditionEvent?.scope === node || itemOpponentScopes.has(node)) return;
    out.push(
      diag('E-SEM-056', spanOf(node), {
        titleKo: '상대팀의 기준 사건이 필요합니다',
        bodyKo: '“시작 사건의 상대팀”은 이어지는 사건의 끝 팀에서만 사용할 수 있습니다.',
        got: got('현재', '기준 없이 상대팀을 선택함'),
        need: need('필요', '이어지는 사건의 끝 팀에서 선택'),
      }),
    );
  });
}

const KNOWN_IDENTIFIERS = new Set([
  ...Object.values(catalog.entities).flatMap((entity) => entity.surfaces),
  ...Object.keys(catalog.landmarks).flatMap((name) => name.split('.')),
  'win',
  'winner',
  'win_rate',
]);

function fieldPath(node: Expr): string | null {
  if (node.kind === 'Identifier') return node.name;
  if (node.kind === 'FieldAccess') {
    const object = fieldPath(node.object);
    return object ? `${object}.${node.field}` : null;
  }
  return null;
}

function isKnownSubjectAttribute(node: Extract<Expr, { kind: 'FieldAccess' }>): boolean {
  if (node.object.kind !== 'Identifier') return false;
  const entity = node.object.name.toLowerCase();
  const grain: GrainId | null =
    entity === 'blue' || entity === 'red' || entity === 'team'
      ? 'team'
      : entity === 'player' || entity === 'match'
        ? entity
        : null;
  const field = catalog.groupKeys[node.field];
  const subjectField = catalog.subjectFields[node.field];
  return (
    grain !== null &&
    Boolean(
      subjectField?.validGrains.includes(grain) ||
      (field?.validGrains.includes(grain) && field.sql === node.field),
    )
  );
}

/** Subject attributes must belong to the selected analysis unit, not merely exist in the catalog. */
function checkSubjectAttributeGrains(program: Program, grain: GrainId, out: Diagnostic[]): void {
  walk(program, (node) => {
    if (node.kind !== 'FieldAccess' || node.object.kind !== 'Identifier') return;
    const entity = node.object.name.toLowerCase();
    const attributeGrain: GrainId | null =
      entity === 'blue' || entity === 'red' || entity === 'team'
        ? 'team'
        : entity === 'player' || entity === 'match'
          ? entity
          : null;
    if (!attributeGrain || attributeGrain === grain) return;
    if (!catalog.subjectFields[node.field] && !catalog.groupKeys[node.field]) return;
    out.push(
      diag('E-SEM-052', spanOf(node), {
        titleKo: `${node.field}은 이 분석 단위에서 쓸 수 없습니다`,
        bodyKo: `${entity}.${node.field}은 ${grainUnitKo(attributeGrain)} 기준의 값입니다.`,
        got: got('현재', `${grainUnitKo(grain)} 기준`),
        need: need('필요', `${grainUnitKo(attributeGrain)} 기준`),
      }),
    );
  });
}

/** Undefined regions. */
function checkRegions(program: Program, known: Set<string>, out: Diagnostic[]): void {
  walk(program, (node) => {
    if (node.kind !== 'RegionRef') return;
    if (known.has(node.name)) return;
    out.push(
      diag('E-SEM-041', spanOf(node), {
        got: got('현재', `region("${node.name}")`),
        need: need('사용 가능', ...[...known].slice(0, 6)),
      }),
    );
  });
}

/**
 * Coordinate-space mixing. Minimap regions are normalized, while `WITHIN 1000` uses game units.
 */
function checkCoordinateSpaces(program: Program, out: Diagnostic[]): void {
  walk(program, (node) => {
    if (node.kind !== 'SpatialPredicate') return;
    if (node.relation !== 'WITHIN_RADIUS') return;
    if (node.target.kind === 'RegionRef') {
      out.push(
        diag('E-SEM-042', spanOf(node), {
          got: got('현재', `반경 ${node.radius ? describeExpr(node.radius) : '?'} + 영역`),
          need: need('필요', '영역에는 IN 을', '반경에는 기준 위치를'),
        }),
      );
    }
  });
}

/** Checks whether comparison operand types are compatible. */
function checkComparisons(program: Program, out: Diagnostic[]): void {
  walk(program, (node) => {
    if (node.kind !== 'BinaryExpr') return;
    if (!['=', '!=', '>', '>=', '<', '<='].includes(node.op)) return;

    const left = inferType(node.left);
    const right = inferType(node.right);
    if (comparable(left.type, right.type)) return;

    // Comparing a position with time is the most common mismatch.
    const isPosition = left.type === 'position' || right.type === 'position';
    out.push(
      diag(isPosition ? 'E-SEM-040' : 'E-SEM-043', spanOf(node), {
        titleKo: isPosition
          ? catalog.diagnostics['E-SEM-040']!.titleKo
          : '서로 비교할 수 없는 값입니다',
        bodyKo: isPosition
          ? catalog.diagnostics['E-SEM-040']!.bodyKo
          : `${left.labelKo}와 ${right.labelKo}는 서로 비교할 수 없습니다.`,
        got: got(
          '현재',
          `${describeExpr(node.left)} (${left.labelKo})`,
          `${describeExpr(node.right)} (${right.labelKo})`,
        ),
        need: need(
          '필요',
          isPosition ? '위치에는 IN region(…) 또는 WITHIN … OF …' : '같은 종류의 값',
          ...(isPosition && left.fieldId === 'position' && left.eventId
            ? [`시간을 뜻했다면 ${left.eventId}.time`]
            : []),
        ),
      }),
    );
  });
}

/** Validates function arity, argument types, and analysis grain. */
function checkFunctions(program: Program, grain: GrainId, out: Diagnostic[]): void {
  walk(program, (node) => {
    // Point-in-time measures are functions too. `gold_diff` needs an opposing team and is not
    // meaningful at match grain, so checking only CallExpr would miss it.
    if (node.kind === 'MeasureAt') {
      const measure = catalog.functions[node.measure];
      if (!measure || measure.kind !== 'frame-measure') {
        out.push(
          diag('E-SEM-012', spanOf(node), {
            got: got('현재', node.measure),
            need: need(
              '사용 가능',
              ...Object.values(catalog.functions)
                .filter((fn) => fn.kind === 'frame-measure')
                .map((fn) => fn.id),
            ),
          }),
        );
        return;
      }
      if (measure && !measure.validGrains.includes(grain)) {
        out.push(
          diag('E-SEM-052', spanOf(node), {
            titleKo: `${measure.labelKo}은 이 분석 단위에서 쓸 수 없습니다`,
            bodyKo: `${measure.labelKo}은 상대와의 차이라서 ${measure.validGrains
              .map(grainUnitKo)
              .join(', ')} 기준에서만 계산됩니다.`,
            got: got('현재', `${grainUnitKo(grain)} 기준`),
            need: need('가능', ...measure.validGrains.map(grainUnitKo)),
          }),
        );
      }
      return;
    }
    if (node.kind !== 'CallExpr') return;
    const fn = catalog.functions[node.callee];
    if (!fn) {
      out.push(
        diag('E-SEM-012', spanOf(node), {
          titleKo: '알 수 없는 측정값입니다',
          bodyKo: '이 이름의 측정값은 없습니다.',
          got: got('현재', node.callee),
          need: need('사용 가능', ...Object.keys(catalog.functions).slice(0, 6)),
        }),
      );
      return;
    }

    const required = fn.params.filter((p) => !p.optional).length;
    if (node.args.length < required) {
      // `duration()` is the explicit diagnostic example from §29.
      const code = node.callee === 'duration' ? 'E-SEM-031' : 'E-SEM-033';
      out.push(
        diag(code, spanOf(node), {
          titleKo:
            code === 'E-SEM-031'
              ? catalog.diagnostics['E-SEM-031']!.titleKo
              : `${fn.labelKo}에 필요한 값이 빠졌습니다`,
          bodyKo:
            code === 'E-SEM-031'
              ? catalog.diagnostics['E-SEM-031']!.bodyKo
              : `${fn.labelKo}은 ${required}개의 값이 필요합니다.`,
          got: got('현재', ...(node.args.length ? node.args.map(describeExpr) : ['비어 있음'])),
          need: need('필요', ...fn.params.map((p) => p.labelKo)),
        }),
      );
    }

    if (node.args.length > fn.params.length) {
      out.push(
        diag('E-SEM-033', spanOf(node), {
          titleKo: `${fn.labelKo}에 값이 너무 많습니다`,
          bodyKo: `${fn.labelKo}은 최대 ${fn.params.length}개의 값을 받습니다.`,
          got: got('현재', `${node.args.length}개`),
          need: need('가능', `${fn.params.length}개 이하`),
        }),
      );
    }

    // Argument types
    node.args.forEach((arg, index) => {
      const param = fn.params[index];
      if (!param) return;
      const actual = inferType(arg);
      if (param.type === 'event' && actual.type !== 'event') {
        out.push(
          diag('E-SEM-034', spanOf(arg), {
            titleKo: '사건이 와야 하는 자리입니다',
            bodyKo: `${fn.labelKo}의 '${param.labelKo}' 자리에는 사건이 들어갑니다.`,
            got: got('현재', `${describeExpr(arg)} (${actual.labelKo})`),
            need: need('필요', '사건'),
          }),
        );
        return;
      }
      if (param.type === 'float' && actual.type === 'event') {
        out.push(
          diag('E-SEM-032', spanOf(arg), {
            got: got('현재', `${describeExpr(arg)} (사건)`),
            need: need('필요', '숫자 또는 시간'),
            quickFixes:
              arg.kind === 'EventRef'
                ? [
                    {
                      titleKo: `${arg.surface}.time 으로 바꾸기`,
                      span: spanOf(arg),
                      newText: `${arg.surface}.time`,
                    },
                  ]
                : [],
          }),
        );
        return;
      }
      if (!argumentTypeCompatible(param.type, actual.type)) {
        out.push(
          diag('E-SEM-043', spanOf(arg), {
            titleKo: `${fn.labelKo}에 맞지 않는 값입니다`,
            bodyKo: `${param.labelKo} 자리에는 ${typeLabelKo(param.type)} 종류의 값이 필요합니다.`,
            got: got('현재', `${describeExpr(arg)} (${actual.labelKo})`),
            need: need('필요', typeLabelKo(param.type)),
          }),
        );
      }
    });

    if (!fn.validGrains.includes(grain)) {
      out.push(
        diag('E-SEM-052', spanOf(node), {
          titleKo: `${fn.labelKo}은 이 분석 단위에서 쓸 수 없습니다`,
          bodyKo: `${fn.labelKo}은 ${fn.validGrains.map(grainUnitKo).join(', ')} 기준에서만 계산됩니다.`,
          got: got('현재', `${grainUnitKo(grain)} 기준`),
          need: need('가능', ...fn.validGrains.map(grainUnitKo)),
        }),
      );
    }
  });
}

function argumentTypeCompatible(expected: ValueType, actual: ValueType): boolean {
  if (expected === 'any' || actual === 'any') return true;
  if (expected === actual) return true;
  if (expected === 'float' && isNumericType(actual)) return true;
  return false;
}

/** Whether a grouping key is meaningful at this grain, notably champion at team grain. */
function checkGroupKeys(program: Program, grain: GrainId, out: Diagnostic[]): void {
  for (const key of program.body.groupBy) {
    const name = key.expr.kind === 'Identifier' ? key.expr.name : null;
    if (!name) continue;
    const def = catalog.groupKeys[name];
    if (!def) {
      out.push(
        diag('E-SEM-014', spanOf(key), {
          titleKo: '알 수 없는 분류 기준입니다',
          bodyKo: '이 이름으로는 나눌 수 없습니다.',
          got: got('현재', name),
          need: need('사용 가능', ...Object.values(catalog.groupKeys).map((g) => g.labelKo)),
        }),
      );
      continue;
    }
    if (def.validGrains.includes(grain)) continue;

    // Champion grouping at team grain multiplies each team row by five.
    const isTeamChampion = name === 'champion' && grain === 'team';
    out.push(
      diag(isTeamChampion ? 'E-SEM-051' : 'E-SEM-053', spanOf(key), {
        titleKo: isTeamChampion
          ? catalog.diagnostics['E-SEM-051']!.titleKo
          : `${def.labelKo}(으)로는 이 분석 단위를 나눌 수 없습니다`,
        bodyKo: isTeamChampion
          ? catalog.diagnostics['E-SEM-051']!.bodyKo
          : `${def.labelKo}은 ${def.validGrains.map(grainUnitKo).join(', ')} 기준에서만 쓸 수 있습니다.`,
        got: got('현재', `${grainUnitKo(grain)} 기준 + ${def.labelKo}별 분류`),
        need: need('필요', ...def.validGrains.map((g) => `${grainUnitKo(g)} 기준`)),
        quickFixes: isTeamChampion
          ? [{ titleKo: '선수 단위로 바꾸기', span: SPAN_ZERO, newText: 'ANALYZE player\n' }]
          : [],
      }),
    );
  }
}

/** A success rate requires a reference event. */
function checkChainRequirements(program: Program, out: Diagnostic[]): void {
  const hasChain = program.body.kind === 'SimpleStmt' && program.body.chain !== null;
  walk(program, (node) => {
    if (node.kind !== 'CallExpr') return;
    const fn = catalog.functions[node.callee];
    if (fn?.requiresClause === 'chain' && !hasChain) {
      out.push(
        diag('E-SEM-060', spanOf(node), {
          got: got('현재', `${fn.labelKo}만 있음`),
          need: need('필요', '기준 사건', '시간 범위'),
          quickFixes: [
            {
              titleKo: '기준 사건과 시간 범위 추가',
              span: SPAN_ZERO,
              newText: 'AFTER kill WITHIN 90s\n',
            },
          ],
        }),
      );
    }
  });
}

/** Empty RETURN clauses and non-aggregate return values. */
function checkReturns(program: Program, out: Diagnostic[]): void {
  const returns = program.body.returns;
  if (!returns.length) return; // The parser already emitted E-SYN-001.

  for (const item of returns) {
    const expr = item.expr;
    const type = inferType(expr);
    if (type.type === 'event') {
      out.push(
        diag('E-SEM-035', spanOf(item), {
          titleKo: '사건 자체는 결과가 될 수 없습니다',
          bodyKo: '사건이 몇 번 일어났는지, 얼마나 걸렸는지 같은 측정값을 골라 주세요.',
          got: got('현재', describeExpr(expr)),
          need: need('예', '개수', '승률', '두 사건 사이의 시간'),
        }),
      );
    }
  }
}

/**
 * Detects outcome leakage into a condition (reverse causality in §23).
 *
 * Filtering to winning teams before measuring win rate always returns 100%, so the system
 * must expose this non-obvious mistake.
 */
function checkPostOutcomeConditions(program: Program, out: Diagnostic[]): void {
  const conditions =
    program.body.kind === 'SimpleStmt'
      ? [program.body.when, program.body.chain?.condition ?? null]
      : program.body.arms.map((arm) => arm.when);

  for (const condition of conditions) {
    if (!condition) continue;
    walk(condition, (node: Node) => {
      const name =
        node.kind === 'Identifier'
          ? node.name
          : node.kind === 'CallExpr' && node.callee === 'win_rate'
            ? node.callee
            : null;
      if (name !== 'win' && name !== 'winner' && name !== 'win_rate') return;
      out.push(
        diag('W-SEM-080', spanOf(node), {
          severity: 'warning',
          got: got('현재', `조건에 ${name}`),
          need: need('확인', '결과를 조건에서 빼기'),
        }),
      );
    });
  }
}

/** Every condition slot must evaluate to true or false. */
function checkBooleanContexts(program: Program, out: Diagnostic[]): void {
  const conditions: Expr[] = [];
  if (program.body.kind === 'SimpleStmt') {
    if (program.body.when) conditions.push(program.body.when);
    if (program.body.chain?.condition) conditions.push(program.body.chain.condition);
  } else {
    conditions.push(...program.body.arms.map((arm) => arm.when));
  }
  for (const condition of conditions) {
    const actual = inferType(condition);
    if (actual.type !== 'bool') {
      out.push(
        diag('E-SEM-043', spanOf(condition), {
          titleKo: '조건은 맞다 또는 아니다로 판단할 수 있어야 합니다',
          bodyKo: '조건 자리에는 참과 거짓으로 결과가 나오는 표현을 사용해 주세요.',
          got: got('현재', `${describeExpr(condition)} (${actual.labelKo})`),
          need: need('필요', '참/거짓 조건'),
        }),
      );
    }
    walk(condition, (node) => {
      const operands =
        node.kind === 'BinaryExpr' && (node.op === 'AND' || node.op === 'OR')
          ? [node.left, node.right]
          : node.kind === 'UnaryExpr' && node.op === 'NOT'
            ? [node.operand]
            : [];
      for (const operand of operands) {
        const operandType = inferType(operand);
        if (operandType.type === 'bool') continue;
        out.push(
          diag('E-SEM-043', spanOf(operand), {
            titleKo: '논리 조건에는 참/거짓 값이 필요합니다',
            bodyKo: '`AND`, `OR`, `NOT`은 참과 거짓으로 판단할 수 있는 조건에만 쓸 수 있습니다.',
            got: got('현재', `${describeExpr(operand)} (${operandType.labelKo})`),
            need: need('필요', '참/거짓 조건'),
          }),
        );
      }
    });
  }
}

/** Warns when a probe time exceeds most matches and would silently shrink the sample. */
function checkMeasureTiming(program: Program, context: ValidationContext, out: Diagnostic[]): void {
  const median = context.medianMatchDurationS;
  if (!median) return;
  walk(program, (node) => {
    if (node.kind !== 'MeasureAt') return;
    if (node.at.seconds <= median) return;
    out.push(
      diag('E-SEM-070', spanOf(node), {
        severity: 'warning',
        got: got('현재', node.at.raw),
        need: need('참고', `중앙 경기 길이 ${Math.round(median / 60)}분`),
      }),
    );
  });
}

/** Renders each condition as Korean copy for the applied-conditions panel. */
export function describeCondition(expr: Expr): string {
  switch (expr.kind) {
    case 'EventPredicate': {
      const event = catalog.events[expr.event.eventType];
      const baseLabel = event?.labelKo ?? expr.event.surface;
      const label =
        typeof expr.event.ordinal === 'number'
          ? `${expr.event.ordinal}번째 ${baseLabel}`
          : expr.event.ordinal === 'last'
            ? `마지막 ${baseLabel}`
            : baseLabel;
      const side =
        expr.event.scope?.side === 'blue'
          ? '블루팀이 '
          : expr.event.scope?.side === 'red'
            ? '레드팀이 '
            : '';
      return expr.negated
        ? `${side}${eulReul(label)} 기록하지 않았습니다`
        : `${side}${eulReul(label)} 기록했습니다`;
    }
    case 'SpatialPredicate': {
      const where =
        expr.target.kind === 'RegionRef' ? `"${expr.target.name}" 영역` : describeExpr(expr.target);
      const what = describeExpr(expr.position);
      if (expr.relation === 'IN_REGION') return `${where} 안에서 ${what} 좌표가 기록되었습니다`;
      if (expr.relation === 'WITHIN_RADIUS') {
        return `${what} 좌표는 ${where}에서 ${expr.radius ? describeExpr(expr.radius) : ''} 이내입니다`;
      }
      return `${what} 좌표가 ${where} 근처에 있습니다`;
    }
    case 'BinaryExpr': {
      if (expr.op === 'AND' || expr.op === 'OR') {
        const joiner = expr.op === 'AND' ? ' 그리고 ' : ' 또는 ';
        return `${describeCondition(expr.left)}${joiner}${describeCondition(expr.right)}`;
      }
      const left = describeExpr(expr.left);
      const right = describeExpr(expr.right);
      const comparison: Record<string, string> = {
        '=': `${left} 값은 ${right}와 같습니다`,
        '!=': `${left} 값은 ${right}와 다릅니다`,
        '>': `${left} 값은 ${right}보다 큽니다`,
        '>=': `${left} 값은 ${right} 이상입니다`,
        '<': `${left} 값은 ${right}보다 작습니다`,
        '<=': `${left} 값은 ${right} 이하입니다`,
      };
      return comparison[expr.op] ?? `${left} ${expr.op} ${right}`;
    }
    default:
      return describeExpr(expr);
  }
}
