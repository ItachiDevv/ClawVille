-- 0006z_prod_schema_reconcile.sql
-- ============================================================================
-- PROD SCHEMA RECONCILE (2026-07-08, authored for the PR #187 promotion).
--
-- WHY: a body of schema reached the STAGING DB via push-era / ad-hoc DDL and
-- has no migration file: the F1 provenance wall (avatars soft/bought/earned +
-- the conservation CHECK + the provenance enum/columns on the CT ledger), the
-- three-way-settlement bounty columns, the cash-poker tables, the SAP escrow
-- tables, `openclaw_bots.is_house`, `agent_session_tickets.issued_to_agent_id`,
-- and three ad-hoc indexes. PROD lacks ALL of it (verified 2026-07-08 by a
-- column-level information_schema diff, prod vs staging: 102 gap entries after
-- excluding objects migrations 0007-0018 create). Without this file, prod's
-- first ledger write 500s and migration 0011 fails loud on the missing columns.
--
-- NAMING: '0006z' sorts lexically AFTER 0006_world_grow and BEFORE 0007 — it
-- MUST run before 0011 (the x10 multiplies the wall columns this file adds).
--
-- SOURCE OF TRUTH: generated from the LIVE staging schema (pg_dump 17 for the
-- six tables; pg_enum / pg_constraint / information_schema for the rest) — the
-- exact schema every DB-gated money suite passed against on 2026-07-07.
--
-- IDEMPOTENT + VALIDATED: every statement is IF-NOT-EXISTS / duplicate-guarded.
-- Applied on STAGING as a 100%-no-op to prove idempotency before promotion.
--
-- BACKFILL SEMANTICS (the one data-writing block): pre-wall prod balances
-- become SOFT (soft_balance = claw_tokens, bought/earned 0) — the F1
-- convention for pre-wall CT (non-cashable). The corrective UPDATE is
-- self-guarding (only rows where the sum doesn't match) so re-runs are no-ops
-- and staging (where the CHECK already holds) is untouched.
-- ============================================================================

-- ── 1) Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE claw_token_provenance AS ENUM ('soft', 'bought', 'earned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bounty_payment_rail AS ENUM ('ct', 'usdc');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sap_escrow_settlement_status AS ENUM
    ('open','submitted','settling','settled','refunding','refunded','failed','funding_unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2) F1 provenance wall on avatars ───────────────────────────────────────
ALTER TABLE avatars ADD COLUMN IF NOT EXISTS soft_balance   integer NOT NULL DEFAULT 1000;
ALTER TABLE avatars ADD COLUMN IF NOT EXISTS bought_balance integer NOT NULL DEFAULT 0;
ALTER TABLE avatars ADD COLUMN IF NOT EXISTS earned_balance integer NOT NULL DEFAULT 0;

-- Backfill pre-wall rows: ALL existing CT classifies as SOFT (non-cashable,
-- the F1 convention). Self-guarding: only rows violating the conservation sum
-- (i.e. rows that predate the wall) are touched; a re-run matches zero rows.
UPDATE avatars SET
  soft_balance   = claw_tokens - bought_balance - earned_balance
WHERE claw_tokens <> soft_balance + bought_balance + earned_balance;

DO $$ BEGIN
  ALTER TABLE avatars ADD CONSTRAINT avatars_vclaw_balance_sum
    CHECK (claw_tokens = ((soft_balance + bought_balance) + earned_balance));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3) F1 columns on the CT ledger ─────────────────────────────────────────
ALTER TABLE claw_token_transactions ADD COLUMN IF NOT EXISTS provenance     claw_token_provenance;
ALTER TABLE claw_token_transactions ADD COLUMN IF NOT EXISTS usd_basis      numeric(20,6);
ALTER TABLE claw_token_transactions ADD COLUMN IF NOT EXISTS fp_hash        text;
ALTER TABLE claw_token_transactions ADD COLUMN IF NOT EXISTS ip_prefix_hash text;

-- ── 4) Three-way-settlement columns on bounties ────────────────────────────
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS acceptance_criteria           text;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS payment_rail                  bounty_payment_rail NOT NULL DEFAULT 'ct';
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS verdict_required              boolean NOT NULL DEFAULT false;
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS escrow_pda                    varchar(64);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS escrow_job_id                 varchar(128);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS covenant_verdict_id           varchar(128);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS covenant_audit_root_hex       varchar(64);
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS covenant_verification_passed  boolean;

-- ── 5) Small drifts ─────────────────────────────────────────────────────────
ALTER TABLE openclaw_bots         ADD COLUMN IF NOT EXISTS is_house            boolean NOT NULL DEFAULT false;
ALTER TABLE agent_session_tickets ADD COLUMN IF NOT EXISTS issued_to_agent_id  text;

-- ── 6) Cash-poker tables (staging pg_dump 17, constraints + FKs inline) ────
CREATE TABLE IF NOT EXISTS poker_cash_tables (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    source text NOT NULL,
    visibility text NOT NULL,
    tier_key text,
    buy_in_ct text NOT NULL,
    small_blind_ct text NOT NULL,
    big_blind_ct text NOT NULL,
    max_seats integer NOT NULL,
    seeded_agent_slots integer DEFAULT 0 NOT NULL,
    join_code text,
    created_by uuid REFERENCES avatars(id) ON DELETE SET NULL,
    rake_bps integer DEFAULT 0 NOT NULL,
    rake_cap_ct text,
    table_escrow_ct text DEFAULT '0'::text NOT NULL,
    rake_taken_ct text DEFAULT '0'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT poker_cash_tables_rake_bps_check CHECK (((rake_bps >= 0) AND (rake_bps <= 10000))),
    CONSTRAINT poker_cash_tables_seat_bounds_check CHECK (((max_seats >= 2) AND (max_seats <= 8) AND (seeded_agent_slots >= 0) AND (seeded_agent_slots <= max_seats))),
    CONSTRAINT poker_cash_tables_source_check CHECK ((source = ANY (ARRAY['house'::text, 'player-public'::text, 'private'::text]))),
    CONSTRAINT poker_cash_tables_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text]))),
    CONSTRAINT poker_cash_tables_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text])))
);

CREATE TABLE IF NOT EXISTS poker_cash_seats (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    table_id uuid NOT NULL REFERENCES poker_cash_tables(id) ON DELETE CASCADE,
    avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
    agent_id text,
    subject_type text NOT NULL,
    is_seeded text DEFAULT 'false'::text NOT NULL,
    seat_index integer NOT NULL,
    current_stack_ct text DEFAULT '0'::text NOT NULL,
    status text DEFAULT 'sitting_in'::text NOT NULL,
    total_bought_in_ct text DEFAULT '0'::text NOT NULL,
    total_cashed_out_ct text DEFAULT '0'::text NOT NULL,
    seated_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT poker_cash_seats_status_check CHECK ((status = ANY (ARRAY['sitting_in'::text, 'sitting_out'::text, 'left'::text]))),
    CONSTRAINT poker_cash_seats_subject_type_check CHECK ((subject_type = ANY (ARRAY['human'::text, 'agent'::text])))
);

CREATE TABLE IF NOT EXISTS poker_cash_hands (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    table_id uuid NOT NULL REFERENCES poker_cash_tables(id) ON DELETE CASCADE,
    hand_number integer NOT NULL,
    server_seed_commit text NOT NULL,
    server_seed_reveal text,
    client_seed text NOT NULL,
    board_json jsonb,
    pot_total_ct text,
    rake_taken_ct text DEFAULT '0'::text NOT NULL,
    pot_result_json jsonb,
    settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS poker_cash_ledger_events (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    table_id uuid NOT NULL REFERENCES poker_cash_tables(id) ON DELETE CASCADE,
    seat_id uuid REFERENCES poker_cash_seats(id) ON DELETE SET NULL,
    avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
    kind text NOT NULL,
    amount_ct text NOT NULL,
    ledger_txn_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT poker_cash_ledger_kind_check CHECK ((kind = ANY (ARRAY['buy_in'::text, 'rebuy'::text, 'cash_out'::text, 'rake'::text])))
);

-- ── 7) SAP escrow tables ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sap_escrow_settlements (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    escrow_pda character varying(64) NOT NULL,
    job_id character varying(128) NOT NULL,
    depositor_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
    worker_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
    worker_wallet_pubkey character varying(64) NOT NULL,
    depositor_wallet_pubkey character varying(64) NOT NULL,
    token_mint character varying(64) NOT NULL,
    price_per_call character varying(32) NOT NULL,
    max_calls character varying(32),
    funded_amount character varying(32),
    calls_settled character varying(32),
    released_amount character varying(32),
    refunded_amount character varying(32),
    verification_provider character varying(64),
    verification_passed boolean,
    audit_root_hex character varying(64),
    verification_detail text,
    status sap_escrow_settlement_status DEFAULT 'open' NOT NULL,
    settle_signature character varying(128),
    funding_signature character varying(128),
    dry_run boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS sap_escrow_approvals (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    escrow_pda character varying(64) NOT NULL,
    job_id character varying(128) NOT NULL,
    approver_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
    worker_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
    approved_calls character varying(32),
    approved_at timestamp with time zone DEFAULT now() NOT NULL
);

-- ── 8) Indexes (dumped set + the three ad-hoc ones) ─────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS poker_cash_hands_table_hand_unique ON poker_cash_hands (table_id, hand_number);
CREATE INDEX IF NOT EXISTS poker_cash_hands_table_idx ON poker_cash_hands (table_id);
CREATE INDEX IF NOT EXISTS poker_cash_ledger_avatar_idx ON poker_cash_ledger_events (avatar_id);
CREATE INDEX IF NOT EXISTS poker_cash_ledger_table_idx ON poker_cash_ledger_events (table_id);
CREATE UNIQUE INDEX IF NOT EXISTS poker_cash_seats_active_avatar_unique ON poker_cash_seats (table_id, avatar_id) WHERE (status <> 'left'::text);
CREATE UNIQUE INDEX IF NOT EXISTS poker_cash_seats_active_index_unique ON poker_cash_seats (table_id, seat_index) WHERE (status <> 'left'::text);
CREATE INDEX IF NOT EXISTS poker_cash_seats_avatar_idx ON poker_cash_seats (avatar_id);
CREATE INDEX IF NOT EXISTS poker_cash_seats_table_idx ON poker_cash_seats (table_id);
CREATE INDEX IF NOT EXISTS poker_cash_tables_created_by_idx ON poker_cash_tables (created_by);
CREATE INDEX IF NOT EXISTS poker_cash_tables_discovery_idx ON poker_cash_tables (visibility, status);
CREATE UNIQUE INDEX IF NOT EXISTS poker_cash_tables_join_code_unique ON poker_cash_tables (join_code) WHERE (join_code IS NOT NULL);
CREATE INDEX IF NOT EXISTS sap_escrow_approvals_approver_idx ON sap_escrow_approvals (approver_avatar_id, approved_at);
CREATE UNIQUE INDEX IF NOT EXISTS sap_escrow_approvals_escrow_job_unique ON sap_escrow_approvals (escrow_pda, job_id);
CREATE INDEX IF NOT EXISTS sap_escrow_settlements_depositor_idx ON sap_escrow_settlements (depositor_avatar_id, created_at);
CREATE INDEX IF NOT EXISTS sap_escrow_settlements_escrow_idx ON sap_escrow_settlements (escrow_pda, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS sap_escrow_settlements_escrow_job_unique ON sap_escrow_settlements (escrow_pda, job_id);
CREATE INDEX IF NOT EXISTS sap_escrow_settlements_status_idx ON sap_escrow_settlements (status, created_at);
CREATE INDEX IF NOT EXISTS sap_escrow_settlements_worker_idx ON sap_escrow_settlements (worker_avatar_id, created_at);

CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events (agent_id, ts DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_events_agent_id_cursor ON events (agent_id, id) WHERE (agent_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_avatars_platform_agent_id ON avatars (platform_agent_id) WHERE (platform_agent_id IS NOT NULL);
