export type ResultUnit = 'percent' | 'seconds' | 'gold' | 'count' | null;

export interface ComparisonGroup {
  readonly id: string;
  readonly labelKo: string;
  readonly value: number | null;
  readonly n: number;
  readonly defined?: number;
  readonly coverage?: number;
  readonly confidenceInterval95?: { readonly low: number; readonly high: number } | null;
}

export interface RateComparison {
  readonly unit: 'percent';
  readonly groups: readonly (ComparisonGroup & {
    readonly confidenceInterval95: { readonly low: number; readonly high: number } | null;
  })[];
  readonly differencePoints: number | null;
  readonly difference?: never;
}

export interface AbsoluteComparison {
  readonly unit: Exclude<ResultUnit, 'percent'>;
  readonly groups: readonly ComparisonGroup[];
  readonly difference: number | null;
  readonly differencePoints?: never;
}

export type ComparisonPayload = RateComparison | AbsoluteComparison;

export interface BiasWarning {
  readonly code: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly titleKo: string;
  readonly messageKo: string;
  readonly mitigationKo: string;
}

export interface BiasAudit {
  readonly riskLevel: 'low' | 'medium' | 'high';
  readonly warnings: readonly BiasWarning[];
  readonly limitationsKo: string;
}

export interface AnalysisResponse {
  readonly format: 'loldsl.result';
  readonly version: 1;
  readonly runId: string;
  readonly result: {
    readonly type: string;
    readonly columns: readonly string[];
    readonly rows: readonly Record<string, unknown>[];
    readonly measures: readonly {
      readonly id: string;
      readonly alias: string;
      readonly labelKo: string;
      readonly unit: ResultUnit;
      readonly decimals: number | null;
    }[];
    readonly confidenceInterval95?: { readonly low: number; readonly high: number };
    readonly mapPoints: readonly {
      readonly match_id?: string;
      readonly event_id?: number;
      readonly timestamp_ms?: number;
      readonly x_norm: number;
      readonly y_norm: number;
    }[];
    readonly baseline?: {
      readonly value: number;
      readonly differencePoints: number;
      readonly labelKo: string;
    };
    readonly comparison?: ComparisonPayload;
  };
  readonly provenance: {
    readonly grain: string;
    readonly grainLabelKo: string;
    readonly totalMatches: number;
    readonly totalUnits: number;
    readonly matchedMatches: number;
    readonly matchedUnits: number;
    readonly denominatorKo: string;
    readonly conditions: readonly {
      readonly id: string;
      readonly dsl: string;
      readonly labelKo: string;
      readonly matchedAlone: number;
      readonly matchedCumulative?: number;
    }[];
    readonly excluded: readonly { readonly reasonKo: string; readonly count: number }[];
    readonly measureCoverage: readonly {
      readonly measureId: string;
      readonly labelKo: string;
      readonly defined: number;
      readonly eligible: number;
      readonly ratio: number;
    }[];
    readonly dataset: {
      readonly snapshotId: string | null;
      readonly filters: Record<string, unknown>;
      readonly matchCount: number;
    };
    readonly drilldown: { readonly token: string; readonly expiresAt: string | null };
    readonly biasAudit?: BiasAudit;
  };
  readonly caveats: readonly { readonly code: string; readonly messageKo: string }[];
  readonly viz: {
    readonly primary: string;
    readonly alternatives: readonly string[];
    readonly reasonKo: string;
  };
  readonly timing: {
    readonly compileMs: number;
    readonly executeMs: number;
    readonly cacheHit: boolean;
    readonly engineVersion: string;
  };
}

export interface ProgressEvent {
  readonly phase:
    'compiling' | 'planning' | 'running' | 'materializing' | 'completed' | 'failed' | 'cancelled';
  readonly result?: AnalysisResponse;
  readonly diagnostic?: {
    readonly code: string;
    readonly titleKo: string;
    readonly bodyKo: string;
  };
}

export interface MatchedMatch {
  readonly match_id: string;
  readonly team_id?: number;
  readonly arm?: string;
}

export interface MatchDetail {
  readonly match: Record<string, unknown> | null;
  readonly participants: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
  readonly teamFrames: readonly Record<string, unknown>[];
  readonly matchReason: {
    readonly summaryKo: string;
    readonly conditions: readonly {
      readonly id: string;
      readonly dsl: string;
      readonly labelKo: string;
      readonly witnesses: readonly {
        readonly event_id: number;
        readonly timestamp_ms: number;
        readonly event_type?: string;
      }[];
    }[];
  };
}

export interface EffectiveEventDefinition {
  readonly id: string;
  readonly labelKo: string;
  readonly descriptionKo: string;
  readonly available: boolean;
  readonly unavailableReasonKo?: string;
  readonly atMostOncePerMatch: boolean;
  readonly context: readonly string[];
  readonly sqlBinding?: {
    readonly table: string;
    readonly where: string;
    readonly columns: readonly string[];
  };
  readonly aliases?: Readonly<Record<string, { readonly ordinal: 'first' | 'last' }>>;
  readonly rank: number;
}

export interface EffectiveContextDefinition {
  readonly id: string;
  readonly labelKo: string;
  readonly descriptionKo: string;
  readonly type: string;
  readonly temporality: string;
  readonly sql?:
    | string
    | {
        readonly xNorm: string;
        readonly yNorm: string;
        readonly xRaw: string;
        readonly yRaw: string;
      };
  readonly rank: number;
}

export type EffectiveRegionShape =
  | { readonly kind: 'polygon'; readonly points: readonly (readonly [number, number])[] }
  | {
      readonly kind: 'rect';
      readonly x0: number;
      readonly y0: number;
      readonly x1: number;
      readonly y1: number;
    }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
  | { readonly kind: 'multi'; readonly parts: readonly EffectiveRegionShape[] };

export interface EffectiveMapRegion {
  readonly id: string;
  readonly label: string;
  readonly origin: 'preset' | 'user';
  readonly coordSpace: 'norm-v1';
  readonly shape: EffectiveRegionShape;
}

export interface EffectiveDslConstructCapability {
  readonly id: string;
  readonly syntax: readonly string[];
  readonly parser: boolean;
  readonly engine: boolean;
  readonly visualBuilder: 'full' | 'partial' | 'none';
  readonly aiGenerate: boolean;
  readonly constraints: readonly string[];
}

export interface EffectiveDslLanguage {
  readonly version: string;
  readonly ebnf: readonly string[];
  readonly precedence: readonly {
    readonly level: number;
    readonly associativity: 'left' | 'right' | 'none';
    readonly operators: readonly string[];
  }[];
  readonly constructs: readonly EffectiveDslConstructCapability[];
  readonly generationRules: readonly string[];
}

export interface EffectiveCatalog {
  readonly catalogVersion: string;
  readonly hash: string;
  readonly baseCatalogHash?: string;
  readonly map: { readonly min: number; readonly span: number };
  readonly events: Readonly<Record<string, EffectiveEventDefinition>>;
  readonly contextFields: Readonly<Record<string, EffectiveContextDefinition>>;
  readonly tables?: Readonly<Record<string, unknown>>;
  readonly grains: Readonly<Record<string, unknown>>;
  readonly entities: Readonly<Record<string, unknown>>;
  readonly landmarks: Readonly<Record<string, unknown>>;
  readonly functions: Readonly<Record<string, unknown>>;
  readonly groupKeys: Readonly<Record<string, unknown>>;
  readonly dslLanguage: EffectiveDslLanguage;
  readonly diagnostics: Readonly<Record<string, unknown>>;
  readonly forbiddenPhrases: readonly string[];
  readonly referencedColumns?: Readonly<Record<string, readonly string[]>>;
  readonly datasetSnapshotId: string | null;
  readonly mapRegions: readonly EffectiveMapRegion[];
  readonly champions: readonly { readonly id: number; readonly name: string }[];
  /** Item IDs observed in purchase events; the web app resolves localized display names. */
  readonly items: readonly { readonly id: number; readonly name?: string }[];
  readonly patches: readonly string[];
  readonly queues: readonly string[];
  readonly tiers: readonly string[];
  readonly platformRegions: readonly string[];
  readonly datasetSource: string | null;
  readonly instanceCapabilities: {
    readonly publicInstance: boolean;
    readonly ai: boolean;
    readonly dataSourceManagement: boolean;
    readonly matchDrilldown: boolean;
    readonly diagnostics: boolean;
  };
  readonly sourceCapabilities: {
    readonly events: Readonly<
      Record<string, { readonly available: false; readonly reasonKo: string }>
    >;
    readonly contexts: Readonly<
      Record<
        string,
        Readonly<Record<string, { readonly available: false; readonly reasonKo: string }>>
      >
    >;
  };
}

export interface AiStatus {
  readonly enabled: boolean;
  readonly model: string;
  readonly provider: 'OpenRouter';
  readonly persistent: boolean;
  readonly sessionConfigured: boolean;
}

export interface DataSourceSummary {
  readonly id: string;
  readonly name: string;
  readonly provider: 'local' | 's3' | 'gcs';
  readonly uri: string;
  readonly authMode: 'local' | 'access_key' | 'anonymous';
  readonly region: string | null;
  readonly snapshotId: string | null;
  readonly datasetSource: string | null;
  readonly matchCount: number;
  readonly tables: readonly string[];
  readonly connectedAt: string | null;
  readonly active: boolean;
  readonly persistent: boolean;
}

export interface DataSourceConnectionInput {
  readonly name: string;
  readonly provider: 's3' | 'gcs';
  readonly uri: string;
  readonly authMode: 'access_key' | 'anonymous';
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly sessionToken?: string;
  readonly region?: string;
}

export interface AnalysisDatasetFilters {
  readonly patch?: string;
  readonly queue?: string;
  readonly tier?: string;
  readonly region?: string;
  readonly excludeRemakes?: boolean;
}

export interface AiDslDraft {
  readonly dsl: string;
  readonly titleKo: string;
  readonly explanationKo: string;
}

export interface AiInterpretation {
  readonly summaryKo: string;
  readonly findingsKo: readonly string[];
  readonly cautionsKo: readonly string[];
}

export interface AnalysisApiErrorDetail {
  readonly code?: string;
  readonly messageKo?: string;
  readonly [key: string]: unknown;
}

export class AnalysisApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly detail: string | AnalysisApiErrorDetail | null,
    message: string,
  ) {
    super(message);
    this.name = 'AnalysisApiError';
  }
}

export type EventSourceLike = Pick<
  EventSource,
  'addEventListener' | 'removeEventListener' | 'close'
>;

export type AnalysisSubscriptionErrorCode = 'invalid-message' | 'connection-error';

export class AnalysisSubscriptionError extends Error {
  constructor(
    readonly code: AnalysisSubscriptionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AnalysisSubscriptionError';
  }
}

export interface AnalysisSubscriptionOptions {
  readonly onError?: (error: AnalysisSubscriptionError) => void;
}

const TERMINAL_PHASES = new Set<ProgressEvent['phase']>(['completed', 'failed', 'cancelled']);

function isProgressEvent(value: unknown): value is ProgressEvent {
  if (typeof value !== 'object' || value === null || !('phase' in value)) return false;
  return (
    value.phase === 'compiling' ||
    value.phase === 'planning' ||
    value.phase === 'running' ||
    value.phase === 'materializing' ||
    value.phase === 'completed' ||
    value.phase === 'failed' ||
    value.phase === 'cancelled'
  );
}

function compactAnalysisForAi(response: AnalysisResponse): Record<string, unknown> {
  const rows = response.result.rows.slice(0, 50).map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .slice(0, 32)
        .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 1_000) : value]),
    ),
  );
  return {
    result: {
      type: response.result.type,
      columns: response.result.columns.slice(0, 32),
      rows,
      measures: response.result.measures.slice(0, 20),
      confidenceInterval95: response.result.confidenceInterval95,
      baseline: response.result.baseline,
      comparison: response.result.comparison,
    },
    provenance: {
      grain: response.provenance.grain,
      grainLabelKo: response.provenance.grainLabelKo,
      totalMatches: response.provenance.totalMatches,
      totalUnits: response.provenance.totalUnits,
      matchedMatches: response.provenance.matchedMatches,
      matchedUnits: response.provenance.matchedUnits,
      denominatorKo: response.provenance.denominatorKo,
      conditions: response.provenance.conditions.slice(0, 20),
      excluded: response.provenance.excluded.slice(0, 20),
      measureCoverage: response.provenance.measureCoverage.slice(0, 20),
      dataset: response.provenance.dataset,
      biasAudit: response.provenance.biasAudit,
    },
    caveats: response.caveats.slice(0, 20),
  };
}

export class AnalysisClient {
  constructor(
    private readonly baseUrl = '/api/v1',
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly makeEventSource: (url: string) => EventSourceLike = (url) =>
      new EventSource(url),
  ) {}

  async run(input: {
    ast: unknown;
    regions?: Record<string, unknown>;
    catalogHash: string;
    dataset?: AnalysisDatasetFilters;
  }): Promise<string> {
    const response = await this.fetcher(`${this.baseUrl}/analyses/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await this.error(response);
    return ((await response.json()) as { runId: string }).runId;
  }

  async biasAudit(input: {
    ast: unknown;
    regions?: Record<string, unknown>;
    catalogHash: string;
    dataset?: AnalysisDatasetFilters;
  }): Promise<BiasAudit> {
    const response = await this.fetcher(`${this.baseUrl}/analyses/bias-audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<BiasAudit>;
  }

  async catalog(): Promise<EffectiveCatalog> {
    const response = await this.fetcher(`${this.baseUrl}/catalog`);
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<EffectiveCatalog>;
  }

  async aiStatus(): Promise<AiStatus> {
    const response = await this.fetcher(`${this.baseUrl}/ai/status`);
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<AiStatus>;
  }

  async dataSources(): Promise<{ items: readonly DataSourceSummary[]; activeId: string }> {
    const response = await this.fetcher(`${this.baseUrl}/data-sources`);
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<{
      items: readonly DataSourceSummary[];
      activeId: string;
    }>;
  }

  async connectDataSource(input: DataSourceConnectionInput): Promise<DataSourceSummary> {
    const response = await this.fetcher(`${this.baseUrl}/data-sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        provider: input.provider,
        uri: input.uri,
        auth_mode: input.authMode,
        access_key_id: input.accessKeyId || null,
        secret_access_key: input.secretAccessKey || null,
        session_token: input.sessionToken || null,
        region: input.region || null,
      }),
    });
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<DataSourceSummary>;
  }

  async activateDataSource(id: string): Promise<DataSourceSummary> {
    const response = await this.fetcher(
      `${this.baseUrl}/data-sources/${encodeURIComponent(id)}/active`,
      { method: 'PUT' },
    );
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<DataSourceSummary>;
  }

  async deleteDataSource(id: string): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/data-sources/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await this.error(response);
  }

  async configureAi(apiKey: string): Promise<AiStatus> {
    const response = await this.fetcher(`${this.baseUrl}/ai/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<AiStatus>;
  }

  async clearAiConfiguration(): Promise<AiStatus> {
    const response = await this.fetcher(`${this.baseUrl}/ai/config`, { method: 'DELETE' });
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<AiStatus>;
  }

  async generateDsl(input: {
    question: string;
    currentDsl?: string;
    regions?: readonly { readonly id: string; readonly label: string }[];
  }): Promise<AiDslDraft> {
    const response = await this.fetcher(`${this.baseUrl}/ai/dsl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: input.question,
        current_dsl: input.currentDsl ?? null,
        regions: input.regions ?? [],
      }),
    });
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<AiDslDraft>;
  }

  async interpret(input: {
    dsl: string;
    result: AnalysisResponse;
    datasetSource?: string | null;
  }): Promise<AiInterpretation> {
    const response = await this.fetcher(`${this.baseUrl}/ai/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dsl: input.dsl,
        result: compactAnalysisForAi(input.result),
        dataset_source: input.datasetSource ?? null,
      }),
    });
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<AiInterpretation>;
  }

  subscribe(
    runId: string,
    onEvent: (event: ProgressEvent) => void,
    options: AnalysisSubscriptionOptions = {},
  ): () => void {
    const source = this.makeEventSource(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`);
    let active = true;

    const cleanup = (): void => {
      if (!active) return;
      active = false;
      source.removeEventListener('message', messageListener);
      source.removeEventListener('error', errorListener);
      source.close();
    };

    const reportError = (error: AnalysisSubscriptionError): void => {
      cleanup();
      options.onError?.(error);
    };

    const messageListener = ((message: MessageEvent<string>): void => {
      if (!active) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data) as unknown;
      } catch (cause) {
        reportError(
          new AnalysisSubscriptionError(
            'invalid-message',
            'The analysis server sent malformed progress data.',
            { cause },
          ),
        );
        return;
      }

      if (!isProgressEvent(parsed)) {
        reportError(
          new AnalysisSubscriptionError(
            'invalid-message',
            'The analysis server sent an invalid progress event.',
          ),
        );
        return;
      }

      try {
        onEvent(parsed);
      } finally {
        if (TERMINAL_PHASES.has(parsed.phase)) cleanup();
      }
    }) as EventListener;

    const errorListener = ((event: Event): void => {
      if (!active) return;
      reportError(
        new AnalysisSubscriptionError(
          'connection-error',
          'The analysis progress connection was interrupted.',
          { cause: event },
        ),
      );
    }) as EventListener;

    source.addEventListener('message', messageListener);
    source.addEventListener('error', errorListener);
    return cleanup;
  }

  async cancel(runId: string): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await this.error(response);
  }

  async explain(runId: string): Promise<Record<string, unknown>> {
    const response = await this.fetcher(
      `${this.baseUrl}/runs/${encodeURIComponent(runId)}/explain`,
    );
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<Record<string, unknown>>;
  }

  async matches(
    runId: string,
    cursor = 0,
    limit = 100,
  ): Promise<{ items: readonly MatchedMatch[]; nextCursor: number | null }> {
    const query = new URLSearchParams({ cursor: String(cursor), limit: String(limit) });
    const response = await this.fetcher(
      `${this.baseUrl}/runs/${encodeURIComponent(runId)}/matches?${query}`,
    );
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<{
      items: readonly MatchedMatch[];
      nextCursor: number | null;
    }>;
  }

  async match(runId: string, matchId: string): Promise<MatchDetail> {
    const query = new URLSearchParams({ runId });
    const response = await this.fetcher(
      `${this.baseUrl}/matches/${encodeURIComponent(matchId)}?${query}`,
    );
    if (!response.ok) throw await this.error(response);
    return response.json() as Promise<MatchDetail>;
  }

  private async error(response: Response): Promise<AnalysisApiError> {
    const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = body?.detail;
    if (typeof detail === 'string') {
      return new AnalysisApiError(response.status, undefined, detail, detail);
    }
    if (typeof detail === 'object' && detail !== null) {
      const structured = detail as AnalysisApiErrorDetail;
      const code = typeof structured.code === 'string' ? structured.code : undefined;
      const message =
        typeof structured.messageKo === 'string'
          ? structured.messageKo
          : `분석 서버 오류 (${response.status})`;
      return new AnalysisApiError(response.status, code, structured, message);
    }
    return new AnalysisApiError(
      response.status,
      undefined,
      null,
      `분석 서버 오류 (${response.status})`,
    );
  }
}
