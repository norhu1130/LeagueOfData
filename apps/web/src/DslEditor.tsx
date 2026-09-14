import {
  configureLolDsl,
  LANGUAGE_ID,
  setDslMarkers,
  setLolDslEventCapabilities,
  type DslEventCapability,
} from '@lol/monaco-lang';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { useEffect, useRef } from 'react';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export default function DslEditor({
  value,
  onChange,
  eventCapabilities,
  colorTheme,
}: {
  value: string;
  onChange: (value: string) => void;
  eventCapabilities?: Readonly<Record<string, DslEventCapability>>;
  colorTheme: 'light' | 'dark';
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callback = useRef(onChange);
  const pending = useRef<{ value: string; versionId: number } | null>(null);
  const applyingExternal = useRef(false);
  callback.current = onChange;

  useEffect(() => {
    setLolDslEventCapabilities(eventCapabilities ?? null);
  }, [eventCapabilities]);

  useEffect(() => {
    monaco.editor.setTheme(colorTheme === 'dark' ? 'vs-dark' : 'vs');
  }, [colorTheme]);

  useEffect(() => {
    if (!host.current) return;
    configureLolDsl(monaco);
    const model = monaco.editor.createModel(value, LANGUAGE_ID);
    const instance = monaco.editor.create(host.current, {
      model,
      theme: colorTheme === 'dark' ? 'vs-dark' : 'vs',
      ariaLabel: 'LoL DSL 편집기',
      minimap: { enabled: false },
      automaticLayout: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontLigatures: false,
      fontSize: 14,
      lineHeight: 25,
      letterSpacing: 0,
      inlineSuggest: { enabled: true, mode: 'prefix', showToolbar: 'onHover' },
      tabCompletion: 'on',
      suggest: { preview: true, showInlineDetails: true },
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: 'smart',
      wordBasedSuggestions: 'off',
      parameterHints: { enabled: true },
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling: true,
      formatOnPaste: true,
      padding: { top: 16 },
      scrollBeyondLastLine: false,
    });
    editor.current = instance;
    setDslMarkers(monaco, model);
    const change = model.onDidChangeContent(() => {
      setDslMarkers(monaco, model);
      if (applyingExternal.current) return;
      // Any user edit supersedes a queued builder render. Applying the older queued value on blur
      // would silently erase what the user just typed.
      pending.current = null;
      callback.current(model.getValue());
    });
    const blur = instance.onDidBlurEditorText(() => {
      const queued = pending.current;
      pending.current = null;
      if (
        queued &&
        queued.versionId === model.getVersionId() &&
        queued.value !== model.getValue()
      ) {
        applyingExternal.current = true;
        model.setValue(queued.value);
        applyingExternal.current = false;
        setDslMarkers(monaco, model);
      }
    });
    const reveal = (raw: Event) => {
      const span = (raw as CustomEvent<readonly [number, number]>).detail;
      if (!span) return;
      const start = model.getPositionAt(span[0]);
      const end = model.getPositionAt(span[1]);
      instance.setSelection({
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      });
      instance.revealPositionInCenter(start);
      instance.focus();
    };
    const format = () => void instance.getAction('editor.action.formatDocument')?.run();
    window.addEventListener('lod-reveal-dsl', reveal);
    window.addEventListener('lod-format-dsl', format);
    return () => {
      window.removeEventListener('lod-reveal-dsl', reveal);
      window.removeEventListener('lod-format-dsl', format);
      change.dispose();
      blur.dispose();
      instance.dispose();
      model.dispose();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (!instance || !model || model.getValue() === value) return;
    if (instance.hasTextFocus()) pending.current = { value, versionId: model.getVersionId() };
    else {
      applyingExternal.current = true;
      model.setValue(value);
      applyingExternal.current = false;
      setDslMarkers(monaco, model);
    }
  }, [value]);

  return <div id="dsl-editor" className="monaco-host" ref={host} data-testid="dsl-editor" />;
}
