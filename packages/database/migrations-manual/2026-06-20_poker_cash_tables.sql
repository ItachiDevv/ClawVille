-- Poker CASH GAMES (P1) — ring-table tables (ADDITIVE, IDEMPOTENT).
--
-- Four net-new poker_cash_* tables backing the CASH (ring) poker layer. SEPARATE
-- product from the tournament engine (poker_tournaments et al.) — these do NOT
-- touch any existing poker_* table. Money columns are TEXT-stringified atomic
-- bigints (chips==CT 1:1; rake=0 in P1, rake columns reserved for later).
--
-- ⚠️ APPLY BY HAND — NOT `bun run db:push`. `db:push` is `drizzle-kit push --force`
-- (silent destructive: it drops any table NOT in the pushing branch's schema, no
-- prompt — it dropped the poker-MTT tables from staging on 2026-06-16). Run this
-- script directly with psql against BOTH Supabase DBs (staging ref
-- mtpixvtclsjqjguouxes, prod ref wheuidgiyyccqyoppxoa), e.g. from the api
-- container:  psql "$DATABASE_URL" -f 2026-06-20_poker_cash_tables.sql
--
-- Fully idempotent (CREATE TABLE/INDEX IF NOT EXISTS) — safe to run repeatedly.

-- ── poker_cash_tables ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poker_cash_tables (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text NOT NULL,
  visibility       text NOT NULL,
  tier_key         text,
  buy_in_ct        text NOT NULL,
  small_blind_ct   text NOT NULL,
  big_blind_ct     text NOT NULL,
  max_seats        integer NOT NULL,
  seeded_agent_slots integer NOT NULL DEFAULT 0,
  join_code        text,
  created_by       uuid REFERENCES avatars(id) ON DELETE SET NULL,
  rake_bps         integer NOT NULL DEFAULT 0,
  rake_cap_ct      text,
  table_escrow_ct  text NOT NULL DEFAULT '0',
  rake_taken_ct    text NOT NULL DEFAULT '0',
  status           text NOT NULL DEFAULT 'open',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poker_cash_tables_source_check
    CHECK (source IN ('house','player-public','private')),
  CONSTRAINT poker_cash_tables_visibility_check
    CHECK (visibility IN ('public','private')),
  CONSTRAINT poker_cash_tables_status_check
    CHECK (status IN ('open','closed')),
  CONSTRAINT poker_cash_tables_seat_bounds_check
    CHECK (max_seats >= 2 AND max_seats <= 8
           AND seeded_agent_slots >= 0 AND seeded_agent_slots <= max_seats),
  CONSTRAINT poker_cash_tables_rake_bps_check
    CHECK (rake_bps >= 0 AND rake_bps <= 10000)
);

CREATE INDEX IF NOT EXISTS poker_cash_tables_discovery_idx
  ON poker_cash_tables (visibility, status);
CREATE INDEX IF NOT EXISTS poker_cash_tables_created_by_idx
  ON poker_cash_tables (created_by);
-- Join codes unique only among the non-null (private) ones.
CREATE UNIQUE INDEX IF NOT EXISTS poker_cash_tables_join_code_unique
  ON poker_cash_tables (join_code) WHERE join_code IS NOT NULL;

-- ── poker_cash_seats ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poker_cash_seats (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id            uuid NOT NULL REFERENCES poker_cash_tables(id) ON DELETE CASCADE,
  avatar_id           uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  agent_id            text,
  subject_type        text NOT NULL,
  is_seeded           text NOT NULL DEFAULT 'false',
  seat_index          integer NOT NULL,
  current_stack_ct    text NOT NULL DEFAULT '0',
  status              text NOT NULL DEFAULT 'sitting_in',
  total_bought_in_ct  text NOT NULL DEFAULT '0',
  total_cashed_out_ct text NOT NULL DEFAULT '0',
  seated_at           timestamptz NOT NULL DEFAULT now(),
  left_at             timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poker_cash_seats_subject_type_check
    CHECK (subject_type IN ('human','agent')),
  CONSTRAINT poker_cash_seats_status_check
    CHECK (status IN ('sitting_in','sitting_out','left'))
);

CREATE INDEX IF NOT EXISTS poker_cash_seats_table_idx
  ON poker_cash_seats (table_id);
CREATE INDEX IF NOT EXISTS poker_cash_seats_avatar_idx
  ON poker_cash_seats (avatar_id);
-- ONE active seat per (table, avatar) — re-sit after leaving allowed (old row history).
CREATE UNIQUE INDEX IF NOT EXISTS poker_cash_seats_active_avatar_unique
  ON poker_cash_seats (table_id, avatar_id) WHERE status <> 'left';
-- ONE occupant per (table, seat_index) among active seats.
CREATE UNIQUE INDEX IF NOT EXISTS poker_cash_seats_active_index_unique
  ON poker_cash_seats (table_id, seat_index) WHERE status <> 'left';

-- ── poker_cash_hands ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poker_cash_hands (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id           uuid NOT NULL REFERENCES poker_cash_tables(id) ON DELETE CASCADE,
  hand_number        integer NOT NULL,
  server_seed_commit text NOT NULL,
  server_seed_reveal text,
  client_seed        text NOT NULL,
  board_json         jsonb,
  pot_total_ct       text,
  rake_taken_ct      text NOT NULL DEFAULT '0',
  pot_result_json    jsonb,
  settled_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS poker_cash_hands_table_hand_unique
  ON poker_cash_hands (table_id, hand_number);
CREATE INDEX IF NOT EXISTS poker_cash_hands_table_idx
  ON poker_cash_hands (table_id);

-- ── poker_cash_ledger_events ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poker_cash_ledger_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id      uuid NOT NULL REFERENCES poker_cash_tables(id) ON DELETE CASCADE,
  seat_id       uuid REFERENCES poker_cash_seats(id) ON DELETE SET NULL,
  avatar_id     uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  amount_ct     text NOT NULL,
  ledger_txn_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poker_cash_ledger_kind_check
    CHECK (kind IN ('buy_in','rebuy','cash_out','rake'))
);

CREATE INDEX IF NOT EXISTS poker_cash_ledger_table_idx
  ON poker_cash_ledger_events (table_id);
CREATE INDEX IF NOT EXISTS poker_cash_ledger_avatar_idx
  ON poker_cash_ledger_events (avatar_id);
