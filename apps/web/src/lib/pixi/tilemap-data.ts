// ---------------------------------------------------------------------------
// Tilemap data for ClawVille The Depths
// 160 x 160 grid of 32px tiles = 5120 x 5120 pixel world
// ---------------------------------------------------------------------------

export const TILE_SIZE = 32;
export const MAP_COLS = 160;
export const MAP_ROWS = 160;
export const MAP_WIDTH = MAP_COLS * TILE_SIZE; // 5120
export const MAP_HEIGHT = MAP_ROWS * TILE_SIZE; // 5120

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
// Circular ring layout in 160×160 grid, center at (80,80)
// Radius: 56 tiles, 10 buildings at 36° spacing (2π/10), starting at top (θ=-π/2) clockwise.
// center_x = round(80 + 56*cos(θ)), center_y = round(80 + 56*sin(θ))
// zone upper-left = (center_x - 7, center_y - 7)  [14×14 tile footprint]
// ---------------------------------------------------------------------------
export interface BuildingZone {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const buildingZones: BuildingZone[] = [
  // Ring order: θ = -π/2 + i*(π/5), i=0..9 (top-center, clockwise)
  // i=0  θ=-π/2       center=(80, 24)  → canvas-studio    (Biolume Studio)
  { id: 'canvas-studio',     x:  73, y:  17, width: 14, height: 14 },
  // i=1  θ=-3π/10     center=(113, 35) → memory-vault      (Abyssal Vault)
  { id: 'memory-vault',      x: 106, y:  28, width: 14, height: 14 },
  // i=2  θ=-π/10      center=(133, 63) → webhook-gateway   (Current Gateway)
  { id: 'webhook-gateway',   x: 126, y:  56, width: 14, height: 14 },
  // i=3  θ=+π/10      center=(133, 97) → cron-hub          (Tide Clock Grotto)
  { id: 'cron-hub',          x: 126, y:  90, width: 14, height: 14 },
  // i=4  θ=+3π/10     center=(113,125) → voice-tower       (Echo Spire)
  { id: 'voice-tower',       x: 106, y: 118, width: 14, height: 14 },
  // i=5  θ=+π/2       center=(80, 136) → config-citadel    (Nautilus Citadel)
  { id: 'config-citadel',    x:  73, y: 129, width: 14, height: 14 },
  // i=6  θ=+7π/10     center=(47, 125) → tool-workshop     (Salvage Workshop)
  { id: 'tool-workshop',     x:  40, y: 118, width: 14, height: 14 },
  // i=7  θ=+9π/10     center=(27,  97) → skill-forge       (Hydrothermal Forge)
  { id: 'skill-forge',       x:  20, y:  90, width: 14, height: 14 },
  // i=8  θ=+11π/10    center=(27,  63) → channel-bridge    (Coral Bridge)
  { id: 'channel-bridge',    x:  20, y:  56, width: 14, height: 14 },
  // i=9  θ=+13π/10    center=(47,  35) → security-fortress (Shell Fortress)
  { id: 'security-fortress', x:  40, y:  28, width: 14, height: 14 },
];

// ---------------------------------------------------------------------------
// Layer 1: GROUND  (grass base — deterministic seeded PRNG)
// 160 cols x 160 rows = 25600 tiles
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
// 160 cols x 160 rows = 25600 tiles — all empty (paths handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const pathLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 3: DECORATIONS  (trees, flowers, bushes along edges and between buildings)
// 160 cols x 160 rows = 25600 tiles — all empty (decorations handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const decorationLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 4: BUILDINGS  (building structures at each location)
// 160 cols x 160 rows = 25600 tiles — all empty (buildings handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const buildingLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);
