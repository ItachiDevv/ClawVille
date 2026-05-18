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
// 12-building TRUE CIRCULAR ring layout in 160×160 grid, center at (80,80).
// 2026-05-17 (Phase 6.0.1): first pass used a square ring (3 per side).
// 2026-05-17 (circle revert): reverted to true circle — 12 buildings at 30°
// angular spacing, radius 72 tiles. Matches the minimap dashed-circle guide.
//
// Circle geometry:
//   Radius: 72 tiles from center (80, 80) = 2304 wu
//   Angular spacing: 30° (π/6 rad) between slots
//   Slot 0 starts at north (top), angles increase clockwise
//   Zone footprint: 14×14 tiles (448×448 wu) — unchanged
//   Zone upper-left = (round(cx) − 7, round(cy) − 7)
//
// Slot assignment (clockwise from north):
//   Slot  0 (  0°/N)   → visual-creation    (Pineapple House)
//   Slot  1 ( 30°/NNE) → code-development   (Chum Bucket)
//   Slot  2 ( 60°/ENE) → mcp-tool-use       (Krusty Krab)
//   Slot  3 ( 90°/E)   → messaging-channels (Sandy's Treedome)
//   Slot  4 (120°/SSE) → api-integrations   (Salty Spitoon)
//   Slot  5 (150°/SSE) → app-publishing     (Boating School)
//   Slot  6 (180°/S)   → cron-automation    (Downtown Building)
//   Slot  7 (210°/SSW) → deployment-ops     (Lighthouse)
//   Slot  8 (240°/WSW) → agent-security     (Patrick's Rock)
//   Slot  9 (270°/W)   → casino             (Predictive Gaming Cove) ─┐ entertainment
//   Slot 10 (300°/WNW) → claw-arcade        (Arcade City)     ┘ district — adjacent
//   Slot 11 (330°/NNW) → memory-rag         (Squidward's House)
//
// The 10 original building IDs are PRESERVED — only positions updated.
// All consumer code (arena-buildings.tsx, minimap.tsx, PixiCanvas.tsx,
// map-locations.ts) reads buildingZones from here — update propagates.
// ---------------------------------------------------------------------------
export interface BuildingZone {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const buildingZones: BuildingZone[] = [
  // ---------------------------------------------------------------------------
  // 12-building circular ring. R=72 tiles, center=(80,80), 30° spacing.
  // cx = 80 + 72*cos(θ), cy = 80 + 72*sin(θ), θ = -π/2 + slot*(π/6).
  // Zone upper-left = (round(cx)-7, round(cy)-7). Width/height = 14.
  // rotY = atan2(80-cx, 80-cy) so each building faces the plaza center.
  // ---------------------------------------------------------------------------

  // Slot 0 — N  (θ=-π/2):  cx=80, cy=8
  { id: 'visual-creation',    x:  73, y:   1, width: 14, height: 14 },
  // Slot 1 — NNE (θ=-π/3):  cx≈116, cy≈18
  { id: 'code-development',   x: 109, y:  11, width: 14, height: 14 },
  // Slot 2 — ENE (θ=-π/6):  cx≈142, cy≈44
  { id: 'mcp-tool-use',       x: 135, y:  37, width: 14, height: 14 },
  // Slot 3 — E  (θ=0):      cx=152, cy=80
  { id: 'messaging-channels', x: 145, y:  73, width: 14, height: 14 },
  // Slot 4 — ESE (θ=π/6):   cx≈142, cy≈116
  { id: 'api-integrations',   x: 135, y: 109, width: 14, height: 14 },
  // Slot 5 — SSE (θ=π/3):   cx≈116, cy≈142
  { id: 'app-publishing',     x: 109, y: 135, width: 14, height: 14 },
  // Slot 6 — S  (θ=π/2):    cx=80, cy=152
  { id: 'cron-automation',    x:  73, y: 145, width: 14, height: 14 },
  // Slot 7 — SSW (θ=2π/3):  cx≈44, cy≈142
  { id: 'deployment-ops',     x:  37, y: 135, width: 14, height: 14 },
  // Slot 8 — WSW (θ=5π/6):  cx≈18, cy≈116
  { id: 'agent-security',     x:  11, y: 109, width: 14, height: 14 },
  // Slot 9 — W  (θ=π):      cx=8, cy=80     ← entertainment district
  { id: 'casino',             x:   1, y:  73, width: 14, height: 14 },
  // Slot 10 — WNW (θ=7π/6): cx≈18, cy≈44   ← entertainment district (adjacent to casino)
  { id: 'claw-arcade',        x:  11, y:  37, width: 14, height: 14 },
  // Slot 11 — NNW (θ=4π/3): cx≈44, cy≈18
  { id: 'memory-rag',         x:  37, y:  11, width: 14, height: 14 },
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
