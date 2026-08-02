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
export const LAND_TIER_LADDER: Record<
  LandTier,
  { minCt: number | null; maxCt: number | null }
> = {
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
export const LAND_RENT_LADDER: Record<
  LandTier,
  { minCt: number | null; maxCt: number | null }
> = {
  starter: { minCt: null, maxCt: null },
  c: { minCt: 50, maxCt: 100 },
  b: { minCt: 250, maxCt: 550 },
  a: { minCt: 1000, maxCt: 2400 },
  founder: { minCt: null, maxCt: null },
};

/** Convenience flag: which tiers are buyable with CT in v1 (founder is USDC/auction-only). */
export const CT_BUYABLE_TIERS: readonly LandTier[] = ['starter', 'c', 'b', 'a'] as const;

/** Which tiers can be RENTED with CT in v1 (starter is free+owned; founder is auction-only). */
export const CT_RENTABLE_TIERS: readonly LandTier[] = ['c', 'b', 'a'] as const;

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

/**
 * Per-tier CLV hold thresholds for B2 hold-to-keep, in CLV **uiAmount** (human
 * token count — NOT atomic base units; compare against
 * `ClvBalanceResult.uiAmount`). FOUNDER-LOCKED 2026-07-07:
 * c 100k / b 500k / a 2.5M / founder 10M. `null` = the tier is not holdable
 * (starter uses the B1 deposit-escrow path). Thresholds STACK: holding
 * multiple parcels requires the SUM of their thresholds.
 */
export const LAND_HOLD_THRESHOLDS_CLV: Record<LandTier, number | null> = {
  starter: null,
  c: 100_000,
  b: 500_000,
  a: 2_500_000,
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
 *
 * A3 ¢-peg re-band (2026-07-07): LEFT UNCHANGED — structure upgrades were NOT in
 * the founder's explicit A3 re-band list, and they belong to the same land
 * buy-outright surface that Phase B (CLV hold-to-keep) supersedes, so like the
 * c/b/a purchase prices they are DEPRECATED and now ~10× cheaper in USD. Do not
 * treat these as a coherent USD price; Phase B re-sizes the land/structure sinks.
 */
export const STRUCTURE_UPGRADE_COSTS: readonly number[] = [0, 0, 600, 1800, 4500, 11000];

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
    modelPath: '/models/land-structures/coastal-cottage/home.glb',
    minLevel: 1,
    premium: false,
  },
  {
    key: 'driftwood-cabin',
    label: 'Driftwood Cabin',
    structureType: 'home',
    modelPath: '/models/land-structures/driftwood-cabin/home.glb',
    minLevel: 2,
    premium: false,
  },
  {
    key: 'fantasy-cottage',
    label: 'Fantasy Cottage',
    structureType: 'home',
    modelPath: '/models/land-structures/fantasy-cottage/home.glb',
    minLevel: 2,
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
    modelPath: '/models/land-structures/coastal-cottage/shop.glb',
    minLevel: 1,
    premium: false,
  },
  {
    key: 'driftwood-cabin',
    label: 'Driftwood Shop',
    structureType: 'shop',
    modelPath: '/models/land-structures/driftwood-cabin/shop.glb',
    minLevel: 2,
    premium: false,
  },
  {
    key: 'fantasy-cottage',
    label: 'Fantasy Shop',
    structureType: 'shop',
    modelPath: '/models/land-structures/fantasy-cottage/shop.glb',
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
  /** Base, accent, and trim tints baked into geometry vertex colours. */
  readonly swatches: readonly [string, string, string];
  readonly minLevel: 1 | 2;
}

/** Eight curated sea-town presets; Lv1 exposes the first three, Lv2+ all eight. */
export const PALETTE_PRESETS: readonly PalettePreset[] = [
  {
    key: 'classic',
    label: 'Harbor Classic',
    swatches: ['#F4E7CE', '#5E9BA6', '#C96F4A'],
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
export function getShellCatalogEntry(
  structureType: LandStructureType,
  shellKey: string,
): ShellCatalogEntry | null {
  return (
    SHELL_CATALOG.find(
      (entry) => entry.structureType === structureType && entry.key === shellKey,
    ) ?? null
  );
}

/** Resolve a named palette preset, or null for bad input. */
export function getPalettePreset(paletteKey: string): PalettePreset | null {
  return PALETTE_PRESETS.find((preset) => preset.key === paletteKey) ?? null;
}

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
  return parcelTier === 'b' || parcelTier === 'a' || parcelTier === 'founder';
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
  { key: 'home-cottage', label: 'Cottage', structureType: 'home', tierLevel: 2 },
  { key: 'home-house', label: 'House', structureType: 'home', tierLevel: 3 },
  { key: 'home-villa', label: 'Villa', structureType: 'home', tierLevel: 4 },
  { key: 'home-mansion', label: 'Mansion', structureType: 'home', tierLevel: 5 },
  // ── Founder-only premium home (Founders' Row exclusive) ──
  { key: 'home-founders-estate', label: "Founders' Estate", structureType: 'home', tierLevel: 5 },
  // ── Shops (commercial — run paid services) ──
  { key: 'shop-stall', label: 'Stall', structureType: 'shop', tierLevel: 1 },
  { key: 'shop-shopfront', label: 'Shopfront', structureType: 'shop', tierLevel: 2 },
  { key: 'shop-market', label: 'Market', structureType: 'shop', tierLevel: 3 },
  { key: 'shop-emporium', label: 'Emporium', structureType: 'shop', tierLevel: 4 },
  { key: 'shop-grand-bazaar', label: 'Grand Bazaar', structureType: 'shop', tierLevel: 5 },
  // ── Founder-only premium shop (Founders' Row exclusive) ──
  { key: 'shop-founders-exchange', label: "Founders' Exchange", structureType: 'shop', tierLevel: 5 },
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
    shopSkus: [
      'shop-stall',
      'shop-shopfront',
      'shop-market',
      'shop-emporium',
      'shop-grand-bazaar',
    ],
    premium: false,
  },
  founder: {
    maxLevel: 5,
    homeSkus: [
      'home-shack',
      'home-cottage',
      'home-house',
      'home-villa',
      'home-mansion',
      'home-founders-estate',
    ],
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
export function isSkuAllowedForTier(
  sku: string,
  structureType: 'home' | 'shop',
  tier: LandTier,
): boolean {
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
