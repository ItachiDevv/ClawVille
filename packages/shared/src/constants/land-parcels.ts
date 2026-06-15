// Land Parcels — Phase 0 geometry constant (2026-06-15).
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
//   - TOTAL_PARCEL_SUPPLY (176) parcels are enumerated: 4+8+16+40+108.
//   - All coordinates are in world-units (wu). 1 tile = 32 wu.
//     World center = (0, 0). Grid = 576x576 tiles = 18432x18432 wu.
//   - Building ring is at R=130 tiles (4160 wu) — parcels NEVER overlap it.
//
// Layout (concentric rings, inner=premium, outer=abundant):
//
//   Tier     | R (tiles) | R (wu)  | Count | Footprint (tiles) | Footprint (wu) | Rows
//   ---------|-----------|---------|-------|-------------------|----------------|-----
//   founder  |    55     |  1760   |   4   |        11         |      352       |   1
//   a        |   165     |  5280   |   8   |        10         |      320       |   1
//   b        |   200     |  6400   |  16   |         9         |      288       |   1
//   c        |   245     |  7840   |  40   |         8         |      256       |   1
//   starter  | 268/272   | 8576/   | 108   |         7         |      224       |   2
//            |           | 8704    |       |                   |                | (54+54)
//
// No-overlap proof (per tier):
//   founder:  arc spacing = 2*pi*1760/4  ~= 2764wu >> 352wu footprint. Gap to bld ring = (130-55)*32=2400wu.
//   a:        arc spacing = 2*pi*5280/8  ~= 4147wu >> 320wu. Gap from bld ring = (165-130)*32=1120wu.
//   b:        arc spacing = 2*pi*6400/16 ~= 2513wu >> 288wu. Gap from a = (200-165)*32=1120wu.
//   c:        arc spacing = 2*pi*7840/40 ~= 1232wu >> 256wu. Gap from b = (245-200)*32=1440wu.
//   starter1: arc spacing = 2*pi*8576/54 ~=  998wu >> 224wu. Gap from c = (268-245)*32=736wu.
//   starter2: arc spacing = 2*pi*8704/54 ~= 1013wu >> 224wu. Rows staggered by half-slot angle.
//             Row gap = (272-268)*32=128wu < footprint but rows are RADIALLY adjacent, not overlapping:
//             parcels are small boxes aligned to tile grid; radial gap = 4 tiles = 128wu (no overlap).
//   Grid edge: outermost parcel at r=272+3.5=275.5 tiles; grid half = 288 tiles. Margin=12.5 tiles.

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
  /** Ring radius from world origin (wu). */
  radius: number;
}

// ---------------------------------------------------------------------------
// Per-tier geometry configuration
// ---------------------------------------------------------------------------

interface TierConfig {
  radiusTiles: number | [number, number]; // single radius or [row1, row2] for 2-row tiers
  footprintTiles: number;
  /** Starting angle offset (radians). Null = evenly distributed from 0. */
  startAngle?: number;
}

const TIER_CONFIG: Record<LandTier, TierConfig> = {
  // founder: 4 parcels at r=55 tiles, clustered at cardinal NE/SE/SW/NW
  // (N/E/S/W are the building ring axes; founders sit in between = more exclusive)
  founder: { radiusTiles: 55,      footprintTiles: 11, startAngle: Math.PI / 4 },
  // a-tier: 8 parcels at r=165 tiles, just outside the building ring (R=130)
  a:       { radiusTiles: 165,     footprintTiles: 10, startAngle: 0 },
  // b-tier: 16 parcels at r=200 tiles
  b:       { radiusTiles: 200,     footprintTiles: 9,  startAngle: 0 },
  // c-tier: 40 parcels at r=245 tiles
  c:       { radiusTiles: 245,     footprintTiles: 8,  startAngle: Math.PI / 40 },
  // starter: 2 rows of 54 at r=268 and r=272 tiles, staggered by half a slot
  starter: { radiusTiles: [268, 272], footprintTiles: 7, startAngle: 0 },
};

// ---------------------------------------------------------------------------
// Deterministic parcel generator
// ---------------------------------------------------------------------------

function generateParcels(): ParcelSlot[] {
  const parcels: ParcelSlot[] = [];

  for (const tier of LAND_TIERS) {
    const count = PARCEL_TIER_COUNTS[tier];
    const cfg = TIER_CONFIG[tier];
    const footprintWU = cfg.footprintTiles * TILE_SIZE;
    const startAngle = cfg.startAngle ?? 0;

    if (Array.isArray(cfg.radiusTiles)) {
      // Two-row layout (starter): split count evenly across rows
      const rows = cfg.radiusTiles as [number, number];
      const perRow = Math.ceil(count / rows.length);

      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const radiusWU = rows[rowIdx] * TILE_SIZE;
        // Stagger odd rows by half a slot-angle to avoid radial alignment
        const rowAngleOffset = rowIdx % 2 === 1 ? (Math.PI / perRow) : 0;
        const slotsThisRow = rowIdx === 0 ? Math.ceil(count / rows.length) : Math.floor(count / rows.length);
        const angleStep = (2 * Math.PI) / slotsThisRow;

        for (let i = 0; i < slotsThisRow; i++) {
          const globalIndex = rowIdx * Math.ceil(count / rows.length) + i;
          const angle = startAngle + rowAngleOffset + i * angleStep;
          parcels.push({
            id: parcelCode(tier, globalIndex),
            tier,
            indexInTier: globalIndex,
            cx: Math.round(Math.cos(angle) * radiusWU),
            cz: Math.round(Math.sin(angle) * radiusWU),
            size: footprintWU,
            angle,
            radius: radiusWU,
          });
        }
      }
    } else {
      // Single-row layout
      const radiusWU = cfg.radiusTiles * TILE_SIZE;
      const angleStep = (2 * Math.PI) / count;

      for (let i = 0; i < count; i++) {
        const angle = startAngle + i * angleStep;
        parcels.push({
          id: parcelCode(tier, i),
          tier,
          indexInTier: i,
          cx: Math.round(Math.cos(angle) * radiusWU),
          cz: Math.round(Math.sin(angle) * radiusWU),
          size: footprintWU,
          angle,
          radius: radiusWU,
        });
      }
    }
  }

  return parcels;
}

/** All 176 land parcels in deterministic order (founder→a→b→c→starter).
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

/** Convert a parcel's world center to its 14x14-tile zone in the tilemap
 *  (upper-left tile coord). Uses the same half-offset formula as buildingZones. */
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
