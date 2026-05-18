// ---------------------------------------------------------------------------
// Tilemap data for ClawVille The Depths
// 240 x 240 grid of 32px tiles = 7680 x 7680 pixel world
// Expanded 2026-05-18 (Phase 6.1): 160→240 to accommodate R=100 building ring
// with ≥13 tiles of clearance on all sides (prev R=72 was constrained to R≤73).
// All consumers import MAP_WIDTH/MAP_HEIGHT/MAP_COLS/MAP_ROWS — no hardcodes.
// ---------------------------------------------------------------------------

export const TILE_SIZE = 32;
export const MAP_COLS = 240;
export const MAP_ROWS = 240;
export const MAP_WIDTH = MAP_COLS * TILE_SIZE; // 7680
export const MAP_HEIGHT = MAP_ROWS * TILE_SIZE; // 7680

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
// 12-building TRUE CIRCULAR ring layout in 240×240 grid, center at (120,120).
// 2026-05-17 (Phase 6.0.1): circle ring at R=72 tiles on 160×160 grid.
// 2026-05-18 (Phase 6.1): grid expanded 160→240 and ring expanded R=72→100
//   to give more breathing room between buildings and better visual separation.
//   New max safe R = 120-7 = 113 tiles; R=100 leaves 13-tile border clearance.
//
// Circle geometry:
//   Grid:   240×240 tiles, center at tile (120, 120) = world origin (0, 0, 0)
//   Radius: 100 tiles from center = 3200 wu
//   Angular spacing: 30° (π/6 rad) between slots
//   Slot 0 starts at north (top), angles increase clockwise
//   Zone footprint: 14×14 tiles (448×448 wu) — unchanged
//   Zone upper-left = (round(cx) − 7, round(cy) − 7)
//   Formula: cx = 120 + 100*cos(θ), cy = 120 + 100*sin(θ), θ = -π/2 + slot*(π/6)
//
// Slot assignment (clockwise from north):
//   Slot  0 (  0°/N)   → visual-creation    (Pineapple House)   cx=120, cy=20
//   Slot  1 ( 30°/NNE) → code-development   (Chum Bucket)       cx=170, cy=33
//   Slot  2 ( 60°/ENE) → mcp-tool-use       (Krusty Krab)       cx=207, cy=70
//   Slot  3 ( 90°/E)   → messaging-channels (Sandy's Treedome)  cx=220, cy=120
//   Slot  4 (120°/ESE) → api-integrations   (Salty Spitoon)     cx=207, cy=170
//   Slot  5 (150°/SSE) → app-publishing     (Boating School)    cx=170, cy=207
//   Slot  6 (180°/S)   → cron-automation    (Downtown Building) cx=120, cy=220
//   Slot  7 (210°/SSW) → deployment-ops     (Lighthouse)        cx=70,  cy=207
//   Slot  8 (240°/WSW) → claw-arcade        (Arcade City)       cx=33,  cy=170  [swapped 2026-05-18]
//   Slot  9 (270°/W)   → casino             (Predictive Gaming) cx=20,  cy=120  ← entertainment
//   Slot 10 (300°/WNW) → agent-security     (Patrick's Rock)    cx=33,  cy=70   [swapped 2026-05-18]
//   Slot 11 (330°/NNW) → memory-rag         (Squidward's House) cx=70,  cy=33
//
// rotY = atan2(120-cx, 120-cy) — faces building's +Z toward plaza center.
// rotY values are identical to R=72 (depend only on angle, not radius).
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
  // 12-building circular ring. R=100 tiles, center=(120,120), 30° spacing.
  // cx = 120 + 100*cos(θ), cy = 120 + 100*sin(θ), θ = -π/2 + slot*(π/6).
  // Zone upper-left = (round(cx)-7, round(cy)-7). Width/height = 14.
  // rotY = atan2(120-cx, 120-cy) so each building faces the plaza center.
  // Phase 6.1 (2026-05-18): expanded from R=72 on 160×160 to R=100 on 240×240.
  // ---------------------------------------------------------------------------

  // Slot 0 — N  (θ=-π/2):  cx=120, cy=20   → zone(113, 13)
  { id: 'visual-creation',    x: 113, y:  13, width: 14, height: 14 },
  // Slot 1 — NNE (θ=-π/3):  cx≈170, cy≈33  → zone(163, 26)
  { id: 'code-development',   x: 163, y:  26, width: 14, height: 14 },
  // Slot 2 — ENE (θ=-π/6):  cx≈207, cy≈70  → zone(200, 63)
  { id: 'mcp-tool-use',       x: 200, y:  63, width: 14, height: 14 },
  // Slot 3 — E  (θ=0):      cx=220, cy=120  → zone(213, 113)
  { id: 'messaging-channels', x: 213, y: 113, width: 14, height: 14 },
  // Slot 4 — ESE (θ=π/6):   cx≈207, cy≈170 → zone(200, 163)
  { id: 'api-integrations',   x: 200, y: 163, width: 14, height: 14 },
  // Slot 5 — SSE (θ=π/3):   cx≈170, cy≈207 → zone(163, 200)
  { id: 'app-publishing',     x: 163, y: 200, width: 14, height: 14 },
  // Slot 6 — S  (θ=π/2):    cx=120, cy=220  → zone(113, 213)
  { id: 'cron-automation',    x: 113, y: 213, width: 14, height: 14 },
  // Slot 7 — SSW (θ=2π/3):  cx≈70, cy≈207  → zone(63, 200)
  { id: 'deployment-ops',     x:  63, y: 200, width: 14, height: 14 },
  // Slot 8 — WSW (θ=5π/6):  cx≈33, cy≈170  → zone(26, 163)
  // 2026-05-18: swapped claw-arcade to slot 8 (was agent-security). Patrick's Rock moved to slot 10.
  { id: 'claw-arcade',        x:  26, y: 163, width: 14, height: 14 },
  // Slot 9 — W  (θ=π):      cx=20, cy=120   → zone(13, 113)  ← entertainment district
  { id: 'casino',             x:  13, y: 113, width: 14, height: 14 },
  // Slot 10 — WNW (θ=7π/6): cx≈33, cy≈70   → zone(26, 63)
  // 2026-05-18: swapped agent-security to slot 10 (was claw-arcade). Casino adjacency flag:
  //   claw-arcade (slot 8/WSW) is now 2 slots from casino (slot 9/W) — NO LONGER ADJACENT.
  //   Patrick's Rock (slot 10/WNW) is now adjacent to casino instead.
  { id: 'agent-security',     x:  26, y:  63, width: 14, height: 14 },
  // Slot 11 — NNW (θ=4π/3): cx≈70, cy≈33   → zone(63, 26)
  { id: 'memory-rag',         x:  63, y:  26, width: 14, height: 14 },
];

// ---------------------------------------------------------------------------
// Layer 1: GROUND  (grass base — deterministic seeded PRNG)
// 240 cols x 240 rows = 57600 tiles
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
// 240 cols x 240 rows = 57600 tiles — all empty (paths handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const pathLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 3: DECORATIONS  (trees, flowers, bushes along edges and between buildings)
// 240 cols x 240 rows = 57600 tiles — all empty (decorations handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const decorationLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 4: BUILDINGS  (building structures at each location)
// 240 cols x 240 rows = 57600 tiles — all empty (buildings handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const buildingLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);
