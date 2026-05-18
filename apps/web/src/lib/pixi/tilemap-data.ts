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
// 12-building SQUARE ring layout in 160×160 grid, center at (80,80).
// 2026-05-17 (Phase 6.0.1): expanded from 10-building circular ring to
// 12-building square ring — 3 buildings per side (N/E/S/W), corners stay
// empty as plaza space. Two new buildings added: casino (E2) + claw-arcade (S3).
//
// Square geometry:
//   Side distance from center: 72 tiles (= 2304 wu)
//   Side slot positions: center ± 0, ± 48 tiles along the side
//   Zone footprint: 14×14 tiles (448×448 wu) — unchanged
//   Zone upper-left = (slot_center_x − 7, slot_center_y − 7)
//
// The 10 original buildings retain their IDs; only positions changed.
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
  // 12-building square ring (3 per side, no corner buildings — corners = plaza).
  // Square radius: 72 tiles from center (80, 80). Side spacing: 48 tiles.
  // Zone footprint: 14×14 tiles. Upper-left = center − 7.
  // Added 2026-05-17 (Phase 6.0.1): casino + claw-arcade fill E2 and S3.
  // rotY = atan2(80 − cx, 80 − cy) so each building faces the plaza center.
  // ---------------------------------------------------------------------------

  // === NORTH SIDE (y-fixed at 8, x varies: 32, 80, 128) ===
  // N1  center=(32,  8)   dx=48, dz=72  → visual-creation (Pineapple House)
  { id: 'visual-creation',     x:  25, y:   1, width: 14, height: 14 },
  // N2  center=(80,  8)   dx= 0, dz=72  → memory-rag (Squidward's House)
  { id: 'memory-rag',          x:  73, y:   1, width: 14, height: 14 },
  // N3  center=(128, 8)   dx=-48,dz=72  → api-integrations (Salty Spitoon)
  { id: 'api-integrations',    x: 121, y:   1, width: 14, height: 14 },

  // === EAST SIDE (x-fixed at 152, y varies: 32, 80, 128) ===
  // E1  center=(152,32)   dx=-72,dz=48  → cron-automation (Downtown Building)
  { id: 'cron-automation',     x: 145, y:  25, width: 14, height: 14 },
  // E2  center=(152,80)   dx=-72,dz= 0  → casino (Phase 6 new building)
  { id: 'casino',              x: 145, y:  73, width: 14, height: 14 },
  // E3  center=(152,128)  dx=-72,dz=-48 → app-publishing (Boating School)
  { id: 'app-publishing',      x: 145, y: 121, width: 14, height: 14 },

  // === SOUTH SIDE (y-fixed at 152, x varies: 32, 80, 128) ===
  // S1  center=(32, 152)  dx=48, dz=-72 → deployment-ops (Lighthouse)
  { id: 'deployment-ops',      x:  25, y: 145, width: 14, height: 14 },
  // S2  center=(80, 152)  dx= 0, dz=-72 → agent-security (Patrick's Rock)
  { id: 'agent-security',      x:  73, y: 145, width: 14, height: 14 },
  // S3  center=(128,152)  dx=-48,dz=-72 → claw-arcade (Phase 6 new building)
  { id: 'claw-arcade',         x: 121, y: 145, width: 14, height: 14 },

  // === WEST SIDE (x-fixed at 8, y varies: 32, 80, 128) ===
  // W1  center=(8,  32)   dx=72, dz=48  → messaging-channels (Sandy's Treedome)
  { id: 'messaging-channels',  x:   1, y:  25, width: 14, height: 14 },
  // W2  center=(8,  80)   dx=72, dz= 0  → mcp-tool-use (Krusty Krab)
  { id: 'mcp-tool-use',        x:   1, y:  73, width: 14, height: 14 },
  // W3  center=(8, 128)   dx=72, dz=-48 → code-development (Chum Bucket)
  { id: 'code-development',    x:   1, y: 121, width: 14, height: 14 },
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
