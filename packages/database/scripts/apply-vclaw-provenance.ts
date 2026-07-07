/**
 * Apply the vCLAW provenance migration (Tokenomics F1) to a target DB.
 *
 * Run from anywhere:
 *   TOKENOMICS_DATABASE_URL="postgres://…" bun packages/database/scripts/apply-vclaw-provenance.ts
 *
 * ── WHY a bespoke env var, not DATABASE_URL ──────────────────────────────────
 * Bun AUTO-LOADS `<cwd>/.env.local`, and the package's index.ts also loads the
 * repo `.env.local` — either could silently inject a PROD `DATABASE_URL`. To make
 * the target DB an EXPLICIT, deliberate choice, this script reads ONLY
 * `TOKENOMICS_DATABASE_URL` (a name nothing auto-populates) and refuses to run if
 * it is missing. It NEVER hardcodes or auto-loads a connection string. This is the
 * "[No Prod URL in env / Bun auto-load]" lesson made mechanical.
 *
 * The migration SQL is idempotent (CREATE TYPE guarded, ADD COLUMN IF NOT EXISTS,
 * a guarded backfill UPDATE, DROP+ADD CHECK) — re-running is safe. The whole file
 * runs as one multi-statement batch via `client.unsafe(fileContents)`; none of the
 * statements are `ALTER TYPE … ADD VALUE`, so a transaction-incompatible split is
 * not required here (the DO-block CREATE TYPE and the rest run fine in sequence).
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
    '[vclaw] TOKENOMICS_DATABASE_URL is not set.\n' +
      '        Set it explicitly to the DB you intend to migrate, e.g.:\n' +
      '          TOKENOMICS_DATABASE_URL="postgres://…staging…" bun packages/database/scripts/apply-vclaw-provenance.ts\n' +
      '        (DATABASE_URL is deliberately NOT used — it auto-loads and could be prod.)',
  );
  process.exit(1);
}

const sqlPath = resolve(SCRIPT_DIR, '../migrations-manual/2026-06-27_vclaw_provenance.sql');
const fullSql = readFileSync(sqlPath, 'utf-8');

// max:1 + prepare:false matches the Supabase transaction-pooler discipline used by
// the package's runtime client (named prepared statements break over the pooler).
const client = postgres(TARGET_URL, { max: 1, prepare: false });

try {
  console.log('[vclaw] Applying provenance migration from', sqlPath);
  await client.unsafe(fullSql);

  // Post-apply verification — prove the columns + enum + constraint landed.
  const cols = await client`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'avatars'
      AND column_name IN ('soft_balance', 'bought_balance', 'earned_balance')
    ORDER BY column_name
  `;
  console.log('[vclaw] avatars tag columns:', cols.map((r) => r.column_name).join(', '));

  const txCols = await client`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'claw_token_transactions'
      AND column_name IN ('provenance', 'usd_basis', 'fp_hash', 'ip_prefix_hash')
    ORDER BY column_name
  `;
  console.log('[vclaw] ledger columns:', txCols.map((r) => r.column_name).join(', '));

  const enumLabels = await client`
    SELECT e.enumlabel
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'claw_token_provenance'
    ORDER BY e.enumsortorder
  `;
  console.log('[vclaw] claw_token_provenance enum:', enumLabels.map((r) => r.enumlabel).join(', '));

  // The sum invariant must hold for EVERY row after the backfill.
  const violations = await client`
    SELECT count(*)::int AS n
    FROM avatars
    WHERE claw_tokens <> soft_balance + bought_balance + earned_balance
  `;
  const n = Number(violations[0]?.n ?? -1);
  if (n !== 0) {
    throw new Error(`[vclaw] POST-BACKFILL INVARIANT VIOLATED: ${n} avatar rows do not satisfy the sum`);
  }
  console.log('[vclaw] sum invariant holds for all rows (0 violations)');

  console.log('[vclaw] ✓ migration applied');
} catch (err) {
  console.error('[vclaw] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
