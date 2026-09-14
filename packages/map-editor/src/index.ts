import { REGION_COORD_SPACE, type NormXY, type RegionDefinition } from '@lol/data-model';

export type MapEditorMode = 'idle' | 'drawing' | 'naming' | 'selected' | 'editing' | 'dragging';
export type PolygonValidationError =
  'too_few_points' | 'duplicate_points' | 'degenerate' | 'self_intersection';
export interface MapEditorState {
  readonly mode: MapEditorMode;
  readonly points: readonly NormXY[];
  readonly selectedId: string | null;
  readonly draft: RegionDefinition | null;
  readonly draggingIndex: number | null;
  readonly warningKo: string | null;
}
export type MapEditorAction =
  | { type: 'startDrawing' }
  | { type: 'addPoint'; point: NormXY }
  | { type: 'finishDrawing' }
  | { type: 'save'; id: string; label: string }
  | { type: 'select'; region: RegionDefinition }
  | { type: 'edit' }
  | { type: 'dragStart'; index: number }
  | { type: 'movePoint'; point: NormXY }
  | { type: 'dragEnd' }
  | { type: 'cancel' };

export const initialMapEditorState: MapEditorState = {
  mode: 'idle',
  points: [],
  selectedId: null,
  draft: null,
  draggingIndex: null,
  warningKo: null,
};

export function mapEditorReducer(state: MapEditorState, action: MapEditorAction): MapEditorState {
  switch (action.type) {
    case 'startDrawing':
      return { ...initialMapEditorState, mode: 'drawing' };
    case 'addPoint':
      return state.mode === 'drawing'
        ? { ...state, points: [...state.points, action.point] }
        : state;
    case 'finishDrawing': {
      if (state.mode !== 'drawing') return state;
      const validationError = validatePolygon(state.points);
      if (validationError)
        return { ...state, warningKo: polygonValidationMessageKo(validationError) };
      return { ...state, mode: 'naming', warningKo: null };
    }
    case 'save': {
      if (state.mode !== 'naming' || !/^[a-z][a-z0-9_]*$/.test(action.id) || !action.label.trim())
        return { ...state, warningKo: '영문 id와 영역 이름이 필요합니다.' };
      const draft: RegionDefinition = {
        id: action.id,
        label: action.label.trim(),
        origin: 'user',
        coordSpace: REGION_COORD_SPACE,
        shape: { kind: 'polygon', points: state.points },
        createdAt: new Date().toISOString(),
      };
      return { ...state, mode: 'selected', selectedId: action.id, draft, warningKo: null };
    }
    case 'select':
      return action.region.shape.kind === 'polygon'
        ? {
            ...state,
            mode: 'selected',
            selectedId: action.region.id,
            points: action.region.shape.points,
            draft: action.region,
            draggingIndex: null,
            warningKo: null,
          }
        : {
            ...state,
            mode: 'selected',
            selectedId: action.region.id,
            points: [],
            draft: null,
            draggingIndex: null,
            warningKo: null,
          };
    case 'edit':
      return state.selectedId ? { ...state, mode: 'editing' } : state;
    case 'dragStart':
      return state.mode === 'editing' && action.index >= 0 && action.index < state.points.length
        ? { ...state, mode: 'dragging', draggingIndex: action.index }
        : state;
    case 'movePoint': {
      if (state.mode !== 'dragging' || state.draggingIndex === null) return state;
      const points = [...state.points];
      points[state.draggingIndex] = action.point;
      const draft =
        state.draft?.shape.kind === 'polygon'
          ? { ...state.draft, shape: { kind: 'polygon' as const, points } }
          : state.draft;
      return {
        ...state,
        points,
        draft,
        warningKo: polygonWarningKo(points),
      };
    }
    case 'dragEnd':
      return state.mode === 'dragging' ? { ...state, mode: 'editing', draggingIndex: null } : state;
    case 'cancel':
      return initialMapEditorState;
  }
}

const GEOMETRY_EPSILON = 1e-9;

function samePoint(a: NormXY, b: NormXY): boolean {
  return Math.abs(a[0] - b[0]) <= GEOMETRY_EPSILON && Math.abs(a[1] - b[1]) <= GEOMETRY_EPSILON;
}

function orientation(a: NormXY, b: NormXY, c: NormXY): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: NormXY, b: NormXY, point: NormXY): boolean {
  return (
    Math.abs(orientation(a, b, point)) <= GEOMETRY_EPSILON &&
    point[0] >= Math.min(a[0], b[0]) - GEOMETRY_EPSILON &&
    point[0] <= Math.max(a[0], b[0]) + GEOMETRY_EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - GEOMETRY_EPSILON &&
    point[1] <= Math.max(a[1], b[1]) + GEOMETRY_EPSILON
  );
}

function intersects(a: NormXY, b: NormXY, c: NormXY, d: NormXY): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (
    ((o1 > GEOMETRY_EPSILON && o2 < -GEOMETRY_EPSILON) ||
      (o1 < -GEOMETRY_EPSILON && o2 > GEOMETRY_EPSILON)) &&
    ((o3 > GEOMETRY_EPSILON && o4 < -GEOMETRY_EPSILON) ||
      (o3 < -GEOMETRY_EPSILON && o4 > GEOMETRY_EPSILON))
  )
    return true;
  return (
    (Math.abs(o1) <= GEOMETRY_EPSILON && onSegment(a, b, c)) ||
    (Math.abs(o2) <= GEOMETRY_EPSILON && onSegment(a, b, d)) ||
    (Math.abs(o3) <= GEOMETRY_EPSILON && onSegment(c, d, a)) ||
    (Math.abs(o4) <= GEOMETRY_EPSILON && onSegment(c, d, b))
  );
}

export function polygonSelfIntersects(points: readonly NormXY[]): boolean {
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    for (let j = i + 1; j < points.length; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === points.length - 1)) continue;
      const c = points[j]!;
      const d = points[(j + 1) % points.length]!;
      if (intersects(a, b, c, d)) return true;
    }
  }
  return false;
}

function hasDuplicatePoints(points: readonly NormXY[]): boolean {
  return points.some((point, index) =>
    points.slice(index + 1).some((other) => samePoint(point, other)),
  );
}

function polygonArea(points: readonly NormXY[]): number {
  let doubledArea = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    const next = points[(index + 1) % points.length]!;
    doubledArea += point[0] * next[1] - next[0] * point[1];
  }
  return Math.abs(doubledArea) / 2;
}

function allPointsAreCollinear(points: readonly NormXY[]): boolean {
  const first = points[0];
  const second = points.find((point) => first && !samePoint(first, point));
  return (
    !first ||
    !second ||
    points.every((point) => Math.abs(orientation(first, second, point)) <= GEOMETRY_EPSILON)
  );
}

function hasAdjacentEdgeOverlap(points: readonly NormXY[]): boolean {
  return points.some((current, index) => {
    const previous = points[(index - 1 + points.length) % points.length]!;
    const next = points[(index + 1) % points.length]!;
    if (Math.abs(orientation(previous, current, next)) > GEOMETRY_EPSILON) return false;
    const previousVector: NormXY = [previous[0] - current[0], previous[1] - current[1]];
    const nextVector: NormXY = [next[0] - current[0], next[1] - current[1]];
    return previousVector[0] * nextVector[0] + previousVector[1] * nextVector[1] > GEOMETRY_EPSILON;
  });
}

export function validatePolygon(points: readonly NormXY[]): PolygonValidationError | null {
  if (points.length < 3) return 'too_few_points';
  if (hasDuplicatePoints(points)) return 'duplicate_points';
  if (allPointsAreCollinear(points)) return 'degenerate';
  if (hasAdjacentEdgeOverlap(points)) return 'self_intersection';
  if (polygonSelfIntersects(points)) return 'self_intersection';
  if (polygonArea(points) <= GEOMETRY_EPSILON) return 'degenerate';
  return null;
}

function polygonValidationMessageKo(error: PolygonValidationError): string {
  switch (error) {
    case 'too_few_points':
      return '영역에는 점이 3개 이상 필요합니다.';
    case 'duplicate_points':
      return '같은 위치의 꼭짓점이 있습니다. 점의 위치를 조정해 주세요.';
    case 'degenerate':
      return '영역의 넓이가 0입니다. 점을 일직선이 아닌 위치에 놓아 주세요.';
    case 'self_intersection':
      return '영역의 선이 서로 교차합니다. 점의 위치를 조정해 주세요.';
  }
}

function polygonWarningKo(points: readonly NormXY[]): string | null {
  const error = validatePolygon(points);
  return error ? polygonValidationMessageKo(error) : null;
}
