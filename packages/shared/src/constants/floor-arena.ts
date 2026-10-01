/**
 * Trading Floor Arena: the paper-trading contest contract that the API engine,
 * the arena routes, the agent manuals and the web UI all share.
 *
 * Canonical design: `docs/trading-floor-arena.md` (§2 is this file's contract,
 * §4 is the database contract whose value sets are the `FLOOR_ARENA_*` enum
 * arrays at the bottom of this file).
 *
 * PAPER ONLY. Nothing here moves money. `mode: 'live'` exists in the schema, but
 * the API rejects it with `live_not_available` until a founder go (D11).
 *
 * Every exported table below is DEEP-FROZEN at module load. The API process
 * serves every player from one copy of `FLOOR_ARENA_TEMPLATES`, so an in-place
 * edit of `template.params` would silently change the template for everyone.
 * Mutating a frozen object throws in an ES module, which makes that bug loud.
 * Start an editable copy with `cloneFloorArenaParams`.
 */

/** Params contract version. 2 (2026-09-30): `entry.first_sight_sources` added (required, D25) and
 *  the platform liquidity floor removed (D26). */
export const FLOOR_ARENA_VERSION = 2;

// ── Types (docs §2) ─────────────────────────────────────────────────────────

export const FLOOR_ARENA_RANK_BY = deepFreeze([
  'vol_over_mcap',
  'newest',
  'oldest',
  'txns1h',
  'lowest_vol_over_mcap',
  'mid_vol_over_mcap',
] as const);
export type FloorArenaRankBy = (typeof FLOOR_ARENA_RANK_BY)[number];

/** Form labels for `entry.rank_by`, in `FLOOR_ARENA_RANK_BY` order. */
export const FLOOR_ARENA_RANK_BY_LABELS: Readonly<Record<FloorArenaRankBy, string>> = deepFreeze({
  vol_over_mcap: 'Highest 1-hour volume to market cap',
  newest: 'Newest pair first',
  oldest: 'Oldest pair first',
  txns1h: 'Most trades in the last hour',
  lowest_vol_over_mcap: 'Lowest 1-hour volume to market cap',
  mid_vol_over_mcap: 'Middle 1-hour volume to market cap',
});

/** D25: which sighting starts the `discovered_within_s` clock. `tradeable` = the first sighting by a
 *  tradeable source (see FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES); `any` = the hub's `first_seen_at`. */
export const FLOOR_ARENA_FIRST_SIGHT_SOURCES = deepFreeze(['any', 'tradeable'] as const);
export type FloorArenaFirstSightSources = (typeof FLOOR_ARENA_FIRST_SIGHT_SOURCES)[number];

/** Form labels for `entry.first_sight_sources`, in `FLOOR_ARENA_FIRST_SIGHT_SOURCES` order. */
export const FLOOR_ARENA_FIRST_SIGHT_SOURCE_LABELS: Readonly<Record<FloorArenaFirstSightSources, string>> = deepFreeze({
  any: 'First seen by any feed',
  tradeable: 'First seen by a tradeable feed (DexScreener or ClawPump)',
});

/** D25: a shared-feed coin is tradeable only when at least one of its sources starts with one of
 *  these prefixes (a GeckoTerminal-only sighting is not). Mints from a paid add-on are exempt. */
export const FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES = deepFreeze(['ds:', 'clawpump:'] as const);

/** True when a discovery source id (e.g. `ds:token-profiles`) is a tradeable source (D25). */
export function isFloorArenaTradeableSource(source: string): boolean {
  return FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));
}

/** Every field is `number | null`; null turns the filter off. `chg*` values are
 *  percent, `age_*_s` is the DexScreener PAIR age in seconds. */
export interface FloorArenaFilters {
  mcap_min: number | null;
  mcap_max: number | null;
  liq_min: number | null;
  liq_max: number | null;
  age_min_s: number | null;
  age_max_s: number | null;
  vol1h_over_mcap_min: number | null;
  vol1h_over_mcap_max: number | null;
  chg5m_min: number | null;
  chg5m_max: number | null;
  chg1h_min: number | null;
  chg1h_max: number | null;
  chg6h_min: number | null;
  chg6h_max: number | null;
  chg24h_min: number | null;
  chg24h_max: number | null;
  txns1h_min: number | null;
  txns1h_max: number | null;
  top10_max_pct: number | null;
}

export interface FloorArenaEntry {
  discovered_within_s: number | null;
  first_sight_sources: FloorArenaFirstSightSources;
  rank_by: FloorArenaRankBy;
  entries_per_tick: number;
}

export interface FloorArenaExits {
  /** `[multiple, fraction of the ORIGINAL position]`, 0..3 legs, multiples
   *  strictly ascending, fractions summing to at most 1. */
  tp: Array<[number, number]>;
  stop_mult: number | null;
  trail_from_peak: number | null;
  trail_arm_mult: number | null;
  max_hold_s: number;
}

export interface FloorArenaLimits {
  position_usd: number;
  max_open: number;
  reentry_cooldown_s: number;
}

export interface FloorArenaParams {
  filters: FloorArenaFilters;
  entry: FloorArenaEntry;
  exits: FloorArenaExits;
  limits: FloorArenaLimits;
}

export interface FloorArenaTemplate {
  id: string;
  displayName: string;
  houseAgentId: string;
  tagline: string;
  thesis: string;
  risk: string;
  params: FloorArenaParams;
}

export interface FloorArenaHouseAgent {
  id: string;
  name: string;
  templateId: string;
  clawpumpAgentId: string | null;
}

/** One `{path, from, to}` entry of `diffFloorArenaParams`; also the element
 *  type of `floor_arena_param_changes.changes`. */
export interface FloorArenaParamDiff {
  path: string;
  from: unknown;
  to: unknown;
}

// ── Param key order (validation, diff, paths and the form share it) ───────────

export const FLOOR_ARENA_FILTER_KEYS = deepFreeze([
  'mcap_min',
  'mcap_max',
  'liq_min',
  'liq_max',
  'age_min_s',
  'age_max_s',
  'vol1h_over_mcap_min',
  'vol1h_over_mcap_max',
  'chg5m_min',
  'chg5m_max',
  'chg1h_min',
  'chg1h_max',
  'chg6h_min',
  'chg6h_max',
  'chg24h_min',
  'chg24h_max',
  'txns1h_min',
  'txns1h_max',
  'top10_max_pct',
] as const satisfies readonly (keyof FloorArenaFilters)[]);

const ENTRY_KEYS = ['discovered_within_s', 'first_sight_sources', 'rank_by', 'entries_per_tick'] as const satisfies readonly (keyof FloorArenaEntry)[];
const EXIT_KEYS = ['tp', 'stop_mult', 'trail_from_peak', 'trail_arm_mult', 'max_hold_s'] as const satisfies readonly (keyof FloorArenaExits)[];
const LIMIT_KEYS = ['position_usd', 'max_open', 'reentry_cooldown_s'] as const satisfies readonly (keyof FloorArenaLimits)[];
const SECTION_KEYS = {
  filters: FLOOR_ARENA_FILTER_KEYS,
  entry: ENTRY_KEYS,
  exits: EXIT_KEYS,
  limits: LIMIT_KEYS,
} as const;
type Section = keyof typeof SECTION_KEYS;
const SECTIONS = ['filters', 'entry', 'exits', 'limits'] as const satisfies readonly Section[];

/** Every `min` filter whose `max` partner must be larger when both are set. */
const FILTER_RANGES = [
  ['mcap_min', 'mcap_max'],
  ['liq_min', 'liq_max'],
  ['age_min_s', 'age_max_s'],
  ['vol1h_over_mcap_min', 'vol1h_over_mcap_max'],
  ['chg5m_min', 'chg5m_max'],
  ['chg1h_min', 'chg1h_max'],
  ['chg6h_min', 'chg6h_max'],
  ['chg24h_min', 'chg24h_max'],
  ['txns1h_min', 'txns1h_max'],
] as const satisfies readonly (readonly [keyof FloorArenaFilters, keyof FloorArenaFilters])[];

/** Every leaf path `diffFloorArenaParams` can emit, in canonical order. A
 *  report suggestion names one of these. `exits.tp` is one leaf (the whole
 *  leg list). */
export const FLOOR_ARENA_PARAM_PATHS: readonly string[] = deepFreeze(
  SECTIONS.flatMap((section) => SECTION_KEYS[section].map((key) => `${section}.${key}`)),
);

// ── Bounds (docs §2; enforced by validateFloorArenaParams, rendered by the UI) ─

export type FloorArenaUnit = 'usd' | 'seconds' | 'percent' | 'ratio' | 'multiple' | 'fraction' | 'count';

export interface FloorArenaBound {
  label: string;
  unit: FloorArenaUnit;
  min: number;
  max: number;
  /** Input step for the form. Validation does NOT snap values to this grid. */
  step: number;
  /** true when null ("off") is a valid value. */
  nullable: boolean;
  /** true when the value must be a whole number. */
  integer: boolean;
  /** true when the player cannot change the value (min === max). */
  locked?: boolean;
}

export interface FloorArenaParamBounds {
  filters: Readonly<Record<keyof FloorArenaFilters, FloorArenaBound>>;
  entry: Readonly<{ discovered_within_s: FloorArenaBound; entries_per_tick: FloorArenaBound }>;
  exits: Readonly<{
    /** Bounds the NUMBER of take-profit legs. */
    tp_legs: FloorArenaBound;
    tp_multiple: FloorArenaBound;
    tp_fraction: FloorArenaBound;
    stop_mult: FloorArenaBound;
    trail_from_peak: FloorArenaBound;
    trail_arm_mult: FloorArenaBound;
    max_hold_s: FloorArenaBound;
  }>;
  limits: Readonly<Record<keyof FloorArenaLimits, FloorArenaBound>>;
}

/** Fixed paper ticket size in USD (D6). Equal tickets keep USD P&L comparable. */
export const FLOOR_ARENA_POSITION_USD = 20;
export const FLOOR_ARENA_MAX_OPEN_POSITIONS = 5;
export const FLOOR_ARENA_MAX_TP_LEGS = 3;

function bound(
  label: string,
  unit: FloorArenaUnit,
  min: number,
  max: number,
  step: number,
  opts: { nullable: boolean; integer?: boolean; locked?: boolean },
): FloorArenaBound {
  return {
    label,
    unit,
    min,
    max,
    step,
    nullable: opts.nullable,
    integer: opts.integer ?? false,
    ...(opts.locked ? { locked: true } : {}),
  };
}

const MCAP = [1_000, 100_000_000, 1_000] as const;
/** D26: no platform liquidity floor; `liq_min` is an ordinary, optional filter. */
const LIQ = [0, 50_000_000, 1_000] as const;
const AGE = [0, 2_592_000, 60] as const;
const VOL_RATIO = [0, 100, 0.01] as const;
const CHG_SHORT = [-100, 1_000_000, 0.01] as const;
const CHG_LONG = [-100, 10_000_000, 0.01] as const;
const TXNS = [0, 1_000_000, 1] as const;
const OFF = { nullable: true } as const;
const OFF_INT = { nullable: true, integer: true } as const;

export const FLOOR_ARENA_PARAM_BOUNDS: FloorArenaParamBounds = deepFreeze({
  filters: {
    mcap_min: bound('Min market cap', 'usd', ...MCAP, OFF),
    mcap_max: bound('Max market cap', 'usd', ...MCAP, OFF),
    liq_min: bound('Min liquidity', 'usd', ...LIQ, OFF),
    liq_max: bound('Max liquidity', 'usd', ...LIQ, OFF),
    age_min_s: bound('Min pair age', 'seconds', ...AGE, OFF_INT),
    age_max_s: bound('Max pair age', 'seconds', ...AGE, OFF_INT),
    vol1h_over_mcap_min: bound('Min 1-hour volume / market cap', 'ratio', ...VOL_RATIO, OFF),
    vol1h_over_mcap_max: bound('Max 1-hour volume / market cap', 'ratio', ...VOL_RATIO, OFF),
    chg5m_min: bound('Min 5-minute change', 'percent', ...CHG_SHORT, OFF),
    chg5m_max: bound('Max 5-minute change', 'percent', ...CHG_SHORT, OFF),
    chg1h_min: bound('Min 1-hour change', 'percent', ...CHG_SHORT, OFF),
    chg1h_max: bound('Max 1-hour change', 'percent', ...CHG_SHORT, OFF),
    chg6h_min: bound('Min 6-hour change', 'percent', ...CHG_LONG, OFF),
    chg6h_max: bound('Max 6-hour change', 'percent', ...CHG_LONG, OFF),
    chg24h_min: bound('Min 24-hour change', 'percent', ...CHG_LONG, OFF),
    chg24h_max: bound('Max 24-hour change', 'percent', ...CHG_LONG, OFF),
    txns1h_min: bound('Min trades in 1 hour', 'count', ...TXNS, OFF_INT),
    txns1h_max: bound('Max trades in 1 hour', 'count', ...TXNS, OFF_INT),
    top10_max_pct: bound('Max top-10 holder share', 'percent', 1, 100, 1, OFF),
  },
  entry: {
    discovered_within_s: bound('Only coins first seen within', 'seconds', 30, 86_400, 10, OFF_INT),
    entries_per_tick: bound('Buys per 15-second tick', 'count', 1, 3, 1, { nullable: false, integer: true }),
  },
  exits: {
    tp_legs: bound('Take-profit legs', 'count', 0, FLOOR_ARENA_MAX_TP_LEGS, 1, { nullable: false, integer: true }),
    tp_multiple: bound('Take-profit at', 'multiple', 1.01, 10, 0.01, { nullable: false }),
    tp_fraction: bound('Share of the position to sell', 'fraction', 0.05, 1, 0.05, { nullable: false }),
    stop_mult: bound('Stop loss at', 'multiple', 0.3, 0.99, 0.01, OFF),
    trail_from_peak: bound('Trailing stop from peak', 'fraction', 0.02, 0.6, 0.01, OFF),
    trail_arm_mult: bound('Arm the trailing stop at', 'multiple', 1, 5, 0.01, OFF),
    max_hold_s: bound('Max hold time', 'seconds', 60, 86_400, 60, { nullable: false, integer: true }),
  },
  limits: {
    position_usd: bound('Position size', 'usd', FLOOR_ARENA_POSITION_USD, FLOOR_ARENA_POSITION_USD, 1, {
      nullable: false,
      locked: true,
    }),
    max_open: bound('Max open positions', 'count', 1, FLOOR_ARENA_MAX_OPEN_POSITIONS, 1, { nullable: false, integer: true }),
    reentry_cooldown_s: bound('Wait before buying the same coin again', 'seconds', 0, 604_800, 60, {
      nullable: false,
      integer: true,
    }),
  },
});

// ── Hard rules, costs, contest, add-ons ─────────────────────────────────────

/** D5, in display order. Not editable; every form shows them. D26 removed the $5,000 liquidity
 *  rule: the founder's hard rules are these five (bonding-curve pools pass the LP rule). */
export const FLOOR_ARENA_HARD_RULES = deepFreeze([
  { id: 'lp-locked', label: 'LP burned or locked (95% or more)' },
  { id: 'mint-authority', label: 'Mint authority revoked' },
  { id: 'freeze-authority', label: 'Freeze authority revoked' },
  { id: 't22-fee', label: 'Token-2022: no transfer fee or risky extension' },
  { id: 'pool-reserves', label: 'Pool reserves present' },
] as const);
export type FloorArenaHardRuleId = (typeof FLOOR_ARENA_HARD_RULES)[number]['id'];

/** D3: the measured execution cost (memory 2026-09-21), applied on top of the
 *  ClawPump quote on every paper fill. */
export const FLOOR_ARENA_PAPER_COSTS = deepFreeze({ buy_haircut_pct: 2.5, sell_haircut_pct: 1.0 } as const);

export interface FloorArenaContest {
  id: 'arena-week-1';
  name: string;
  startsAt: string;
  endsAt: string;
  prizes: readonly { place: 1 | 2 | 3; amount: number; token: '$CLAWVILLE' }[];
  rules: readonly string[];
}

/** D6: 2026-09-30 6 PM EDT to Sun 2026-10-04 11:59:59 PM EDT. */
export const FLOOR_ARENA_CONTEST: FloorArenaContest = deepFreeze({
  id: 'arena-week-1',
  name: 'Trading Arena Week 1',
  startsAt: '2026-09-30T22:00:00Z',
  endsAt: '2026-10-05T03:59:59Z',
  prizes: [
    { place: 1, amount: 1_000_000, token: '$CLAWVILLE' },
    { place: 2, amount: 500_000, token: '$CLAWVILLE' },
    { place: 3, amount: 250_000, token: '$CLAWVILLE' },
  ],
  rules: [
    "This contest uses paper trading only, so no vCLAW is spent and no real tokens are bought; paid data add-ons are optional and spend only USDC that you send to your agent's own wallet.",
    `Every position is $${FLOOR_ARENA_POSITION_USD}, an agent holds at most ${FLOOR_ARENA_MAX_OPEN_POSITIONS} open positions, and a position with no usable price for 30 minutes closes as unresolved and counts as a loss of its open stake in the contest score.`,
    'Each account can enter one arena agent, and guests cannot enter.',
    'House agents trade on the same board but cannot win prizes.',
    'Your score is the realised paper P&L in USD of positions opened inside the contest window, including positions that close after the end; final standings are published when the last of them closes.',
    'To be eligible for a prize, your agent must be launched before the contest ends and have at least one position opened inside the contest window and closed.',
    'Your agent opens new positions only while it sits at a Trading Floor desk.',
    'The ClawVille team pays the prizes in $CLAWVILLE after it reviews the results.',
    'ClawVille may disqualify any agent or account that abuses the contest.',
  ],
});

export interface FloorArenaAddon {
  id: string;
  vendor: string;
  name: string;
  url: string;
  method: 'GET' | 'POST';
  /** URL query parameters for a GET feed; null when there are none. */
  query: Record<string, string> | null;
  /** JSON request body for a POST feed; null for a GET feed. */
  body: Record<string, unknown> | null;
  /**
   * ClawPump's x402 route answers an identical call made within about 3 to 12
   * minutes with the cached body (`duplicate: true`) and no new data. When set,
   * the caller alternates the body field at dot path `path` between the two
   * `values` on consecutive polls, so every poll is a fresh call.
   */
  dedupeVary: { path: string; values: [number, number] } | null;
  priceUsd: number;
  minIntervalS: number;
  mintPath: string;
  symbolPath: string | null;
  note: string;
}

/** Vetted paid discovery feeds (x402 vetter, 2026-09-30; approved entries
 *  only). Real prices, measured per call. Callers must copy `body` before they
 *  change it: the catalog is frozen. */
export const FLOOR_ARENA_ADDONS: readonly FloorArenaAddon[] = deepFreeze([
  {
    id: 'nansen-token-screener-sol',
    vendor: 'Nansen',
    name: 'Nansen Token Screener (new Solana tokens by 1h volume)',
    url: 'https://api.nansen.ai/api/v1/token-screener',
    method: 'POST',
    query: null,
    body: {
      chains: ['solana'],
      timeframe: '1h',
      filters: { token_age_days: { min: 0, max: 1 } },
      pagination: { page: 1, per_page: 50 },
    },
    dedupeVary: { path: 'pagination.per_page', values: [50, 49] },
    priceUsd: 0.01,
    minIntervalS: 600,
    mintPath: 'data[].token_address',
    symbolPath: 'data[].token_symbol',
    note: 'About $1.44 per day at one call every 10 minutes. In a test, 21 of 30 tokens were not in the free feed.',
  },
  {
    id: 'nansen-smart-money-dex-trades-sol',
    vendor: 'Nansen',
    name: 'Nansen Smart Money DEX Trades (Solana tokens under 1 day old)',
    url: 'https://api.nansen.ai/api/v1/smart-money/dex-trades',
    method: 'POST',
    query: null,
    body: {
      chains: ['solana'],
      filters: { token_bought_age_days: { min: 0, max: 1 } },
      pagination: { page: 1, per_page: 50 },
    },
    dedupeVary: { path: 'pagination.per_page', values: [50, 49] },
    priceUsd: 0.05,
    minIntervalS: 900,
    mintPath: 'data[].token_bought_address',
    symbolPath: 'data[].token_bought_symbol',
    note: 'About $4.80 per day at one call every 15 minutes. Tokens that smart-money wallets bought.',
  },
]);

/** D9: per-agent daily spend cap on paid add-ons, in USD. */
export const FLOOR_ARENA_DEFAULT_ADDON_DAILY_CAP_USD = 1;
export const FLOOR_ARENA_MAX_ADDON_DAILY_CAP_USD = 5;

// ── Templates + house agents (docs §3) ──────────────────────────────────────

const NO_FILTERS: FloorArenaFilters = {
  mcap_min: null,
  mcap_max: null,
  liq_min: null,
  liq_max: null,
  age_min_s: null,
  age_max_s: null,
  vol1h_over_mcap_min: null,
  vol1h_over_mcap_max: null,
  chg5m_min: null,
  chg5m_max: null,
  chg1h_min: null,
  chg1h_max: null,
  chg6h_min: null,
  chg6h_max: null,
  chg24h_min: null,
  chg24h_max: null,
  txns1h_min: null,
  txns1h_max: null,
  top10_max_pct: null,
};

const NO_STOPS = { stop_mult: null, trail_from_peak: null, trail_arm_mult: null } as const;
const ARENA_LIMITS: FloorArenaLimits = {
  position_usd: FLOOR_ARENA_POSITION_USD,
  max_open: FLOOR_ARENA_MAX_OPEN_POSITIONS,
  reentry_cooldown_s: 21_600,
};

/**
 * FINAL template set (lead, 2026-09-30). Parameters are the strategy
 * designer's (ops/house-traders/TEMPLATES_2026-09-30.md §5, in-sample on a
 * 31.4-hour paper log), clamped by the lead to the §2 bounds: `max_open` 5
 * (designer: 20), Runner `entries_per_tick` 3 (designer: 99) and Runner
 * `liq_min` null, as in C1 (D26 removed the 5,000 floor). Runner starts its
 * 120-s first-sight clock at the first TRADEABLE sighting (D25). The designer's
 * `top10_max_pct` 100 meant "off" and is written as null: a set cap fails any
 * coin whose top-10 share is unmeasured. Volume Surge and the Trend Rider trail
 * were rejected by that data and are not templates.
 */
/** Bumped whenever a template's params change. The engine resets a HOUSE agent's params to its
 *  template when the row's `template_version` is lower (user agents keep their own params).
 *  2 (2026-09-30): D25 first-sight sources, D26 Runner liq_min null. */
export const FLOOR_ARENA_TEMPLATE_VERSION = 2;

export const FLOOR_ARENA_TEMPLATES: readonly FloorArenaTemplate[] = deepFreeze([
  {
    id: 'genesis',
    displayName: 'Genesis',
    houseAgentId: 'house:genesis',
    tagline: 'Buys the busiest young coin and takes +10% fast.',
    thesis:
      'Coins 30 minutes to 6 hours old with a $10k to $250k market cap often touch +10% within 15 minutes. Genesis buys the one with the most volume for its size and sells everything at +10%.',
    risk: 'No stop loss: a coin that collapses costs the full $20.',
    params: {
      filters: { ...NO_FILTERS, mcap_min: 10_000, mcap_max: 250_000, liq_min: 15_000, age_min_s: 1_800, age_max_s: 21_600 },
      entry: { discovered_within_s: null, first_sight_sources: 'any', rank_by: 'vol_over_mcap', entries_per_tick: 1 },
      exits: { tp: [[1.1, 1]], ...NO_STOPS, max_hold_s: 900 },
      limits: { ...ARENA_LIMITS },
    },
  },
  {
    id: 'runner',
    displayName: 'Runner',
    houseAgentId: 'house:runner',
    tagline: 'Buys a coin in its first 2 minutes on our radar when it is already up 680% in 6 hours but calm right now.',
    thesis:
      'A coin that already ran hard and is not spiking right now often has one more leg. Runner looks once, at first sight, and sells at +20% or after 15 minutes.',
    risk: 'Few entries, and a 15-minute time exit can still lose a lot.',
    params: {
      filters: { ...NO_FILTERS, chg5m_max: 41.48, chg6h_min: 680.4 },
      entry: { discovered_within_s: 120, first_sight_sources: 'tradeable', rank_by: 'newest', entries_per_tick: 3 },
      exits: { tp: [[1.2, 1]], ...NO_STOPS, max_hold_s: 900 },
      limits: { ...ARENA_LIMITS },
    },
  },
  {
    id: 'dip-hunter',
    displayName: 'Dip Hunter',
    houseAgentId: 'house:dip-hunter',
    tagline: 'Buys a proven coin after a one-hour pullback and sells the bounce at +8%.',
    thesis:
      'Coins older than 6 hours with real size have survived the launch rush. When one drops 5% in an hour but is still up on the day, it often bounces within two hours. Dip Hunter sells at +8% and cuts at -10%.',
    risk: 'The edge is thin after costs, and a slow slide books the -10% stop.',
    params: {
      filters: {
        ...NO_FILTERS,
        mcap_min: 250_000,
        mcap_max: 50_000_000,
        liq_min: 50_000,
        age_min_s: 21_600,
        chg1h_max: -5,
        chg24h_min: 0,
      },
      entry: { discovered_within_s: null, first_sight_sources: 'any', rank_by: 'lowest_vol_over_mcap', entries_per_tick: 1 },
      exits: { tp: [[1.08, 1]], ...NO_STOPS, stop_mult: 0.9, max_hold_s: 7_200 },
      limits: { ...ARENA_LIMITS },
    },
  },
  {
    id: 'midcap-climber',
    displayName: 'Mid-Cap Climber',
    houseAgentId: 'house:midcap-climber',
    tagline: 'Rides a $500k to $5M coin that climbs steadily, not spiking, and sells at +10%.',
    thesis:
      'Bigger coins between 1 and 24 hours old rarely collapse. A steady climb of 5% to 60% in an hour with the last 5 minutes still green often carries another 10%. It sells at +10% or after an hour.',
    risk: 'Very few entries, sometimes one every few hours.',
    params: {
      filters: {
        ...NO_FILTERS,
        mcap_min: 500_000,
        mcap_max: 5_000_000,
        liq_min: 30_000,
        age_min_s: 3_600,
        age_max_s: 86_400,
        chg5m_min: 0,
        chg1h_min: 5,
        chg1h_max: 60,
      },
      entry: { discovered_within_s: null, first_sight_sources: 'any', rank_by: 'txns1h', entries_per_tick: 1 },
      exits: { tp: [[1.1, 1]], ...NO_STOPS, max_hold_s: 3_600 },
      limits: { ...ARENA_LIMITS },
    },
  },
  {
    id: 'late-bloomer',
    displayName: 'Late Bloomer',
    houseAgentId: 'house:late-bloomer',
    tagline: 'Skips the launch chaos and buys a small coin that is waking up again after 6 hours.',
    thesis:
      'A small coin older than 6 hours that rises 20% in an hour, with the last 5 minutes still up, often gets a second wave of buyers. Late Bloomer sells at +10% or after 30 minutes.',
    risk: 'Few collapses so far, but it has not beaten trading costs yet.',
    params: {
      filters: {
        ...NO_FILTERS,
        mcap_min: 50_000,
        mcap_max: 500_000,
        liq_min: 15_000,
        age_min_s: 21_600,
        age_max_s: 172_800,
        chg5m_min: 2,
        chg1h_min: 20,
      },
      entry: { discovered_within_s: null, first_sight_sources: 'any', rank_by: 'txns1h', entries_per_tick: 1 },
      exits: { tp: [[1.1, 1]], ...NO_STOPS, max_hold_s: 1_800 },
      limits: { ...ARENA_LIMITS },
    },
  },
]);

/** One house agent per template, always seated, never contest-eligible (D6/D7).
 *  `clawpumpAgentId` is the existing live ClawPump agent, when there is one. */
export const FLOOR_ARENA_HOUSE_AGENTS: readonly FloorArenaHouseAgent[] = deepFreeze([
  { id: 'house:genesis', name: 'Genesis', templateId: 'genesis', clawpumpAgentId: '0f600d73-05a0-4c2e-8215-ab2a770ba192' },
  { id: 'house:runner', name: 'Runner', templateId: 'runner', clawpumpAgentId: '1a0a153e-cc2c-4b2a-8a38-04e4417ce3c1' },
  { id: 'house:dip-hunter', name: 'Dip Hunter', templateId: 'dip-hunter', clawpumpAgentId: null },
  { id: 'house:midcap-climber', name: 'Mid-Cap Climber', templateId: 'midcap-climber', clawpumpAgentId: null },
  { id: 'house:late-bloomer', name: 'Late Bloomer', templateId: 'late-bloomer', clawpumpAgentId: null },
]);

export function floorArenaTemplateById(id: string): FloorArenaTemplate | undefined {
  return FLOOR_ARENA_TEMPLATES.find((template) => template.id === id);
}

/** A mutable deep copy. Use it before editing any template's params. */
export function cloneFloorArenaParams(p: FloorArenaParams): FloorArenaParams {
  return {
    filters: { ...p.filters },
    entry: { ...p.entry },
    exits: { ...p.exits, tp: p.exits.tp.map(([multiple, fraction]): [number, number] => [multiple, fraction]) },
    limits: { ...p.limits },
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkKeys(obj: PlainObject, allowed: readonly string[], path: string, errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: unknown key`);
  }
  for (const key of allowed) {
    if (!(key in obj)) errors.push(`${path}.${key}: required`);
  }
}

/** Returns the checked value, or undefined after pushing an error. */
function checkNumber(value: unknown, b: FloorArenaBound, path: string, errors: string[]): number | null | undefined {
  if (value === null) {
    if (b.nullable) return null;
    errors.push(`${path}: must be set`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path}: must be a number`);
    return undefined;
  }
  if (b.integer && !Number.isInteger(value)) {
    errors.push(`${path}: must be a whole number`);
    return undefined;
  }
  if (b.locked && value !== b.min) {
    errors.push(`${path}: is fixed at ${b.min}`);
    return undefined;
  }
  if (value < b.min || value > b.max) {
    errors.push(`${path}: must be between ${b.min} and ${b.max}`);
    return undefined;
  }
  return value;
}

/** Tolerance for the floating-point sum of take-profit fractions. */
const FRACTION_SUM_EPSILON = 1e-9;

/**
 * Validates untrusted params (a request body, a stored row, an LLM suggestion
 * applied to a copy) against the §2 bounds. Collects every error instead of
 * stopping at the first, so the form can mark all bad fields at once. On
 * success it returns a fresh object with exactly the known keys.
 */
export function validateFloorArenaParams(
  p: unknown,
): { ok: true; params: FloorArenaParams } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(p)) return { ok: false, errors: ['params: must be an object'] };
  checkKeys(p, SECTIONS, 'params', errors);
  const sections: Partial<Record<Section, PlainObject>> = {};
  for (const section of SECTIONS) {
    const value = p[section];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      errors.push(`${section}: must be an object`);
      continue;
    }
    checkKeys(value, SECTION_KEYS[section], section, errors);
    sections[section] = value;
  }
  const B = FLOOR_ARENA_PARAM_BOUNDS;

  const filters: Partial<Record<keyof FloorArenaFilters, number | null>> = {};
  if (sections.filters) {
    for (const key of FLOOR_ARENA_FILTER_KEYS) {
      if (!(key in sections.filters)) continue;
      const value = checkNumber(sections.filters[key], B.filters[key], `filters.${key}`, errors);
      if (value !== undefined) filters[key] = value;
    }
    for (const [minKey, maxKey] of FILTER_RANGES) {
      const lo = filters[minKey];
      const hi = filters[maxKey];
      if (typeof lo === 'number' && typeof hi === 'number' && lo >= hi) {
        errors.push(`filters.${minKey}: must be below filters.${maxKey}`);
      }
    }
  }

  let entry: FloorArenaEntry | undefined;
  if (sections.entry) {
    const e = sections.entry;
    const within = 'discovered_within_s' in e
      ? checkNumber(e.discovered_within_s, B.entry.discovered_within_s, 'entry.discovered_within_s', errors)
      : undefined;
    const perTick = 'entries_per_tick' in e
      ? checkNumber(e.entries_per_tick, B.entry.entries_per_tick, 'entry.entries_per_tick', errors)
      : undefined;
    const firstSight = e.first_sight_sources;
    const firstSightOk =
      typeof firstSight === 'string' && (FLOOR_ARENA_FIRST_SIGHT_SOURCES as readonly string[]).includes(firstSight);
    if ('first_sight_sources' in e && !firstSightOk) {
      errors.push(`entry.first_sight_sources: must be one of ${FLOOR_ARENA_FIRST_SIGHT_SOURCES.join(', ')}`);
    }
    const rankBy = e.rank_by;
    const rankOk = typeof rankBy === 'string' && (FLOOR_ARENA_RANK_BY as readonly string[]).includes(rankBy);
    if ('rank_by' in e && !rankOk) errors.push(`entry.rank_by: must be one of ${FLOOR_ARENA_RANK_BY.join(', ')}`);
    if (within !== undefined && typeof perTick === 'number' && rankOk && firstSightOk) {
      entry = {
        discovered_within_s: within,
        first_sight_sources: firstSight as FloorArenaFirstSightSources,
        rank_by: rankBy as FloorArenaRankBy,
        entries_per_tick: perTick,
      };
    }
  }

  let exits: FloorArenaExits | undefined;
  if (sections.exits) {
    const x = sections.exits;
    const tp = 'tp' in x ? checkTakeProfit(x.tp, errors) : undefined;
    const stop = 'stop_mult' in x ? checkNumber(x.stop_mult, B.exits.stop_mult, 'exits.stop_mult', errors) : undefined;
    const trail = 'trail_from_peak' in x
      ? checkNumber(x.trail_from_peak, B.exits.trail_from_peak, 'exits.trail_from_peak', errors)
      : undefined;
    const arm = 'trail_arm_mult' in x
      ? checkNumber(x.trail_arm_mult, B.exits.trail_arm_mult, 'exits.trail_arm_mult', errors)
      : undefined;
    const maxHold = 'max_hold_s' in x ? checkNumber(x.max_hold_s, B.exits.max_hold_s, 'exits.max_hold_s', errors) : undefined;
    if (typeof arm === 'number' && trail === null) {
      errors.push('exits.trail_arm_mult: needs exits.trail_from_peak');
    }
    if (tp !== undefined && stop !== undefined && trail !== undefined && tp.length === 0 && stop === null && trail === null) {
      errors.push('exits: needs a take-profit leg, a stop_mult or a trail_from_peak');
    }
    if (tp !== undefined && stop !== undefined && trail !== undefined && arm !== undefined && typeof maxHold === 'number') {
      exits = { tp, stop_mult: stop, trail_from_peak: trail, trail_arm_mult: arm, max_hold_s: maxHold };
    }
  }

  let limits: FloorArenaLimits | undefined;
  if (sections.limits) {
    const l = sections.limits;
    const size = 'position_usd' in l ? checkNumber(l.position_usd, B.limits.position_usd, 'limits.position_usd', errors) : undefined;
    const maxOpen = 'max_open' in l ? checkNumber(l.max_open, B.limits.max_open, 'limits.max_open', errors) : undefined;
    const cooldown = 'reentry_cooldown_s' in l
      ? checkNumber(l.reentry_cooldown_s, B.limits.reentry_cooldown_s, 'limits.reentry_cooldown_s', errors)
      : undefined;
    if (typeof size === 'number' && typeof maxOpen === 'number' && typeof cooldown === 'number') {
      limits = { position_usd: size, max_open: maxOpen, reentry_cooldown_s: cooldown };
    }
  }

  if (errors.length > 0 || !entry || !exits || !limits) {
    // The last guard is unreachable when errors is empty; it keeps the types honest.
    return { ok: false, errors: errors.length > 0 ? errors : ['params: invalid'] };
  }
  return { ok: true, params: { filters: filters as FloorArenaFilters, entry, exits, limits } };
}

function checkTakeProfit(value: unknown, errors: string[]): Array<[number, number]> | undefined {
  const B = FLOOR_ARENA_PARAM_BOUNDS.exits;
  if (!Array.isArray(value)) {
    errors.push('exits.tp: must be a list of [multiple, fraction] legs');
    return undefined;
  }
  if (value.length > B.tp_legs.max) {
    errors.push(`exits.tp: at most ${B.tp_legs.max} legs`);
    return undefined;
  }
  const legs: Array<[number, number]> = [];
  let valid = true;
  value.forEach((leg: unknown, i: number) => {
    if (!Array.isArray(leg) || leg.length !== 2) {
      errors.push(`exits.tp[${i}]: must be [multiple, fraction]`);
      valid = false;
      return;
    }
    const multiple = checkNumber(leg[0], B.tp_multiple, `exits.tp[${i}][0]`, errors);
    const fraction = checkNumber(leg[1], B.tp_fraction, `exits.tp[${i}][1]`, errors);
    if (typeof multiple !== 'number' || typeof fraction !== 'number') {
      valid = false;
      return;
    }
    legs.push([multiple, fraction]);
  });
  if (!valid) return undefined;
  // Ascending order is load-bearing: a position stores only
  // `remaining_fraction`, so the engine infers which legs already fired from the
  // cumulative fractions in this order.
  for (let i = 1; i < legs.length; i += 1) {
    if (legs[i][0] <= legs[i - 1][0]) {
      errors.push(`exits.tp[${i}][0]: must be above the previous leg's multiple`);
      return undefined;
    }
  }
  const sum = legs.reduce((total, [, fraction]) => total + fraction, 0);
  if (sum > 1 + FRACTION_SUM_EPSILON) {
    errors.push('exits.tp: fractions must sum to 1 or less');
    return undefined;
  }
  return legs;
}

// ── Diff + apply ────────────────────────────────────────────────────────────

function leafValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map((leg) => (Array.isArray(leg) ? [...leg] : leg)) : value;
}

function sameLeaf(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** Leaf differences from `a` to `b`, in canonical path order. `exits.tp` is
 *  compared and reported as one leaf. Returned values are copies. */
export function diffFloorArenaParams(a: FloorArenaParams, b: FloorArenaParams): FloorArenaParamDiff[] {
  const changes: FloorArenaParamDiff[] = [];
  for (const section of SECTIONS) {
    const from = a[section] as unknown as PlainObject;
    const to = b[section] as unknown as PlainObject;
    for (const key of SECTION_KEYS[section]) {
      if (!sameLeaf(from[key], to[key])) {
        changes.push({ path: `${section}.${key}`, from: leafValue(from[key]), to: leafValue(to[key]) });
      }
    }
  }
  return changes;
}

/**
 * Returns a copy of `params` with one leaf replaced, for a report suggestion
 * `{path, to}`. Throws on a path outside `FLOOR_ARENA_PARAM_PATHS`. It does NOT
 * validate the result: run `validateFloorArenaParams` on it before storing.
 */
export function applyFloorArenaParamChange(params: FloorArenaParams, path: string, to: unknown): FloorArenaParams {
  if (!FLOOR_ARENA_PARAM_PATHS.includes(path)) throw new Error(`unknown floor arena param path: ${path}`);
  const [section, key] = path.split('.') as [Section, string];
  const next = cloneFloorArenaParams(params);
  (next[section] as unknown as PlainObject)[key] = leafValue(to);
  return next;
}

// ── Database value sets (docs §4; the 0070 CHECK constraints list the same) ──

export const FLOOR_ARENA_AGENT_KINDS = deepFreeze(['house', 'user'] as const);
export type FloorArenaAgentKind = (typeof FLOOR_ARENA_AGENT_KINDS)[number];

export const FLOOR_ARENA_MODES = deepFreeze(['paper', 'live'] as const);
export type FloorArenaMode = (typeof FLOOR_ARENA_MODES)[number];

export const FLOOR_ARENA_AGENT_STATUSES = deepFreeze(['active', 'paused', 'stopped'] as const);
export type FloorArenaAgentStatus = (typeof FLOOR_ARENA_AGENT_STATUSES)[number];

/** `creating` = a worker holds the ClawPump create call in flight (at most one per agent). */
export const FLOOR_ARENA_PROVISION_STATES = deepFreeze(['none', 'pending', 'creating', 'ready', 'failed'] as const);
export type FloorArenaProvisionState = (typeof FLOOR_ARENA_PROVISION_STATES)[number];

export const FLOOR_ARENA_POSITION_STATUSES = deepFreeze(['open', 'closed'] as const);
export type FloorArenaPositionStatus = (typeof FLOOR_ARENA_POSITION_STATUSES)[number];

/** `unresolved`: the exit could not be priced; the row closes with `pnl_usd` NULL (the only case
 *  where a closed position has no P&L). */
export const FLOOR_ARENA_EXIT_REASONS = deepFreeze(['tp', 'stop', 'trail', 'time', 'manual', 'unresolved'] as const);
export type FloorArenaExitReason = (typeof FLOOR_ARENA_EXIT_REASONS)[number];

/** Entries always fill on a quote; only exits may fall back to the mark (D4). */
export const FLOOR_ARENA_ENTRY_FILL_SOURCES = deepFreeze(['quote'] as const);
export type FloorArenaEntryFillSource = (typeof FLOOR_ARENA_ENTRY_FILL_SOURCES)[number];

/** `quote_confirmed`: with no fresh mark, a sell quote below 0.5x the reference price was refused 3+ times
 *  over at least 45 s, and the exit then filled at that latest quote (D4 hardening). */
export const FLOOR_ARENA_EXIT_FILL_SOURCES = deepFreeze(['quote', 'mark_fallback', 'quote_confirmed', 'unresolved'] as const);
export type FloorArenaExitFillSource = (typeof FLOOR_ARENA_EXIT_FILL_SOURCES)[number];

export const FLOOR_ARENA_EVENT_TYPES = deepFreeze([
  'scan',
  'pass',
  'skip',
  'entry',
  'exit',
  'param_change',
  'report',
  'status',
  'addon',
] as const);
export type FloorArenaEventType = (typeof FLOOR_ARENA_EVENT_TYPES)[number];

/** `floor_arena_events.summary` is human readable and at most this long. The
 *  database does not enforce it; writers truncate. */
export const FLOOR_ARENA_EVENT_SUMMARY_MAX = 280;

export const FLOOR_ARENA_SUGGESTION_STATES = deepFreeze([
  'none',
  'pending',
  'applied',
  'dismissed',
  'auto_applied',
  'rejected',
] as const);
export type FloorArenaSuggestionState = (typeof FLOOR_ARENA_SUGGESTION_STATES)[number];

export const FLOOR_ARENA_PARAM_CHANGE_SOURCES = deepFreeze(['user', 'house-tuner', 'admin', 'suggestion'] as const);
export type FloorArenaParamChangeSource = (typeof FLOOR_ARENA_PARAM_CHANGE_SOURCES)[number];

/** `floor_arena_addon_calls.state`: a `reserved` row (price = catalog price) is written before the
 *  payment and counts against the daily cap; it becomes `done` with the charged amount. */
export const FLOOR_ARENA_ADDON_CALL_STATES = deepFreeze(['reserved', 'done'] as const);
export type FloorArenaAddonCallState = (typeof FLOOR_ARENA_ADDON_CALL_STATES)[number];

/** `floor_arena_positions.exit_run`: the engine's record of a failing exit (D4). Times are ISO strings.
 *  `firstFailureAt` = first failure of the whole exit history (the 30-minute `unresolved` clock; a
 *  pause after a low quote does not move it). `runStartedAt` = start of the current failure run (the
 *  3-failures-over-45-s mark fallback counts from it). `streakStartedAt` = first low quote of the
 *  current low streak (the 45-s low-quote confirmation window). */
export interface FloorArenaExitRun {
  firstFailureAt: string;
  runStartedAt: string;
  streakStartedAt: string | null;
  failures: number;
  lowCount: number;
  sawLow: boolean;
  lastLowAt: string | null;
  lastAttemptAt: string;
}

/** `floor_arena_agents.addons` element. */
export interface FloorArenaAgentAddon {
  id: string;
  enabled: boolean;
  dailyCapUsd: number;
}

/** `floor_arena_reports.suggestion`: at most ONE change per report (D10). */
export interface FloorArenaSuggestion {
  path: string;
  from: unknown;
  to: unknown;
  reason: string;
}

/** `chain_verdict` on floor_discovery_mints and floor_arena_private_mints.
 *  `fails` lists hard-rule ids only; a read error is `pass: false, fails: []`
 *  with `error` set (shown as "not verified"). The optional keys are engine
 *  detail: `codes` are the granular reasons (e.g. `lp_not_locked`). */
export interface FloorArenaChainVerdict {
  pass: boolean;
  fails: FloorArenaHardRuleId[];
  checkedAt: string;
  error?: string;
  codes?: string[];
  decimals?: number;
  top10Pct?: number | null;
  pairAddress?: string | null;
  tokenProgram?: 'spl' | 'token2022';
}

/** `snapshot` on floor_discovery_mints and floor_arena_private_mints: DexScreener pair fields. `pairCreatedAt`
 *  is epoch milliseconds as DexScreener returns it; `ageS` is seconds. */
export interface FloorDiscoverySnapshot {
  priceUsd: number | null;
  mcap: number | null;
  liqUsd: number | null;
  pairAddress: string | null;
  dexId: string | null;
  pairCreatedAt: number | null;
  ageS: number | null;
  chg5m: number | null;
  chg1h: number | null;
  chg6h: number | null;
  chg24h: number | null;
  txns1h: number | null;
  vol1h: number | null;
  volOverMcap: number | null;
  /** Engine extras (pool amounts for the top-10 and reserve checks). */
  liqBase?: number | null;
  liqQuote?: number | null;
  quoteMint?: string | null;
  labels?: string[];
  symbol?: string | null;
  name?: string | null;
}

// ── Internal ────────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
