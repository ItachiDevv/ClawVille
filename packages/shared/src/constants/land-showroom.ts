// Land Showroom — deterministic selection of showcase lots for the "kinda set
// up" display: ALL 56 plots filled (founder asked to fill every plot,
// 2026-06-18) — 26 REGULAR (starter) cottages + 20 OUTER WARD (tier c)
// cottages + 10 inner PREMIUM (founder) skyscraper/mall lots. The c ring joined
// on 2026-09-18; before that its 20 lots were bare. Signs drawn by
// land-parcels.tsx (3-category FOR SALE).
//
// Invariants (load-bearing — same as land-parcels.ts header):
//   - Pure math only. NO Math.random(), NO Date.now().
//   - Every client calling this gets an IDENTICAL result: multiplayer-safe.
//   - Showroom lots HIDE once a parcel is owned, so the buyer's real structure
//     cleanly takes over with zero visual conflict.
//
// Selection: every starter-tier parcel, every c-tier parcel, plus up to ten
// founder-tier parcels. Invariant: every rendered parcel has an entry
// (land-showroom.test.ts).
//
// Per selected lot, by selection index k (0-based):
//   style = SHOWROOM_STYLES[k % 3]
//   structureType = k % 2 === 0 ? 'home' : 'shop'
//   level = 1 + (k % 2)   → 1 (home) or 2 (shop) — starter-appropriate low levels
//   (c tier: 2 + (k % 2) → 2 or 3, one step above starter, under its cap of 4)

import { LAND_PARCELS } from './land-parcels';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShowroomStyle =
  | 'coastal-cottage'
  | 'fantasy-cottage'
  | 'driftwood-cabin'
  // Premium-tier showcase models (Founders' Row) — the "higher tier = nicer
  // buildings" payoff. GLBs at /models/land-structures/<style>/<type>.glb.
  // Skyscraper is under REVIEW: tower-cand-1 (Option A, Kenney windowed) +
  // tower-cand-3 (Option C, NYC stepped) are placed for the founder to pick;
  // the winner gets promoted to a stable `premium-tower` and the candidates
  // removed. premium-mall = the approved mall (a `shop`).
  | 'premium-tower'
  | 'premium-mall'
  | 'tower-cand-1'
  | 'tower-cand-3';
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

/** Stride for picking REGULAR (starter) lots to fill with example cottages —
 *  stride 1 = EVERY one of the 26 starter lots gets a building (founder asked to
 *  fill all plots). (2-ring layout: starter is the big-plot outer ring.) */
const SHOWROOM_STRIDE = 1;

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

  // ── Outer Ward showcase (tier c, outermost ring) ──
  // The c ring was added on 2026-06-24, six days after the founder asked for
  // every plot to be filled, and it was never added here. Its 20 lots rendered
  // as bare sand with a FOR SALE sign (founder report 2026-09-18, "empty lots
  // again"). Same cottage cycle, continuing k so neighbours differ, one level
  // above starter (2-3, inside the c-tier ceiling of 4) so the outer ring reads
  // a step up from Starter Cove.
  const outer = LAND_PARCELS.filter((p) => p.tier === 'c');
  for (const parcel of outer) {
    entries.push({
      parcelId: parcel.id,
      style: SHOWROOM_STYLES[k % 3],
      structureType: k % 2 === 0 ? 'home' : 'shop',
      level: 2 + (k % 2),
      signLabel: 'rent',
    });
    k++;
  }

  // ── Premium showcase (Founders' Row inner ring, PREMIUM) ──
  // Placed for REVIEW: Option A (tower-cand-1, Kenney windowed) vs Option C
  // (tower-cand-3, NYC stepped) skyscrapers, alternating, with the approved mall
  // on the last 2 lots — so the founder can compare both towers in-world and
  // pick. Level 5 → top of the scale ramp so premium reads biggest over the
  // starter cottages. (Winner gets promoted to a stable `premium-tower` and the
  // candidates removed; the glass-slab option was rejected.)
  const PREMIUM_LAYOUT: Array<{ style: ShowroomStyle; type: ShowroomStructureType }> = [
    { style: 'tower-cand-1', type: 'home' }, // Option A skyscraper
    { style: 'tower-cand-3', type: 'home' }, // Option C skyscraper
    { style: 'tower-cand-1', type: 'home' }, // Option A
    { style: 'tower-cand-3', type: 'home' }, // Option C
    { style: 'premium-mall', type: 'shop' }, // approved mall
    { style: 'premium-mall', type: 'shop' }, // approved mall
    { style: 'tower-cand-1', type: 'home' }, // Option A
    { style: 'premium-mall', type: 'shop' }, // approved mall
    { style: 'tower-cand-3', type: 'home' }, // Option C
    { style: 'premium-mall', type: 'shop' }, // approved mall
  ];
  const founders = LAND_PARCELS.filter((p) => p.tier === 'founder');
  for (let i = 0; i < Math.min(PREMIUM_LAYOUT.length, founders.length); i++) {
    const slot = PREMIUM_LAYOUT[i];
    entries.push({
      parcelId: founders[i].id,
      style: slot.style,
      structureType: slot.type,
      level: 5, // top of the scale ramp — premium reads biggest
      signLabel: 'premium',
    });
  }

  return entries;
}

/** Deterministic showroom entries for every starter and c parcel and up to ten founders.
 *  Computed once at module load — safe to reference from React components and
 *  server code without memoisation cost. */
export const LAND_SHOWROOM: readonly ShowroomEntry[] = generateShowroom();

/** Fast O(1) lookup: is a parcel id in the showroom set?
 *  Used by land-parcels.tsx to suppress the FOR-SALE sign on showroom lots
 *  (they get a FOR RENT sign from land-showroom.tsx instead). */
export const SHOWROOM_PARCEL_IDS: ReadonlySet<string> = new Set(
  LAND_SHOWROOM.map((e) => e.parcelId),
);
