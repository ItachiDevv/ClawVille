// Land Economy — FROZEN tier contract (Phase 0, 2026-06-15).
//
// Single source of truth for the land-tier taxonomy, fixed supply counts, and the
// stable parcel-code format. BOTH the geometry constant (`land-parcels.ts`, 3D/world) and
// the economic constant (`land-economy.ts`, backend pricing) import from here so the enum
// casing, supply, and id format can never drift across concerns.
//
// Founder-locked decisions (see .claude/plans/land-economy/DESIGN.md final-answers addendum):
//   - World grows to 576x576 tiles (geometry lives in land-parcels.ts).
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

/**
 * FIXED supply per tier (founder-locked 2026-06-15).
 * Founder/A scarce (prestige + land-rush); Starter raised well above day-1 concurrency so it
 * never sells out (onboarding floor, not a scarcity lever). C/B fill the value gradient.
 *
 * The geometry constant (`land-parcels.ts`) enumerates exactly this many parcels per tier; the
 * seed script and the leaderboard/pricing logic read these same counts. Re-confirm Starter vs
 * expected launch concurrency before go-live (ROADMAP §7-Q2).
 */
export const PARCEL_TIER_COUNTS: Record<LandTier, number> = {
  founder: 8, // 8 plots on Founders' Row (4 corners + 4 edge-mids of inner square frame)
  a: 8,
  b: 16,
  c: 40,
  starter: 108, // in the founder-approved 96-120 band; raise if launch concurrency demands
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
