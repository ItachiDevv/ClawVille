/**
 * Land Economy — economic constants (Phase 0, 2026-06-15).
 *
 * The SINGLE converged constants file for the land economy (§6.C1). Founder-
 * locked numbers (§6.C4). Imports the FROZEN tier contract from `./land-tiers`
 * (`LandTier`, `PARCEL_TIER_COUNTS`, `parcelCode`) so enum casing, supply, and
 * id format can never drift across concerns.
 *
 * Pricing discipline: the tier ladder below is the SEED INPUT only. The Phase 1
 * seed interpolates `land_parcels.price_ct` per-parcel by index within tier and
 * STAMPS it on the row. The buy route reads `land_parcels.price_ct`, NEVER this
 * ladder — so a retune here never reprices an already-listed parcel (ROADMAP R11).
 */

import { type LandTier, PARCEL_TIER_COUNTS, parcelCode } from './land-tiers';

// Re-export the frozen contract symbols this file builds on, so a consumer can
// import the whole land-economy surface from one module.
export {
  type LandTier,
  LAND_TIERS,
  LAND_TIER_LABELS,
  tierLabel,
  PARCEL_TIER_COUNTS,
  TOTAL_PARCEL_SUPPLY,
  parcelCode,
  parseParcelCode,
} from './land-tiers';

// ─────────────────────────────────────────────────────────────────────────────
// Tier price ladder (seed interpolation input — NOT read at buy time)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-tier CT price band. The Phase 1 seed interpolates `min`→`max` by a
 * parcel's index within its tier (e.g. innermost A = `max`, outermost A = `min`)
 * and stamps the result on `land_parcels.price_ct`. Founder-locked anchors
 * (DESIGN §3 / ROADMAP §6.C4):
 *
 *   - starter: 1st claim is FREE (the seed flags the abundant starter rung with
 *     priceCt=0 for the free-grant path); the rest seed around ~150 CT.
 *   - founder: USDC/auction sentinel — `min/max` are `null`. The seed leaves
 *     `land_parcels.price_ct` NULL and the v1 buy route returns 501
 *     (`founder_tier_not_in_v1`). Any consumer MUST handle `null`.
 */
export const LAND_TIER_LADDER: Record<
  LandTier,
  { minCt: number | null; maxCt: number | null }
> = {
  starter: { minCt: 0, maxCt: 150 },
  c: { minCt: 300, maxCt: 800 },
  b: { minCt: 1500, maxCt: 4000 },
  a: { minCt: 6000, maxCt: 15000 },
  // USDC / auction-only sentinel — out of the v1 CT settle path. NULL = no CT price.
  founder: { minCt: null, maxCt: null },
};

/** Convenience flag: which tiers are buyable with CT in v1 (founder is USDC/auction-only). */
export const CT_BUYABLE_TIERS: readonly LandTier[] = ['starter', 'c', 'b', 'a'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Structure upgrade costs (Lv1 → Lv5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server-authoritative CT cost to REACH each level. Index = target level:
 *   [0]            unused (no level 0)
 *   [1] = 0        free placement lands a structure at Lv1
 *   [2] = 600      Lv1 → Lv2
 *   [3] = 1800     Lv2 → Lv3
 *   [4] = 4500     Lv3 → Lv4
 *   [5] = 11000    Lv4 → Lv5  (~weeks of play — aspirational; ROADMAP §6.C4)
 *
 * The upgrade route derives `cost = STRUCTURE_UPGRADE_COSTS[currentLevel + 1]`
 * — never client-trusted.
 */
export const STRUCTURE_UPGRADE_COSTS: readonly number[] = [0, 0, 600, 1800, 4500, 11000];

/** Max structure level (Lv5). Matches the `land_structures.level BETWEEN 1 AND 5` DB check. */
export const MAX_STRUCTURE_LEVEL = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Structure catalog (allowlist of catalog keys → metadata; GLBs bind in Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

export interface StructureCatalogEntry {
  /** Stable catalog key stored on `land_structures.catalog_key`. */
  readonly key: string;
  /** Display name (UI). */
  readonly label: string;
  /** Which structure type this key is valid for. */
  readonly structureType: 'home' | 'shop';
  /**
   * Minimum structure level this catalog model represents. The upgrade ladder
   * swaps the rendered GLB as `land_structures.level` climbs; Phase 2 binds a
   * GLB to each key. Keys only now — no asset binding in Phase 0.
   */
  readonly tierLevel: number;
}

/**
 * The full catalog allowlist. The placement route validates
 * `catalogKey ∈ STRUCTURE_CATALOG` for the requested structure type; an unknown
 * key is a 400. Homes: shack → mansion. Shops: stall → grand bazaar. These bind
 * to GLBs in Phase 2 (DESIGN decision #8 — catalog placement only, no sandbox).
 */
export const STRUCTURE_CATALOG: readonly StructureCatalogEntry[] = [
  // ── Homes (utility hubs) ──
  { key: 'home-shack', label: 'Shack', structureType: 'home', tierLevel: 1 },
  { key: 'home-cottage', label: 'Cottage', structureType: 'home', tierLevel: 2 },
  { key: 'home-house', label: 'House', structureType: 'home', tierLevel: 3 },
  { key: 'home-villa', label: 'Villa', structureType: 'home', tierLevel: 4 },
  { key: 'home-mansion', label: 'Mansion', structureType: 'home', tierLevel: 5 },
  // ── Shops (commercial — run paid services) ──
  { key: 'shop-stall', label: 'Stall', structureType: 'shop', tierLevel: 1 },
  { key: 'shop-shopfront', label: 'Shopfront', structureType: 'shop', tierLevel: 2 },
  { key: 'shop-market', label: 'Market', structureType: 'shop', tierLevel: 3 },
  { key: 'shop-emporium', label: 'Emporium', structureType: 'shop', tierLevel: 4 },
  { key: 'shop-grand-bazaar', label: 'Grand Bazaar', structureType: 'shop', tierLevel: 5 },
] as const;

/** Catalog keys valid for HOME placement. */
export const HOME_CATALOG_KEYS: readonly string[] = STRUCTURE_CATALOG.filter(
  (e) => e.structureType === 'home',
).map((e) => e.key);

/** Catalog keys valid for SHOP placement. */
export const SHOP_CATALOG_KEYS: readonly string[] = STRUCTURE_CATALOG.filter(
  (e) => e.structureType === 'shop',
).map((e) => e.key);

/** O(1) lookup of a catalog entry by key (null if not an allowlisted key). */
export function getCatalogEntry(key: string): StructureCatalogEntry | null {
  return STRUCTURE_CATALOG.find((e) => e.key === key) ?? null;
}

/** Validate a catalog key against the allowlist for a given structure type. */
export function isValidCatalogKey(key: string, structureType: 'home' | 'shop'): boolean {
  const entry = getCatalogEntry(key);
  return entry !== null && entry.structureType === structureType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership cap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Max parcels one avatar can own in v1 (tunable; ROADMAP §7-Q7). Prevents a
 * single whale buying out the scarce inner ring. The buy route COUNTs owned
 * parcels under the row lock and rejects at this cap.
 */
export const MAX_PARCELS_PER_AVATAR = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Leaderboard event types + weights/caps (consistent with CLAUDE.md scheme)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Land-economy leaderboard events. Weights + daily caps mirror the canonical
 * leaderboard scheme in CLAUDE.md (learning > arcade; commerce ≈ collaboration):
 *
 *   - `land.parcel.purchased`  weight 5  — meaningful commitment (one-shot per parcel)
 *   - `land.structure.placed`  weight 3  — engagement (like building.visited)
 *   - `land.structure.upgraded` weight 5 — investment signal
 *   - `land.service.sold`      weight 40 — credited to the SELLER; THE human↔agent /
 *                                          agent↔agent commerce axis (mirrors the
 *                                          load-bearing `agent.collaboration.turn` 40)
 *
 * Daily caps are applied per-subject as `LEAST(count, cap)` (anti-farm, salted by
 * FINGERPRINT_SECRET). Phase 1/2/3 wire these into `leaderboard.ts`.
 */
export const LAND_EVENT_TYPES = {
  PARCEL_PURCHASED: 'land.parcel.purchased',
  STRUCTURE_PLACED: 'land.structure.placed',
  STRUCTURE_UPGRADED: 'land.structure.upgraded',
  SERVICE_SOLD: 'land.service.sold',
} as const;

export type LandEventType = (typeof LAND_EVENT_TYPES)[keyof typeof LAND_EVENT_TYPES];

/** Leaderboard point weight per land event. */
export const LAND_EVENT_WEIGHTS: Record<LandEventType, number> = {
  [LAND_EVENT_TYPES.PARCEL_PURCHASED]: 5,
  [LAND_EVENT_TYPES.STRUCTURE_PLACED]: 3,
  [LAND_EVENT_TYPES.STRUCTURE_UPGRADED]: 5,
  [LAND_EVENT_TYPES.SERVICE_SOLD]: 40,
};

/** Daily per-subject cap per land event (anti-farm `LEAST(count, cap)`). */
export const LAND_EVENT_DAILY_CAPS: Record<LandEventType, number> = {
  [LAND_EVENT_TYPES.PARCEL_PURCHASED]: 5, // ≤ MAX_PARCELS_PER_AVATAR; realistically tiny
  [LAND_EVENT_TYPES.STRUCTURE_PLACED]: 5,
  [LAND_EVENT_TYPES.STRUCTURE_UPGRADED]: 10,
  [LAND_EVENT_TYPES.SERVICE_SOLD]: 50, // mirrors the collaboration cap (a busy shop)
};

// ─────────────────────────────────────────────────────────────────────────────
// Rest bonus — DEFERRED, FOUNDER-GATED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HOME passive CT rest bonus — the ONLY recurring CT *source* in lean v1, so its
 * rate is a faucet lever.
 *
 * ⛔ FOUNDER-GATED (see TODO.md, ROADMAP §7-Q3). The Phase 2 `POST /home/:id/claim-rest`
 *    route MUST NOT ship until the founder confirms this is a real number.
 *    `null` = the rest bonus is DISABLED. Any consumer MUST treat `null` as
 *    "feature off" (do not credit, do not show the claim affordance).
 *
 * Planner recommendation when the founder confirms: 40 CT/day, capped BELOW the
 * ~50–120 CT/day active earn rate, shipped alongside the `/dash` Land-Economy
 * faucet-watch (track `ct_minted_rest_per_day` vs active earn; if rest > 25% of
 * daily minted CT, tighten this cap first).
 */
export const REST_BONUS_DAILY_CAP_CT: number | null = null;

/** True only once the founder has set a real `REST_BONUS_DAILY_CAP_CT`. */
export function isRestBonusEnabled(): boolean {
  return REST_BONUS_DAILY_CAP_CT !== null;
}
