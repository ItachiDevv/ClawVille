/**
 * Apply the SAP Option C escrow-gate schema (sap_escrow_settlements +
 * sap_escrow_approvals + the lifecycle enum) to a target DB.
 *
 * Run from anywhere:
 *   TOKENOMICS_DATABASE_URL="postgres://…" bun packages/database/scripts/apply-sap-escrow.ts
 *
 * ── WHY a bespoke env var, not DATABASE_URL ──────────────────────────────────
 * Bun AUTO-LOADS `<cwd>/.env.local`, and the package's index.ts also loads the
 * repo `.env.local` — either could silently inject a PROD `DATABASE_URL`. To make
 * the target DB an EXPLICIT, deliberate choice, this script reads ONLY
 * `TOKENOMICS_DATABASE_URL` (a name nothing auto-populates) and refuses to run if
 * it is missing. It NEVER hardcodes or auto-loads a connection string. This is the
 * "[No Prod URL in env / Bun auto-load]" lesson made mechanical (mirrors
 * apply-vclaw-provenance.ts).
 *
 * The migration SQL is fully idempotent (CREATE TYPE guarded + ADD VALUE IF NOT
 * EXISTS, CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) — re-running
 * is safe. The whole file runs as one multi-statement batch via
 * `client.unsafe(fileContents)`. The `ALTER TYPE … ADD VALUE` statements only
 * RECONCILE a pre-existing enum; the new values are not USED in this migration's
 * DDL (defaults use 'open', always present), so no transaction-incompatible
 * same-statement use occurs.
 *
 * PURELY ADDITIVE: two net-new tables + one enum. It NEVER touches an existing
 * table, so it can never drop or rewrite live data.
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// import.meta.dir is Bun-native; fileURLToPath keeps it portable if run via node.
const SCRIPT_DIR =
  (import.meta as unknown as { dir?: string }).dir ??
  dirname(fileURLToPath(import.meta.url));

const TARGET_URL = process.env.TOKENOMICS_DATABASE_URL;
if (!TARGET_URL) {
  console.error(
    '[sap-escrow] TOKENOMICS_DATABASE_URL is not set.\n' +
      '            Set it explicitly to the DB you intend to migrate, e.g.:\n' +
      '              TOKENOMICS_DATABASE_URL="postgres://…staging…" bun packages/database/scripts/apply-sap-escrow.ts\n' +
      '            (DATABASE_URL is deliberately NOT used — it auto-loads and could be prod.)',
  );
  process.exit(1);
}

const sqlPath = resolve(SCRIPT_DIR, '../migrations-manual/2026-06-30_sap_escrow.sql');
const fullSql = readFileSync(sqlPath, 'utf-8');

// max:1 + prepare:false matches the Supabase transaction-pooler discipline used by
// the package's runtime client (named prepared statements break over the pooler).
const client = postgres(TARGET_URL, { max: 1, prepare: false });

try {
  console.log('[sap-escrow] Applying SAP escrow-gate schema from', sqlPath);
  await client.unsafe(fullSql);

  // Post-apply verification — prove both tables + the enum + the key indexes landed.
  const tables = await client`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('sap_escrow_settlements', 'sap_escrow_approvals')
    ORDER BY table_name
  `;
  console.log('[sap-escrow] tables:', tables.map((r) => r.table_name).join(', '));
  if (tables.length !== 2) {
    throw new Error(`[sap-escrow] expected 2 tables, found ${tables.length}`);
  }

  const enumLabels = await client`
    SELECT e.enumlabel
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'sap_escrow_settlement_status'
    ORDER BY e.enumsortorder
  `;
  const labels = enumLabels.map((r) => r.enumlabel);
  console.log('[sap-escrow] sap_escrow_settlement_status enum:', labels.join(', '));
  for (const required of ['refunding', 'funding_unknown']) {
    if (!labels.includes(required)) {
      throw new Error(`[sap-escrow] enum is missing the '${required}' value`);
    }
  }

  // The at-most-once-settle guard MUST exist (the core money invariant).
  const idx = await client`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'sap_escrow_settlements_escrow_job_unique',
        'sap_escrow_approvals_escrow_job_unique'
      )
    ORDER BY indexname
  `;
  console.log('[sap-escrow] unique guards:', idx.map((r) => r.indexname).join(', '));
  if (idx.length !== 2) {
    throw new Error(`[sap-escrow] expected 2 unique guard indexes, found ${idx.length}`);
  }

  // The accounting/recovery columns the security fixes added must be present.
  const cols = await client`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'sap_escrow_settlements'
      AND column_name IN ('max_calls', 'funded_amount', 'released_amount', 'refunded_amount', 'funding_signature')
    ORDER BY column_name
  `;
  console.log('[sap-escrow] accounting/recovery columns:', cols.map((r) => r.column_name).join(', '));
  if (cols.length !== 5) {
    throw new Error(`[sap-escrow] expected 5 accounting/recovery columns, found ${cols.length}`);
  }

  console.log('[sap-escrow] ✓ migration applied');
} catch (err) {
  console.error('[sap-escrow] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
