import { describe, expect, it } from 'bun:test';
import {
  KELP_FOREST_PORTAL_ID,
  KELP_FOREST_PORTAL_MAX_ORIGIN_DISTANCE_WU,
  KELP_FOREST_PORTAL_MIN_COLLIDER_CLEARANCE_WU,
  KELP_FOREST_PORTAL_MIN_LANDMARK_DISTANCE_WU,
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
  it('pins exactly what the deterministic clearance search derives', () => {
    // If future town furniture crowds the pinned spot, the derivation moves
    // and this fails loud — the portal can never be silently swallowed.
    const derived = deriveKelpForestPortalWorldCenter(getServerColliders());
    expect(derived).toEqual({ ...KELP_FOREST_PORTAL_WORLD_CENTER });
  });

  it('honors every placement invariant at the pinned spot', () => {
    const { x, z } = KELP_FOREST_PORTAL_WORLD_CENTER;
    expect(Math.hypot(x, z)).toBeLessThanOrEqual(KELP_FOREST_PORTAL_MAX_ORIGIN_DISTANCE_WU);
    expect(Math.hypot(x - SPAWN_WORLD.x, z - SPAWN_WORLD.z))
      .toBeGreaterThanOrEqual(KELP_FOREST_PORTAL_MIN_LANDMARK_DISTANCE_WU);
    for (const collider of getServerColliders()) {
      if (collider.id === KELP_FOREST_PORTAL_ID) continue;
      expect(kelpForestPortalClearanceFromCollider(x, z, collider))
        .toBeGreaterThanOrEqual(KELP_FOREST_PORTAL_MIN_COLLIDER_CLEARANCE_WU);
    }
  });
});
