import { describe, it, expect } from 'vitest';
import { toNorm } from '../src/coords.js';
import {
  PRESET_REGIONS,
  PRESET_REGIONS_BY_ID,
  pointInRegion,
  pointInShape,
  shapeBbox,
  type RegionDefinition,
} from '../src/regions.js';

const byId = (id: string): RegionDefinition => {
  const r = PRESET_REGIONS_BY_ID.get(id);
  if (!r) throw new Error(`preset is absent: ${id}`);
  return r;
};

describe('built-in regions', () => {
  it('uses unique snake_case identifiers', () => {
    const ids = PRESET_REGIONS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('gives every preset a Korean label and norm-v1 coordinate space', () => {
    for (const r of PRESET_REGIONS) {
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.coordSpace).toBe('norm-v1');
      expect(r.origin).toBe('preset');
    }
  });

  it('keeps polygon vertices and circle centers inside map bounds', () => {
    // A circle centered at a corner may extend outside the map; only its center must be inside.
    const check = (shape: RegionDefinition['shape']): void => {
      switch (shape.kind) {
        case 'polygon':
          for (const [x, y] of shape.points) {
            expect(x).toBeGreaterThanOrEqual(-0.001);
            expect(x).toBeLessThanOrEqual(1.001);
            expect(y).toBeGreaterThanOrEqual(-0.001);
            expect(y).toBeLessThanOrEqual(1.001);
          }
          break;
        case 'rect': {
          const b = shapeBbox(shape);
          expect(b.x0).toBeGreaterThanOrEqual(-0.001);
          expect(b.y1).toBeLessThanOrEqual(1.001);
          break;
        }
        case 'circle':
          expect(shape.cx).toBeGreaterThanOrEqual(0);
          expect(shape.cx).toBeLessThanOrEqual(1);
          expect(shape.cy).toBeGreaterThanOrEqual(0);
          expect(shape.cy).toBeLessThanOrEqual(1);
          expect(shape.r).toBeGreaterThan(0);
          break;
        case 'multi':
          shape.parts.forEach(check);
          break;
      }
    };
    for (const r of PRESET_REGIONS) check(r.shape);
  });

  it('matches dragon and baron pit centers to game coordinates', () => {
    const dragon = toNorm(9866, 4414);
    const baron = toNorm(4950, 10400);
    const d = byId('dragon_pit').shape;
    const b = byId('baron_pit').shape;
    if (d.kind !== 'circle' || b.kind !== 'circle') throw new Error('expected circle regions');
    expect(d.cx).toBeCloseTo(dragon.xNorm, 3);
    expect(d.cy).toBeCloseTo(dragon.yNorm, 3);
    expect(b.cx).toBeCloseTo(baron.xNorm, 3);
    expect(b.cy).toBeCloseTo(baron.yNorm, 3);
  });
});

describe('point containment', () => {
  it('includes the main diagonal in mid lane and excludes corners', () => {
    const mid = byId('mid_lane');
    expect(pointInRegion(0.5, 0.5, mid)).toBe(true);
    expect(pointInRegion(0.3, 0.3, mid)).toBe(true);
    expect(pointInRegion(0.1, 0.9, mid)).toBe(false); // Top side.
    expect(pointInRegion(0.9, 0.1, mid)).toBe(false); // Bot side.
  });

  it('assigns the corresponding corners to top and bot lanes', () => {
    expect(pointInRegion(0.06, 0.6, byId('top_lane'))).toBe(true);
    expect(pointInRegion(0.6, 0.06, byId('top_lane'))).toBe(false);
    expect(pointInRegion(0.6, 0.06, byId('bot_lane'))).toBe(true);
    expect(pointInRegion(0.06, 0.6, byId('bot_lane'))).toBe(false);
  });

  it('accepts a point contained by any part of a multi shape', () => {
    const bj = byId('blue_jungle');
    expect(pointInRegion(0.22, 0.45, bj)).toBe(true); // Top-side half.
    expect(pointInRegion(0.45, 0.22, bj)).toBe(true); // Bot-side half.
    expect(pointInRegion(0.9, 0.9, bj)).toBe(false); // Red base.
  });

  it('includes the radius boundary in circle containment', () => {
    const c = { kind: 'circle', cx: 0.5, cy: 0.5, r: 0.1 } as const;
    expect(pointInShape(0.5, 0.5, c)).toBe(true);
    expect(pointInShape(0.6, 0.5, c)).toBe(true);
    expect(pointInShape(0.601, 0.5, c)).toBe(false);
  });

  it('allows built-in regions to overlap', () => {
    const p = { x: 0.5, y: 0.5 };
    const hits = PRESET_REGIONS.filter((r) => pointInRegion(p.x, p.y, r)).map((r) => r.id);
    expect(hits).toContain('mid_lane');
    expect(hits).toContain('river');
    expect(hits.length).toBeGreaterThan(1);
  });
});
