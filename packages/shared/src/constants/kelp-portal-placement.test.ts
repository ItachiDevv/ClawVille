import { describe, expect, it } from 'bun:test';
import {
  KELP_FOREST_PORTAL_ID,
  KELP_FOREST_PORTAL_MAX_ORIGIN_DISTANCE_WU,
  KELP_FOREST_PORTAL_MIN_COLLIDER_CLEARANCE_WU,
  KELP_FOREST_PORTAL_MIN_LANDMARK_DISTANCE_WU,
  KELP_FOREST_PORTAL_MIN_VALIDATION_CLEARANCE_WU,
  KELP_FOREST_PORTAL_WORLD_CENTER,
  deriveKelpForestPortalWorldCenter,
  getServerColliders,
  kelpForestPortalClearanceFromCollider,
} from './world-colliders-data';
import { SPAWN_PX, WORLD_CENTER_PX } from './world-dimensions';

const SPAWN_WORLD = {
  x: SPAWN_PX.x - WORLD_CENTER_PX.x,
  z: SPAWN_PX.y - WORLD_CENTER_PX.y,
};

describe('Kelp Forest portal town-center placement', () => {
  it('pins the founder-chosen bazaar-to-sign midpoint', () => {
    expect(KELP_FOREST_PORTAL_WORLD_CENTER).toEqual({ x: -547, z: -120 });
  });

  it('validates the founder pin against structures and landmarks', () => {
    const { x, z } = KELP_FOREST_PORTAL_WORLD_CENTER;
    const colliders = getServerColliders();
    const townDirectory = colliders.find((collider) => collider.id === 'town-directory-sign');
    expect(townDirectory).toBeDefined();
    if (!townDirectory) throw new Error('town-directory-sign collider missing from placement test');

    expect(x).not.toBe(SPAWN_WORLD.x);
    expect(Math.hypot(x - SPAWN_WORLD.x, z - SPAWN_WORLD.z))
      .toBeGreaterThanOrEqual(KELP_FOREST_PORTAL_MIN_LANDMARK_DISTANCE_WU);
    expect(Math.hypot(x - townDirectory.centerX, z - townDirectory.centerZ))
      .toBeGreaterThanOrEqual(KELP_FOREST_PORTAL_MIN_LANDMARK_DISTANCE_WU);
    for (const collider of colliders) {
      if (collider.id === KELP_FOREST_PORTAL_ID) continue;
      expect(kelpForestPortalClearanceFromCollider(x, z, collider))
        .toBeGreaterThanOrEqual(KELP_FOREST_PORTAL_MIN_VALIDATION_CLEARANCE_WU);
    }
  });

  it('keeps the conservative origin-nearest derivation as an advisory suggester', () => {
    const derived = deriveKelpForestPortalWorldCenter(getServerColliders());
    expect(Math.hypot(derived.x, derived.z))
      .toBeLessThanOrEqual(KELP_FOREST_PORTAL_MAX_ORIGIN_DISTANCE_WU);
    for (const collider of getServerColliders()) {
      if (collider.id === KELP_FOREST_PORTAL_ID) continue;
      expect(kelpForestPortalClearanceFromCollider(derived.x, derived.z, collider))
        .toBeGreaterThanOrEqual(KELP_FOREST_PORTAL_MIN_COLLIDER_CLEARANCE_WU);
    }
  });
});
