import { describe, expect, test } from 'bun:test';
import { SPAWN_PX, WORLD_CENTER_PX, getServerColliders, getBuildingFootprint } from '@clawville/shared';
import { getAllColliders } from '../three/collision/world-colliders';
import { findPath as clientPath } from './client-pathfinding';
import { findPath as serverPath, isSegmentCollisionFree } from '../../../../api/src/services/pathfinding';

// The BrainChain Office is the `api-integrations` ring building (2026-11-10).
const BRAINCHAIN_OFFICE_BUILDING_ID = 'api-integrations';

function verifyPath(path: { x: number; y: number }[], start: { x: number; y: number }) {
  expect(path.length).toBeGreaterThan(0);
  let previous = start;
  for (const point of path) {
    expect(isSegmentCollisionFree(previous.x, previous.y, point.x, point.y, 50)).toBe(true);
    previous = point;
  }
}

/** Plaza-side point clear of the building's collider and both safety halos. */
function plazaApproach(collider: { centerX: number; centerZ: number; halfX: number; halfZ: number }) {
  const radius = Math.hypot(collider.centerX, collider.centerZ);
  const ux = collider.centerX / radius;
  const uz = collider.centerZ / radius;
  const edge = Math.min(collider.halfX / Math.abs(ux || 1e-12), collider.halfZ / Math.abs(uz || 1e-12));
  return { x: Math.round(collider.centerX - ux * (edge + 240) + WORLD_CENTER_PX.x), y: Math.round(collider.centerZ - uz * (edge + 240) + WORLD_CENTER_PX.y) };
}

describe('BrainChain Office ring slot navigation', () => {
  test('the standalone venue colliders are gone on client and server', () => {
    expect(getAllColliders().some((c) => c.id.startsWith('brainchain'))).toBe(false);
    expect(getServerColliders().some((c) => c.id.startsWith('brainchain'))).toBe(false);
  });

  test('client and server agree on every Office wall', () => {
    const server = getServerColliders().filter((c) => c.id.startsWith(BRAINCHAIN_OFFICE_BUILDING_ID));
    const client = getAllColliders().filter((c) => c.id.startsWith(BRAINCHAIN_OFFICE_BUILDING_ID));
    expect(server).toHaveLength(16);
    expect(client).toMatchObject(server);
  });

  test('both planners reach the Office plaza approach from spawn without crossing a collider', () => {
    for (const collider of [getBuildingFootprint(BRAINCHAIN_OFFICE_BUILDING_ID)!]) {
      const target = plazaApproach(collider);
      for (const planner of [clientPath, serverPath]) {
        const path = planner(SPAWN_PX.x, SPAWN_PX.y, target.x, target.y);
        verifyPath(path, SPAWN_PX);
        expect(path.at(-1)).toEqual(target);
      }
    }
  });
});
