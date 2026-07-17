import { describe, expect, it } from 'bun:test';
import {
  KELP_MAZE_COLLIDER_COUNT,
  KELP_MAZE_LANDMARK_COLLIDER,
  KELP_MAZE_WALL_COUNT,
  KELP_MAZE_WALLS,
} from '@clawville/shared';
import { getAllColliders } from './world-colliders';
import {
  KELP_FOREST_BLADE_COUNT,
  KELP_FOREST_TOTAL_BLADE_COUNT,
  KELP_MAZE_WALL_BLADE_COUNT,
} from '../kelp-forest';

describe('Kelp maze client collider parity', () => {
  it('maps every canonical shared wall to exactly one prop AABB', () => {
    const wallIds = new Set<string>(KELP_MAZE_WALLS.map((wall) => wall.id));
    const clientWalls = getAllColliders().filter((collider) => wallIds.has(collider.id));

    expect(clientWalls).toHaveLength(KELP_MAZE_WALL_COUNT);
    expect(clientWalls.every((wall) => wall.kind === 'prop')).toBe(true);
    expect(clientWalls.map(({ id, centerX, centerZ, halfX, halfZ }) => ({
      id, centerX, centerZ, halfX, halfZ,
    }))).toEqual(KELP_MAZE_WALLS.map((wall) => ({ ...wall })));

    const landmark = getAllColliders().filter(
      (collider) => collider.id === KELP_MAZE_LANDMARK_COLLIDER.id,
    );
    expect(KELP_MAZE_COLLIDER_COUNT).toBe(9);
    expect(landmark).toHaveLength(1);
    expect(landmark[0]).toMatchObject({ ...KELP_MAZE_LANDMARK_COLLIDER, kind: 'prop' });
  });

  it('keeps the ambient count and derives the dense wall-row budget', () => {
    expect(KELP_FOREST_BLADE_COUNT).toBe(5400);
    expect(KELP_MAZE_WALL_BLADE_COUNT).toBe(1995);
    expect(KELP_FOREST_TOTAL_BLADE_COUNT).toBe(7395);
  });
});
