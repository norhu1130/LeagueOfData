import type { Ordinal, SpatialPredicate } from '@lol/ast';
import {
  AnalysisClient,
  type AnalysisDatasetFilters,
  type AiDslDraft,
  type AiStatus,
  type EffectiveCatalog,
} from '@lol/analysis-client';
import { catalog, listEvents, listGroupKeys } from '@lol/catalog';
import { PRESET_REGIONS, type RegionDefinition } from '@lol/data-model';
import { parse, printDsl } from '@lol/dsl';
import {
  applyCardEdit,
  applyDslEdit,
  createSyncDocument,
  project,
  type AstPath,
  type SyncDocument,
} from '@lol/visual-builder';
import { BUILDER_LIMITS, validate, type CounterItemSelection } from '@lol/validate';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  type ChangeEvent,
} from 'react';
import { MapPanel } from './MapPanel.js';
import { AnalysisBuilderPane } from './components/AnalysisBuilderPane.js';
import {
  containsEventRef,
  findNumberedDragonRef,
  isDragonTypeGroup,
} from './components/EventConditionEditors.js';
import { DataSourcesPane, HomePane, SettingsPane } from './components/AppRoutePanes.js';
import {
  AnalysisSidebar,
  AppHeader,
  AppLegalNotice,
  PanelResizer,
} from './components/AppShellChrome.js';
import { ResultPane } from './features/ResultPane.js';
import { EXAMPLES } from './analysis-examples.js';
export { EXAMPLES } from './analysis-examples.js';
import {
  THEME_PREFERENCE,
  deletedRegionIds,
  preferredColorTheme,
  resultIsStale,
  setRegionDeleted,
  type ColorTheme,
} from './app-preferences.js';
import {
  documentFromDsl,
  type EventScopeChoice,
  type ItemResponseDraft,
} from './features/analysis-dsl.js';
import type { RosterRelation } from './features/roster-analysis.js';
import {
  appendCondition,
  appendDragonTypeGroup,
  appendGroupKey,
  appendSequence,
  compareWithOpposite,
  createChampionDraft,
  createCounterItemDraft,
  createItemResponseDraft,
} from './features/builder-commands.js';
import {
  analysisResultCacheIdentity,
  currentAnalysis,
  downloadAnalysis,
  listAnalyses,
  listRegionDefinitions,
  loadAnalysisResult,
  parseImportedAnalysis,
  renameRegionRefs,
  deleteAnalysis,
  deleteRegionDefinition,
  saveAnalysis,
  saveRegionDefinition,
  type StoredAnalysis,
} from './storage.js';
import { restoreStoredDocument } from './stored-document.js';
import { parseRoute, routePath, type AppRoute } from './routes.js';
import { DEFAULT_PANEL_WIDTHS } from './layout/panel-layout.js';
import { useResizablePanels } from './layout/useResizablePanels.js';
import { questionScopedItemReferences, useItemMetadata } from './features/useItemMetadata.js';
import {
  questionScopedChampionReferences,
  useChampionMetadata,
} from './features/useChampionMetadata.js';
import { useAnalysisRun } from './features/useAnalysisRun.js';
import { useDataSources } from './features/useDataSources.js';

const DslEditor = lazy(() => import('./DslEditor.js'));
const analysisClient = new AnalysisClient();
const STATIC_CARD_EVENTS = listEvents();
const REGION_LIBRARY_INITIALIZED = 'lod-region-library-initialized';
type EffectiveCatalogView = EffectiveCatalog & { readonly catalogHash?: string };

const DEFAULT_CUSTOM_REGION: RegionDefinition = {
  id: 'custom_region_1',
  label: '탑 강가 사용자 영역',
  origin: 'user',
  coordSpace: 'norm-v1',
  shape: { kind: 'rect', x0: 0, y0: 0.55, x1: 0.35, y1: 1 },
};

const EXAMPLE_DOCUMENTS = EXAMPLES.map((example) => ({
  ...example,
  document: documentFromDsl(example.dsl),
}));

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname));
  const [sync, setSync] = useState(() => EXAMPLE_DOCUMENTS[1]!.document);
  const [documentId, setDocumentId] = useState('current');
  const [activeExampleId, setActiveExampleId] = useState<string | null>('b');
  const [savedAnalyses, setSavedAnalyses] = useState<StoredAnalysis[]>([]);
  const [title, setTitle] = useState(EXAMPLE_DOCUMENTS[1]!.title);
  const [mode, setMode] = useState<'builder' | 'dsl' | 'split'>('builder');
  const projection = useMemo(() => project(sync.ast), [sync.ast]);
  const firstResultCardIndex = projection.cards.findIndex(
    (card) => card.path[0] === 'body' && card.path[1] === 'returns',
  );
  const [hydrated, setHydrated] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [pendingImport, setPendingImport] = useState<StoredAnalysis | null>(null);
  const [regionConflictStrategy, setRegionConflictStrategy] = useState<
    'rename' | 'overwrite' | 'keep'
  >('rename');
  const [customRegions, setCustomRegions] = useState<RegionDefinition[]>([DEFAULT_CUSTOM_REGION]);
  const [effectiveCatalog, setEffectiveCatalog] = useState<EffectiveCatalogView | null>(null);
  const [catalogOnline, setCatalogOnline] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [colorTheme, setColorTheme] = useState<ColorTheme>(preferredColorTheme);
  const [activeLocationPath, setActiveLocationPath] = useState<AstPath | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [aiKey, setAiKey] = useState('');
  const [aiSettingsMessage, setAiSettingsMessage] = useState<string | null>(null);
  const [aiComposerOpen, setAiComposerOpen] = useState(false);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiDrafting, setAiDrafting] = useState(false);
  const [aiDraftError, setAiDraftError] = useState<string | null>(null);
  const [datasetPatch, setDatasetPatch] = useState('');
  const [datasetQueue, setDatasetQueue] = useState('');
  const [datasetTier, setDatasetTier] = useState('');
  const [datasetRegion, setDatasetRegion] = useState('');
  const [excludeRemakes, setExcludeRemakes] = useState(true);
  const deletedDocumentIds = useRef(new Set<string>());
  const importButton = useRef<HTMLButtonElement>(null);
  const importDialog = useRef<HTMLElement>(null);
  const regions = useMemo(() => [...PRESET_REGIONS, ...customRegions], [customRegions]);
  const datasetFilters = useMemo(
    () => ({
      ...(datasetPatch ? { patch: datasetPatch } : {}),
      ...(datasetQueue ? { queue: datasetQueue } : {}),
      ...(datasetTier ? { tier: datasetTier } : {}),
      ...(datasetRegion ? { region: datasetRegion } : {}),
      excludeRemakes,
    }),
    [datasetPatch, datasetQueue, datasetRegion, datasetTier, excludeRemakes],
  );
  const applyDatasetFilters = useCallback((filters?: AnalysisDatasetFilters) => {
    setDatasetPatch(filters?.patch ?? '');
    setDatasetQueue(filters?.queue ?? '');
    setDatasetTier(filters?.tier ?? '');
    setDatasetRegion(filters?.region ?? '');
    setExcludeRemakes(filters?.excludeRemakes ?? true);
  }, []);
  const resultPaneVisible = route.kind === 'analysis';
  const {
    appShell,
    appShellStyle,
    panelWidths,
    beginPanelResize,
    resizePanelTo,
    resizePanelWithKeyboard,
  } = useResizablePanels(resultPaneVisible);
  const sidebarAnalyses = useMemo(() => {
    if (!hydrated || route.kind !== 'analysis' || deletedDocumentIds.current.has(documentId)) {
      return savedAnalyses;
    }

    const persisted = savedAnalyses.find((analysis) => analysis.id === documentId);
    const live = {
      ...currentAnalysis(
        title,
        sync.dslText,
        sync.ast,
        customRegions,
        documentId,
        sync.state,
        datasetFilters,
      ),
      ...(persisted?.createdAt ? { createdAt: persisted.createdAt } : {}),
    };
    return [live, ...savedAnalyses.filter((analysis) => analysis.id !== documentId)];
  }, [customRegions, datasetFilters, documentId, hydrated, route.kind, savedAnalyses, sync, title]);
  const cardEvents = useMemo(() => {
    if (!effectiveCatalog) return STATIC_CARD_EVENTS;
    return STATIC_CARD_EVENTS.filter((event) => effectiveCatalog.events[event.id]?.available).map(
      (event) => {
        const effective = effectiveCatalog.events[event.id];
        return effective
          ? {
              ...event,
              context: effective.context ?? event.context,
              available: effective.available,
              unavailableReasonKo: effective.unavailableReasonKo,
            }
          : event;
      },
    );
  }, [effectiveCatalog]);
  const itemOptions = useItemMetadata(
    effectiveCatalog?.patches ?? [],
    effectiveCatalog?.items ?? [],
  );
  const championMetadata = useChampionMetadata(
    effectiveCatalog?.patches ?? [],
    effectiveCatalog?.champions ?? [],
  );
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = colorTheme;
    document.documentElement.style.colorScheme = colorTheme;
  }, [colorTheme]);
  const effectiveCatalogHash =
    effectiveCatalog?.hash ?? effectiveCatalog?.catalogHash ?? catalog.hash;
  const datasetSource = effectiveCatalog?.datasetSource ?? null;
  const publicInstance = effectiveCatalog?.instanceCapabilities.publicInstance ?? false;
  const syntheticDataset = datasetSource?.startsWith('synthetic') ?? false;
  const {
    runId,
    runStarting,
    runPhase,
    result,
    runError,
    biasAudit,
    biasAuditLoading,
    biasAuditError,
    execute,
    cancel,
    clear: abandonRun,
    invalidate: invalidateCurrentResult,
    reviewBias,
    restoreResult,
    reportError: setRunError,
  } = useAnalysisRun({
    client: analysisClient,
    ast: sync.ast,
    documentId,
    catalogReady,
    catalogHash: effectiveCatalogHash,
    datasetFilters,
    regions,
    cacheRegions: customRegions,
  });
  const updateEffectiveCatalog = useCallback((effective: EffectiveCatalog) => {
    setEffectiveCatalog(effective as EffectiveCatalogView);
    setCatalogOnline(true);
  }, []);
  const {
    sources: dataSources,
    loading: dataSourcesLoading,
    message: dataSourceMessage,
    connect: connectDataSource,
    activate: activateDataSource,
    remove: removeDataSource,
  } = useDataSources({
    client: analysisClient,
    enabled:
      route.kind === 'dataSources' &&
      Boolean(effectiveCatalog?.instanceCapabilities.dataSourceManagement),
    onInvalidate: invalidateCurrentResult,
    onCatalogChange: updateEffectiveCatalog,
  });
  const navigate = useCallback((next: AppRoute, replace = false) => {
    const path = routePath(next);
    if (window.location.pathname !== path)
      window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    setRoute(next);
  }, []);
  const semanticDiagnostics = useMemo(
    () =>
      validate(sync.ast, {
        regionIds: regions.map((region) => region.id),
        eventCapabilities: effectiveCatalog?.events,
      }).diagnostics,
    [effectiveCatalog, regions, sync.ast],
  );
  const hasSemanticErrors = semanticDiagnostics.some((item) => item.severity === 'error');
  const commitBuilderDocument = useCallback(
    (next: SyncDocument) => {
      if (next === sync) return;
      const rewritesAuthoredSource = sync.origin === 'dsl' && sync.dslText !== printDsl(sync.ast);
      if (
        rewritesAuthoredSource &&
        !window.confirm(
          '빌더에서 수정하면 DSL 편집기의 직접 작성한 서식과 주석이 정리됩니다. 계속할까요?',
        )
      )
        return;
      invalidateCurrentResult();
      setSync(next);
    },
    [invalidateCurrentResult, sync],
  );
  useEffect(() => {
    void analysisClient
      .catalog()
      .then((effective) => {
        setEffectiveCatalog(effective as EffectiveCatalogView);
        setCatalogOnline(true);
      })
      .catch(() => setCatalogOnline(false))
      .finally(() => setCatalogReady(true));
  }, []);
  useEffect(() => {
    if (!effectiveCatalog) return;
    if (!effectiveCatalog.instanceCapabilities.ai) {
      setAiStatus(null);
      return;
    }
    void analysisClient
      .aiStatus()
      .then(setAiStatus)
      .catch(() => setAiStatus(null));
  }, [effectiveCatalog]);
  useEffect(() => {
    if (
      effectiveCatalog?.instanceCapabilities.publicInstance &&
      (route.kind === 'settings' || route.kind === 'dataSources')
    ) {
      navigate({ kind: 'home' }, true);
    }
  }, [effectiveCatalog, navigate, route.kind]);
  useEffect(() => {
    if (!effectiveCatalog || !datasetPatch || effectiveCatalog.patches.includes(datasetPatch))
      return;
    invalidateCurrentResult();
    setDatasetPatch('');
  }, [datasetPatch, effectiveCatalog, invalidateCurrentResult]);
  useEffect(() => {
    if (!hydrated || route.kind !== 'analysis' || route.documentId === documentId) return;
    const saved = savedAnalyses.find((analysis) => analysis.id === route.documentId);
    if (!saved) {
      navigate({ kind: 'home' }, true);
      return;
    }
    abandonRun();
    setDocumentId(saved.id);
    setSync(restoreStoredDocument(saved));
    setTitle(saved.title);
    applyDatasetFilters(saved.datasetFilters);
    setCustomRegions((library) => [
      ...library.filter(
        (region) => !saved.regions.some((savedRegion) => savedRegion.id === region.id),
      ),
      ...saved.regions,
    ]);
  }, [abandonRun, applyDatasetFilters, documentId, hydrated, navigate, route, savedAnalyses]);
  useEffect(() => {
    if (route.kind !== 'regions') return;
    setMode('builder');
    window.setTimeout(
      () => document.getElementById('region-editor')?.scrollIntoView({ behavior: 'smooth' }),
      0,
    );
  }, [route]);
  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    void Promise.all([listAnalyses(), listRegionDefinitions()])
      .then(async ([analyses, libraryRegions]) => {
        setSavedAnalyses(analyses);
        const initialRoute = parseRoute(window.location.pathname);
        const saved =
          initialRoute.kind === 'analysis'
            ? analyses.find((analysis) => analysis.id === initialRoute.documentId)
            : analyses[0];
        if (saved) {
          setSync(restoreStoredDocument(saved));
          setTitle(saved.title);
          setDocumentId(saved.id);
          applyDatasetFilters(saved.datasetFilters);
        } else if (initialRoute.kind === 'analysis') {
          navigate({ kind: 'home' }, true);
        }
        let availableLibraryRegions = libraryRegions;
        if (!localStorage.getItem(REGION_LIBRARY_INITIALIZED)) {
          localStorage.setItem(REGION_LIBRARY_INITIALIZED, '1');
          if (availableLibraryRegions.length === 0) {
            await saveRegionDefinition(DEFAULT_CUSTOM_REGION);
            availableLibraryRegions = [DEFAULT_CUSTOM_REGION];
          }
        }
        const deletedIds = deletedRegionIds();
        availableLibraryRegions = availableLibraryRegions.filter(
          (region) => !deletedIds.has(region.id),
        );
        const documentRegions = saved?.regions ?? [];
        const merged = [...availableLibraryRegions, ...documentRegions].reduce<RegionDefinition[]>(
          (items, region) => [...items.filter((item) => item.id !== region.id), region],
          [],
        );
        setCustomRegions(merged);
      })
      .catch(() => setSaveStatus('error'))
      .finally(() => setHydrated(true));
  }, [applyDatasetFilters, navigate]);
  useEffect(() => {
    if (
      !hydrated ||
      !catalogReady ||
      !effectiveCatalog ||
      route.kind !== 'analysis' ||
      route.documentId !== documentId ||
      result ||
      resultIsStale(documentId)
    )
      return;
    const saved = savedAnalyses.find((analysis) => analysis.id === documentId);
    if (!saved) return;
    const identity = analysisResultCacheIdentity(
      saved.ast,
      saved.regions,
      effectiveCatalogHash,
      effectiveCatalog.datasetSnapshotId,
      datasetFilters,
    );
    let cancelled = false;
    void loadAnalysisResult(documentId, identity).then((cachedResult) => {
      if (!cancelled) restoreResult(cachedResult);
    });
    return () => {
      cancelled = true;
    };
  }, [
    catalogReady,
    documentId,
    effectiveCatalog,
    effectiveCatalogHash,
    datasetFilters,
    hydrated,
    result,
    route,
    savedAnalyses,
    restoreResult,
  ]);
  useEffect(() => {
    if (!pendingImport) return;
    importDialog.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPendingImport(null);
      window.setTimeout(() => importButton.current?.focus(), 0);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [pendingImport]);
  useEffect(() => {
    const showRegion = () => {
      navigate({ kind: 'regions' });
      setMode('builder');
      window.setTimeout(
        () => document.getElementById('region-editor')?.scrollIntoView({ behavior: 'smooth' }),
        0,
      );
    };
    window.addEventListener('lod-show-region', showRegion);
    return () => window.removeEventListener('lod-show-region', showRegion);
  }, [navigate]);
  useEffect(() => {
    if (!hydrated) return;
    setSaveStatus('saving');
    const timer = window.setTimeout(() => {
      if (deletedDocumentIds.current.has(documentId)) return;
      void saveAnalysis(
        currentAnalysis(
          title,
          sync.dslText,
          sync.ast,
          customRegions,
          documentId,
          sync.state,
          datasetFilters,
        ),
      )
        .then(async () => {
          if (deletedDocumentIds.current.has(documentId)) {
            await deleteAnalysis(documentId);
            return;
          }
          setSaveStatus('saved');
          setSavedAnalyses(await listAnalyses());
        })
        .catch(() => setSaveStatus('error'));
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [
    customRegions,
    datasetFilters,
    documentId,
    hydrated,
    sync.ast,
    sync.dslText,
    sync.state,
    title,
  ]);
  useEffect(() => {
    const locations = projection.cards.filter((candidate) => candidate.type === 'location');
    setActiveLocationPath((current) => {
      if (
        current &&
        locations.some((candidate) => JSON.stringify(candidate.path) === JSON.stringify(current))
      )
        return current;
      return locations.length === 1 ? locations[0]!.path : null;
    });
  }, [projection]);
  const activeRegionId = useMemo(() => {
    const card = projection.cards.find(
      (candidate) =>
        candidate.type === 'location' &&
        activeLocationPath !== null &&
        JSON.stringify(candidate.path) === JSON.stringify(activeLocationPath),
    );
    return card?.node.kind === 'SpatialPredicate' && card.node.target.kind === 'RegionRef'
      ? card.node.target.name
      : null;
  }, [activeLocationPath, projection]);
  const saveRegion = (region: RegionDefinition) => {
    setRegionDeleted(region.id, false);
    setCustomRegions((current) => [...current.filter((item) => item.id !== region.id), region]);
    void saveRegionDefinition(region).catch(() => setSaveStatus('error'));
    const location =
      route.kind === 'analysis' && activeLocationPath
        ? projection.cards.find(
            (card) =>
              card.type === 'location' &&
              JSON.stringify(card.path) === JSON.stringify(activeLocationPath),
          )
        : null;
    if (location?.node.kind === 'SpatialPredicate') {
      const value: SpatialPredicate = {
        ...location.node,
        target: { kind: 'RegionRef', name: region.id },
      };
      commitBuilderDocument(applyCardEdit(sync, { kind: 'replace', path: location.path, value }));
    }
  };
  const removeRegion = (region: RegionDefinition) => {
    setSaveStatus('saving');
    setRegionDeleted(region.id, true);
    const nextRegions = customRegions.filter((item) => item.id !== region.id);
    setCustomRegions(nextRegions);
    void deleteRegionDefinition(region.id).catch(() => setSaveStatus('error'));
    let next = sync;
    while (true) {
      const location = project(next.ast).cards.find(
        (card) =>
          card.type === 'location' &&
          card.node.kind === 'SpatialPredicate' &&
          card.node.target.kind === 'RegionRef' &&
          card.node.target.name === region.id,
      );
      if (!location) break;
      next = applyCardEdit(next, { kind: 'removeCondition', path: location.path });
    }
    if (next !== sync) {
      invalidateCurrentResult();
      setSync(next);
      setActiveExampleId(null);
    }
    void saveAnalysis(
      currentAnalysis(
        title,
        next.dslText,
        next.ast,
        nextRegions,
        documentId,
        next.state,
        datasetFilters,
      ),
    )
      .then(async () => {
        setSavedAnalyses(await listAnalyses());
        setSaveStatus('saved');
      })
      .catch(() => setSaveStatus('error'));
  };
  const persistCurrentNow = useCallback(() => {
    if (!hydrated || route.kind !== 'analysis' || deletedDocumentIds.current.has(documentId))
      return;
    setSaveStatus('saving');
    void saveAnalysis(
      currentAnalysis(
        title,
        sync.dslText,
        sync.ast,
        customRegions,
        documentId,
        sync.state,
        datasetFilters,
      ),
    )
      .then(async () => {
        if (deletedDocumentIds.current.has(documentId)) {
          await deleteAnalysis(documentId);
          return;
        }
        setSavedAnalyses(await listAnalyses());
        setSaveStatus('saved');
      })
      .catch(() => setSaveStatus('error'));
  }, [
    customRegions,
    datasetFilters,
    documentId,
    hydrated,
    route.kind,
    sync.ast,
    sync.dslText,
    sync.state,
    title,
  ]);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const primaryModifier = event.metaKey || event.ctrlKey;
      if (route.kind !== 'analysis') return;
      if (primaryModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        persistCurrentNow();
        return;
      }
      if (primaryModifier && !event.altKey && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (runId) void cancel();
        else if (catalogReady && sync.state !== 'stale' && !hasSemanticErrors && !runStarting)
          void execute();
        return;
      }
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent('lod-format-dsl'));
      }
    };
    window.addEventListener('keydown', onShortcut, true);
    return () => window.removeEventListener('keydown', onShortcut, true);
  }, [
    cancel,
    catalogReady,
    execute,
    hasSemanticErrors,
    persistCurrentNow,
    route.kind,
    runId,
    runStarting,
    sync.state,
  ]);
  const openExample = (example: (typeof EXAMPLE_DOCUMENTS)[number]) => {
    persistCurrentNow();
    const document = example.document;
    const nextDocumentId = `example_${example.id}_${Date.now()}`;
    setSync(document);
    setTitle(example.title);
    setActiveExampleId(example.id);
    setDocumentId(nextDocumentId);
    applyDatasetFilters();
    navigate({ kind: 'analysis', documentId: nextDocumentId, view: 'editor' });
    void execute(document.ast, nextDocumentId);
  };
  const openSaved = (saved: StoredAnalysis) => {
    if (saved.id === documentId && route.kind === 'analysis') {
      if (route.view !== 'editor')
        navigate({ kind: 'analysis', documentId: saved.id, view: 'editor' });
      return;
    }
    persistCurrentNow();
    abandonRun();
    setDocumentId(saved.id);
    setSync(restoreStoredDocument(saved));
    setTitle(saved.title);
    applyDatasetFilters(saved.datasetFilters);
    setCustomRegions((library) => [
      ...library.filter(
        (region) => !saved.regions.some((savedRegion) => savedRegion.id === region.id),
      ),
      ...saved.regions,
    ]);
    setActiveExampleId(null);
    navigate({ kind: 'analysis', documentId: saved.id, view: 'editor' });
  };
  const newAnalysis = () => {
    persistCurrentNow();
    abandonRun();
    const nextDocumentId = `analysis_${Date.now()}`;
    setDocumentId(nextDocumentId);
    setTitle('새 분석');
    setSync(documentFromDsl('ANALYZE blue\nRETURN blue.win_rate'));
    applyDatasetFilters();
    setActiveExampleId(null);
    navigate({ kind: 'analysis', documentId: nextDocumentId, view: 'editor' });
  };
  const removeAnalysis = async (saved: StoredAnalysis) => {
    if (!window.confirm(`“${saved.title}” 분석을 삭제할까요? 삭제 후 복구할 수 없습니다.`)) return;
    deletedDocumentIds.current.add(saved.id);
    try {
      await deleteAnalysis(saved.id);
      const remaining = await listAnalyses();
      setSavedAnalyses(remaining);
      if (saved.id === documentId) {
        abandonRun();
        const next = remaining[0];
        if (next) {
          setDocumentId(next.id);
          setSync(restoreStoredDocument(next));
          setTitle(next.title);
          applyDatasetFilters(next.datasetFilters);
          setCustomRegions((library) => [
            ...library.filter(
              (region) => !next.regions.some((savedRegion) => savedRegion.id === region.id),
            ),
            ...next.regions,
          ]);
          setActiveExampleId(null);
          navigate({ kind: 'analysis', documentId: next.id, view: 'editor' });
        } else {
          navigate({ kind: 'home' });
        }
      }
    } catch {
      deletedDocumentIds.current.delete(saved.id);
      setSaveStatus('error');
    }
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('분석 파일은 5MB보다 작아야 합니다.');
      const imported = parseImportedAnalysis(JSON.parse(await file.text()));
      if (!imported) throw new Error('지원하지 않는 분석 파일입니다.');
      setPendingImport(imported);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : '분석 파일을 읽지 못했습니다.');
    }
  };
  const applyImport = () => {
    if (!pendingImport) return;
    persistCurrentNow();
    abandonRun();
    const conflicts = pendingImport.regions.filter((incoming) =>
      customRegions.some(
        (current) =>
          current.id === incoming.id &&
          JSON.stringify(current.shape) !== JSON.stringify(incoming.shape),
      ),
    );
    const mapping = Object.fromEntries(
      conflicts.map((region) => {
        let candidate = `${region.id}_imported`;
        let suffix = 2;
        while ([...customRegions, ...pendingImport.regions].some((item) => item.id === candidate))
          candidate = `${region.id}_imported_${suffix++}`;
        return [region.id, candidate];
      }),
    );
    const importedRegions = pendingImport.regions.map((region) =>
      regionConflictStrategy === 'rename' && mapping[region.id]
        ? { ...region, id: mapping[region.id]! }
        : region,
    );
    const nextRegions =
      regionConflictStrategy === 'keep'
        ? [
            ...customRegions,
            ...importedRegions.filter(
              (incoming) => !customRegions.some((current) => current.id === incoming.id),
            ),
          ]
        : [
            ...customRegions.filter(
              (current) => !importedRegions.some((incoming) => incoming.id === current.id),
            ),
            ...importedRegions,
          ];
    for (const region of importedRegions) {
      setRegionDeleted(region.id, false);
      void saveRegionDefinition(region).catch(() => setSaveStatus('error'));
    }
    const ast =
      regionConflictStrategy === 'rename'
        ? renameRegionRefs(pendingImport.ast, mapping)
        : pendingImport.ast;
    setSync(
      regionConflictStrategy === 'rename'
        ? createSyncDocument(ast)
        : restoreStoredDocument({ ...pendingImport, ast }),
    );
    setTitle(pendingImport.title);
    applyDatasetFilters(pendingImport.datasetFilters);
    setCustomRegions(nextRegions);
    const nextDocumentId = `import_${Date.now()}`;
    setDocumentId(nextDocumentId);
    setActiveExampleId(null);
    setPendingImport(null);
    navigate({ kind: 'analysis', documentId: nextDocumentId, view: 'editor' });
  };

  const addCondition = (source: string) => {
    commitBuilderDocument(appendCondition(sync, source));
    setActiveExampleId(null);
  };

  const createItemResponseAnalysis = (selection: ItemResponseDraft) => {
    const draft = createItemResponseDraft(selection);
    commitBuilderDocument(draft.document);
    setTitle(draft.title);
    setActiveExampleId(null);
  };

  const createCounterItemAnalysis = (selection: CounterItemSelection) => {
    const draft = createCounterItemDraft(selection);
    commitBuilderDocument(draft.document);
    setTitle(draft.title);
    setActiveExampleId(null);
  };

  const createChampionAnalysis = (selection: {
    champion: string;
    role: string;
    relation: RosterRelation | 'none';
    relatedChampion: string;
    relatedRole: string;
  }) => {
    const draft = createChampionDraft(selection);
    commitBuilderDocument(draft.document);
    setTitle(draft.title);
    setActiveExampleId(null);
  };

  const addSequence = (
    startEvent = 'kill',
    endEvent = 'dragon_kill',
    seconds = 90,
    startScope: EventScopeChoice = 'target',
    endScope: EventScopeChoice = 'target',
    startOrdinal: Ordinal = 'any',
    endOrdinal: Ordinal = 'any',
    endRoles: readonly string[] = [],
    endRoleMode: 'any' | 'all' = 'any',
  ) => {
    commitBuilderDocument(
      appendSequence(sync, {
        startEvent,
        endEvent,
        seconds,
        startScope,
        endScope,
        startOrdinal,
        endOrdinal,
        endRoles,
        endRoleMode,
      }),
    );
    setActiveExampleId(null);
  };

  const makeComparison = () => {
    commitBuilderDocument(compareWithOpposite(sync));
    setActiveExampleId(null);
  };
  const unconditional =
    sync.ast.body.kind === 'SimpleStmt' && !sync.ast.body.when && !sync.ast.body.chain;
  const groupingGrain =
    sync.ast.body.kind === 'SimpleStmt' && sync.ast.body.chain
      ? 'event'
      : (sync.ast.analyze?.entity ?? 'team');
  const selectedGroupIds = new Set(
    sync.ast.body.groupBy.flatMap((group) =>
      group.expr.kind === 'Identifier' ? [group.expr.name] : [],
    ),
  );
  const analysisContext =
    sync.ast.body.kind === 'SimpleStmt'
      ? { chain: sync.ast.body.chain, when: sync.ast.body.when }
      : sync.ast.body;
  const numberedDragon = findNumberedDragonRef(analysisContext);
  const hasFirstBlood = containsEventRef(analysisContext, 'first_blood');
  const availableGroupKeys = listGroupKeys(groupingGrain).filter(
    (group) =>
      !selectedGroupIds.has(group.id) &&
      (group.id !== 'position_region' || (groupingGrain === 'team' && hasFirstBlood)) &&
      (group.id !== 'side' || !sync.ast.analyze?.side),
  );
  const hasDragonTypeGroup = sync.ast.body.groupBy.some(isDragonTypeGroup);
  const dragonTypeGroupAvailable = Boolean(numberedDragon) && !hasDragonTypeGroup;
  const comparisonActionVisible =
    sync.ast.body.kind === 'SimpleStmt' && Boolean(sync.ast.body.when);
  const groupingDisabledReason =
    sync.ast.body.kind === 'CompareStmt'
      ? '비교 조건과 분류 기준은 현재 한 분석에서 함께 사용할 수 없습니다.'
      : sync.ast.body.groupBy.length >= BUILDER_LIMITS.maxGroupKeys
        ? `분류 기준은 ${BUILDER_LIMITS.maxGroupKeys}개까지 추가할 수 있습니다.`
        : availableGroupKeys.length === 0 && !dragonTypeGroupAvailable
          ? '현재 분석 단위에 더 추가할 수 있는 분류 기준이 없습니다.'
          : null;
  const addGroupKey = (id: string) => {
    if (groupingDisabledReason) return;
    commitBuilderDocument(appendGroupKey(sync, id));
    setActiveExampleId(null);
  };
  const addDragonTypeGroup = () => {
    if (groupingDisabledReason || !numberedDragon) return;
    commitBuilderDocument(appendDragonTypeGroup(sync, numberedDragon));
    setActiveExampleId(null);
  };
  const generateAiDsl = async () => {
    const question = aiQuestion.trim();
    if (!question) return;
    setAiDrafting(true);
    setAiDraftError(null);
    try {
      const draft: AiDslDraft = await analysisClient.generateDsl({
        question,
        currentDsl: sync.dslText,
        regions: regions.map((region) => ({ id: region.id, label: region.label })),
        championReferences: questionScopedChampionReferences(question, championMetadata),
        itemReferences: questionScopedItemReferences(question, itemOptions),
        currentDatasetFilters: datasetFilters,
      });
      if (!draft.dsl.trim())
        throw new Error(draft.explanationKo || '이 질문은 아직 DSL로 만들 수 없습니다.');
      const parsed = parse(draft.dsl);
      const errors = [
        ...parsed.diagnostics,
        ...(parsed.ast
          ? validate(parsed.ast, {
              regionIds: regions.map((region) => region.id),
              eventCapabilities: effectiveCatalog?.events,
            }).diagnostics
          : []),
      ].filter((diagnostic) => diagnostic.severity === 'error');
      if (!parsed.ast || errors.length) {
        throw new Error(
          errors[0]?.titleKo ?? 'AI가 만든 DSL을 현재 카탈로그로 검증하지 못했습니다.',
        );
      }
      invalidateCurrentResult();
      setSync(createSyncDocument(parsed.ast, draft.dsl));
      applyDatasetFilters({
        ...(draft.datasetFilters.patch ? { patch: draft.datasetFilters.patch } : {}),
        ...(draft.datasetFilters.queue ? { queue: draft.datasetFilters.queue } : {}),
        ...(draft.datasetFilters.tier ? { tier: draft.datasetFilters.tier } : {}),
        ...(draft.datasetFilters.region ? { region: draft.datasetFilters.region } : {}),
        excludeRemakes: draft.datasetFilters.excludeRemakes,
      });
      if (draft.titleKo.trim()) setTitle(draft.titleKo.trim());
      setActiveExampleId(null);
      setAiComposerOpen(false);
      setAiQuestion('');
      void reviewBias(parsed.ast);
    } catch (error) {
      setAiDraftError(
        error instanceof Error ? error.message : 'AI DSL 생성을 완료하지 못했습니다.',
      );
    } finally {
      setAiDrafting(false);
    }
  };
  const configureAi = async () => {
    const key = aiKey.trim();
    if (!key) return;
    setAiSettingsMessage('연결 중…');
    try {
      setAiStatus(await analysisClient.configureAi(key));
      setAiKey('');
      setAiSettingsMessage('이 API 세션에서 AI 기능이 활성화되었습니다.');
    } catch (error) {
      setAiSettingsMessage(
        error instanceof Error ? error.message : 'OpenRouter 키를 저장하지 못했습니다.',
      );
    }
  };
  const clearAi = async () => {
    try {
      setAiStatus(await analysisClient.clearAiConfiguration());
      setAiSettingsMessage(
        aiStatus?.persistent
          ? '세션 키를 제거했습니다. 환경변수 키는 계속 사용됩니다.'
          : '세션 키를 제거했습니다.',
      );
    } catch (error) {
      setAiSettingsMessage(
        error instanceof Error ? error.message : '세션 키를 제거하지 못했습니다.',
      );
    }
  };
  return (
    <div
      ref={appShell}
      className={`app-shell${resultPaneVisible ? ' app-shell--analysis' : ''}`}
      style={appShellStyle}
    >
      <AppHeader
        route={route}
        saveStatus={saveStatus}
        syntheticDataset={syntheticDataset}
        publicInstance={publicInstance}
        colorTheme={colorTheme}
        mode={mode}
        catalogReady={catalogReady}
        documentReady={sync.state !== 'stale'}
        hasSemanticErrors={hasSemanticErrors}
        runStarting={runStarting}
        runId={runId}
        importButtonRef={importButton}
        onNavigate={navigate}
        onSave={persistCurrentNow}
        onThemeToggle={() => {
          const next = colorTheme === 'dark' ? 'light' : 'dark';
          window.localStorage.setItem(THEME_PREFERENCE, next);
          setColorTheme(next);
        }}
        onModeChange={setMode}
        onExecute={() => void execute()}
        onCancel={() => void cancel()}
        onExport={() =>
          downloadAnalysis(
            currentAnalysis(
              title,
              sync.dslText,
              sync.ast,
              customRegions,
              documentId,
              sync.state,
              datasetFilters,
            ),
          )
        }
        onImportFile={importFile}
      />
      <AnalysisSidebar
        analyses={sidebarAnalyses}
        documentId={documentId}
        examples={EXAMPLE_DOCUMENTS}
        catalogReady={catalogReady}
        onNew={newAnalysis}
        onOpen={openSaved}
        onRemove={(saved) => void removeAnalysis(saved)}
        onOpenExample={(id) => {
          const example = EXAMPLE_DOCUMENTS.find((candidate) => candidate.id === id);
          if (example) openExample(example);
        }}
      />
      <PanelResizer
        panel="sidebar"
        width={panelWidths.sidebar}
        onPointerDown={(event) => beginPanelResize('sidebar', event)}
        onKeyDown={(event) => resizePanelWithKeyboard('sidebar', event)}
        onReset={() => resizePanelTo('sidebar', DEFAULT_PANEL_WIDTHS.sidebar)}
      />
      <main className={`workspace workspace--${mode}`}>
        {route.kind === 'home' && (
          <HomePane
            examples={EXAMPLE_DOCUMENTS}
            syntheticDataset={syntheticDataset}
            catalogReady={catalogReady}
            onOpenExample={(id) => {
              const example = EXAMPLE_DOCUMENTS.find((candidate) => candidate.id === id);
              if (example) openExample(example);
            }}
            onNewAnalysis={newAnalysis}
          />
        )}
        {route.kind === 'settings' && (
          <SettingsPane
            catalogOnline={catalogOnline}
            eventCount={cardEvents.length}
            aiStatus={aiStatus}
            aiKey={aiKey}
            message={aiSettingsMessage}
            onAiKeyChange={setAiKey}
            onConfigureAi={() => void configureAi()}
            onClearAi={() => void clearAi()}
          />
        )}
        {route.kind === 'dataSources' && (
          <DataSourcesPane
            sources={dataSources}
            loading={dataSourcesLoading}
            message={dataSourceMessage}
            onConnect={connectDataSource}
            onActivate={(id) => void activateDataSource(id)}
            onRemove={(source) => void removeDataSource(source)}
          />
        )}
        {route.kind === 'analysis' && (mode === 'builder' || mode === 'split') && (
          <AnalysisBuilderPane
            title={title}
            sync={sync}
            projection={projection}
            firstResultCardIndex={firstResultCardIndex}
            mode={mode}
            catalogReady={catalogReady}
            effectiveCatalog={effectiveCatalog}
            events={cardEvents}
            items={itemOptions}
            regions={regions}
            customRegions={customRegions}
            activeRegionId={activeRegionId}
            activeExampleId={activeExampleId}
            resultMapPoints={result?.result.mapPoints}
            biasAudit={biasAudit}
            biasAuditLoading={biasAuditLoading}
            biasAuditError={biasAuditError}
            aiStatus={aiStatus}
            hasSemanticErrors={hasSemanticErrors}
            semanticDiagnostics={semanticDiagnostics}
            unconditional={unconditional}
            comparisonActionVisible={comparisonActionVisible}
            groupingDisabledReason={groupingDisabledReason}
            dragonTypeGroupAvailable={dragonTypeGroupAvailable}
            numberedDragon={numberedDragon}
            availableGroupKeys={availableGroupKeys}
            datasetPatch={datasetPatch}
            datasetQueue={datasetQueue}
            datasetTier={datasetTier}
            datasetRegion={datasetRegion}
            excludeRemakes={excludeRemakes}
            onTitleChange={setTitle}
            onModeChange={setMode}
            onReviewBias={() => void reviewBias()}
            onOpenAi={() => {
              setAiDraftError(null);
              setAiComposerOpen(true);
            }}
            onMakeComparison={makeComparison}
            onAddDragonTypeGroup={addDragonTypeGroup}
            onAddGroupKey={addGroupKey}
            onDatasetPatchChange={(patch) => {
              invalidateCurrentResult();
              setDatasetPatch(patch);
            }}
            onDatasetQueueChange={(queue) => {
              invalidateCurrentResult();
              setDatasetQueue(queue);
            }}
            onDatasetTierChange={(tier) => {
              invalidateCurrentResult();
              setDatasetTier(tier);
            }}
            onDatasetRegionChange={(region) => {
              invalidateCurrentResult();
              setDatasetRegion(region);
            }}
            onExcludeRemakesChange={(exclude) => {
              invalidateCurrentResult();
              setExcludeRemakes(exclude);
            }}
            onAddCondition={addCondition}
            onCreateItemResponse={createItemResponseAnalysis}
            onCreateCounterItem={createCounterItemAnalysis}
            onCreateChampionAnalysis={createChampionAnalysis}
            onAddSequence={addSequence}
            onCommitDocument={commitBuilderDocument}
            onActivateLocation={setActiveLocationPath}
            onSaveRegion={saveRegion}
            onDeleteRegion={removeRegion}
          />
        )}
        {route.kind === 'regions' && (
          <section className="region-management">
            <span className="eyebrow">REGION LIBRARY</span>
            <h1>내 영역</h1>
            <p>분석에서 다시 사용할 영역을 만들고 관리합니다.</p>
            <MapPanel
              regions={customRegions}
              activeRegionId={activeRegionId}
              heatmapPoints={[]}
              onSave={saveRegion}
              onDelete={removeRegion}
            />
          </section>
        )}
        {route.kind === 'analysis' && (mode === 'dsl' || mode === 'split') && (
          <section className="dsl-pane">
            <div className="pane-heading">
              <div>
                <span>LOL DSL</span>
                <h1>직접 편집</h1>
              </div>
              <div className="editor-meta">
                <span>Tab 완성 · ⌘/Ctrl+S 저장 · ⌘/Ctrl+Enter 실행</span>
                <b>rev {sync.dslRev}</b>
              </div>
            </div>
            <Suspense fallback={<div className="editor-loading">DSL 편집기를 불러오는 중…</div>}>
              <DslEditor
                value={sync.dslText}
                colorTheme={colorTheme}
                eventCapabilities={effectiveCatalog?.events}
                onChange={(value) => {
                  if (value === sync.dslText) return;
                  invalidateCurrentResult();
                  setSync((current) => applyDslEdit(current, value));
                }}
              />
            </Suspense>
            <div className="diagnostics">
              {[...sync.diagnostics, ...(sync.state === 'stale' ? [] : semanticDiagnostics)].map(
                (diagnostic) => (
                  <p key={`${diagnostic.code}-${diagnostic.span[0]}`}>⚠ {diagnostic.titleKo}</p>
                ),
              )}
            </div>
          </section>
        )}
      </main>
      {route.kind === 'analysis' && (
        <>
          <PanelResizer
            panel="result"
            width={panelWidths.result}
            onPointerDown={(event) => beginPanelResize('result', event)}
            onKeyDown={(event) => resizePanelWithKeyboard('result', event)}
            onReset={() => resizePanelTo('result', DEFAULT_PANEL_WIDTHS.result)}
          />
          <ResultPane
            result={result}
            phase={runPhase}
            error={runError}
            documentId={documentId}
            route={route}
            navigate={navigate}
            datasetSource={datasetSource}
            colorTheme={colorTheme}
            dsl={sync.dslText}
            aiEnabled={Boolean(aiStatus?.enabled)}
            matchDrilldownEnabled={effectiveCatalog?.instanceCapabilities.matchDrilldown ?? false}
            onRefreshRun={() => execute()}
          />
        </>
      )}
      {aiComposerOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !aiDrafting) setAiComposerOpen(false);
          }}
        >
          <section
            className="ai-composer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-composer-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !aiDrafting) setAiComposerOpen(false);
            }}
          >
            <span className="eyebrow">AI DSL ASSISTANT</span>
            <h2 id="ai-composer-title">어떤 분석을 만들까요?</h2>
            <p>팀 관계, 사건 순서, 시간 범위와 원하는 결과를 자연어로 적어 주세요.</p>
            <textarea
              autoFocus
              aria-label="AI에게 전달할 분석 질문"
              rows={5}
              maxLength={4000}
              placeholder="예: 아무 팀이 와드를 설치한 뒤 3분 안에 상대팀이 바론을 처치한 비율"
              value={aiQuestion}
              onChange={(event) => setAiQuestion(event.target.value)}
            />
            {aiDraftError && <div className="banner banner--stale">{aiDraftError}</div>}
            <div className="slot-row">
              <button disabled={aiDrafting} onClick={() => setAiComposerOpen(false)}>
                취소
              </button>
              <button
                className="picker-primary"
                disabled={aiDrafting || aiQuestion.trim().length < 3}
                onClick={() => void generateAiDsl()}
              >
                {aiDrafting ? 'DSL 만드는 중…' : 'DSL과 카드 만들기'}
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingImport && (
        <div className="modal-backdrop" role="presentation">
          <section
            ref={importDialog}
            className="import-preview"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const controls = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), input:not(:disabled)',
                ),
              );
              if (!controls.length) return;
              const first = controls[0]!;
              const last = controls.at(-1)!;
              if (
                event.shiftKey &&
                (document.activeElement === first || document.activeElement === event.currentTarget)
              ) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <span>가져오기 미리보기</span>
            <h2 id="import-title">{pendingImport.title}</h2>
            <pre>{pendingImport.dsl}</pre>
            <p>
              사용자 영역 {pendingImport.regions.length}개 · 가져온 분석은 자동 실행되지 않습니다.
            </p>
            {pendingImport.regions.some((incoming) =>
              customRegions.some(
                (current) =>
                  current.id === incoming.id &&
                  JSON.stringify(current.shape) !== JSON.stringify(incoming.shape),
              ),
            ) && (
              <fieldset className="conflict-options">
                <legend>같은 id의 영역을 처리하는 방법</legend>
                {(
                  [
                    ['rename', '가져온 영역 이름 변경'],
                    ['overwrite', '가져온 영역으로 덮어쓰기'],
                    ['keep', '현재 영역 유지'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="region-conflict"
                      value={value}
                      checked={regionConflictStrategy === value}
                      onChange={() => setRegionConflictStrategy(value)}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="slot-row">
              <button
                onClick={() => {
                  setPendingImport(null);
                  window.setTimeout(() => importButton.current?.focus(), 0);
                }}
              >
                취소
              </button>
              <button onClick={applyImport}>분석 가져오기</button>
            </div>
          </section>
        </div>
      )}
      <AppLegalNotice />
    </div>
  );
}
