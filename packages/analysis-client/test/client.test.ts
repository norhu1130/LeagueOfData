import { describe, expect, it, vi } from 'vitest';
import {
  AnalysisApiError,
  AnalysisClient,
  AnalysisSubscriptionError,
  type AnalysisResponse,
  type ComparisonPayload,
  type EventSourceLike,
  type ProgressEvent,
} from '../src/index.js';

class FakeEvents implements EventSourceLike {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  closed = false;
  closeCalls = 0;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }
  close(): void {
    this.closed = true;
    this.closeCalls += 1;
  }
  send(event: ProgressEvent): void {
    this.dispatch('message', { data: JSON.stringify(event) } as MessageEvent);
  }
  sendRaw(data: string): void {
    this.dispatch('message', { data } as MessageEvent);
  }
  fail(): void {
    this.dispatch('error', new Event('error'));
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

describe('AnalysisClient', () => {
  it('loads the effective server catalog', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          catalogVersion: '1',
          hash: 'sha256:test',
          datasetSnapshotId: 'snapshot',
          events: {
            kill: { id: 'kill', available: true, context: ['time', 'position'] },
            recall: {
              id: 'recall',
              available: false,
              unavailableReasonKo: 'Unavailable from this source.',
              context: ['time'],
            },
          },
          contextFields: { time: { id: 'time', type: 'time' } },
          patches: ['14.19'],
          queues: ['RANKED_SOLO_5x5'],
          platformRegions: ['KR'],
          sourceCapabilities: {
            events: {
              recall: { available: false, reasonKo: 'Unavailable from this source.' },
            },
            contexts: {
              ward_placed: {
                position: { available: false, reasonKo: 'Position is unavailable.' },
              },
            },
          },
        }),
      ),
    );
    const client = new AnalysisClient('/api/v1', fetcher);
    const catalog = await client.catalog();
    expect(catalog.hash).toBe('sha256:test');
    expect(catalog.events.kill).toMatchObject({ available: true, context: ['time', 'position'] });
    expect(catalog.contextFields.time).toMatchObject({ id: 'time', type: 'time' });
    expect(catalog.sourceCapabilities.contexts.ward_placed?.position).toMatchObject({
      available: false,
    });
  });

  it('connects an object-storage data source without changing credential field names', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'source_1',
          name: 'Matches',
          provider: 's3',
          uri: 's3://bucket/silver',
          authMode: 'access_key',
          active: true,
        }),
        { status: 201 },
      ),
    );
    const client = new AnalysisClient('/api/v1', fetcher);

    await client.connectDataSource({
      name: 'Matches',
      provider: 's3',
      uri: 's3://bucket/silver',
      authMode: 'access_key',
      accessKeyId: 'key-id',
      secretAccessKey: 'secret',
      region: 'ap-northeast-2',
    });

    const init = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      auth_mode: 'access_key',
      access_key_id: 'key-id',
      secret_access_key: 'secret',
      region: 'ap-northeast-2',
    });
  });

  it('models percent and absolute comparisons with distinct difference fields', () => {
    const percent: ComparisonPayload = {
      unit: 'percent',
      groups: [
        {
          id: 'arm0',
          labelKo: '조건',
          value: 0.61,
          n: 100,
          confidenceInterval95: { low: 0.51, high: 0.7 },
        },
      ],
      differencePoints: 19,
    };
    const count: ComparisonPayload = {
      unit: 'count',
      groups: [{ id: 'arm0', labelKo: '조건', value: 30, n: 100 }],
      difference: -70,
    };

    expect(percent.differencePoints).toBe(19);
    expect(count.difference).toBe(-70);
  });

  it('models provenance fields returned by the API', () => {
    const provenance: AnalysisResponse['provenance'] = {
      grain: 'team',
      grainLabelKo: '팀',
      totalMatches: 100,
      totalUnits: 200,
      matchedMatches: 50,
      matchedUnits: 50,
      denominatorKo: '팀-경기',
      conditions: [
        {
          id: 'f0',
          dsl: 'blue.first_blood',
          labelKo: '퍼스트 블러드',
          matchedAlone: 50,
          matchedCumulative: 50,
        },
      ],
      excluded: [{ reasonKo: '10분보다 짧게 끝난 경기', count: 2 }],
      measureCoverage: [{ measureId: 'm0', labelKo: '승률', defined: 50, eligible: 50, ratio: 1 }],
      dataset: { snapshotId: 'snapshot', filters: {}, matchCount: 100 },
      drilldown: { token: 'token', expiresAt: null },
    };

    expect(provenance.conditions[0]?.dsl).toBe('blue.first_blood');
    expect(provenance.excluded[0]?.count).toBe(2);
  });
  it('returns a run ID after submitting an AST', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ runId: 'r1' }), { status: 202 }));
    const client = new AnalysisClient('/api/v1', fetcher);
    await expect(client.run({ ast: { kind: 'Program' }, catalogHash: 'sha256:x' })).resolves.toBe(
      'r1',
    );
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/analyses/run',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('requests a deterministic bias audit without starting a run', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          riskLevel: 'high',
          warnings: [
            {
              code: 'ITEM_POST_OUTCOME',
              severity: 'high',
              titleKo: '아이템 조건에 판정 시점이 없습니다',
              messageKo: '경기 전체 구매 기록입니다.',
              mitigationKo: '동일 시점으로 비교하세요.',
            },
          ],
          limitationsKo: '조건을 자동 변경하지 않았습니다.',
        }),
      ),
    );
    const client = new AnalysisClient('/api/v1', fetcher);

    const audit = await client.biasAudit({
      ast: { kind: 'Program' },
      catalogHash: 'sha256:x',
    });

    expect(audit.riskLevel).toBe('high');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/analyses/bias-audit',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('submits queue and tier dataset filters with the analysis', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ runId: 'r1' }), { status: 202 }));
    const client = new AnalysisClient('/api/v1', fetcher);
    await client.run({
      ast: { kind: 'Program' },
      catalogHash: 'sha256:x',
      dataset: { queue: 'SWIFTPLAY', tier: 'GOLD', excludeRemakes: true },
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, any>;
    expect(body.dataset).toEqual({ queue: 'SWIFTPLAY', tier: 'GOLD', excludeRemakes: true });
  });

  it('uses structured API error codes and localized messages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            code: 'E-SEM-060',
            messageKo: '분석 카탈로그가 바뀌었습니다. 화면을 새로고침해 주세요.',
            catalogHash: 'sha256:new',
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new AnalysisClient('/api/v1', fetcher);

    const error = await client
      .run({ ast: { kind: 'Program' }, catalogHash: 'sha256:old' })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AnalysisApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'E-SEM-060',
      message: '분석 카탈로그가 바뀌었습니다. 화면을 새로고침해 주세요.',
      detail: { catalogHash: 'sha256:new' },
    });
  });

  it('delivers the completion event and closes the connection', () => {
    const source = new FakeEvents();
    const seen: ProgressEvent[] = [];
    const client = new AnalysisClient('/api/v1', fetch, () => source);
    client.subscribe('r1', (event) => seen.push(event));
    source.send({ phase: 'running' });
    source.send({ phase: 'completed' });
    expect(seen.map((event) => event.phase)).toEqual(['running', 'completed']);
    expect(source.closed).toBe(true);
    expect(source.listenerCount('message')).toBe(0);
    expect(source.listenerCount('error')).toBe(0);
  });

  it('reports malformed progress data and closes the connection', () => {
    const source = new FakeEvents();
    const errors: AnalysisSubscriptionError[] = [];
    const client = new AnalysisClient('/api/v1', fetch, () => source);
    client.subscribe('r1', vi.fn(), { onError: (error) => errors.push(error) });

    source.sendRaw('{');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AnalysisSubscriptionError);
    expect(errors[0]?.code).toBe('invalid-message');
    expect(errors[0]?.cause).toBeInstanceOf(SyntaxError);
    expect(source.closed).toBe(true);
    expect(source.listenerCount('message')).toBe(0);
  });

  it('reports invalid progress events and closes the connection', () => {
    const source = new FakeEvents();
    const errors: AnalysisSubscriptionError[] = [];
    const client = new AnalysisClient('/api/v1', fetch, () => source);
    client.subscribe('r1', vi.fn(), { onError: (error) => errors.push(error) });

    source.sendRaw(JSON.stringify({ phase: 'unknown' }));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('invalid-message');
    expect(source.closed).toBe(true);
  });

  it('reports connection errors and closes the connection', () => {
    const source = new FakeEvents();
    const errors: AnalysisSubscriptionError[] = [];
    const client = new AnalysisClient('/api/v1', fetch, () => source);
    client.subscribe('r1', vi.fn(), { onError: (error) => errors.push(error) });

    source.fail();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('connection-error');
    expect(errors[0]?.cause).toBeInstanceOf(Event);
    expect(source.closed).toBe(true);
    expect(source.listenerCount('error')).toBe(0);
  });

  it('makes unsubscribe idempotent and ignores later events', () => {
    const source = new FakeEvents();
    const onEvent = vi.fn();
    const client = new AnalysisClient('/api/v1', fetch, () => source);
    const unsubscribe = client.subscribe('r1', onEvent);

    unsubscribe();
    unsubscribe();
    source.send({ phase: 'running' });

    expect(source.closeCalls).toBe(1);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('passes the cursor and limit to the drill-down match list', async () => {
    let requested = '';
    const client = new AnalysisClient('/api/v1', (async (input) => {
      requested = String(input);
      return new Response(
        JSON.stringify({ items: [{ match_id: 'SYNTH_1', team_id: 100 }], nextCursor: 25 }),
        { status: 200 },
      );
    }) as typeof fetch);
    const result = await client.matches('run id', 5, 20);
    expect(requested).toContain('/runs/run%20id/matches?cursor=5&limit=20');
    expect(result.items[0]?.match_id).toBe('SYNTH_1');
  });

  it('includes the run ID in match-detail requests', async () => {
    let requested = '';
    const client = new AnalysisClient('/api/v1', (async (input) => {
      requested = String(input);
      return new Response(
        JSON.stringify({
          match: { match_id: 'SYN_1' },
          participants: [],
          events: [],
          teamFrames: [],
          matchReason: { summaryKo: '포함됨', conditions: [] },
        }),
        { status: 200 },
      );
    }) as typeof fetch);
    const result = await client.match('run id', 'SYN/1');
    expect(requested).toContain('/matches/SYN%2F1?runId=run+id');
    expect(result.match?.match_id).toBe('SYN_1');
  });

  it('configures OpenRouter without placing the key in the URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          enabled: true,
          model: 'openai/gpt-5.6-luna',
          provider: 'OpenRouter',
          persistent: false,
          sessionConfigured: true,
        }),
      ),
    );
    const client = new AnalysisClient('/api/v1', fetcher);

    await client.configureAi('sk-or-v1-private-key');

    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/ai/config',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ api_key: 'sk-or-v1-private-key' }),
      }),
    );
  });

  it('sends region labels with IDs for natural-language DSL grounding', async () => {
    let body: Record<string, unknown> = {};
    const client = new AnalysisClient('/api/v1', (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          dsl: 'RETURN count()',
          titleKo: '개수',
          explanationKo: '개수입니다.',
          datasetFilters: {
            patch: null,
            queue: null,
            tier: null,
            region: null,
            excludeRemakes: true,
          },
        }),
      );
    }) as typeof fetch);

    await client.generateDsl({
      question: '탑 강가 사용자 영역의 사건 수',
      regions: [{ id: 'custom_top_river', label: '탑 강가 사용자 영역' }],
      championReferences: [{ value: 'Ashe', aliases: ['애쉬'] }],
      itemReferences: [{ id: 3157, aliases: ['존야의 모래시계'] }],
      currentDatasetFilters: { patch: '16.19', excludeRemakes: false },
    });

    expect(body.regions).toEqual([{ id: 'custom_top_river', label: '탑 강가 사용자 영역' }]);
    expect(body.champion_references).toEqual([{ value: 'Ashe', aliases: ['애쉬'] }]);
    expect(body.item_references).toEqual([{ id: 3157, aliases: ['존야의 모래시계'] }]);
    expect(body.current_dataset_filters).toEqual({ patch: '16.19', excludeRemakes: false });
  });

  it('removes map points and limits result rows before requesting AI interpretation', async () => {
    let requestBody: Record<string, unknown> = {};
    const client = new AnalysisClient('/api/v1', (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ summaryKo: '요약', findingsKo: [], cautionsKo: [] }));
    }) as typeof fetch);
    const result = {
      result: {
        type: 'map',
        columns: ['n'],
        rows: Array.from({ length: 80 }, (_, n) => ({ n })),
        measures: [],
        mapPoints: [{ match_id: 'm1', event_id: 1, timestamp_ms: 1, x_norm: 0.5, y_norm: 0.5 }],
      },
      provenance: {
        grain: 'team',
        grainLabelKo: '팀',
        totalMatches: 1,
        totalUnits: 2,
        matchedMatches: 1,
        matchedUnits: 1,
        denominatorKo: '팀-경기',
        conditions: [],
        excluded: [],
        measureCoverage: [],
        dataset: { snapshotId: 's1', filters: {}, matchCount: 1 },
        drilldown: { token: 'token', expiresAt: null },
      },
      caveats: [],
      viz: { primary: 'map', alternatives: [], reasonKo: '위치 결과' },
      timing: { compileMs: 1, executeMs: 1, cacheHit: false, engineVersion: 'test' },
    } as unknown as AnalysisResponse;

    await client.interpret({ dsl: 'ANALYZE team RETURN count()', result });

    const compact = requestBody.result as {
      result: { rows: unknown[]; mapPoints?: unknown[] };
    };
    expect(compact.result.rows).toHaveLength(50);
    expect(compact.result.mapPoints).toBeUndefined();
  });
});
