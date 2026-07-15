-- 0031_tokenomics_redeem.sql — E3 EARNED exit rail (BUILT, DEFAULT-OFF)
-- Additive/idempotent DDL only. Applying this migration does not open the
-- route: TOKENOMICS_REDEEM_ENABLED must still equal literal 'true'.

DO $$ BEGIN
  CREATE TYPE "earned_redemption_status" AS ENUM (
    'requested', 'refused', 'debited', 'buy_queued', 'bought', 'delivering',
    'delivered', 'reconcile'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A DB lock cannot order observations from independent Solana RPC replicas.
-- E3 stores the confirmation slot; E1 custody admission reads with
-- minContextSlot >= the maximum EARNED sweep slot before admitting liability.
ALTER TABLE "clv_swap_funding"
  ADD COLUMN IF NOT EXISTS "sweep_confirmed_slot" bigint;

CREATE TABLE IF NOT EXISTS "earned_redemptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_type" text NOT NULL,
  "avatar_id" uuid NOT NULL,
  "idempotency_key" varchar(64) NOT NULL,
  "amount_vclaw" integer NOT NULL,
  "gross_usdc_atomic" numeric(20,0) NOT NULL,
  "exit_fee_usdc_atomic" numeric(20,0) NOT NULL,
  "exit_fee_retained_at" timestamp with time zone,
  "buy_usdc_atomic" numeric(20,0) NOT NULL,
  "status" "earned_redemption_status" DEFAULT 'requested' NOT NULL,
  "ledger_debit_id" uuid,
  "backing_custody_wallet_id" uuid,
  "clv_buy_queue_id" uuid,
  "clv_swap_funding_id" uuid,
  "delivery_claim_id" uuid,
  "delivery_claimed_at" timestamp with time zone,
  "delivery_tx_signature" text,
  "delivery_clv_atomic" numeric(30,0),
  "delivery_wallet_pubkey" varchar(64),
  "delivered_at" timestamp with time zone,
  "failure_reason" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "earned_redemptions_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE restrict,
  CONSTRAINT "earned_redemptions_ledger_debit_id_claw_token_transactions_id_fk"
    FOREIGN KEY ("ledger_debit_id") REFERENCES "claw_token_transactions"("id") ON DELETE restrict,
  CONSTRAINT "earned_redemptions_backing_custody_wallet_id_treasury_wallets_id_fk"
    FOREIGN KEY ("backing_custody_wallet_id") REFERENCES "treasury_wallets"("id") ON DELETE restrict,
  CONSTRAINT "earned_redemptions_clv_buy_queue_id_clv_buy_queue_id_fk"
    FOREIGN KEY ("clv_buy_queue_id") REFERENCES "clv_buy_queue"("id") ON DELETE restrict,
  CONSTRAINT "earned_redemptions_clv_swap_funding_id_clv_swap_funding_id_fk"
    FOREIGN KEY ("clv_swap_funding_id") REFERENCES "clv_swap_funding"("id") ON DELETE restrict,
  CONSTRAINT "earned_redemptions_subject_type_valid"
    CHECK ("subject_type" IN ('user', 'agent')),
  CONSTRAINT "earned_redemptions_exact_money"
    CHECK (
      "amount_vclaw" > 0
      AND "gross_usdc_atomic" = "amount_vclaw"::numeric * 10000
      AND "exit_fee_usdc_atomic" = "amount_vclaw"::numeric * 444
      AND "buy_usdc_atomic" = "amount_vclaw"::numeric * 9556
      AND "gross_usdc_atomic" = "exit_fee_usdc_atomic" + "buy_usdc_atomic"
    ),
  CONSTRAINT "earned_redemptions_debit_shape"
    CHECK (
      "status" IN ('requested', 'refused')
      OR ("ledger_debit_id" IS NOT NULL
        AND "backing_custody_wallet_id" IS NOT NULL
        AND "exit_fee_retained_at" IS NOT NULL)
    ),
  CONSTRAINT "earned_redemptions_queue_shape"
    CHECK ("status" IN ('requested', 'refused', 'debited') OR "clv_buy_queue_id" IS NOT NULL),
  CONSTRAINT "earned_redemptions_delivery_shape"
    CHECK (
      "status" <> 'delivering'
      OR ("delivery_claim_id" IS NOT NULL AND "delivery_claimed_at" IS NOT NULL)
    ),
  CONSTRAINT "earned_redemptions_bought_shape"
    CHECK (
      "status" NOT IN ('bought', 'delivering', 'delivered')
      OR ("clv_swap_funding_id" IS NOT NULL
        AND "clv_buy_queue_id" IS NOT NULL
        AND "delivery_clv_atomic" > 0)
    ),
  CONSTRAINT "earned_redemptions_captured_delivery_shape"
    CHECK (
      "delivery_tx_signature" IS NULL
      OR ("delivery_clv_atomic" > 0 AND "delivery_wallet_pubkey" IS NOT NULL)
    ),
  CONSTRAINT "earned_redemptions_reconcile_shape"
    CHECK ("status" <> 'reconcile' OR "failure_reason" IS NOT NULL),
  CONSTRAINT "earned_redemptions_refused_shape"
    CHECK ("status" <> 'refused' OR "failure_reason" IS NOT NULL),
  CONSTRAINT "earned_redemptions_delivered_shape"
    CHECK (
      "status" <> 'delivered'
      OR ("delivery_tx_signature" IS NOT NULL
        AND "delivery_clv_atomic" > 0
        AND "delivery_wallet_pubkey" IS NOT NULL
        AND "delivered_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "earned_redemptions_subject_idem_unique"
  ON "earned_redemptions" ("subject_type", "avatar_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "earned_redemptions_ledger_debit_unique"
  ON "earned_redemptions" ("ledger_debit_id") WHERE "ledger_debit_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "earned_redemptions_queue_unique"
  ON "earned_redemptions" ("clv_buy_queue_id") WHERE "clv_buy_queue_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "earned_redemptions_funding_unique"
  ON "earned_redemptions" ("clv_swap_funding_id") WHERE "clv_swap_funding_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "earned_redemptions_delivery_sig_unique"
  ON "earned_redemptions" ("delivery_tx_signature") WHERE "delivery_tx_signature" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "earned_redemptions_status_created_idx"
  ON "earned_redemptions" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "earned_redemptions_avatar_created_idx"
  ON "earned_redemptions" ("avatar_id", "created_at");
