-- Spec 2 Phase B: durable Meridian fee accounting.
-- Idempotent because CI may retry a migration after a partial deploy.

ALTER TABLE "x402_settlement_receipts"
  ADD COLUMN IF NOT EXISTS "gross_usdc_atomic" bigint,
  ADD COLUMN IF NOT EXISTS "platform_fee_usdc_atomic" bigint,
  ADD COLUMN IF NOT EXISTS "treasury_fee_usdc_atomic" bigint,
  ADD COLUMN IF NOT EXISTS "net_usdc_atomic" bigint;

UPDATE "x402_settlement_receipts"
SET
  "gross_usdc_atomic" = COALESCE("gross_usdc_atomic", "amount_usdc_atomic"),
  "platform_fee_usdc_atomic" = COALESCE("platform_fee_usdc_atomic", 0),
  "treasury_fee_usdc_atomic" = COALESCE("treasury_fee_usdc_atomic", 0),
  "net_usdc_atomic" = COALESCE("net_usdc_atomic", "amount_usdc_atomic")
WHERE
  "gross_usdc_atomic" IS NULL
  OR "platform_fee_usdc_atomic" IS NULL
  OR "treasury_fee_usdc_atomic" IS NULL
  OR "net_usdc_atomic" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'x402_settlement_receipts_fee_conservation'
      AND conrelid = 'x402_settlement_receipts'::regclass
  ) THEN
    ALTER TABLE "x402_settlement_receipts"
      ADD CONSTRAINT "x402_settlement_receipts_fee_conservation"
      CHECK (
        (
          "gross_usdc_atomic" IS NULL
          AND "platform_fee_usdc_atomic" IS NULL
          AND "treasury_fee_usdc_atomic" IS NULL
          AND "net_usdc_atomic" IS NULL
        )
        OR (
        "gross_usdc_atomic" > 0
        AND "platform_fee_usdc_atomic" >= 0
        AND "treasury_fee_usdc_atomic" >= 0
        AND "net_usdc_atomic" > 0
        AND "amount_usdc_atomic" = "gross_usdc_atomic"
        AND "gross_usdc_atomic" =
          "net_usdc_atomic"
          + "platform_fee_usdc_atomic"
          + "treasury_fee_usdc_atomic"
        )
      );
  END IF;
END $$;

ALTER TABLE "agent_payments"
  ADD COLUMN IF NOT EXISTS "facilitator" varchar(32),
  ADD COLUMN IF NOT EXISTS "gross_usdc_atomic" numeric(20, 0),
  ADD COLUMN IF NOT EXISTS "platform_fee_usdc_atomic" numeric(20, 0),
  ADD COLUMN IF NOT EXISTS "treasury_fee_usdc_atomic" numeric(20, 0),
  ADD COLUMN IF NOT EXISTS "net_usdc_atomic" numeric(20, 0);

UPDATE "agent_payments"
SET
  "facilitator" = COALESCE("facilitator", 'payai'),
  "gross_usdc_atomic" = COALESCE("gross_usdc_atomic", "usdc_atomic"),
  "platform_fee_usdc_atomic" = COALESCE("platform_fee_usdc_atomic", 0),
  "treasury_fee_usdc_atomic" = COALESCE("treasury_fee_usdc_atomic", 0),
  "net_usdc_atomic" = COALESCE("net_usdc_atomic", "usdc_atomic")
WHERE
  "facilitator" IS NULL
  OR "gross_usdc_atomic" IS NULL
  OR "platform_fee_usdc_atomic" IS NULL
  OR "treasury_fee_usdc_atomic" IS NULL
  OR "net_usdc_atomic" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_payments_x402_fee_conservation'
      AND conrelid = 'agent_payments'::regclass
  ) THEN
    ALTER TABLE "agent_payments"
      ADD CONSTRAINT "agent_payments_x402_fee_conservation"
      CHECK (
        (
          "gross_usdc_atomic" IS NULL
          AND "platform_fee_usdc_atomic" IS NULL
          AND "treasury_fee_usdc_atomic" IS NULL
          AND "net_usdc_atomic" IS NULL
        )
        OR (
          "gross_usdc_atomic" > 0
          AND "platform_fee_usdc_atomic" >= 0
          AND "treasury_fee_usdc_atomic" >= 0
          AND "net_usdc_atomic" > 0
          AND "gross_usdc_atomic" =
            "net_usdc_atomic"
            + "platform_fee_usdc_atomic"
            + "treasury_fee_usdc_atomic"
        )
      );
  END IF;
END $$;
