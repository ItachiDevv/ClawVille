-- Tier-2 claim lease. Forward-only, additive, and safe while the feature flag is OFF.
-- The CI migration runner must execute this migration under SET LOCAL ROLE
-- clawville_tier2_owner, matching 0062b/0062c ownership.
DO $$
BEGIN
  IF current_user IS DISTINCT FROM 'clawville_tier2_owner' THEN
    RAISE EXCEPTION 'tier2_apply_owner_identity_invalid:%',current_user;
  END IF;
END $$;

ALTER TABLE public.bounty_attempts
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS bounty_attempts_tier2_claim_expiry_idx
  ON public.bounty_attempts (claim_expires_at,id)
  WHERE claim_expires_at IS NOT NULL AND status IN ('claimed','in_progress');

-- Slice-A route work executes under the dedicated NOINHERIT app role. Keep the
-- ordinary route tables writable only to the extent needed for draft creation,
-- claim leasing, review CAS, bonus rows, and immutable Covenant provenance.
GRANT SELECT ON TABLE public.bounties TO clawville_app;
GRANT SELECT (id,bounty_id,hunter_id,status,claim_expires_at)
  ON public.bounty_attempts TO clawville_app;
GRANT SELECT (id,action,subject_type,subject_id,actor_kind,payload,payload_hash,dedupe_key)
  ON public.covenant_action_records TO clawville_app;
GRANT SELECT (id,user_id,wallet_address) ON public.avatars TO clawville_app;
GRANT SELECT (id,linked_wallet_pubkey) ON public.users TO clawville_app;
GRANT INSERT
  (creator_id,title,description,requirements,difficulty,token_reward,max_attempts,
   tags,expires_at,payment_rail,acceptance_criteria,verdict_required,status)
ON public.bounties TO clawville_app;
GRANT UPDATE (current_attempts,updated_at) ON public.bounties TO clawville_app;
GRANT INSERT (bounty_id,hunter_id,status,claim_expires_at,claimed_at,created_at,updated_at)
  ON public.bounty_attempts TO clawville_app;
GRANT UPDATE (status,claim_expires_at,review_note,reviewed_at,updated_at)
  ON public.bounty_attempts TO clawville_app;
GRANT INSERT (bounty_id,reward_type,agent_config_id,book_id,custom_description)
  ON public.bounty_rewards TO clawville_app;
GRANT INSERT (action,subject_type,subject_id,actor_kind,payload,payload_hash,dedupe_key)
  ON public.covenant_action_records TO clawville_app;
GRANT USAGE,SELECT ON SEQUENCE public.covenant_action_records_seq_seq TO clawville_app;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid='public.bounty_attempts'::regclass
      AND attname='claim_expires_at' AND attnum>0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'tier2_claim_lock_column_missing';
  END IF;
  IF pg_catalog.to_regclass('public.bounty_attempts_tier2_claim_expiry_idx') IS NULL THEN
    RAISE EXCEPTION 'tier2_claim_lock_index_missing';
  END IF;
END $$;
