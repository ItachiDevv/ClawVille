import { TRADING_FLOOR_ROOM } from './trading-floor-room';

/** Half a 15-20 wu foot; this surface never affects gameplay. */
export const TRADING_FLOOR_WATER_Y = 7;
export const TRADING_FLOOR_WATER_ALPHA = 0.08;
export const TRADING_FLOOR_WATER_SHIMMER_ALPHA = 0.04;
/** Glow (-1), then water, then normal-blended trade-tape chips (0). */
export const TRADING_FLOOR_WATER_RENDER_ORDER = -0.5;

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
