import { describe, expect, test } from 'bun:test';
import {
  BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME as door,
  BRAINCHAIN_OFFICE_WORLD_CENTER,
  SPAWN_PX,
  WORLD_CENTER_PX,
  getServerColliders,
  isBrainchainOfficeDoorWorld,
  isBrainchainOfficeGuideWorld,
  BRAINCHAIN_OFFICE_GUIDE_APPROACH_GAME,
} from '@clawville/shared';
import { getAllColliders } from '../three/collision/world-colliders';
import { buildingZones } from './tilemap-data';
import { findPath as clientPath } from './client-pathfinding';
import { findPath as serverPath, isSegmentCollisionFree } from '../../../../api/src/services/pathfinding';

function verifyPath(path: { x: number; y: number }[], start: { x: number; y: number }) {
  expect(path.length).toBeGreaterThan(0);
  let previous = start;
  for (const point of path) {
    expect(isSegmentCollisionFree(previous.x, previous.y, point.x, point.y, 50)).toBe(true);
    previous = point;
  }
}

describe('Office navigation agrees across client and server', () => {
  test('uses identical office and guide colliders without changing the ring cohort', () => {
    expect(buildingZones).toHaveLength(12);
    for (const id of ['brainchain-office', 'brainchain-office-guide']) {
      const server = getServerColliders().find((c) => c.id === id)!;
      const client = getAllColliders().find((c) => c.id === id)!;
      expect(server).toBeDefined();
      expect(client).toMatchObject(server);
    }
  });

  test('reaches the office beyond the former 360-tile client limit', () => {
    for (const planner of [clientPath, serverPath]) {
      const path = planner(SPAWN_PX.x, SPAWN_PX.y, door.x, door.y);
      verifyPath(path, SPAWN_PX);
      expect(path.at(-1)).toEqual(door);
      expect(isBrainchainOfficeDoorWorld(path.at(-1)!.x - WORLD_CENTER_PX.x, path.at(-1)!.y - WORLD_CENTER_PX.y)).toBe(true);
    }
  });

  test('reaches an interactable guide-only point on both planners', () => {
    const target = BRAINCHAIN_OFFICE_GUIDE_APPROACH_GAME;
    for (const planner of [clientPath, serverPath]) {
      const path = planner(door.x, door.y, target.x, target.y);
      verifyPath(path, door);
      expect(path.at(-1)).toEqual(target);
      expect(isBrainchainOfficeGuideWorld(target.x - WORLD_CENTER_PX.x, target.y - WORLD_CENTER_PX.y)).toBe(true);
      for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 4) {
        const tolerant = { x: target.x + 12 * Math.cos(angle), y: target.y + 12 * Math.sin(angle) };
        const tolerantPath = planner(door.x, door.y, tolerant.x, tolerant.y);
        expect(tolerantPath.at(-1)).toEqual(tolerant);
        expect(isBrainchainOfficeGuideWorld(tolerant.x - WORLD_CENTER_PX.x, tolerant.y - WORLD_CENTER_PX.y)).toBe(true);
      }
    }
  });

  test('compresses a straight run of grid tiles to two points', () => {
    expect(clientPath(WORLD_CENTER_PX.x + 16, WORLD_CENTER_PX.y + 1616, WORLD_CENTER_PX.x + 16 + 320, WORLD_CENTER_PX.y + 1616).length).toBe(2);
  });

  test('routes around the office without corner cuts', () => {
    const start = { x: WORLD_CENTER_PX.x + 250, y: WORLD_CENTER_PX.y - 3040 };
    const end = { x: WORLD_CENTER_PX.x + 1300, y: start.y };
    for (const planner of [clientPath, serverPath]) verifyPath(planner(start.x, start.y, end.x, end.y), start);
  });

  test('does not append a blocked exact target after the client snaps it', () => {
    const path = clientPath(door.x, door.y, WORLD_CENTER_PX.x + BRAINCHAIN_OFFICE_WORLD_CENTER.x, WORLD_CENTER_PX.y + BRAINCHAIN_OFFICE_WORLD_CENTER.z);
    verifyPath(path, door);
    expect(path.at(-1)).not.toEqual({ x: WORLD_CENTER_PX.x + BRAINCHAIN_OFFICE_WORLD_CENTER.x, y: WORLD_CENTER_PX.y + BRAINCHAIN_OFFICE_WORLD_CENTER.z });
  });

  test('retains access to all twelve ring approaches', () => {
    for (const collider of getAllColliders().filter((c) => c.kind === 'building')) {
      // Stand toward the plaza, clear of adjacent ring buildings and both safety halos.
      const radius = Math.hypot(collider.centerX, collider.centerZ);
      const ux = collider.centerX / radius;
      const uz = collider.centerZ / radius;
      const edge = Math.min(collider.halfX / Math.abs(ux || 1e-12), collider.halfZ / Math.abs(uz || 1e-12));
      const target = { x: Math.round(collider.centerX - ux * (edge + 240) + WORLD_CENTER_PX.x), y: Math.round(collider.centerZ - uz * (edge + 240) + WORLD_CENTER_PX.y) };
      for (const planner of [clientPath, serverPath]) {
        const path = planner(door.x, door.y, target.x, target.y);
        verifyPath(path, door);
        expect(path.at(-1)).toEqual(target);
      }
    }
  });
});
