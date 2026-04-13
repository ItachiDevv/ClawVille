// ---------------------------------------------------------------------------
// Tilemap data for ClawVille The Depths
// 64 x 40 grid of 32px tiles = 2048 x 1280 pixel world
// ---------------------------------------------------------------------------

export const TILE_SIZE = 32;
export const MAP_COLS = 64;
export const MAP_ROWS = 40;
export const MAP_WIDTH = MAP_COLS * TILE_SIZE; // 2048
export const MAP_HEIGHT = MAP_ROWS * TILE_SIZE; // 1280

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

// Shorthand aliases for readability in layer arrays
const _ = TILES.EMPTY;
const G1 = TILES.GRASS_1;
const G2 = TILES.GRASS_2;
const G3 = TILES.GRASS_3;
const DP = TILES.DIRT_PATH;
const SP = TILES.STONE_PATH;
const WA = TILES.WATER;
const T1 = TILES.TREE_1;
const T2 = TILES.TREE_2;
const F1 = TILES.FLOWER_1;
const F2 = TILES.FLOWER_2;
const BU = TILES.BUSH;
const FE = TILES.FENCE;
const BS = TILES.BUILDING_SHOP;
const BL = TILES.BUILDING_LARGE;
const BX = TILES.BUILDING_SPECIAL;
const SM = TILES.BUILDING_SMALL;
const RR = TILES.ROOF_RED;
const RB = TILES.ROOF_BLUE;
const RG = TILES.ROOF_GREEN;
const DR = TILES.DOOR;
const WN = TILES.WINDOW;

// ---------------------------------------------------------------------------
// Building positions (tile coords)
// Wider ring in 64×40 grid (semi-major X=26, semi-minor Y=16 from center 32,20)
// ---------------------------------------------------------------------------
export interface BuildingZone {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const buildingZones: BuildingZone[] = [
  // Circular village — wider ring in 64×40 tile grid, village center at (32, 20)
  { id: 'canvas-studio',       x: 29, y: 2,  width: 4, height: 3 },  // TOP CENTER
  { id: 'memory-vault',        x: 45, y: 4,  width: 4, height: 3 },  // TOP RIGHT
  { id: 'webhook-gateway',     x: 54, y: 12, width: 4, height: 3 },  // RIGHT
  { id: 'cron-hub',            x: 54, y: 22, width: 4, height: 3 },  // RIGHT LOW
  { id: 'voice-tower',         x: 44, y: 32, width: 4, height: 3 },  // BOTTOM RIGHT
  { id: 'config-citadel',      x: 30, y: 35, width: 4, height: 3 },  // BOTTOM CENTER
  { id: 'tool-workshop',       x: 14, y: 32, width: 4, height: 3 },  // BOTTOM LEFT
  { id: 'skill-forge',         x: 6,  y: 22, width: 4, height: 3 },  // LEFT LOW
  { id: 'channel-bridge',      x: 6,  y: 12, width: 4, height: 4 },  // LEFT
  { id: 'security-fortress',   x: 15, y: 4,  width: 4, height: 3 },  // TOP LEFT
];

// ---------------------------------------------------------------------------
// Layer 1: GROUND  (grass base + water at Rainbow Pool area)
// 64 cols x 40 rows = 2560 tiles
// ---------------------------------------------------------------------------
// prettier-ignore
export const groundLayer: number[] = [
  // Row 0
  G1,G2,G1,G3,G1,G2,G1,G1,G2,G3,G1,G2,G1,G3,G2,G1,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,
  // Row 1
  G2,G1,G3,G1,G2,G1,G3,G2,G1,G1,G2,G3,G1,G2,G1,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G3,G1,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,
  // Row 2
  G1,G3,G2,G1,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,
  // Row 3
  G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,
  // Row 4
  G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,
  // Row 5
  G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,
  // Row 6
  G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,
  // Row 7
  G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,
  // Row 8
  G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,
  // Row 9
  G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,G2,
  // Row 10
  G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,
  // Row 11
  G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G2,G3,G1,
  // Row 12
  G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,
  // Row 13
  G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G1,G3,G2,G1,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,
  // Row 14
  G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G2,G1,G3,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,
  // Row 15
  G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,
  // Row 16
  G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,
  // Row 17
  G2,G1,G3,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G3,G1,G2,G1,G3,G2,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G1,
  // Row 18 — Rainbow Pool water area at cols 32-35
  G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G1,G2,G3,G2,G1,G2,G3,G1,G2,G3,G2,G1,WA,WA,WA,WA,G2,G1,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,
  // Row 19 — Rainbow Pool water continues
  G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,WA,WA,WA,WA,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,
  // Row 20 — Rainbow Pool water continues
  G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,WA,WA,WA,WA,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G2,G3,G1,G2,G1,
  // Row 21
  G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G1,G2,G3,G1,G2,
  // Row 22
  G3,G1,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,
  // Row 23
  G2,G3,G1,G2,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G2,G1,G3,G2,G1,
  // Row 24
  G1,G2,G3,G1,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,
  // Row 25
  G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,
  // Row 26
  G2,G1,G3,G2,G1,G2,G1,G3,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,
  // Row 27
  G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,
  // Row 28
  G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,
  // Row 29
  G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,
  // Row 30
  G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,
  // Row 31
  G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,
  // Row 32
  G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,
  // Row 33
  G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,
  // Row 34
  G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,
  // Row 35
  G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,
  // Row 36
  G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G2,G3,G1,G2,
  // Row 37
  G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,
  // Row 38
  G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G1,
  // Row 39 — bottom edge
  G2,G3,G1,G2,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G2,G1,G3,G2,G1,
];

// ---------------------------------------------------------------------------
// Layer 2: PATHS  (dirt paths connecting buildings, stone at entrances)
// 64 cols x 40 rows = 2560 tiles — all empty (paths handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const pathLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 3: DECORATIONS  (trees, flowers, bushes along edges and between buildings)
// 64 cols x 40 rows = 2560 tiles — all empty (decorations handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const decorationLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 4: BUILDINGS  (building structures at each location)
// 64 cols x 40 rows = 2560 tiles — all empty (buildings handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const buildingLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);
