-- BA-2: staging-only deterministic parity-fixture persistence.
-- AUTHORED ONLY in Wave W-E1. Do not apply from this build-only worktree.

CREATE TABLE IF NOT EXISTS "cove_test_fixture_runs" (
  "run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_avatar_id" uuid NOT NULL,
  "scenario_name" text NOT NULL,
  "token_hash" text NOT NULL,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "exposure_budget_ct" integer NOT NULL,
  "spent_ct" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "consumed_at" timestamptz,
  "closed_at" timestamptz,
  CONSTRAINT "cove_test_fixture_runs_owner_avatar_id_avatars_id_fk"
    FOREIGN KEY ("owner_avatar_id") REFERENCES "public"."avatars"("id")
    ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "cove_test_fixture_runs_status_check"
    CHECK ("status" IN ('active', 'expired', 'closed')),
  CONSTRAINT "cove_test_fixture_runs_exposure_check"
    CHECK ("exposure_budget_ct" >= 0 AND "spent_ct" >= 0 AND "spent_ct" <= "exposure_budget_ct")
);

CREATE INDEX IF NOT EXISTS "cove_test_fixture_runs_owner_status_idx"
  ON "cove_test_fixture_runs" ("owner_avatar_id", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "cove_test_fixture_runs_owner_active_unique"
  ON "cove_test_fixture_runs" ("owner_avatar_id")
  WHERE "status" = 'active';

ALTER TABLE "blackjack_shoes"
  ADD COLUMN IF NOT EXISTS "fixture_run_id" uuid;
ALTER TABLE "baccarat_shoes"
  ADD COLUMN IF NOT EXISTS "fixture_run_id" uuid;
ALTER TABLE "baccarat_shoes"
  ADD COLUMN IF NOT EXISTS "fixture_initial_dealt_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "poker_cash_hands"
  ADD COLUMN IF NOT EXISTS "fixture_run_id" uuid;
ALTER TABLE "poker_cash_hands"
  ADD COLUMN IF NOT EXISTS "fixture_voided_at" timestamp with time zone;
ALTER TABLE "cove_game_events"
  ADD COLUMN IF NOT EXISTS "fixture_run_id" uuid;
ALTER TABLE "holdem_tables"
  ADD COLUMN IF NOT EXISTS "fixture_run_id" uuid;
ALTER TABLE "holdem_hands"
  ADD COLUMN IF NOT EXISTS "fixture_run_id" uuid;

DO $$ BEGIN
  ALTER TABLE "blackjack_shoes"
    ADD CONSTRAINT "blackjack_shoes_fixture_run_id_fk"
    FOREIGN KEY ("fixture_run_id") REFERENCES "public"."cove_test_fixture_runs"("run_id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "baccarat_shoes"
    ADD CONSTRAINT "baccarat_shoes_fixture_run_id_fk"
    FOREIGN KEY ("fixture_run_id") REFERENCES "public"."cove_test_fixture_runs"("run_id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "poker_cash_hands"
    ADD CONSTRAINT "poker_cash_hands_fixture_run_id_fk"
    FOREIGN KEY ("fixture_run_id") REFERENCES "public"."cove_test_fixture_runs"("run_id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "cove_game_events"
    ADD CONSTRAINT "cove_game_events_fixture_run_id_fk"
    FOREIGN KEY ("fixture_run_id") REFERENCES "public"."cove_test_fixture_runs"("run_id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "holdem_tables"
    ADD CONSTRAINT "holdem_tables_fixture_run_id_fk"
    FOREIGN KEY ("fixture_run_id") REFERENCES "public"."cove_test_fixture_runs"("run_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "holdem_hands"
    ADD CONSTRAINT "holdem_hands_fixture_run_id_fk"
    FOREIGN KEY ("fixture_run_id") REFERENCES "public"."cove_test_fixture_runs"("run_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
