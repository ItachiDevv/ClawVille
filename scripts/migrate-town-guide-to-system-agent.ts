/**
 * One-off backfill: migrate pre-existing `town-guide` platform_agents rows to
 * the generalized `system-agent` shape used by `ensureSystemAgents()`.
 *
 * Before: rows were identified by `type='town-guide'` + `name=townGuide.name`.
 * After : rows are identified by `type='system-agent'` + `customization.slug='town-guide'`.
 *
 * This script is IDEMPOTENT — it only touches rows that still carry the
 * legacy `type='town-guide'` value. Safe to run multiple times. Exits 0 on
 * success (including "nothing to migrate") and non-zero on any DB error.
 *
 * Run via the Hetzner tinker pattern:
 *
 *   # PROD (post-2026-05-23 migration: uses ~/.ssh/clawville_hillsboro via ssh-agent)
 *   ssh root@<PROD_VPS_IP> \
 *     "docker exec -e DATABASE_URL='...' api-container-name \
 *       bun run /app/scripts/migrate-town-guide-to-system-agent.ts"
 *   # STAGING uses `-i ~/.ssh/clawville_deploy root@<STAGING_VPS_IP>`.
 *
 * Or locally against prod DB with a one-off session:
 *
 *   DATABASE_URL='postgres://...' bun run scripts/migrate-town-guide-to-system-agent.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import pkg from 'pg';
const { Client } = pkg;

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[migrate] DATABASE_URL not set — refusing to run');
  process.exit(1);
}

const client = new Client({ connectionString: dbUrl });

async function main() {
  await client.connect();
  console.log('[migrate] connected to', dbUrl?.slice(0, 40), '...');

  // Idempotency check — only rows that still have the legacy type
  const existing = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM platform_agents WHERE type = 'town-guide'`,
  );
  const pendingRows = parseInt(existing.rows[0]?.count ?? '0', 10);
  console.log(`[migrate] found ${pendingRows} row(s) still on type='town-guide'`);

  if (pendingRows === 0) {
    console.log('[migrate] nothing to migrate — exiting 0');
    await client.end();
    return;
  }

  // Update in place: set type + merge {slug:'town-guide'} into customization
  // COALESCE handles the case where customization is NULL.
  const result = await client.query(
    `
      UPDATE platform_agents
      SET
        type = 'system-agent',
        customization = COALESCE(customization, '{}'::jsonb) || jsonb_build_object('slug', 'town-guide'),
        updated_at = now()
      WHERE type = 'town-guide'
      RETURNING id, name, user_id
    `,
  );

  console.log(`[migrate] migrated ${result.rowCount} row(s):`);
  for (const row of result.rows) {
    console.log(`  - ${row.id} (${row.name}) owner=${row.user_id}`);
  }

  // Verify — after update there should be zero rows left on legacy type
  const after = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM platform_agents WHERE type = 'town-guide'`,
  );
  const leftover = parseInt(after.rows[0]?.count ?? '0', 10);
  if (leftover !== 0) {
    console.error(`[migrate] VERIFY FAILED — ${leftover} row(s) still legacy, aborting`);
    await client.end();
    process.exit(2);
  }

  console.log('[migrate] verify ok — all town-guide rows migrated to system-agent');
  await client.end();
}

main().catch(async (err) => {
  console.error('[migrate] FATAL:', err?.message ?? err);
  try {
    await client.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
