import { useEffect, useMemo, useState } from 'react';
import type { ItemOption } from './analysis-types.js';

export function latestPatchVersion(patches: readonly string[]): string | null {
  const versions = patches
    .map((patch) => patch.split('.').map(Number))
    .filter((parts) => parts.length >= 2 && parts.every(Number.isFinite));
  versions.sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0) || (b[1] ?? 0) - (a[1] ?? 0));
  const latest = versions[0];
  return latest ? `${latest[0]}.${latest[1]}.1` : null;
}

export function useItemMetadata(
  patches: readonly string[],
  items: readonly { readonly id: number }[],
): readonly ItemOption[] {
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});
  const version = latestPatchVersion(patches);

  useEffect(() => {
    if (!version) {
      setNames({});
      return;
    }
    const cacheKey = `lod-item-names-ko-${version}`;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        setNames(JSON.parse(cached) as Record<string, string>);
        return;
      }
    } catch {
      // Browser storage is optional; fetching still keeps the picker usable.
    }
    const controller = new AbortController();
    void fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/item.json`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error('아이템 이름을 불러오지 못했습니다.');
        return response.json() as Promise<{ data?: Record<string, { name?: string }> }>;
      })
      .then((payload) => {
        const nextNames = Object.fromEntries(
          Object.entries(payload.data ?? {}).flatMap(([id, item]) =>
            item.name ? [[id, item.name] as const] : [],
          ),
        );
        setNames(nextNames);
        try {
          localStorage.setItem(cacheKey, JSON.stringify(nextNames));
        } catch {
          // Keep the in-memory names when persistence is unavailable.
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setNames({});
      });
    return () => controller.abort();
  }, [version]);

  return useMemo(
    () =>
      [...items]
        .map((item) => ({ id: item.id, name: names[String(item.id)] ?? `아이템 #${item.id}` }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    [items, names],
  );
}
