// Land Signage — visual category model for FOR-SALE signs on land parcels.
//
// Separates VISUAL sign fanciness from the ECONOMIC tier contract in land-tiers.ts.
// Do NOT use this module for pricing, supply, or economic decisions — those live in
// land-economy.ts and land-tiers.ts. This module is purely 3D/visual.
//
// Three sign categories, escalating in size + fanciness:
//   regular        — basic sign, current size, "FOR SALE" one-liner.
//   premium        — ~1.35× bigger, gold double-border, "FOR SALE" + "PREMIUM" subtitle.
//   premium-partner — ~1.7× bigger, cyan/platinum ornate border+topper, "FOR SALE" + "PARTNER" subtitle.
//
// Category assignment:
//   premium        — founder + a tiers (the inner square frames closest to town center).
//   premium-partner — a game-owner-curated subset of the premium ring reserved for
//                     featured partner plots; they share the same premium land but get
//                     the fanciest sign. Selected by PREMIUM_PARTNER_PARCEL_IDS.
//   regular        — all other tiers (b, c, starter).
//
// This constant is safe to import in both web (Three.js) and server (utils) — it
// only imports from frozen sibling constants, never from framework code.

import { type LandTier } from './land-tiers';
import { type ParcelSlot, LAND_PARCELS } from './land-parcels';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LandSignCategory = 'regular' | 'premium' | 'premium-partner';

// ---------------------------------------------------------------------------
// Which tiers get the premium sign (inner frames only)
// ---------------------------------------------------------------------------

/** Tiers that receive the premium sign. Inner-ring plots only. */
export const PREMIUM_SIGN_TIERS: readonly LandTier[] = ['founder', 'a'];

// ---------------------------------------------------------------------------
// Partner parcel IDs — curated subset of premium-ring plots
// ---------------------------------------------------------------------------

// Selection criteria:
//   - Must exist in LAND_PARCELS (verified: LAND_PARCELS uses parcelCode(tier, i)
//     format = "parcel-<tier>-<NN>").
//   - Spread across both founder + a tiers so partner signage appears in multiple
//     quadrants of the premium ring.
//   - Include parcel-founder-00 and parcel-founder-02 because those are the lots
//     that carry the premium showcase towers (tower-cand-1 + tower-cand-3 in
//     land-showroom.ts) — partner signs show in the review/comparison area.
//
// 2-RING layout (2026-06-18): the premium ring is the `founder` tier (10 plots,
// indices 00..09); `a` is now empty, so partner plots are founder-only. Chosen 4,
// spread around the inner square (every ~3rd of 10). founder-00 + founder-02 carry
// the premium showcase towers (land-showroom.ts), so partner signs show in the
// review area.
//   parcel-founder-00, parcel-founder-03, parcel-founder-06, parcel-founder-09
// Confirmed present: PARCEL_TIER_COUNTS.founder = 10 → indices 00..09 all exist ✓
export const PREMIUM_PARTNER_PARCEL_IDS: ReadonlySet<string> = new Set([
  'parcel-founder-00',
  'parcel-founder-03',
  'parcel-founder-06',
  'parcel-founder-09',
]);

// ---------------------------------------------------------------------------
// Runtime self-check (dev mode only) — will throw if a partner ID is missing
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV !== 'production') {
  const knownIds = new Set(LAND_PARCELS.map((p) => p.id));
  for (const id of PREMIUM_PARTNER_PARCEL_IDS) {
    if (!knownIds.has(id)) {
      throw new Error(
        `[land-signage] PREMIUM_PARTNER_PARCEL_IDS contains unknown parcel id: "${id}". ` +
        `Check PARCEL_TIER_COUNTS in land-tiers.ts.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Category resolver
// ---------------------------------------------------------------------------

/**
 * Returns the visual sign category for a parcel.
 *
 * Priority (highest first):
 *   1. premium-partner — curated subset of premium plots (hand-picked partner lots).
 *   2. premium         — all founder + a tier plots not in the partner set.
 *   3. regular         — all other plots (b, c, starter).
 */
export function getLandSignCategory(parcel: ParcelSlot): LandSignCategory {
  if (PREMIUM_PARTNER_PARCEL_IDS.has(parcel.id)) return 'premium-partner';
  if ((PREMIUM_SIGN_TIERS as readonly string[]).includes(parcel.tier)) return 'premium';
  return 'regular';
}
