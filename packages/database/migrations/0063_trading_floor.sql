-- Trading Floor wave 1. Keep this file idempotent for CI bootstrap and deployment gates.
CREATE TABLE IF NOT EXISTS trading_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind varchar(8) NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  agent_id varchar(200) REFERENCES openclaw_bots(agent_id) ON DELETE CASCADE,
  pubkey varchar(44) NOT NULL,
  source varchar(16) NOT NULL,
  operated_by_clawville boolean NOT NULL DEFAULT false,
  metadata jsonb,
  bound_at timestamptz NOT NULL DEFAULT now(),
  bound_slot bigint NOT NULL,
  revoked_at timestamptz,
  cursor_signature varchar(128),
  cursor_block_time bigint,
  last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trading_wallets_subject_agent_consistent CHECK ((subject_kind = 'agent') = (agent_id IS NOT NULL)),
  CONSTRAINT trading_wallets_subject_kind_check CHECK (subject_kind IN ('avatar', 'agent')),
  CONSTRAINT trading_wallets_source_check CHECK (source IN ('linked', 'clawpump', 'custodial', 'signed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS trading_wallets_pubkey_active_unique
  ON trading_wallets (pubkey) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS trading_wallets_avatar_active_idx
  ON trading_wallets (avatar_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS trading_wallets_observer_idx
  ON trading_wallets (last_polled_at NULLS FIRST) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS verified_trades (
  signature varchar(128) PRIMARY KEY,
  trading_wallet_id uuid REFERENCES trading_wallets(id) ON DELETE SET NULL,
  subject_kind varchar(8) NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  avatar_id uuid REFERENCES avatars(id) ON DELETE SET NULL,
  agent_id varchar(200),
  wallet varchar(44) NOT NULL,
  dex varchar(16) NOT NULL,
  input_mint varchar(44) NOT NULL,
  output_mint varchar(44) NOT NULL,
  input_amount numeric(40,0) NOT NULL,
  output_amount numeric(40,0) NOT NULL,
  input_decimals smallint NOT NULL,
  output_decimals smallint NOT NULL,
  notional_usd numeric(20,6),
  notional_source varchar(16),
  multiplier_tier varchar(8) NOT NULL,
  scored boolean NOT NULL DEFAULT false,
  unscored_reason varchar(32),
  event_id bigint,
  block_time bigint,
  slot bigint NOT NULL,
  score_day date,
  verified_at timestamptz NOT NULL DEFAULT now(),
  decision_id text,
  source varchar(12) NOT NULL,
  CONSTRAINT verified_trades_subject_agent_consistent CHECK ((subject_kind = 'agent') = (agent_id IS NOT NULL)),
  CONSTRAINT verified_trades_subject_kind_check CHECK (subject_kind IN ('avatar', 'agent')),
  CONSTRAINT verified_trades_dex_check CHECK (dex IN ('jupiter', 'pumpswap', 'pumpfun')),
  CONSTRAINT verified_trades_notional_source_check CHECK (notional_source IS NULL OR notional_source IN ('usdc_leg', 'live_price')),
  CONSTRAINT verified_trades_multiplier_tier_check CHECK (multiplier_tier IN ('base', 'clv', 'ansem')),
  CONSTRAINT verified_trades_unscored_reason_check CHECK (unscored_reason IS NULL OR unscored_reason IN ('below_min_notional','price_unavailable','price_stale_window','pre_bind','chain_time_unavailable','pair_repeat_today','daily_cap')),
  CONSTRAINT verified_trades_source_check CHECK (source IN ('observer', 'report', 'prime')),
  CONSTRAINT verified_trades_scored_stamp CHECK ((scored = true) = (unscored_reason IS NULL)),
  CONSTRAINT verified_trades_scored_needs_chain_time CHECK (scored = false OR (slot IS NOT NULL AND block_time IS NOT NULL AND score_day IS NOT NULL)),
  CONSTRAINT verified_trades_amounts_positive CHECK (input_amount > 0 AND output_amount > 0),
  CONSTRAINT verified_trades_decimals_sane CHECK (input_decimals BETWEEN 0 AND 18 AND output_decimals BETWEEN 0 AND 18),
  CONSTRAINT verified_trades_notional_pair CHECK ((notional_usd IS NULL) = (notional_source IS NULL))
);

CREATE INDEX IF NOT EXISTS verified_trades_avatar_time_idx
  ON verified_trades (avatar_id, verified_at DESC);
CREATE INDEX IF NOT EXISTS verified_trades_feed_idx
  ON verified_trades (verified_at DESC);
CREATE INDEX IF NOT EXISTS verified_trades_daily_cap_idx
  ON verified_trades (avatar_id, verified_at) WHERE scored;

ALTER TABLE openclaw_bots
  ADD COLUMN IF NOT EXISTS leaderboard_eligible boolean NOT NULL DEFAULT true;

-- Add named checks when the table already existed before this migration ran.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_wallets_subject_agent_consistent') THEN
    ALTER TABLE trading_wallets ADD CONSTRAINT trading_wallets_subject_agent_consistent CHECK ((subject_kind = 'agent') = (agent_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_wallets_subject_kind_check') THEN
    ALTER TABLE trading_wallets ADD CONSTRAINT trading_wallets_subject_kind_check CHECK (subject_kind IN ('avatar', 'agent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trading_wallets_source_check') THEN
    ALTER TABLE trading_wallets ADD CONSTRAINT trading_wallets_source_check CHECK (source IN ('linked', 'clawpump', 'custodial', 'signed'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_subject_agent_consistent') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_subject_agent_consistent CHECK ((subject_kind = 'agent') = (agent_id IS NOT NULL)); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_subject_kind_check') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_subject_kind_check CHECK (subject_kind IN ('avatar', 'agent')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_dex_check') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_dex_check CHECK (dex IN ('jupiter', 'pumpswap', 'pumpfun')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_notional_source_check') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_notional_source_check CHECK (notional_source IS NULL OR notional_source IN ('usdc_leg', 'live_price')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_multiplier_tier_check') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_multiplier_tier_check CHECK (multiplier_tier IN ('base', 'clv', 'ansem')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_unscored_reason_check') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_unscored_reason_check CHECK (unscored_reason IS NULL OR unscored_reason IN ('below_min_notional','price_unavailable','price_stale_window','pre_bind','chain_time_unavailable','pair_repeat_today','daily_cap')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_source_check') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_source_check CHECK (source IN ('observer', 'report', 'prime')); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_scored_stamp') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_scored_stamp CHECK ((scored = true) = (unscored_reason IS NULL)); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_scored_needs_chain_time') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_scored_needs_chain_time CHECK (scored = false OR (slot IS NOT NULL AND block_time IS NOT NULL AND score_day IS NOT NULL)); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_amounts_positive') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_amounts_positive CHECK (input_amount > 0 AND output_amount > 0); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_decimals_sane') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_decimals_sane CHECK (input_decimals BETWEEN 0 AND 18 AND output_decimals BETWEEN 0 AND 18); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verified_trades_notional_pair') THEN ALTER TABLE verified_trades ADD CONSTRAINT verified_trades_notional_pair CHECK ((notional_usd IS NULL) = (notional_source IS NULL)); END IF;
END $$;
