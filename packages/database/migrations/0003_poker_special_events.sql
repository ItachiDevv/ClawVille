-- ============================================================================
-- 0003_poker_special_events.sql — Poker MTT + Special Events (GATED migration)
-- ============================================================================
--
-- Brings PROD's schema to PARITY with the proven STAGING schema for the 8 poker
-- + special-events tables (built by `drizzle-kit generate` from
-- packages/database/src/schema/poker.ts + special-events.ts), AND converges the
-- FK names that DRIFTED on STAGING. The 8 tables were recovered on STAGING with
-- UNNAMED inline REFERENCES, so Postgres auto-named their FKs "<table>_<col>_fkey".
-- drizzle-kit expects "<table>_<col>_<reftable>_<refcol>_fk". This migration
-- produces the DRIZZLE name on empty PROD AND converges the drifted STAGING name.
--
-- PROPERTIES (this is a CI deploy GATE — correctness is paramount):
--   * IDEMPOTENT — every statement is guarded (table: CREATE TABLE IF NOT EXISTS;
--     index: CREATE [UNIQUE] INDEX IF NOT EXISTS; FK convergence: DROP CONSTRAINT
--     IF EXISTS the drifted name + a DO-block that ADDs the drizzle name only when
--     absent). Running it on STAGING (objects already present, FKs DRIFTED) DROPs
--     the *_fkey and ADDs the *_fk — a one-time convergence, then a TOTAL NO-OP on
--     every re-run; running it on PROD (objects absent) does the real CREATE +
--     ADDs the drizzle-named FKs (the DROP no-ops). A second run on EITHER db is
--     a NO-OP.
--   * ADDITIVE-ONLY — NEW tables only. NEVER alters columns, NEVER drops a data
--     table, NEVER renames any pre-existing object other than swapping a drifted FK
--     name to its drizzle name. References ONLY the already-present base table
--     "avatars"("id") + these 8 new tables as FK targets. NEVER touches Eliza
--     tables. There are NO enums — every status is text + a named CHECK (so no
--     ALTER TYPE ADD VALUE concerns; transcribed below).
--   * FK-DEPENDENCY ORDER — parent-before-child for the CREATE TABLE block:
--       poker_blind_schedules -> special_events -> poker_tournaments ->
--       poker_tables -> poker_tournament_entrants -> poker_hands ->
--       poker_tournament_results -> special_event_signups
--     (FKs are NOT inline — see below — so this order only needs to satisfy the
--     readability/grouping intent; the convergence block runs after all 8 exist.)
--
-- FK NAME CONVERGENCE — load-bearing for drift-prevention. The live STAGING DB
-- carries POSTGRES-AUTO-NAMED FKs ("<table>_<col>_fkey"). An *_fkey name makes
-- `drizzle-kit push` churn DROP/ADD forever = drift. So FKs are NOT declared
-- inline in CREATE TABLE here. After all 8 tables exist, SECTION 3 emits, per FK:
--     ALTER TABLE ... DROP CONSTRAINT IF EXISTS "<drifted *_fkey>";
--     DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint
--       WHERE conname='<drizzle *_fk>' AND conrelid='<table>'::regclass)
--       THEN ALTER TABLE ... ADD CONSTRAINT "<drizzle *_fk>" FOREIGN KEY (...)
--       REFERENCES ...; END IF; END $$;
-- On EMPTY PROD: the DROP no-ops, the ADD creates the drizzle FK. On DRIFTED
-- STAGING: the DROP removes the *_fkey, the ADD creates the *_fk. Re-run: both
-- no-op. "avatars" is referenced UNQUALIFIED so search_path resolves it (public).
--
-- TRANSCRIPTION — every column (name/type/nullability/default), every NAMED CHECK
-- body, and every non-pkey index name+def below was transcribed BYTE-FOR-BYTE
-- from the live STAGING introspection (_poker-introspect.json), NOT from memory.
-- The ONLY names that differ from staging are the FKs, which deliberately use the
-- drizzle *_fk form (the whole point of the convergence). Type mapping:
-- uuid->uuid, text->text, int4->integer, jsonb->jsonb,
-- timestamptz->timestamp with time zone.
-- NOTE: special_event_signups.user_id is intentionally NOT a FK (no *_fkey for it
-- in the introspection, and special-events.ts declares userId with no
-- .references()).
--
-- Physical base-table name verified against the live DB: "avatars" (plural).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — CREATE TABLE IF NOT EXISTS (8 tables, FK-dependency order).
-- Inline: PRIMARY KEY on id + NAMED CHECK constraints. NO inline FK.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. poker_blind_schedules — reusable rising-blind ladders
CREATE TABLE IF NOT EXISTS "poker_blind_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "levels_json" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- 2. special_events — generic reusable PARENT layer for one-time events
CREATE TABLE IF NOT EXISTS "special_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "kind" text NOT NULL DEFAULT 'poker_tournament',
  "status" text NOT NULL DEFAULT 'draft',
  "gate_hold_mint" text,
  "gate_hold_bps" integer,
  "gate_sol_lamports" text,
  "gate_ct" integer,
  "venue_config_json" jsonb,
  "prize_config_json" jsonb,
  "max_participants" integer,
  "registration_opens_at" timestamp with time zone,
  "registration_closes_at" timestamp with time zone,
  "starts_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "special_events_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'signup_open'::text, 'live'::text, 'completed'::text, 'cancelled'::text]))),
  CONSTRAINT "special_events_gate_hold_bps_check" CHECK (((gate_hold_bps IS NULL) OR ((gate_hold_bps >= 1) AND (gate_hold_bps <= 10000)))),
  CONSTRAINT "special_events_gate_ct_check" CHECK (((gate_ct IS NULL) OR (gate_ct >= 0))),
  CONSTRAINT "special_events_max_participants_check" CHECK (((max_participants IS NULL) OR (max_participants >= 1)))
);

-- 3. poker_tournaments — one row per tournament (config + status machine + pool)
CREATE TABLE IF NOT EXISTS "poker_tournaments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'registering',
  "buy_in_ct" text NOT NULL,
  "rake_bps" integer NOT NULL DEFAULT 0,
  "min_entrants" integer NOT NULL DEFAULT 2,
  "max_entrants" integer NOT NULL,
  "seats_per_table" integer NOT NULL DEFAULT 9,
  "starting_stack" integer NOT NULL,
  "prize_pool_ct" text NOT NULL DEFAULT '0',
  "rake_taken_ct" text,
  "payout_curve_json" jsonb NOT NULL,
  "blind_schedule_id" uuid NOT NULL,
  "registration_closes_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "settled_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_by" uuid,
  "special_event_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "poker_tournaments_status_check" CHECK ((status = ANY (ARRAY['registering'::text, 'seating'::text, 'running'::text, 'completed'::text, 'cancelled'::text]))),
  CONSTRAINT "poker_tournaments_rake_bps_check" CHECK (((rake_bps >= 0) AND (rake_bps <= 10000))),
  CONSTRAINT "poker_tournaments_entrant_bounds_check" CHECK (((min_entrants >= 2) AND (max_entrants >= min_entrants) AND (seats_per_table >= 2) AND (seats_per_table <= 9))),
  CONSTRAINT "poker_tournaments_starting_stack_check" CHECK ((starting_stack > 0))
);

-- 4. poker_tables — one row per physical table in a tournament
CREATE TABLE IF NOT EXISTS "poker_tables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tournament_id" uuid NOT NULL,
  "table_number" integer NOT NULL DEFAULT 1,
  "room_id" uuid,
  "status" text NOT NULL DEFAULT 'live',
  "button_seat_index" integer NOT NULL DEFAULT 0,
  "hand_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "poker_tables_status_check" CHECK ((status = ANY (ARRAY['live'::text, 'broken'::text, 'done'::text])))
);

-- 5. poker_tournament_entrants — one row per registered subject (human OR agent)
CREATE TABLE IF NOT EXISTS "poker_tournament_entrants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tournament_id" uuid NOT NULL,
  "avatar_id" uuid NOT NULL,
  "agent_id" text,
  "subject_type" text NOT NULL,
  "buy_in_paid_ct" text NOT NULL,
  "refunded_ct" text NOT NULL DEFAULT '0',
  "placement" integer,
  "chip_stack" integer NOT NULL DEFAULT 0,
  "current_table_id" uuid,
  "seat_index" integer,
  "status" text NOT NULL DEFAULT 'registered',
  "fp_hash" text,
  "ip_prefix_hash" text,
  "registered_at" timestamp with time zone NOT NULL DEFAULT now(),
  "busted_at" timestamp with time zone,
  CONSTRAINT "poker_entrants_subject_type_check" CHECK ((subject_type = ANY (ARRAY['human'::text, 'agent'::text]))),
  CONSTRAINT "poker_entrants_status_check" CHECK ((status = ANY (ARRAY['registered'::text, 'seated'::text, 'busted'::text, 'refunded'::text])))
);

-- 6. poker_hands — one row per settled hand at a table (provably-fair trail)
CREATE TABLE IF NOT EXISTS "poker_hands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "table_id" uuid NOT NULL,
  "hand_number" integer NOT NULL,
  "server_seed_commit" text NOT NULL,
  "server_seed_reveal" text,
  "client_seed" text NOT NULL,
  "board_json" jsonb,
  "pot_result_json" jsonb,
  "settled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- 7. poker_tournament_results — one row per placed subject at tournament close
CREATE TABLE IF NOT EXISTS "poker_tournament_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tournament_id" uuid NOT NULL,
  "avatar_id" uuid NOT NULL,
  "agent_id" text,
  "placement" integer NOT NULL,
  "prize_ct" text NOT NULL DEFAULT '0',
  "settled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- 8. special_event_signups — one row per (event, avatar) signup
CREATE TABLE IF NOT EXISTS "special_event_signups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL,
  "user_id" uuid,
  "avatar_id" uuid NOT NULL,
  "agent_id" text,
  "subject_type" text NOT NULL,
  "entry_method" text NOT NULL,
  "wallet_used" text,
  "entry_proof_json" jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "confirmed_at" timestamp with time zone,
  CONSTRAINT "special_event_signups_entry_method_check" CHECK ((entry_method = ANY (ARRAY['free'::text, 'hold'::text, 'sol'::text, 'ct'::text]))),
  CONSTRAINT "special_event_signups_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'refunded'::text]))),
  CONSTRAINT "special_event_signups_subject_type_check" CHECK ((subject_type = ANY (ARRAY['human'::text, 'agent'::text]))),
  CONSTRAINT "special_event_signups_wallet_used_check" CHECK (((wallet_used IS NULL) OR (wallet_used = ANY (ARRAY['external'::text, 'custodial'::text]))))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — FK NAME CONVERGENCE (13 FKs). Per FK: DROP the drifted *_fkey if
-- present, then ADD the drizzle-named *_fk only when absent. Grouped per table.
-- ─────────────────────────────────────────────────────────────────────────────

-- special_events (1 FK) — created_by -> avatars (SET NULL)
ALTER TABLE "special_events" DROP CONSTRAINT IF EXISTS "special_events_created_by_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'special_events_created_by_avatars_id_fk' AND conrelid = 'special_events'::regclass) THEN
    ALTER TABLE "special_events" ADD CONSTRAINT "special_events_created_by_avatars_id_fk" FOREIGN KEY ("created_by") REFERENCES "avatars"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- poker_tournaments (3 FKs)
ALTER TABLE "poker_tournaments" DROP CONSTRAINT IF EXISTS "poker_tournaments_blind_schedule_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poker_tournaments_blind_schedule_id_poker_blind_schedules_id_fk' AND conrelid = 'poker_tournaments'::regclass) THEN
    ALTER TABLE "poker_tournaments" ADD CONSTRAINT "poker_tournaments_blind_schedule_id_poker_blind_schedules_id_fk" FOREIGN KEY ("blind_schedule_id") REFERENCES "poker_blind_schedules"("id") ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE "poker_tournaments" DROP CONSTRAINT IF EXISTS "poker_tournaments_created_by_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poker_tournaments_created_by_avatars_id_fk' AND conrelid = 'poker_tournaments'::regclass) THEN
    ALTER TABLE "poker_tournaments" ADD CONSTRAINT "poker_tournaments_created_by_avatars_id_fk" FOREIGN KEY ("created_by") REFERENCES "avatars"("id") ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE "poker_tournaments" DROP CONSTRAINT IF EXISTS "poker_tournaments_special_event_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poker_tournaments_special_event_id_special_events_id_fk' AND conrelid = 'poker_tournaments'::regclass) THEN
    ALTER TABLE "poker_tournaments" ADD CONSTRAINT "poker_tournaments_special_event_id_special_events_id_fk" FOREIGN KEY ("special_event_id") REFERENCES "special_events"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- poker_tables (1 FK) — tournament_id -> poker_tournaments (CASCADE)
ALTER TABLE "poker_tables" DROP CONSTRAINT IF EXISTS "poker_tables_tournament_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poker_tables_tournament_id_poker_tournaments_id_fk' AND conrelid = 'poker_tables'::regclass) THEN
    ALTER TABLE "poker_tables" ADD CONSTRAINT "poker_tables_tournament_id_poker_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "poker_tournaments"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- poker_tournament_entrants (3 FKs)
ALTER TABLE "poker_tournament_entrants" DROP CONSTRAINT IF EXISTS "poker_tournament_entrants_tournament_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poker_tournament_entrants_tournament_id_poker_tournaments_id_fk' AND conrelid = 'poker_tournament_entrants'::regclass) THEN
    ALTER TABLE "poker_tournament_entrants" ADD CONSTRAINT "poker_tournament_entrants_tournament_id_poker_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "poker_tournaments"("id") ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE "poker_tournament_entrants" DROP CONSTRAINT IF EXISTS "poker_tournament_entrants_avatar_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poker_tournament_entrants_avatar_id_avatars_id_fk' AND conrelid = 'poker_tournament_entrants'::regclass) THEN
    ALTER TABLE "poker_tournament_entrants" ADD CONSTRAINT "poker_tournament_entrants_avatar_id_avatars_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE "poker_tournament_entrants" DROP CONSTRAINT IF EXISTS "poker_tournament_entrants_current_table_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poker_tournament_entrants_current_table_id_poker_tables_id_fk' AND conrelid = 'poker_tournament_entrants'::regclass) THEN
    ALTER TABLE "poker_tournament_entrants" ADD CONSTRAINT "poker_tournament_entrants_current_table_id_poker_tables_id_fk" FOREIGN KEY ("current_table_id") REFERENCES "poker_tables"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- poker_hands (1 FK) — table_id -> poker_tables (CASCADE)
ALTER TABLE "poker_hands" DROP CONSTRAINT IF EXISTS "poker_hands_table_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poker_hands_table_id_poker_tables_id_fk' AND conrelid = 'poker_hands'::regclass) THEN
    ALTER TABLE "poker_hands" ADD CONSTRAINT "poker_hands_table_id_poker_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "poker_tables"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- poker_tournament_results (2 FKs)
ALTER TABLE "poker_tournament_results" DROP CONSTRAINT IF EXISTS "poker_tournament_results_tournament_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poker_tournament_results_tournament_id_poker_tournaments_id_fk' AND conrelid = 'poker_tournament_results'::regclass) THEN
    ALTER TABLE "poker_tournament_results" ADD CONSTRAINT "poker_tournament_results_tournament_id_poker_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "poker_tournaments"("id") ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE "poker_tournament_results" DROP CONSTRAINT IF EXISTS "poker_tournament_results_avatar_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poker_tournament_results_avatar_id_avatars_id_fk' AND conrelid = 'poker_tournament_results'::regclass) THEN
    ALTER TABLE "poker_tournament_results" ADD CONSTRAINT "poker_tournament_results_avatar_id_avatars_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- special_event_signups (2 FKs)
ALTER TABLE "special_event_signups" DROP CONSTRAINT IF EXISTS "special_event_signups_event_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'special_event_signups_event_id_special_events_id_fk' AND conrelid = 'special_event_signups'::regclass) THEN
    ALTER TABLE "special_event_signups" ADD CONSTRAINT "special_event_signups_event_id_special_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "special_events"("id") ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE "special_event_signups" DROP CONSTRAINT IF EXISTS "special_event_signups_avatar_id_fkey";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'special_event_signups_avatar_id_avatars_id_fk' AND conrelid = 'special_event_signups'::regclass) THEN
    ALTER TABLE "special_event_signups" ADD CONSTRAINT "special_event_signups_avatar_id_avatars_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — CREATE [UNIQUE] INDEX IF NOT EXISTS (15 non-pkey indexes).
-- EXACT names + defs transcribed from the live STAGING introspection.
-- pkey indexes are auto-created by the inline PRIMARY KEY and are NOT created here.
-- ─────────────────────────────────────────────────────────────────────────────

-- special_events (2)
CREATE UNIQUE INDEX IF NOT EXISTS "special_events_slug_unique"
  ON "special_events" USING btree ("slug");
CREATE INDEX IF NOT EXISTS "special_events_status_idx"
  ON "special_events" USING btree ("status");

-- poker_tournaments (2)
CREATE INDEX IF NOT EXISTS "poker_tournaments_special_event_idx"
  ON "poker_tournaments" USING btree ("special_event_id");
CREATE INDEX IF NOT EXISTS "poker_tournaments_status_idx"
  ON "poker_tournaments" USING btree ("status");

-- poker_tables (2)
CREATE INDEX IF NOT EXISTS "poker_tables_tournament_idx"
  ON "poker_tables" USING btree ("tournament_id");
CREATE UNIQUE INDEX IF NOT EXISTS "poker_tables_tournament_number_unique"
  ON "poker_tables" USING btree ("tournament_id", "table_number");

-- poker_tournament_entrants (2)
CREATE UNIQUE INDEX IF NOT EXISTS "poker_entrants_tournament_avatar_unique"
  ON "poker_tournament_entrants" USING btree ("tournament_id", "avatar_id");
CREATE INDEX IF NOT EXISTS "poker_entrants_tournament_idx"
  ON "poker_tournament_entrants" USING btree ("tournament_id");

-- poker_hands (2)
CREATE UNIQUE INDEX IF NOT EXISTS "poker_hands_table_hand_unique"
  ON "poker_hands" USING btree ("table_id", "hand_number");
CREATE INDEX IF NOT EXISTS "poker_hands_table_idx"
  ON "poker_hands" USING btree ("table_id");

-- poker_tournament_results (2)
CREATE UNIQUE INDEX IF NOT EXISTS "poker_results_tournament_avatar_unique"
  ON "poker_tournament_results" USING btree ("tournament_id", "avatar_id");
CREATE INDEX IF NOT EXISTS "poker_results_tournament_placement_idx"
  ON "poker_tournament_results" USING btree ("tournament_id", "placement");

-- special_event_signups (3)
CREATE UNIQUE INDEX IF NOT EXISTS "special_event_signups_event_avatar_unique"
  ON "special_event_signups" USING btree ("event_id", "avatar_id");
CREATE INDEX IF NOT EXISTS "special_event_signups_event_idx"
  ON "special_event_signups" USING btree ("event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "special_event_signups_sol_txsig_global_unique"
  ON "special_event_signups" USING btree (((entry_proof_json ->> 'txSig'::text)))
  WHERE ((entry_method = 'sol'::text) AND (status <> 'refunded'::text));
