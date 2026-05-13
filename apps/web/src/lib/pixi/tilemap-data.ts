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
// Radius: 72 tiles, 10 buildings at 36° spacing (2π/10), starting at top (θ=-π/2) clockwise.
// 2026-05-13: expanded ring 68 → 72 tiles to give the town-plaza inner band
// breathing room after the decoration retune packed 60 props into the
// 1500-3800wu visible annulus (was 30 in 2700-4500wu). +128wu / +5.9%.
// Practical max — R=73 puts deployment-ops zone end at tile 160 (off-map).
// center_x = round(80 + 72*cos(θ)), center_y = round(80 + 72*sin(θ))
// zone upper-left = (center_x - 7, center_y - 7)  [14×14 tile footprint]
// Ring radius in world units: 72 × 32 = 2304 wu
// Circumference / 10 = 1448 wu per slot; MAX_FOOTPRINT=1000 → 448 wu gap between buildings
// Max zone edge: deployment-ops bottom = tile 159 (1-tile map buffer).
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
  // i=0  θ=-π/2       center=(80,  8)  → visual-creation    (Pineapple House)
  { id: 'visual-creation',     x:  73, y:   1, width: 14, height: 14 },
  // i=1  θ=-3π/10     center=(122, 22) → memory-rag        (Squidward's House)
  { id: 'memory-rag',          x: 115, y:  15, width: 14, height: 14 },
  // i=2  θ=-π/10      center=(148, 58) → api-integrations  (Salty Spitoon)
  { id: 'api-integrations',    x: 141, y:  51, width: 14, height: 14 },
  // i=3  θ=+π/10      center=(148,102) → cron-automation   (Downtown Building)
  { id: 'cron-automation',     x: 141, y:  95, width: 14, height: 14 },
  // i=4  θ=+3π/10     center=(122,138) → app-publishing    (Boating School)
  { id: 'app-publishing',      x: 115, y: 131, width: 14, height: 14 },
  // i=5  θ=+π/2       center=(80, 152) → deployment-ops    (Lighthouse)
  { id: 'deployment-ops',      x:  73, y: 145, width: 14, height: 14 },
  // i=6  θ=+7π/10     center=(38, 138) → mcp-tool-use      (Krusty Krab)
  { id: 'mcp-tool-use',        x:  31, y: 131, width: 14, height: 14 },
  // i=7  θ=+9π/10     center=(12, 102) → code-development  (Chum Bucket)
  { id: 'code-development',    x:   5, y:  95, width: 14, height: 14 },
  // i=8  θ=+11π/10    center=(12,  58) → messaging-channels (Sandy's Treedome)
  { id: 'messaging-channels',  x:   5, y:  51, width: 14, height: 14 },
  // i=9  θ=+13π/10    center=(38,  22) → agent-security    (Patrick's Rock)
  { id: 'agent-security',      x:  31, y:  15, width: 14, height: 14 },
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
