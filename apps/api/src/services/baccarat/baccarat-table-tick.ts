/**
 * Shared-table baccarat: the round-loop TICK.
 *
 * A guarded `setInterval` (`BAC_TABLE_TICK_MS`, default 1000, clamped 250..5000)
 * that advances every open `source='house'` table by one step through
 * `baccaratTableManager.tickRound`. The round phase lives on the table row (D1), so
 * the tick is stateless: a restart or a second API process during a Coolify flip
 * resumes from the row, and the CAS deal claim lets exactly one process deal.
 *
 * Every 60 s the pass also runs `maintainTable` per table: the orphan guard (void a
 * pending bet of an already-advanced round, warn alert) and the idle-seat sweep
 * (free a real seat idle for 10 min with no pending bet).
 *
 * Safety: `sweepInFlight` re-entrancy guard; a per-table try/catch so one stuck
 * table never stalls the others; `tickRound` runs under the same per-table lock as
 * the REST sit/leave/bet paths.
 */

import { and, eq } from 'drizzle-orm';
import { db as realDb, baccaratTables } from '@clawville/database';
import { baccaratTableManager } from './baccarat-table-manager-singleton';
import { baccaratTableTickMs } from './baccarat-house-config';

export const BACCARAT_MAINTENANCE_INTERVAL_MS = 60_000;

let tickInterval: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;
let lastMaintenanceAt = 0;

/** One pass: advance every open house table by one step. Returns the tables ticked. */
export async function baccaratTableTickPass(now: number = Date.now()): Promise<number> {
  if (sweepInFlight) return 0;
  sweepInFlight = true;
  try {
    let rows: Array<{ id: string }>;
    try {
      rows = await realDb
        .select({ id: baccaratTables.id })
        .from(baccaratTables)
        .where(and(eq(baccaratTables.source, 'house'), eq(baccaratTables.status, 'open')));
    } catch (err) {
      console.error('[baccarat-tick] open house tables query failed:', err);
      return 0;
    }

    const maintain = now - lastMaintenanceAt >= BACCARAT_MAINTENANCE_INTERVAL_MS;
    if (maintain) lastMaintenanceAt = now;

    let ticked = 0;
    for (const row of rows) {
      try {
        await baccaratTableManager.tickRound(row.id);
        ticked++;
      } catch (err) {
        console.error(`[baccarat-tick] tickRound failed for ${row.id}:`, err);
      }
      if (maintain) {
        try {
          await baccaratTableManager.maintainTable(row.id);
        } catch (err) {
          console.error(`[baccarat-tick] maintainTable failed for ${row.id}:`, err);
        }
      }
    }
    return ticked;
  } finally {
    sweepInFlight = false;
  }
}

/** Start the periodic round tick. Idempotent. */
export function startBaccaratTableTick(): void {
  if (tickInterval) return;
  const periodMs = baccaratTableTickMs();
  tickInterval = setInterval(() => {
    baccaratTableTickPass().catch((err) => {
      console.error('[baccarat-tick] tick pass failed:', err);
    });
  }, periodMs);
  console.log(`[baccarat-tick] Started: advancing open house tables every ${periodMs}ms`);
}

/** Stop the round tick (graceful shutdown). Idempotent. */
export function stopBaccaratTableTick(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}
