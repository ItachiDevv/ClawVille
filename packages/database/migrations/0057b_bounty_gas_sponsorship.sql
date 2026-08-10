-- Bounty SOL sponsorship and expiry-refund capture. sap_escrow_withdrawals was
-- created by 0023b and already contains terminal rows on staging/production, so
-- every additive constraint below must validate against that legacy history.

CREATE UNIQUE INDEX IF NOT EXISTS treasury_wallets_sap_gas_sponsor_singleton
  ON treasury_wallets (purpose) WHERE purpose = 'sap-gas-sponsor';

CREATE TABLE IF NOT EXISTS bounty_gas_cap_policies (
  cap_day date PRIMARY KEY,
  cap_lamports bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bounty_gas_cap_policies_cap_positive CHECK (cap_lamports > 0)
);

CREATE TABLE IF NOT EXISTS bounty_gas_sponsorships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id uuid NOT NULL,
  leg text NOT NULL,
  worker_wallet text NOT NULL,
  lamports bigint NOT NULL,
  cap_day date NOT NULL,
  cap_lamports bigint NOT NULL,
  status text NOT NULL,
  signature text NOT NULL,
  serialized_transaction text NOT NULL,
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL,
  claim_id uuid,
  claimed_at timestamptz,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bounty_gas_sponsorships_leg_valid
    CHECK (leg IN ('settle', 'finalize')),
  CONSTRAINT bounty_gas_sponsorships_lamports_positive CHECK (lamports > 0),
  CONSTRAINT bounty_gas_sponsorships_cap_positive CHECK (cap_lamports > 0),
  CONSTRAINT bounty_gas_sponsorships_status_valid
    CHECK (status IN ('pending', 'unconfirmed', 'quarantined', 'confirmed', 'failed')),
  CONSTRAINT bounty_gas_sponsorships_claim_lease_pair
    CHECK ((claim_id IS NULL) = (claimed_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS bounty_gas_sponsorships_dedupe_unique
  ON bounty_gas_sponsorships (dedupe_key);

CREATE INDEX IF NOT EXISTS bounty_gas_sponsorships_cap_day_idx
  ON bounty_gas_sponsorships (cap_day, status);

ALTER TABLE bounties
  ADD COLUMN IF NOT EXISTS composition_refund_signature varchar(128),
  ADD COLUMN IF NOT EXISTS composition_refund_claim_id uuid,
  ADD COLUMN IF NOT EXISTS composition_refund_claimed_at timestamptz;

ALTER TABLE sap_escrow_withdrawals
  ADD COLUMN IF NOT EXISTS serialized_transaction text,
  ADD COLUMN IF NOT EXISTS blockhash varchar(128),
  ADD COLUMN IF NOT EXISTS last_valid_block_height bigint,
  ADD COLUMN IF NOT EXISTS claim_id uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

DO $$
BEGIN
  -- A partially-applied prerelease 0057b may already have the original status
  -- constraint. Upgrade it in place so `quarantined` is valid on rerun too.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bounty_gas_sponsorships'::regclass
      AND conname = 'bounty_gas_sponsorships_status_valid'
      AND pg_get_constraintdef(oid) LIKE '%quarantined%'
  ) THEN
    ALTER TABLE bounty_gas_sponsorships
      DROP CONSTRAINT IF EXISTS bounty_gas_sponsorships_status_valid;
    ALTER TABLE bounty_gas_sponsorships
      ADD CONSTRAINT bounty_gas_sponsorships_status_valid
      CHECK (status IN ('pending', 'unconfirmed', 'quarantined', 'confirmed', 'failed'))
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bounties'::regclass
      AND conname = 'bounties_composition_refund_claim_lease_pair'
  ) THEN
    ALTER TABLE bounties
      ADD CONSTRAINT bounties_composition_refund_claim_lease_pair
      CHECK (
        (composition_refund_claim_id IS NULL) =
        (composition_refund_claimed_at IS NULL)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bounties'::regclass
      AND conname = 'bounties_composition_refund_reconcile_has_signature'
  ) THEN
    ALTER TABLE bounties
      ADD CONSTRAINT bounties_composition_refund_reconcile_has_signature
      CHECK (
        composition_state <> 'reconcile_refund_unknown'
        OR composition_refund_signature IS NOT NULL
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'sap_escrow_withdrawals'::regclass
      AND conname = 'sap_escrow_withdrawals_capture_shape'
  ) THEN
    ALTER TABLE sap_escrow_withdrawals
      ADD CONSTRAINT sap_escrow_withdrawals_capture_shape
      CHECK (
        (
          status IN ('succeeded', 'broadcast_unknown')
          AND serialized_transaction IS NULL
          AND blockhash IS NULL
          AND last_valid_block_height IS NULL
        ) OR (
          status = 'in_flight'
          AND (
            (
              signature IS NULL
              AND serialized_transaction IS NULL
              AND blockhash IS NULL
              AND last_valid_block_height IS NULL
            ) OR (
              signature IS NOT NULL
              AND serialized_transaction IS NOT NULL
              AND blockhash IS NOT NULL
              AND last_valid_block_height IS NOT NULL
            )
          )
        ) OR (
          status IN ('succeeded', 'broadcast_unknown')
          AND signature IS NOT NULL
          AND serialized_transaction IS NOT NULL
          AND blockhash IS NOT NULL
          AND last_valid_block_height IS NOT NULL
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'sap_escrow_withdrawals'::regclass
      AND conname = 'sap_escrow_withdrawals_claim_lease_pair'
  ) THEN
    ALTER TABLE sap_escrow_withdrawals
      ADD CONSTRAINT sap_escrow_withdrawals_claim_lease_pair
      CHECK ((claim_id IS NULL) = (claimed_at IS NULL)) NOT VALID;
  END IF;
END $$;

ALTER TABLE bounties
  VALIDATE CONSTRAINT bounties_composition_refund_claim_lease_pair;
ALTER TABLE bounty_gas_sponsorships
  VALIDATE CONSTRAINT bounty_gas_sponsorships_status_valid;
ALTER TABLE bounties
  VALIDATE CONSTRAINT bounties_composition_refund_reconcile_has_signature;
ALTER TABLE sap_escrow_withdrawals
  VALIDATE CONSTRAINT sap_escrow_withdrawals_capture_shape;
ALTER TABLE sap_escrow_withdrawals
  VALIDATE CONSTRAINT sap_escrow_withdrawals_claim_lease_pair;
