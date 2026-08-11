-- Tier-1 USDC bounties reserve custodial balance in the database and settle
-- poster -> winner through agent-pay. No custody movement or chain escrow occurs.

CREATE TABLE IF NOT EXISTS "bounty_usdc_holds" (
  "bounty_id" uuid PRIMARY KEY REFERENCES "bounties"("id") ON DELETE RESTRICT,
  "poster_avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE RESTRICT,
  "amount_base_units" numeric(20, 0) NOT NULL,
  "settlement_attempt" integer NOT NULL DEFAULT 1,
  "status" varchar(16) NOT NULL DEFAULT 'open',
  "released_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bounty_usdc_holds_amount_positive" CHECK ("amount_base_units" > 0),
  CONSTRAINT "bounty_usdc_holds_settlement_attempt_bounded"
    CHECK ("settlement_attempt" BETWEEN 1 AND 5),
  CONSTRAINT "bounty_usdc_holds_status_valid"
    CHECK ("status" IN ('open', 'settled', 'released')),
  CONSTRAINT "bounty_usdc_holds_release_stamp"
    CHECK (("status" = 'open') = ("released_at" IS NULL))
);

CREATE INDEX IF NOT EXISTS "bounty_usdc_holds_poster_open_idx"
  ON "bounty_usdc_holds" ("poster_avatar_id", "created_at")
  WHERE "status" = 'open';

-- Safe when an earlier development copy of this additive migration already
-- created the hold table before bounded settlement retries were added.
ALTER TABLE "bounty_usdc_holds"
  ADD COLUMN IF NOT EXISTS "settlement_attempt" integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bounty_usdc_holds_settlement_attempt_bounded'
      AND conrelid = 'bounty_usdc_holds'::regclass
  ) THEN
    ALTER TABLE "bounty_usdc_holds"
      ADD CONSTRAINT "bounty_usdc_holds_settlement_attempt_bounded"
      CHECK ("settlement_attempt" BETWEEN 1 AND 5);
  END IF;
END $$;

ALTER TABLE "agent_payments"
  ADD COLUMN IF NOT EXISTS "count_cap_exempt" boolean NOT NULL DEFAULT false;

ALTER TABLE "agent_payments"
  ADD COLUMN IF NOT EXISTS "bounty_hold_id" uuid
  REFERENCES "bounty_usdc_holds"("bounty_id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_payments_bounty_hold_unique"
  ON "agent_payments" ("bounty_hold_id")
  WHERE "bounty_hold_id" IS NOT NULL;

COMMENT ON COLUMN "agent_payments"."count_cap_exempt" IS
  'Exempt from AGENT_PAY_DAILY_COUNT_CAP only; USD send/receive caps still apply.';

COMMENT ON COLUMN "agent_payments"."bounty_hold_id" IS
  'Tier-1 bounty hold backing this payment; NULL for ordinary agent-pay sends.';
