/**
 * Apply the agent-metaverse P1 `openclaw_bots.is_house` column (one additive,
 * idempotent boolean) to a target DB.
 *
 * Run from anywhere:
 *   AGENTS_DATABASE_URL="postgres://…" bun packages/database/scripts/apply-openclaw-is-house.ts
 *
 * ── WHY a bespoke env var, not DATABASE_URL ──────────────────────────────────
 * Bun AUTO-LOADS `<cwd>/.env.local`, and the package's index.ts also loads the
 * repo `.env.local` — either could silently inject a PROD `DATABASE_URL`. To make
 * the target DB an EXPLICIT, deliberate choice, this script reads ONLY
 * `AGENTS_DATABASE_URL` (a name nothing auto-populates, shared with the sibling
 * agent-metaverse migration `apply-platform-agents-openclaw-bot-singleton.ts`) and
 * refuses to run if it is missing. It NEVER hardcodes or auto-loads a connection
 * string. This is the "[No Prod URL in env / Bun auto-load]" lesson made
 * mechanical (mirrors apply-bounty-escrow-linkage.ts / apply-sap-escrow.ts).
 *
 * The migration SQL is fully idempotent (`ADD COLUMN IF NOT EXISTS`) — re-running
 * is safe. PURELY ADDITIVE: it only ADDs one boolean column (NOT NULL DEFAULT
 * false) to the EXISTING `openclaw_bots` table, so it can never drop or rewrite
 * live data. NOT run via `db:push` — that is `drizzle-kit push --force`
 * (silently destructive on a shared/partial-schema branch); this deterministic
 * script is the safe apply path.
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
    '[oc-is-house] AGENTS_DATABASE_URL is not set.\n' +
      '              Set it explicitly to the DB you intend to migrate, e.g.:\n' +
      '                AGENTS_DATABASE_URL="postgres://…staging…" bun packages/database/scripts/apply-openclaw-is-house.ts\n' +
      '              (DATABASE_URL is deliberately NOT used — it auto-loads and could be prod.)',
  );
  process.exit(1);
}

const sqlPath = resolve(
  SCRIPT_DIR,
  '../migrations-manual/2026-07-01_add_openclaw_is_house.sql',
);
const fullSql = readFileSync(sqlPath, 'utf-8');

// max:1 + prepare:false matches the Supabase transaction-pooler discipline used by
// the package's runtime client (named prepared statements break over the pooler).
const client = postgres(TARGET_URL, { max: 1, prepare: false });

try {
  console.log('[oc-is-house] Applying openclaw_bots.is_house column from', sqlPath);
  await client.unsafe(fullSql);

  // Post-apply verification — prove the column landed with the expected shape.
  const cols = await client`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'openclaw_bots'
      AND column_name = 'is_house'
  `;
  if (cols.length !== 1) {
    throw new Error('[oc-is-house] is_house column NOT present after apply');
  }
  const col = cols[0];
  console.log(
    `[oc-is-house] openclaw_bots.is_house: type=${col.data_type} nullable=${col.is_nullable} default=${col.column_default}`,
  );
  if (col.is_nullable !== 'NO') {
    console.warn(
      '[oc-is-house] ⚠ is_house is nullable — expected NOT NULL. A pre-existing ' +
        'column may differ from the schema; reconcile before relying on the seeder.',
    );
  }

  console.log('[oc-is-house] ✓ migration applied');
} catch (err) {
  console.error('[oc-is-house] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
