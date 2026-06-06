// Phase 6.7.5 — guest history schema migration. Idempotent: safe to re-run.
//
// Adds nullable `user_id` + new `guest_fp_hash` to `cove_game_events` and
// `slot_sessions`, plus a check constraint that exactly one of the two is
// set per row. Rebuilds the user-keyed indexes as partial-WHERE so guest
// rows don't bloat them, and adds matching guest-keyed partial indexes.
//
// Run locally (hits prod Supabase via DATABASE_URL — see CLAUDE.md staging
// note: this is a non-destructive schema migration, safe to run against
// shared DB):
//
//   bun run scripts/casino/migrate-guest-history.mjs
//
// Drizzle-kit can't handle the check()+partial-index combo (see memory
// `feedback_drizzle_kit_introspection_bug`), so we apply via raw SQL. Every
// statement uses IF NOT EXISTS / DO $$ EXCEPTION WHEN duplicate_object
// so a second invocation is a no-op.

import pg from 'pg';
const { Client } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const STATEMENTS = [
  // ─── cove_game_events ─────────────────────────────────────────────────
  `ALTER TABLE cove_game_events ALTER COLUMN user_id DROP NOT NULL`,
  `ALTER TABLE cove_game_events ADD COLUMN IF NOT EXISTS guest_fp_hash TEXT`,
  `DO $$ BEGIN
     ALTER TABLE cove_game_events
       ADD CONSTRAINT cove_game_events_subject_check
       CHECK ((user_id IS NOT NULL) <> (guest_fp_hash IS NOT NULL));
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DROP INDEX IF EXISTS cove_game_events_user_created_at_idx`,
  `CREATE INDEX IF NOT EXISTS cove_game_events_user_created_at_idx
     ON cove_game_events (user_id, created_at DESC)
     WHERE user_id IS NOT NULL`,
  `DROP INDEX IF EXISTS cove_game_events_user_game_created_at_idx`,
  `CREATE INDEX IF NOT EXISTS cove_game_events_user_game_created_at_idx
     ON cove_game_events (user_id, game_type, created_at DESC)
     WHERE user_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS cove_game_events_guest_fp_created_at_idx
     ON cove_game_events (guest_fp_hash, created_at DESC)
     WHERE guest_fp_hash IS NOT NULL`,

  // ─── slot_sessions ────────────────────────────────────────────────────
  `ALTER TABLE slot_sessions ALTER COLUMN user_id DROP NOT NULL`,
  `ALTER TABLE slot_sessions ADD COLUMN IF NOT EXISTS guest_fp_hash TEXT`,
  `DO $$ BEGIN
     ALTER TABLE slot_sessions
       ADD CONSTRAINT slot_sessions_subject_check
       CHECK ((user_id IS NOT NULL) <> (guest_fp_hash IS NOT NULL));
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // The original index was non-partial and unconditional on user_id;
  // rebuild as partial so guest rows don't carry a stale NULL slot.
  `DROP INDEX IF EXISTS slot_sessions_user_id_idx`,
  `CREATE INDEX IF NOT EXISTS slot_sessions_user_id_idx
     ON slot_sessions (user_id)
     WHERE user_id IS NOT NULL`,
  // Existing one-open-session-per-user unique needs the user_id IS NOT NULL
  // predicate so a guest row with user_id=NULL doesn't fail the unique check.
  `DROP INDEX IF EXISTS slot_sessions_user_open_unique`,
  `CREATE UNIQUE INDEX IF NOT EXISTS slot_sessions_user_open_unique
     ON slot_sessions (user_id)
     WHERE status = 'open' AND user_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS slot_sessions_guest_fp_idx
     ON slot_sessions (guest_fp_hash)
     WHERE guest_fp_hash IS NOT NULL`,
  // Guest equivalent of openSessionUnique — prevents a single fp opening
  // many concurrent guest sessions (would also let it bypass the per-fp
  // rate limit by parking them).
  `CREATE UNIQUE INDEX IF NOT EXISTS slot_sessions_guest_open_unique
     ON slot_sessions (guest_fp_hash)
     WHERE status = 'open' AND guest_fp_hash IS NOT NULL`,
];

const client = new Client({ connectionString });
await client.connect();

let applied = 0;
let skipped = 0;
for (const stmt of STATEMENTS) {
  const label = stmt.replace(/\s+/g, ' ').slice(0, 90);
  try {
    const res = await client.query(stmt);
    // CREATE INDEX IF NOT EXISTS / ALTER TABLE … DROP NOT NULL emit notices
    // not row counts; just report the statement.
    console.log(`[ok]   ${label}${res.rowCount != null ? ` (rows=${res.rowCount})` : ''}`);
    applied++;
  } catch (err) {
    console.error(`[fail] ${label}\n       ${err.message}`);
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log(`\nDone. ${applied} statements applied, ${skipped} skipped.`);
