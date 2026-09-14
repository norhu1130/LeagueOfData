import { describe, expect, it } from 'vitest';
import {
  initialMapEditorState,
  mapEditorReducer,
  polygonSelfIntersects,
  validatePolygon,
} from '../src/index.js';

describe('minimap drawing state machine', () => {
  it('saves through idle, drawing, naming, and selected states', () => {
    let state = mapEditorReducer(initialMapEditorState, { type: 'startDrawing' });
    for (const point of [
      [0, 0],
      [1, 0],
      [0, 1],
    ] as const)
      state = mapEditorReducer(state, { type: 'addPoint', point });
    state = mapEditorReducer(state, { type: 'finishDrawing' });
    expect(state.mode).toBe('naming');
    state = mapEditorReducer(state, { type: 'save', id: 'my_top', label: '내 탑 영역' });
    expect(state.mode).toBe('selected');
    expect(state.draft?.id).toBe('my_top');
  });
  it('rejects a self-intersecting polygon', () => {
    const points = [
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
    ] as const;
    expect(polygonSelfIntersects(points)).toBe(true);
  });
  it('rejects collinear overlap between non-adjacent edges', () => {
    const points = [
      [0, 0],
      [1, 0],
      [0.25, 0],
      [0.75, 0],
      [0, 1],
    ] as const;
    expect(polygonSelfIntersects(points)).toBe(true);
  });
  it('rejects an adjacent edge that doubles back over itself', () => {
    expect(
      validatePolygon([
        [0, 0],
        [1, 0],
        [0.5, 0],
        [0.5, 1],
      ]),
    ).toBe('self_intersection');
  });
  it('rejects duplicate vertices', () => {
    expect(
      validatePolygon([
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 0],
      ]),
    ).toBe('duplicate_points');
  });
  it('rejects zero-area polygons', () => {
    expect(
      validatePolygon([
        [0, 0],
        [0.5, 0.5],
        [1, 1],
      ]),
    ).toBe('degenerate');
  });
  it('does not enter naming with fewer than three points', () => {
    const drawing = {
      ...initialMapEditorState,
      mode: 'drawing' as const,
      points: [
        [0, 0],
        [1, 1],
      ] as const,
    };
    const state = mapEditorReducer(drawing, { type: 'finishDrawing' });
    expect(state.mode).toBe('drawing');
    expect(state.warningKo).toContain('3개');
  });
  it('updates a saved polygon by dragging a vertex', () => {
    const region = {
      id: 'mine',
      label: '내 영역',
      origin: 'user' as const,
      coordSpace: 'norm-v1' as const,
      shape: {
        kind: 'polygon' as const,
        points: [
          [0, 0],
          [1, 0],
          [0, 1],
        ] as const,
      },
    };
    let state = mapEditorReducer(initialMapEditorState, { type: 'select', region });
    state = mapEditorReducer(state, { type: 'edit' });
    state = mapEditorReducer(state, { type: 'dragStart', index: 1 });
    state = mapEditorReducer(state, { type: 'movePoint', point: [0.8, 0.2] });
    state = mapEditorReducer(state, { type: 'dragEnd' });
    expect(state.mode).toBe('editing');
    expect(state.points[1]).toEqual([0.8, 0.2]);
    expect(state.draft?.shape).toMatchObject({ kind: 'polygon', points: state.points });
  });
  it('clears polygon editing state when selecting a non-polygon region', () => {
    const polygon = {
      id: 'mine',
      label: '내 영역',
      origin: 'user' as const,
      coordSpace: 'norm-v1' as const,
      shape: {
        kind: 'polygon' as const,
        points: [
          [0, 0],
          [1, 0],
          [0, 1],
        ] as const,
      },
    };
    const rectangle = {
      id: 'top_lane',
      label: '탑 라인',
      origin: 'builtin' as const,
      coordSpace: 'norm-v1' as const,
      shape: { kind: 'rect' as const, x0: 0, y0: 0, x1: 0.2, y1: 0.2 },
    };
    let state = mapEditorReducer(initialMapEditorState, { type: 'select', region: polygon });
    state = mapEditorReducer(state, { type: 'select', region: rectangle });
    expect(state.points).toEqual([]);
    expect(state.draft).toBeNull();
    expect(state.warningKo).toBeNull();
  });
});
