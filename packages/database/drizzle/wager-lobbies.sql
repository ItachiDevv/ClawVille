-- Wager lobbies + escrow tables. Mirrors the deployed `clawville_wager`
-- Anchor program (`HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG`).
--
-- IDEMPOTENT — re-running this file is safe. Apply via:
--   docker exec coolify-db psql -U coolify -d coolify -f wager-lobbies.sql
-- or via `psql $DATABASE_URL -f packages/database/drizzle/wager-lobbies.sql`.
--
-- Order:
--   1. Extend treasury_purpose enum (must happen before any column reference).
--   2. Create wager_lobby_id_seq for u64 on-chain ids.
--   3. Create lobbies / lobby_players / lobby_events tables.

-- ─── 1. treasury_purpose enum extension ───────────────────────────────────
-- Drizzle 0.33+ also emits this when `db:push` runs against an existing
-- enum that adds a value, but we duplicate here so the SQL file is
-- self-contained and idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'treasury_purpose'
      AND e.enumlabel = 'wager-settlement-authority'
  ) THEN
    ALTER TYPE "treasury_purpose" ADD VALUE 'wager-settlement-authority';
  END IF;
END$$;

-- ─── 2. lobby id sequence ─────────────────────────────────────────────────
-- u64 on-chain — Postgres `bigint` (8-byte) gives us 0..2^63-1 safely; we
-- never use the top bit. Sequence is non-cycling so collisions are
-- impossible across the lifetime of the deployment.
CREATE SEQUENCE IF NOT EXISTS "wager_lobby_id_seq"
  AS bigint
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

-- ─── 3. lobbies ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "lobbies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lobby_id" bigint NOT NULL UNIQUE DEFAULT nextval('wager_lobby_id_seq'),
  "activity_id" text NOT NULL,
  "room_id" text NOT NULL,
  "creator_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "creator_avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "wager_amount_lamports" bigint NOT NULL DEFAULT 0,
  "wager_mint" text,
  "max_players" smallint NOT NULL,
  "joined_count" smallint NOT NULL DEFAULT 1,
  "state" text NOT NULL DEFAULT 'open',
  "visibility" text NOT NULL DEFAULT 'public',
  "invite_code" text,
  "mode" text NOT NULL DEFAULT 'multiplayer',
  "settled_winner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "settled_winner_avatar_id" uuid REFERENCES "avatars"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "locked_at" timestamp with time zone,
  "settled_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "on_chain_create_sig" text,
  "on_chain_lock_sig" text,
  "on_chain_settle_sig" text,
  "on_chain_cancel_sig" text,
  CONSTRAINT "lobbies_max_players_range" CHECK (max_players >= 2 AND max_players <= 16),
  CONSTRAINT "lobbies_state_valid" CHECK (state IN ('open','locked','settled','cancelled')),
  CONSTRAINT "lobbies_visibility_valid" CHECK (visibility IN ('public','private','friends')),
  CONSTRAINT "lobbies_mode_valid" CHECK (mode IN ('multiplayer','solo-bots')),
  CONSTRAINT "lobbies_invite_code_required" CHECK (visibility = 'public' OR invite_code IS NOT NULL),
  CONSTRAINT "lobbies_joined_count_range" CHECK (joined_count >= 0 AND joined_count <= max_players)
);

CREATE INDEX IF NOT EXISTS "idx_lobbies_state_activity"
  ON "lobbies" ("state", "activity_id");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_lobbies_invite_code_uniq"
  ON "lobbies" ("invite_code")
  WHERE invite_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_lobbies_room_id"
  ON "lobbies" ("room_id");

-- ─── 4. lobby_players ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "lobby_players" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lobby_id" uuid NOT NULL REFERENCES "lobbies"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "deposit_amount_lamports" bigint NOT NULL,
  "deposited_at" timestamp with time zone NOT NULL DEFAULT now(),
  "refunded" boolean NOT NULL DEFAULT false,
  "refunded_at" timestamp with time zone,
  "on_chain_join_sig" text NOT NULL,
  "on_chain_refund_sig" text
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_lobby_players_lobby_user_uniq"
  ON "lobby_players" ("lobby_id", "user_id");

CREATE INDEX IF NOT EXISTS "idx_lobby_players_user"
  ON "lobby_players" ("user_id");

-- ─── 5. lobby_events ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "lobby_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lobby_id" uuid NOT NULL REFERENCES "lobbies"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "tx_sig" text,
  "raw_event_json" jsonb,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "lobby_events_kind_valid"
    CHECK (kind IN ('created','joined','locked','settled','cancelled','refunded','cleanup'))
);

CREATE INDEX IF NOT EXISTS "idx_lobby_events_lobby_occurred"
  ON "lobby_events" ("lobby_id", "occurred_at" DESC);
