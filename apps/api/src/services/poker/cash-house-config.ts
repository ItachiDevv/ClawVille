/**
 * Poker CASH GAMES — shared HOUSE TIER + house-scaler/bot env config.
 *
 * SINGLE SOURCE OF TRUTH for the locked house stake tiers. The cash-poker route
 * (`cove-cash-poker.ts`) and the house auto-scaler (`cash-house-scaler.ts`) BOTH
 * import `HOUSE_TIERS` from here so a tier's stakes can never drift between the
 * human-facing create path and the scaler's auto-create path.
 *
 * ── LOCKED DECISIONS (founder-approved 2026-06-22) ───────────────────────────
 *   TIERS  (stakes == the values previously inlined in cove-cash-poker.ts:62-69):
 *     low  { buyIn 20,  SB 1,  BB 2  }   N open house tables = 2
 *     mid  { buyIn 100, SB 5,  BB 10 }   N open house tables = 2
 *     high { buyIn 500, SB 25, BB 50 }   N open house tables = 1
 *   maxSeats = 6 for every house table.
 *   seededAgentSlots = 3 (cap on bots per house table) → a solo human gets up to
 *     ~3 bot opponents (a small live game, NOT a packed 6-max felt).
 *   CASH_HOUSE_FILL_TARGET_SEATS default 3 (target TOTAL occupied incl. the human).
 *
 * ── SCOPE (locked) ───────────────────────────────────────────────────────────
 *   Bots seed HOUSE TABLES ONLY (source='house', visibility='public'). They NEVER
 *   seed player-public or private tables. The seeded-agent provider is only ever
 *   exercised for source='house' tables.
 *
 * Everything here is pure data + env-knob readers (NO DB, NO side effects) so it
 * is safe to import from the route, the scaler, the tick, and tests alike.
 */

/** One locked house tier: fixed stakes + how many tables of it stay open + bot fill. */
export interface HouseTierConfig {
  /** Stable tier key persisted on `poker_cash_tables.tier_key`. */
  readonly tierKey: string;
  readonly buyInCt: number;
  readonly smallBlindCt: number;
  readonly bigBlindCt: number;
  /** How many open `source='house'` public tables of this tier the scaler keeps. */
  readonly openTables: number;
  /** Seats per house table. Locked at 6. */
  readonly maxSeats: number;
  /** Max bots per house table (cap). Locked at 3. */
  readonly seededAgentSlots: number;
}

/**
 * The three locked house tiers, keyed by `tierKey`. The route still owns the
 * `{ buyInCt, smallBlindCt, bigBlindCt }` shape it always used; consumers that
 * only need stakes can read those three fields and ignore the scaler-only ones.
 *
 * Default `openTables` counts are env-overridable per tier (see
 * `houseOpenTables()` below); these literals are the locked defaults.
 */
// Stakes ladder restored to the ORIGINAL July values by founder ruling
// 2026-08-11 ("use the old ones — I never approved the new ones"): the reland
// had introduced a 10x-lower ladder that was never signed off. These values
// match every live house-table row created before the reland.
export const HOUSE_TIERS: Record<'low' | 'mid' | 'high', HouseTierConfig> = {
  low: {
    tierKey: 'low',
    buyInCt: 200,
    smallBlindCt: 10,
    bigBlindCt: 20,
    openTables: 2,
    maxSeats: 6,
    seededAgentSlots: 3,
  },
  mid: {
    tierKey: 'mid',
    buyInCt: 1000,
    smallBlindCt: 50,
    bigBlindCt: 100,
    openTables: 2,
    maxSeats: 6,
    seededAgentSlots: 3,
  },
  high: {
    tierKey: 'high',
    buyInCt: 5000,
    smallBlindCt: 250,
    bigBlindCt: 500,
    openTables: 1,
    maxSeats: 6,
    seededAgentSlots: 3,
  },
};

/** Stable ordered list of tier keys (low → high). */
export const HOUSE_TIER_KEYS: ReadonlyArray<'low' | 'mid' | 'high'> = ['low', 'mid', 'high'];

/**
 * Back-compat view for the route: the exact `{ buyInCt, smallBlindCt, bigBlindCt }`
 * map the route previously declared inline at cove-cash-poker.ts:62-69. The route
 * imports THIS so its public stake table and the scaler's tables are one source.
 */
export const HOUSE_TIER_STAKES: Record<
  string,
  { buyInCt: number; smallBlindCt: number; bigBlindCt: number }
> = {
  low: {
    buyInCt: HOUSE_TIERS.low.buyInCt,
    smallBlindCt: HOUSE_TIERS.low.smallBlindCt,
    bigBlindCt: HOUSE_TIERS.low.bigBlindCt,
  },
  mid: {
    buyInCt: HOUSE_TIERS.mid.buyInCt,
    smallBlindCt: HOUSE_TIERS.mid.smallBlindCt,
    bigBlindCt: HOUSE_TIERS.mid.bigBlindCt,
  },
  high: {
    buyInCt: HOUSE_TIERS.high.buyInCt,
    smallBlindCt: HOUSE_TIERS.high.smallBlindCt,
    bigBlindCt: HOUSE_TIERS.high.bigBlindCt,
  },
};

// ── env-knob readers (defaults are the founder-locked values) ────────────────

/** Parse a non-negative integer env var with a clamped floor; fall back to `def`. */
function readInt(name: string, def: number, floor = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return def;
  return Math.max(floor, n);
}

/** Parse a boolean env var ('true'/'1' → true, 'false'/'0' → false); fall back to `def`. */
function readBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return def;
}

/**
 * How many open `source='house'` public tables the scaler keeps per tier.
 * Env override per tier: `CASH_HOUSE_TABLES_LOW` / `_MID` / `_HIGH`. Defaults
 * 2 / 2 / 1 (the locked counts).
 */
export function houseOpenTables(tierKey: 'low' | 'mid' | 'high'): number {
  const envName =
    tierKey === 'low'
      ? 'CASH_HOUSE_TABLES_LOW'
      : tierKey === 'mid'
        ? 'CASH_HOUSE_TABLES_MID'
        : 'CASH_HOUSE_TABLES_HIGH';
  return readInt(envName, HOUSE_TIERS[tierKey].openTables, 0);
}

/** Whether the house auto-scaler runs at all (off for local/dev). Default true. */
export function houseScalerEnabled(): boolean {
  return readBool('CASH_HOUSE_SCALER_ENABLED', true);
}

/** Scaler sweep cadence in ms. Default 45_000 (floor 5_000). */
export function houseScalerIntervalMs(): number {
  return readInt('CASH_HOUSE_SCALER_INTERVAL_MS', 45_000, 5_000);
}

/**
 * Autonomous self-drive TICK cadence in ms. Default 1_500. MUST be well under
 * `turnClock (25_000) + grace (5_000)` so a bot acts before the sim's auto-fold
 * timer fires — the reader clamps it to [250, 20_000] for safety.
 */
export function cashTableTickMs(): number {
  const v = readInt('CASH_TABLE_TICK_MS', 1_500, 250);
  return Math.min(v, 20_000);
}

/** Cap on bots per house table. Default 3 (the locked `seededAgentSlots`). */
export function houseSeededSlotsPerTable(): number {
  return readInt('CASH_HOUSE_SEEDED_SLOTS_PER_TABLE', HOUSE_TIERS.low.seededAgentSlots, 0);
}

/**
 * Target TOTAL occupied seats (human + bots) the fill aims for. Default 3 — a
 * solo human + up to ~2 bots, capped further by `seededAgentSlots` and `maxSeats`.
 * The locked value is 3.
 */
export function houseFillTargetSeats(): number {
  return readInt('CASH_HOUSE_FILL_TARGET_SEATS', 3, 2);
}

/** Bot pool size M. Default 24 (covers Σ N_tier × seededAgentSlots = 15 + headroom). */
export function houseBotPoolSize(): number {
  return readInt('CASH_HOUSE_BOT_POOL_SIZE', 24, 1);
}

/** One-time house-bank bankroll seed target (CT). Default 100_000. */
export function houseBankBankroll(): number {
  return readInt('CASH_HOUSE_BANK_BANKROLL', 100_000, 0);
}

/** Low-balance alarm threshold for the house bank (CT). Default 10_000. */
export function houseBankLowAlarm(): number {
  return readInt('CASH_HOUSE_BANK_LOW_ALARM', 10_000, 0);
}
