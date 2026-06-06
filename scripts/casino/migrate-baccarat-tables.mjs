// Phase 6.6.1 — create baccarat_shoes + baccarat_coups on the shared Supabase DB.
// Idempotent (CREATE TABLE/INDEX IF NOT EXISTS; CHECK is inline so it only lands
// with a fresh table). Scoped: touches ONLY the two baccarat tables — does NOT
// diff/alter any other table (deliberately avoids `db:push` full-schema diff on
// the shared prod DB). Mirrors packages/database/src/schema/baccarat.ts exactly.
//   Run: DATABASE_URL=... bun scripts/casino/migrate-baccarat-tables.mjs
import pg from 'pg';
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const stmts = [
  `CREATE TABLE IF NOT EXISTS baccarat_shoes (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id uuid REFERENCES users(id) ON DELETE CASCADE,
     guest_fp_hash text,
     currency text NOT NULL DEFAULT 'clawtoken',
     server_seed text NOT NULL,
     server_seed_hash text NOT NULL,
     client_seed text NOT NULL,
     coup_counter integer NOT NULL DEFAULT 0,
     cursor_counter integer NOT NULL DEFAULT 0,
     dealt_count integer NOT NULL DEFAULT 0,
     starting_balance text NOT NULL,
     current_balance text NOT NULL DEFAULT '0',
     total_bet text NOT NULL DEFAULT '0',
     total_payout text NOT NULL DEFAULT '0',
     status text NOT NULL DEFAULT 'open',
     coups_played integer NOT NULL DEFAULT 0,
     engine_version text NOT NULL DEFAULT 'bac-v1',
     created_at timestamptz NOT NULL DEFAULT now(),
     last_coup_at timestamptz,
     closed_at timestamptz,
     CONSTRAINT baccarat_shoes_subject_check CHECK ((user_id IS NOT NULL) <> (guest_fp_hash IS NOT NULL))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS baccarat_shoes_user_open_unique
     ON baccarat_shoes (user_id) WHERE status = 'open' AND user_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS baccarat_shoes_guest_open_unique
     ON baccarat_shoes (guest_fp_hash) WHERE status = 'open' AND guest_fp_hash IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS baccarat_coups (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     shoe_id uuid NOT NULL REFERENCES baccarat_shoes(id) ON DELETE CASCADE,
     coup_index integer NOT NULL,
     cursor_before integer NOT NULL,
     cursor_after integer,
     dealt_before integer NOT NULL,
     dealt_after integer,
     bet text NOT NULL,
     stake text NOT NULL,
     status text NOT NULL DEFAULT 'in_progress',
     outcome_json jsonb,
     payout text,
     net text,
     idempotency_key text,
     created_at timestamptz NOT NULL DEFAULT now(),
     settled_at timestamptz
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS baccarat_coups_shoe_coup_unique
     ON baccarat_coups (shoe_id, coup_index)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS baccarat_coups_shoe_idempotency_unique
     ON baccarat_coups (shoe_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS baccarat_coups_shoe_idx ON baccarat_coups (shoe_id)`,
];

let applied = 0;
for (const s of stmts) {
  await c.query(s);
  console.log(`[ok]   ${s.slice(0, 70).replace(/\s+/g, ' ')}`);
  applied++;
}

const { rows } = await c.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_name IN ('baccarat_shoes','baccarat_coups') ORDER BY table_name`,
);
console.log(`\nDone. ${applied} statements applied. Tables present: ${rows.map((r) => r.table_name).join(', ')}`);
await c.end();
