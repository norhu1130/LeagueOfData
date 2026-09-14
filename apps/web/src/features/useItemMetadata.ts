import { useEffect, useMemo, useState } from 'react';
import type { AiItemReference } from '@lol/analysis-client';
import type { ItemOption } from './analysis-types.js';

export function latestPatchVersion(patches: readonly string[]): string | null {
  const versions = patches
    .map((patch) => patch.split('.').map(Number))
    .filter((parts) => parts.length >= 2 && parts.every(Number.isFinite));
  versions.sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0) || (b[1] ?? 0) - (a[1] ?? 0));
  const latest = versions[0];
  return latest ? `${latest[0]}.${latest[1]}.1` : null;
}

export function questionScopedItemReferences(
  question: string,
  items: readonly ItemOption[],
): readonly AiItemReference[] {
  const folded = question.toLocaleLowerCase();
  return items
    .filter(({ id, name, aliases }) =>
      name.startsWith('아이템 #')
        ? question.includes(String(id))
        : [name, ...(aliases ?? [])].some((alias) => folded.includes(alias.toLocaleLowerCase())),
    )
    .slice(0, 32)
    .map(({ id, name, aliases }) => ({ id, aliases: [name, ...(aliases ?? [])].slice(0, 8) }));
}

export function useItemMetadata(
  patches: readonly string[],
  items: readonly { readonly id: number }[],
): readonly ItemOption[] {
  const [metadata, setMetadata] = useState<
    Readonly<Record<string, { readonly name: string; readonly aliases: readonly string[] }>>
  >({});
  const version = latestPatchVersion(patches);

  useEffect(() => {
    if (!version) {
      setMetadata({});
      return;
    }
    const cacheKey = `lod-item-metadata-ko-v2-${version}`;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        setMetadata(
          JSON.parse(cached) as Record<string, { name: string; aliases: readonly string[] }>,
        );
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
        return response.json() as Promise<{
          data?: Record<string, { name?: string; colloq?: string }>;
        }>;
      })
      .then((payload) => {
        const nextNames = Object.fromEntries(
          Object.entries(payload.data ?? {}).flatMap(([id, item]) =>
            item.name
              ? [
                  [
                    id,
                    {
                      name: item.name,
                      aliases: (item.colloq ?? '')
                        .split(';')
                        .map((alias) => alias.trim())
                        .filter((alias) => alias.length >= 2 && alias !== item.name),
                    },
                  ] as const,
                ]
              : [],
          ),
        );
        setMetadata(nextNames);
        try {
          localStorage.setItem(cacheKey, JSON.stringify(nextNames));
        } catch {
          // Keep the in-memory names when persistence is unavailable.
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setMetadata({});
      });
    return () => controller.abort();
  }, [version]);

  return useMemo(
    () =>
      [...items]
        .map((item) => ({
          id: item.id,
          name: metadata[String(item.id)]?.name ?? `아이템 #${item.id}`,
          aliases: metadata[String(item.id)]?.aliases ?? [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    [items, metadata],
  );
}
