import type { CSSProperties } from 'react';

export const PANEL_LAYOUT_PREFERENCE = 'lod-panel-layout';
export const DEFAULT_PANEL_WIDTHS = { sidebar: 220, result: 350 } as const;
export const PANEL_WIDTH_LIMITS = {
  sidebar: { min: 160, max: 420 },
  result: { min: 280, max: 720 },
} as const;
export const DESKTOP_RESULT_BREAKPOINT = 1050;
export const MOBILE_BREAKPOINT = 720;
const DESKTOP_WORKSPACE_MIN_WIDTH = 560;
const COMPACT_WORKSPACE_MIN_WIDTH = 320;
const RESIZER_WIDTH = 8;

export type PanelName = keyof typeof DEFAULT_PANEL_WIDTHS;
export type PanelWidths = Record<PanelName, number>;
export type AppShellStyle = CSSProperties & {
  '--sidebar-width': string;
  '--result-width': string;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function preferredPanelWidths(): PanelWidths {
  if (typeof window === 'undefined') return { ...DEFAULT_PANEL_WIDTHS };
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(PANEL_LAYOUT_PREFERENCE) ?? '{}',
    ) as Record<string, unknown>;
    return {
      sidebar:
        typeof stored.sidebar === 'number' && Number.isFinite(stored.sidebar)
          ? clamp(stored.sidebar, PANEL_WIDTH_LIMITS.sidebar.min, PANEL_WIDTH_LIMITS.sidebar.max)
          : DEFAULT_PANEL_WIDTHS.sidebar,
      result:
        typeof stored.result === 'number' && Number.isFinite(stored.result)
          ? clamp(stored.result, PANEL_WIDTH_LIMITS.result.min, PANEL_WIDTH_LIMITS.result.max)
          : DEFAULT_PANEL_WIDTHS.result,
    };
  } catch {
    return { ...DEFAULT_PANEL_WIDTHS };
  }
}

export function maximumPanelWidth(
  panel: PanelName,
  widths: PanelWidths,
  shellWidth: number,
  resultVisible: boolean,
): number {
  const limits = PANEL_WIDTH_LIMITS[panel];
  if (panel === 'result') {
    return Math.min(
      limits.max,
      shellWidth - widths.sidebar - DESKTOP_WORKSPACE_MIN_WIDTH - RESIZER_WIDTH * 2,
    );
  }
  if (resultVisible && shellWidth > DESKTOP_RESULT_BREAKPOINT) {
    return Math.min(
      limits.max,
      shellWidth - widths.result - DESKTOP_WORKSPACE_MIN_WIDTH - RESIZER_WIDTH * 2,
    );
  }
  return Math.min(limits.max, shellWidth - COMPACT_WORKSPACE_MIN_WIDTH - RESIZER_WIDTH);
}

export function fitPanelWidths(
  widths: PanelWidths,
  shellWidth: number,
  resultVisible: boolean,
): PanelWidths {
  let sidebar = clamp(
    widths.sidebar,
    PANEL_WIDTH_LIMITS.sidebar.min,
    PANEL_WIDTH_LIMITS.sidebar.max,
  );
  let result = clamp(widths.result, PANEL_WIDTH_LIMITS.result.min, PANEL_WIDTH_LIMITS.result.max);
  if (shellWidth <= MOBILE_BREAKPOINT) return { sidebar, result };
  if (!resultVisible || shellWidth <= DESKTOP_RESULT_BREAKPOINT) {
    sidebar = clamp(
      sidebar,
      PANEL_WIDTH_LIMITS.sidebar.min,
      maximumPanelWidth('sidebar', { sidebar, result }, shellWidth, resultVisible),
    );
    return { sidebar, result };
  }
  let overflow = sidebar + result - (shellWidth - DESKTOP_WORKSPACE_MIN_WIDTH - RESIZER_WIDTH * 2);
  if (overflow > 0) {
    const resultReduction = Math.min(overflow, result - PANEL_WIDTH_LIMITS.result.min);
    result -= resultReduction;
    overflow -= resultReduction;
    sidebar -= Math.min(overflow, sidebar - PANEL_WIDTH_LIMITS.sidebar.min);
  }
  return { sidebar, result };
}
