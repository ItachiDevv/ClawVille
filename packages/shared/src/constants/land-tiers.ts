// Land Economy — FROZEN tier contract (Phase 0, 2026-06-15).
//
// Single source of truth for the land-tier taxonomy, fixed supply counts, and the
// stable parcel-code format. BOTH the geometry constant (`land-parcels.ts`, 3D/world) and
// the economic constant (`land-economy.ts`, backend pricing) import from here so the enum
// casing, supply, and id format can never drift across concerns.
//
// Founder-locked decisions (see .claude/plans/land-economy/DESIGN.md final-answers addendum):
//   - World grows to 704x704 tiles (geometry lives in land-parcels.ts; grown 576→704
//     2026-06-24 for the outer c ring).
//   - Fixed concentric supply, scarce inner / abundant outer.
//   - Tier enum is LOWERCASE (Postgres pgEnum convention) — display via tierLabel().
//   - Starter is the onboarding FLOOR (every new player claims one free) — must never sell out.

/** Land tiers, lowercase to match the Postgres `land_tier` pgEnum exactly. */
export type LandTier = 'starter' | 'c' | 'b' | 'a' | 'founder';

/** Inner (most premium) -> outer (most abundant). The order the value gradient reads. */
export const LAND_TIERS: readonly LandTier[] = ['founder', 'a', 'b', 'c', 'starter'] as const;

/** Human-facing labels. UI/agent text uses these; raw enum casing is never shown. */
export const LAND_TIER_LABELS: Record<LandTier, string> = {
  founder: "Founders' Row",
  a: 'A-Tier — Town Crest',
  b: 'B-Tier — Inner Ward',
  c: 'C-Tier — Outer Ward',
  starter: 'Starter Cove',
};

export function tierLabel(tier: LandTier): string {
  return LAND_TIER_LABELS[tier];
}

/** Compact place names used when a specific parcel is shown to a person. */
const PARCEL_DISPLAY_TIER_LABELS: Record<LandTier, string> = {
  founder: "Founders' Row",
  a: 'Town Crest',
  b: 'Inner Ward',
  c: 'Outer Ward',
  starter: 'Starter Cove',
};

/**
 * Stable human-facing name for a technical parcel code.
 *
 * The wire key remains `parcelCode`; this helper only derives presentation
 * copy from its frozen numeric suffix, so no database field or mutable naming
 * registry can drift. Canonical codes use a two-digit, zero-based suffix.
 */
export function parcelDisplayName(code: string, tier: LandTier): string {
  const suffix = /-(\d+)$/.exec(code)?.[1];
  if (!suffix) return PARCEL_DISPLAY_TIER_LABELS[tier];
  return `${PARCEL_DISPLAY_TIER_LABELS[tier]} #${suffix.padStart(2, '0')}`;
}

/**
 * FIXED supply per tier (founder-locked 2026-06-15).
 * Founder/A scarce (prestige + land-rush); Starter raised well above day-1 concurrency so it
 * never sells out (onboarding floor, not a scarcity lever). C/B fill the value gradient.
 *
 * The geometry constant (`land-parcels.ts`) enumerates exactly this many parcels per tier; the
 * seed script and the leaderboard/pricing logic read these same counts. Re-confirm Starter vs
 * expected launch concurrency before go-live (ROADMAP §7-Q2).
 */
// 3-RING layout (2026-06-24, land-builder-economics — "grow the world" option taken):
// the world grew 576→704 tiles, enabling the new OUTER c ring on top of the prior
// 2-ring (founder + starter) layout. 56 LARGE plots across THREE concentric squares,
// so a placed building reads at ~2.5-3x a character instead of ~1/2.
//   - founder  = PREMIUM inner ring (10 plots, just outside the town circle).
//   - starter  = REGULAR mid ring  (26 plots, surrounding the premium ring).
//   - c        = OUTER ring        (20 plots, surrounding starter — NEW in the 704 world).
//   - a/b      = 0 (still unused; the enum + economic Records stay intact so nothing
//                else has to change). a/b can be repopulated if we grow further.
// Footprints are 34-38 tiles (land-parcels.ts TIER_CONFIG). The c tier already has
// full economic configs (price/rent/structure rules) in land-economy.ts, so enabling
// it here produces 20 fully-priced, buyable + rentable parcels with no other change.
export const PARCEL_TIER_COUNTS: Record<LandTier, number> = {
  founder: 10, // PREMIUM inner ring — big plots on the square just outside town
  a: 0,
  b: 0,
  c: 20, // OUTER ring — big plots on the new outermost square (704-world grow)
  starter: 26, // REGULAR mid ring — big plots on the surrounding square
};

/** Total fixed parcel supply across all tiers. */
export const TOTAL_PARCEL_SUPPLY: number = Object.values(PARCEL_TIER_COUNTS).reduce(
  (sum, n) => sum + n,
  0,
);

/**
 * Stable, frozen parcel id/code format: `parcel-<tier>-<NN>` (lowercase tier, zero-padded index).
 * This single string is used identically as `LAND_PARCELS[].id` (geometry constant),
 * `land_parcels.parcel_code` (DB, UNIQUE), and the `stores/land.ts` render key — no mapping layer.
 * Index is 0-based within its tier.
 */
export function parcelCode(tier: LandTier, indexWithinTier: number): string {
  return `parcel-${tier}-${String(indexWithinTier).padStart(2, '0')}`;
}

/** Parse a parcel code back into its tier + index. Returns null on malformed input. */
export function parseParcelCode(code: string): { tier: LandTier; index: number } | null {
  const m = /^parcel-(starter|c|b|a|founder)-(\d{2,})$/.exec(code);
  if (!m) return null;
  return { tier: m[1] as LandTier, index: Number(m[2]) };
}
