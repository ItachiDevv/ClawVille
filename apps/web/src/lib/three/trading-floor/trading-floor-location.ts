/**
 * trading-floor-location.ts
 *
 * WORLD-SIDE (outdoor) anchors for the Trading Floor building — the walk-in
 * door target, the entry-prompt band and the game-px conversions the walk-in
 * poll needs. The INTERIOR's own geometry lives in `trading-floor-room.ts`.
 *
 * The building keeps its historical id `cron-automation` (slot 6 / S). The id
 * is load-bearing: owned book ids, leaderboard events and agent memories all
 * key off it, so it is NEVER renamed — only re-themed.
 *
 * Everything here is DERIVED from `buildingZones`, which is recomputed on every
 * world grow (576 -> 704 tiles re-centred the whole ring). A hand-set world
 * constant is the trap that produced the cove's -3760 exit bug; deriving keeps
 * the door and the building together through the next grow.
 */

import {
  buildingZones,
  MAP_HEIGHT,
  MAP_WIDTH,
  TILE_SIZE,
} from '@/lib/pixi/tilemap-data';

/** Ring-slot id. Renaming this is FORBIDDEN — see the module comment. */
export const TRADING_FLOOR_BUILDING_ID = 'cron-automation';

/**
 * `nearLocation` value published while the player stands at the door.
 * Deliberately NOT the building id: the building id already means "Pearl's
 * teacher chat is in range", and the two prompts must stay distinguishable.
 */
export const TRADING_FLOOR_NEAR_ID = 'trading-floor';

const ZONE = buildingZones.find((zone) => zone.id === TRADING_FLOOR_BUILDING_ID);
if (!ZONE) {
  // Fail LOUD, not silently at (0,0): every door/exit/prompt below derives
  // from this zone, and a missing entry would quietly drop the walk-in on the
  // town centre. buildingZones is a static table; this can only fire if the
  // ring is edited, which is exactly when we want the crash.
  throw new Error(
    `[trading-floor] buildingZones has no '${TRADING_FLOOR_BUILDING_ID}' entry`,
  );
}

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

/** World centre of the building footprint. Today: (0, 4160) — due south. */
export const TRADING_FLOOR_BUILDING_WORLD = Object.freeze({
  x: OFFSET_X + (ZONE.x + ZONE.width / 2) * TILE_SIZE,
  z: OFFSET_Z + (ZONE.y + ZONE.height / 2) * TILE_SIZE,
});

/**
 * How far IN FRONT of the building centre the door target sits, toward the
 * ring centre (-Z from this slot).
 *
 * The Trading Floor exterior's collider is halfZ 720 + a 28 wu texture buffer
 * = 748 (`collision/world-colliders.ts` BUILDING_EXTENTS), so a chibi avatar
 * (ENTITY_HALF_CHIBI = 25) is stopped 773 wu from the centre. 800 puts the
 * target just OUTSIDE that — somewhere the avatar can actually stand — so the
 * walk-in poll's 200 game-px arrival window closes on the building's face
 * instead of grinding against the wall until its 1500 ms timeout.
 *
 * Pinned by trading-floor-exit-spawn.test.ts, which walks a real clamped path
 * into the building and checks where it comes to rest.
 */
export const TRADING_FLOOR_DOOR_INSET_WU = 800;

/** World point the avatar walks to before the fade. */
export const TRADING_FLOOR_DOOR_WORLD = Object.freeze({
  x: TRADING_FLOOR_BUILDING_WORLD.x,
  z: TRADING_FLOOR_BUILDING_WORLD.z - TRADING_FLOOR_DOOR_INSET_WU,
});

/** Same point in game-px (game-px = MAP centre + world units, 1:1). */
export const TRADING_FLOOR_DOOR_PX = Object.freeze({
  x: MAP_WIDTH / 2 + TRADING_FLOOR_DOOR_WORLD.x,
  y: MAP_HEIGHT / 2 + TRADING_FLOOR_DOOR_WORLD.z,
});

/**
 * Radius (wu) of the entry-prompt band around the door target.
 *
 * 400 leaves a ~500 wu approach corridor between Pearl's 260 wu talk radius
 * and the building face, so walking up reads: resident prompt first, then the
 * door prompt. There is deliberately NO auto-enter band — the cove's was the
 * mechanism behind the exit re-entry loop (founder-reported 2026-09-18).
 */
export const TRADING_FLOOR_PROMPT_RADIUS_WU = 400;
