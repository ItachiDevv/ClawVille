// Land Showroom — deterministic selection of ~15 starter-tier lots for the
// "kinda set up" showroom display (2026-06-18).
//
// Invariants (load-bearing — same as land-parcels.ts header):
//   - Pure math only. NO Math.random(), NO Date.now().
//   - Every client calling this gets an IDENTICAL result: multiplayer-safe.
//   - Showroom lots HIDE once a parcel is owned, so the buyer's real structure
//     cleanly takes over with zero visual conflict.
//
// Selection: stride every 7th starter-tier parcel (108 starters → indices
//   0, 7, 14, 21, …, 105 = 16 lots), evenly spread around the outer perimeter
//   so the showroom reads as distributed, not clustered.
//
// Per selected lot, by selection index k (0-based):
//   style = SHOWROOM_STYLES[k % 3]
//   structureType = k % 2 === 0 ? 'home' : 'shop'
//   level = 1 + (k % 2)   → 1 (home) or 2 (shop) — starter-appropriate low levels

import { LAND_PARCELS } from './land-parcels';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShowroomStyle = 'coastal-cottage' | 'fantasy-cottage' | 'driftwood-cabin';
export type ShowroomStructureType = 'home' | 'shop';

export interface ShowroomEntry {
  parcelId: string;
  style: ShowroomStyle;
  structureType: ShowroomStructureType;
  level: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stride for picking starter lots — every 7th gives 16 lots from 108 starters. */
const SHOWROOM_STRIDE = 7;

/** Style cycle — rotates across 3 styles for visual variety. */
const SHOWROOM_STYLES: readonly ShowroomStyle[] = [
  'coastal-cottage',
  'fantasy-cottage',
  'driftwood-cabin',
];

// ---------------------------------------------------------------------------
// Deterministic showroom selection
// ---------------------------------------------------------------------------

function generateShowroom(): ShowroomEntry[] {
  const starters = LAND_PARCELS.filter((p) => p.tier === 'starter');

  const entries: ShowroomEntry[] = [];
  let k = 0;
  for (let idx = 0; idx < starters.length; idx += SHOWROOM_STRIDE) {
    const parcel = starters[idx];
    entries.push({
      parcelId: parcel.id,
      style: SHOWROOM_STYLES[k % 3],
      structureType: k % 2 === 0 ? 'home' : 'shop',
      level: 1 + (k % 2), // home=L1, shop=L2 — starter-appropriate
    });
    k++;
  }
  return entries;
}

/** 16 showroom entries, deterministic, evenly spread around the outer perimeter.
 *  Computed once at module load — safe to reference from React components and
 *  server code without memoisation cost. */
export const LAND_SHOWROOM: readonly ShowroomEntry[] = generateShowroom();

/** Fast O(1) lookup: is a parcel id in the showroom set?
 *  Used by land-parcels.tsx to suppress the FOR-SALE sign on showroom lots
 *  (they get a FOR RENT sign from land-showroom.tsx instead). */
export const SHOWROOM_PARCEL_IDS: ReadonlySet<string> = new Set(
  LAND_SHOWROOM.map((e) => e.parcelId),
);
