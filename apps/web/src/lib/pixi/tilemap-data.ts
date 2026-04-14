// ---------------------------------------------------------------------------
// Tilemap data for ClawVille The Depths
// 80 x 80 grid of 32px tiles = 2560 x 2560 pixel world
// ---------------------------------------------------------------------------

export const TILE_SIZE = 32;
export const MAP_COLS = 80;
export const MAP_ROWS = 80;
export const MAP_WIDTH = MAP_COLS * TILE_SIZE; // 2560
export const MAP_HEIGHT = MAP_ROWS * TILE_SIZE; // 2560

/** Tile indices matching the tileset spritesheet columns */
export const TILES = {
  EMPTY: -1,
  GRASS_1: 0,
  GRASS_2: 1,
  GRASS_3: 2,
  DIRT_PATH: 3,
  STONE_PATH: 4,
  WATER: 5,
  TREE_1: 6,
  TREE_2: 7,
  FLOWER_1: 8,
  FLOWER_2: 9,
  BUSH: 10,
  FENCE: 11,
  BUILDING_SHOP: 12,
  BUILDING_LARGE: 13,
  BUILDING_SPECIAL: 14,
  BUILDING_SMALL: 15,
  ROOF_RED: 16,
  ROOF_BLUE: 17,
  ROOF_GREEN: 18,
  DOOR: 19,
  WINDOW: 20,
} as const;

export type TileIndex = (typeof TILES)[keyof typeof TILES];

// ---------------------------------------------------------------------------
// Building positions (tile coords)
// Circular ring in 80×80 grid, radius 28 tiles from center (40,40)
// ---------------------------------------------------------------------------
export interface BuildingZone {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const buildingZones: BuildingZone[] = [
  { id: 'canvas-studio',       x: 38, y: 10, width: 5, height: 4 },  // TOP CENTER
  { id: 'memory-vault',        x: 54, y: 15, width: 5, height: 4 },  // TOP RIGHT
  { id: 'webhook-gateway',     x: 65, y: 29, width: 5, height: 4 },  // RIGHT
  { id: 'cron-hub',            x: 65, y: 47, width: 5, height: 4 },  // RIGHT LOW
  { id: 'voice-tower',         x: 54, y: 61, width: 5, height: 4 },  // BOTTOM RIGHT
  { id: 'config-citadel',      x: 38, y: 66, width: 5, height: 4 },  // BOTTOM CENTER
  { id: 'tool-workshop',       x: 22, y: 61, width: 5, height: 4 },  // BOTTOM LEFT
  { id: 'skill-forge',         x: 11, y: 47, width: 5, height: 4 },  // LEFT LOW
  { id: 'channel-bridge',      x: 11, y: 29, width: 5, height: 5 },  // LEFT
  { id: 'security-fortress',   x: 22, y: 15, width: 5, height: 4 },  // TOP LEFT
];

// ---------------------------------------------------------------------------
// Layer 1: GROUND  (grass base — deterministic seeded PRNG)
// 80 cols x 80 rows = 6400 tiles
// ---------------------------------------------------------------------------
function generateGroundLayer(): number[] {
  const tiles = [TILES.GRASS_1, TILES.GRASS_2, TILES.GRASS_3];
  const result: number[] = [];
  let seed = 42;
  for (let i = 0; i < MAP_COLS * MAP_ROWS; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    result.push(tiles[seed % 3]);
  }
  return result;
}
export const groundLayer: number[] = generateGroundLayer();

// ---------------------------------------------------------------------------
// Layer 2: PATHS  (dirt paths connecting buildings, stone at entrances)
// 80 cols x 80 rows = 6400 tiles — all empty (paths handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const pathLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 3: DECORATIONS  (trees, flowers, bushes along edges and between buildings)
// 80 cols x 80 rows = 6400 tiles — all empty (decorations handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const decorationLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 4: BUILDINGS  (building structures at each location)
// 80 cols x 80 rows = 6400 tiles — all empty (buildings handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const buildingLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);
