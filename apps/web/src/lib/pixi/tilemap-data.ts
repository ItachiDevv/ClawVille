// ---------------------------------------------------------------------------
// Tilemap data for ElizaPets Neopia Central
// 40 x 25 grid of 32px tiles = 1280 x 800 pixel world
// ---------------------------------------------------------------------------

export const TILE_SIZE = 32;
export const MAP_COLS = 40;
export const MAP_ROWS = 25;
export const MAP_WIDTH = MAP_COLS * TILE_SIZE; // 1280
export const MAP_HEIGHT = MAP_ROWS * TILE_SIZE; // 800

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
// Mapped from MAP_LOCATIONS pixel coords (780x468 source) to 40x25 grid
// ---------------------------------------------------------------------------
export interface BuildingZone {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const buildingZones: BuildingZone[] = [
  { id: 'potion-shop',      x: 3,  y: 2,  width: 4, height: 3 },
  { id: 'auction-house',    x: 9,  y: 1,  width: 4, height: 3 },
  { id: 'book-shop',        x: 16, y: 1,  width: 3, height: 3 },
  { id: 'clothing-shop',    x: 23, y: 1,  width: 3, height: 3 },
  { id: 'bazaar',           x: 2,  y: 8,  width: 4, height: 3 },
  { id: 'petpet-shop',      x: 7,  y: 10, width: 3, height: 3 },
  { id: 'money-tree',       x: 14, y: 7,  width: 4, height: 4 },
  { id: 'rainbow-pool',     x: 20, y: 8,  width: 4, height: 3 },
  { id: 'wishing-well',     x: 27, y: 6,  width: 3, height: 3 },
  { id: 'treasure-island',  x: 32, y: 3,  width: 4, height: 3 },
  { id: 'neopian-flats',    x: 2,  y: 16, width: 4, height: 3 },
  { id: 'art-studio',       x: 9,  y: 18, width: 3, height: 3 },
  { id: 'juice-shop',       x: 17, y: 17, width: 3, height: 3 },
  { id: 'electronics-shop', x: 25, y: 16, width: 3, height: 3 },
  { id: 'pharmacy',         x: 32, y: 17, width: 3, height: 3 },
];

// ---------------------------------------------------------------------------
// Layer 1: GROUND  (grass base + water at Rainbow Pool area)
// 40 cols x 25 rows = 1000 tiles
// ---------------------------------------------------------------------------
// prettier-ignore
export const groundLayer: number[] = [
  // Row 0 — top edge, varied grass
  G1,G2,G1,G3,G1,G2,G1,G1,G2,G3,G1,G2,G1,G3,G2,G1,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,
  // Row 1
  G2,G1,G3,G1,G2,G1,G3,G2,G1,G1,G2,G3,G1,G2,G1,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,
  // Row 2
  G1,G3,G2,G1,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,
  // Row 3
  G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,
  // Row 4
  G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G3,
  // Row 5
  G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,
  // Row 6
  G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,
  // Row 7
  G1,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G1,
  // Row 8 — Rainbow Pool water area at cols 20-23
  G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,WA,WA,WA,WA,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,
  // Row 9 — Rainbow Pool water continues
  G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,WA,WA,WA,WA,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,
  // Row 10
  G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,WA,WA,WA,WA,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,
  // Row 11
  G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G2,G1,G3,G2,G1,G2,G1,G3,
  // Row 12
  G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,
  // Row 13
  G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G1,
  // Row 14
  G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G2,G1,G3,G2,G3,
  // Row 15
  G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G1,G2,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G1,G2,G1,
  // Row 16
  G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,
  // Row 17
  G2,G1,G3,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,G2,G3,G1,G2,G1,G3,G1,G2,G3,G2,G1,G3,G2,G1,G2,G3,G1,G3,G2,G1,G3,G1,G2,G1,G3,G2,G2,
  // Row 18
  G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G1,G2,G3,G2,G1,G2,G3,G1,G2,G3,G2,G1,G3,G2,G1,G3,G2,G1,G3,G1,
  // Row 19
  G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,
  // Row 20
  G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G2,
  // Row 21
  G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G1,
  // Row 22
  G3,G1,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G3,
  // Row 23
  G2,G3,G1,G2,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G3,G1,G2,G3,G1,G2,G2,
  // Row 24 — bottom edge
  G1,G2,G3,G1,G3,G1,G2,G3,G1,G2,G3,G1,G2,G1,G2,G3,G1,G2,G3,G1,G2,G1,G3,G2,G1,G2,G1,G3,G2,G1,G3,G2,G1,G2,G3,G1,G2,G1,G3,G1,
];

// ---------------------------------------------------------------------------
// Layer 2: PATHS  (dirt paths connecting buildings, stone at entrances)
// -1 = transparent (no path tile)
// ---------------------------------------------------------------------------
// prettier-ignore
export const pathLayer: number[] = [
  // Row 0
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 1
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 2
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 3
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 4 — horizontal path segment from potion-shop down toward center area
  _,_,_,_,_,SP,_,_,_,_,_,SP,_,_,_,_,_,_,SP,_,_,_,_,_,SP,_,_,_,_,_,_,_,_,_,SP,_,_,_,_,_,
  // Row 5 — main east-west path connecting top-row buildings
  _,_,_,_,_,SP,DP,DP,DP,DP,DP,SP,DP,DP,DP,DP,DP,DP,SP,DP,DP,DP,DP,DP,SP,DP,DP,DP,DP,DP,DP,DP,DP,DP,SP,_,_,_,_,_,
  // Row 6 — path continues, branch down to center
  _,_,_,_,_,DP,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,DP,_,_,SP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 7 — vertical paths going down from top buildings
  _,_,_,_,_,DP,_,_,_,_,_,DP,_,_,_,_,SP,_,DP,_,_,_,_,_,DP,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 8 — horizontal path at middle tier
  _,_,_,_,_,DP,_,_,_,_,_,DP,_,_,_,_,SP,_,DP,_,_,_,_,_,DP,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 9
  _,_,_,_,_,DP,_,_,_,_,_,DP,_,_,_,_,SP,_,DP,_,_,_,_,_,DP,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 10
  _,_,_,_,_,DP,_,_,_,SP,_,DP,_,_,_,_,SP,_,DP,_,_,_,_,_,DP,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 11 — main east-west path at mid level connecting middle buildings
  _,_,_,_,_,SP,DP,DP,DP,SP,DP,SP,DP,DP,DP,DP,SP,DP,SP,DP,DP,DP,DP,DP,SP,DP,DP,SP,DP,DP,DP,DP,DP,DP,SP,_,_,_,_,_,
  // Row 12 — vertical paths going down to lower buildings
  _,_,_,_,_,DP,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 13
  _,_,_,_,_,DP,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 14
  _,_,_,_,_,DP,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 15 — path along lower tier
  _,_,_,_,_,DP,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 16
  _,_,_,_,_,DP,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 17
  _,_,_,_,_,DP,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,_,DP,_,DP,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 18 — horizontal path at bottom tier
  _,_,_,_,_,SP,DP,DP,DP,DP,DP,SP,DP,DP,DP,DP,DP,DP,SP,DP,DP,DP,DP,DP,DP,SP,DP,SP,DP,DP,DP,DP,DP,DP,SP,_,_,_,_,_,
  // Row 19
  _,_,_,_,_,DP,_,_,_,_,_,_,_,_,_,_,_,_,DP,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,DP,_,_,_,_,_,
  // Row 20 — lower horizontal connector
  _,_,_,_,_,SP,DP,DP,DP,DP,DP,DP,DP,DP,DP,DP,DP,DP,SP,DP,DP,DP,DP,DP,DP,DP,DP,DP,DP,DP,DP,DP,DP,DP,SP,_,_,_,_,_,
  // Row 21
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 22
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 23
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 24
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
];

// ---------------------------------------------------------------------------
// Layer 3: DECORATIONS  (trees, flowers, bushes along edges and between buildings)
// -1 = transparent
// ---------------------------------------------------------------------------
// prettier-ignore
export const decorationLayer: number[] = [
  // Row 0 — dense tree line along top edge
  T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,
  // Row 1 — trees with gaps for buildings
  T2,T1,_,_,_,_,_,T1,_,_,_,_,_,T2,_,_,_,_,_,T1,_,_,_,_,_,_,T2,T1,T2,T1,T2,_,_,_,_,_,T1,T2,T1,T2,
  // Row 2 — flowers near buildings
  T1,_,_,_,_,_,_,_,F1,_,_,_,_,_,F2,_,_,_,_,_,F1,_,_,_,_,_,F2,_,_,_,T1,_,_,_,_,_,_,_,T1,T2,
  // Row 3
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,T1,
  // Row 4
  _,BU,_,_,_,_,_,BU,_,_,_,_,_,BU,_,_,_,_,_,F2,_,_,_,_,_,F1,_,_,_,F2,_,BU,_,_,_,_,_,BU,_,T2,
  // Row 5
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,T1,
  // Row 6 — some bushes and flowers between buildings
  T2,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,T2,
  // Row 7 — Money Tree area decorations
  T1,_,BU,_,_,_,_,_,_,_,F1,_,_,_,_,_,_,_,_,_,_,_,_,_,_,F2,_,_,_,BU,_,_,_,_,_,_,_,BU,_,T1,
  // Row 8
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 9 — flowers around Rainbow Pool
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,F1,_,_,_,_,F2,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 10
  T2,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,F2,_,_,_,_,F1,_,_,_,_,_,_,_,_,_,_,_,_,_,_,T2,
  // Row 11
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 12 — scattered decorations
  T1,_,_,_,_,_,_,F1,_,_,_,_,_,_,_,F2,_,_,_,_,_,BU,_,_,_,_,_,_,_,BU,_,_,_,_,_,_,F1,_,_,T1,
  // Row 13
  _,_,_,_,_,_,_,_,_,_,BU,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 14
  T2,_,BU,_,_,_,_,_,_,_,_,_,_,_,F1,_,_,_,_,_,F2,_,_,_,_,_,_,_,_,_,F1,_,_,_,_,_,_,BU,_,T2,
  // Row 15 — above lower buildings
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 16
  T1,_,_,_,_,_,_,_,F2,_,_,_,_,BU,_,_,_,_,_,_,BU,_,_,_,_,_,_,_,_,BU,_,_,_,_,_,_,_,_,_,T1,
  // Row 17
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 18
  T2,_,_,_,_,_,_,_,_,_,_,_,_,_,F1,_,_,_,_,_,_,_,_,F2,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,T2,
  // Row 19
  _,_,_,_,_,_,_,BU,_,_,_,_,_,_,_,_,_,_,_,_,_,BU,_,_,_,_,_,_,_,_,_,_,_,_,_,BU,_,_,_,_,
  // Row 20
  T1,_,_,_,_,_,_,_,_,_,F2,_,_,_,_,_,F1,_,_,_,_,_,_,_,F2,_,_,_,_,_,F1,_,_,_,_,_,_,_,_,T1,
  // Row 21
  _,BU,_,_,_,_,_,_,_,_,_,_,_,BU,_,_,_,_,BU,_,_,_,_,_,_,_,BU,_,_,_,_,_,_,BU,_,_,_,_,BU,_,
  // Row 22
  T2,_,F1,_,_,F2,_,_,T1,_,_,_,_,_,T2,_,_,_,_,T1,_,_,_,_,T2,_,_,_,T1,_,_,_,_,T2,_,_,_,F1,_,T2,
  // Row 23
  T1,T2,_,BU,_,_,BU,T1,T2,_,BU,_,T1,T2,_,BU,T1,_,T2,_,BU,T1,_,T2,_,BU,T1,T2,_,BU,T1,_,T2,_,BU,T1,T2,_,T1,T2,
  // Row 24 — dense tree line along bottom edge
  T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,T2,T1,
];

// ---------------------------------------------------------------------------
// Layer 4: BUILDINGS  (building structures at each location)
// -1 = transparent
// ---------------------------------------------------------------------------
// prettier-ignore
export const buildingLayer: number[] = [
  // Row 0
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 1 — roof line: auction-house (9-12), book-shop (16-18), clothing-shop (23-25)
  _,_,_,_,_,_,_,_,_,RR,RR,RR,RR,_,_,_,RB,RB,RB,_,_,_,_,RG,RG,RG,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 2 — walls: potion-shop (3-6), auction-house, book-shop, clothing-shop
  _,_,_,RR,RR,RR,RR,_,_,WN,BS,BS,WN,_,_,_,WN,BS,WN,_,_,_,_,WN,BS,WN,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 3 — walls + doors: potion-shop, auction-house, book-shop, clothing-shop + treasure-island roof (32-35)
  _,_,_,WN,BS,BS,WN,_,_,BS,DR,DR,BS,_,_,_,BS,DR,BS,_,_,_,_,BS,DR,BS,_,_,_,_,_,_,RB,RB,RB,RB,_,_,_,_,
  // Row 4 — potion-shop door row + treasure-island walls
  _,_,_,BS,DR,DR,BS,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,WN,BL,BL,WN,_,_,_,_,
  // Row 5 — treasure-island door
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,BL,DR,DR,BL,_,_,_,_,
  // Row 6 — wishing-well roof (27-29)
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,RG,RG,RG,_,_,_,_,_,_,_,_,_,_,
  // Row 7 — money-tree (14-17) special area + wishing-well walls
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,BX,BX,BX,BX,_,_,_,_,_,_,_,_,_,WN,SM,WN,_,_,_,_,_,_,_,_,_,_,
  // Row 8 — bazaar (2-5) roof + money-tree + rainbow-pool (20-23) + wishing-well door
  _,_,RR,RR,RR,RR,_,_,_,_,_,_,_,_,BX,BX,BX,BX,_,_,WA,WA,WA,WA,_,_,_,SM,DR,SM,_,_,_,_,_,_,_,_,_,_,
  // Row 9 — bazaar walls + money-tree + rainbow-pool
  _,_,WN,BS,BS,WN,_,_,_,_,_,_,_,_,BX,DR,DR,BX,_,_,WA,WA,WA,WA,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 10 — bazaar door + petpet-shop roof (7-9) + money-tree bottom + rainbow-pool
  _,_,BS,DR,DR,BS,_,RG,RG,RG,_,_,_,_,BX,BX,BX,BX,_,_,WA,WA,WA,WA,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 11 — petpet-shop walls
  _,_,_,_,_,_,_,WN,SM,WN,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 12 — petpet-shop door
  _,_,_,_,_,_,_,SM,DR,SM,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 13
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 14
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 15 — electronics-shop roof (25-27)
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,RB,RB,RB,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 16 — neopian-flats roof (2-5) + electronics-shop walls + pharmacy roof (32-34)
  _,_,RR,RR,RR,RR,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,WN,BS,WN,_,_,_,_,RG,RG,RG,_,_,_,_,_,
  // Row 17 — neopian-flats walls + juice-shop roof (17-19) + electronics-shop door + pharmacy walls
  _,_,WN,BL,BL,WN,_,_,_,_,_,_,_,_,_,_,_,RR,RR,RR,_,_,_,_,_,BS,DR,BS,_,_,_,_,WN,SM,WN,_,_,_,_,_,
  // Row 18 — neopian-flats door + art-studio roof (9-11) + juice-shop walls + pharmacy door
  _,_,BL,DR,DR,BL,_,_,_,RB,RB,RB,_,_,_,_,_,WN,BS,WN,_,_,_,_,_,_,_,_,_,_,_,_,SM,DR,SM,_,_,_,_,_,
  // Row 19 — art-studio walls + juice-shop door
  _,_,_,_,_,_,_,_,_,WN,SM,WN,_,_,_,_,_,BS,DR,BS,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 20 — art-studio door
  _,_,_,_,_,_,_,_,_,SM,DR,SM,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 21
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 22
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 23
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
  // Row 24
  _,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,
];
