-- Phase 6.1 slice 3 — additive schema for casino slots
-- IF NOT EXISTS clauses make this safe to re-run.

CREATE TABLE IF NOT EXISTS slot_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paytable_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  server_seed TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed TEXT NOT NULL,
  nonce_counter BIGINT NOT NULL DEFAULT 0,
  cursor_counter BIGINT NOT NULL DEFAULT 0,
  starting_balance TEXT NOT NULL,
  current_balance TEXT NOT NULL,
  escrow_amount TEXT NOT NULL DEFAULT '0',
  total_staked TEXT NOT NULL DEFAULT '0',
  total_won TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'open',
  mode TEXT NOT NULL DEFAULT 'base',
  free_spins_remaining INTEGER NOT NULL DEFAULT 0,
  spin_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_spin_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS slot_sessions_user_id_idx ON slot_sessions (user_id);
CREATE INDEX IF NOT EXISTS slot_sessions_status_idx ON slot_sessions (status);
CREATE UNIQUE INDEX IF NOT EXISTS slot_sessions_user_open_unique
  ON slot_sessions (user_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS slot_spins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES slot_sessions(id) ON DELETE CASCADE,
  nonce BIGINT NOT NULL,
  cursor_before BIGINT NOT NULL,
  cursor_after BIGINT NOT NULL,
  bet TEXT NOT NULL,
  is_free_spin BOOLEAN NOT NULL DEFAULT false,
  reels JSONB NOT NULL,
  winning_lines JSONB NOT NULL,
  win_amount TEXT NOT NULL,
  wild_multipliers JSONB NOT NULL DEFAULT '[]'::jsonb,
  scatter_payout TEXT NOT NULL DEFAULT '0',
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS slot_spins_session_id_idx ON slot_spins (session_id);
CREATE UNIQUE INDEX IF NOT EXISTS slot_spins_session_idempotency_unique
  ON slot_spins (session_id, idempotency_key);

-- Verify
SELECT 'slot_sessions' AS table_name, count(*) AS row_count FROM slot_sessions
UNION ALL
SELECT 'slot_spins', count(*) FROM slot_spins;
