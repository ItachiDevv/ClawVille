-- 0087_baccarat_shared_tables.sql: shared-table (multiplayer) baccarat (founder order 2026-10-21).
-- Spec: ~/.clawville-brain/plans/baccarat-shared-table-port-2026-10-22.md section 4.
-- Adds baccarat_tables, baccarat_table_seats, baccarat_table_bets, and a table-owned shoe column.
-- Additive and idempotent. No table or column DROP. One constraint swap on baccarat_shoes:
-- the two-way subject check becomes exactly-one-of (user_id, guest_fp_hash, table_id), which
-- accepts every existing row (all have table_id NULL and exactly one of the other two).

-- 1. Tables ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS baccarat_tables (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source              text NOT NULL,
  visibility          text NOT NULL,
  tier_key            text,
  min_bet_ct          integer NOT NULL,
  max_bet_ct          integer NOT NULL,
  max_seats           integer NOT NULL,
  seeded_agent_slots  integer NOT NULL DEFAULT 0,
  active_shoe_id      uuid REFERENCES baccarat_shoes(id) ON DELETE SET NULL,
  previous_shoe_id    uuid REFERENCES baccarat_shoes(id) ON DELETE SET NULL,
  round_seq           bigint NOT NULL DEFAULT 0,
  round_phase         text NOT NULL DEFAULT 'idle',
  phase_ends_at       timestamptz,
  settle_attempts     integer NOT NULL DEFAULT 0,
  last_coup_id        uuid REFERENCES baccarat_coups(id) ON DELETE SET NULL,
  last_round_seq      bigint,
  created_by          uuid REFERENCES avatars(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'open',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT baccarat_tables_source_check CHECK (source IN ('house', 'player-public', 'private')),
  CONSTRAINT baccarat_tables_visibility_check CHECK (visibility IN ('public', 'private')),
  CONSTRAINT baccarat_tables_status_check CHECK (status IN ('open', 'closed')),
  CONSTRAINT baccarat_tables_phase_check CHECK (round_phase IN ('idle', 'betting', 'dealing', 'reveal')),
  CONSTRAINT baccarat_tables_bet_bounds_check CHECK (min_bet_ct > 0 AND max_bet_ct >= min_bet_ct),
  CONSTRAINT baccarat_tables_seat_bounds_check CHECK (
    max_seats BETWEEN 2 AND 8 AND seeded_agent_slots BETWEEN 0 AND max_seats
  )
);
CREATE INDEX IF NOT EXISTS baccarat_tables_discovery_idx ON baccarat_tables (visibility, status);
CREATE INDEX IF NOT EXISTS baccarat_tables_tier_idx ON baccarat_tables (source, tier_key, status);

-- 2. Seats ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS baccarat_table_seats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id        uuid NOT NULL REFERENCES baccarat_tables(id) ON DELETE CASCADE,
  avatar_id       uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  agent_id        text,
  subject_type    text NOT NULL,
  is_seeded       boolean NOT NULL DEFAULT false,
  seat_index      integer NOT NULL,
  status          text NOT NULL DEFAULT 'seated',
  seated_at       timestamptz NOT NULL DEFAULT now(),
  last_action_at  timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT baccarat_table_seats_subject_type_check CHECK (subject_type IN ('human', 'agent')),
  CONSTRAINT baccarat_table_seats_status_check CHECK (status IN ('seated', 'left')),
  CONSTRAINT baccarat_table_seats_index_check CHECK (seat_index >= 0 AND seat_index < 8)
);
CREATE INDEX IF NOT EXISTS baccarat_table_seats_table_idx
  ON baccarat_table_seats (table_id) WHERE status = 'seated';
CREATE UNIQUE INDEX IF NOT EXISTS baccarat_table_seats_active_index_unique
  ON baccarat_table_seats (table_id, seat_index) WHERE status = 'seated';
-- One shared-baccarat seat per avatar across ALL tables (also stops one bot at two tables).
CREATE UNIQUE INDEX IF NOT EXISTS baccarat_table_seats_active_avatar_unique
  ON baccarat_table_seats (avatar_id) WHERE status = 'seated';

-- 3. Per-round bets -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS baccarat_table_bets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id      uuid NOT NULL REFERENCES baccarat_tables(id) ON DELETE CASCADE,
  round_seq     bigint NOT NULL,
  seat_index    integer NOT NULL,
  avatar_id     uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  actor_kind    text NOT NULL,
  agent_id      text,
  origin        text NOT NULL DEFAULT 'rest',
  bet           text NOT NULL,
  stake         text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  void_reason   text,
  shoe_id       uuid REFERENCES baccarat_shoes(id) ON DELETE SET NULL,
  coup_id       uuid REFERENCES baccarat_coups(id) ON DELETE SET NULL,
  coup_index    integer,
  payout        text,
  net           text,
  commission    text,
  settled_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT baccarat_table_bets_actor_kind_check CHECK (actor_kind IN ('human', 'agent')),
  CONSTRAINT baccarat_table_bets_origin_check CHECK (origin IN ('rest', 'autonomous')),
  CONSTRAINT baccarat_table_bets_bet_check CHECK (bet IN ('player', 'banker', 'tie')),
  CONSTRAINT baccarat_table_bets_status_check CHECK (status IN ('pending', 'settled', 'void', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS baccarat_table_bets_round_idx ON baccarat_table_bets (table_id, round_seq);
CREATE INDEX IF NOT EXISTS baccarat_table_bets_avatar_idx ON baccarat_table_bets (avatar_id, created_at DESC);
-- One live bet per (table, round, seat); replace = UPDATE this row.
CREATE UNIQUE INDEX IF NOT EXISTS baccarat_table_bets_pending_round_seat_unique
  ON baccarat_table_bets (table_id, round_seq, seat_index) WHERE status = 'pending';
-- Settle idempotency anchors: an avatar is charged at most once per (table, round),
-- and a seat at most once per coup.
CREATE UNIQUE INDEX IF NOT EXISTS baccarat_table_bets_round_avatar_unique
  ON baccarat_table_bets (table_id, round_seq, avatar_id) WHERE status IN ('pending', 'settled');
CREATE UNIQUE INDEX IF NOT EXISTS baccarat_table_bets_coup_seat_unique
  ON baccarat_table_bets (coup_id, seat_index) WHERE coup_id IS NOT NULL AND status = 'settled';

-- 4. Table-owned shoes ----------------------------------------------------------------------
ALTER TABLE baccarat_shoes ADD COLUMN IF NOT EXISTS table_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'baccarat_shoes_table_id_fkey') THEN
    ALTER TABLE baccarat_shoes
      ADD CONSTRAINT baccarat_shoes_table_id_fkey
      FOREIGN KEY (table_id) REFERENCES baccarat_tables(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Constraint swap (in the 2026-09-22 constraint inventory: docs/audits/2026-09-22-independent-review.md:116).
-- No migration file names the two-way check (it came from a historical Drizzle push,
-- schema/baccarat.ts:91-94), so its live name is not proven. Drop EVERY check on
-- baccarat_shoes that references guest_fp_hash and is not the new three-way form, by
-- catalog lookup, then add the new one. A plain DROP ... IF EXISTS on a guessed name
-- could be a silent no-op and leave the old check, which rejects every table shoe.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'baccarat_shoes'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%guest_fp_hash%'
       AND pg_get_constraintdef(oid) NOT LIKE '%num_nonnulls%'
  LOOP
    EXECUTE format('ALTER TABLE baccarat_shoes DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'baccarat_shoes'::regclass AND conname = 'baccarat_shoes_subject_check'
  ) THEN
    ALTER TABLE baccarat_shoes
      ADD CONSTRAINT baccarat_shoes_subject_check
      CHECK (num_nonnulls(user_id, guest_fp_hash, table_id) = 1);
  END IF;
END $$;
-- Post-check (W1 runs it on the scratch DB and the lead runs it read-only on staging after the
-- migrate job): exactly one CHECK on baccarat_shoes mentions guest_fp_hash, and it is the
-- num_nonnulls form.

-- BA-2: a table-owned shoe is never a test-fixture shoe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'baccarat_shoes_table_no_fixture_check') THEN
    ALTER TABLE baccarat_shoes
      ADD CONSTRAINT baccarat_shoes_table_no_fixture_check
      CHECK (table_id IS NULL OR (fixture_run_id IS NULL AND fixture_initial_dealt_count = 0));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS baccarat_shoes_table_open_unique
  ON baccarat_shoes (table_id) WHERE status = 'open' AND table_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS baccarat_shoes_table_idx
  ON baccarat_shoes (table_id) WHERE table_id IS NOT NULL;
