/**
 * Region definitions shared by built-in and user-defined regions.
 *
 * This file is the only source for built-in regions. The frontend imports it directly and
 * the backend reads generated reference data. Duplicating coordinates would create drift.
 *
 * All coordinates use normalized space with y increasing upward and `(0,0)` at the blue corner.
 */

/** Coordinate-space version; increment and migrate when the convention changes. */
export const REGION_COORD_SPACE = 'norm-v1' as const;
export type RegionCoordSpace = typeof REGION_COORD_SPACE;

/** [x_norm, y_norm] */
export type NormXY = readonly [number, number];

export type RegionShape =
  | { readonly kind: 'polygon'; readonly points: readonly NormXY[] }
  | {
      readonly kind: 'rect';
      readonly x0: number;
      readonly y0: number;
      readonly x1: number;
      readonly y1: number;
    }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
  | { readonly kind: 'multi'; readonly parts: readonly RegionShape[] };

export interface RegionDefinition {
  /** Stable English snake_case identifier used by DSL `region("...")`. */
  readonly id: string;
  /** Korean display label; never emitted into DSL source. */
  readonly label: string;
  readonly origin: 'preset' | 'user';
  readonly coordSpace: RegionCoordSpace;
  readonly shape: RegionShape;
  readonly createdAt?: string;
}

/** Axis-aligned bounding box used as a cheap spatial prefilter. */
export interface Bbox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export function shapeBbox(shape: RegionShape): Bbox {
  switch (shape.kind) {
    case 'polygon': {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const [x, y] of shape.points) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      return { x0, y0, x1, y1 };
    }
    case 'rect':
      return {
        x0: Math.min(shape.x0, shape.x1),
        y0: Math.min(shape.y0, shape.y1),
        x1: Math.max(shape.x0, shape.x1),
        y1: Math.max(shape.y0, shape.y1),
      };
    case 'circle':
      return {
        x0: shape.cx - shape.r,
        y0: shape.cy - shape.r,
        x1: shape.cx + shape.r,
        y1: shape.cy + shape.r,
      };
    case 'multi': {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const part of shape.parts) {
        const b = shapeBbox(part);
        if (b.x0 < x0) x0 = b.x0;
        if (b.y0 < y0) y0 = b.y0;
        if (b.x1 > x1) x1 = b.x1;
        if (b.y1 > y1) y1 = b.y1;
      }
      return { x0, y0, x1, y1 };
    }
  }
}

/**
 * Tests whether a point lies inside a shape.
 *
 * Polygons use the same even-odd ray-casting algorithm as the backend SQL fallback.
 * Cross-language golden tests keep boundary behavior aligned with the frontend preview.
 */
export function pointInShape(xNorm: number, yNorm: number, shape: RegionShape): boolean {
  switch (shape.kind) {
    case 'polygon': {
      const pts = shape.points;
      const n = pts.length;
      if (n < 3) return false;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const pi = pts[i]!;
        const pj = pts[j]!;
        const [xi, yi] = pi;
        const [xj, yj] = pj;
        if (yi > yNorm !== yj > yNorm) {
          const t = (xj - xi) * (yNorm - yi);
          const d = yj - yi;
          if (d !== 0 && xNorm < t / d + xi) inside = !inside;
        }
      }
      return inside;
    }
    case 'rect': {
      const b = shapeBbox(shape);
      return xNorm >= b.x0 && xNorm <= b.x1 && yNorm >= b.y0 && yNorm <= b.y1;
    }
    case 'circle': {
      const dx = xNorm - shape.cx;
      const dy = yNorm - shape.cy;
      return dx * dx + dy * dy <= shape.r * shape.r;
    }
    case 'multi':
      return shape.parts.some((p) => pointInShape(xNorm, yNorm, p));
  }
}

export function pointInRegion(xNorm: number, yNorm: number, region: RegionDefinition): boolean {
  return pointInShape(xNorm, yNorm, region.shape);
}

const preset = (id: string, label: string, shape: RegionShape): RegionDefinition => ({
  id,
  label,
  origin: 'preset',
  coordSpace: REGION_COORD_SPACE,
  shape,
});

const poly = (...points: NormXY[]): RegionShape => ({ kind: 'polygon', points });

/**
 * Built-in regions.
 *
 * Regions follow map symmetry: mid follows the main diagonal and river the opposite diagonal.
 * Lane and jungle polygons are four-to-six-point terrain approximations.
 *
 * Built-ins intentionally overlap, so category totals need not equal the overall population.
 */
export const PRESET_REGIONS: readonly RegionDefinition[] = [
  preset(
    'top_lane',
    '탑 라인',
    poly([0.0, 0.28], [0.13, 0.28], [0.14, 0.85], [0.72, 0.87], [0.72, 1.0], [0.0, 1.0]),
  ),

  preset(
    'bot_lane',
    '봇 라인',
    poly([0.28, 0.0], [1.0, 0.0], [1.0, 0.72], [0.87, 0.72], [0.85, 0.14], [0.28, 0.13]),
  ),

  preset('mid_lane', '미드 라인', poly([0.16, 0.08], [0.92, 0.84], [0.84, 0.92], [0.08, 0.16])),

  preset('river', '강', poly([0.915, 0.155], [0.155, 0.915], [0.085, 0.845], [0.845, 0.085])),

  preset(
    'top_river',
    '탑 강 (바론 쪽)',
    poly([0.535, 0.535], [0.155, 0.915], [0.085, 0.845], [0.465, 0.465]),
  ),

  preset(
    'bot_river',
    '봇 강 (드래곤 쪽)',
    poly([0.915, 0.155], [0.535, 0.535], [0.465, 0.465], [0.845, 0.085]),
  ),

  preset('blue_top_jungle', '블루 탑 정글', poly([0.15, 0.21], [0.15, 0.79], [0.44, 0.5])),
  preset('blue_bot_jungle', '블루 봇 정글', poly([0.21, 0.15], [0.79, 0.15], [0.5, 0.44])),
  preset('blue_jungle', '블루 정글', {
    kind: 'multi',
    parts: [
      poly([0.15, 0.21], [0.15, 0.79], [0.44, 0.5]),
      poly([0.21, 0.15], [0.79, 0.15], [0.5, 0.44]),
    ],
  }),

  preset('red_top_jungle', '레드 탑 정글', poly([0.79, 0.85], [0.21, 0.85], [0.5, 0.56])),
  preset('red_bot_jungle', '레드 봇 정글', poly([0.85, 0.79], [0.85, 0.21], [0.56, 0.5])),
  preset('red_jungle', '레드 정글', {
    kind: 'multi',
    parts: [
      poly([0.79, 0.85], [0.21, 0.85], [0.5, 0.56]),
      poly([0.85, 0.79], [0.85, 0.21], [0.56, 0.5]),
    ],
  }),

  preset('blue_base', '블루 본진', { kind: 'circle', cx: 0.06, cy: 0.06, r: 0.12 }),
  preset('red_base', '레드 본진', { kind: 'circle', cx: 0.94, cy: 0.94, r: 0.12 }),

  // Game coordinates (9866, 4414), converted with `toNorm`.
  preset('dragon_pit', '드래곤 둥지', { kind: 'circle', cx: 0.6657, cy: 0.3023, r: 0.05 }),
  // Game coordinates (4950, 10400), converted with `toNorm`.
  preset('baron_pit', '바론 둥지', { kind: 'circle', cx: 0.338, cy: 0.7013, r: 0.05 }),
];

export const PRESET_REGIONS_BY_ID: ReadonlyMap<string, RegionDefinition> = new Map(
  PRESET_REGIONS.map((r) => [r.id, r]),
);
