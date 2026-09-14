import { catalog, listEvents, listFunctions, listGroupKeys, propertiesOf } from '@lol/catalog';
import { parse, printDsl, type Diagnostic } from '@lol/dsl';
import type * as Monaco from 'monaco-editor';

export const LANGUAGE_ID = 'loldsl';

type MonacoApi = typeof Monaco;

export interface DslEventCapability {
  readonly available: boolean;
  readonly context: readonly string[];
  readonly unavailableReasonKo?: string | null;
}

let eventCapabilities: Readonly<Record<string, DslEventCapability>> | null = null;

/** Updates completion and hover data to match the dataset currently connected to the editor. */
export function setLolDslEventCapabilities(
  capabilities: Readonly<Record<string, DslEventCapability>> | null,
): void {
  eventCapabilities = capabilities;
}

function effectiveEvents() {
  return listEvents()
    .filter((event) => eventCapabilities?.[event.id]?.available ?? event.available)
    .map((event) => {
      const effective = eventCapabilities?.[event.id];
      return effective ? { ...event, context: effective.context } : event;
    });
}

const keywords = [
  'ANALYZE',
  'WHEN',
  'RETURN',
  'GROUP',
  'BY',
  'COMPARE',
  'VS',
  'AS',
  'IF',
  'AND',
  'OR',
  'NOT',
  'IN',
  'BEFORE',
  'AFTER',
  'WITHIN',
  'UNTIL',
  'DURING',
  'BETWEEN',
  'AT',
  'OF',
  'NEAR',
  'TRUE',
  'FALSE',
  'NULL',
];

export interface InlineCompletionCandidate {
  readonly insertText: string;
  readonly replaceLength: number;
}

/** Returns the highest-value context-aware completion shown as VS Code-style ghost text. */
export function inlineCompletionAt(
  source: string,
  offset: number,
): InlineCompletionCandidate | null {
  const before = source.slice(0, offset);
  if (!before.trim()) {
    return {
      insertText: 'ANALYZE team\nWHEN first_blood\nRETURN win_rate()',
      replaceLength: 0,
    };
  }

  const property = before.match(/(?:^|\s)(?:blue\.|red\.|team\.)?([a-z_][a-z0-9_]*)\.([a-z_]*)$/i);
  if (property) {
    const prefix = property[2] ?? '';
    const candidate = propertiesOf(property[1] ?? '')?.find((item) =>
      item.id.toLowerCase().startsWith(prefix.toLowerCase()),
    );
    if (candidate && candidate.id !== prefix) {
      return { insertText: candidate.id, replaceLength: prefix.length };
    }
  }

  const prefix = before.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? '';
  const line = before.slice(before.lastIndexOf('\n') + 1);
  let candidates: string[];
  if (/^\s*ANALYZE\s+[A-Za-z_]*$/i.test(line)) {
    candidates = ['team', 'blue', 'red', 'player', 'match'];
  } else if (/\bIF\s+[A-Za-z_]*$/i.test(line)) {
    candidates = effectiveEvents().flatMap((event) => [
      event.id,
      `opponent.${event.id}`,
      `team.${event.id}`,
      `blue.${event.id}`,
      `red.${event.id}`,
    ]);
  } else if (/(?:\bWHEN|\bAND|\bOR)\s+[A-Za-z_]*$/i.test(line)) {
    candidates = effectiveEvents().flatMap((event) => [
      event.id,
      `blue.${event.id}`,
      `red.${event.id}`,
    ]);
  } else if (/\bRETURN\s+[A-Za-z_]*$/i.test(line) || /,\s*[A-Za-z_]*$/i.test(line)) {
    candidates = listFunctions().map((item) => `${item.id}()`);
  } else if (/\bGROUP\s+BY\s+[A-Za-z_]*$/i.test(line)) {
    candidates = listGroupKeys().map((item) => item.id);
  } else {
    candidates = keywords;
  }
  const candidate = candidates.find(
    (item) => item.toLowerCase().startsWith(prefix.toLowerCase()) && item !== prefix,
  );
  return candidate ? { insertText: candidate, replaceLength: prefix.length } : null;
}

export function diagnosticsToMarkers(
  monaco: MonacoApi,
  model: Monaco.editor.ITextModel,
  diagnostics: readonly Diagnostic[],
): Monaco.editor.IMarkerData[] {
  return diagnostics.map((diagnostic) => {
    const start = model.getPositionAt(diagnostic.span[0]);
    const end = model.getPositionAt(diagnostic.span[1]);
    return {
      severity:
        diagnostic.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : diagnostic.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Hint,
      message: `${diagnostic.titleKo}\n${diagnostic.bodyKo}`,
      code: diagnostic.code,
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: Math.max(end.column, start.column + 1),
    };
  });
}

export function setDslMarkers(monaco: MonacoApi, model: Monaco.editor.ITextModel): Diagnostic[] {
  const diagnostics = parse(model.getValue()).diagnostics;
  monaco.editor.setModelMarkers(
    model,
    LANGUAGE_ID,
    diagnosticsToMarkers(monaco, model, diagnostics),
  );
  return diagnostics;
}

let configured = false;
export function configureLolDsl(monaco: MonacoApi): void {
  if (configured) return;
  configured = true;
  monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.lolq'], aliases: ['LoL DSL'] });
  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: '--', blockComment: ['/*', '*/'] },
    brackets: [
      ['(', ')'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    ignoreCase: true,
    keywords,
    tokenizer: {
      root: [
        [/--.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/\d+(?:\.\d+)?(?:ms|s|m|h)+/, 'number.unit'],
        [/\d+(?::\d+){1,2}/, 'number.unit'],
        [/\d+(?:\.\d+)?%?/, 'number'],
        [/[a-z_][\w]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/[()[\],.]/, 'delimiter'],
        [/[=!<>+\-*/%]+/, 'operator'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  });
  monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: ['.', '(', '"'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const suggestions: Monaco.languages.CompletionItem[] = [
        {
          label: 'opponent',
          insertText: 'opponent.',
          detail: '시작 사건의 상대팀',
          documentation: '이어지는 사건에서 시작 사건을 기록한 팀의 상대팀을 선택합니다.',
          kind: monaco.languages.CompletionItemKind.Reference,
          range,
          sortText: '0-opponent',
        },
        ...keywords.map((label) => ({
          label,
          insertText: label,
          detail: 'DSL 키워드',
          kind: monaco.languages.CompletionItemKind.Keyword,
          range,
        })),
        ...effectiveEvents().map((event) => ({
          label: event.id,
          insertText: event.id,
          detail: event.labelKo,
          documentation: event.descriptionKo,
          kind: monaco.languages.CompletionItemKind.Event,
          range,
          sortText: `1-${String(event.rank).padStart(3, '0')}`,
        })),
        ...listFunctions().map((fn) => ({
          label: fn.id,
          insertText: `${fn.id}($0)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: fn.labelKo,
          documentation: fn.descriptionKo,
          kind: monaco.languages.CompletionItemKind.Function,
          range,
          sortText: `2-${String(fn.rank).padStart(3, '0')}`,
        })),
        ...listGroupKeys().map((key) => ({
          label: key.id,
          insertText: key.id,
          detail: key.labelKo,
          documentation: key.descriptionKo,
          kind: monaco.languages.CompletionItemKind.EnumMember,
          range,
          sortText: `3-${String(key.rank).padStart(3, '0')}`,
        })),
      ];
      return { suggestions };
    },
  });
  monaco.languages.registerInlineCompletionsProvider(LANGUAGE_ID, {
    provideInlineCompletions(model, position) {
      if (position.column !== model.getLineMaxColumn(position.lineNumber)) {
        return { items: [] };
      }
      const offset = model.getOffsetAt(position);
      const candidate = inlineCompletionAt(model.getValue(), offset);
      if (!candidate) return { items: [] };
      return {
        items: [
          {
            insertText: candidate.insertText,
            range: new monaco.Range(
              position.lineNumber,
              Math.max(1, position.column - candidate.replaceLength),
              position.lineNumber,
              position.column,
            ),
          },
        ],
        enableForwardStability: true,
      };
    },
    freeInlineCompletions() {},
  });
  monaco.languages.registerHoverProvider(LANGUAGE_ID, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position)?.word;
      if (!word) return null;
      const event = catalog.events[word];
      const fn = catalog.functions[word];
      const key = catalog.groupKeys[word];
      const effective = event ? eventCapabilities?.[event.id] : undefined;
      const item = event ?? fn ?? key;
      return item
        ? {
            contents: [
              { value: `**${item.labelKo}**` },
              {
                value:
                  effective?.available === false
                    ? effective.unavailableReasonKo || '현재 데이터에서는 사용할 수 없습니다.'
                    : item.descriptionKo,
              },
            ],
          }
        : null;
    },
  });
  monaco.languages.registerDocumentFormattingEditProvider(LANGUAGE_ID, {
    provideDocumentFormattingEdits(model) {
      const result = parse(model.getValue());
      if (!result.ast || result.diagnostics.some((item) => item.severity === 'error')) return [];
      return [{ range: model.getFullModelRange(), text: printDsl(result.ast) }];
    },
  });
  monaco.languages.registerCodeActionProvider(LANGUAGE_ID, {
    provideCodeActions(model) {
      const actions = parse(model.getValue()).diagnostics.flatMap((diagnostic) =>
        (diagnostic.quickFixes ?? []).map((fix) => {
          const start = model.getPositionAt(fix.span[0]);
          const end = model.getPositionAt(fix.span[1]);
          return {
            title: fix.titleKo,
            kind: 'quickfix',
            edit: {
              edits: [
                {
                  resource: model.uri,
                  versionId: model.getVersionId(),
                  textEdit: {
                    range: new monaco.Range(
                      start.lineNumber,
                      start.column,
                      end.lineNumber,
                      end.column,
                    ),
                    text: fix.newText,
                  },
                },
              ],
            },
          };
        }),
      );
      return { actions, dispose() {} };
    },
  });
  monaco.languages.registerSignatureHelpProvider(LANGUAGE_ID, {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp() {
      return {
        value: {
          signatures: [
            {
              label: 'duration(시작 사건, 끝 사건)',
              parameters: [{ label: '시작 사건' }, { label: '끝 사건' }],
            },
          ],
          activeSignature: 0,
          activeParameter: 0,
        },
        dispose() {},
      };
    },
  });
  monaco.languages.registerInlayHintsProvider(LANGUAGE_ID, {
    provideInlayHints(model, range) {
      const hints: Monaco.languages.InlayHint[] = [];
      const text = model.getValueInRange(range);
      const offset = model.getOffsetAt(range.getStartPosition());
      for (const match of text.matchAll(/\b(\d+)s\b/g)) {
        const seconds = Number(match[1]);
        if (seconds < 60 || !match.index) continue;
        hints.push({
          position: model.getPositionAt(offset + match.index + match[0].length),
          label: ` (${seconds / 60}분)`,
          kind: monaco.languages.InlayHintKind.Type,
          paddingLeft: true,
        });
      }
      return { hints, dispose() {} };
    },
  });
  monaco.editor.registerCommand('loldsl.showRegion', (_accessor, regionId: string) => {
    window.dispatchEvent(new CustomEvent('lod-show-region', { detail: regionId }));
  });
  monaco.languages.registerCodeLensProvider(LANGUAGE_ID, {
    provideCodeLenses(model) {
      const lenses: Monaco.languages.CodeLens[] = [];
      for (const match of model.getValue().matchAll(/region\("([a-z][a-z0-9_]*)"\)/g)) {
        if (match.index === undefined) continue;
        const start = model.getPositionAt(match.index);
        const end = model.getPositionAt(match.index + match[0].length);
        lenses.push({
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          command: {
            id: 'loldsl.showRegion',
            title: '미니맵에서 보기',
            arguments: [match[1]],
          },
        });
      }
      return { lenses, dispose() {} };
    },
    resolveCodeLens(_model, codeLens) {
      return codeLens;
    },
  });
}
