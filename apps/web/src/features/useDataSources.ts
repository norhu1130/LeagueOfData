import type { AnalysisClient, DataSourceSummary, EffectiveCatalog } from '@lol/analysis-client';
import { useCallback, useEffect, useState } from 'react';

export interface DataSourceDraft {
  readonly name: string;
  readonly provider: 's3' | 'gcs';
  readonly uri: string;
  readonly authMode: 'access_key' | 'anonymous';
  readonly accessKey: string;
  readonly secretKey: string;
  readonly sessionToken: string;
  readonly region: string;
}

export function useDataSources({
  client,
  enabled,
  onInvalidate,
  onCatalogChange,
}: {
  client: AnalysisClient;
  enabled: boolean;
  onInvalidate: () => void;
  onCatalogChange: (catalog: EffectiveCatalog) => void;
}) {
  const [sources, setSources] = useState<readonly DataSourceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const response = await client.dataSources();
    setSources(response.items);
  }, [client]);

  const refreshCatalog = useCallback(async () => {
    onCatalogChange(await client.catalog());
  }, [client, onCatalogChange]);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void reload()
      .catch((error) =>
        setMessage(
          error instanceof Error ? error.message : '데이터 소스 목록을 불러오지 못했습니다.',
        ),
      )
      .finally(() => setLoading(false));
  }, [enabled, reload]);

  const connect = useCallback(
    async (draft: DataSourceDraft): Promise<boolean> => {
      setLoading(true);
      setMessage('Parquet 구조와 접근 권한을 확인하는 중…');
      try {
        await client.connectDataSource({
          name: draft.name.trim(),
          provider: draft.provider,
          uri: draft.uri.trim(),
          authMode: draft.authMode,
          ...(draft.authMode === 'access_key'
            ? {
                accessKeyId: draft.accessKey.trim(),
                secretAccessKey: draft.secretKey,
                ...(draft.provider === 's3' && draft.sessionToken.trim()
                  ? { sessionToken: draft.sessionToken }
                  : {}),
              }
            : {}),
          ...(draft.provider === 's3' && draft.region.trim()
            ? { region: draft.region.trim() }
            : {}),
        });
        onInvalidate();
        await Promise.all([reload(), refreshCatalog()]);
        setMessage('연결을 확인했고 이 데이터 소스를 분석에 사용합니다.');
        return true;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '데이터 소스에 연결하지 못했습니다.');
        return false;
      } finally {
        setLoading(false);
      }
    },
    [client, onInvalidate, refreshCatalog, reload],
  );

  const activate = useCallback(
    async (id: string) => {
      setLoading(true);
      setMessage('데이터 소스를 전환하는 중…');
      try {
        await client.activateDataSource(id);
        onInvalidate();
        await Promise.all([reload(), refreshCatalog()]);
        setMessage('분석에 사용할 데이터 소스를 전환했습니다.');
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '데이터 소스를 전환하지 못했습니다.');
      } finally {
        setLoading(false);
      }
    },
    [client, onInvalidate, refreshCatalog, reload],
  );

  const remove = useCallback(
    async (source: DataSourceSummary) => {
      if (!window.confirm(`${source.name} 연결을 제거할까요? 원격 데이터는 삭제되지 않습니다.`))
        return;
      setLoading(true);
      try {
        await client.deleteDataSource(source.id);
        if (source.active) {
          onInvalidate();
          await refreshCatalog();
        }
        await reload();
        setMessage('연결 정보만 제거했습니다. 버킷의 데이터는 변경하지 않았습니다.');
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '연결을 제거하지 못했습니다.');
      } finally {
        setLoading(false);
      }
    },
    [client, onInvalidate, refreshCatalog, reload],
  );

  return { sources, loading, message, connect, activate, remove, reload };
}
