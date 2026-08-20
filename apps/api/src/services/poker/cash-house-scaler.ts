/**
 * Poker CASH GAMES — house AUTO-SCALER.
 *
 * Keeps `N` open `source='house'` public tables alive per tier at all times so a
 * visitor always finds a populated, bot-seated table to sit at. A guarded
 * `setInterval` that, each pass:
 *   1. Releases abandoned, busted non-seeded seats across all cash tables.
 *   2. Retires safe-to-close house tables whose stakes no longer match their tier.
 *   3. Closes idle, empty non-house tables whose escrow is zero.
 *   4. COUNTs the open `source='house'` public tables of each `tierKey`.
 *   5. Creates the deficit `(N - open)` via `cashTableManager.createTable(...)`
 *      with the HOUSE-BANK avatar as the creator subject.
 *   6. EAGER-SEATS the bots (`cashTableManager.seatHouseBots`) so the lobby shows
 *      ~`seededAgentSlots` seated bots per table WITHOUT dealing a hand (Option B,
 *      founder-approved 2026-06-22) — the "always populated" look with NO 24/7
 *      bot-vs-bot bankroll drain (no hand deals until a REAL player sits).
 * It never deletes rows: retired tables are closed only after their seeded stacks
 * are reclaimed and escrow reaches zero. A bounded `N` per tier (env-overridable,
 * default 2/2/1) keeps it from running away.
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
  idleEmptyTableWindowMs,
} from './cash-house-config';

let scalerInterval: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

// Give a busted player ten minutes to reconnect before freeing their dead seat.
const BUSTED_SEAT_IDLE_MS = 10 * 60 * 1_000;

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
 * Release abandoned zero-stack human/agent seats on house and player tables. The
 * query supplies candidates only; the manager serializes per table and re-checks
 * both the seat and live-hand guard before changing anything.
 */
async function releaseBustedSeats(): Promise<void> {
  let rows: Array<{ seat_id: string; table_id: string }>;
  try {
    // Raw-sql params bypass Drizzle's column serializers — a bare Date throws at
    // runtime on the postgres.js driver, so the timestamp goes over as ISO text.
    const staleBefore = new Date(Date.now() - BUSTED_SEAT_IDLE_MS).toISOString();
    rows = await realDb.execute<{ seat_id: string; table_id: string }>(
      sql`SELECT id AS seat_id, table_id
          FROM poker_cash_seats
          WHERE status <> 'left'
            AND is_seeded = 'false'
            AND current_stack_ct = '0'
            AND updated_at < ${staleBefore}::timestamptz`,
    );
  } catch (err) {
    console.error('[cash-scaler] busted-seat discovery failed:', err);
    return;
  }

  for (const row of rows) {
    try {
      await cashTableManager.releaseBustedSeat(row.table_id, row.seat_id);
    } catch (err) {
      console.error(
        `[cash-scaler] busted seat ${row.seat_id} on table ${row.table_id} release failed:`,
        err,
      );
    }
  }
}

/**
 * Close open house tables whose persisted stakes no longer match their configured
 * tier. One discovery query is the entire common-case cost; each candidate is
 * independently fenced and retired by the manager so one failure cannot stop the
 * remaining candidates or escape the scaler pass.
 */
async function retireMismatchedHouseTables(): Promise<void> {
  let rows: Array<{ id: string }>;
  try {
    rows = await realDb.execute<{ id: string }>(
      sql`SELECT id FROM poker_cash_tables
          WHERE source = 'house' AND status = 'open'
            AND (
              tier_key IS NULL
              OR tier_key NOT IN (${HOUSE_TIER_KEYS[0]}, ${HOUSE_TIER_KEYS[1]}, ${HOUSE_TIER_KEYS[2]})
              OR (tier_key = ${HOUSE_TIER_KEYS[0]} AND (
                buy_in_ct IS DISTINCT FROM ${HOUSE_TIERS.low.buyInCt}
                OR small_blind_ct IS DISTINCT FROM ${HOUSE_TIERS.low.smallBlindCt}
                OR big_blind_ct IS DISTINCT FROM ${HOUSE_TIERS.low.bigBlindCt}
              ))
              OR (tier_key = ${HOUSE_TIER_KEYS[1]} AND (
                buy_in_ct IS DISTINCT FROM ${HOUSE_TIERS.mid.buyInCt}
                OR small_blind_ct IS DISTINCT FROM ${HOUSE_TIERS.mid.smallBlindCt}
                OR big_blind_ct IS DISTINCT FROM ${HOUSE_TIERS.mid.bigBlindCt}
              ))
              OR (tier_key = ${HOUSE_TIER_KEYS[2]} AND (
                buy_in_ct IS DISTINCT FROM ${HOUSE_TIERS.high.buyInCt}
                OR small_blind_ct IS DISTINCT FROM ${HOUSE_TIERS.high.smallBlindCt}
                OR big_blind_ct IS DISTINCT FROM ${HOUSE_TIERS.high.bigBlindCt}
              ))
            )`,
    );
  } catch (err) {
    console.error('[cash-scaler] mismatched house-table discovery failed:', err);
    return;
  }

  for (const row of rows) {
    try {
      await cashTableManager.retireHouseTable(row.id);
    } catch (err) {
      console.error(`[cash-scaler] house table ${row.id} retirement failed:`, err);
    }
  }
}

/**
 * Close open non-house tables that have remained empty for the configured idle
 * window. Discovery is read-only; the manager independently re-checks every
 * money and seat predicate under the per-table lock before closing a candidate.
 */
async function retireIdleEmptyTables(): Promise<void> {
  // ONE cutoff for the whole pass: discovery selects against it and the manager
  // re-evaluates the SAME instant under the table lock, so a table that stops
  // being idle mid-pass is not closed on stale evidence.
  const idleBefore = new Date(Date.now() - idleEmptyTableWindowMs());
  let rows: Array<{ id: string }>;
  try {
    // Raw-sql params bypass Drizzle's column serializers, so send ISO text and
    // cast it explicitly rather than binding a Date object.
    const idleBeforeIso = idleBefore.toISOString();
    rows = await realDb.execute<{ id: string }>(
      // NOTE (Codex adversarial pass, 2026-08-20): deliberately NO escrow
      // predicate here. Pre-filtering on `table_escrow_ct = '0'` made the
      // manager's orphan-escrow refusal unreachable in production — an empty
      // table holding stranded CT was silently never selected, so it stayed
      // open forever, held a creator slot forever, and paged nobody. Discovery
      // now surfaces it; the manager refuses to close it AND alerts ops.
      sql`SELECT cash_table.id
          FROM poker_cash_tables AS cash_table
          LEFT JOIN poker_cash_seats AS seat ON seat.table_id = cash_table.id
          WHERE cash_table.status = 'open'
            AND cash_table.source <> 'house'
            AND NOT EXISTS (
              SELECT 1 FROM poker_cash_seats AS active_seat
              WHERE active_seat.table_id = cash_table.id
                AND active_seat.status <> 'left'
            )
          GROUP BY cash_table.id
          HAVING GREATEST(
            cash_table.updated_at,
            COALESCE(MAX(seat.updated_at), cash_table.created_at)
          ) < ${idleBeforeIso}::timestamptz`,
    );
  } catch (err) {
    console.error('[cash-scaler] idle empty-table discovery failed:', err);
    return;
  }

  for (const row of rows) {
    try {
      await cashTableManager.retireIdleEmptyTable(row.id, idleBefore);
    } catch (err) {
      console.error(`[cash-scaler] idle empty table ${row.id} retirement failed:`, err);
    }
  }
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
    await releaseBustedSeats();
    await retireMismatchedHouseTables();
    await retireIdleEmptyTables();

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
