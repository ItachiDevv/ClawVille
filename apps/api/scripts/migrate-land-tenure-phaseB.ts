/**
 * migrate-land-tenure-phaseB.ts — Phase B grandfather migration (2026-07-07).
 * ============================================================================
 *
 * WHAT THIS DOES (idempotent — safe to re-run)
 * --------------------------------------------
 *   1. DDL (re-asserted, idempotent — the same statements as
 *      packages/database/migrations/0013_land_tenure_phaseB.sql, so this script
 *      is SELF-CONTAINED against a box where 0013 was not applied): the
 *      'deposit'/'hold' tenure values, the 4 land_transaction_kind values, the
 *      land_hold_subject enum, the 5 land_parcels columns, the non-negative
 *      escrow CHECK, and the tenure sweep-index swap. Every ALTER TYPE runs as
 *      its OWN autocommit statement (a new enum value cannot be USED in the
 *      transaction that added it — the partial index below needs them
 *      committed first).
 *   2. GRANDFATHER DML: every legacy buy-outright parcel (tenure='owned',
 *      tier c/b/a/founder) becomes a GRANDFATHERED HOLD —
 *        tenure='hold', grandfathered=true,
 *        hold_threshold_ct = LAND_HOLD_THRESHOLDS_CLV[tier]   (stamped for the
 *          record; a grandfathered hold is NEVER CLV-checked and is EXCLUDED
 *          from every stacked-threshold sum),
 *        hold_subject     = NULL (no CLV subject — never checked),
 *        rent_ct_weekly   = COALESCE(existing, founder → FOUNDER_UPKEEP_CT_WEEKLY)
 *          (c/b/a keep their stamped weekly rent as the upkeep; founder rows
 *          were never rent-laddered so they get the founder upkeep),
 *        rent_paid_through = now() + RENT_PERIOD_DAYS  (a fresh week before the
 *          first upkeep draw — nobody is charged retroactively),
 *        grace_until      = NULL.
 *      Idempotent by construction: the WHERE matches tenure='owned' only, and
 *      the UPDATE sets tenure='hold', so a re-run matches ZERO rows.
 *
 * WHAT THIS DELIBERATELY LEAVES UNTOUCHED (and why)
 * -------------------------------------------------
 *   - tenure='starter' rows: legacy FREE starter claims. They pre-date the
 *     deposit model, escrowed nothing, and the sweeper ignores the 'starter'
 *     tenure entirely — they are effectively grandfathered free parcels. New
 *     claims escrow via tenure='deposit'; converting old ones would either
 *     charge users retroactively (unacceptable) or create deposit rows with a
 *     0 escrow that immediately grace->lapse (wrong). Founder call if they
 *     should ever migrate.
 *   - tenure='rented' rows: the legacy weekly-rent flow still works end-to-end
 *     (sweeper 'rented' branch unchanged); no new rentals can start (route
 *     409s) so the population only shrinks via eviction/natural end.
 *   - tenure='owned' rows with tier='starter' (data anomaly — should not
 *     exist): NOT matched by the tier IN (...) filter; counted + reported by
 *     the dry-run so a human can decide.
 *
 * EXPLICIT-URL-ONLY (the prod-write incident — see seed-land-parcels.ts)
 * ---------------------------------------------------------------------
 *   - DB URL read ONLY from `SEED_DATABASE_URL`. NO fallback to DATABASE_URL,
 *     NO `.env.local` load. This script does NOT import the auto-connecting
 *     `@clawville/database` `db` proxy — it creates its OWN `postgres()` client.
 *   - `@clawville/shared` is imported for the PURE constants only (no DB side
 *     effects at module load).
 *   - The DB URL is a secret: NEVER logged, echoed, or printed.
 *
 * RUN
 * ---
 *   # DRY-RUN IS THE DEFAULT (no args == --dry-run). Without SEED_DATABASE_URL
 *   # it prints the plan and exits 0 (no env read, no connect, no write). With
 *   # SEED_DATABASE_URL set it ALSO does a READ-ONLY per-tier count of the rows
 *   # the apply run would touch. Nothing is ever written in dry-run.
 *   bun apps/api/scripts/migrate-land-tenure-phaseB.ts --dry-run
 *
 *   # Real migration (orchestrator only — explicit URL + explicit --apply,
 *   # STAGING first):
 *   SEED_DATABASE_URL=<target-session-pooler-url> bun apps/api/scripts/migrate-land-tenure-phaseB.ts --apply
 *
 * Use the Supabase SESSION pooler URL (:5432) for DDL safety, never :6543.
 */

import postgres from 'postgres';
import {
  LAND_HOLD_THRESHOLDS_CLV,
  FOUNDER_UPKEEP_CT_WEEKLY,
  RENT_PERIOD_DAYS,
  type LandTier,
} from '@clawville/shared';

const LOG = '[migrate-land-tenure-phaseB]';

/** The tiers the grandfather DML converts (starter stays on its legacy path). */
const HOLD_TIERS: readonly LandTier[] = ['c', 'b', 'a', 'founder'] as const;

function printPlan(): void {
  console.log(`${LOG} PLAN — grandfather legacy buy-outright parcels to Phase-B holds.`);
  console.log(`${LOG} tenure='owned' AND tier IN (${HOLD_TIERS.join(', ')})  →  tenure='hold', grandfathered=true`);
  console.log(`${LOG} per-tier hold_threshold_ct stamped (CLV uiAmount; grandfathered rows are NEVER CLV-checked):`);
  for (const tier of HOLD_TIERS) {
    console.log(`${LOG}   ${tier.padEnd(8)} ${String(LAND_HOLD_THRESHOLDS_CLV[tier])}`);
  }
  console.log(`${LOG} rent_ct_weekly = COALESCE(existing, founder → ${FOUNDER_UPKEEP_CT_WEEKLY})`);
  console.log(`${LOG} rent_paid_through = now() + ${RENT_PERIOD_DAYS} days; grace_until = NULL; hold_subject = NULL`);
  console.log(`${LOG} UNTOUCHED: tenure='starter' (legacy free claims), tenure='rented' (legacy rent flow),`);
  console.log(`${LOG}            tenure IN ('deposit','hold') (already Phase B), anomalous owned/starter rows.`);
}

/** Idempotent DDL — mirrors migrations/0013_land_tenure_phaseB.sql exactly. */
async function applyDdl(client: postgres.Sql): Promise<void> {
  // Each runs in autocommit (no wrapping tx) — required for ALTER TYPE ADD
  // VALUE (the partial index below USES the new values) and safe + idempotent
  // for the rest. Types BEFORE the columns that use them.
  console.log(`${LOG} applying idempotent DDL (mirror of migration 0013)…`);
  await client`ALTER TYPE land_tenure ADD VALUE IF NOT EXISTS 'deposit'`;
  await client`ALTER TYPE land_tenure ADD VALUE IF NOT EXISTS 'hold'`;
  await client`ALTER TYPE land_transaction_kind ADD VALUE IF NOT EXISTS 'land_deposit_escrow'`;
  await client`ALTER TYPE land_transaction_kind ADD VALUE IF NOT EXISTS 'land_deposit_topup'`;
  await client`ALTER TYPE land_transaction_kind ADD VALUE IF NOT EXISTS 'land_deposit_refund'`;
  await client`ALTER TYPE land_transaction_kind ADD VALUE IF NOT EXISTS 'hold_claim'`;
  await client`DO $$ BEGIN CREATE TYPE land_hold_subject AS ENUM ('user','agent'); EXCEPTION WHEN duplicate_object THEN null; END $$;`;
  await client`ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS deposit_ct integer`;
  await client`ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS deposit_remaining_ct integer`;
  await client`ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS hold_threshold_ct integer`;
  await client`ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS hold_subject land_hold_subject`;
  await client`ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS grandfathered boolean NOT NULL DEFAULT false`;
  await client`DO $$ BEGIN
    ALTER TABLE land_parcels ADD CONSTRAINT land_parcels_deposit_remaining_nonneg
      CHECK (deposit_remaining_ct IS NULL OR deposit_remaining_ct >= 0);
  EXCEPTION WHEN duplicate_object THEN null; END $$;`;
  await client`DROP INDEX IF EXISTS land_parcels_rent_sweep_idx`;
  await client`CREATE INDEX IF NOT EXISTS land_parcels_tenure_sweep_idx ON land_parcels (rent_paid_through) WHERE tenure IN ('rented','deposit','hold')`;
  console.log(`${LOG} DDL applied.`);
}

function buildClient(url: string): postgres.Sql {
  return postgres(url, { max: 1, prepare: false, connect_timeout: 15, idle_timeout: 10 });
}

/** READ-ONLY dry-run counts of what the apply run would touch. */
async function dryRunCounts(client: postgres.Sql): Promise<void> {
  const rows = await client<{ tier: string; n: string }[]>`
    SELECT tier::text AS tier, COUNT(*)::text AS n
    FROM land_parcels
    WHERE tenure = 'owned' AND tier IN ('c','b','a','founder')
    GROUP BY tier ORDER BY tier`;
  console.log(`${LOG} DRY RUN (read-only) — rows the apply run WOULD grandfather:`);
  if (rows.length === 0) {
    console.log(`${LOG}   (none — nothing to migrate, or already applied)`);
  } else {
    for (const r of rows) console.log(`${LOG}   ${r.tier.padEnd(8)} ${r.n}`);
  }
  const anomalies = await client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM land_parcels WHERE tenure = 'owned' AND tier = 'starter'`;
  const anomalyCount = Number(anomalies[0]?.n ?? 0);
  if (anomalyCount > 0) {
    console.warn(
      `${LOG} ⚠ ${anomalyCount} anomalous tenure='owned' STARTER row(s) found — deliberately NOT migrated; investigate manually.`,
    );
  }
  console.log(`${LOG} DRY RUN complete — nothing written.`);
}

async function runApply(client: postgres.Sql): Promise<void> {
  await applyDdl(client);

  // ONE set-based idempotent UPDATE — the WHERE stops matching after the first
  // run (tenure flips to 'hold'). Thresholds + upkeep come from the shared
  // constants as BOUND PARAMS (never string-concatenated).
  const rows = await client<{ tier: string }[]>`
    UPDATE land_parcels SET
      tenure = 'hold',
      grandfathered = true,
      hold_threshold_ct = CASE tier
        WHEN 'c' THEN ${LAND_HOLD_THRESHOLDS_CLV.c}
        WHEN 'b' THEN ${LAND_HOLD_THRESHOLDS_CLV.b}
        WHEN 'a' THEN ${LAND_HOLD_THRESHOLDS_CLV.a}
        WHEN 'founder' THEN ${LAND_HOLD_THRESHOLDS_CLV.founder}
        ELSE NULL
      END,
      hold_subject = NULL,
      rent_ct_weekly = COALESCE(rent_ct_weekly, CASE WHEN tier = 'founder' THEN ${FOUNDER_UPKEEP_CT_WEEKLY} END),
      rent_paid_through = now() + make_interval(days => ${RENT_PERIOD_DAYS}),
      grace_until = NULL,
      updated_at = now()
    WHERE tenure = 'owned' AND tier IN ('c','b','a','founder')
    RETURNING tier::text AS tier`;

  const perTier = new Map<string, number>();
  for (const r of rows) perTier.set(r.tier, (perTier.get(r.tier) ?? 0) + 1);
  console.log(`${LOG} DONE — grandfathered ${rows.length} parcel(s) to tenure='hold':`);
  for (const [tier, n] of [...perTier.entries()].sort()) {
    console.log(`${LOG}   ${tier.padEnd(8)} ${n}`);
  }
  if (rows.length === 0) {
    console.log(`${LOG}   (0 rows — already applied or nothing legacy-owned; idempotent no-op)`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  printPlan();

  const url = process.env.SEED_DATABASE_URL;

  if (!apply) {
    // DRY-RUN IS THE DEFAULT. Without a URL: plan only (no connect). With a
    // URL: read-only counts too. Never writes.
    if (!url || url.trim() === '') {
      console.log(`${LOG} DRY RUN (no SEED_DATABASE_URL) — plan printed, no DB connection, nothing written.`);
      console.log(`${LOG} To count affected rows read-only: SEED_DATABASE_URL=<url> bun ... --dry-run`);
      console.log(`${LOG} To apply: SEED_DATABASE_URL=<url> bun ... --apply`);
      return;
    }
    const client = buildClient(url);
    try {
      await dryRunCounts(client);
    } finally {
      await client.end({ timeout: 5 });
    }
    return;
  }

  if (!url || url.trim() === '') {
    console.error(
      `${LOG} SEED_DATABASE_URL is not set. Refusing to run --apply. Set it explicitly to ` +
        `the TARGET Supabase SESSION-pooler URL (:5432). This script does NOT load ` +
        `.env.local and does NOT fall back to DATABASE_URL. For a safe preview run --dry-run.`,
    );
    process.exit(1);
  }

  const client = buildClient(url);
  try {
    await runApply(client);
  } catch (err) {
    console.error(`${LOG} FAILED`, err);
    process.exit(1);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`${LOG} unexpected top-level error`, err);
  process.exit(1);
});
