/**
 * Shared-table baccarat: the house AUTO-SCALER.
 *
 * Keeps `BAC_HOUSE_TABLES_LOW|MID|HIGH` (default 1 each) open `source='house'`
 * public tables per tier, and keeps each open house table filled toward its
 * `seeded_agent_slots` visual-only bots. Each pass, per tier, in ONE tx under
 * `pg_advisory_xact_lock(hashtext('baccarat-house-scaler'))` (two API processes
 * during a Coolify flip can never both create the deficit): count the open tables,
 * then create the deficit with `createTable(config, creator, tx)` (each new table
 * gets its first commit-reveal shoe in the same tx). After the tier txs, every open
 * house table gets `seatHouseBots` (idempotent).
 *
 * It never deletes a table. An empty house table idles (no coup deals until a real
 * bet exists). ZERO ledger writes: seeded bots never bet.
 *
 * Safety: `baccaratHouseScalerEnabled()` gate; `sweepInFlight` guard; per-tier and
 * per-table try/catch.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db as realDb, baccaratTables } from '@clawville/database';
import { baccaratTableManager } from './baccarat-table-manager-singleton';
import { baccaratHouseSeeder } from './baccarat-house-seeder';
import type { CreateBaccaratTableConfig } from './baccarat-table-manager';
import {
  BACCARAT_HOUSE_TIERS,
  BACCARAT_HOUSE_TIER_KEYS,
  baccaratHouseOpenTables,
  baccaratHouseScalerEnabled,
  baccaratHouseScalerIntervalMs,
  baccaratHouseSeededSlots,
} from './baccarat-house-config';

const SCALER_ADVISORY_KEY = 'baccarat-house-scaler';

let scalerInterval: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

/** One pass. Returns the number of tables created. Exported for a manual run. */
export async function baccaratHouseScalerPass(): Promise<number> {
  if (sweepInFlight) return 0;
  sweepInFlight = true;
  try {
    // `created_by` is audit only (nullable): a seeded bot avatar when the pool exists.
    const creator = baccaratHouseSeeder.botAvatarIds()[0] ?? null;
    const seededSlots = baccaratHouseSeededSlots();
    let created = 0;

    for (const tierKey of BACCARAT_HOUSE_TIER_KEYS) {
      try {
        const target = baccaratHouseOpenTables(tierKey);
        if (target <= 0) continue;
        const tier = BACCARAT_HOUSE_TIERS[tierKey];
        const config: CreateBaccaratTableConfig = {
          source: 'house',
          visibility: 'public',
          tierKey,
          minBetCt: tier.minBetCt,
          maxBetCt: tier.maxBetCt,
          maxSeats: tier.maxSeats,
          seededAgentSlots: Math.min(seededSlots, tier.maxSeats),
        };
        created += await realDb.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SCALER_ADVISORY_KEY}))`);
          const open = await tx
            .select({ id: baccaratTables.id })
            .from(baccaratTables)
            .where(
              and(
                eq(baccaratTables.source, 'house'),
                eq(baccaratTables.visibility, 'public'),
                eq(baccaratTables.status, 'open'),
                eq(baccaratTables.tierKey, tierKey),
              ),
            );
          const deficit = target - open.length;
          let made = 0;
          for (let i = 0; i < deficit; i++) {
            await baccaratTableManager.createTable(config, creator, tx);
            made++;
          }
          return made;
        });
      } catch (err) {
        console.error(`[baccarat-scaler] tier ${tierKey} scale failed:`, err);
      }
    }

    // Fill every open house table toward its seeded slots (idempotent, no money).
    try {
      const tables = await realDb
        .select({ id: baccaratTables.id })
        .from(baccaratTables)
        .where(and(eq(baccaratTables.source, 'house'), eq(baccaratTables.status, 'open')));
      for (const t of tables) {
        try {
          await baccaratTableManager.seatHouseBots(t.id);
        } catch (err) {
          console.error(`[baccarat-scaler] seatHouseBots failed for ${t.id}:`, err);
        }
      }
    } catch (err) {
      console.error('[baccarat-scaler] open house tables query failed:', err);
    }

    if (created > 0) console.log(`[baccarat-scaler] created ${created} house table(s)`);
    return created;
  } finally {
    sweepInFlight = false;
  }
}

/** Start the periodic scaler with an immediate first pass. Idempotent; off when disabled. */
export function startBaccaratHouseScaler(): void {
  if (scalerInterval) return;
  if (!baccaratHouseScalerEnabled()) {
    console.log('[baccarat-scaler] disabled (BAC_HOUSE_SCALER_ENABLED=false): no house tables');
    return;
  }
  const periodMs = baccaratHouseScalerIntervalMs();
  baccaratHouseScalerPass().catch((err) => console.error('[baccarat-scaler] initial pass failed:', err));
  scalerInterval = setInterval(() => {
    baccaratHouseScalerPass().catch((err) => console.error('[baccarat-scaler] pass failed:', err));
  }, periodMs);
  console.log(`[baccarat-scaler] Started: sweep every ${periodMs}ms`);
}

/** Stop the scaler (graceful shutdown). Idempotent. */
export function stopBaccaratHouseScaler(): void {
  if (scalerInterval) {
    clearInterval(scalerInterval);
    scalerInterval = null;
  }
}
