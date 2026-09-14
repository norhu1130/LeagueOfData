import { applyDslEdit, createSyncDocument, type SyncDocument } from '@lol/visual-builder';
import type { StoredAnalysis } from './storage.js';

export function restoreStoredDocument(saved: StoredAnalysis): SyncDocument {
  return applyDslEdit(createSyncDocument(saved.ast), saved.dsl);
}
