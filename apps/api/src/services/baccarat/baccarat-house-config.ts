/**
 * Shared-table baccarat: house tiers + round/scaler/tick env knobs (2026-10-22).
 *
 * Single source of truth for the house tier bounds and the cadence knobs. The
 * manager, seeder, scaler, tick, and tests import from here so the values never
 * drift. Spec: `baccarat-shared-table-port-2026-10-22.md` section 2.1. Every env
 * knob is documented in `ARCHITECTURE.md` section 4.
 *
 * Founder decisions (2026-10-21): tiers low 5-50, mid 20-200, high 50-500 vCLAW
 * per seat per round; betting window 12 s; reveal 4 s; seeded bots visual only.
 * maxSeats = 6 is perf-derived: the hold'em room already ships 5 seated figures +
 * dealer on Iris Xe in the same room and table, so 6 seats = the viewer's POV seat
 * plus 5 figures.
 *
 * Pure data + env readers. No DB, no side effects.
 */

import type { BaccaratTableTier } from '@clawville/shared';

/** One house tier: per-seat per-round bet bounds + table counts. */
export interface BaccaratHouseTierConfig {
  readonly tierKey: BaccaratTableTier;
  readonly minBetCt: number;
  readonly maxBetCt: number;
  /** Default number of open `source='house'` public tables of this tier. */
  readonly openTables: number;
  /** Seats per house table (6). */
  readonly maxSeats: number;
  /** Default visual-only bots per house table (3). */
  readonly seededAgentSlots: number;
}

/** Seats per house table. Perf-derived (see header). */
export const BACCARAT_HOUSE_MAX_SEATS = 6;
/** Default visual-only bots per house table (`BAC_HOUSE_SEEDED_SLOTS`). */
export const BACCARAT_HOUSE_SEEDED_SLOTS_DEFAULT = 3;
/** Default bot pool size (`BAC_HOUSE_BOT_POOL_SIZE`): 3 tiers x 3 bots + 3 headroom. */
export const BACCARAT_HOUSE_BOT_POOL_SIZE_DEFAULT = 12;

export const BACCARAT_HOUSE_TIERS: Readonly<Record<BaccaratTableTier, BaccaratHouseTierConfig>> = {
  low: {
    tierKey: 'low',
    minBetCt: 5,
    maxBetCt: 50,
    openTables: 1,
    maxSeats: BACCARAT_HOUSE_MAX_SEATS,
    seededAgentSlots: BACCARAT_HOUSE_SEEDED_SLOTS_DEFAULT,
  },
  mid: {
    tierKey: 'mid',
    minBetCt: 20,
    maxBetCt: 200,
    openTables: 1,
    maxSeats: BACCARAT_HOUSE_MAX_SEATS,
    seededAgentSlots: BACCARAT_HOUSE_SEEDED_SLOTS_DEFAULT,
  },
  high: {
    tierKey: 'high',
    minBetCt: 50,
    maxBetCt: 500,
    openTables: 1,
    maxSeats: BACCARAT_HOUSE_MAX_SEATS,
    seededAgentSlots: BACCARAT_HOUSE_SEEDED_SLOTS_DEFAULT,
  },
};

/** Stable tier order, low to high (the autonomous bet picks the lowest tier that admits the wager). */
export const BACCARAT_HOUSE_TIER_KEYS: ReadonlyArray<BaccaratTableTier> = ['low', 'mid', 'high'];

// ── env readers (defaults are the locked values) ─────────────────────────────

/** Integer env knob. Unset, empty, or non-integer -> default. Then clamped to [floor, ceil]. */
function readInt(name: string, def: number, floor: number, ceil = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return def;
  return Math.min(ceil, Math.max(floor, n));
}

/** Boolean env knob: true|1|yes|on / false|0|no|off; anything else -> default. */
function readBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return def;
}

const OPEN_TABLES_ENV: Readonly<Record<BaccaratTableTier, string>> = {
  low: 'BAC_HOUSE_TABLES_LOW',
  mid: 'BAC_HOUSE_TABLES_MID',
  high: 'BAC_HOUSE_TABLES_HIGH',
};

/** Open house tables the scaler keeps per tier. Env `BAC_HOUSE_TABLES_LOW|MID|HIGH`, default 1, floor 0. */
export function baccaratHouseOpenTables(tierKey: BaccaratTableTier): number {
  return readInt(OPEN_TABLES_ENV[tierKey], BACCARAT_HOUSE_TIERS[tierKey].openTables, 0);
}

/** Whether the house scaler runs. Env `BAC_HOUSE_SCALER_ENABLED`, default true. */
export function baccaratHouseScalerEnabled(): boolean {
  return readBool('BAC_HOUSE_SCALER_ENABLED', true);
}

/** Scaler sweep cadence (ms). Env `BAC_HOUSE_SCALER_INTERVAL_MS`, default 45000, floor 5000. */
export function baccaratHouseScalerIntervalMs(): number {
  return readInt('BAC_HOUSE_SCALER_INTERVAL_MS', 45_000, 5_000);
}

/** Round tick cadence (ms). Env `BAC_TABLE_TICK_MS`, default 1000, clamped 250..5000. */
export function baccaratTableTickMs(): number {
  return readInt('BAC_TABLE_TICK_MS', 1_000, 250, 5_000);
}

/** Betting window (ms). Env `BAC_BETTING_WINDOW_MS`, default 12000, floor 3000. */
export function baccaratBettingWindowMs(): number {
  return readInt('BAC_BETTING_WINDOW_MS', 12_000, 3_000);
}

/** Reveal pause (ms). Env `BAC_REVEAL_PAUSE_MS`, default 4000, floor 1000. */
export function baccaratRevealPauseMs(): number {
  return readInt('BAC_REVEAL_PAUSE_MS', 4_000, 1_000);
}

/**
 * Visual-only bots per house table. Env `BAC_HOUSE_SEEDED_SLOTS`, default 3,
 * clamped 0..maxSeats (the DB check `seeded_agent_slots BETWEEN 0 AND max_seats`
 * would reject a larger value at table insert).
 */
export function baccaratHouseSeededSlots(): number {
  return readInt(
    'BAC_HOUSE_SEEDED_SLOTS',
    BACCARAT_HOUSE_SEEDED_SLOTS_DEFAULT,
    0,
    BACCARAT_HOUSE_MAX_SEATS,
  );
}

/** Bot pool size (users `bac-bot-NNN@house.clawville.internal`). Env `BAC_HOUSE_BOT_POOL_SIZE`, default 12, floor 1. */
export function baccaratHouseBotPoolSize(): number {
  return readInt('BAC_HOUSE_BOT_POOL_SIZE', BACCARAT_HOUSE_BOT_POOL_SIZE_DEFAULT, 1);
}
