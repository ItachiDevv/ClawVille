// Land Showroom — deterministic selection of showcase lots for the "kinda set
// up" display (2026-06-18): 16 outer starter-tier lots (FOR RENT cottages) +
// 6 inner Founders'-Row lots (PREMIUM skyscraper/mall) = 22 total.
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

export type ShowroomStyle =
  | 'coastal-cottage'
  | 'fantasy-cottage'
  | 'driftwood-cabin'
  // Premium-tier showcase models (Founders' Row) — the "higher tier = nicer
  // buildings" payoff. premium-tower = skyscraper (a `home`), premium-mall = mall
  // (a `shop`). GLBs at /models/land-structures/<style>/<type>.glb.
  | 'premium-tower'
  | 'premium-mall';
export type ShowroomStructureType = 'home' | 'shop';

/** Sign shown on a showroom lot. 'rent' = amber FOR RENT (starter showcase);
 *  'premium' = gold PREMIUM / FOUNDERS' ROW (founder-tier showcase). */
export type ShowroomSignLabel = 'rent' | 'premium';

export interface ShowroomEntry {
  parcelId: string;
  style: ShowroomStyle;
  structureType: ShowroomStructureType;
  level: number;
  /** Sign variant. Defaults to 'rent' when omitted (starter showcase). */
  signLabel?: ShowroomSignLabel;
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

/** Number of Founders'-Row lots to fill with the premium skyscraper/mall pair.
 *  Founder tier has 8 lots; filling 6 leaves 2 open for the real auction sale. */
const PREMIUM_LOT_COUNT = 6;

function generateShowroom(): ShowroomEntry[] {
  const entries: ShowroomEntry[] = [];

  // ── Starter showcase (outer ring, FOR RENT) ──
  const starters = LAND_PARCELS.filter((p) => p.tier === 'starter');
  let k = 0;
  for (let idx = 0; idx < starters.length; idx += SHOWROOM_STRIDE) {
    const parcel = starters[idx];
    entries.push({
      parcelId: parcel.id,
      style: SHOWROOM_STYLES[k % 3],
      structureType: k % 2 === 0 ? 'home' : 'shop',
      level: 1 + (k % 2), // home=L1, shop=L2 — starter-appropriate
      signLabel: 'rent',
    });
    k++;
  }

  // ── Premium showcase (Founders' Row inner ring, PREMIUM) ──
  // Alternating skyscraper (premium-tower, a 'home') + mall (premium-mall, a
  // 'shop') on the first PREMIUM_LOT_COUNT founder lots, at a high level so they
  // scale up and tower over the starter cottages — the "nicer buildings on
  // higher tiers" payoff made visible. Level only drives scale here (decorative).
  const founders = LAND_PARCELS.filter((p) => p.tier === 'founder');
  for (let i = 0; i < Math.min(PREMIUM_LOT_COUNT, founders.length); i++) {
    const parcel = founders[i];
    const isTower = i % 2 === 0;
    entries.push({
      parcelId: parcel.id,
      style: isTower ? 'premium-tower' : 'premium-mall',
      structureType: isTower ? 'home' : 'shop',
      level: 5, // top of the scale ramp — premium reads biggest
      signLabel: 'premium',
    });
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
