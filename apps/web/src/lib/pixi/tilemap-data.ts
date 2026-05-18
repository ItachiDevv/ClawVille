// ---------------------------------------------------------------------------
// Tilemap data for ClawVille The Depths
// 360 x 360 grid of 32px tiles = 11520 x 11520 pixel world
// Expanded 2026-05-18 (Phase 6.1): 160→240 to accommodate R=100 building ring.
// Expanded 2026-05-18 (Phase 6.2): 240→360 to accommodate R=160 building ring.
// Tuned 2026-05-18 (Phase 6.2.1): ring R=160→130 (5120→4160wu). Arc spacing
// ≈2178wu (vs 2680wu at R=160 which was too spaced out). 43-tile border
// clearance on all sides. Grid stays at 360×360 — no expansion needed.
// All consumers import MAP_WIDTH/MAP_HEIGHT/MAP_COLS/MAP_ROWS — no hardcodes.
// ---------------------------------------------------------------------------

export const TILE_SIZE = 32;
export const MAP_COLS = 360;
export const MAP_ROWS = 360;
export const MAP_WIDTH = MAP_COLS * TILE_SIZE; // 11520
export const MAP_HEIGHT = MAP_ROWS * TILE_SIZE; // 11520

/** Center tile (grid / 2). Must equal MAP_COLS / 2. */
export const CENTER_TILE = MAP_COLS / 2; // 180

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
// 12-building TRUE CIRCULAR ring layout in 360×360 grid, center at (180,180).
// 2026-05-17 (Phase 6.0.1): circle ring at R=72 tiles on 160×160 grid.
// 2026-05-18 (Phase 6.1): grid expanded 160→240 and ring expanded R=72→100.
// 2026-05-18 (Phase 6.2): grid expanded 240→360 and ring expanded R=100→160.
// 2026-05-18 (Phase 6.2.1): ring tuned R=160→130 (too spaced out). Grid stays 360×360.
//   Arc spacing at R=130: 2π×4160/12 ≈ 2178wu (was 2680wu at R=160 — too far).
//   43-tile border clearance on all four cardinal sides.
//
// Circle geometry:
//   Grid:   360×360 tiles, center at tile (180, 180) = world origin (0, 0, 0)
//   Radius: 130 tiles from center = 4160 wu
//   Angular spacing: 30° (π/6 rad) between slots
//   Slot 0 starts at north (top), angles increase clockwise
//   Zone footprint: 14×14 tiles (448×448 wu) — unchanged
//   Zone upper-left = (round(cx) − 7, round(cy) − 7)
//   Formula: cx = 180 + 130*cos(θ), cy = 180 + 130*sin(θ), θ = -π/2 + slot*(π/6)
//
// Slot assignment (clockwise from north):
//   Slot  0 (  0°/N)   → visual-creation    (Pineapple House)   cx=180, cy=50
//   Slot  1 ( 30°/NNE) → code-development   (Chum Bucket)       cx=245, cy=67
//   Slot  2 ( 60°/ENE) → mcp-tool-use       (Krusty Krab)       cx=293, cy=115
//   Slot  3 ( 90°/E)   → messaging-channels (Sandy's Treedome)  cx=310, cy=180
//   Slot  4 (120°/ESE) → api-integrations   (Salty Spitoon)     cx=293, cy=245
//   Slot  5 (150°/SSE) → app-publishing     (Boating School)    cx=245, cy=293
//   Slot  6 (180°/S)   → cron-automation    (Downtown Building) cx=180, cy=310
//   Slot  7 (210°/SSW) → deployment-ops     (Lighthouse)        cx=115, cy=293
//   Slot  8 (240°/WSW) → claw-arcade        (Arcade City)       cx=67,  cy=245  [swapped 2026-05-18]
//   Slot  9 (270°/W)   → casino             (Predictive Gaming) cx=50,  cy=180  ← entertainment
//   Slot 10 (300°/WNW) → agent-security     (Patrick's Rock)    cx=67,  cy=115  [swapped 2026-05-18]
//   Slot 11 (330°/NNW) → memory-rag         (Squidward's House) cx=115, cy=67
//
// rotY = atan2(180-cx, 180-cy) — faces building's +Z toward plaza center.
// rotY values are nearly identical to R=160 (depend only on angle direction).
//
// The 12 building IDs are PRESERVED — only positions updated.
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
  // 12-building circular ring. R=130 tiles, center=(180,180), 30° spacing.
  // cx = 180 + 130*cos(θ), cy = 180 + 130*sin(θ), θ = -π/2 + slot*(π/6).
  // Zone upper-left = (round(cx)-7, round(cy)-7). Width/height = 14.
  // rotY = atan2(180-cx, 180-cy) so each building faces the plaza center.
  // Phase 6.2.1 (2026-05-18): tuned from R=160 on 360×360 to R=130 on 360×360.
  // ---------------------------------------------------------------------------

  // Slot 0 — N  (θ=-π/2):  cx=180, cy=50   → zone(173, 43)
  { id: 'visual-creation',    x: 173, y:  43, width: 14, height: 14 },
  // Slot 1 — NNE (θ=-π/3):  cx=245, cy≈67  → zone(238, 60)
  { id: 'code-development',   x: 238, y:  60, width: 14, height: 14 },
  // Slot 2 — ENE (θ=-π/6):  cx≈293, cy=115 → zone(286, 108)
  { id: 'mcp-tool-use',       x: 286, y: 108, width: 14, height: 14 },
  // Slot 3 — E  (θ=0):      cx=310, cy=180  → zone(303, 173)
  { id: 'messaging-channels', x: 303, y: 173, width: 14, height: 14 },
  // Slot 4 — ESE (θ=π/6):   cx≈293, cy=245 → zone(286, 238)
  { id: 'api-integrations',   x: 286, y: 238, width: 14, height: 14 },
  // Slot 5 — SSE (θ=π/3):   cx=245, cy≈293 → zone(238, 286)
  { id: 'app-publishing',     x: 238, y: 286, width: 14, height: 14 },
  // Slot 6 — S  (θ=π/2):    cx=180, cy=310  → zone(173, 303)
  { id: 'cron-automation',    x: 173, y: 303, width: 14, height: 14 },
  // Slot 7 — SSW (θ=2π/3):  cx=115, cy≈293  → zone(108, 286)
  { id: 'deployment-ops',     x: 108, y: 286, width: 14, height: 14 },
  // Slot 8 — WSW (θ=5π/6):  cx≈67,  cy=245  → zone(60, 238)
  // Phase 6.2: slot preserved from Phase 6.1 swap (claw-arcade at slot 8/WSW).
  { id: 'claw-arcade',        x:  60, y: 238, width: 14, height: 14 },
  // Slot 9 — W  (θ=π):      cx=50,  cy=180  → zone(43, 173)  ← entertainment district
  { id: 'casino',             x:  43, y: 173, width: 14, height: 14 },
  // Slot 10 — WNW (θ=7π/6): cx≈67,  cy=115  → zone(60, 108)
  // Phase 6.2: slot preserved from Phase 6.1 swap (agent-security at slot 10/WNW).
  { id: 'agent-security',     x:  60, y: 108, width: 14, height: 14 },
  // Slot 11 — NNW (θ=4π/3): cx=115, cy≈67   → zone(108, 60)
  { id: 'memory-rag',         x: 108, y:  60, width: 14, height: 14 },
];

// ---------------------------------------------------------------------------
// Layer 1: GROUND  (grass base — deterministic seeded PRNG)
// 360 cols x 360 rows = 129600 tiles
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
