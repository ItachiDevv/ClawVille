import { describe, expect, it } from 'bun:test';
import {
  ENTITY_HALF_CHIBI,
  KELP_MAZE_COLLIDER_COUNT,
  KELP_MAZE_ENTRY,
  KELP_MAZE_LANDMARK,
  KELP_MAZE_LANDMARK_COLLIDER,
  KELP_MAZE_PATH_WIDTH_WU,
  KELP_MAZE_PHOTO_SPOT,
  KELP_MAZE_WALL_COUNT,
  KELP_MAZE_WALLS,
  WORLD_COLLIDER_MAP_HALF,
  getServerColliders,
} from '@clawville/shared';
import {
  findPath,
  isCollisionFreeWorld,
  isPathCollisionFree,
  isSegmentCollisionFree,
} from './pathfinding';

function gamePx(worldCoord: number): number {
  return worldCoord + WORLD_COLLIDER_MAP_HALF;
}

describe('Kelp maze human/agent navigation parity', () => {
  it('uses the canonical shared AABBs for every server collider', () => {
    const wallIds = new Set<string>(KELP_MAZE_WALLS.map((wall) => wall.id));
    const serverWalls = getServerColliders().filter((collider) => wallIds.has(collider.id));

    expect(KELP_MAZE_WALL_COUNT).toBe(8);
    expect(new Set(KELP_MAZE_WALLS.map((wall) => wall.id)).size).toBe(KELP_MAZE_WALL_COUNT);
    expect(serverWalls).toHaveLength(KELP_MAZE_WALL_COUNT);
    expect(serverWalls.map(({ id, centerX, centerZ, halfX, halfZ }) => ({
      id, centerX, centerZ, halfX, halfZ,
    }))).toEqual(KELP_MAZE_WALLS.map((wall) => ({ ...wall })));
    expect(serverWalls.every((wall) =>
      wall.pathfindingRaster?.mode === 'cell-center-expanded-aabb'
      && wall.pathfindingRaster.paddingWu === ENTITY_HALF_CHIBI
    )).toBe(true);

    const landmark = getServerColliders().filter(
      (collider) => collider.id === KELP_MAZE_LANDMARK_COLLIDER.id,
    );
    expect(KELP_MAZE_COLLIDER_COUNT).toBe(9);
    expect(landmark).toHaveLength(1);
    expect(landmark[0]).toMatchObject(KELP_MAZE_LANDMARK_COLLIDER);
    expect(landmark[0]?.pathfindingRaster).toEqual({
      mode: 'cell-center-expanded-aabb',
      paddingWu: ENTITY_HALF_CHIBI,
    });
  });

  it('leaves body clearance and routes from the south entry to the photo spot', () => {
    expect(KELP_MAZE_PATH_WIDTH_WU).toBeGreaterThan(ENTITY_HALF_CHIBI * 2);
    expect(KELP_MAZE_PATH_WIDTH_WU - ENTITY_HALF_CHIBI * 2).toBe(25);

    const startX = gamePx(KELP_MAZE_ENTRY.approachWorldX);
    const startY = gamePx(KELP_MAZE_ENTRY.approachWorldZ);
    const targetX = gamePx(KELP_MAZE_PHOTO_SPOT.worldX);
    const targetY = gamePx(KELP_MAZE_PHOTO_SPOT.worldZ);
    const path = findPath(startX, startY, targetX, targetY);

    expect(isCollisionFreeWorld(targetX, targetY, ENTITY_HALF_CHIBI)).toBe(true);
    expect(path.length).toBeGreaterThan(0);
    expect(isPathCollisionFree(startX, startY, path, ENTITY_HALF_CHIBI)).toBe(true);
  });

  it('rejects the direct segment through the switchback walls', () => {
    expect(isSegmentCollisionFree(
      gamePx(KELP_MAZE_ENTRY.approachWorldX),
      gamePx(KELP_MAZE_ENTRY.approachWorldZ),
      gamePx(KELP_MAZE_PHOTO_SPOT.worldX),
      gamePx(KELP_MAZE_PHOTO_SPOT.worldZ),
      ENTITY_HALF_CHIBI,
    )).toBe(false);
  });

  it('rejects a segment from the photo spot through the landmark', () => {
    expect(isSegmentCollisionFree(
      gamePx(KELP_MAZE_PHOTO_SPOT.worldX),
      gamePx(KELP_MAZE_PHOTO_SPOT.worldZ),
      gamePx(KELP_MAZE_LANDMARK.worldX),
      gamePx(KELP_MAZE_LANDMARK.worldZ),
      ENTITY_HALF_CHIBI,
    )).toBe(false);
  });
});
