// Land Parcels — Phase 1 geometry constant (square block-frames, 2026-06-17).
//
// Deterministic source of truth for the 3D world positions of every land parcel.
// Imports the FROZEN tier contract (land-tiers.ts) for enum, supply counts, and
// parcelCode() so they can never drift.
//
// Key invariants:
//   - Pure, side-effect-free. generateParcels() uses only math — no Date.now, no
//     Math.random. Every client calling this gets an IDENTICAL array: multiplayer-safe.
//   - Parcel ids match parcelCode(tier, index) exactly. The DB seed script and
//     land_parcels.parcel_code use this same function — no mapping layer anywhere.
//   - TOTAL_PARCEL_SUPPLY (180) parcels are enumerated: 8+8+16+40+108.
//   - All coordinates are in world-units (wu). 1 tile = 32 wu.
//     World center = (0, 0). Grid = 576x576 tiles = 18432x18432 wu.
//   - Building ring is at R=130 tiles (~4160 wu) — parcels NEVER overlap it.
//
// Layout (axis-aligned SQUARE concentric BLOCK-FRAMES, inner=premium, outer=abundant):
//
//   2-RING "fewer big plots" layout (2026-06-18 founder review — supersedes the
//   old 5-tier 180-plot table). Only founder + starter are populated:
//
//   Tier     | role    | half-side h (tiles) | count | footprint (tiles) | footprint (wu)
//   ---------|---------|---------------------|-------|-------------------|---------------
//   founder  | PREMIUM |        190          |  10   |        38         |     1216
//   a/b/c    | unused  |         —           |   0   |         —         |       —
//   starter  | REGULAR |        258          |  26   |        34         |     1088
//
// Plots are placed at EVEN ARC-LENGTH steps around the square perimeter (P=8·h tiles)
// so corners always receive plots. s_i = i × (P/N), i ∈ [0, N).
//
// Perimeter walk (clockwise from top-left corner, s=0):
//   side 0 = TOP edge:    z = −h, x runs −h → +h  (local = x + h)
//   side 1 = RIGHT edge:  x = +h, z runs −h → +h  (local = z + h)
//   side 2 = BOTTOM edge: z = +h, x runs +h → −h  (local = −x + h  i.e. h−x)
//   side 3 = LEFT edge:   x = −h, z runs +h → −h  (local = −z + h  i.e. h−z)
//   side = floor(s / (2h));  local = s − side × 2h  ∈ [0, 2h)
//
// NO-OVERLAP + MAP-BOUNDS + BUILDING-CLEARANCE PROOF:
//
//   Building ring worst-case axial reach: R=130t, max building footprint ≈ 31t half-side
//   → worst radial reach on N/E/S/W axes ≈ 130+31 = 161t.
//
//   BUILDING CLEARANCE:
//     Founder inner edge (on-axis) = 176 − 3 (half of 6t footprint) = 173t > 161t → 12t clearance ✓
//
//   WITHIN-FRAME plot spacing (step = 8h/N tiles >> footprint):
//     founder: 8×176/8 = 176t >> 6t ✓
//     a:       8×200/8 = 200t >> 7t ✓
//     b:       8×224/16 = 112t >> 7t ✓
//     c:       8×248/40 = 49.6t >> 7t ✓
//     starter: 8×272/108 ≈ 20.1t >> 7t ✓
//
//   RADIAL GAP between consecutive frames = (h2−h1) = 24t each.
//     Nearest edges of adjacent tiers: 24t − (7/2 + 7/2) = 24 − 7 = 17t clear ✓
//     (founder→a gap = 24t − (6/2+7/2) = 24 − 6.5 = 17.5t clear ✓)
//
//   MAP BOUNDS:
//     Outer frame h=272t, footprint/2=3.5t → furthest edge = 275.5t < 288t half-grid → 12.5t margin ✓

import {
  type LandTier,
  LAND_TIERS,
  PARCEL_TIER_COUNTS,
  parcelCode,
} from './land-tiers';

// TILE_SIZE duplicated here (32) so land-parcels.ts has no dep on the web tilemap.
// Keep in sync with TILE_SIZE in tilemap-data.ts.
const TILE_SIZE = 32;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single land parcel's geometry descriptor. */
export interface ParcelSlot {
  /** Stable parcel id — identical to DB land_parcels.parcel_code. */
  id: string;
  /** Land tier. */
  tier: LandTier;
  /** Index within the tier (0-based). */
  indexInTier: number;
  /** World-space X of parcel center (wu). */
  cx: number;
  /** World-space Z of parcel center (wu). */
  cz: number;
  /** Parcel footprint side length (wu). Square. */
  size: number;
  /** Angle from world origin to parcel center (radians, for rendering / minimap). */
  angle: number;
  /** Chebyshev distance from world origin to parcel center frame (wu).
   *  Equal to the frame's half-side in wu (= h×32) for all plots on that frame.
   *  Backend and minimap read this; must stay a number. */
  radius: number;
}

// ---------------------------------------------------------------------------
// Per-tier geometry configuration (square block-frames)
// ---------------------------------------------------------------------------

interface TierConfig {
  /** Half-side of the square frame in tiles. Chebyshev distance from center. */
  halfSideTiles: number;
  /** Side length of each parcel's footprint in tiles. */
  footprintTiles: number;
}

// 2-RING "fewer big plots" layout (2026-06-18). Only founder (PREMIUM inner) and
// starter (REGULAR outer) are populated — PARCEL_TIER_COUNTS zeroes a/b/c.
// Footprints are 34-38 tiles (1088-1216 wu) — ~5x the old 6-7t plots — so a
// building (scaled to ~0.62-0.78x the footprint) reads at ~2.5-3x a character.
//   founder (premium): h=190t (6080wu) inner edge 171t > building reach ~161t (10t clear).
//   starter (regular): h=258t (8256wu) outer edge 275t < grid half 288t (13t margin).
//   radial gap 68t - footprints(19+17) = 32t clear; within-ring spacing >> footprint.
// a/b/c keep nominal configs (never generated at count 0). The middle tiers come
// back if we grow the world.
const TIER_CONFIG: Record<LandTier, TierConfig> = {
  founder: { halfSideTiles: 190, footprintTiles: 38 }, // PREMIUM inner ring (big)
  a:       { halfSideTiles: 200, footprintTiles: 7 },  // unused (count 0)
  b:       { halfSideTiles: 224, footprintTiles: 7 },  // unused (count 0)
  c:       { halfSideTiles: 248, footprintTiles: 7 },  // unused (count 0)
  starter: { halfSideTiles: 258, footprintTiles: 34 }, // REGULAR outer ring (big)
};

// ---------------------------------------------------------------------------
// Arc-length perimeter walk — converts arc-length s (tiles) → (cx_tiles, cz_tiles)
// on a square frame of half-side h tiles.
// Perimeter P = 8h. Side length = 2h.
// s=0 = top-left corner (x=−h, z=−h).
// ---------------------------------------------------------------------------

function squarePerimeterPoint(s: number, h: number): { xt: number; zt: number } {
  const sideLen = 2 * h;
  const side = Math.floor(s / sideLen);
  const local = s - side * sideLen; // 0 ≤ local < 2h

  switch (side) {
    case 0: // TOP: z=−h, x: −h → +h
      return { xt: -h + local, zt: -h };
    case 1: // RIGHT: x=+h, z: −h → +h
      return { xt: +h, zt: -h + local };
    case 2: // BOTTOM: z=+h, x: +h → −h
      return { xt: +h - local, zt: +h };
    case 3: // LEFT: x=−h, z: +h → −h
      return { xt: -h, zt: +h - local };
    default:
      // Should never happen for s ∈ [0, P); guard for floating-point edge at s≈P
      return { xt: -h, zt: -h };
  }
}

// ---------------------------------------------------------------------------
// Deterministic parcel generator
// ---------------------------------------------------------------------------

function generateParcels(): ParcelSlot[] {
  const parcels: ParcelSlot[] = [];

  for (const tier of LAND_TIERS) {
    const count = PARCEL_TIER_COUNTS[tier];
    const cfg = TIER_CONFIG[tier];
    const h = cfg.halfSideTiles;
    const perimeter = 8 * h; // tiles
    const step = perimeter / count;
    const footprintWU = cfg.footprintTiles * TILE_SIZE;
    const radiusWU = h * TILE_SIZE; // Chebyshev frame radius in wu

    for (let i = 0; i < count; i++) {
      const s = i * step; // arc-length position in tiles along the perimeter
      const { xt, zt } = squarePerimeterPoint(s, h);
      const cx = Math.round(xt * TILE_SIZE);
      const cz = Math.round(zt * TILE_SIZE);

      parcels.push({
        id: parcelCode(tier, i),
        tier,
        indexInTier: i,
        cx,
        cz,
        size: footprintWU,
        angle: Math.atan2(cz, cx),
        radius: radiusWU,
      });
    }
  }

  return parcels;
}

/** All 180 land parcels in deterministic order (founder→a→b→c→starter).
 *  Computed once at module load — safe to reference from React components and
 *  server code without memoisation cost. */
export const LAND_PARCELS: readonly ParcelSlot[] = generateParcels();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** World-space center of a parcel. Identical to (parcel.cx, 0, parcel.cz)
 *  but provided as a typed return for convenience. */
export function parcelCenterWorld(parcel: ParcelSlot): { x: number; y: number; z: number } {
  return { x: parcel.cx, y: 0, z: parcel.cz };
}

/** Convert a parcel's world center to its tile zone in the tilemap (upper-left tile coord).
 *  Uses the same half-offset formula as buildingZones. cx/cz are integer world-wu so the
 *  downstream gridX/gridY = floor((cx|cz + 9216)/32) math is always exact. */
export function parcelToTileZone(parcel: ParcelSlot): {
  x: number; // tile col of zone upper-left
  y: number; // tile row of zone upper-left
  width: number;
  height: number;
} {
  const HALF_MAP_WU = (576 / 2) * TILE_SIZE; // 9216 wu — grid half-width
  // Convert world center (wu) to tilemap pixel coords, then to tile coords.
  // tilemap px = worldCoord + HALF_MAP_WU. Tile = floor(px / TILE_SIZE).
  const tileX = Math.floor((parcel.cx + HALF_MAP_WU) / TILE_SIZE);
  const tileY = Math.floor((parcel.cz + HALF_MAP_WU) / TILE_SIZE);
  const halfFootprint = Math.round(parcel.size / TILE_SIZE / 2);
  return {
    x: tileX - halfFootprint,
    y: tileY - halfFootprint,
    width: parcel.size / TILE_SIZE,
    height: parcel.size / TILE_SIZE,
  };
}
