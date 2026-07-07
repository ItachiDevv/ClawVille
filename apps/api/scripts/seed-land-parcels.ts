/**
 * seed-land-parcels.ts — Land primary-sale + Phase-B hold-tier supply seed.
 * ============================================================================
 *
 * WHAT THIS DOES (idempotent — safe to re-run)
 * --------------------------------------------
 * Inserts one `land_parcels` row per parcel across TWO sources:
 *   1. The FROZEN geometry constant `LAND_PARCELS` — 56 render-backed parcels
 *      (10 founder + 26 starter + 20 c; the 3-ring layout after the 576->704
 *      world grow added the outer c ring; a/b are 0 in `PARCEL_TIER_COUNTS`).
 *   2. The Phase-B HOLD-tier inventory — 12 b + 6 a parcels generated via the
 *      SHARED `generateParcelsForTier(tier, count)` helper at a seed-only count
 *      (2026-07-07). `PARCEL_TIER_COUNTS` a/b STAY 0, so `LAND_PARCELS` and the
 *      3D render are UNTOUCHED — these 18 rows are pure DB economic inventory
 *      claimable via `POST /api/land/parcels/:id/claim-hold` (CLV hold-to-keep).
 *      They use the IDENTICAL square-perimeter formula as founder/starter/c, so
 *      their grid cells land on the same convention (and `buildSeedRows` asserts
 *      they are disjoint from every render-backed cell — a `land_parcels_grid_
 *      unique` collision fails LOUD in dry-run before any DB is touched).
 *
 * Each row stamps `parcel_code`, `tier`, `grid_x`, `grid_y`, `price_ct` (the
 * per-row primary-sale price interpolated from `LAND_TIER_LADDER`) AND
 * `rent_ct_weekly` (interpolated from `LAND_RENT_LADDER` — the weekly upkeep the
 * land-rent-sweeper draws; `claim-hold` reads this for c/b/a/founder holds).
 * NULL rent for starter/founder (not laddered). All other columns take schema
 * defaults (status 'available', tenure NULL, rake_bps 0, timestamps now()).
 * Idempotent: `ON CONFLICT (parcel_code) DO NOTHING`, so a re-run never
 * duplicates or reprices/re-rents an existing parcel.
 *
 * NOTE on price_ct + Phase B: c/b/a/founder BUY is retired (409
 * `tenure_model_active`); `claim-hold` never reads `price_ct`. It is stamped
 * anyway for row-shape parity with the pre-Phase-B seed (and in case a tier ever
 * re-enables a buy path). The LIVE value for a hold parcel is `rent_ct_weekly`.
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
 *   - `@clawville/shared` is imported for the geometry + ladder constants + the
 *     pure `generateParcelsForTier` helper. Those modules (`land-parcels.ts`,
 *     `land-economy.ts`, `land-tiers.ts`) are PURE — they import only from each
 *     other, never touch a DB, and have no side effects at module load — so
 *     importing them cannot trigger a connection.
 *   - SECURITY: the DB URL is a secret. This script NEVER logs, echoes, or
 *     prints it — not the full URL, not the host, not the credentials
 *     (mirrors migrate-ci.ts).
 *
 * RUN
 * ---
 *   # Dry-run (DEFAULT-SAFE — no env, no connect, no write). Prints the rows it
 *   # WOULD insert + samples + per-tier price/rent ranges. This is the verify step.
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
  LAND_RENT_LADDER,
  PARCEL_TIER_COUNTS,
  TOTAL_PARCEL_SUPPLY,
  generateParcelsForTier,
  type LandTier,
  type ParcelSlot,
} from '@clawville/shared';

const LOG = '[seed-land-parcels]';

// ---------------------------------------------------------------------------
// Grid-coord constants — MUST match `parcelToTileZone` in
// `packages/shared/src/constants/land-parcels.ts` so the seeded grid_x/grid_y
// land in the SAME tile cells the world/minimap renders the parcels at. There
// it computes `HALF_MAP_WU = (704 / 2) * TILE_SIZE = 11264` and
// `tileX = floor((cx + HALF_MAP_WU) / TILE_SIZE)`. We deliberately re-derive
// the two literals here (NOT import a web tilemap module) so this script has no
// dep beyond the pure `@clawville/shared` constants. World grid = 704x704 tiles
// (grown 576->704 2026-06-24 for the outer c ring; the new c-parcels reach cx up
// to 9760wu -> gridX floor((9760+11264)/32)=657 < 704, in-bounds).
// ---------------------------------------------------------------------------
const TILE_SIZE = 32; // wu per tile (== TILE_SIZE in land-parcels.ts)
const HALF_MAP_WU = (704 / 2) * TILE_SIZE; // 11264 wu — grid half-width
const WORLD_TILES = 704; // grid is WORLD_TILES x WORLD_TILES tiles

// ---------------------------------------------------------------------------
// Phase-B hold-tier seed inventory (2026-07-07). The a/b bands exist in the tier
// contract but are seeded at 0 in PARCEL_TIER_COUNTS (render supply). Phase B's
// CLV hold-to-keep needs claimable B/A supply, so we seed b/a HERE via the shared
// `generateParcelsForTier` helper — WITHOUT touching PARCEL_TIER_COUNTS (render
// stays untouched). Counts from tokenomics MODEL §M3 ("~12 B, ~6 A").
// generateParcelsForTier uses the frozen TIER_CONFIG a/b half-side anchors
// (a=200t, b=224t) + the same perimeter walk, so positions are convention-
// consistent; buildSeedRows asserts their grid cells are disjoint from the 56.
// ---------------------------------------------------------------------------
const BA_SEED_PLAN: readonly { tier: Extract<LandTier, 'a' | 'b'>; count: number }[] = [
  { tier: 'b', count: 12 },
  { tier: 'a', count: 6 },
] as const;
const BA_SEED_COUNT = BA_SEED_PLAN.reduce((n, p) => n + p.count, 0); // 18
const EXPECTED_TOTAL = TOTAL_PARCEL_SUPPLY + BA_SEED_COUNT; // 56 + 18 = 74

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
  /** Weekly upkeep/rent CT (the sweeper draws it; claim-hold reads it). `null` for starter/founder. */
  rentCtWeekly: number | null;
}

/**
 * Interpolate a per-parcel value from a tier band. RAMP: innermost parcel in a
 * tier (indexInTier 0) = `maxCt`, outermost (indexInTier N-1) = `minCt`, linear
 * across the tier's count N.
 *   - N > 1: `round(maxCt - (maxCt - minCt) * indexInTier / (N - 1))`
 *   - N == 1: `maxCt`
 *   - null band (founder price; starter/founder rent) → `null` (SQL NULL, not 0).
 * Identical math to `migrate-land-tenure.ts`'s `interpolate`, shared by the buy
 * AND rent ladders so they ramp the same way.
 *
 * NOTE on starter price: its ladder is `{minCt:0, maxCt:1500}`, so index 0 = 1500
 * … last index = 0. A 0-priced starter row is FINE — "first starter claim is
 * FREE" is enforced by the route (now a deposit-escrow claim, Phase B1), not by
 * a 0-priced row. The seed just stamps the interpolated ladder value.
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

/**
 * Build all seed rows (74 = 56 render-backed + 18 b/a hold-tier) in
 * deterministic order. Asserts grid bounds, parcel-code uniqueness, AND grid-
 * cell uniqueness across ALL rows (the b/a rows must not collide with any
 * render-backed cell — the `land_parcels_grid_unique` DB index backs this, but
 * assert here so a geometry/constant drift fails LOUD in dry-run first).
 */
function buildSeedRows(): SeedRow[] {
  const rows: SeedRow[] = [];
  const seenCodes = new Set<string>();
  const seenCells = new Set<string>();

  // (1) render-backed supply from the frozen generator (count = PARCEL_TIER_COUNTS),
  // then (2) the b/a hold-tier inventory via the SAME per-tier generator at the
  // seed-only BA_SEED_PLAN counts. `count` rides each slot for the price/rent ramp.
  const planned: { slot: ParcelSlot; count: number }[] = [
    ...LAND_PARCELS.map((slot) => ({ slot, count: PARCEL_TIER_COUNTS[slot.tier] })),
    ...BA_SEED_PLAN.flatMap((p) =>
      generateParcelsForTier(p.tier, p.count).map((slot) => ({ slot, count: p.count })),
    ),
  ];

  for (const { slot, count } of planned) {
    const gridX = Math.floor((slot.cx + HALF_MAP_WU) / TILE_SIZE);
    const gridY = Math.floor((slot.cz + HALF_MAP_WU) / TILE_SIZE);

    // Grid sanity — every cell must sit inside the 704x704 world grid.
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
      throw new Error(`${LOG} duplicate parcel_code: ${slot.id}`);
    }
    seenCodes.add(slot.id);

    // Grid-cell uniqueness across ALL rows — the `land_parcels_grid_unique`
    // index backs this; assert so a b/a-vs-render (or b-vs-a) collision fails
    // LOUD in dry-run rather than aborting the INSERT tx.
    const cellKey = `${gridX},${gridY}`;
    if (seenCells.has(cellKey)) {
      throw new Error(
        `${LOG} grid cell ${cellKey} collision at ${slot.id} — would violate ` +
          `land_parcels_grid_unique. Geometry drift (check the a/b half-side anchors).`,
      );
    }
    seenCells.add(cellKey);

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

/** Per-tier min/max of a seeded numeric column (founder/null reported as NULL). */
function perTierRanges(rows: SeedRow[], key: 'priceCt' | 'rentCtWeekly'): Record<string, string> {
  const acc: Record<string, { min: number; max: number } | 'NULL'> = {};
  for (const r of rows) {
    const v = r[key];
    if (v === null) {
      if (acc[r.tier] === undefined) acc[r.tier] = 'NULL';
      continue;
    }
    const cur = acc[r.tier];
    if (cur === undefined || cur === 'NULL') {
      acc[r.tier] = { min: v, max: v };
    } else {
      cur.min = Math.min(cur.min, v);
      cur.max = Math.max(cur.max, v);
    }
  }
  const out: Record<string, string> = {};
  for (const [tier, v] of Object.entries(acc)) {
    out[tier] = v === 'NULL' ? 'NULL' : `${v.min} … ${v.max} CT`;
  }
  return out;
}

function printDryRun(rows: SeedRow[]): void {
  console.log(`${LOG} DRY RUN — no env read, no DB connection, no write.`);
  console.log(
    `${LOG} total rows: ${rows.length} (expected ${EXPECTED_TOTAL} = ${TOTAL_PARCEL_SUPPLY} render-backed + ${BA_SEED_COUNT} b/a hold-tier)`,
  );

  const fmt = (r: SeedRow | undefined): string =>
    r
      ? `parcel_code=${r.parcelCode} tier=${r.tier} grid=(${r.gridX},${r.gridY}) ` +
        `price_ct=${r.priceCt === null ? 'NULL' : r.priceCt} rent_ct_weekly=${r.rentCtWeekly === null ? 'NULL' : r.rentCtWeekly}`
      : '(none)';
  for (const t of ['founder', 'starter', 'c', 'b', 'a'] as const) {
    console.log(`${LOG} sample [${t.padEnd(7)}]: ${fmt(rows.find((r) => r.tier === t))}`);
  }

  const priceRanges = perTierRanges(rows, 'priceCt');
  const rentRanges = perTierRanges(rows, 'rentCtWeekly');
  console.log(`${LOG} per-tier price_ct range (min … max):`);
  for (const tier of Object.keys(priceRanges)) console.log(`${LOG}   ${tier.padEnd(8)} ${priceRanges[tier]}`);
  console.log(`${LOG} per-tier rent_ct_weekly range (min … max):`);
  for (const tier of Object.keys(rentRanges)) console.log(`${LOG}   ${tier.padEnd(8)} ${rentRanges[tier]}`);
  console.log(`${LOG} bounds + parcel-code + grid-cell uniqueness asserted OK. DRY RUN complete — nothing written.`);
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
    // One transaction for all rows. ON CONFLICT (parcel_code) DO NOTHING makes a
    // re-run idempotent. price_ct/rent_ct_weekly may be NULL (founder/starter).
    await client.begin(async (sql) => {
      for (const r of rows) {
        const res = await sql`
          INSERT INTO land_parcels (parcel_code, tier, grid_x, grid_y, price_ct, rent_ct_weekly)
          VALUES (${r.parcelCode}, ${r.tier}, ${r.gridX}, ${r.gridY}, ${r.priceCt}, ${r.rentCtWeekly})
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

  // Build + assert rows FIRST (runs in both modes). A geometry/constant drift or
  // a b/a grid collision throws here, before any DB is touched.
  const rows = buildSeedRows();

  if (rows.length !== EXPECTED_TOTAL) {
    throw new Error(`${LOG} expected ${EXPECTED_TOTAL} parcels, built ${rows.length} — geometry drift. Aborting.`);
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
