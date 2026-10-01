-- 0070_floor_arena.sql: Trading Floor Arena (paper contest). Contract: docs/trading-floor-arena.md §4.
-- Drizzle mirror: packages/database/src/schema/floor-arena.ts. Value sets: packages/shared/src/constants/floor-arena.ts.
-- PAPER ONLY: no table here holds money, a ClawToken balance or a wallet secret. Purely additive; depends on "users".
-- Idempotent. The CHECK constraints live in the guarded DO block at the end, not inline: in CI the tables come
-- from the Drizzle bootstrap first (drizzle-kit 0.24 emits no CHECKs), so CREATE TABLE IF NOT EXISTS no-ops there
-- and only the DO block adds them. Foreign-key names match the ones Drizzle generates.

CREATE TABLE IF NOT EXISTS "floor_discovery_mints" (
  "mint" text PRIMARY KEY,
  "first_seen_at" timestamptz NOT NULL,
  "first_source" text NOT NULL,
  "sources" text[] NOT NULL DEFAULT '{}'::text[],
  "last_seen_at" timestamptz NOT NULL,
  "symbol" text,
  "name" text,
  "snapshot" jsonb,
  "snapshot_at" timestamptz,
  "chain_verdict" jsonb,
  "chain_checked_at" timestamptz,
  "expires_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "floor_discovery_mints_first_seen_idx" ON "floor_discovery_mints" ("first_seen_at" DESC);
CREATE INDEX IF NOT EXISTS "floor_discovery_mints_expires_idx" ON "floor_discovery_mints" ("expires_at");

CREATE TABLE IF NOT EXISTS "floor_arena_agents" (
  "id" text PRIMARY KEY,
  "kind" text NOT NULL,
  "owner_user_id" uuid,
  "avatar_id" uuid,
  "name" text NOT NULL,
  "template_id" text NOT NULL,
  "params" jsonb NOT NULL,
  "params_version" integer NOT NULL DEFAULT 1,
  "mode" text NOT NULL DEFAULT 'paper',
  "status" text NOT NULL DEFAULT 'active',
  "seated" boolean NOT NULL DEFAULT false,
  "seat_index" integer,
  "seated_at" timestamptz,
  "clawpump_agent_id" text,
  "clawpump_wallet" text,
  "provision_state" text NOT NULL DEFAULT 'none',
  "provision_error" text,
  "provision_attempts" integer NOT NULL DEFAULT 0,
  "provision_next_at" timestamptz,
  "addons" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "auto_apply_suggestions" boolean NOT NULL DEFAULT false,
  "contest_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "floor_arena_agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
-- One arena agent per account (D6). The owner_matches_kind CHECK makes every user row carry an owner.
CREATE UNIQUE INDEX IF NOT EXISTS "floor_arena_agents_one_user_per_owner_uniq" ON "floor_arena_agents" ("owner_user_id") WHERE "kind" = 'user';
-- One ClawPump agent serves at most one arena agent (D8).
CREATE UNIQUE INDEX IF NOT EXISTS "floor_arena_agents_clawpump_agent_uq" ON "floor_arena_agents" ("clawpump_agent_id") WHERE "clawpump_agent_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "floor_arena_positions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" text NOT NULL,
  "mint" text NOT NULL,
  "symbol" text,
  "source" text,
  "opened_at" timestamptz NOT NULL,
  "size_usd" numeric NOT NULL,
  "tokens" numeric NOT NULL,
  "entry_price_usd" numeric NOT NULL,
  "entry_fill_source" text,
  "entry_features" jsonb,
  "params_version" integer NOT NULL,
  "peak_mult" numeric NOT NULL DEFAULT 1,
  "last_mark_mult" numeric,
  "last_mark_at" timestamptz,
  "remaining_fraction" numeric NOT NULL DEFAULT 1,
  "realised_usd" numeric NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'open',
  "closed_at" timestamptz,
  "exit_reason" text,
  "exit_fill_source" text,
  "pnl_usd" numeric,
  "pnl_mult" numeric,
  "exit_quote_failures" integer NOT NULL DEFAULT 0,
  "exit_run" jsonb,
  CONSTRAINT "floor_arena_positions_agent_id_floor_arena_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "floor_arena_agents"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "floor_arena_positions_agent_status_idx" ON "floor_arena_positions" ("agent_id","status");
CREATE INDEX IF NOT EXISTS "floor_arena_positions_agent_opened_idx" ON "floor_arena_positions" ("agent_id","opened_at" DESC);
CREATE INDEX IF NOT EXISTS "floor_arena_positions_closed_idx" ON "floor_arena_positions" ("closed_at");
-- At most one OPEN position per agent and mint: a double entry tick or a leader failover cannot buy the same coin twice.
CREATE UNIQUE INDEX IF NOT EXISTS "floor_arena_positions_open_mint_uniq" ON "floor_arena_positions" ("agent_id","mint") WHERE "status" = 'open';

CREATE TABLE IF NOT EXISTS "floor_arena_events" (
  "id" bigserial PRIMARY KEY,
  "agent_id" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  "type" text NOT NULL,
  "mint" text,
  "summary" text NOT NULL,
  "data" jsonb,
  CONSTRAINT "floor_arena_events_agent_id_floor_arena_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "floor_arena_agents"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "floor_arena_events_agent_id_idx" ON "floor_arena_events" ("agent_id","id" DESC);
-- Serves the 7-day retention prune.
CREATE INDEX IF NOT EXISTS "floor_arena_events_at_idx" ON "floor_arena_events" ("at");
-- Serves the public trade tape (newest entry/exit rows) without walking scan/pass/skip rows.
CREATE INDEX IF NOT EXISTS "floor_arena_events_trades_idx" ON "floor_arena_events" ("id" DESC) WHERE "type" IN ('entry','exit');

CREATE TABLE IF NOT EXISTS "floor_arena_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" text NOT NULL,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "stats" jsonb NOT NULL,
  "summary" text,
  "suggestion" jsonb,
  "suggestion_state" text NOT NULL DEFAULT 'none',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "floor_arena_reports_agent_id_floor_arena_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "floor_arena_agents"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "floor_arena_reports_agent_created_idx" ON "floor_arena_reports" ("agent_id","created_at" DESC);

CREATE TABLE IF NOT EXISTS "floor_arena_param_changes" (
  "id" bigserial PRIMARY KEY,
  "agent_id" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  "source" text NOT NULL,
  "changes" jsonb NOT NULL,
  "params_version" integer NOT NULL,
  "reason" text,
  CONSTRAINT "floor_arena_param_changes_agent_id_floor_arena_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "floor_arena_agents"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "floor_arena_param_changes_agent_at_idx" ON "floor_arena_param_changes" ("agent_id","at" DESC);

-- Add-on mints stay private to one agent (D9), so they carry their own snapshot and chain verdict.
CREATE TABLE IF NOT EXISTS "floor_arena_private_mints" (
  "agent_id" text NOT NULL,
  "mint" text NOT NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "source" text NOT NULL,
  "last_seen_at" timestamptz,
  "symbol" text,
  "snapshot" jsonb,
  "snapshot_at" timestamptz,
  "chain_verdict" jsonb,
  "chain_checked_at" timestamptz,
  CONSTRAINT "floor_arena_private_mints_pkey" PRIMARY KEY ("agent_id","mint"),
  CONSTRAINT "floor_arena_private_mints_agent_id_floor_arena_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "floor_arena_agents"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "floor_arena_private_mints_mint_idx" ON "floor_arena_private_mints" ("mint");

-- Spend ledger for paid x402 add-on calls (real USDC from the agent's own ClawPump wallet). price_usd has NO default.
-- A call is written 'reserved' (catalog price) under a per-agent lock BEFORE the payment, then 'done' with the charge.
CREATE TABLE IF NOT EXISTS "floor_arena_addon_calls" (
  "id" bigserial PRIMARY KEY,
  "agent_id" text NOT NULL,
  "addon_id" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  "price_usd" numeric NOT NULL,
  "ok" boolean NOT NULL,
  "error" text,
  "mints" integer NOT NULL DEFAULT 0,
  "response_ref" text,
  "state" text NOT NULL DEFAULT 'done',
  CONSTRAINT "floor_arena_addon_calls_agent_id_floor_arena_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "floor_arena_agents"("id") ON DELETE CASCADE
);
-- Serves the per-agent daily-cap sum and the latest call per add-on (DISTINCT ON addon_id).
CREATE INDEX IF NOT EXISTS "floor_arena_addon_calls_agent_addon_at_idx" ON "floor_arena_addon_calls" ("agent_id","addon_id","at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_agents_kind_valid' AND conrelid = 'floor_arena_agents'::regclass) THEN
    ALTER TABLE "floor_arena_agents" ADD CONSTRAINT "floor_arena_agents_kind_valid"
      CHECK ("kind" IN ('house','user'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_agents_owner_matches_kind' AND conrelid = 'floor_arena_agents'::regclass) THEN
    ALTER TABLE "floor_arena_agents" ADD CONSTRAINT "floor_arena_agents_owner_matches_kind"
      CHECK (("kind" = 'house' AND "owner_user_id" IS NULL) OR ("kind" = 'user' AND "owner_user_id" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_agents_mode_valid' AND conrelid = 'floor_arena_agents'::regclass) THEN
    ALTER TABLE "floor_arena_agents" ADD CONSTRAINT "floor_arena_agents_mode_valid"
      CHECK ("mode" IN ('paper','live'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_agents_status_valid' AND conrelid = 'floor_arena_agents'::regclass) THEN
    ALTER TABLE "floor_arena_agents" ADD CONSTRAINT "floor_arena_agents_status_valid"
      CHECK ("status" IN ('active','paused','stopped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_agents_provision_state_valid' AND conrelid = 'floor_arena_agents'::regclass) THEN
    ALTER TABLE "floor_arena_agents" ADD CONSTRAINT "floor_arena_agents_provision_state_valid"
      CHECK ("provision_state" IN ('none','pending','creating','ready','failed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_positions_status_valid' AND conrelid = 'floor_arena_positions'::regclass) THEN
    ALTER TABLE "floor_arena_positions" ADD CONSTRAINT "floor_arena_positions_status_valid"
      CHECK ("status" IN ('open','closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_positions_closed_stamp' AND conrelid = 'floor_arena_positions'::regclass) THEN
    ALTER TABLE "floor_arena_positions" ADD CONSTRAINT "floor_arena_positions_closed_stamp"
      CHECK (("status" = 'open' AND "closed_at" IS NULL) OR ("status" = 'closed' AND "closed_at" IS NOT NULL AND "exit_reason" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_positions_exit_reason_valid' AND conrelid = 'floor_arena_positions'::regclass) THEN
    ALTER TABLE "floor_arena_positions" ADD CONSTRAINT "floor_arena_positions_exit_reason_valid"
      CHECK ("exit_reason" IS NULL OR "exit_reason" IN ('tp','stop','trail','time','manual','unresolved'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_positions_entry_fill_source_valid' AND conrelid = 'floor_arena_positions'::regclass) THEN
    ALTER TABLE "floor_arena_positions" ADD CONSTRAINT "floor_arena_positions_entry_fill_source_valid"
      CHECK ("entry_fill_source" IS NULL OR "entry_fill_source" IN ('quote'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_positions_exit_fill_source_valid' AND conrelid = 'floor_arena_positions'::regclass) THEN
    ALTER TABLE "floor_arena_positions" ADD CONSTRAINT "floor_arena_positions_exit_fill_source_valid"
      CHECK ("exit_fill_source" IS NULL OR "exit_fill_source" IN ('quote','mark_fallback','quote_confirmed','unresolved'));
  END IF;
  -- A closed position has a P&L unless its exit is unresolved.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_positions_closed_pnl' AND conrelid = 'floor_arena_positions'::regclass) THEN
    ALTER TABLE "floor_arena_positions" ADD CONSTRAINT "floor_arena_positions_closed_pnl"
      CHECK ("status" = 'open' OR "pnl_usd" IS NOT NULL OR "exit_reason" = 'unresolved');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_positions_amounts_positive' AND conrelid = 'floor_arena_positions'::regclass) THEN
    ALTER TABLE "floor_arena_positions" ADD CONSTRAINT "floor_arena_positions_amounts_positive"
      CHECK ("size_usd" > 0 AND "tokens" > 0 AND "entry_price_usd" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_positions_remaining_fraction_range' AND conrelid = 'floor_arena_positions'::regclass) THEN
    ALTER TABLE "floor_arena_positions" ADD CONSTRAINT "floor_arena_positions_remaining_fraction_range"
      CHECK ("remaining_fraction" >= 0 AND "remaining_fraction" <= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_events_type_valid' AND conrelid = 'floor_arena_events'::regclass) THEN
    ALTER TABLE "floor_arena_events" ADD CONSTRAINT "floor_arena_events_type_valid"
      CHECK ("type" IN ('scan','pass','skip','entry','exit','param_change','report','status','addon'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_reports_suggestion_state_valid' AND conrelid = 'floor_arena_reports'::regclass) THEN
    ALTER TABLE "floor_arena_reports" ADD CONSTRAINT "floor_arena_reports_suggestion_state_valid"
      CHECK ("suggestion_state" IN ('none','pending','applied','dismissed','auto_applied','rejected'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_param_changes_source_valid' AND conrelid = 'floor_arena_param_changes'::regclass) THEN
    ALTER TABLE "floor_arena_param_changes" ADD CONSTRAINT "floor_arena_param_changes_source_valid"
      CHECK ("source" IN ('user','house-tuner','admin','suggestion'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_addon_calls_state_valid' AND conrelid = 'floor_arena_addon_calls'::regclass) THEN
    ALTER TABLE "floor_arena_addon_calls" ADD CONSTRAINT "floor_arena_addon_calls_state_valid"
      CHECK ("state" IN ('reserved','done'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_addon_calls_price_nonneg' AND conrelid = 'floor_arena_addon_calls'::regclass) THEN
    ALTER TABLE "floor_arena_addon_calls" ADD CONSTRAINT "floor_arena_addon_calls_price_nonneg"
      CHECK ("price_usd" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_addon_calls_mints_nonneg' AND conrelid = 'floor_arena_addon_calls'::regclass) THEN
    ALTER TABLE "floor_arena_addon_calls" ADD CONSTRAINT "floor_arena_addon_calls_mints_nonneg"
      CHECK ("mints" >= 0);
  END IF;
END $$;
