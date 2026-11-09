import { describe, expect, test } from 'bun:test';
import { BUILDING_TILE_ZONES } from './npc-definitions';
import { AUTONOMY_ENTERABLE_PLACES } from './map-locations';
import { getServerColliders } from './world-colliders-data';
import { LAND_PARCELS } from './land-parcels';
import { WORLD_CENTER_PX } from './world-dimensions';
import {
  BRAINCHAIN_OFFICE_WORLD_CENTER as center,
  BRAINCHAIN_OFFICE_HALF_X_WU as hx,
  BRAINCHAIN_OFFICE_HALF_Z_WU as hz,
  BRAINCHAIN_OFFICE_GUIDE_WORLD as guide,
  BRAINCHAIN_OFFICE_GUIDE_APPROACH_GAME as guideApproach,
  BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME,
  brainchainOfficeColliderClearance,
  isBrainchainOfficeDoorWorld,
  isBrainchainOfficeGuideWorld,
} from './brainchain-office-world';

describe('BrainChain Office additive placement', () => {
  test('keeps its full footprint outside every ring lane and other collider', () => {
    for (const collider of getServerColliders()) {
      if (collider.id.startsWith('brainchain-office')) continue;
      expect(brainchainOfficeColliderClearance(collider)).toBeGreaterThanOrEqual(200);
    }
    // Quantized 12-slot ring directions, including the two entertainment slots.
    for (let slot = 0; slot < 12; slot++) {
      const theta = -Math.PI / 2 + slot * Math.PI / 6;
      const bx = Math.round(130 * Math.cos(theta)) * 32;
      const bz = Math.round(130 * Math.sin(theta)) * 32;
      const length = Math.hypot(bx, bz);
      const ux = bx / length;
      const uz = bz / length;
      const distance = Math.abs(center.x * uz - center.z * ux) - hx * Math.abs(uz) - hz * Math.abs(ux);
      const projection = center.x * ux + center.z * uz;
      if (projection > 0 && projection < length) expect(distance).toBeGreaterThanOrEqual(400);
    }
  });

  test('clears every land parcel', () => {
    for (const parcel of LAND_PARCELS) expect(brainchainOfficeColliderClearance({ id: parcel.id, centerX: parcel.cx, centerZ: parcel.cz, halfX: parcel.size / 2, halfZ: parcel.size / 2 })).toBeGreaterThanOrEqual(200);
  });

  test('clears residents and their prompt bands', () => {
    for (const zone of Object.values(BUILDING_TILE_ZONES)) {
      const bx = (zone.x + zone.w / 2) * 32 - WORLD_CENTER_PX.x;
      const bz = (zone.y + zone.h / 2) * 32 - WORLD_CENTER_PX.y;
      const length = Math.hypot(bx, bz);
      const rx = bx * (1 - 1300 / length);
      const rz = bz * (1 - 1300 / length);
      const distance = Math.hypot(Math.max(0, Math.abs(rx - center.x) - hx), Math.max(0, Math.abs(rz - center.z) - hz));
      expect(distance).toBeGreaterThanOrEqual(460);
      expect(Math.hypot(guide.x - rx, guide.z - rz)).toBeGreaterThan(480);
      expect(Math.hypot(760 - rx, -2710 - rz)).toBeGreaterThan(260);
    }
  });

  test('provides separate door and guide approaches', () => {
    expect(isBrainchainOfficeDoorWorld(760, -2710)).toBe(true);
    expect(isBrainchainOfficeDoorWorld(BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME.x - WORLD_CENTER_PX.x, BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME.y - WORLD_CENTER_PX.y)).toBe(true);
    for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 16) {
      expect(isBrainchainOfficeDoorWorld(760 + 96 * Math.cos(angle), -2600 + 96 * Math.sin(angle))).toBe(true);
    }
    expect(isBrainchainOfficeGuideWorld(760, -2710)).toBe(false);
    expect(isBrainchainOfficeGuideWorld(guide.x - 160, guide.z)).toBe(true);
    expect(isBrainchainOfficeDoorWorld(guide.x - 160, guide.z)).toBe(false);
    for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 16) {
      const x = guideApproach.x - WORLD_CENTER_PX.x + 12 * Math.cos(angle);
      const z = guideApproach.y - WORLD_CENTER_PX.y + 12 * Math.sin(angle);
      expect(isBrainchainOfficeGuideWorld(x, z)).toBe(true);
      expect(isBrainchainOfficeDoorWorld(x, z)).toBe(false);
    }
  });

  test('adds a move place without a teaching-building reward identity', () => {
    expect(Object.hasOwn(BUILDING_TILE_ZONES, 'brainchain-office')).toBe(false);
    expect(AUTONOMY_ENTERABLE_PLACES.find((p) => p.placeId === 'brainchain-office')).toMatchObject({
      actionVerb: 'move', center: BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME, destinationId: 'brainchain-office',
    });
  });
});
