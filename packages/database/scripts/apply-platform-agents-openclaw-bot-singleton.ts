/**
 * Apply the R3 partial unique index that de-duplicates openclaw-bot rows in
 * `platform_agents` (agent-metaverse P1 RELIABILITY). Runs the pre-index dedupe
 * DELETE + `CREATE UNIQUE INDEX IF NOT EXISTS platform_agents_openclaw_bot_singleton`.
 *
 * Run from anywhere:
 *   AGENTS_DATABASE_URL="postgres://…" bun packages/database/scripts/apply-platform-agents-openclaw-bot-singleton.ts
 *
 * ── WHY a bespoke env var, not DATABASE_URL ──────────────────────────────────
 * Bun AUTO-LOADS `<cwd>/.env.local`, and the package's index.ts also loads the repo
 * `.env.local` — either could silently inject a PROD `DATABASE_URL`. To make the
 * target DB an EXPLICIT, deliberate choice, this script reads ONLY
 * `AGENTS_DATABASE_URL` (a name nothing auto-populates) and refuses to run if it is
 * missing. It NEVER hardcodes or auto-loads a connection string. This is the
 * "[No Prod URL in env / Bun auto-load]" lesson made mechanical (mirrors
 * apply-bounty-escrow-linkage.ts / apply-sap-escrow.ts).
 *
 * The migration SQL is fully idempotent: the dedupe DELETE is a no-op once deduped
 * and the index is CREATE UNIQUE INDEX IF NOT EXISTS — re-running is safe. It only
 * DELETEs duplicate rows (keeping the earliest per bot) and ADDs an index, so it
 * never rewrites surviving data.
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// import.meta.dir is Bun-native; fileURLToPath keeps it portable if run via node.
const SCRIPT_DIR =
  (import.meta as unknown as { dir?: string }).dir ??
  dirname(fileURLToPath(import.meta.url));

const TARGET_URL = process.env.AGENTS_DATABASE_URL;
if (!TARGET_URL) {
  console.error(
    '[oc-bot-singleton] AGENTS_DATABASE_URL is not set.\n' +
      '                  Set it explicitly to the DB you intend to migrate, e.g.:\n' +
      '                    AGENTS_DATABASE_URL="postgres://…staging…" bun packages/database/scripts/apply-platform-agents-openclaw-bot-singleton.ts\n' +
      '                  (DATABASE_URL is deliberately NOT used — it auto-loads and could be prod.)',
  );
  process.exit(1);
}

const sqlPath = resolve(
  SCRIPT_DIR,
  '../migrations-manual/2026-07-02_platform_agents_openclaw_bot_singleton.sql',
);
const fullSql = readFileSync(sqlPath, 'utf-8');

// max:1 + prepare:false matches the Supabase transaction-pooler discipline used by
// the package's runtime client (named prepared statements break over the pooler).
const client = postgres(TARGET_URL, { max: 1, prepare: false });

try {
  console.log('[oc-bot-singleton] Applying openclaw-bot singleton index from', sqlPath);
  await client.unsafe(fullSql);

  // Post-apply verification — prove the partial unique index landed.
  const idx = await client`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'platform_agents_openclaw_bot_singleton'
  `;
  if (idx.length !== 1) {
    throw new Error(
      '[oc-bot-singleton] index platform_agents_openclaw_bot_singleton NOT present after apply',
    );
  }
  console.log('[oc-bot-singleton] partial unique index present: platform_agents_openclaw_bot_singleton');

  // Sanity: no remaining duplicate openclaw-bot rows per (user_id, openclawBotId).
  const dups = await client`
    SELECT user_id, (config->>'openclawBotId') AS bot_id, COUNT(*) AS n
    FROM platform_agents
    WHERE type = 'openclaw-bot'
      AND (config->>'openclawBotId') IS NOT NULL
    GROUP BY user_id, (config->>'openclawBotId')
    HAVING COUNT(*) > 1
  `;
  if (dups.length > 0) {
    // Should be impossible once the unique index exists, but report loudly if so.
    throw new Error(
      `[oc-bot-singleton] ${dups.length} duplicate (user_id, openclawBotId) group(s) still present — reconcile and re-run`,
    );
  }
  console.log('[oc-bot-singleton] no duplicate openclaw-bot rows remain');

  console.log('[oc-bot-singleton] ✓ migration applied');
} catch (err) {
  console.error('[oc-bot-singleton] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
