import { describe, expect, it } from 'vitest';
import { heatmapSampleLabelKo, moveKeyboardCursor } from './MapPanel.js';

describe('map keyboard interaction helpers', () => {
  it('moves the drawing cursor with normal and large steps', () => {
    expect(moveKeyboardCursor([0.5, 0.5], 'ArrowRight', false)).toEqual([0.51, 0.5]);
    expect(moveKeyboardCursor([0.5, 0.5], 'ArrowUp', true)).toEqual([0.5, 0.55]);
  });

  it('keeps the drawing cursor within normalized map bounds', () => {
    expect(moveKeyboardCursor([0, 1], 'ArrowLeft', false)).toEqual([0, 1]);
    expect(moveKeyboardCursor([0, 1], 'ArrowUp', true)).toEqual([0, 1]);
    expect(moveKeyboardCursor([0.5, 0.5], 'Enter', false)).toBeNull();
  });
});

describe('heatmap sample label', () => {
  it('states that an unknown total reflects only the received sample', () => {
    expect(heatmapSampleLabelKo(736)).toContain('서버 응답에 포함된 표본 기준');
  });

  it('states the displayed and total counts when both are available', () => {
    expect(heatmapSampleLabelKo(5_000, 12_000)).toContain('전체 12,000개 중');
    expect(heatmapSampleLabelKo(5_000, 5_000)).toContain('전체 5,000개 중');
  });
});
