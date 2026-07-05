/**
 * Apply the poker MTT entrant-placement UNIQUE partial index (Codex gate 2026-07-04)
 * to a target DB — the DB-level primary defense against a duplicate `placement` within
 * a tournament (which would mint/mispay CT at settle; see the SQL header + the
 * settleTournament crash-loud guard).
 *
 * Run from anywhere:
 *   POKER_PLACEMENT_UNIQUE_DATABASE_URL="postgres://…" \
 *     bun packages/database/scripts/apply-poker-placement-unique.ts
 *
 * ── WHY a bespoke env var, not DATABASE_URL ──────────────────────────────────
 * Bun AUTO-LOADS `<cwd>/.env.local`, and the package's index.ts also loads the repo
 * `.env.local` — either could silently inject a PROD `DATABASE_URL`. To make the target
 * DB an EXPLICIT, deliberate choice, this script reads ONLY
 * `POKER_PLACEMENT_UNIQUE_DATABASE_URL` (a name nothing auto-populates) and refuses to
 * run if it is missing. Mirrors apply-holdem-1b-columns.ts.
 *
 * The migration SQL is fully idempotent (CREATE UNIQUE INDEX IF NOT EXISTS) and PURELY
 * ADDITIVE — re-running is safe; it never drops or rewrites live data. If the target DB
 * already holds duplicate placements from the pre-fix code, the CREATE fails LOUDLY on
 * the existing data — that is intentional (surfaces corruption for reconciliation).
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// import.meta.dir is Bun-native; fileURLToPath keeps it portable if run via node.
const SCRIPT_DIR =
  (import.meta as unknown as { dir?: string }).dir ??
  dirname(fileURLToPath(import.meta.url));

const TARGET_URL = process.env.POKER_PLACEMENT_UNIQUE_DATABASE_URL;
if (!TARGET_URL) {
  console.error(
    '[poker-placement-unique] POKER_PLACEMENT_UNIQUE_DATABASE_URL is not set.\n' +
      '               Set it explicitly to the DB you intend to migrate, e.g.:\n' +
      '                 POKER_PLACEMENT_UNIQUE_DATABASE_URL="postgres://…staging…" bun packages/database/scripts/apply-poker-placement-unique.ts\n' +
      '               (DATABASE_URL is deliberately NOT used — it auto-loads and could be prod.)',
  );
  process.exit(1);
}

const sqlPath = resolve(
  SCRIPT_DIR,
  '../migrations-manual/2026-07-04_poker_entrant_placement_unique.sql',
);
const fullSql = readFileSync(sqlPath, 'utf-8');

// max:1 + prepare:false matches the Supabase transaction-pooler discipline used by
// the package's runtime client (named prepared statements break over the pooler).
const client = postgres(TARGET_URL, { max: 1, prepare: false });

try {
  console.log('[poker-placement-unique] Applying placement UNIQUE index from', sqlPath);
  await client.unsafe(fullSql);

  // Post-apply verification — prove the partial unique index landed.
  const idx = await client`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'poker_entrants_tournament_placement_unique'
  `;
  if (idx.length !== 1) {
    throw new Error(
      '[poker-placement-unique] poker_entrants_tournament_placement_unique index NOT present',
    );
  }
  console.log('[poker-placement-unique] partial unique index: present');
  console.log('[poker-placement-unique] ✓ migration applied');
} catch (err) {
  console.error('[poker-placement-unique] FAILED:', err);
  process.exit(1);
} finally {
  await client.end();
}
