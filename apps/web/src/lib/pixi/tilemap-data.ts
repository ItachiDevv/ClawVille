// ---------------------------------------------------------------------------
// Tilemap data for ClawVille The Depths
// 704 x 704 grid of 32px tiles = 22528 x 22528 pixel world
// Expanded 2026-05-18 (Phase 6.1): 160→240 to accommodate R=100 building ring.
// Expanded 2026-05-18 (Phase 6.2): 240→360 to accommodate R=160 building ring.
// Tuned 2026-05-18 (Phase 6.2.1): ring R=160→130 (5120→4160wu). Arc spacing
// ≈2178wu (vs 2680wu at R=160 which was too spaced out). 43-tile border
// clearance on all sides.
// Expanded 2026-06-15 (Phase 0 land economy): 360→576 to fit concentric land
// parcel rings. Camera.far raised to 14000, fog [6500,13500]. Center tile stays
// at MAP_COLS/2 (now 288). Building ring stays at R=130 — positions recalculated
// for new center=288. All consumers import MAP_WIDTH/MAP_HEIGHT — no hardcodes.
// Grown 2026-06-24 (land-builder-economics): 576→704 to add the new outer c-tier
// parcel ring (h=305t). UNIFORM recenter: center tile 288→352 (+64), every
// buildingZone x/y +64, every game-px coord +2048. World-space (origin-relative)
// positions stay INVARIANT — render OFFSET=-MAP_WIDTH/2 auto-shifts to -11264.
// ---------------------------------------------------------------------------

export const TILE_SIZE = 32;
export const MAP_COLS = 704;
export const MAP_ROWS = 704;
export const MAP_WIDTH = MAP_COLS * TILE_SIZE; // 22528
export const MAP_HEIGHT = MAP_ROWS * TILE_SIZE; // 22528

/** Center tile (grid / 2). Must equal MAP_COLS / 2. */
export const CENTER_TILE = MAP_COLS / 2; // 352

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
// 12-building TRUE CIRCULAR ring layout in 704x704 grid, center at (352,352).
// 2026-05-17 (Phase 6.0.1): circle ring at R=72 tiles on 160x160 grid.
// 2026-05-18 (Phase 6.1): grid expanded 160->240 and ring expanded R=72->100.
// 2026-05-18 (Phase 6.2): grid expanded 240->360 and ring expanded R=100->160.
// 2026-05-18 (Phase 6.2.1): ring tuned R=160->130 (too spaced out). Grid stays 360x360.
//   Arc spacing at R=130: 2*pi*4160/12 ~= 2178wu (was 2680wu at R=160 -- too far).
//   43-tile border clearance on all four cardinal sides.
// 2026-06-15 (Phase 0 land): grid expanded 360->576. Ring STAYS at R=130.
//   Positions recalculated for new center=288; ring footprint unchanged.
//   Border clearance: 288-130-14 = 144 tiles on all sides.
// 2026-06-24 (land-builder-economics): grid grown 576->704. Ring STAYS at R=130.
//   UNIFORM recenter: center 288->352 (+64). Every zone x/y +64. Ring footprint +
//   each building's WORLD position UNCHANGED (the +64-tile / +2048-px zone shift is
//   exactly cancelled by the +2048 MAP_HALF bump on the render OFFSET). Border
//   clearance: 352-130-14 = 208 tiles on all sides.
//
// Circle geometry:
//   Grid:   704x704 tiles, center at tile (352, 352) = world origin (0, 0, 0)
//   Radius: 130 tiles from center = 4160 wu
//   Angular spacing: 30 degrees (pi/6 rad) between slots
//   Slot 0 starts at north (top), angles increase clockwise
//   Zone footprint: 14x14 tiles (448x448 wu) -- unchanged
//   Zone upper-left = (round(cx) - 7, round(cy) - 7)
//   Formula: cx = 352 + 130*cos(theta), cy = 352 + 130*sin(theta), theta = -pi/2 + slot*(pi/6)
//
// Slot assignment (clockwise from north):
//   Slot  0 (  0/N)   -> visual-creation    (Pineapple House)   cx=352,   cy=222
//   Slot  1 ( 30/NNE) -> code-development   (Chum Bucket)       cx=417,   cy~=239
//   Slot  2 ( 60/ENE) -> mcp-tool-use       (Krusty Krab)       cx~=465,  cy=287
//   Slot  3 ( 90/E)   -> messaging-channels (Sandy's Treedome)  cx=482,   cy=352
//   Slot  4 (120/ESE) -> api-integrations   (Salty Spitoon)     cx~=465,  cy=417
//   Slot  5 (150/SSE) -> app-publishing     (Boating School)    cx=417,   cy~=465
//   Slot  6 (180/S)   -> cron-automation    (Downtown Building) cx=352,   cy=482
//   Slot  7 (210/SSW) -> deployment-ops     (Lighthouse)        cx=287,   cy~=465
//   Slot  8 (240/WSW) -> claw-arcade        (Arcade City)       cx~=239,  cy=417  [swapped 2026-05-18]
//   Slot  9 (270/W)   -> cove               (Predictive Gaming) cx=222,   cy=352  <- entertainment
//   Slot 10 (300/WNW) -> agent-security     (Patrick's Rock)    cx~=239,  cy=287  [swapped 2026-05-18]
//   Slot 11 (330/NNW) -> memory-rag         (Squidward's House) cx=287,   cy~=239
//
// rotY = atan2(352-cx, 352-cy) -- faces building's +Z toward plaza center.
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
  // 12-building circular ring. R=130 tiles, center=(352,352), 30-deg spacing.
  // cx = 352 + 130*cos(theta), cy = 352 + 130*sin(theta), theta = -pi/2 + slot*(pi/6).
  // Zone upper-left = (round(cx)-7, round(cy)-7). Width/height = 14.
  // rotY = atan2(352-cx, 352-cy) so each building faces the plaza center.
  // Land-builder-economics (2026-06-24): recentered +64 for center=352 (was 288 on
  // 576x576 grid). The +64-tile zone shift is cancelled by the +2048 render OFFSET,
  // so each building's WORLD position is UNCHANGED.
  // ---------------------------------------------------------------------------

  // Slot 0 -- N   (theta=-pi/2):  cx=352,    cy=222      -> zone(345, 215)
  { id: 'visual-creation',    x: 345, y: 215, width: 14, height: 14 },
  // Slot 1 -- NNE (theta=-pi/3):  cx=417,    cy~=239.4   -> zone(410, 232)
  { id: 'code-development',   x: 410, y: 232, width: 14, height: 14 },
  // Slot 2 -- ENE (theta=-pi/6):  cx~=464.6, cy=287      -> zone(458, 280)
  { id: 'mcp-tool-use',       x: 458, y: 280, width: 14, height: 14 },
  // Slot 3 -- E   (theta=0):      cx=482,    cy=352      -> zone(475, 345)
  { id: 'messaging-channels', x: 475, y: 345, width: 14, height: 14 },
  // Slot 4 -- ESE (theta=pi/6):   cx~=464.6, cy=417      -> zone(458, 410)
  { id: 'api-integrations',   x: 458, y: 410, width: 14, height: 14 },
  // Slot 5 -- SSE (theta=pi/3):   cx=417,    cy~=464.6   -> zone(410, 458)
  { id: 'app-publishing',     x: 410, y: 458, width: 14, height: 14 },
  // Slot 6 -- S   (theta=pi/2):   cx=352,    cy=482      -> zone(345, 475)
  { id: 'cron-automation',    x: 345, y: 475, width: 14, height: 14 },
  // Slot 7 -- SSW (theta=2pi/3):  cx=287,    cy~=464.6   -> zone(280, 458)
  { id: 'deployment-ops',     x: 280, y: 458, width: 14, height: 14 },
  // Slot 8 -- WSW (theta=5pi/6):  cx~=239.4, cy=417      -> zone(232, 410)
  // Phase 6.2: slot preserved from Phase 6.1 swap (claw-arcade at slot 8/WSW).
  { id: 'claw-arcade',        x: 232, y: 410, width: 14, height: 14 },
  // Slot 9 -- W   (theta=pi):     cx=222,    cy=352      -> zone(215, 345)  <- entertainment
  { id: 'cove',               x: 215, y: 345, width: 14, height: 14 },
  // Slot 10 -- WNW (theta=7pi/6): cx~=239.4, cy=287      -> zone(232, 280)
  // Phase 6.2: slot preserved from Phase 6.1 swap (agent-security at slot 10/WNW).
  { id: 'agent-security',     x: 232, y: 280, width: 14, height: 14 },
  // Slot 11 -- NNW (theta=4pi/3): cx=287,    cy~=239.4   -> zone(280, 232)
  { id: 'memory-rag',         x: 280, y: 232, width: 14, height: 14 },
];

// ---------------------------------------------------------------------------
// Layer 1: GROUND  (grass base -- deterministic seeded PRNG)
// 704 cols x 704 rows = 495616 tiles
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
// 704 cols x 704 rows = 495616 tiles -- all empty (paths handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const pathLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 3: DECORATIONS  (trees, flowers, bushes along edges and between buildings)
// 704 cols x 704 rows = 495616 tiles -- all empty (decorations handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const decorationLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);

// ---------------------------------------------------------------------------
// Layer 4: BUILDINGS  (building structures at each location)
// 704 cols x 704 rows = 495616 tiles -- all empty (buildings handled by 3D world)
// ---------------------------------------------------------------------------
// prettier-ignore
export const buildingLayer: number[] = Array(MAP_COLS * MAP_ROWS).fill(TILES.EMPTY);
