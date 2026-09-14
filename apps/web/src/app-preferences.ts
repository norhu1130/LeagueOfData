export type ColorTheme = 'light' | 'dark';

const DELETED_REGION_IDS = 'lod-deleted-region-ids';
const STALE_RESULT_DOCUMENTS = 'lod-stale-result-documents';
export const THEME_PREFERENCE = 'lod-color-theme';

export function preferredColorTheme(): ColorTheme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(THEME_PREFERENCE);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function storedIdSet(key: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function setStoredId(key: string, id: string, included: boolean): void {
  const ids = storedIdSet(key);
  if (included) ids.add(id);
  else ids.delete(id);
  localStorage.setItem(key, JSON.stringify([...ids]));
}

export function deletedRegionIds(): Set<string> {
  return storedIdSet(DELETED_REGION_IDS);
}

export function setRegionDeleted(id: string, deleted: boolean): void {
  setStoredId(DELETED_REGION_IDS, id, deleted);
}

export function resultIsStale(documentId: string): boolean {
  return storedIdSet(STALE_RESULT_DOCUMENTS).has(documentId);
}

export function setResultStale(documentId: string, stale: boolean): void {
  setStoredId(STALE_RESULT_DOCUMENTS, documentId, stale);
}
