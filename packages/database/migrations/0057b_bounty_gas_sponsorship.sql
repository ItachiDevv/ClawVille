-- Dedicated SAP bounty gas wallet + durable daily-cap reservations.
-- Apply after 0057a has committed the treasury enum extension.

CREATE UNIQUE INDEX IF NOT EXISTS treasury_wallets_sap_gas_sponsor_singleton
  ON treasury_wallets (purpose) WHERE purpose = 'sap-gas-sponsor';

CREATE TABLE IF NOT EXISTS bounty_gas_sponsorships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id uuid NOT NULL,
  leg text NOT NULL CHECK (leg IN ('settle', 'finalize')),
  worker_wallet text NOT NULL,
  lamports bigint NOT NULL CHECK (lamports > 0),
  status text NOT NULL CHECK (status IN ('pending', 'unconfirmed', 'confirmed', 'failed')),
  signature text,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bounty_gas_sponsorships_dedupe_unique
  ON bounty_gas_sponsorships (dedupe_key);

CREATE INDEX IF NOT EXISTS bounty_gas_sponsorships_daily_cap_idx
  ON bounty_gas_sponsorships (created_at, status);
