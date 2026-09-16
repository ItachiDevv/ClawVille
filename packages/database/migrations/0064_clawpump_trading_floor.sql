-- Depends on 0063_trading_floor.sql.
CREATE TABLE IF NOT EXISTS "clawpump_agent_links" (
  "avatar_id" uuid PRIMARY KEY REFERENCES "avatars"("id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "clawville_agent_id" varchar(128),
  "clawpump_agent_id" varchar(128) UNIQUE,
  "wallet_pubkey" varchar(64) NOT NULL UNIQUE,
  "objective" varchar(48) NOT NULL,
  "armed" boolean NOT NULL DEFAULT false,
  "killed" boolean NOT NULL DEFAULT true,
  "float_start_lamports" numeric(20,0) NOT NULL DEFAULT 0,
  "float_start_usd_micros" numeric(20,0) NOT NULL DEFAULT 0,
  "baseline_slot" bigint,
  "operated_by_clawville" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "clawpump_agent_links_objective_valid" CHECK ("objective" IN ('momentum-board','ansem-clawville-dca','sol-usdc-mean-reversion','intel-signal-follower','conservative-rebalancer')),
  CONSTRAINT "clawpump_agent_links_float_nonneg" CHECK ("float_start_lamports" >= 0 AND "float_start_usd_micros" >= 0),
  CONSTRAINT "clawpump_agent_links_armed_needs_baseline" CHECK ("armed" = false OR "float_start_usd_micros" > 0)
);

CREATE TABLE IF NOT EXISTS "trading_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE RESTRICT,
  "origin" varchar(16) NOT NULL,
  "input_mint" varchar(64) NOT NULL,
  "output_mint" varchar(64) NOT NULL,
  "amount_usd_micros" numeric(20,0) NOT NULL,
  "amount_atomic" numeric(40,0),
  "slippage_bps" integer,
  "verdict" varchar(32) NOT NULL,
  "status" varchar(24) NOT NULL,
  "reason" varchar(240) NOT NULL DEFAULT '',
  "detail" varchar(400) NOT NULL DEFAULT '',
  "signature" varchar(128),
  "signed_tx_bytes" bytea,
  "recent_blockhash" varchar(64),
  "last_valid_block_height" bigint,
  "build_hash" varchar(64),
  "local_confirm_outcome" varchar(12),
  "local_confirm_slot" bigint,
  "local_confirmed_at" timestamptz,
  "directive_id" varchar(64),
  "directive_ordinal" integer,
  "operator_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  CONSTRAINT "trading_decisions_origin_valid" CHECK ("origin" IN ('autonomous','agent-tool','human-rest','admin-test')),
  CONSTRAINT "trading_decisions_status_valid" CHECK ("status" IN ('refused','admitted','submitted','executed','failed','expired','reconcile')),
  CONSTRAINT "trading_decisions_amount_positive" CHECK ("amount_usd_micros" > 0),
  CONSTRAINT "trading_decisions_local_confirm_valid" CHECK ("local_confirm_outcome" IS NULL OR "local_confirm_outcome" IN ('confirmed','failed'))
);
CREATE INDEX IF NOT EXISTS "trading_decisions_avatar_spend_idx" ON "trading_decisions" ("avatar_id","created_at") WHERE "status" IN ('admitted','submitted','executed','reconcile');
CREATE UNIQUE INDEX IF NOT EXISTS "trading_decisions_signature_uniq" ON "trading_decisions" ("signature") WHERE "signature" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "trading_decisions_directive_uniq" ON "trading_decisions" ("directive_id","directive_ordinal") WHERE "directive_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "trading_decisions_feed_idx" ON "trading_decisions" ("created_at" DESC);

CREATE TABLE IF NOT EXISTS "trading_halts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "scope" varchar(8) NOT NULL, "scope_id" uuid,
  "reason" varchar(240) NOT NULL, "engaged_by" varchar(64) NOT NULL,
  "halted_at" timestamptz NOT NULL DEFAULT now(), "cleared_at" timestamptz, "cleared_by" varchar(64),
  CONSTRAINT "trading_halts_scope_valid" CHECK (("scope"='fleet' AND "scope_id" IS NULL) OR ("scope"='agent' AND "scope_id" IS NOT NULL)),
  CONSTRAINT "trading_halts_clear_stamp" CHECK (("cleared_at" IS NULL) = ("cleared_by" IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "trading_halts_active_fleet_uniq" ON "trading_halts" ("scope") WHERE "scope"='fleet' AND "cleared_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "trading_halts_active_agent_uniq" ON "trading_halts" ("scope_id") WHERE "scope"='agent' AND "cleared_at" IS NULL;

CREATE TABLE IF NOT EXISTS "trading_usdc_reservations" (
  "decision_id" uuid PRIMARY KEY REFERENCES "trading_decisions"("id") ON DELETE RESTRICT,
  "avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE RESTRICT,
  "amount_base_units" numeric(20,0) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'open',
  "release_reason" varchar(64), "last_wedge_alert_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(), "released_at" timestamptz,
  CONSTRAINT "trading_usdc_reservations_amount_positive" CHECK ("amount_base_units" > 0),
  CONSTRAINT "trading_usdc_reservations_status_valid" CHECK ("status" IN ('open','settled','failed','expired','reconcile')),
  CONSTRAINT "trading_usdc_reservations_release_stamp" CHECK (("status" IN ('open','reconcile')) = ("released_at" IS NULL))
);
CREATE INDEX IF NOT EXISTS "trading_usdc_reservations_liability_idx" ON "trading_usdc_reservations" ("avatar_id") WHERE "status" IN ('open','reconcile');
