/**
 * Apply the bounty ↔ SAP USDC escrow linkage + verdict columns (one enum + eight
 * additive columns on the EXISTING `bounties` table) to a target DB.
 *
 * Run from anywhere:
 *   TOKENOMICS_DATABASE_URL="postgres://…" bun packages/database/scripts/apply-bounty-escrow-linkage.ts
 *
 * ── WHY a bespoke env var, not DATABASE_URL ──────────────────────────────────
 * Bun AUTO-LOADS `<cwd>/.env.local`, and the package's index.ts also loads the
 * repo `.env.local` — either could silently inject a PROD `DATABASE_URL`. To make
 * the target DB an EXPLICIT, deliberate choice, this script reads ONLY
 * `TOKENOMICS_DATABASE_URL` (a name nothing auto-populates) and refuses to run if
 * it is missing. It NEVER hardcodes or auto-loads a connection string. This is the
 * "[No Prod URL in env / Bun auto-load]" lesson made mechanical (mirrors
 * apply-sap-escrow.ts).
 *
 * The migration SQL is fully idempotent (CREATE TYPE guarded + ADD COLUMN IF NOT
 * EXISTS) — re-running is safe. PURELY ADDITIVE: it only ADDs columns/enum/index
 * to an existing table, so it can never drop or rewrite live data.
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
    '[bounty-escrow] TOKENOMICS_DATABASE_URL is not set.\n' +
      '               Set it explicitly to the DB you intend to migrate, e.g.:\n' +
      '                 TOKENOMICS_DATABASE_URL="postgres://…staging…" bun packages/database/scripts/apply-bounty-escrow-linkage.ts\n' +
      '               (DATABASE_URL is deliberately NOT used — it auto-loads and could be prod.)',
  );
  process.exit(1);
}

const sqlPath = resolve(
  SCRIPT_DIR,
  '../migrations-manual/2026-06-30_bounty_escrow_linkage.sql',
);
const fullSql = readFileSync(sqlPath, 'utf-8');

// max:1 + prepare:false matches the Supabase transaction-pooler discipline used by
// the package's runtime client (named prepared statements break over the pooler).
const client = postgres(TARGET_URL, { max: 1, prepare: false });

try {
  console.log('[bounty-escrow] Applying bounty↔escrow linkage schema from', sqlPath);
  await client.unsafe(fullSql);

  // Post-apply verification — prove the enum + all eight columns landed.
  const enumLabels = await client`
    SELECT e.enumlabel
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'bounty_payment_rail'
    ORDER BY e.enumsortorder
  `;
  const labels = enumLabels.map((r) => r.enumlabel);
  console.log('[bounty-escrow] bounty_payment_rail enum:', labels.join(', '));
  for (const required of ['ct', 'usdc']) {
    if (!labels.includes(required)) {
      throw new Error(`[bounty-escrow] enum is missing the '${required}' value`);
    }
  }

  const cols = await client`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'bounties'
      AND column_name IN (
        'acceptance_criteria',
        'payment_rail',
        'escrow_pda',
        'escrow_job_id',
        'covenant_audit_root_hex',
        'covenant_verification_passed',
        'covenant_verdict_id',
        'verdict_required'
      )
    ORDER BY column_name
  `;
  const colNames = cols.map((r) => r.column_name);
  console.log('[bounty-escrow] added columns:', colNames.join(', '));
  if (colNames.length !== 8) {
    throw new Error(`[bounty-escrow] expected 8 columns, found ${colNames.length}`);
  }

  console.log('[bounty-escrow] ✓ migration applied');
} catch (err) {
  console.error('[bounty-escrow] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
