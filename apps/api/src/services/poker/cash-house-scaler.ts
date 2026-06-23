/**
 * Poker CASH GAMES — house AUTO-SCALER.
 *
 * Keeps `N` open `source='house'` public tables alive per tier at all times so a
 * visitor always finds a populated, bot-seated table to sit at. A guarded
 * `setInterval` that, each pass and per tier:
 *   1. COUNTs the open `source='house'` public tables of that `tierKey`.
 *   2. Creates the deficit `(N - open)` via `cashTableManager.createTable(...)`
 *      with the HOUSE-BANK avatar as the creator subject.
 *   3. EAGER-SEATS the bots (`cashTableManager.seatHouseBots`) so the lobby shows
 *      ~`seededAgentSlots` seated bots per table WITHOUT dealing a hand (Option B,
 *      founder-approved 2026-06-22) — the "always populated" look with NO 24/7
 *      bot-vs-bot bankroll drain (no hand deals until a REAL player sits).
 * It NEVER deletes a table — an empty house table simply idles. A bounded `N` per
 * tier (env-overridable, default 2/2/1) keeps it from running away.
 *
 * ── WHY IT BYPASSES THE PER-CREATOR CAP ──────────────────────────────────────
 * The route's `MAX_CONCURRENT_OPEN_TABLES_PER_CREATOR=3` cap lives ONLY in
 * `cove-cash-poker.ts`. The scaler calls `cashTableManager.createTable` DIRECTLY
 * (not via the rate-limited route), so the house-bank creator is exempt and can
 * stand up all N tables. (If a future refactor moves the cap into the manager, the
 * scaler must be granted an explicit exemption — flagged in the design traps.)
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 *   - `houseScalerEnabled()` gate (off for local/dev) — checked at start.
 *   - `sweepInFlight` re-entrancy guard (a slow pass never overlaps the next).
 *   - PER-TIER try/catch so one tier's failure never stops the others.
 *   - The house-bank avatar is resolved fresh each pass from the seeder (which
 *     `ensure()`d at boot before the scaler starts), so a not-yet-ensured seeder
 *     surfaces as a caught per-pass error, never a crash.
 *   - The ONLY ledger writes it triggers are the bounded, treasury-banked seeded-bot
 *     buy-ins via `seatHouseBots` (each a house-bank DEBIT, the existing no-faucet
 *     guard unchanged) — a BOUNDED lock-up (≈ Σ tables × seededAgentSlots × buyIn),
 *     NOT a drain: idle bots never re-buy (the deal-gate + real-player-gated re-buy).
 *     All other CT movement stays inside the manager's seat/settle path.
 */

import { sql } from 'drizzle-orm';
import { db as realDb } from '@clawville/database';
import { cashTableManager } from './cash-table-manager-singleton';
import type { CashSubject, CreateCashTableConfig } from './cash-table-manager';
import { cashHouseSeeder } from './cash-house-seeder';
import {
  HOUSE_TIERS,
  HOUSE_TIER_KEYS,
  houseOpenTables,
  houseScalerEnabled,
  houseScalerIntervalMs,
  houseSeededSlotsPerTable,
} from './cash-house-config';

let scalerInterval: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

/** COUNT the open `source='house'` public tables of a tier. One grouped query per tier. */
async function countOpenHouseTables(tierKey: string): Promise<number> {
  const rows = await realDb.execute<{ n: number | string }>(
    sql`SELECT COUNT(*)::int AS n FROM poker_cash_tables
        WHERE source = 'house' AND visibility = 'public'
          AND status = 'open' AND tier_key = ${tierKey}`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * One scaler pass: for each tier, create the deficit toward `N_per_tier` open house
 * tables. Re-entrancy guarded; per-tier errors are swallowed (logged). Exported for
 * tests / a manual single-pass run. Returns the total number of tables created.
 */
export async function cashHouseScalerPass(): Promise<number> {
  if (sweepInFlight) return 0;
  sweepInFlight = true;
  try {
    // The house-bank avatar as the table creator (`created_by` audit). Resolved
    // fresh each pass; if the seeder hasn't ensured yet, this throws and the whole
    // pass is caught below (no partial damage — nothing was created yet).
    let houseSubject: CashSubject;
    try {
      const houseBankAvatarId = cashHouseSeeder.houseBankAvatarId();
      houseSubject = {
        kind: 'agent',
        userId: houseBankAvatarId,
        avatarId: houseBankAvatarId,
        agentId: 'poker-house-bank',
        name: 'Poker House Bank',
      };
    } catch (err) {
      console.warn('[cash-scaler] house bank not ready (seeder.ensure() pending?):', err);
      return 0;
    }

    const seededSlots = houseSeededSlotsPerTable();
    let created = 0;

    for (const tierKey of HOUSE_TIER_KEYS) {
      try {
        const target = houseOpenTables(tierKey);
        if (target <= 0) continue;
        const open = await countOpenHouseTables(tierKey);
        const deficit = target - open;
        if (deficit <= 0) continue;

        const tier = HOUSE_TIERS[tierKey];
        for (let i = 0; i < deficit; i++) {
          const config: CreateCashTableConfig = {
            source: 'house',
            visibility: 'public',
            tierKey,
            buyInCt: tier.buyInCt,
            smallBlindCt: tier.smallBlindCt,
            bigBlindCt: tier.bigBlindCt,
            maxSeats: tier.maxSeats, // locked 6
            seededAgentSlots: seededSlots, // locked 3 (env-overridable)
          };
          const newTable = await cashTableManager.createTable(config, houseSubject);
          // OPTION B (founder-approved 2026-06-22): EAGER-SEAT the bots right after
          // create so the lobby shows ~seededSlots seated bots per house table — the
          // "always populated" look — WITHOUT dealing a hand. `seatHouseBots` tops up
          // toward the lobby target under the per-table lock and debits the house bank
          // for each seeded buy-in (treasury-banked, no-faucet guard unchanged). NO
          // hand deals until a REAL player sits (the `maybeStartHand` gate), so the
          // idle bots' stacks stay frozen and the bankroll never churns bot-vs-bot.
          // Idempotent: a future pass that re-seats only fills the deficit.
          await cashTableManager.seatHouseBots(newTable.id);
          created++;
        }
      } catch (err) {
        // One tier's failure must never stop the others.
        console.error(`[cash-scaler] tier ${tierKey} scale failed:`, err);
      }
    }

    if (created > 0) {
      console.log(`[cash-scaler] created ${created} house table(s) to refill the deficit`);
    }
    return created;
  } finally {
    sweepInFlight = false;
  }
}

/**
 * Wire up the periodic scaler. Idempotent. No-op when `CASH_HOUSE_SCALER_ENABLED`
 * is false (local/dev runs without house tables). Run an immediate pass on start so
 * the tables exist before the first visitor instead of waiting a full interval.
 */
export function startCashHouseScaler(): void {
  if (scalerInterval) return;
  if (!houseScalerEnabled()) {
    console.log('[cash-scaler] disabled (CASH_HOUSE_SCALER_ENABLED=false) — no house tables');
    return;
  }
  const periodMs = houseScalerIntervalMs();
  // Immediate first pass so the lobby is populated at boot (errors swallowed).
  cashHouseScalerPass().catch((err) => console.error('[cash-scaler] initial pass failed:', err));
  scalerInterval = setInterval(() => {
    cashHouseScalerPass().catch((err) => {
      console.error('[cash-scaler] scaler pass failed:', err);
    });
  }, periodMs);
  console.log(`[cash-scaler] Started — keeping N house tables/tier open, sweep every ${periodMs}ms`);
}

/** Stop the scaler (graceful shutdown / HMR). Idempotent. */
export function stopCashHouseScaler(): void {
  if (scalerInterval) {
    clearInterval(scalerInterval);
    scalerInterval = null;
  }
}
