import { describe, expect, it } from 'vitest';
import { fitPanelWidths } from './layout/panel-layout.js';

describe('resizable application panels', () => {
  it('keeps enough workspace width when both desktop side panels are visible', () => {
    const fitted = fitPanelWidths({ sidebar: 420, result: 720 }, 1_200, true);

    expect(fitted.sidebar).toBeGreaterThanOrEqual(160);
    expect(fitted.result).toBeGreaterThanOrEqual(280);
    expect(fitted.sidebar + fitted.result + 560 + 16).toBeLessThanOrEqual(1_200);
  });

  it('clamps persisted widths to supported panel ranges', () => {
    expect(fitPanelWidths({ sidebar: 20, result: 2_000 }, 1_920, true)).toEqual({
      sidebar: 160,
      result: 720,
    });
  });

  it('lets the sidebar use its full range after the result moves below the workspace', () => {
    expect(fitPanelWidths({ sidebar: 420, result: 720 }, 900, true)).toEqual({
      sidebar: 420,
      result: 720,
    });
  });
});
