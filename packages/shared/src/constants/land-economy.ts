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
import { getParcelFootprintWu } from './land-parcels';

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
 *     priceCt=0 for the free-grant path); the rest seed around ~1500 units.
 *   - founder: USDC/auction sentinel — `min/max` are `null`. The seed leaves
 *     `land_parcels.price_ct` NULL and the v1 buy route returns 501
 *     (`founder_tier_not_in_v1`). Any consumer MUST handle `null`.
 *
 * A3 ¢-peg re-band (2026-07-07): STARTER kept purchasing power — max ×10
 * (150→1500 units = $15 at $0.01), matching the founder's "starter stays cheap
 * (0–1,500 units)". The c/b/a buy-outright bands are LEFT UNCHANGED (NOT ×10,
 * NOT re-banded): per the founder, C/B/A purchase prices become IRRELEVANT once
 * land tenure moves to CLV hold-to-keep in Phase B — "leave values, do not gate
 * on them, note it." So c/b/a are effectively 10× cheaper in USD now (a stopgap
 * until Phase B replaces buy-outright with claim-locks) and MUST NOT be treated
 * as a coherent USD price. Migration 0011 ×10's only the starter parcel rows.
 */
export const LAND_TIER_LADDER: Record<LandTier, { minCt: number | null; maxCt: number | null }> = {
  starter: { minCt: 0, maxCt: 1500 },
  // Buy-outright bands (founder-locked 2026-06-24). LEFT UNCHANGED by the A3
  // re-band — DEPRECATED/IRRELEVANT (Phase B replaces buy-outright with CLV
  // claim-locks; do not gate on these USD-wise). See the block comment above.
  c: { minCt: 2000, maxCt: 4000 },
  b: { minCt: 10000, maxCt: 24000 },
  a: { minCt: 40000, maxCt: 80000 },
  // USDC / auction-only sentinel — out of the v1 CT settle path. NULL = no CT price.
  founder: { minCt: null, maxCt: null },
};

/**
 * Per-tier WEEKLY rent band (founder-locked 2026-06-24). Rent is the recurring
 * CT sink (-> treasury/burn) that keeps the economy from inflating once services
 * circulate. Interpolated per parcel index within tier EXACTLY like the buy
 * ladder (innermost = max, outermost = min) and STAMPED on
 * `land_parcels.rent_ct_weekly` at seed/migration; the rent route reads the
 * stamped row value, NEVER this ladder (same discipline as price_ct).
 *
 * Buy is ~9-11 months of rent at these numbers, so buying is a premium over
 * renting, not a shortcut. starter (free+owned, never rents) + founder
 * (USDC/auction) are NULL = not rentable.
 *
 * A3 ¢-peg re-band (2026-07-07): these values are UNCHANGED — they are already
 * the founder's target band (c 50–100, b 250–550, a 1000–2400 units/week), so
 * the re-band OVERRIDES the ×10 for rent (migration 0011 does NOT touch
 * rent_ct_weekly rows). At the $0.01 peg that is $0.50–24/wk (was $5–240/wk at
 * the old $0.10 rate — rent got 10× cheaper in USD, deliberately).
 */
export const LAND_RENT_LADDER: Record<LandTier, { minCt: number | null; maxCt: number | null }> = {
  starter: { minCt: null, maxCt: null },
  c: { minCt: 50, maxCt: 100 },
  b: { minCt: 250, maxCt: 550 },
  a: { minCt: 1000, maxCt: 2400 },
  founder: { minCt: null, maxCt: null },
};

/** Convenience flag: which tiers are buyable with CT in v1 (founder is USDC/auction-only). */
export const CT_BUYABLE_TIERS: readonly LandTier[] = ['starter', 'c', 'b', 'a'] as const;

/** P2 vCLAW rent door; founder is hold/auction-only and a/b are retired. */
export const CT_RENTABLE_TIERS: readonly LandTier[] = ['starter', 'c'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Phase B tenure model (FOUNDER-DECIDED 2026-07-07) — deposit-escrow + hold-to-keep
// ─────────────────────────────────────────────────────────────────────────────
//
// Land is never sold permanently. Two tenure mechanisms replace buy-outright:
//   B1 starter  = vCLAW DEPOSIT-ESCROW. The claim debits a refundable deposit
//                 into escrow (a NUMBER on the parcel row — the CT exists in NO
//                 avatar balance while escrowed). Weekly rent auto-draws from
//                 the escrow remainder → house treasury; voluntary release
//                 refunds the remainder; exhaustion → grace → lapse (remainder
//                 forfeits to the treasury — nothing refunded).
//   B2 c/b/a/founder = HOLD-TO-KEEP. Claiming requires the subject's CLV
//                 balance ≥ the tier threshold (thresholds STACK across held
//                 parcels); a weekly CT upkeep draws from the holder's avatar
//                 balance → treasury. CLV-below-threshold OR insufficient CT at
//                 sweep → grace → lapse. Purchase (price_ct) is DEAD for these
//                 tiers (`tenure_model_active` 409).

/**
 * Refundable vCLAW deposit (units) debited INTO ESCROW on a starter claim.
 * FOUNDER-LOCKED 2026-07-07 (2000 units ≈ $20 at the ¢-peg). Refundable on
 * voluntary release (remainder only); forfeited on lapse. NOT revenue at claim
 * time — only the weekly draws (and a lapse forfeit) reach the treasury.
 */
export const LAND_STARTER_DEPOSIT_CT = 2000;

/**
 * Weekly rent (units/week) auto-drawn FROM THE ESCROW REMAINDER of a starter
 * deposit parcel — the tenant is never debited again after the claim; the
 * sweeper moves escrow → treasury.
 *
 * ⚠ FOUNDER-TUNABLE / UNCONFIRMED (JUDGMENT CALL 2026-07-07): 100/wk makes the
 * 2000 deposit last ≈ 20 weeks with no top-up — chosen to sit at the c-tier
 * rent ceiling (LAND_RENT_LADDER c = 50–100) so a starter is never cheaper to
 * hold than a paid tier. Confirm with the founder before prod.
 */
export const LAND_STARTER_RENT_CT_WEEKLY = 100;

/** P2 claim prices. Never derive a quote from a parcel row's legacy stamp. */
export const LAND_TENURE_RENT_CT_WEEKLY: Record<LandTier, number | null> = {
  starter: 1_000,
  c: 2_500,
  b: null,
  a: null,
  founder: null,
};

export function tenureRentCtWeeklyForTier(tier: LandTier): number | null {
  return LAND_TENURE_RENT_CT_WEEKLY[tier];
}

/**
 * P2 per-tier CLV hold thresholds, in CLV **uiAmount** (human
 * token count — NOT atomic base units; compare against
 * `ClvBalanceResult.uiAmount`). FOUNDER-LOCKED 2026-07-07:
 * c 100k / b 500k / a 2.5M / founder 10M. `null` = the tier is not holdable
 * (starter uses the B1 deposit-escrow path). Thresholds STACK: holding
 * multiple parcels requires the SUM of their thresholds.
 */
export const LAND_HOLD_THRESHOLDS_CLV: Record<LandTier, number | null> = {
  starter: 100_000,
  c: 250_000,
  b: null,
  a: null,
  founder: 10_000_000,
};

/**
 * Weekly CT upkeep for a FOUNDER-tier hold parcel (units/week). Founder rows
 * carry rent_ct_weekly NULL (the rent ladder never priced them), so the
 * claim-hold route stamps THIS value on acquisition. c/b/a hold parcels keep
 * their already-stamped `rent_ct_weekly` as the upkeep. Founder-tunable —
 * set at the a-tier rent ceiling (LAND_RENT_LADDER a max = 2400).
 */
export const FOUNDER_UPKEEP_CT_WEEKLY = 2400;

/** The CLV hold threshold for a tier (uiAmount), or null when not holdable. */
export function holdThresholdForTier(tier: LandTier): number | null {
  return LAND_HOLD_THRESHOLDS_CLV[tier];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rent cycle timing (founder-locked 2026-06-24)
// ─────────────────────────────────────────────────────────────────────────────

/** Rent charge period: a rented parcel owes `rent_ct_weekly` every 7 days. */
export const RENT_PERIOD_DAYS = 7;

/**
 * Grace window after a missed rent charge. The parcel's perks + shop listings are
 * PAUSED (hidden) for this many days; if the charge still cannot be collected by
 * the end of grace, the parcel is evicted (returns to the available pool, the
 * structure is archived not destroyed).
 */
export const RENT_GRACE_DAYS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Structure upgrade costs (Lv1 → Lv5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server-authoritative CT cost to REACH each level, keyed by structure type.
 * Index = target level; `[0]` is unused (there is no level 0) and `[1] = 0`
 * because free placement lands a structure at Lv1.
 *
 *            Lv2     Lv3     Lv4     Lv5
 *   home       0     900   4,500  11,000
 *   shop     600   1,800   4,500  11,000
 *
 * Repriced 2026-08-09 (founder ruling Q3), HOME LADDER ONLY. The problem it
 * solves: reaching Lv3 on a home cost 2,400 CT of upgrades on top of the
 * pieces, so the whole 2,585 CT onboarding grant bought 88% of one finished
 * yard. Lv2 is now free — every new player reaches the first real capacity
 * bump without saving — and Lv3 is halved. Lv4/Lv5 are untouched: they are
 * still meant to be aspirational. The SHOP ladder is unchanged; shops recover
 * the giveback through their recurring slot rentals.
 *
 * The upgrade route derives
 * `cost = structureUpgradeCostCt(structureType, currentLevel + 1)` from the
 * LOCKED structure row — never client-trusted.
 *
 * A3 ¢-peg re-band (2026-07-07): these were left out of the founder's explicit
 * re-band list, so they are not a coherent USD price. Do not read them as one.
 */
export const STRUCTURE_UPGRADE_COSTS_BY_TYPE: Readonly<
  Record<LandStructureType, readonly number[]>
> = {
  home: [0, 0, 0, 900, 4500, 11000],
  shop: [0, 0, 600, 1800, 4500, 11000],
};

/**
 * The authoritative upgrade-cost lookup. Returns 0 for a level outside the
 * ladder, matching the route's `?? 0` guard.
 */
export function structureUpgradeCostCt(
  structureType: LandStructureType,
  targetLevel: number,
): number {
  return STRUCTURE_UPGRADE_COSTS_BY_TYPE[structureType][targetLevel] ?? 0;
}

/**
 * @deprecated Use `structureUpgradeCostCt(structureType, targetLevel)`.
 *
 * Retained as the SHOP ladder so the pre-reprice shape and numbers still
 * resolve for callers with no structure type in scope: the guest land sandbox
 * (`apps/web/src/stores/land-guest-sandbox.ts`, `guest-land-sandbox.tsx`),
 * which is a DEMO economy that settles nothing. Real settlement always goes
 * through the type-keyed lookup above.
 */
export const STRUCTURE_UPGRADE_COSTS: readonly number[] =
  STRUCTURE_UPGRADE_COSTS_BY_TYPE.shop;

/**
 * Weekly rent for ONE shop service-listing slot, in whole vCLAW (founder ruling
 * Q3). This is the recurring sink that funds the home-side giveback: home piece
 * fees dropped to a third and the home Lv2 upgrade became free, which is a
 * ~20,400 CT one-time cost across 10 commerce players. At 100% uptake this
 * recovers it in about 1.3 weeks; at 25%, about 5.
 *
 * Charged by `service-slot-rent-sweeper.ts`, never at listing creation — a new
 * listing is granted its first week so a shop is never billed before it has had
 * a chance to sell anything.
 */
export const SERVICE_LISTING_SLOT_RENT_CT_WEEKLY = 400;

/**
 * Weekly rent for the PREMIUM featured placement, in whole vCLAW. Charged on a
 * cursor entirely separate from the slot rent, so a shop that can afford its
 * slot but not its feature keeps selling and only loses the placement.
 */
export const SERVICE_FEATURED_SLOT_RENT_CT_WEEKLY = 1200;

/** Max structure level (Lv5). Matches the `land_structures.level BETWEEN 1 AND 5` DB check. */
export const MAX_STRUCTURE_LEVEL = 5;

// Structure appearance catalogs (P1 shell + palette build loop).

export const DEFAULT_SHELL_KEY = 'coastal-cottage' as const;
export const DEFAULT_PALETTE_KEY = 'classic' as const;

export type LandStructureType = 'home' | 'shop';

export interface ShellCatalogEntry {
  readonly key: string;
  readonly label: string;
  readonly structureType: LandStructureType;
  /** Public path to the verified on-disk GLB. */
  readonly modelPath: string;
  /** Structure level at which the shell first becomes eligible. */
  readonly minLevel: number;
  /** Premium shells also require a b/a/founder parcel. */
  readonly premium: boolean;
}

/**
 * Server-owned shell catalog. Every entry below was verified on disk under
 * `apps/web/public/models/land-structures`; there is no distinct founder GLB,
 * so the type-specific premium asset is the Lv5 ceiling in P1.
 */
export const SHELL_CATALOG: readonly ShellCatalogEntry[] = [
  {
    key: 'coastal-cottage',
    label: 'Coastal Cottage',
    structureType: 'home',
    modelPath: '/models/land-structures/coastal-cottage/home2.glb',
    minLevel: 1,
    premium: false,
  },
  {
    key: 'driftwood-cabin',
    label: 'Driftwood Cabin',
    structureType: 'home',
    modelPath: '/models/land-structures/driftwood-cabin/home2.glb',
    minLevel: 2,
    premium: false,
  },
  {
    key: 'fantasy-cottage',
    label: 'Fantasy Cottage',
    structureType: 'home',
    modelPath: '/models/land-structures/fantasy-cottage/home2.glb',
    minLevel: 2,
    premium: false,
  },
  // ── Meshy catalog ramp, 2026-08-09 ────────────────────────────────────────
  // Seven new home shells. All non-premium, so any tier may use them once the
  // level is reached; premium remains the two Lv4 tower/mall assets below.
  //
  // ⚠ minLevel VALUES ARE FOUNDER-TUNABLE. They are a first pass at pacing —
  // one more shell to choose from at Lv1, a spread of four at Lv2, and the
  // three tall silhouettes held back to Lv3 so upgrading visibly changes your
  // skyline rather than just your palette. Nothing structural depends on these
  // numbers: `isShellAllowed` reads `minLevel` straight off this row, the
  // picker locks on the same helper, and the allowlist test derives its
  // expectations from this catalog. Retuning is a one-line edit per row.
  //
  // Measured at freeze (world-space bbox, meshopt + WebP, 1 material each):
  //   pearl-dome      1.898 x 1.236 x 1.899, H/W 0.65, 3,115 tri, 238 KB
  //   tiki-hut        1.857 x 1.165 x 1.287, H/W 0.63, 2,753 tri, 436 KB
  //   anchor-forge    1.889 x 1.112 x 1.892, H/W 0.59, 3,069 tri, 302 KB
  //   shipwreck-mast  1.722 x 1.897 x 0.699, H/W 1.10, 3,883 tri, 441 KB
  //   tide-lighthouse 0.867 x 1.899 x 0.991, H/W 1.92, 4,033 tri, 335 KB
  //   kelp-spire      0.849 x 1.898 x 0.856, H/W 2.22, 4,166 tri, 413 KB
  //   coral-highrise  0.609 x 1.895 x 0.491, H/W 3.11, 3,785 tri, 293 KB
  // All within the §4.3 shell budget (≤ 6,000 tri, ≤ 2 materials, ≤ 500 KB).
  // `coral-highrise` (H/W 3.11) and `kelp-spire` (2.22) sit ABOVE the 2.254
  // footprint/height crossover, so their rendered size is height-bound rather
  // than footprint-bound — they read as genuinely tall on a parcel.
  {
    key: 'pearl-dome',
    label: 'Pearl Dome',
    structureType: 'home',
    modelPath: '/models/land-structures/pearl-dome/home.glb',
    minLevel: 1,
    premium: false,
  },
  {
    key: 'tiki-hut',
    label: 'Tiki Hut',
    structureType: 'home',
    modelPath: '/models/land-structures/tiki-hut/home.glb',
    minLevel: 2,
    premium: false,
  },
  {
    key: 'anchor-forge',
    label: 'Anchor Forge',
    structureType: 'home',
    modelPath: '/models/land-structures/anchor-forge/home.glb',
    minLevel: 2,
    premium: false,
  },
  {
    key: 'shipwreck-mast',
    label: 'Shipwreck Mast',
    structureType: 'home',
    modelPath: '/models/land-structures/shipwreck-mast/home.glb',
    minLevel: 2,
    premium: false,
  },
  {
    key: 'tide-lighthouse',
    label: 'Tide Lighthouse',
    structureType: 'home',
    modelPath: '/models/land-structures/tide-lighthouse/home.glb',
    minLevel: 3,
    premium: false,
  },
  {
    key: 'kelp-spire',
    label: 'Kelp Spire',
    structureType: 'home',
    modelPath: '/models/land-structures/kelp-spire/home.glb',
    minLevel: 3,
    premium: false,
  },
  {
    key: 'coral-highrise',
    label: 'Coral Highrise',
    structureType: 'home',
    modelPath: '/models/land-structures/coral-highrise/home.glb',
    minLevel: 3,
    premium: false,
  },
  {
    key: 'premium-tower',
    label: 'Tideglass Tower',
    structureType: 'home',
    modelPath: '/models/land-structures/premium-tower/home.glb',
    minLevel: 4,
    premium: true,
  },
  {
    key: 'coastal-cottage',
    label: 'Coastal Shop',
    structureType: 'shop',
    modelPath: '/models/land-structures/coastal-cottage/shop2.glb',
    minLevel: 1,
    premium: false,
  },
  {
    key: 'driftwood-cabin',
    label: 'Driftwood Shop',
    structureType: 'shop',
    modelPath: '/models/land-structures/driftwood-cabin/shop2.glb',
    minLevel: 2,
    premium: false,
  },
  {
    key: 'fantasy-cottage',
    label: 'Fantasy Shop',
    structureType: 'shop',
    modelPath: '/models/land-structures/fantasy-cottage/shop2.glb',
    minLevel: 2,
    premium: false,
  },
  {
    key: 'premium-mall',
    label: 'Pearl Arcade',
    structureType: 'shop',
    modelPath: '/models/land-structures/premium-mall/shop.glb',
    minLevel: 4,
    premium: true,
  },
] as const;

export interface PalettePreset {
  readonly key: string;
  readonly label: string;
  /** Base, accent, and trim tints multiplied into authored mesh materials. */
  readonly swatches: readonly [string, string, string];
  readonly minLevel: 1 | 2;
}

/** Eight curated sea-town presets; Lv1 exposes the first three, Lv2+ all eight. */
export const PALETTE_PRESETS: readonly PalettePreset[] = [
  {
    key: 'classic',
    label: 'Harbor Classic',
    // Identity tint: existing structures retain their authored GLB appearance.
    swatches: ['#FFFFFF', '#FFFFFF', '#FFFFFF'],
    minLevel: 1,
  },
  {
    key: 'seafoam',
    label: 'Seafoam',
    swatches: ['#DDF3E4', '#73B9A2', '#2F6F73'],
    minLevel: 1,
  },
  {
    key: 'sunset-coral',
    label: 'Sunset Coral',
    swatches: ['#FFE0C2', '#E9826B', '#7D5A7A'],
    minLevel: 1,
  },
  {
    key: 'deep-current',
    label: 'Deep Current',
    swatches: ['#C8DCE8', '#315B7D', '#163247'],
    minLevel: 2,
  },
  {
    key: 'pearl-gold',
    label: 'Pearl & Gold',
    swatches: ['#F7F1E3', '#C8A45D', '#6B7C82'],
    minLevel: 2,
  },
  {
    key: 'kelp-garden',
    label: 'Kelp Garden',
    swatches: ['#DDE6C7', '#728C56', '#C58B57'],
    minLevel: 2,
  },
  {
    key: 'storm-lilac',
    label: 'Storm Lilac',
    swatches: ['#DED9EA', '#756C91', '#39465C'],
    minLevel: 2,
  },
  {
    key: 'lagoon-night',
    label: 'Lagoon Night',
    swatches: ['#A9D9D0', '#176B78', '#F0B86E'],
    minLevel: 2,
  },
] as const;

/** Resolve a verified shell entry for a structure type, or null for bad input. */
export function getShellCatalogEntry(structureType: LandStructureType, shellKey: string): ShellCatalogEntry | null {
  return SHELL_CATALOG.find((entry) => entry.structureType === structureType && entry.key === shellKey) ?? null;
}

/** Resolve a named palette preset, or null for bad input. */
export function getPalettePreset(paletteKey: string): PalettePreset | null {
  return PALETTE_PRESETS.find((preset) => preset.key === paletteKey) ?? null;
}

/**
 * Tiers that may equip premium appearance shells. This is intentionally not
 * `TierStructureRule.premium`, which describes founder-only SKU/acquisition
 * privileges rather than the appearance-shell gate.
 */
export const PREMIUM_SHELL_TIERS: readonly LandTier[] = ['b', 'a', 'founder'];

/**
 * Server-authoritative shell gate. The current DB level and parcel tier are
 * both required: a level outside its parcel ceiling is invalid, and the D2
 * starter/c max-level raise must never grant either tier a premium shell.
 */
export function isShellAllowed(
  structureType: LandStructureType,
  level: number,
  parcelTier: LandTier,
  shellKey: string,
): boolean {
  if (!Number.isInteger(level) || level < 1 || level > TIER_STRUCTURE_RULES[parcelTier].maxLevel) {
    return false;
  }
  const shell = getShellCatalogEntry(structureType, shellKey);
  if (shell === null || level < shell.minLevel) return false;
  if (!shell.premium) return true;
  return PREMIUM_SHELL_TIERS.includes(parcelTier);
}

/** Server-authoritative palette gate: three presets at Lv1, all eight at Lv2+. */
export function isPaletteAllowed(level: number, paletteKey: string): boolean {
  if (!Number.isInteger(level) || level < 1 || level > MAX_STRUCTURE_LEVEL) return false;
  const preset = getPalettePreset(paletteKey);
  return preset !== null && level >= preset.minLevel;
}

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
  {
    key: 'home-cottage',
    label: 'Cottage',
    structureType: 'home',
    tierLevel: 2,
  },
  { key: 'home-house', label: 'House', structureType: 'home', tierLevel: 3 },
  { key: 'home-villa', label: 'Villa', structureType: 'home', tierLevel: 4 },
  {
    key: 'home-mansion',
    label: 'Mansion',
    structureType: 'home',
    tierLevel: 5,
  },
  // ── Founder-only premium home (Founders' Row exclusive) ──
  {
    key: 'home-founders-estate',
    label: "Founders' Estate",
    structureType: 'home',
    tierLevel: 5,
  },
  // ── Shops (commercial — run paid services) ──
  { key: 'shop-stall', label: 'Stall', structureType: 'shop', tierLevel: 1 },
  {
    key: 'shop-shopfront',
    label: 'Shopfront',
    structureType: 'shop',
    tierLevel: 2,
  },
  { key: 'shop-market', label: 'Market', structureType: 'shop', tierLevel: 3 },
  {
    key: 'shop-emporium',
    label: 'Emporium',
    structureType: 'shop',
    tierLevel: 4,
  },
  {
    key: 'shop-grand-bazaar',
    label: 'Grand Bazaar',
    structureType: 'shop',
    tierLevel: 5,
  },
  // ── Founder-only premium shop (Founders' Row exclusive) ──
  {
    key: 'shop-founders-exchange',
    label: "Founders' Exchange",
    structureType: 'shop',
    tierLevel: 5,
  },
] as const;

/** Catalog keys valid for HOME placement. */
export const HOME_CATALOG_KEYS: readonly string[] = STRUCTURE_CATALOG.filter((e) => e.structureType === 'home').map(
  (e) => e.key,
);

/** Catalog keys valid for SHOP placement. */
export const SHOP_CATALOG_KEYS: readonly string[] = STRUCTURE_CATALOG.filter((e) => e.structureType === 'shop').map(
  (e) => e.key,
);

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
// Tier-gated structure ladder (SERVER-AUTHORITATIVE — routes call these helpers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-tier gating ladder. A higher land tier unlocks a higher upgrade
 * CEILING (`maxLevel`) AND more / premium catalog SKUs — that is the "nicer
 * options for higher tiers" payoff that makes the scarce inner ring worth
 * buying. Each tier is a strict SUPERSET of the one below it.
 *
 * How the route uses this ladder:
 *   - PLACEMENT lands a FREE Lv1 structure (`STRUCTURE_UPGRADE_COSTS[1] === 0`),
 *     but ONLY if `isSkuAllowedForTier(sku, type, parcel.tier)` — a starter
 *     parcel can never place a founder SKU.
 *   - UPGRADE is priced by TARGET level via `STRUCTURE_UPGRADE_COSTS[target]`
 *     and is CAPPED at `getTierMaxLevel(parcel.tier)`. A starter home (maxLevel
 *     2) therefore can never pass Lv2; an A-tier home can climb to Lv5. The cost
 *     is ALWAYS server-derived from the target level — never client-supplied.
 *
 * `premium` flags the founder tier (the only one whose SKU set includes the
 * `*-founders-*` exclusives + USDC/auction acquisition — out of the v1 CT buy
 * path). The arrays are written as explicit literals (not runtime spreads) so
 * the gate is auditable at a glance and never depends on evaluation order.
 */
export interface TierStructureRule {
  /** Max upgrade level a structure on this tier may reach (1..5). */
  readonly maxLevel: number;
  /** Home catalog keys placeable on this tier (superset of all lower tiers). */
  readonly homeSkus: readonly string[];
  /** Shop catalog keys placeable on this tier (superset of all lower tiers). */
  readonly shopSkus: readonly string[];
  /** True only for the founder tier (premium SKUs + auction/USDC acquisition). */
  readonly premium: boolean;
}

export const TIER_STRUCTURE_RULES: Record<LandTier, TierStructureRule> = {
  starter: {
    maxLevel: 3,
    homeSkus: ['home-shack', 'home-cottage'],
    shopSkus: ['shop-stall', 'shop-shopfront'],
    premium: false,
  },
  c: {
    maxLevel: 4,
    homeSkus: ['home-shack', 'home-cottage', 'home-house'],
    shopSkus: ['shop-stall', 'shop-shopfront', 'shop-market'],
    premium: false,
  },
  b: {
    maxLevel: 4,
    homeSkus: ['home-shack', 'home-cottage', 'home-house', 'home-villa'],
    shopSkus: ['shop-stall', 'shop-shopfront', 'shop-market', 'shop-emporium'],
    premium: false,
  },
  a: {
    maxLevel: 5,
    homeSkus: ['home-shack', 'home-cottage', 'home-house', 'home-villa', 'home-mansion'],
    shopSkus: ['shop-stall', 'shop-shopfront', 'shop-market', 'shop-emporium', 'shop-grand-bazaar'],
    premium: false,
  },
  founder: {
    maxLevel: 5,
    homeSkus: ['home-shack', 'home-cottage', 'home-house', 'home-villa', 'home-mansion', 'home-founders-estate'],
    shopSkus: [
      'shop-stall',
      'shop-shopfront',
      'shop-market',
      'shop-emporium',
      'shop-grand-bazaar',
      'shop-founders-exchange',
    ],
    premium: true,
  },
};

/** The full tier rule object (homeSkus/shopSkus/maxLevel/premium) for a tier. */
export function getTierStructureRules(tier: LandTier): TierStructureRule {
  return TIER_STRUCTURE_RULES[tier];
}

/** Max upgrade level a structure on this tier may reach (the tier ceiling). */
export function getTierMaxLevel(tier: LandTier): number {
  return TIER_STRUCTURE_RULES[tier].maxLevel;
}

/**
 * Server-authoritative placement gate. True ONLY when BOTH hold:
 *   1. `sku` is in the tier's allowed list for `structureType`
 *      (founder SKUs are FALSE for starter/c/b/a; a starter SKU is true for all
 *      tiers ≥ starter because each tier is a superset of the one below), AND
 *   2. the catalog entry for `sku` actually has that `structureType`
 *      (so a home key can never be placed as a shop, even if the lists drifted).
 *
 * Routes MUST call this — never trust a client-asserted SKU/type/tier.
 */
export function isSkuAllowedForTier(sku: string, structureType: 'home' | 'shop', tier: LandTier): boolean {
  const entry = getCatalogEntry(sku);
  if (entry === null || entry.structureType !== structureType) return false;
  const rule = TIER_STRUCTURE_RULES[tier];
  const allowed = structureType === 'home' ? rule.homeSkus : rule.shopSkus;
  return allowed.includes(sku);
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

// ─────────────────────────────────────────────────────────────────────────────
// Structure world-scale contract (gamification pass §5.6, Q7 RATIFIED)
//
// These three numbers used to live as private duplicates inside
// `land-structures.tsx` and `land-showroom.tsx` (0.62 / 0.78→1.25 / 1.5). They
// are promoted here because `shellEnvelopeHalfWu` — the reservation the kit
// placement predicate subtracts from every parcel — is derived from them, and a
// renderer-only copy would let the drawn shell and the reserved shell diverge.
//
// Q7 accepted the FLAT ramp: scale is not a level signal (the shell swap and the
// palette are), so the ladder is a 2.5%-per-level nudge rather than a 60% growth
// curve. Raising FOOTPRINT_FRACTION 0.62 → 0.64 and collapsing the ramp to
// 0.94 → 1.04 lifts the Lv1 shell from 401 wu (1.49× a 270 wu avatar) to 558 wu
// (2.07×) with no art change.
// ─────────────────────────────────────────────────────────────────────────────

/** Fraction of a parcel's side the structure footprint targets at levelScale 1. */
export const STRUCTURE_FOOTPRINT_FRACTION = 0.64;

/** Level 1 end of the flat scale ramp. */
export const STRUCTURE_LEVEL_SCALE_MIN = 0.94;

/** Level 5 end of the flat scale ramp. */
export const STRUCTURE_LEVEL_SCALE_MAX = 1.04;

/**
 * Height ceiling as a multiple of the parcel side. Footprint binds iff the
 * shell's `H/W < HEIGHT_CAP_FRACTION / (FOOTPRINT_FRACTION × LEVEL_SCALE_MAX)`
 * = 1.50 / (0.64 × 1.04) = 2.254. Every shipping shell is below that crossover,
 * so footprint is the binding constraint today.
 */
export const STRUCTURE_HEIGHT_CAP_FRACTION = 1.5;

/**
 * Structure scale multiplier for a build level. Clamped to 1..5; the step is
 * `(1.04 − 0.94)/4 = 0.025` → 0.94 / 0.965 / 0.99 / 1.015 / 1.04.
 */
export function structureLevelScale(level: number): number {
  const clamped = Math.max(1, Math.min(5, Number.isFinite(level) ? level : 1));
  return (
    STRUCTURE_LEVEL_SCALE_MIN
    + (clamped - 1) * ((STRUCTURE_LEVEL_SCALE_MAX - STRUCTURE_LEVEL_SCALE_MIN) / 4)
  );
}

/**
 * Half-side, in parcel-local world units, of the square a parcel reserves for
 * its structure shell — the region kit pieces may never intersect.
 *
 * DELIBERATELY LEVEL-INDEPENDENT (defect D-1). The signature takes a tier and
 * NOTHING ELSE: the envelope is computed at the tier's MAXIMUM level, so a
 * placement that is legal at Lv1 stays legal after every upgrade. A level
 * parameter here would let a Lv4/Lv5 shell grow into pieces the server had
 * already sold as legal, and Q5 forbids deleting a paid row to resolve that.
 *
 * The honest cost: at Lv1 a 19–39 wu ring of ground looks free but is reserved.
 * The yard editor draws THIS function's square, so the reservation is visible
 * rather than a surprise at upgrade time.
 */
export function shellEnvelopeHalfWu(parcelTier: LandTier): number {
  const sideWu = getParcelFootprintWu(parcelTier);
  return (
    (sideWu * STRUCTURE_FOOTPRINT_FRACTION * structureLevelScale(getTierMaxLevel(parcelTier))) / 2
  );
}
