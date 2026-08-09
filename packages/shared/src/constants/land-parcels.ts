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
//   - TOTAL_PARCEL_SUPPLY (56) parcels are enumerated: founder 10 + starter 26 + c 20
//     (3-ring layout; a/b are 0). Was 180 (8+8+16+40+108) in the original 5-tier plan.
//   - All coordinates are in world-units (wu). 1 tile = 32 wu.
//     World center = (0, 0). Grid = 704x704 tiles = 22528x22528 wu.
//   - Building ring is at R=130 tiles (~4160 wu) — parcels NEVER overlap it.
//
// Layout (axis-aligned SQUARE concentric BLOCK-FRAMES, inner=premium, outer=abundant):
//
//   3-RING layout (2026-06-24 land-builder-economics — adds the new OUTER c-tier
//   ring enabled by the 576→704 world grow). founder + starter + c are populated:
//
//   Tier     | role    | half-side h (tiles) | count | footprint (tiles) | footprint (wu)
//   ---------|---------|---------------------|-------|-------------------|---------------
//   founder  | PREMIUM |        190          |  10   |        38         |     1216
//   a/b      | unused  |         —           |   0   |         —         |       —
//   starter  | REGULAR |        258          |  26   |        34         |     1088
//   c        | OUTER   |        305          |  20   |        34         |     1088
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
//   NEW OUTER c-RING (2026-06-24, h=305t, footprint=34t, count=20) NO-OVERLAP PROOF:
//     c inner edge   = 305 − 34/2 = 288t  > starter outer edge 275t      → 13t gap   ✓
//     c outer edge   = 305 + 34/2 = 322t  < new half-grid 352t (704/2)   → 30t margin ✓
//     within-ring spacing = 8·305/20 = 122t >> 34t footprint              → no self-overlap ✓
//     founder / starter / building-ring positions are UNCHANGED by this addition.
//
//   MAP BOUNDS (704×704 grid → half-grid 352t):
//     Outermost frame is now c: h=305t, footprint/2=17t → furthest edge = 322t < 352t → 30t margin ✓
//     (pre-grow 2-ring bound: starter h=258t furthest edge 275t < 288t half-grid — still holds.)

import { type LandTier, LAND_TIERS, PARCEL_TIER_COUNTS, parcelCode } from './land-tiers';

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

// 3-RING layout (2026-06-24 land-builder-economics — adds the OUTER c ring that
// the 576→704 world grow enabled). founder (PREMIUM inner), starter (REGULAR mid),
// and c (OUTER) are populated — PARCEL_TIER_COUNTS zeroes only a/b now.
// Footprints are 34-38 tiles (1088-1216 wu) — ~5x the old 6-7t plots — so a
// building (scaled to ~0.62-0.78x the footprint) reads at ~2.5-3x a character.
//   founder (premium): h=190t (6080wu) inner edge 171t > building reach ~161t (10t clear).
//   starter (regular): h=258t (8256wu) outer edge 275t; c inner edge 288t → 13t gap.
//   c       (outer):   h=305t (9760wu) outer edge 322t < new grid half 352t (30t margin).
//   within-ring spacing >> footprint for all three (founder 176t, starter 20.1t, c 122t).
// a/b keep nominal configs (never generated at count 0). They come back if we grow further.
//
// PLOT GROWTH (gamification pass §5.1, 2026-08-09): starter 34 → 38 t (+24.9%
// area) and c 34 → 52 t (+133.9%); founder stays 38 t. Verified by exhaustive
// pairwise AABB over all 1,540 parcel pairs, replicating this generator
// including `Math.round(xt × 32)`. The binding case is starter-06
// (218.3125, −258) against starter-07 (258, −218.3125), separated 39.6875 t on
// both axes — minimum slack 1.6875 t = 54 wu. `land-tiers.test.ts` pins it.
const TIER_CONFIG: Record<LandTier, TierConfig> = {
  founder: { halfSideTiles: 190, footprintTiles: 38 }, // PREMIUM inner ring (big)
  a: { halfSideTiles: 200, footprintTiles: 7 }, // unused (count 0)
  b: { halfSideTiles: 224, footprintTiles: 7 }, // unused (count 0)
  c: { halfSideTiles: 305, footprintTiles: 52 }, // OUTER ring (big) — new in the 704 world
  starter: { halfSideTiles: 258, footprintTiles: 38 }, // REGULAR mid ring (big)
};

/** Side length, in world units, of one parcel footprint on `tier`. */
export function getParcelFootprintWu(tier: LandTier): number {
  return TIER_CONFIG[tier].footprintTiles * TILE_SIZE;
}

/** Half-side, in tiles, of the square ring frame `tier`'s parcels sit on. */
export function getTierHalfSideTiles(tier: LandTier): number {
  return TIER_CONFIG[tier].halfSideTiles;
}

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

/**
 * Deterministically generate `count` parcel slots for ONE tier on its square
 * block-frame — the SAME arc-length perimeter walk `generateParcels()` runs,
 * extracted as its per-tier body so a consumer can generate a tier at a count
 * OTHER than `PARCEL_TIER_COUNTS[tier]` WITHOUT mutating the frozen render
 * supply. Pure (math only — no RNG/clock); `count <= 0` → `[]`.
 *
 * `LAND_PARCELS` calls this per tier at `PARCEL_TIER_COUNTS`. Tooling may also
 * call it at historical counts to audit the retired a/b ghost manifest; doing
 * so never changes the frozen render supply.
 */
export function generateParcelsForTier(tier: LandTier, count: number): ParcelSlot[] {
  if (count <= 0) return [];
  const cfg = TIER_CONFIG[tier];
  const h = cfg.halfSideTiles;
  const perimeter = 8 * h; // tiles
  const step = perimeter / count;
  const footprintWU = cfg.footprintTiles * TILE_SIZE;
  const radiusWU = h * TILE_SIZE; // Chebyshev frame radius in wu

  const parcels: ParcelSlot[] = [];
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
  return parcels;
}

function generateParcels(): ParcelSlot[] {
  const parcels: ParcelSlot[] = [];
  for (const tier of LAND_TIERS) {
    // Identical to the prior inline loop — LAND_PARCELS output is unchanged.
    parcels.push(...generateParcelsForTier(tier, PARCEL_TIER_COUNTS[tier]));
  }
  return parcels;
}

/** All 56 rendered parcels in deterministic order (founder→c→starter).
 *  Computed once at module load — safe to reference from React components and
 *  server code without memoisation cost. */
export const LAND_PARCELS: readonly ParcelSlot[] = generateParcels();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** World-space center of a parcel. Identical to (parcel.cx, 0, parcel.cz)
 *  but provided as a typed return for convenience. */
export function parcelCenterWorld(parcel: ParcelSlot): {
  x: number;
  y: number;
  z: number;
} {
  return { x: parcel.cx, y: 0, z: parcel.cz };
}

/** Convert a parcel's world center to its tile zone in the tilemap (upper-left tile coord).
 *  Uses the same half-offset formula as buildingZones. cx/cz are integer world-wu so the
 *  downstream gridX/gridY = floor((cx|cz + 11264)/32) math is always exact. */
export function parcelToTileZone(parcel: ParcelSlot): {
  x: number; // tile col of zone upper-left
  y: number; // tile row of zone upper-left
  width: number;
  height: number;
} {
  const HALF_MAP_WU = (704 / 2) * TILE_SIZE; // 11264 wu — grid half-width (704-tile world)
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
