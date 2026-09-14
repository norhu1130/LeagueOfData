/**
 * Summoner's Rift coordinate system: the single source of truth.
 *
 * Three coordinate spaces exist, and mixing them is a common source of bugs:
 *
 *   game   : Riot source coordinates, approximately [-120, 14870], with y increasing upward.
 *   norm   : normalized [0,1] coordinates with the game y orientation; used on disk and in queries.
 *   screen : canvas pixels with y increasing downward.
 *
 * One rule applies: storage and queries preserve game orientation; only canvas conversion
 * flips y. `toScreen` and `fromScreen` are the only functions allowed to perform that flip.
 */

/** Shared lower bound for x and y map coordinates. */
export const MAP_MIN = -120;

/**
 * Normalization divisor, shared by both axes.
 *
 * The physical bounds differ slightly between axes. Separate divisors would make normalized
 * space anisotropic and turn circles into ellipses. The shared span preserves distance at the
 * cost of about 0.7% unused space at the top of the y-axis.
 */
export const MAP_SPAN = 15000;

export interface GamePoint {
  x: number;
  y: number;
}
/** Normalized coordinates corresponding to the stored `x_norm` and `y_norm` fields. */
export interface NormPoint {
  xNorm: number;
  yNorm: number;
}
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Converts game to normalized coordinates without clamping data-quality failures. */
export function toNorm(x: number, y: number): NormPoint {
  return { xNorm: (x - MAP_MIN) / MAP_SPAN, yNorm: (y - MAP_MIN) / MAP_SPAN };
}

/** norm → game. */
export function fromNorm(xNorm: number, yNorm: number): GamePoint {
  return { x: xNorm * MAP_SPAN + MAP_MIN, y: yNorm * MAP_SPAN + MAP_MIN };
}

/** Converts a game-unit distance to normalized units; isotropy makes it axis-independent. */
export function radiusToNorm(radiusGameUnits: number): number {
  return radiusGameUnits / MAP_SPAN;
}

export function radiusFromNorm(radiusNorm: number): number {
  return radiusNorm * MAP_SPAN;
}

/**
 * Converts normalized to screen coordinates and flips y. Do not write `1 - y` elsewhere.
 */
export function toScreen(xNorm: number, yNorm: number, width: number, height: number): ScreenPoint {
  return { x: xNorm * width, y: (1 - yNorm) * height };
}

/** Converts screen to normalized coordinates; inverse of `toScreen`. */
export function fromScreen(x: number, y: number, width: number, height: number): NormPoint {
  return { xNorm: x / width, yNorm: 1 - y / height };
}

/** Checks normalized map bounds with a small floating-point tolerance. */
export function isInMapBounds(xNorm: number, yNorm: number, epsilon = 1e-3): boolean {
  return xNorm >= -epsilon && xNorm <= 1 + epsilon && yNorm >= -epsilon && yNorm <= 1 + epsilon;
}
