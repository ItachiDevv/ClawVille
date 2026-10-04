import { TRADING_FLOOR_ROOM } from './trading-floor-room';

/** Half a 15-20 wu foot; this surface never affects gameplay. */
export const TRADING_FLOOR_WATER_Y = 7;
export const TRADING_FLOOR_WATER_ALPHA = 0.12;
export const TRADING_FLOOR_WATER_GRAZING_ALPHA = 0.46;
export const TRADING_FLOOR_WATER_SHIMMER_ALPHA = 0.04;
/** World-units/second toward the board (-Z); directions have unit length. */
export const TRADING_FLOOR_WATER_FLOW_SPEED = 58;
export const TRADING_FLOOR_WATER_FLOW_DIRECTION = Object.freeze({ x: 0, z: -1 });
export const TRADING_FLOOR_WATER_SECONDARY_FLOW_SPEED = 44;
export const TRADING_FLOOR_WATER_SECONDARY_FLOW_DIRECTION = Object.freeze({ x: 0.28, z: -0.96 });
/** Crest normals align with the flow so visible motion reads toward -Z. */
export const TRADING_FLOOR_WATER_RIPPLE_WAVE_VECTOR = Object.freeze({ x: 0.014, z: 0.040 });
export const TRADING_FLOOR_WATER_CAUSTIC_WAVE_VECTOR = Object.freeze({ x: 0.010, z: 0.057 });
/** N dot V = sin(view angle below horizontal): clear by 25 degrees. */
export const TRADING_FLOOR_WATER_GRAZING_DOT = 0.14;
export const TRADING_FLOOR_WATER_STEEP_DOT = 0.42;
export const TRADING_FLOOR_WATER_STEEP_COLOR = '#4e8d7c';
export const TRADING_FLOOR_WATER_GRAZING_COLOR = '#8ccfd0';
export const TRADING_FLOOR_WATER_HIGHLIGHT_COLOR = '#d5f4ed';
/** Glow (-1), then water, then normal-blended trade-tape chips (0). */
export const TRADING_FLOOR_WATER_RENDER_ORDER = -0.5;

/** Matches the TSL smoothstep curve; angle is in degrees below horizontal. */
export function tradingFloorWaterAlpha(viewAngleDegrees: number): number {
  const normalDotView = Math.sin(Math.max(0, Math.min(90, viewAngleDegrees)) * Math.PI / 180);
  const t = Math.max(0, Math.min(1, (normalDotView - TRADING_FLOOR_WATER_GRAZING_DOT)
    / (TRADING_FLOOR_WATER_STEEP_DOT - TRADING_FLOOR_WATER_GRAZING_DOT)));
  const grazing = 1 - t * t * (3 - 2 * t);
  return TRADING_FLOOR_WATER_ALPHA
    + (TRADING_FLOOR_WATER_GRAZING_ALPHA - TRADING_FLOOR_WATER_ALPHA) * grazing;
}

export function tradingFloorWaterBounds(room: {
  readonly halfX: number;
  readonly halfZ: number;
  readonly wallThickness: number;
} = TRADING_FLOOR_ROOM) {
  // Room half-extents are INNER wall faces. Only a small inset is needed.
  const inset = room.wallThickness / 20;
  return { halfX: room.halfX - inset, halfZ: room.halfZ - inset };
}

export const TRADING_FLOOR_WATER_BOUNDS = Object.freeze(tradingFloorWaterBounds());
