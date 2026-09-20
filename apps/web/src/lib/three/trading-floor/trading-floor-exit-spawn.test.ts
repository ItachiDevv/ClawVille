import { describe, expect, test } from 'bun:test';
import { ENTITY_HALF_CHIBI } from '@clawville/shared';
import {
  CHARACTER_POSITIONS,
  isCoveProximate,
  isTradingFloorProximate,
  TALK_RADIUS_WORLD,
  TRADING_FLOOR_EXIT_WORLD_X,
  TRADING_FLOOR_EXIT_WORLD_Z,
} from '../character-positions';
import { clampMovement2D } from '../collision/world-colliders';
import {
  TRADING_FLOOR_BUILDING_ID,
  TRADING_FLOOR_BUILDING_WORLD,
  TRADING_FLOOR_DOOR_PX,
  TRADING_FLOOR_DOOR_WORLD,
  TRADING_FLOOR_PROMPT_RADIUS_WU,
} from './trading-floor-location';
import { MAP_HEIGHT, MAP_WIDTH } from '@/lib/pixi/tilemap-data';

/**
 * The cove's exit bug, restated so it cannot happen twice (founder-reported
 * 2026-09-18): the exit point was hand-set BEFORE the tunnel, collision wall
 * and auto-enter band existed, so it landed inside the band and the first step
 * toward town re-entered the venue. Every exit, every time.
 *
 * The Trading Floor's exit is DERIVED from the resident's computed stand
 * position, and this file pins the two properties the derivation exists for.
 */

/** The walk-in poll's arrival window (arena-buildings DOOR_ARRIVE_DIST). */
const DOOR_ARRIVE_DIST = 200;

/**
 * Walks an avatar south (toward the building) in small steps, clamping each
 * step against the world colliders, and returns where it comes to rest.
 *
 * A stepped walk, not a single teleport into the AABB: `clampMovement2D` is a
 * point-ejection, so a jump to the collider's dead centre ejects out of the
 * FAR face. Real movement never does that, and modelling it would test the
 * ejection tie-break instead of the door placement.
 */
function walkSouthToBuilding(startX: number, startZ: number): { x: number; z: number } {
  let x = startX;
  let z = startZ;
  for (let step = 0; step < 400; step += 1) {
    const clamped = clampMovement2D(x, z, x, z + 8, ENTITY_HALF_CHIBI);
    if (Math.abs(clamped.z - z) < 0.01 && Math.abs(clamped.x - x) < 0.01) break;
    x = clamped.x;
    z = clamped.z;
  }
  return { x, z };
}

describe('Trading Floor world anchors', () => {
  test('derives from the live cron-automation ring zone, not a hand-set constant', () => {
    expect(CHARACTER_POSITIONS[TRADING_FLOOR_BUILDING_ID]).toBeDefined();
    // Today's ring: slot 6 / S, world (0, 4160).
    expect(TRADING_FLOOR_BUILDING_WORLD.x).toBe(0);
    expect(TRADING_FLOOR_BUILDING_WORLD.z).toBeGreaterThan(0);
  });

  test('the door sits between the town centre and the building centre', () => {
    expect(TRADING_FLOOR_DOOR_WORLD.z).toBeLessThan(
      TRADING_FLOOR_BUILDING_WORLD.z,
    );
    expect(TRADING_FLOOR_DOOR_WORLD.z).toBeGreaterThan(0);
  });

  test('game-px conversion matches the world point', () => {
    expect(TRADING_FLOOR_DOOR_PX.x).toBe(
      MAP_WIDTH / 2 + TRADING_FLOOR_DOOR_WORLD.x,
    );
    expect(TRADING_FLOOR_DOOR_PX.y).toBe(
      MAP_HEIGHT / 2 + TRADING_FLOOR_DOOR_WORLD.z,
    );
  });
});

describe('Trading Floor door is reachable on foot', () => {
  // A door target the avatar can never get near would leave the walk-in poll
  // grinding against the building wall until its 1500ms timeout — the fade
  // would fire from wherever the avatar stalled instead of at the door.
  test('the building collider stops the avatar inside the arrival window', () => {
    const rest = walkSouthToBuilding(
      TRADING_FLOOR_DOOR_WORLD.x,
      TRADING_FLOOR_EXIT_WORLD_Z,
    );
    const reachedDistance = Math.hypot(
      rest.x - TRADING_FLOOR_DOOR_WORLD.x,
      rest.z - TRADING_FLOOR_DOOR_WORLD.z,
    );
    expect(reachedDistance).toBeLessThanOrEqual(DOOR_ARRIVE_DIST);
  });

  test('the prompt band still covers that stopping point', () => {
    const rest = walkSouthToBuilding(
      TRADING_FLOOR_DOOR_WORLD.x,
      TRADING_FLOOR_EXIT_WORLD_Z,
    );
    expect(isTradingFloorProximate(rest.x, rest.z)).toBe(true);
  });

  test('the avatar is stopped by the building, not standing inside it', () => {
    const rest = walkSouthToBuilding(
      TRADING_FLOOR_DOOR_WORLD.x,
      TRADING_FLOOR_EXIT_WORLD_Z,
    );
    expect(rest.z).toBeLessThan(TRADING_FLOOR_BUILDING_WORLD.z);
    // The collider, not the map edge, is what stopped it.
    expect(
      clampMovement2D(rest.x, rest.z, rest.x, rest.z + 8, ENTITY_HALF_CHIBI).hit,
    ).toBe(true);
  });

  test('the door target is somewhere the avatar can stand', () => {
    // A target inside the collider would leave the walk-in poll grinding
    // against the wall until its 1500 ms timeout instead of arriving.
    expect(
      clampMovement2D(
        TRADING_FLOOR_DOOR_WORLD.x,
        TRADING_FLOOR_DOOR_WORLD.z,
        TRADING_FLOOR_DOOR_WORLD.x,
        TRADING_FLOOR_DOOR_WORLD.z,
        ENTITY_HALF_CHIBI,
      ).hit,
    ).toBe(false);
  });
});

describe('Trading Floor exit spawn', () => {
  test('lands outside the door prompt band', () => {
    expect(
      isTradingFloorProximate(
        TRADING_FLOOR_EXIT_WORLD_X,
        TRADING_FLOOR_EXIT_WORLD_Z,
      ),
    ).toBe(false);
  });

  test('lands outside the resident teacher radius, so arrival is not nagged', () => {
    const resident = CHARACTER_POSITIONS[TRADING_FLOOR_BUILDING_ID]!;
    const distance = Math.hypot(
      TRADING_FLOOR_EXIT_WORLD_X - resident.worldX,
      TRADING_FLOOR_EXIT_WORLD_Z - resident.worldZ,
    );
    expect(distance).toBeGreaterThan(TALK_RADIUS_WORLD);
  });

  test('sits on the TOWN side of the door band, with a real margin', () => {
    const gap =
      TRADING_FLOOR_DOOR_WORLD.z -
      TRADING_FLOOR_PROMPT_RADIUS_WU -
      TRADING_FLOOR_EXIT_WORLD_Z;
    expect(gap).toBeGreaterThan(0);
  });

  test('is not inside the building collider', () => {
    const clamped = clampMovement2D(
      TRADING_FLOOR_EXIT_WORLD_X,
      TRADING_FLOOR_EXIT_WORLD_Z,
      TRADING_FLOOR_EXIT_WORLD_X,
      TRADING_FLOOR_EXIT_WORLD_Z,
      ENTITY_HALF_CHIBI,
    );
    expect(clamped.hit).toBe(false);
  });

  test('does not land in the cove prompt band either', () => {
    expect(
      isCoveProximate(TRADING_FLOOR_EXIT_WORLD_X, TRADING_FLOOR_EXIT_WORLD_Z),
    ).toBe(false);
  });

  // There is deliberately NO auto-enter band here, so walking toward town can
  // never re-enter. This walks the whole return path and proves the prompt
  // only reappears when the player turns back around.
  test('walking toward town from the exit never re-enters the door band', () => {
    for (let z = TRADING_FLOOR_EXIT_WORLD_Z; z >= 0; z -= 10) {
      expect(isTradingFloorProximate(TRADING_FLOOR_EXIT_WORLD_X, z)).toBe(false);
    }
  });
});

describe('Trading Floor prompt band does not collide with other venues', () => {
  test('no point in the band is also cove-proximate', () => {
    for (let dz = -TRADING_FLOOR_PROMPT_RADIUS_WU; dz <= TRADING_FLOOR_PROMPT_RADIUS_WU; dz += 25) {
      for (let dx = -TRADING_FLOOR_PROMPT_RADIUS_WU; dx <= TRADING_FLOOR_PROMPT_RADIUS_WU; dx += 25) {
        const x = TRADING_FLOOR_DOOR_WORLD.x + dx;
        const z = TRADING_FLOOR_DOOR_WORLD.z + dz;
        if (!isTradingFloorProximate(x, z)) continue;
        expect(isCoveProximate(x, z)).toBe(false);
      }
    }
  });
});
