-- 0030b_tokenomics_earned_backing.sql
-- Tokenomics E1/E2: gated EARNED import, sybil verification, dollar backing.
--
-- IDEMPOTENT DDL. DO NOT APPLY as part of this build. `treasury_purpose` enum
-- alteration requires statement-by-statement autocommit. Existing EARNED mints
-- are conservatively classified `none`: rail ④ paid the recipient, not the
-- house, so no historical dollar may be invented as backing.

DO $$ BEGIN
  CREATE TYPE earn_payer_verification AS ENUM ('pending', 'verified', 'rejected');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE earned_backing_kind AS ENUM ('backed', 'none');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE earned_consumption_kind AS ENUM ('spend', 'redemption', 'clawback');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE earned_ledger_account_kind AS ENUM
    ('mint', 'spend', 'redemption', 'clawback', 'legacy');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS earned_accounted_ledger (
  ledger_id uuid PRIMARY KEY REFERENCES claw_token_transactions(id) ON DELETE RESTRICT,
  kind earned_ledger_account_kind NOT NULL,
  accounted_at timestamptz NOT NULL DEFAULT now()
);

-- Exact deploy cutover: old app writers are blocked until backfill + membership
-- seed commit. Any old-writer EARNED row committed afterward lacks membership
-- regardless of transaction-start timestamps and is replayed by the new app.
LOCK TABLE avatars, claw_token_transactions IN SHARE ROW EXCLUSIVE MODE;

-- `0030a_earned_backing_purpose.sql` commits the enum value first. V1 has
-- exactly one backing wallet; rotation is an explicit proof-backed migration.
CREATE UNIQUE INDEX IF NOT EXISTS treasury_wallets_earned_backing_singleton
  ON treasury_wallets (purpose) WHERE purpose = 'earned-backing';

CREATE TABLE IF NOT EXISTS earn_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  earner_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE RESTRICT,
  payer_wallet varchar(64) NOT NULL,
  payer_cluster_key varchar(64) NOT NULL,
  first_funder_wallet varchar(64),
  source varchar(32) NOT NULL,
  backing_network varchar(16) NOT NULL,
  gross_usdc_atomic numeric(20,0) NOT NULL,
  rake_bps integer NOT NULL DEFAULT 0,
  vclaw_minted integer NOT NULL,
  ledger_id uuid REFERENCES claw_token_transactions(id) ON DELETE RESTRICT,
  payer_verification earn_payer_verification NOT NULL DEFAULT 'pending',
  verification_reason text,
  verified_at timestamptz,
  vests_at timestamptz NOT NULL,
  epoch_start timestamptz NOT NULL,
  clawed_back_at timestamptz,
  clawback_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earn_events_cent_aligned CHECK (
    gross_usdc_atomic > 0 AND MOD(gross_usdc_atomic, 10000) = 0
    AND vclaw_minted::numeric = gross_usdc_atomic / 10000
  ),
  CONSTRAINT earn_events_entry_rake_zero CHECK (rake_bps = 0),
  CONSTRAINT earn_events_backing_network_valid CHECK (
    backing_network IN ('mainnet', 'devnet')
  ),
  CONSTRAINT earn_events_verification_shape CHECK (
    (payer_verification = 'pending' AND verified_at IS NULL)
    OR (payer_verification = 'verified' AND verified_at IS NOT NULL
        AND first_funder_wallet IS NOT NULL)
    OR (payer_verification = 'rejected' AND verified_at IS NOT NULL
        AND verification_reason IS NOT NULL)
  ),
  CONSTRAINT earn_events_clawback_shape CHECK (
    (clawed_back_at IS NULL AND clawback_reason IS NULL)
    OR (clawed_back_at IS NOT NULL AND clawback_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS earn_events_idem_unique ON earn_events(idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS earn_events_ledger_unique ON earn_events(ledger_id)
  WHERE ledger_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS earn_events_earner_idx ON earn_events(earner_avatar_id, vests_at);
CREATE INDEX IF NOT EXISTS earn_events_pair_idx
  ON earn_events(payer_cluster_key, earner_avatar_id, created_at);
CREATE INDEX IF NOT EXISTS earn_events_verification_idx
  ON earn_events(payer_verification, created_at);

CREATE TABLE IF NOT EXISTS earn_wallet_epoch_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  payer_wallet varchar(64) NOT NULL,
  backing_network varchar(16) NOT NULL,
  earner_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE RESTRICT,
  epoch_start timestamptz NOT NULL,
  usdc_atomic numeric(20,0) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earn_wallet_epoch_nonnegative CHECK (usdc_atomic >= 0),
  CONSTRAINT earn_wallet_epoch_network_valid CHECK (backing_network IN ('mainnet', 'devnet'))
);
CREATE UNIQUE INDEX IF NOT EXISTS earn_wallet_epoch_unique
  ON earn_wallet_epoch_counters(backing_network, payer_wallet, earner_avatar_id, epoch_start);

CREATE TABLE IF NOT EXISTS earn_cluster_epoch_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  payer_cluster_key varchar(64) NOT NULL,
  backing_network varchar(16) NOT NULL,
  earner_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE RESTRICT,
  epoch_start timestamptz NOT NULL,
  usdc_atomic numeric(20,0) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earn_cluster_epoch_nonnegative CHECK (usdc_atomic >= 0),
  CONSTRAINT earn_cluster_epoch_network_valid CHECK (backing_network IN ('mainnet', 'devnet'))
);
CREATE UNIQUE INDEX IF NOT EXISTS earn_cluster_epoch_unique
  ON earn_cluster_epoch_counters(backing_network, payer_cluster_key, earner_avatar_id, epoch_start);

CREATE TABLE IF NOT EXISTS earn_payer_clusters (
  backing_network varchar(16) NOT NULL,
  payer_wallet varchar(64) NOT NULL,
  first_funder_wallet varchar(64) NOT NULL,
  cluster_key varchar(64) NOT NULL,
  wallet_age_seconds integer NOT NULL,
  signature_count integer NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT earn_payer_clusters_heuristic_nonnegative CHECK (
    wallet_age_seconds >= 0 AND signature_count >= 0
  ),
  CONSTRAINT earn_payer_clusters_network_valid CHECK (
    backing_network IN ('mainnet', 'devnet')
  ),
  CONSTRAINT earn_payer_clusters_network_payer_pk PRIMARY KEY (backing_network, payer_wallet)
);

-- All EARNED mints have a fungibility lot. Only backed lots get a row in the
-- physical earned_backing ledger below.
CREATE TABLE IF NOT EXISTS earned_mint_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  ledger_id uuid NOT NULL REFERENCES claw_token_transactions(id) ON DELETE RESTRICT,
  earn_event_id uuid REFERENCES earn_events(id) ON DELETE RESTRICT,
  avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE RESTRICT,
  backing_kind earned_backing_kind NOT NULL,
  mint_ref varchar(200) NOT NULL,
  original_vclaw integer NOT NULL,
  remaining_vclaw integer NOT NULL,
  exhausted_at timestamptz,
  released_at timestamptz,
  release_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earned_mint_lots_amount_shape CHECK (
    original_vclaw > 0 AND remaining_vclaw >= 0 AND remaining_vclaw <= original_vclaw
  ),
  CONSTRAINT earned_mint_lots_release_shape CHECK (
    (released_at IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND release_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS earned_mint_lots_ledger_unique
  ON earned_mint_lots(ledger_id);
CREATE UNIQUE INDEX IF NOT EXISTS earned_mint_lots_event_unique
  ON earned_mint_lots(earn_event_id) WHERE earn_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS earned_mint_lots_ref_unique
  ON earned_mint_lots(mint_ref);
CREATE INDEX IF NOT EXISTS earned_mint_lots_avatar_remaining_idx
  ON earned_mint_lots(avatar_id, backing_kind, created_at);

-- Physical ledger: a `none` lot can never appear here by construction.
CREATE TABLE IF NOT EXISTS earned_backing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  mint_lot_id uuid NOT NULL REFERENCES earned_mint_lots(id) ON DELETE RESTRICT,
  custody_wallet_id uuid NOT NULL REFERENCES treasury_wallets(id) ON DELETE RESTRICT,
  source_ref varchar(200) NOT NULL,
  original_usdc_atomic numeric(20,0) NOT NULL,
  remaining_usdc_atomic numeric(20,0) NOT NULL,
  consumed_usdc_atomic numeric(20,0) NOT NULL DEFAULT 0,
  released_usdc_atomic numeric(20,0) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earned_backing_conservation CHECK (
    original_usdc_atomic > 0 AND remaining_usdc_atomic >= 0
    AND consumed_usdc_atomic >= 0
    AND released_usdc_atomic >= 0
    AND original_usdc_atomic = remaining_usdc_atomic
      + consumed_usdc_atomic + released_usdc_atomic
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS earned_backing_lot_unique ON earned_backing(mint_lot_id);
CREATE UNIQUE INDEX IF NOT EXISTS earned_backing_source_unique ON earned_backing(source_ref);
CREATE INDEX IF NOT EXISTS earned_backing_custody_idx
  ON earned_backing(custody_wallet_id, updated_at);

CREATE TABLE IF NOT EXISTS earned_lot_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  mint_lot_id uuid NOT NULL REFERENCES earned_mint_lots(id) ON DELETE RESTRICT,
  ledger_debit_id uuid NOT NULL REFERENCES claw_token_transactions(id) ON DELETE RESTRICT,
  kind earned_consumption_kind NOT NULL,
  vclaw_amount integer NOT NULL,
  usdc_atomic numeric(20,0) NOT NULL,
  reference_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earned_lot_consumptions_positive CHECK (
    vclaw_amount > 0 AND usdc_atomic >= 0
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS earned_lot_consumptions_lot_ledger_unique
  ON earned_lot_consumptions(mint_lot_id, ledger_debit_id);
CREATE INDEX IF NOT EXISTS earned_lot_consumptions_reference_idx
  ON earned_lot_consumptions(kind, reference_id);

CREATE TABLE IF NOT EXISTS earn_clawbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  earn_event_id uuid NOT NULL REFERENCES earn_events(id) ON DELETE RESTRICT,
  requested_vclaw integer NOT NULL,
  debited_vclaw integer NOT NULL,
  deficit_vclaw integer NOT NULL,
  released_usdc_atomic numeric(20,0) NOT NULL,
  ledger_debit_id uuid REFERENCES claw_token_transactions(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  admin_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT earn_clawbacks_conservation CHECK (
    requested_vclaw > 0 AND debited_vclaw >= 0 AND deficit_vclaw >= 0
    AND requested_vclaw = debited_vclaw + deficit_vclaw
  ),
  CONSTRAINT earn_clawbacks_ledger_shape CHECK (
    (debited_vclaw = 0 AND ledger_debit_id IS NULL)
    OR (debited_vclaw > 0 AND ledger_debit_id IS NOT NULL)
  ),
  CONSTRAINT earn_clawbacks_release_nonnegative CHECK (released_usdc_atomic >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS earn_clawbacks_event_unique ON earn_clawbacks(earn_event_id);

-- Conservative legacy reconciliation. Positive historical EARNED ledger rows
-- become `none` lots. Current avatar.earned_balance is distributed newest-first
-- across those credits, equivalent to deterministic FIFO historical spending.
-- This is idempotent and deliberately creates NO physical backing rows.
WITH legacy_credits AS (
  SELECT
    l.id AS ledger_id,
    l.avatar_id,
    l.amount,
    l.created_at,
    a.earned_balance,
    COALESCE(
      SUM(l.amount) OVER (
        PARTITION BY l.avatar_id
        ORDER BY l.created_at DESC, l.id DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) AS newer_credit_total
  FROM claw_token_transactions l
  JOIN avatars a ON a.id = l.avatar_id
  WHERE l.provenance = 'earned' AND l.amount > 0
)
INSERT INTO earned_mint_lots (
  ledger_id, avatar_id, backing_kind, mint_ref, original_vclaw,
  remaining_vclaw, exhausted_at, metadata, created_at
)
SELECT
  ledger_id,
  avatar_id,
  'none'::earned_backing_kind,
  'legacy-ledger:' || ledger_id::text,
  amount,
  GREATEST(LEAST(amount, earned_balance - newer_credit_total), 0)::integer,
  CASE WHEN GREATEST(LEAST(amount, earned_balance - newer_credit_total), 0) = 0
       THEN now() ELSE NULL END,
  jsonb_build_object('legacyUnbacked', true, 'migration', '0030'),
  created_at
FROM legacy_credits
ON CONFLICT (ledger_id) DO NOTHING;

-- Seed exact membership only after the lot backfill. The table locks above
-- make this a complete snapshot; post-commit old-writer rows are unmarked.
INSERT INTO earned_accounted_ledger (ledger_id, kind)
SELECT id, 'legacy'::earned_ledger_account_kind
FROM claw_token_transactions
WHERE provenance = 'earned'
ON CONFLICT (ledger_id) DO NOTHING;

-- Kill the migration if lot accounting does not exactly explain the live
-- aggregate EARNED balance. Never deploy with a substitution hole.
DO $$
DECLARE mismatch_count bigint;
        backing_mismatch_count bigint;
BEGIN
  SELECT COUNT(*) INTO mismatch_count
  FROM avatars a
  LEFT JOIN (
    SELECT avatar_id, SUM(remaining_vclaw)::bigint AS lot_balance
    FROM earned_mint_lots GROUP BY avatar_id
  ) lots ON lots.avatar_id = a.id
  WHERE COALESCE(lots.lot_balance, 0) <> a.earned_balance::bigint;

  IF mismatch_count <> 0 THEN
    RAISE EXCEPTION '0030 EARNED lot backfill mismatch for % avatar(s)', mismatch_count;
  END IF;

  SELECT COUNT(*) INTO backing_mismatch_count
  FROM earned_mint_lots l
  LEFT JOIN earned_backing b ON b.mint_lot_id = l.id
  LEFT JOIN earn_events e ON e.id = l.earn_event_id
  LEFT JOIN claw_token_transactions ct ON ct.id = l.ledger_id
  WHERE (l.backing_kind = 'backed' AND (
      e.id IS NULL OR b.id IS NULL
      OR (SELECT COUNT(*) FROM treasury_wallets
          WHERE purpose = 'earned-backing') <> 1
      OR NOT EXISTS (SELECT 1 FROM treasury_wallets tw
          WHERE tw.purpose = 'earned-backing'
            AND tw.id = b.custody_wallet_id)
      OR b.original_usdc_atomic <> l.original_vclaw::numeric * 10000
      OR b.remaining_usdc_atomic <> l.remaining_vclaw::numeric * 10000
      OR e.vclaw_minted <> l.original_vclaw
      OR e.gross_usdc_atomic <> l.original_vclaw::numeric * 10000
      OR e.ledger_id IS DISTINCT FROM l.ledger_id
      OR e.earner_avatar_id IS DISTINCT FROM l.avatar_id
      OR ct.id IS NULL
      OR ct.provenance IS DISTINCT FROM 'earned'
      OR ct.amount IS DISTINCT FROM l.original_vclaw
      OR ct.avatar_id IS DISTINCT FROM l.avatar_id
    )) OR (l.backing_kind = 'none' AND b.id IS NOT NULL
      AND b.remaining_usdc_atomic <> 0);

  IF backing_mismatch_count <> 0 THEN
    RAISE EXCEPTION '0030 EARNED physical backing mismatch for % lot(s)', backing_mismatch_count;
  END IF;
END $$;
