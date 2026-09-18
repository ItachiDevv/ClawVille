import { describe, expect, test } from 'bun:test';
import { isAtTownSpawn } from '../spawn-on-load';
import { MAP_HEIGHT, MAP_WIDTH } from '@/lib/pixi/tilemap-data';
import { COVE_EXIT_WORLD_X, COVE_EXIT_WORLD_Z } from '@/lib/three/character-positions';
import { KELP_FOREST_EXIT_WORLD } from '@/lib/three/kelp-forest-location';

// Regression (found 2026-09-18): after a refresh inside the cove, "Back to
// World" placed the avatar at the cove door and THEN /game mounted, so
// SpawnOnLoad read the door as "the page-load spawn" and sent a home-spawn
// player to their home parcel. It must only move a real town spawn.

const TOWN_X = MAP_WIDTH / 2;
const TOWN_Y = MAP_HEIGHT / 2 + 540;

describe('isAtTownSpawn', () => {
  test('the scattered town spawn counts, at every corner of the scatter box', () => {
    for (const [dx, dy] of [[0, 0], [200, 180], [-200, -180], [200, -180], [-200, 180]]) {
      expect(isAtTownSpawn(TOWN_X + dx, TOWN_Y + dy)).toBe(true);
    }
  });

  test('the cove and kelp exits do not', () => {
    expect(isAtTownSpawn(MAP_WIDTH / 2 + COVE_EXIT_WORLD_X, MAP_HEIGHT / 2 + COVE_EXIT_WORLD_Z)).toBe(false);
    expect(isAtTownSpawn(MAP_WIDTH / 2 + KELP_FOREST_EXIT_WORLD.x, MAP_HEIGHT / 2 + KELP_FOREST_EXIT_WORLD.z)).toBe(false);
  });

  test('just outside the scatter box does not', () => {
    expect(isAtTownSpawn(TOWN_X + 201, TOWN_Y)).toBe(false);
    expect(isAtTownSpawn(TOWN_X, TOWN_Y - 181)).toBe(false);
  });
});
