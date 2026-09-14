import type { AiChampionReference } from '@lol/analysis-client';
import { useEffect, useMemo, useState } from 'react';
import { latestPatchVersion } from './useItemMetadata.js';

export interface ChampionMetadata {
  readonly value: string;
  readonly localizedName: string | null;
}

function mentions(question: string, name: string): boolean {
  const foldedQuestion = question.toLocaleLowerCase();
  const foldedName = name.toLocaleLowerCase();
  const index = foldedQuestion.indexOf(foldedName);
  if (index < 0) return false;
  if (!/^[a-z0-9_]+$/i.test(name)) return true;
  const before = foldedQuestion[index - 1] ?? '';
  const after = foldedQuestion[index + foldedName.length] ?? '';
  return !/[a-z0-9_]/i.test(before) && !/[a-z0-9_]/i.test(after);
}

export function questionScopedChampionReferences(
  question: string,
  champions: readonly ChampionMetadata[],
): readonly AiChampionReference[] {
  return champions
    .filter(({ value, localizedName }) =>
      [value, localizedName].some((name) => name && mentions(question, name)),
    )
    .slice(0, 32)
    .map(({ value, localizedName }) => ({
      value,
      aliases: localizedName && localizedName !== value ? [localizedName] : [value],
    }));
}

export function useChampionMetadata(
  patches: readonly string[],
  champions: readonly { readonly id: number; readonly name: string }[],
): readonly ChampionMetadata[] {
  const [localizedNames, setLocalizedNames] = useState<Readonly<Record<string, string>>>({});
  const version = latestPatchVersion(patches);

  useEffect(() => {
    if (!version) {
      setLocalizedNames({});
      return;
    }
    const cacheKey = `lod-champion-names-ko-by-id-v2-${version}`;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        setLocalizedNames(JSON.parse(cached) as Record<string, string>);
        return;
      }
    } catch {
      // Browser storage is optional.
    }
    const controller = new AbortController();
    void fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/champion.json`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error('챔피언 이름을 불러오지 못했습니다.');
        return response.json() as Promise<{
          data?: Record<string, { key?: string; name?: string }>;
        }>;
      })
      .then((payload) => {
        const nextNames = Object.fromEntries(
          Object.values(payload.data ?? {}).flatMap((champion) =>
            champion.key && champion.name ? [[champion.key, champion.name] as const] : [],
          ),
        );
        setLocalizedNames(nextNames);
        try {
          localStorage.setItem(cacheKey, JSON.stringify(nextNames));
        } catch {
          // Keep the in-memory names when persistence is unavailable.
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setLocalizedNames({});
      });
    return () => controller.abort();
  }, [version]);

  return useMemo(
    () =>
      champions.map(({ id, name }) => ({
        value: name,
        localizedName: localizedNames[String(id)] ?? null,
      })),
    [champions, localizedNames],
  );
}
