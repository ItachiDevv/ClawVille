// ---------------------------------------------------------------------------
// Tilemap data for ClawVille The Depths
// 576 x 576 grid of 32px tiles = 18432 x 18432 pixel world
// Expanded 2026-05-18 (Phase 6.1): 160→240 to accommodate R=100 building ring.
// Expanded 2026-05-18 (Phase 6.2): 240→360 to accommodate R=160 building ring.
// Tuned 2026-05-18 (Phase 6.2.1): ring R=160→130 (5120→4160wu). Arc spacing
// ≈2178wu (vs 2680wu at R=160 which was too spaced out). 43-tile border
// clearance on all sides.
// Expanded 2026-06-15 (Phase 0 land economy): 360→576 to fit concentric land
// parcel rings. Camera.far raised to 14000, fog [6500,13500]. Center tile stays
// at MAP_COLS/2 (now 288). Building ring stays at R=130 — positions recalculated
// for new center=288. All consumers import MAP_WIDTH/MAP_HEIGHT — no hardcodes.
// ---------------------------------------------------------------------------

export const TILE_SIZE = 32;
export const MAP_COLS = 576;
export const MAP_ROWS = 576;
export const MAP_WIDTH = MAP_COLS * TILE_SIZE; // 18432
export const MAP_HEIGHT = MAP_ROWS * TILE_SIZE; // 18432

/** Center tile (grid / 2). Must equal MAP_COLS / 2. */
export const CENTER_TILE = MAP_COLS / 2; // 288

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
// 12-building TRUE CIRCULAR ring layout in 576x576 grid, center at (288,288).
// 2026-05-17 (Phase 6.0.1): circle ring at R=72 tiles on 160x160 grid.
// 2026-05-18 (Phase 6.1): grid expanded 160->240 and ring expanded R=72->100.
// 2026-05-18 (Phase 6.2): grid expanded 240->360 and ring expanded R=100->160.
// 2026-05-18 (Phase 6.2.1): ring tuned R=160->130 (too spaced out). Grid stays 360x360.
//   Arc spacing at R=130: 2*pi*4160/12 ~= 2178wu (was 2680wu at R=160 -- too far).
//   43-tile border clearance on all four cardinal sides.
// 2026-06-15 (Phase 0 land): grid expanded 360->576. Ring STAYS at R=130.
//   Positions recalculated for new center=288; ring footprint unchanged.
//   Border clearance: 288-130-14 = 144 tiles on all sides.
//
// Circle geometry:
//   Grid:   576x576 tiles, center at tile (288, 288) = world origin (0, 0, 0)
//   Radius: 130 tiles from center = 4160 wu
//   Angular spacing: 30 degrees (pi/6 rad) between slots
//   Slot 0 starts at north (top), angles increase clockwise
//   Zone footprint: 14x14 tiles (448x448 wu) -- unchanged
//   Zone upper-left = (round(cx) - 7, round(cy) - 7)
//   Formula: cx = 288 + 130*cos(theta), cy = 288 + 130*sin(theta), theta = -pi/2 + slot*(pi/6)
//
// Slot assignment (clockwise from north):
//   Slot  0 (  0/N)   -> visual-creation    (Pineapple House)   cx=288,   cy=158
//   Slot  1 ( 30/NNE) -> code-development   (Chum Bucket)       cx=353,   cy~=175
//   Slot  2 ( 60/ENE) -> mcp-tool-use       (Krusty Krab)       cx~=401,  cy=223
//   Slot  3 ( 90/E)   -> messaging-channels (Sandy's Treedome)  cx=418,   cy=288
//   Slot  4 (120/ESE) -> api-integrations   (Salty Spitoon)     cx~=401,  cy=353
//   Slot  5 (150/SSE) -> app-publishing     (Boating School)    cx=353,   cy~=401
//   Slot  6 (180/S)   -> cron-automation    (Downtown Building) cx=288,   cy=418
//   Slot  7 (210/SSW) -> deployment-ops     (Lighthouse)        cx=223,   cy~=401
//   Slot  8 (240/WSW) -> claw-arcade        (Arcade City)       cx~=175,  cy=353  [swapped 2026-05-18]
//   Slot  9 (270/W)   -> cove               (Predictive Gaming) cx=158,   cy=288  <- entertainment
//   Slot 10 (300/WNW) -> agent-security     (Patrick's Rock)    cx~=175,  cy=223  [swapped 2026-05-18]
//   Slot 11 (330/NNW) -> memory-rag         (Squidward's House) cx=223,   cy~=175
//
// rotY = atan2(288-cx, 288-cy) -- faces building's +Z toward plaza center.
// rotY values identical to old layout (angles unchanged -- same R, same spacing).
//
// The 12 building IDs are PRESERVED -- only positions updated for new center.
// All consumer code (arena-buildings.tsx, minimap.tsx, PixiCanvas.tsx,
// map-locations.ts) reads buildingZones from here -- update propagates.
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
  // 12-building circular ring. R=130 tiles, center=(288,288), 30-deg spacing.
  // cx = 288 + 130*cos(theta), cy = 288 + 130*sin(theta), theta = -pi/2 + slot*(pi/6).
  // Zone upper-left = (round(cx)-7, round(cy)-7). Width/height = 14.
  // rotY = atan2(288-cx, 288-cy) so each building faces the plaza center.
  // Phase 0 land (2026-06-15): recalculated for center=288 (was 180 on 360x360 grid).
  // ---------------------------------------------------------------------------

  // Slot 0 -- N   (theta=-pi/2):  cx=288,    cy=158      -> zone(281, 151)
  { id: 'visual-creation',    x: 281, y: 151, width: 14, height: 14 },
  // Slot 1 -- NNE (theta=-pi/3):  cx=353,    cy~=175.4   -> zone(346, 168)
  { id: 'code-development',   x: 346, y: 168, width: 14, height: 14 },
  // Slot 2 -- ENE (theta=-pi/6):  cx~=400.6, cy=223      -> zone(394, 216)
  { id: 'mcp-tool-use',       x: 394, y: 216, width: 14, height: 14 },
  // Slot 3 -- E   (theta=0):      cx=418,    cy=288      -> zone(411, 281)
  { id: 'messaging-channels', x: 411, y: 281, width: 14, height: 14 },
  // Slot 4 -- ESE (theta=pi/6):   cx~=400.6, cy=353      -> zone(394, 346)
  { id: 'api-integrations',   x: 394, y: 346, width: 14, height: 14 },
  // Slot 5 -- SSE (theta=pi/3):   cx=353,    cy~=400.6   -> zone(346, 394)
  { id: 'app-publishing',     x: 346, y: 394, width: 14, height: 14 },
  // Slot 6 -- S   (theta=pi/2):   cx=288,    cy=418      -> zone(281, 411)
  { id: 'cron-automation',    x: 281, y: 411, width: 14, height: 14 },
  // Slot 7 -- SSW (theta=2pi/3):  cx=223,    cy~=400.6   -> zone(216, 394)
  { id: 'deployment-ops',     x: 216, y: 394, width: 14, height: 14 },
  // Slot 8 -- WSW (theta=5pi/6):  cx~=175.4, cy=353      -> zone(168, 346)
  // Phase 6.2: slot preserved from Phase 6.1 swap (claw-arcade at slot 8/WSW).
  { id: 'claw-arcade',        x: 168, y: 346, width: 14, height: 14 },
  // Slot 9 -- W   (theta=pi):     cx=158,    cy=288      -> zone(151, 281)  <- entertainment
  { id: 'cove',               x: 151, y: 281, width: 14, height: 14 },
  // Slot 10 -- WNW (theta=7pi/6): cx~=175.4, cy=223      -> zone(168, 216)
  // Phase 6.2: slot preserved from Phase 6.1 swap (agent-security at slot 10/WNW).
  { id: 'agent-security',     x: 168, y: 216, width: 14, height: 14 },
  // Slot 11 -- NNW (theta=4pi/3): cx=223,    cy~=175.4   -> zone(216, 168)
  { id: 'memory-rag',         x: 216, y: 168, width: 14, height: 14 },
];

// ---------------------------------------------------------------------------
// Layer 1: GROUND  (grass base -- deterministic seeded PRNG)
// 576 cols x 576 rows = 331776 tiles
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
// 576 cols x 576 rows = 331776 tiles -- all empty (paths handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const pathLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 3: DECORATIONS  (trees, flowers, bushes along edges and between buildings)
// 576 cols x 576 rows = 331776 tiles -- all empty (decorations handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const decorationLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 4: BUILDINGS  (building structures at each location)
// 576 cols x 576 rows = 331776 tiles -- all empty (buildings handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const buildingLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);
