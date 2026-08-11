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
//   3-RING layout, LAND SCALE-UP pass (2026-08-10 — founder-ratified plot growth;
//   supersedes the 2026-06-24 even-arc-length layout). founder + starter + c are
//   populated; all three carry the SAME 52 t footprint:
//
//   Tier     | role    | half-side h (tiles) | count | footprint (tiles) | footprint (wu)
//   ---------|---------|---------------------|-------|-------------------|---------------
//   founder  | PREMIUM |        192          |  10   |        52         |     1664
//   a/b      | unused  |         —           |   0   |         —         |       —
//   starter  | REGULAR |        257          |  26   |        52         |     1664
//   c        | OUTER   |        322          |  20   |        52         |     1664
//
// Plots use a CORNER-INSET PER-SIDE DISTRIBUTION (replacing the even arc-length
// walk — at 52 t footprints the arc walk parks plots ON the frame corners, where
// two sides' plots collide diagonally):
//
//   perSide[side] = floor(count/4) + (side < count % 4 ? 1 : 0), side ∈ 0..3
//     → founder 10 = 3,3,2,2 · starter 26 = 7,7,6,6 · c 20 = 5,5,5,5
//   inset = footprintTiles + 12 (= 64 t for every populated tier)
//   sideLen = 2h; span = sideLen − 2·inset
//   local(j of n) = (n === 1) ? sideLen/2 : inset + j·span/(n−1)
//   side 0 TOP:    xt = −h + local, zt = −h
//   side 1 RIGHT:  xt = +h,         zt = −h + local
//   side 2 BOTTOM: xt = +h − local, zt = +h
//   side 3 LEFT:   xt = −h,         zt = +h − local
//   cx = round(xt·32), cz = round(zt·32); the index runs continuously across
//   sides 0,1,2,3 so parcelCode(tier, i) — every parcel id — is UNCHANGED from
//   the previous layout. Only centers moved.
//
// NO-OVERLAP + MAP-BOUNDS + BUILDING-CLEARANCE PROOF (measured 2026-08-10 by
// exhaustive computation against this generator + getServerColliders()):
//
//   BUILDING CLEARANCE (bar: >= 256 wu = 8 t from every parcel AABB):
//     Measured max building-collider Chebyshev reach = 157.44 t = 5038 wu
//     (messaging-channels; the previous comment's "~161 t" was wrong).
//     Founder inner edge = 192 − 26 = 166 t = 5312 wu
//     → min parcel-AABB-to-collider-AABB gap = 274 wu
//       (parcel-founder-04 vs messaging-channels) >= 256 wu ✓
//
//   PAIRWISE NO-OVERLAP (exhaustive over all C(56,2) = 1,540 parcel pairs):
//     min Chebyshev slack = 384 wu = 12 t, binding pair
//     parcel-founder-00 vs parcel-founder-09 (the two plots nearest the
//     founder frame's top-left corner, one on each side of it). Every other
//     pair has more. land-placement.test.ts §5.1 pins this exhaustively.
//
//   MAP BOUNDS (704×704 grid → half-grid 352 t = 11264 wu):
//     Outermost frame is c: h=322 t, footprint/2=26 t → furthest edge = 348 t
//     = 11136 wu < 11264 wu → 128 wu (4 t) margin ✓
//
//   RADIAL OCCUPANCY + SALVAGE BANDS (kept in sync with land-salvage.ts):
//     founder [166, 218] t · starter [231, 283] t · c [296, 348] t.
//     The two 13 t inter-ring gaps centred at 224.5 t and 289.5 t are the ONLY
//     remaining homes for the shelf/deep salvage bands — moving any half-side
//     here moves those bands (SALVAGE_LAYOUT_VERSION bump required).

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

// 3-RING layout, LAND SCALE-UP pass (2026-08-10 — founder-ratified). founder
// (PREMIUM inner), starter (REGULAR mid) and c (OUTER) are populated —
// PARCEL_TIER_COUNTS zeroes only a/b. All three populated tiers now carry the
// SAME 52 t (1664 wu) footprint: founder and starter grew 38 → 52 t (+87%
// area); c keeps the 52 t it already had.
//
// WHY c DID NOT GROW TO 60 t (the original brief): infeasible by measurement.
// The founder ring is pinned at halfSide >= 157.44 (measured max collider
// reach) + 8 (clearance) + 26 (half of 52 t) = 191.44 t, each salvage band
// needs a >= 12.5 t radial gap to hold its 200 wu node-to-parcel clearance,
// and 157.44 + 8 + 52 + 12.5 + 52 + 12.5 + 60 = 354.44 t > the 352 t
// half-world. c at 60 t requires redesigning salvage placement (a live money
// path) or growing the world grid — deliberately NOT done in this pass.
//
//   founder (premium): h=192t (6144wu) inner edge 166t; 274wu clear of the
//                      farthest building collider (measured reach 157.44t).
//   starter (regular): h=257t (8224wu) occupancy [231, 283]t.
//   c       (outer):   h=322t (10304wu) outer edge 348t < grid half 352t
//                      (128 wu margin).
// a/b keep nominal configs (never generated at count 0). They come back if we grow further.
//
// PLOT GROWTH proof: exhaustive pairwise AABB over all 1,540 parcel pairs of
// THIS generator (including `Math.round(xt × 32)`) gives minimum slack 384 wu
// = 12 t, binding pair parcel-founder-00 (−4096, −6144) vs parcel-founder-09
// (−6144, −4096). `land-placement.test.ts` §5.1 pins it exhaustively.
const TIER_CONFIG: Record<LandTier, TierConfig> = {
  founder: { halfSideTiles: 192, footprintTiles: 52 }, // PREMIUM inner ring (grown 38→52 t)
  a: { halfSideTiles: 200, footprintTiles: 7 }, // unused (count 0)
  b: { halfSideTiles: 224, footprintTiles: 7 }, // unused (count 0)
  c: { halfSideTiles: 322, footprintTiles: 52 }, // OUTER ring (52 t; ring moved 305→322)
  starter: { halfSideTiles: 257, footprintTiles: 52 }, // REGULAR mid ring (grown 38→52 t)
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
// Deterministic parcel generator — corner-inset per-side distribution
// ---------------------------------------------------------------------------

/**
 * Tiles between a side's END (the frame corner) and the CENTER of the nearest
 * plot on that side, beyond the plot's own footprint. inset = footprint + 12
 * keeps the two plots flanking each corner 384 wu apart (the measured global
 * minimum slack) at the 52 t footprint.
 */
const CORNER_INSET_MARGIN_TILES = 12;

/**
 * Deterministically generate `count` parcel slots for ONE tier on its square
 * block-frame — the SAME corner-inset per-side distribution `generateParcels()`
 * runs, extracted as its per-tier body so a consumer can generate a tier at a
 * count OTHER than `PARCEL_TIER_COUNTS[tier]` WITHOUT mutating the frozen
 * render supply. Pure (math only — no RNG/clock); `count <= 0` → `[]`.
 *
 * Distribution (2026-08-10, replaces the even arc-length walk): each side of
 * the frame receives floor(count/4) plots, the first `count % 4` sides one
 * extra. Along a side, plots run from `inset` to `sideLen − inset` at even
 * spacing (a lone plot sits at the side's midpoint). The index increments
 * continuously across sides 0 (top), 1 (right), 2 (bottom), 3 (left), so
 * `parcelCode(tier, i)` — every parcel id, and the tier ordering — is
 * byte-identical to the previous layout. Only centers moved.
 *
 * `LAND_PARCELS` calls this per tier at `PARCEL_TIER_COUNTS`. Tooling may also
 * call it at historical counts to audit the retired a/b ghost manifest; doing
 * so never changes the frozen render supply.
 */
export function generateParcelsForTier(tier: LandTier, count: number): ParcelSlot[] {
  if (count <= 0) return [];
  const cfg = TIER_CONFIG[tier];
  const h = cfg.halfSideTiles;
  const sideLen = 2 * h; // tiles
  const inset = cfg.footprintTiles + CORNER_INSET_MARGIN_TILES; // tiles from each corner
  const span = sideLen - 2 * inset; // usable run per side, tiles
  const footprintWU = cfg.footprintTiles * TILE_SIZE;
  const radiusWU = h * TILE_SIZE; // Chebyshev frame radius in wu

  const parcels: ParcelSlot[] = [];
  let i = 0;
  for (let side = 0; side < 4; side++) {
    const n = Math.floor(count / 4) + (side < count % 4 ? 1 : 0);
    for (let j = 0; j < n; j++) {
      // Distance along the side from its start corner, in tiles.
      const local = n === 1 ? sideLen / 2 : inset + (j * span) / (n - 1);
      let xt: number;
      let zt: number;
      switch (side) {
        case 0: // TOP: z=−h, x: −h → +h
          xt = -h + local;
          zt = -h;
          break;
        case 1: // RIGHT: x=+h, z: −h → +h
          xt = +h;
          zt = -h + local;
          break;
        case 2: // BOTTOM: z=+h, x: +h → −h
          xt = +h - local;
          zt = +h;
          break;
        default: // LEFT: x=−h, z: +h → −h
          xt = -h;
          zt = +h - local;
          break;
      }
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
      i++;
    }
  }
  return parcels;
}

function generateParcels(): ParcelSlot[] {
  const parcels: ParcelSlot[] = [];
  for (const tier of LAND_TIERS) {
    // Tier order (founder→a→b→c→starter) and ids are unchanged from every
    // prior layout; only the per-tier centers come from the new distribution.
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
