import { describe, expect, it } from 'vitest';
import { parseRoute, routePath, type AppRoute } from './routes.js';

describe('application routes', () => {
  it.each<AppRoute>([
    { kind: 'home' },
    { kind: 'regions' },
    { kind: 'dataSources' },
    { kind: 'settings' },
    { kind: 'analysis', documentId: 'analysis_1', view: 'editor' },
    { kind: 'analysis', documentId: 'analysis 1', view: 'matches' },
    { kind: 'analysis', documentId: 'analysis_1', view: 'matches', matchId: 'KR/123' },
  ])('round-trips $kind routes through URL paths', (route) => {
    expect(parseRoute(routePath(route))).toEqual(route);
  });

  it('falls back to home for malformed or unknown routes', () => {
    expect(parseRoute('/unknown')).toEqual({ kind: 'home' });
    expect(parseRoute('/a/%E0%A4%A')).toEqual({ kind: 'home' });
    expect(parseRoute('/a/doc/unknown')).toEqual({ kind: 'home' });
  });
});
