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
 *   4. GRID RECENTER (576->704 world grow, 2026-06-24): recomputes every existing
 *      row's grid_x/grid_y under the NEW 11264 HALF_MAP_WU (== +64 on each axis;
 *      cx/cz are origin-invariant, only the offset changed) so old + new parcels
 *      share ONE coordinate system. Done as ONE set-based UPDATE ... FROM (VALUES)
 *      to absolute values (idempotent + collision-free under the
 *      land_parcels_grid_unique index, which a per-row +64 loop would transiently
 *      violate — two existing rows can be exactly +64 apart).
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

// Grid-coord constants — MUST match `parcelToTileZone` in
// `packages/shared/src/constants/land-parcels.ts` and `seed-land-parcels.ts`.
// World grew 576->704 (2026-06-24): HALF_MAP_WU 9216 -> 11264, so EVERY existing
// row's grid_x/grid_y (seeded under the old 9216 offset) is now stale by exactly
// +64 (the parcel cx/cz are origin-invariant; only the offset changed). This
// migration recomputes grid_x/grid_y from cx/cz under the NEW offset and UPDATEs
// every row, so old + new parcels share ONE consistent coordinate system and a
// stale old-grid coord can never collide with a new c-row's unique (grid_x,grid_y).
const TILE_SIZE = 32; // wu per tile (== TILE_SIZE in land-parcels.ts)
const HALF_MAP_WU = (704 / 2) * TILE_SIZE; // 11264 wu — grid half-width (704-world)

interface RepriceRow {
  parcelCode: string;
  tier: LandTier;
  gridX: number;
  gridY: number;
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
    const gridX = Math.floor((slot.cx + HALF_MAP_WU) / TILE_SIZE);
    const gridY = Math.floor((slot.cz + HALF_MAP_WU) / TILE_SIZE);
    if (!Number.isInteger(gridX) || gridX < 0 || gridX >= 704) {
      throw new Error(`${LOG} grid_x out of bounds for ${slot.id}: gridX=${gridX} (cx=${slot.cx}); expected [0, 704).`);
    }
    if (!Number.isInteger(gridY) || gridY < 0 || gridY >= 704) {
      throw new Error(`${LOG} grid_y out of bounds for ${slot.id}: gridY=${gridY} (cz=${slot.cz}); expected [0, 704).`);
    }
    rows.push({
      parcelCode: slot.id,
      tier: slot.tier,
      gridX,
      gridY,
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
  // Grid recenter sample — one row per populated tier, NEW grid coords (704 world).
  const gridSample = (tier: LandTier) => {
    const r = rows.find((x) => x.tier === tier);
    return r ? `${r.parcelCode} -> grid (${r.gridX}, ${r.gridY})` : '(none)';
  };
  console.log(`${LOG} grid recenter (576->704, +64/axis) sample NEW coords:`);
  console.log(`${LOG}   founder  ${gridSample('founder')}`);
  console.log(`${LOG}   starter  ${gridSample('starter')}`);
  console.log(`${LOG}   c        ${gridSample('c')}`);
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

    // Reprice + rent-stamp + grid-recenter in ONE transaction (atomic).
    //
    // GRID RECENTER FIRST, as a SINGLE set-based statement — NOT a per-row loop.
    // `land_parcels_grid_unique` is a UNIQUE index on (grid_x, grid_y), and the
    // +64 recenter is a uniform shift, so two existing rows can be exactly +64
    // apart: a per-row UPDATE would transiently collide (row A's NEW coord ==
    // row B's still-old coord), failing the per-statement unique check. A single
    // UPDATE ... FROM (VALUES ...) sets ALL rows to their ABSOLUTE new coords in
    // ONE statement, so Postgres checks the index only at end-of-statement on the
    // collision-free final state. Absolute values (from the frozen LAND_PARCELS
    // cx/cz under the new 11264 offset) make it IDEMPOTENT — a re-run sets the
    // same coords. Only matches existing parcel_codes; not-yet-seeded c-rows are
    // untouched here (the seed inserts them later with the same 11264 offset).
    // Build a parameterized VALUES list ($1,$2,$3),($4,$5,$6),... — injection-safe
    // (all values are bound params, never string-concatenated) and portable on the
    // raw postgres.js client via client.unsafe(query, params).
    const gridParams: (string | number)[] = [];
    const gridTuples = rows
      .map((r, i) => {
        const base = i * 3;
        gridParams.push(r.parcelCode, r.gridX, r.gridY);
        return `($${base + 1}, $${base + 2}::int, $${base + 3}::int)`;
      })
      .join(', ');
    const regridResult = await client.unsafe(
      `UPDATE land_parcels AS p
         SET grid_x = v.gx, grid_y = v.gy, updated_at = now()
       FROM (VALUES ${gridTuples}) AS v(code, gx, gy)
       WHERE p.parcel_code = v.code
         AND (p.grid_x <> v.gx OR p.grid_y <> v.gy)`,
      gridParams,
    );
    const regridded = regridResult.count;

    // Reprice + rent-stamp per row (price_ct / rent_ct_weekly have no unique
    // constraint, so a per-row loop is safe). Recomputed from the new ladders so
    // existing rows == the new ladder (no divergence). UPDATE-by-parcel_code:
    // c-rows not yet seeded simply match 0 rows here until the seed inserts them.
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
    console.log(`${LOG} DONE. regridded=${regridded} (grid_x/grid_y +64 recenter), repriced=${repriced} of ${rows.length} parcel rows; tenure back-filled.`);
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
