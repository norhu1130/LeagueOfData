export type AppRoute =
  | { readonly kind: 'home' }
  | {
      readonly kind: 'analysis';
      readonly documentId: string;
      readonly view: 'editor' | 'matches';
      readonly matchId?: string;
    }
  | { readonly kind: 'regions' }
  | { readonly kind: 'dataSources' }
  | { readonly kind: 'settings' };

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string): AppRoute {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return { kind: 'home' };
  if (parts.length === 1 && parts[0] === 'regions') return { kind: 'regions' };
  if (parts.length === 1 && parts[0] === 'data-sources') return { kind: 'dataSources' };
  if (parts.length === 1 && parts[0] === 'settings') return { kind: 'settings' };
  if (parts[0] === 'a' && parts[1]) {
    const documentId = decoded(parts[1]);
    if (!documentId) return { kind: 'home' };
    if (parts.length === 2) return { kind: 'analysis', documentId, view: 'editor' };
    if (parts[2] === 'matches' && parts.length === 3)
      return { kind: 'analysis', documentId, view: 'matches' };
    if (parts[2] === 'matches' && parts[3] && parts.length === 4) {
      const matchId = decoded(parts[3]);
      if (matchId) return { kind: 'analysis', documentId, view: 'matches', matchId };
    }
  }
  return { kind: 'home' };
}

export function routePath(route: AppRoute): string {
  if (route.kind === 'home') return '/';
  if (route.kind === 'regions') return '/regions';
  if (route.kind === 'dataSources') return '/data-sources';
  if (route.kind === 'settings') return '/settings';
  const base = `/a/${encodeURIComponent(route.documentId)}`;
  if (route.view === 'editor') return base;
  return route.matchId ? `${base}/matches/${encodeURIComponent(route.matchId)}` : `${base}/matches`;
}
