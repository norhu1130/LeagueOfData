import { describe, it, expect } from 'vitest';
import {
  MAP_MIN,
  MAP_SPAN,
  toNorm,
  fromNorm,
  toScreen,
  fromScreen,
  radiusToNorm,
  radiusFromNorm,
  isInMapBounds,
} from '../src/coords.js';

describe('coordinate conversion', () => {
  it('round-trips game to normalized to game coordinates', () => {
    for (const [x, y] of [
      [-120, -120],
      [0, 0],
      [7375, 7375],
      [14870, 14980],
      [1234, 9876],
    ]) {
      const n = toNorm(x!, y!);
      const g = fromNorm(n.xNorm, n.yNorm);
      expect(g.x).toBeCloseTo(x!, 9);
      expect(g.y).toBeCloseTo(y!, 9);
    }
  });

  it('maps the lower map bound to the normalized origin', () => {
    const n = toNorm(MAP_MIN, MAP_MIN);
    expect(n.xNorm).toBe(0);
    expect(n.yNorm).toBe(0);
  });

  it('uses the same divisor for both axes', () => {
    // Equal game-unit displacements must normalize equally on either axis.
    const dx = toNorm(1000, 0).xNorm - toNorm(0, 0).xNorm;
    const dy = toNorm(0, 1000).yNorm - toNorm(0, 0).yNorm;
    expect(dx).toBeCloseTo(dy, 12);
    expect(dx).toBeCloseTo(1000 / MAP_SPAN, 12);
  });

  it('round-trips radius conversion', () => {
    expect(radiusFromNorm(radiusToNorm(1000))).toBeCloseTo(1000, 9);
  });

  it('flips y only during screen conversion', () => {
    const top = toScreen(0.5, 1.0, 512, 512); // Red-side north maps to screen top.
    const bottom = toScreen(0.5, 0.0, 512, 512); // Blue-side south maps to screen bottom.
    expect(top.y).toBe(0);
    expect(bottom.y).toBe(512);
    expect(top.x).toBe(256);
  });

  it('round-trips screen conversion', () => {
    const n = fromScreen(
      ...(Object.values(toScreen(0.3, 0.7, 800, 600)) as [number, number]),
      800,
      600,
    );
    expect(n.xNorm).toBeCloseTo(0.3, 9);
    expect(n.yNorm).toBeCloseTo(0.7, 9);
  });

  it('does not clamp out-of-range coordinates', () => {
    const n = toNorm(-5000, 99999);
    expect(n.xNorm).toBeLessThan(0);
    expect(n.yNorm).toBeGreaterThan(1);
    expect(isInMapBounds(n.xNorm, n.yNorm)).toBe(false);
  });
});
