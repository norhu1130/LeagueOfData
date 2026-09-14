import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deletedRegionIds,
  resultIsStale,
  setRegionDeleted,
  setResultStale,
} from './app-preferences.js';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('app preferences', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records and clears deleted region tombstones', () => {
    setRegionDeleted('river_custom', true);
    expect(deletedRegionIds()).toEqual(new Set(['river_custom']));

    setRegionDeleted('river_custom', false);
    expect(deletedRegionIds()).toEqual(new Set());
  });

  it('records and clears stale result markers', () => {
    setResultStale('analysis_1', true);
    expect(resultIsStale('analysis_1')).toBe(true);

    setResultStale('analysis_1', false);
    expect(resultIsStale('analysis_1')).toBe(false);
  });
});
