/**
 * Apply the Cove Hold'em Increment 1b resync/replay idempotency columns (two
 * additive columns + one partial unique index on the EXISTING `holdem_hands` /
 * `holdem_tables` tables) to a target DB.
 *
 * Run from anywhere:
 *   HOLDEM_1B_DATABASE_URL="postgres://…" bun packages/database/scripts/apply-holdem-1b-columns.ts
 *
 * ── WHY a bespoke env var, not DATABASE_URL ──────────────────────────────────
 * Bun AUTO-LOADS `<cwd>/.env.local`, and the package's index.ts also loads the
 * repo `.env.local` — either could silently inject a PROD `DATABASE_URL`. To make
 * the target DB an EXPLICIT, deliberate choice, this script reads ONLY
 * `HOLDEM_1B_DATABASE_URL` (a name nothing auto-populates) and refuses to run if
 * it is missing. It NEVER hardcodes or auto-loads a connection string. This is the
 * "[No Prod URL in env / Bun auto-load]" lesson made mechanical (mirrors
 * apply-bounty-escrow-linkage.ts / apply-sap-escrow.ts).
 *
 * The migration SQL is fully idempotent (ADD COLUMN IF NOT EXISTS + CREATE
 * UNIQUE INDEX IF NOT EXISTS) — re-running is safe. PURELY ADDITIVE: it only
 * ADDs columns/an index to existing tables, so it can never drop or rewrite
 * live data.
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// import.meta.dir is Bun-native; fileURLToPath keeps it portable if run via node.
const SCRIPT_DIR =
  (import.meta as unknown as { dir?: string }).dir ??
  dirname(fileURLToPath(import.meta.url));

const TARGET_URL = process.env.HOLDEM_1B_DATABASE_URL;
if (!TARGET_URL) {
  console.error(
    '[holdem-1b-columns] HOLDEM_1B_DATABASE_URL is not set.\n' +
      '               Set it explicitly to the DB you intend to migrate, e.g.:\n' +
      '                 HOLDEM_1B_DATABASE_URL="postgres://…staging…" bun packages/database/scripts/apply-holdem-1b-columns.ts\n' +
      '               (DATABASE_URL is deliberately NOT used — it auto-loads and could be prod.)',
  );
  process.exit(1);
}

const sqlPath = resolve(
  SCRIPT_DIR,
  '../migrations-manual/2026-07-03_holdem_1b_columns.sql',
);
const fullSql = readFileSync(sqlPath, 'utf-8');

// max:1 + prepare:false matches the Supabase transaction-pooler discipline used by
// the package's runtime client (named prepared statements break over the pooler).
const client = postgres(TARGET_URL, { max: 1, prepare: false });

try {
  console.log('[holdem-1b-columns] Applying Hold\'em 1b columns from', sqlPath);
  await client.unsafe(fullSql);

  // Post-apply verification — prove both columns + the index landed.
  const cols = await client`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE (table_name = 'holdem_hands' AND column_name = 'deal_idempotency_key')
       OR (table_name = 'holdem_tables' AND column_name = 'cash_out')
    ORDER BY table_name, column_name
  `;
  console.log(
    '[holdem-1b-columns] columns present:',
    cols.map((r) => `${r.table_name}.${r.column_name}`).join(', ') || '(none)',
  );
  if (cols.length !== 2) {
    throw new Error(`[holdem-1b-columns] expected 2 columns, found ${cols.length}`);
  }

  const idx = await client`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'holdem_hands_table_deal_idem_unique'
  `;
  if (idx.length !== 1) {
    throw new Error('[holdem-1b-columns] holdem_hands_table_deal_idem_unique index NOT present');
  }
  console.log('[holdem-1b-columns] partial unique index: present');

  console.log('[holdem-1b-columns] ✓ migration applied');
} catch (err) {
  console.error('[holdem-1b-columns] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
