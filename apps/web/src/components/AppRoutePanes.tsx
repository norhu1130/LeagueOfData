import type { AiStatus, DataSourceSummary } from '@lol/analysis-client';
import { useState } from 'react';
import type { DataSourceDraft } from '../features/useDataSources.js';

export interface ExampleSummary {
  readonly id: string;
  readonly title: string;
}

export function HomePane({
  examples,
  syntheticDataset,
  catalogReady,
  onOpenExample,
  onNewAnalysis,
}: {
  examples: readonly ExampleSummary[];
  syntheticDataset: boolean;
  catalogReady: boolean;
  onOpenExample: (id: string) => void;
  onNewAnalysis: () => void;
}) {
  return (
    <section className="onboarding-home">
      <span className="eyebrow">START HERE</span>
      <h1>질문을 고르면 분석 카드와 결과를 함께 보여드려요</h1>
      <p>
        예제로 흐름을 익히거나 새 분석에서 조건 카드를 직접 조립하세요. 모든 분석은 DSL로 확인하고
        다시 편집할 수 있습니다.
      </p>
      {syntheticDataset && (
        <div className="synthetic-notice" role="status">
          <b>현재 합성 데이터 사용 중</b>
          <span>기능 확인용으로 생성된 경기이며 실제 Riot 경기 통계가 아닙니다.</span>
        </div>
      )}
      <div className="onboarding-grid">
        {examples.map((example) => (
          <button
            key={example.id}
            disabled={!catalogReady}
            onClick={() => onOpenExample(example.id)}
          >
            <small>예제 {example.id.toUpperCase()}</small>
            <b>{example.title}</b>
            <span>완성된 카드와 결과 열기 →</span>
          </button>
        ))}
      </div>
      <button className="onboarding-blank" onClick={onNewAnalysis}>
        빈 분석으로 시작하기
      </button>
    </section>
  );
}

export function SettingsPane({
  catalogOnline,
  eventCount,
  aiStatus,
  aiKey,
  message,
  onAiKeyChange,
  onConfigureAi,
  onClearAi,
}: {
  catalogOnline: boolean;
  eventCount: number;
  aiStatus: AiStatus | null;
  aiKey: string;
  message: string | null;
  onAiKeyChange: (value: string) => void;
  onConfigureAi: () => void;
  onClearAi: () => void;
}) {
  return (
    <section className="settings-pane">
      <span className="eyebrow">SETTINGS</span>
      <h1>로컬 분석 환경</h1>
      <p>
        분석 API 카탈로그: {catalogOnline ? '연결됨' : '정적 카탈로그 사용 중'} · 사용 가능한 사건{' '}
        {eventCount}개
      </p>
      <p>분석 문서는 이 브라우저에, 매치 데이터는 로컬 분석 서버에 저장됩니다.</p>
      <section className="ai-settings-card" aria-labelledby="ai-settings-title">
        <div>
          <span className="eyebrow">OPTIONAL AI</span>
          <h2 id="ai-settings-title">OpenRouter 연결</h2>
          <p>
            결과 해석과 자연어 DSL 생성을 활성화합니다. 키는 로컬 API 프로세스 메모리에만 보관되며
            브라우저에는 저장되지 않습니다.
          </p>
        </div>
        <div className="ai-status-row">
          <b>{aiStatus?.enabled ? 'AI 활성화됨' : 'AI 비활성화'}</b>
          <span>
            {aiStatus?.model ?? 'openai/gpt-5.6-luna'}
            {aiStatus?.persistent ? ' · 환경 변수' : ''}
          </span>
        </div>
        <form
          className="ai-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            onConfigureAi();
          }}
        >
          <label>
            <span>OpenRouter API 키</span>
            <input
              type="password"
              aria-label="OpenRouter API 키"
              autoComplete="off"
              placeholder="sk-or-v1-…"
              value={aiKey}
              onChange={(event) => onAiKeyChange(event.target.value)}
            />
          </label>
          <button type="submit" disabled={aiKey.trim().length < 16}>
            키 연결
          </button>
          {aiStatus?.sessionConfigured && (
            <button type="button" onClick={onClearAi}>
              세션 키 제거
            </button>
          )}
        </form>
        <small>
          재시작 후에도 사용하려면 서버의 `.env`에 `LOD_OPENROUTER_API_KEY`를 설정하세요.
        </small>
        {message && <p role="status">{message}</p>}
      </section>
    </section>
  );
}

type Provider = 's3' | 'gcs';
type AuthMode = 'access_key' | 'anonymous';

export function DataSourcesPane({
  sources,
  loading,
  message,
  onConnect,
  onActivate,
  onRemove,
}: {
  sources: readonly DataSourceSummary[];
  loading: boolean;
  message: string | null;
  onConnect: (draft: DataSourceDraft) => Promise<boolean>;
  onActivate: (id: string) => void;
  onRemove: (source: DataSourceSummary) => void;
}) {
  const [draft, setDraft] = useState<DataSourceDraft>({
    name: '',
    provider: 's3',
    uri: '',
    authMode: 'access_key',
    accessKey: '',
    secretKey: '',
    sessionToken: '',
    region: 'ap-northeast-2',
  });
  const updateDraft = (patch: Partial<DataSourceDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const setProvider = (nextProvider: Provider) => {
    updateDraft({ provider: nextProvider, uri: '' });
  };

  return (
    <section className="data-sources-pane">
      <span className="eyebrow">DATA SOURCES</span>
      <div className="data-sources-heading">
        <div>
          <h1>데이터 소스</h1>
          <p>S3 또는 GCS의 표준 Parquet 데이터셋을 DuckDB에 직접 연결합니다.</p>
        </div>
        <span>{sources.some((source) => source.active) ? '연결됨' : '확인 중'}</span>
      </div>

      <div className="data-source-list" aria-label="등록된 데이터 소스">
        {sources.map((source) => (
          <article
            className={`data-source-card${source.active ? ' data-source-card--active' : ''}`}
            key={source.id}
          >
            <div className="data-source-card-heading">
              <span className="data-source-provider">{source.provider.toUpperCase()}</span>
              {source.active && <b>현재 사용 중</b>}
            </div>
            <h2>{source.name}</h2>
            <code title={source.uri}>{source.uri}</code>
            <dl>
              <div>
                <dt>경기</dt>
                <dd>{source.matchCount.toLocaleString('ko-KR')}개</dd>
              </div>
              <div>
                <dt>테이블</dt>
                <dd>{source.tables.length}개</dd>
              </div>
              <div>
                <dt>스냅샷</dt>
                <dd>{source.snapshotId?.replace('sha256:', '').slice(0, 12) ?? '없음'}</dd>
              </div>
            </dl>
            <div className="data-source-actions">
              {!source.active && (
                <button disabled={loading} onClick={() => onActivate(source.id)}>
                  이 데이터 사용
                </button>
              )}
              {source.provider !== 'local' && (
                <button
                  className="danger-button"
                  disabled={loading}
                  onClick={() => onRemove(source)}
                >
                  연결 제거
                </button>
              )}
            </div>
          </article>
        ))}
        {!sources.length && !loading && <p>등록된 데이터 소스를 불러오지 못했습니다.</p>}
      </div>

      <section className="data-source-add" aria-labelledby="data-source-add-title">
        <span className="eyebrow">ADD SOURCE</span>
        <h2 id="data-source-add-title">새 데이터 소스 연결</h2>
        <p>
          루트에는 <code>_manifest.json</code>과 matches, participants, teams, events 등의 표준
          폴더가 있어야 합니다.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onConnect(draft).then((connected) => {
              if (connected) updateDraft({ accessKey: '', secretKey: '', sessionToken: '' });
            });
          }}
        >
          <div className="source-provider-switch" role="group" aria-label="스토리지 제공자">
            <button
              type="button"
              aria-pressed={draft.provider === 's3'}
              onClick={() => setProvider('s3')}
            >
              Amazon S3
            </button>
            <button
              type="button"
              aria-pressed={draft.provider === 'gcs'}
              onClick={() => setProvider('gcs')}
            >
              Google Cloud Storage
            </button>
          </div>
          <div className="data-source-fields">
            <label>
              <span>표시 이름</span>
              <input
                required
                maxLength={80}
                placeholder="프로덕션 매치 데이터"
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
              />
            </label>
            <label>
              <span>데이터셋 루트</span>
              <input
                required
                placeholder={
                  draft.provider === 's3' ? 's3://bucket/lol/silver' : 'gs://bucket/lol/silver'
                }
                value={draft.uri}
                onChange={(event) => updateDraft({ uri: event.target.value })}
              />
            </label>
            {draft.provider === 's3' && (
              <label>
                <span>AWS 리전</span>
                <input
                  required
                  placeholder="ap-northeast-2"
                  value={draft.region}
                  onChange={(event) => updateDraft({ region: event.target.value })}
                />
              </label>
            )}
            <label>
              <span>인증 방식</span>
              <select
                value={draft.authMode}
                onChange={(event) => updateDraft({ authMode: event.target.value as AuthMode })}
              >
                <option value="access_key">
                  {draft.provider === 'gcs' ? 'GCS HMAC 키' : '액세스 키'}
                </option>
                <option value="anonymous">공개 버킷</option>
              </select>
            </label>
            {draft.authMode === 'access_key' && (
              <>
                <label>
                  <span>{draft.provider === 'gcs' ? 'HMAC Access ID' : 'Access Key ID'}</span>
                  <input
                    required
                    autoComplete="off"
                    value={draft.accessKey}
                    onChange={(event) => updateDraft({ accessKey: event.target.value })}
                  />
                </label>
                <label>
                  <span>{draft.provider === 'gcs' ? 'HMAC Secret' : 'Secret Access Key'}</span>
                  <input
                    required
                    type="password"
                    autoComplete="off"
                    value={draft.secretKey}
                    onChange={(event) => updateDraft({ secretKey: event.target.value })}
                  />
                </label>
                {draft.provider === 's3' && (
                  <label>
                    <span>
                      Session Token <small>선택</small>
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      value={draft.sessionToken}
                      onChange={(event) => updateDraft({ sessionToken: event.target.value })}
                    />
                  </label>
                )}
              </>
            )}
          </div>
          <div className="data-source-submit">
            <button type="submit" disabled={loading || !draft.name.trim() || !draft.uri.trim()}>
              {loading ? '확인 중…' : '연결 확인 후 사용'}
            </button>
            <small>키는 API 프로세스 메모리에만 보관되며 서버 재시작 시 제거됩니다.</small>
          </div>
        </form>
        {message && (
          <p className="data-source-message" role="status">
            {message}
          </p>
        )}
      </section>
    </section>
  );
}
