/**
 * migrate-land-tenure.ts — Builder-economics tenure migration + reprice (2026-06-24).
 * ============================================================================
 *
 * WHAT THIS DOES (idempotent, additive — safe to re-run)
 * ------------------------------------------------------
 *   1. DDL (idempotent): creates the `land_tenure` + `land_structure_status`
 *      enums, adds the `eviction` value to `land_transaction_kind`, adds the
 *      tenure/rent columns to `land_parcels` + `status` to `land_structures`,
 *      and the partial rent-sweep index. Every step is `IF NOT EXISTS` /
 *      duplicate-safe, so a re-run is a no-op on already-applied deltas.
 *   2. REPRICE (founder decision 2026-06-24 — "existing == new"): recomputes
 *      `price_ct` from the NEW `LAND_TIER_LADDER` and stamps `rent_ct_weekly`
 *      from `LAND_RENT_LADDER` per parcel (same per-tier interpolation as the
 *      seed), UPDATEing the EXISTING rows so old-stamped prices match the new
 *      ladder with no divergence.
 *   3. TENURE back-fill: already-bought parcels -> 'owned', free starter claims
 *      -> 'starter'; available/unsold rows keep tenure NULL.
 *
 * EXPLICIT-URL-ONLY (the prod-write incident — see seed-land-parcels.ts)
 * ---------------------------------------------------------------------
 *   - DB URL read ONLY from `SEED_DATABASE_URL`. NO fallback to DATABASE_URL,
 *     NO `.env.local` load. This script does NOT import the auto-connecting
 *     `@clawville/database` `db` proxy — it creates its OWN `postgres()` client.
 *   - `@clawville/shared` is imported for the PURE geometry + ladder constants
 *     (no DB side effects at module load).
 *   - The DB URL is a secret: NEVER logged, echoed, or printed.
 *
 * RUN
 * ---
 *   # Dry-run (DEFAULT-SAFE — no env, no connect, no write). Prints the per-tier
 *   # price + rent bands it WOULD stamp. This is the verify step.
 *   bun apps/api/scripts/migrate-land-tenure.ts --dry-run
 *
 *   # Real migration (orchestrator only — explicit URL required, STAGING first):
 *   SEED_DATABASE_URL=<target-session-pooler-url> bun apps/api/scripts/migrate-land-tenure.ts
 *
 * Use the Supabase SESSION pooler URL (:5432) for DDL safety, never :6543.
 */

import postgres from 'postgres';
import {
  LAND_PARCELS,
  LAND_TIER_LADDER,
  LAND_RENT_LADDER,
  PARCEL_TIER_COUNTS,
  TOTAL_PARCEL_SUPPLY,
  type LandTier,
} from '@clawville/shared';

const LOG = '[migrate-land-tenure]';

interface RepriceRow {
  parcelCode: string;
  tier: LandTier;
  priceCt: number | null;
  rentCtWeekly: number | null;
}

/**
 * Interpolate a per-parcel value from a tier band. RAMP: innermost parcel in a
 * tier (indexInTier 0) = `maxCt`, outermost = `minCt`. Null band (founder, or
 * starter rent) -> null. Identical math to the seed's `interpolatePrice`, shared
 * by both the buy ladder + the rent ladder so they ramp the same way.
 */
function interpolate(
  band: { minCt: number | null; maxCt: number | null },
  indexInTier: number,
  count: number,
): number | null {
  if (band.minCt === null || band.maxCt === null) return null;
  const { minCt, maxCt } = band;
  if (count <= 1) return maxCt;
  return Math.round(maxCt - (maxCt - minCt) * (indexInTier / (count - 1)));
}

/** Build the reprice row set from the frozen geometry + the NEW ladders. */
function buildRepriceRows(): RepriceRow[] {
  const rows: RepriceRow[] = [];
  const seen = new Set<string>();
  for (const slot of LAND_PARCELS) {
    if (seen.has(slot.id)) {
      throw new Error(`${LOG} duplicate parcel_code in LAND_PARCELS: ${slot.id}`);
    }
    seen.add(slot.id);
    const count = PARCEL_TIER_COUNTS[slot.tier];
    rows.push({
      parcelCode: slot.id,
      tier: slot.tier,
      priceCt: interpolate(LAND_TIER_LADDER[slot.tier], slot.indexInTier, count),
      rentCtWeekly: interpolate(LAND_RENT_LADDER[slot.tier], slot.indexInTier, count),
    });
  }
  return rows;
}

function perTierRanges(rows: RepriceRow[], key: 'priceCt' | 'rentCtWeekly'): Record<string, string> {
  const acc: Record<string, { min: number; max: number } | 'NULL'> = {};
  for (const r of rows) {
    const v = r[key];
    if (v === null) {
      if (acc[r.tier] === undefined) acc[r.tier] = 'NULL';
      continue;
    }
    const cur = acc[r.tier];
    if (cur === undefined || cur === 'NULL') acc[r.tier] = { min: v, max: v };
    else {
      cur.min = Math.min(cur.min, v);
      cur.max = Math.max(cur.max, v);
    }
  }
  const out: Record<string, string> = {};
  for (const [tier, v] of Object.entries(acc)) {
    out[tier] = v === 'NULL' ? 'NULL (not priced/rentable)' : `${v.min} … ${v.max} CT`;
  }
  return out;
}

function printDryRun(rows: RepriceRow[]): void {
  console.log(`${LOG} DRY RUN — no env read, no DB connection, no write.`);
  console.log(`${LOG} rows: ${rows.length} (expected ${TOTAL_PARCEL_SUPPLY})`);
  const priceRanges = perTierRanges(rows, 'priceCt');
  const rentRanges = perTierRanges(rows, 'rentCtWeekly');
  console.log(`${LOG} per-tier BUY price_ct (min … max):`);
  for (const tier of Object.keys(priceRanges)) console.log(`${LOG}   ${tier.padEnd(8)} ${priceRanges[tier]}`);
  console.log(`${LOG} per-tier WEEKLY rent_ct_weekly (min … max):`);
  for (const tier of Object.keys(rentRanges)) console.log(`${LOG}   ${tier.padEnd(8)} ${rentRanges[tier]}`);
  console.log(`${LOG} DRY RUN complete — nothing written.`);
}

async function applyDdl(client: postgres.Sql): Promise<void> {
  // Each runs in autocommit (no wrapping tx) — required for ALTER TYPE ADD VALUE
  // and safe + idempotent for the rest. Types BEFORE the columns that use them.
  console.log(`${LOG} applying idempotent DDL…`);
  await client`DO $$ BEGIN CREATE TYPE land_tenure AS ENUM ('rented','owned','starter'); EXCEPTION WHEN duplicate_object THEN null; END $$;`;
  await client`DO $$ BEGIN CREATE TYPE land_structure_status AS ENUM ('active','archived'); EXCEPTION WHEN duplicate_object THEN null; END $$;`;
  await client`ALTER TYPE land_transaction_kind ADD VALUE IF NOT EXISTS 'eviction'`;
  await client`ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS tenure land_tenure`;
  await client`ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS rent_ct_weekly integer`;
  await client`ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS rent_paid_through timestamptz`;
  await client`ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS grace_until timestamptz`;
  await client`ALTER TABLE land_structures ADD COLUMN IF NOT EXISTS status land_structure_status NOT NULL DEFAULT 'active'`;
  await client`CREATE INDEX IF NOT EXISTS land_parcels_rent_sweep_idx ON land_parcels (rent_paid_through) WHERE tenure = 'rented'`;
  console.log(`${LOG} DDL applied.`);
}

async function runMigration(rows: RepriceRow[]): Promise<void> {
  const url = process.env.SEED_DATABASE_URL;
  if (!url || url.trim() === '') {
    console.error(
      `${LOG} SEED_DATABASE_URL is not set. Refusing to run. Set it explicitly to ` +
        `the TARGET Supabase SESSION-pooler URL (:5432). This script does NOT load ` +
        `.env.local and does NOT fall back to DATABASE_URL. For a safe preview run --dry-run.`,
    );
    process.exit(1);
  }

  const client = postgres(url, { max: 1, prepare: false, connect_timeout: 15, idle_timeout: 10 });
  try {
    await applyDdl(client);

    // Reprice + rent-stamp in ONE transaction (atomic). price/rent recomputed
    // from the new ladders so existing rows == the new ladder (no divergence).
    let repriced = 0;
    await client.begin(async (sql) => {
      for (const r of rows) {
        const res = await sql`
          UPDATE land_parcels
          SET price_ct = ${r.priceCt}, rent_ct_weekly = ${r.rentCtWeekly}, updated_at = now()
          WHERE parcel_code = ${r.parcelCode}
        `;
        repriced += res.count;
      }
      // Tenure back-fill for already-acquired parcels (rent did not exist before,
      // so nothing is 'rented' yet). Available/unsold rows keep tenure NULL.
      await sql`UPDATE land_parcels SET tenure = 'starter' WHERE tier = 'starter' AND owner_avatar_id IS NOT NULL AND tenure IS NULL`;
      await sql`UPDATE land_parcels SET tenure = 'owned' WHERE tier <> 'starter' AND owner_avatar_id IS NOT NULL AND tenure IS NULL`;
    });
    console.log(`${LOG} DONE. repriced=${repriced} of ${rows.length} parcel rows; tenure back-filled.`);
  } catch (err) {
    console.error(`${LOG} FAILED`, err);
    process.exit(1);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const rows = buildRepriceRows();
  if (rows.length !== TOTAL_PARCEL_SUPPLY) {
    throw new Error(`${LOG} expected ${TOTAL_PARCEL_SUPPLY} parcels, built ${rows.length} — geometry drift. Aborting.`);
  }
  if (dryRun) {
    printDryRun(rows);
    return;
  }
  await runMigration(rows);
}

main().catch((err) => {
  console.error(`${LOG} unexpected top-level error`, err);
  process.exit(1);
});
