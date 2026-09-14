import {
  useRef,
  type ChangeEvent,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type RefObject,
} from 'react';
import type { AppRoute } from '../routes.js';
import type { StoredAnalysis } from '../storage.js';
import type { ColorTheme } from '../app-preferences.js';
import { PANEL_WIDTH_LIMITS, type PanelName } from '../layout/panel-layout.js';

export type EditorMode = 'builder' | 'dsl' | 'split';

export function AppHeader({
  route,
  saveStatus,
  syntheticDataset,
  colorTheme,
  mode,
  catalogReady,
  documentReady,
  hasSemanticErrors,
  runStarting,
  runId,
  importButtonRef,
  onNavigate,
  onSave,
  onThemeToggle,
  onModeChange,
  onExecute,
  onCancel,
  onExport,
  onImportFile,
}: {
  route: AppRoute;
  saveStatus: 'saved' | 'saving' | 'error';
  syntheticDataset: boolean;
  colorTheme: ColorTheme;
  mode: EditorMode;
  catalogReady: boolean;
  documentReady: boolean;
  hasSemanticErrors: boolean;
  runStarting: boolean;
  runId: string | null;
  importButtonRef: RefObject<HTMLButtonElement>;
  onNavigate: (route: AppRoute) => void;
  onSave: () => void;
  onThemeToggle: () => void;
  onModeChange: (mode: EditorMode) => void;
  onExecute: () => void;
  onCancel: () => void;
  onExport: () => void;
  onImportFile: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const importInput = useRef<HTMLInputElement>(null);
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <strong>League of Data</strong>
        <span>
          매치 분석 IDE ·{' '}
          {route.kind === 'analysis' ? (
            <button className="save-status" title="지금 저장 (⌘S / Ctrl+S)" onClick={onSave}>
              {saveStatus === 'saving'
                ? '저장 중'
                : saveStatus === 'error'
                  ? '저장 실패'
                  : '저장됨'}
            </button>
          ) : (
            <span className="save-status" aria-label="분석 화면에서 자동 저장됩니다">
              자동 저장
            </span>
          )}
        </span>
      </div>
      {syntheticDataset && (
        <strong className="dataset-badge" title="실제 Riot 경기가 아닌 생성 데이터입니다.">
          합성 데이터
        </strong>
      )}
      <nav className="primary-nav" aria-label="주요 화면">
        {(
          [
            ['home', '홈'],
            ['regions', '영역'],
            ['dataSources', '데이터 소스'],
            ['settings', '설정'],
          ] as const
        ).map(([kind, label]) => (
          <button
            key={kind}
            aria-current={route.kind === kind ? 'page' : undefined}
            onClick={() => onNavigate({ kind })}
          >
            {label}
          </button>
        ))}
      </nav>
      <button
        className="theme-toggle"
        type="button"
        aria-label={colorTheme === 'dark' ? '라이트 테마로 전환' : '다크 테마로 전환'}
        aria-pressed={colorTheme === 'dark'}
        title={colorTheme === 'dark' ? '라이트 테마로 전환' : '다크 테마로 전환'}
        onClick={onThemeToggle}
      >
        <span aria-hidden="true">{colorTheme === 'dark' ? '☀' : '☾'}</span>
        {colorTheme === 'dark' ? '라이트' : '다크'}
      </button>
      {route.kind === 'analysis' && (
        <>
          <div className="mode-switch" role="group" aria-label="편집 모드">
            <button aria-pressed={mode === 'builder'} onClick={() => onModeChange('builder')}>
              빌더
            </button>
            <button aria-pressed={mode === 'dsl'} onClick={() => onModeChange('dsl')}>
              DSL
            </button>
            <button aria-pressed={mode === 'split'} onClick={() => onModeChange('split')}>
              나란히
            </button>
          </div>
          <button
            className="utility-button advanced-dsl-toggle"
            aria-pressed={mode !== 'builder'}
            onClick={() => onModeChange(mode === 'builder' ? 'split' : 'builder')}
          >
            {mode === 'builder' ? '고급 DSL 켜기' : '고급 DSL 끄기'}
          </button>
          <div className="run-action">
            <button
              className="run-button"
              aria-describedby="run-shortcut-hint"
              disabled={!catalogReady || !documentReady || hasSemanticErrors || runStarting}
              onClick={runId ? onCancel : onExecute}
            >
              {runStarting ? '시작 중…' : runId ? '취소' : '분석 실행'}
            </button>
            <span id="run-shortcut-hint" className="shortcut-tooltip" role="tooltip">
              <span>{runId ? '실행 취소' : '분석 실행'}</span>
              <kbd>⌘ Enter</kbd>
              <i>또는</i>
              <kbd>Ctrl Enter</kbd>
            </span>
          </div>
          <button className="utility-button" onClick={onExport}>
            내보내기
          </button>
        </>
      )}
      <button
        ref={importButtonRef}
        className="utility-button"
        onClick={() => importInput.current?.click()}
      >
        가져오기
      </button>
      <input
        ref={importInput}
        hidden
        type="file"
        accept=".json,.lolq.json"
        onChange={onImportFile}
      />
    </header>
  );
}

export function AnalysisSidebar({
  analyses,
  documentId,
  examples,
  catalogReady,
  onNew,
  onOpen,
  onRemove,
  onOpenExample,
}: {
  analyses: readonly StoredAnalysis[];
  documentId: string;
  examples: readonly { readonly id: string; readonly title: string }[];
  catalogReady: boolean;
  onNew: () => void;
  onOpen: (analysis: StoredAnalysis) => void;
  onRemove: (analysis: StoredAnalysis) => void;
  onOpenExample: (id: string) => void;
}) {
  return (
    <aside className="sidebar">
      <h2>내 분석</h2>
      <button className="doc-item doc-item--new" onClick={onNew}>
        + 새 분석
      </button>
      {analyses.map((analysis) => (
        <div className="doc-row" key={analysis.id}>
          <button
            className={`doc-item ${analysis.id === documentId ? 'doc-item--active' : ''}`}
            onClick={() => onOpen(analysis)}
          >
            {analysis.title}
          </button>
          <button
            className="doc-delete"
            aria-label={`${analysis.title} 분석 삭제`}
            title="분석 삭제"
            onClick={() => onRemove(analysis)}
          >
            삭제
          </button>
        </div>
      ))}
      <h2>예제</h2>
      {examples.map((example) => (
        <button
          className="doc-item"
          key={example.id}
          disabled={!catalogReady}
          onClick={() => onOpenExample(example.id)}
        >
          {example.title}
        </button>
      ))}
    </aside>
  );
}

export function PanelResizer({
  panel,
  width,
  onPointerDown,
  onKeyDown,
  onReset,
}: {
  panel: PanelName;
  width: number;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onReset: () => void;
}) {
  const label = panel === 'sidebar' ? '왼쪽 탐색 패널' : '오른쪽 결과 패널';
  return (
    <div
      className={`panel-resizer panel-resizer--${panel}`}
      role="separator"
      aria-label={`${label} 너비 조절`}
      aria-orientation="vertical"
      aria-valuemin={PANEL_WIDTH_LIMITS[panel].min}
      aria-valuemax={PANEL_WIDTH_LIMITS[panel].max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title={`드래그하여 ${label.replace(' 패널', '')} 패널 너비 조절 · 더블클릭하여 초기화`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}

export function AppLegalNotice() {
  return (
    <footer className="legal-notice">
      League of Data isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot
      Games or anyone officially involved in producing or managing Riot Games properties. Riot
      Games, and all associated properties are trademarks or registered trademarks of Riot Games,
      Inc.
    </footer>
  );
}
