/**
 * Poker CASH GAMES — autonomous self-drive TICK.
 *
 * THE missing self-drive seam. Without it, seeded bots ONLY act when a human
 * REST-pokes (`driveSeededAgents` runs inside `sitDown`→`startAndAdvance` and
 * `submitAction`). A solo human with a bot on the button would STALL until the
 * human acts, and a bot's turn would never run its policy — the sim's internal
 * auto-fold timer would check/fold the bot instead of playing it. This guarded
 * `setInterval` closes that gap: on every pass it advances each open
 * `source='house'` table by one tick so bots act on their turn, hands settle, and
 * the next hand auto-starts WITHOUT a human poke.
 *
 * ── OPTION B (founder-approved 2026-06-22) ───────────────────────────────────
 * `advanceTable` deals a hand ONLY when ≥1 REAL player (human OR connected/hosted
 * agent — a sitting-in, non-seeded seat) is at the table. For a BOT-ONLY table the
 * tick is a deal/money NO-OP: no new hand, no busted-bot re-buy, frozen stacks,
 * zero bankroll churn. The tick still keeps the lobby populated — it eagerly tops
 * up the seated bots toward the lobby target each pass (bounded, treasury-banked).
 * So the always-populated look survives with NO 24/7 bot-vs-bot bankroll drain.
 *
 * ── CADENCE INVARIANT ────────────────────────────────────────────────────────
 * `CASH_TABLE_TICK_MS` (default 1_500, clamped [250, 20_000]) MUST be well under
 * the sim's `turnClock (25_000) + grace (5_000)` so a bot acts BEFORE the sim's
 * auto-fold timer fires. `cashTableTickMs()` enforces the clamp.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 *   - `sweepInFlight` re-entrancy guard (a slow pass never overlaps the next).
 *   - PER-TABLE try/catch so one stuck/erroring table never stalls the loop or
 *     starves the others.
 *   - `cashTableManager.advanceTable(tableId)` runs under the SAME per-table lock
 *     the REST sit/leave/action path uses, so the tick can NEVER interleave with a
 *     human action and adds NO new money path.
 *   - Scope: ONLY `source='house'` open tables are advanced. Player-public /
 *     private tables are human/agent-driven (no bots), so the tick leaves them
 *     alone — their hands progress on each player's REST action as before.
 */

import { sql } from 'drizzle-orm';
import { db as realDb } from '@clawville/database';
import { cashTableManager } from './cash-table-manager-singleton';
import { cashTableTickMs } from './cash-house-config';

let tickInterval: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

/**
 * One tick pass: advance every open `source='house'` table by one step. Re-entrancy
 * guarded; per-table errors are swallowed (logged) so one bad table never stalls the
 * loop. Exported for tests / a manual single-pass drive.
 */
export async function cashTableTickPass(): Promise<number> {
  if (sweepInFlight) return 0;
  sweepInFlight = true;
  try {
    let rows: Array<{ id: string }>;
    try {
      rows = await realDb.execute<{ id: string }>(
        sql`SELECT id FROM poker_cash_tables
            WHERE source = 'house' AND status = 'open'`,
      );
    } catch (err) {
      console.error('[cash-tick] open-house-tables query failed:', err);
      return 0;
    }

    let advanced = 0;
    for (const row of rows) {
      try {
        await cashTableManager.advanceTable(row.id);
        advanced++;
      } catch (err) {
        // One stuck/erroring table must never stall the loop or starve the others.
        console.error(`[cash-tick] advanceTable failed for ${row.id}:`, err);
      }
    }
    return advanced;
  } finally {
    sweepInFlight = false;
  }
}

/** Wire up the periodic self-drive tick. Idempotent — a second call is a no-op. */
export function startCashTableTick(): void {
  if (tickInterval) return;
  const periodMs = cashTableTickMs();
  tickInterval = setInterval(() => {
    cashTableTickPass().catch((err) => {
      console.error('[cash-tick] tick pass failed:', err);
    });
  }, periodMs);
  console.log(`[cash-tick] Started — advancing open house tables every ${periodMs}ms`);
}

/** Stop the self-drive tick (graceful shutdown / HMR). Idempotent. */
export function stopCashTableTick(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}
