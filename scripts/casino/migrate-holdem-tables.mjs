// Phase 6.5.1 — create holdem_tables + holdem_hands on the shared Supabase DB.
// Idempotent (CREATE TABLE/INDEX IF NOT EXISTS; CHECK is inline so it only lands
// with a fresh table). Scoped: touches ONLY the two holdem tables — does NOT
// diff/alter any other table (deliberately avoids `db:push` full-schema diff on
// the shared prod DB). Mirrors packages/database/src/schema/holdem.ts exactly.
//   Run: DATABASE_URL=... bun scripts/casino/migrate-holdem-tables.mjs
import pg from 'pg';
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const stmts = [
  `CREATE TABLE IF NOT EXISTS holdem_tables (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id uuid REFERENCES users(id) ON DELETE CASCADE,
     guest_fp_hash text,
     currency text NOT NULL DEFAULT 'clawtoken',
     server_seed text NOT NULL,
     server_seed_hash text NOT NULL,
     client_seed text NOT NULL,
     hand_counter integer NOT NULL DEFAULT 0,
     buy_in_stack text NOT NULL,
     player_stack text NOT NULL,
     starting_balance text NOT NULL,
     total_bet text NOT NULL DEFAULT '0',
     total_payout text NOT NULL DEFAULT '0',
     status text NOT NULL DEFAULT 'open',
     hands_played integer NOT NULL DEFAULT 0,
     engine_version text NOT NULL DEFAULT 'th-v1',
     created_at timestamptz NOT NULL DEFAULT now(),
     last_hand_at timestamptz,
     closed_at timestamptz,
     CONSTRAINT holdem_tables_subject_check CHECK ((user_id IS NOT NULL) <> (guest_fp_hash IS NOT NULL))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS holdem_tables_user_open_unique
     ON holdem_tables (user_id) WHERE status = 'open' AND user_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS holdem_tables_guest_open_unique
     ON holdem_tables (guest_fp_hash) WHERE status = 'open' AND guest_fp_hash IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS holdem_hands (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     table_id uuid NOT NULL REFERENCES holdem_tables(id) ON DELETE CASCADE,
     hand_index integer NOT NULL,
     button_seat integer NOT NULL,
     starting_stack text NOT NULL,
     actions jsonb NOT NULL,
     status text NOT NULL DEFAULT 'in_progress',
     outcome_json jsonb,
     bet_amount text,
     payout text,
     net text,
     ending_stack text,
     idempotency_key text,
     created_at timestamptz NOT NULL DEFAULT now(),
     settled_at timestamptz
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS holdem_hands_table_hand_unique
     ON holdem_hands (table_id, hand_index)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS holdem_hands_table_idempotency_unique
     ON holdem_hands (table_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS holdem_hands_table_idx ON holdem_hands (table_id)`,
];

let applied = 0;
for (const s of stmts) {
  await c.query(s);
  console.log(`[ok]   ${s.slice(0, 70).replace(/\s+/g, ' ')}`);
  applied++;
}

const { rows } = await c.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_name IN ('holdem_tables','holdem_hands') ORDER BY table_name`,
);
console.log(`\nDone. ${applied} statements applied. Tables present: ${rows.map((r) => r.table_name).join(', ')}`);
await c.end();
