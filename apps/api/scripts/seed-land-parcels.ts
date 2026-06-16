/**
 * seed-land-parcels.ts — Land Economy Phase 1 / Slice A primary-sale supply seed.
 * ============================================================================
 *
 * WHAT THIS DOES
 * --------------
 * Inserts one `land_parcels` row per parcel in the FROZEN geometry constant
 * `LAND_PARCELS` (176 parcels: 4 founder + 8 a + 16 b + 40 c + 108 starter).
 * Each row stamps `parcel_code`, `tier`, `grid_x`, `grid_y`, and `price_ct`
 * (the per-row primary-sale price interpolated from the tier ladder). All other
 * columns take their schema defaults (status 'available', rake_bps 0,
 * timestamps now()). Idempotent: `ON CONFLICT (parcel_code) DO NOTHING`, so a
 * re-run never duplicates or reprices an existing parcel.
 *
 * THE PROD-WRITE INCIDENT — WHY THIS SCRIPT IS EXPLICIT-URL-ONLY
 * -------------------------------------------------------------
 * A prior agent caused a REAL PROD WRITE because a script run from
 * `packages/database` auto-loaded `packages/database/.env.local` (a prod URL)
 * via Bun's implicit `.env.local` loading and then connected through the
 * auto-connecting `@clawville/database` `db` proxy. To make that class of
 * accident IMPOSSIBLE here:
 *   - The DB URL is read ONLY from the explicit `SEED_DATABASE_URL` env var.
 *     There is NO fallback to `DATABASE_URL` and NO `.env.local` load.
 *   - This script does NOT import the `db` proxy from `@clawville/database`
 *     (which auto-connects via DATABASE_URL/.env.local on first use). It creates
 *     its OWN `postgres()` client from `SEED_DATABASE_URL` and writes raw SQL —
 *     exactly the explicit-only pattern of
 *     `packages/database/scripts/migrate-ci.ts`.
 *   - `@clawville/shared` is imported for the geometry + ladder constants. Those
 *     modules (`land-parcels.ts`, `land-economy.ts`, `land-tiers.ts`) are PURE —
 *     they import only from each other, never touch a DB, and have no side
 *     effects at module load — so importing them cannot trigger a connection.
 *   - SECURITY: the DB URL is a secret. This script NEVER logs, echoes, or
 *     prints it — not the full URL, not the host, not the credentials
 *     (mirrors migrate-ci.ts).
 *
 * RUN
 * ---
 *   # Dry-run (DEFAULT-SAFE — no env, no connect, no write). Prints the 176 rows
 *   # it WOULD insert + samples + per-tier price ranges. This is the verify step.
 *   bun apps/api/scripts/seed-land-parcels.ts --dry-run
 *
 *   # Real seed (orchestrator only — explicit URL required):
 *   SEED_DATABASE_URL=<target-session-pooler-url> bun apps/api/scripts/seed-land-parcels.ts
 *
 * Use the Supabase SESSION pooler URL (:5432) for DDL/seed safety, never the
 * transaction pooler (:6543, app runtime).
 */

import postgres from 'postgres';
import {
  LAND_PARCELS,
  LAND_TIER_LADDER,
  PARCEL_TIER_COUNTS,
  type LandTier,
} from '@clawville/shared';

const LOG = '[seed-land-parcels]';

// ---------------------------------------------------------------------------
// Grid-coord constants — MUST match `parcelToTileZone` in
// `packages/shared/src/constants/land-parcels.ts` so the seeded grid_x/grid_y
// land in the SAME tile cells the world/minimap renders the parcels at. There
// it computes `HALF_MAP_WU = (576 / 2) * TILE_SIZE = 9216` and
// `tileX = floor((cx + HALF_MAP_WU) / TILE_SIZE)`. We deliberately re-derive
// the two literals here (NOT import a web tilemap module) so this script has no
// dep beyond the pure `@clawville/shared` constants. World grid = 576x576 tiles.
// ---------------------------------------------------------------------------
const TILE_SIZE = 32; // wu per tile (== TILE_SIZE in land-parcels.ts)
const HALF_MAP_WU = (576 / 2) * TILE_SIZE; // 9216 wu — grid half-width
const WORLD_TILES = 576; // grid is WORLD_TILES x WORLD_TILES tiles

// ---------------------------------------------------------------------------
// Derived seed row.
// ---------------------------------------------------------------------------
interface SeedRow {
  parcelCode: string;
  tier: LandTier;
  gridX: number;
  gridY: number;
  /** Primary-sale CT price. `null` for the founder tier (auction/USDC-only). */
  priceCt: number | null;
}

/**
 * Interpolate a parcel's primary-sale `price_ct` from its tier ladder band.
 *
 * RAMP: innermost parcel in a tier (indexInTier 0) = `maxCt`, outermost
 * (indexInTier N-1) = `minCt`, linear across the tier's fixed count N.
 *   - N > 1: `round(maxCt - (maxCt - minCt) * indexInTier / (N - 1))`
 *   - N == 1: `maxCt`
 *   - founder tier: `LAND_TIER_LADDER.founder` is `{minCt:null, maxCt:null}`
 *     → returns `null` (SQL NULL, not 0). The v1 buy route returns 501 for
 *     founder; the row carries no CT price.
 *
 * NOTE on starter: its ladder is `{minCt:0, maxCt:150}`, so index 0 = 150 …
 * last index = 0. A 0-priced starter row is FINE — the "first starter claim is
 * FREE" rule is enforced by the route's claim-starter grant at amount 0, NOT by
 * a 0-priced row. The seed just stamps the interpolated ladder value.
 */
function interpolatePrice(tier: LandTier, indexInTier: number, count: number): number | null {
  const band = LAND_TIER_LADDER[tier];
  // Founder (or any future tier) with null anchors → no CT price.
  if (band.minCt === null || band.maxCt === null) {
    return null;
  }
  const { minCt, maxCt } = band;
  if (count <= 1) {
    return maxCt;
  }
  return Math.round(maxCt - (maxCt - minCt) * (indexInTier / (count - 1)));
}

/**
 * Build all 176 seed rows in deterministic order from the frozen geometry
 * constant. Asserts grid bounds + parcel-code uniqueness (throws on violation)
 * so a geometry/constant drift fails LOUD in dry-run before any DB is touched.
 */
function buildSeedRows(): SeedRow[] {
  const rows: SeedRow[] = [];
  const seenCodes = new Set<string>();

  for (const slot of LAND_PARCELS) {
    const count = PARCEL_TIER_COUNTS[slot.tier];
    const gridX = Math.floor((slot.cx + HALF_MAP_WU) / TILE_SIZE);
    const gridY = Math.floor((slot.cz + HALF_MAP_WU) / TILE_SIZE);

    // Grid sanity — every cell must sit inside the 576x576 world grid.
    if (!Number.isInteger(gridX) || gridX < 0 || gridX >= WORLD_TILES) {
      throw new Error(
        `${LOG} grid_x out of bounds for ${slot.id}: gridX=${gridX} (cx=${slot.cx}); ` +
          `expected [0, ${WORLD_TILES}).`,
      );
    }
    if (!Number.isInteger(gridY) || gridY < 0 || gridY >= WORLD_TILES) {
      throw new Error(
        `${LOG} grid_y out of bounds for ${slot.id}: gridY=${gridY} (cz=${slot.cz}); ` +
          `expected [0, ${WORLD_TILES}).`,
      );
    }

    // Parcel-code uniqueness — the DB UNIQUE(parcel_code) backs this, but assert
    // here so a constant drift is caught in dry-run before connecting.
    if (seenCodes.has(slot.id)) {
      throw new Error(`${LOG} duplicate parcel_code in LAND_PARCELS: ${slot.id}`);
    }
    seenCodes.add(slot.id);

    rows.push({
      parcelCode: slot.id,
      tier: slot.tier,
      gridX,
      gridY,
      priceCt: interpolatePrice(slot.tier, slot.indexInTier, count),
    });
  }

  return rows;
}

/** Per-tier min/max of the seeded `price_ct` (founder reported as NULL). */
function perTierPriceRanges(rows: SeedRow[]): Record<string, string> {
  const acc: Record<string, { min: number; max: number } | 'NULL'> = {};
  for (const r of rows) {
    if (r.priceCt === null) {
      acc[r.tier] = 'NULL';
      continue;
    }
    const cur = acc[r.tier];
    if (cur === undefined || cur === 'NULL') {
      acc[r.tier] = { min: r.priceCt, max: r.priceCt };
    } else {
      cur.min = Math.min(cur.min, r.priceCt);
      cur.max = Math.max(cur.max, r.priceCt);
    }
  }
  const out: Record<string, string> = {};
  for (const [tier, v] of Object.entries(acc)) {
    out[tier] = v === 'NULL' ? 'NULL (founder — auction/USDC only)' : `${v.min} … ${v.max} CT`;
  }
  return out;
}

function printDryRun(rows: SeedRow[]): void {
  console.log(`${LOG} DRY RUN — no env read, no DB connection, no write.`);
  console.log(`${LOG} total rows: ${rows.length} (expected 176)`);

  // 3 sample rows: one founder, one a, one starter.
  const sampleFounder = rows.find((r) => r.tier === 'founder');
  const sampleA = rows.find((r) => r.tier === 'a');
  const sampleStarter = rows.find((r) => r.tier === 'starter');
  const fmt = (r: SeedRow | undefined): string =>
    r
      ? `parcel_code=${r.parcelCode} tier=${r.tier} grid_x=${r.gridX} grid_y=${r.gridY} ` +
        `price_ct=${r.priceCt === null ? 'NULL' : r.priceCt}`
      : '(none)';
  console.log(`${LOG} sample [founder]: ${fmt(sampleFounder)}`);
  console.log(`${LOG} sample [a]:       ${fmt(sampleA)}`);
  console.log(`${LOG} sample [starter]: ${fmt(sampleStarter)}`);

  // Per-tier price ranges.
  const ranges = perTierPriceRanges(rows);
  console.log(`${LOG} per-tier price_ct range (min … max):`);
  for (const tier of Object.keys(ranges)) {
    console.log(`${LOG}   ${tier.padEnd(8)} ${ranges[tier]}`);
  }
  console.log(`${LOG} DRY RUN complete — nothing written.`);
}

async function runSeed(rows: SeedRow[]): Promise<void> {
  const url = process.env.SEED_DATABASE_URL;
  if (!url || url.trim() === '') {
    console.error(
      `${LOG} SEED_DATABASE_URL is not set. Refusing to run a real seed. ` +
        `Set it explicitly to the TARGET Supabase SESSION-pooler URL (:5432). ` +
        `This script does NOT load .env.local and does NOT fall back to ` +
        `DATABASE_URL — explicit-only, to prevent ever seeding the wrong ` +
        `database (the prod-write incident). For a safe preview, run with --dry-run.`,
    );
    process.exit(1);
  }

  // Our OWN postgres client — NEVER the auto-connecting @clawville/database proxy.
  // max:1 serial, prepare:false simple-query, short timeouts to fail fast.
  const client = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    idle_timeout: 10,
  });

  let inserted = 0;
  try {
    // One transaction for all 176 rows. ON CONFLICT (parcel_code) DO NOTHING
    // makes a re-run idempotent. price_ct may be NULL (founder).
    await client.begin(async (sql) => {
      for (const r of rows) {
        const res = await sql`
          INSERT INTO land_parcels (parcel_code, tier, grid_x, grid_y, price_ct)
          VALUES (${r.parcelCode}, ${r.tier}, ${r.gridX}, ${r.gridY}, ${r.priceCt})
          ON CONFLICT (parcel_code) DO NOTHING
        `;
        inserted += res.count;
      }
    });

    const skipped = rows.length - inserted;
    console.log(`${LOG} DONE. inserted=${inserted} skipped(existing)=${skipped} total=${rows.length}`);
  } catch (err) {
    console.error(`${LOG} FAILED while seeding`, err);
    process.exit(1);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  // Build + assert rows FIRST (runs in both modes). A geometry/constant drift
  // throws here, before any DB is touched.
  const rows = buildSeedRows();

  if (rows.length !== 176) {
    throw new Error(`${LOG} expected 176 parcels, built ${rows.length} — geometry drift. Aborting.`);
  }

  if (dryRun) {
    printDryRun(rows);
    return;
  }

  await runSeed(rows);
}

main().catch((err) => {
  console.error(`${LOG} unexpected top-level error`, err);
  process.exit(1);
});
