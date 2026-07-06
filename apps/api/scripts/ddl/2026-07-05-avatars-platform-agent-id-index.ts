/**
 * 2026-07-05-avatars-platform-agent-id-index.ts — P3 slice-3 (D6) additive index.
 * ============================================================================
 *
 * WHAT THIS DOES (idempotent, additive — safe to re-run)
 * ------------------------------------------------------
 *   Creates the partial index backing the D6 connected-session exemption lookup
 *   (`agent-orchestrator.ts agentBacksLiveConnectedSession`), which the 30-min
 *   inactivity sweep runs per candidate runtime to decide whether a hosted
 *   runtime backs a LIVE connected agent session — it filters `avatars` by
 *   `platform_agent_id`:
 *
 *     CREATE INDEX IF NOT EXISTS idx_avatars_platform_agent_id
 *       ON avatars (platform_agent_id) WHERE platform_agent_id IS NOT NULL;
 *
 *   `IF NOT EXISTS` makes a re-run a no-op. The partial predicate keeps the
 *   index small (only provisioned avatars carry a platform_agent_id) and matches
 *   the query's `avatars.platform_agent_id = $1` leg (then it joins
 *   openclaw_bots on the owner to check for a live session). Without it the sweep
 *   would seq-scan `avatars` every 5 minutes per running non-system/non-house
 *   agent.
 *
 * EXPLICIT-URL-ONLY (the prod-write incident — see seed-land-parcels.ts)
 * ---------------------------------------------------------------------
 *   - DB URL read ONLY from `DDL_DATABASE_URL`. NO fallback to `DATABASE_URL`,
 *     NO `.env.local` load. Bun auto-loads `<cwd>/.env.local`, but that only
 *     ever sets `DATABASE_URL` — we read a DIFFERENT var and refuse if it is
 *     unset, so an auto-loaded `.env.local` can never silently target prod.
 *   - Does NOT import the auto-connecting `@clawville/database` `db` proxy — it
 *     creates its OWN `postgres()` client (like migrate-land-tenure.ts).
 *   - The DB URL is a secret: NEVER logged, echoed, or printed.
 *
 * RUN (orchestrator only — STAGING first, prod at promote; NEVER db:push)
 * ----------------------------------------------------------------------
 *   # Preview the exact DDL (no env, no connect, no write):
 *   bun apps/api/scripts/ddl/2026-07-05-avatars-platform-agent-id-index.ts --dry-run
 *
 *   # Apply (explicit URL required — Supabase SESSION-pooler :5432 for DDL):
 *   DDL_DATABASE_URL=<target-session-pooler-url> \
 *     bun apps/api/scripts/ddl/2026-07-05-avatars-platform-agent-id-index.ts
 *
 *   NOTE: `avatars` is small (one row per user), so a plain CREATE INDEX is fine
 *   here — no CONCURRENTLY dance needed (unlike the large `events` table).
 */

import postgres from 'postgres';

const LOG = '[ddl:avatars-platform-agent-id-index]';

const DDL =
  'CREATE INDEX IF NOT EXISTS idx_avatars_platform_agent_id ON avatars (platform_agent_id) WHERE platform_agent_id IS NOT NULL';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log(`${LOG} DRY RUN — no env read, no DB connection, no write. Would run:`);
    console.log(`${LOG}   ${DDL};`);
    console.log(`${LOG} DRY RUN complete — nothing written.`);
    return;
  }

  const url = process.env.DDL_DATABASE_URL;
  if (!url || url.trim() === '') {
    console.error(
      `${LOG} DDL_DATABASE_URL is not set. Refusing to run. Set it explicitly to the ` +
        `TARGET Supabase SESSION-pooler URL (:5432). This script does NOT load .env.local ` +
        `and does NOT fall back to DATABASE_URL. Preview with --dry-run.`,
    );
    process.exit(1);
  }

  const client = postgres(url, { max: 1, prepare: false, connect_timeout: 15, idle_timeout: 10 });
  try {
    console.log(`${LOG} applying idempotent index (IF NOT EXISTS)…`);
    await client.unsafe(DDL);
    console.log(`${LOG} DONE.`);
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
