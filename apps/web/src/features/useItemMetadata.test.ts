import { describe, expect, it } from 'vitest';
import { latestPatchVersion } from './useItemMetadata.js';

describe('latestPatchVersion', () => {
  it('selects the newest major and minor patch', () => {
    expect(latestPatchVersion(['15.9', '14.24.2', '15.10.3'])).toBe('15.10.1');
  });

  it('ignores malformed versions and handles an empty list', () => {
    expect(latestPatchVersion(['invalid', '15.x'])).toBeNull();
    expect(latestPatchVersion([])).toBeNull();
  });
});
