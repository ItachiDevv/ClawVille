-- Tier-2 USDC escrow database contract (frozen spec revision 18.1).
-- Forward-only, additive, and idempotent. This file is one implicit transaction.

CREATE SCHEMA IF NOT EXISTS tier2_trusted;
REVOKE ALL ON SCHEMA tier2_trusted FROM PUBLIC;

-- SECURITY DEFINER ownership is part of the contract, not a runner default.
-- The runner must SET ROLE to this pre-created, non-login owner before apply.
DO $$
DECLARE v_owner oid; v_login boolean; v_super boolean; v_bypass boolean;
BEGIN
  IF current_user IS DISTINCT FROM 'clawville_tier2_owner' THEN
    RAISE EXCEPTION 'tier2_apply_owner_identity_invalid:%',current_user;
  END IF;
  SELECT r.oid,r.rolcanlogin,r.rolsuper,r.rolbypassrls
    INTO v_owner,v_login,v_super,v_bypass
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user;
  IF NOT FOUND OR v_login OR v_super OR v_bypass THEN
    RAISE EXCEPTION 'tier2_apply_owner_attributes_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='clawville_app')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='clawville_ops')
  THEN RAISE EXCEPTION 'tier2_runtime_roles_missing'; END IF;
  IF pg_catalog.pg_has_role('clawville_app',current_user,'MEMBER')
     OR pg_catalog.pg_has_role('clawville_ops',current_user,'MEMBER')
     OR pg_catalog.pg_has_role(current_user,'clawville_app','MEMBER')
     OR pg_catalog.pg_has_role(current_user,'clawville_ops','MEMBER')
  THEN RAISE EXCEPTION 'tier2_owner_runtime_membership_forbidden'; END IF;
  IF (SELECT n.nspowner FROM pg_catalog.pg_namespace n
      WHERE n.nspname='tier2_trusted') IS DISTINCT FROM v_owner
  THEN RAISE EXCEPTION 'tier2_trusted_schema_owner_invalid'; END IF;
END $$;

-- Overlay preflight runs before any convergence DDL.  Missing route coordinates
-- and legacy sweep releases cannot be inferred safely, so abort without
-- partially applying later Stage-1f objects.
DO $$
DECLARE v_bad boolean; v_has_sweep boolean; v_has_capture_column boolean;
        v_liability regclass; v_evidence regclass;
BEGIN
  v_liability:=pg_catalog.to_regclass('public.bounty_tier2_liabilities');
  v_evidence:=pg_catalog.to_regclass('public.bounty_tier2_evidence');
  IF v_liability IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid=v_liability
         AND a.attname='custody_source' AND a.attnum>0 AND NOT a.attisdropped
     ) THEN
    EXECUTE $sql$
      SELECT EXISTS (
        SELECT 1 FROM public.bounty_tier2_liabilities l
        WHERE (l.kind='poster_prefund' AND l.asset_kind='usdc'
               AND (l.custody_source IS NULL OR l.alternate_dest IS NULL))
           OR (l.kind='poster_refund' AND l.custody_source IS NULL)
      )
    $sql$ INTO v_bad;
    IF v_bad THEN
      RAISE EXCEPTION 'tier2_prerequisite_failed: legacy liability route coordinates missing';
    END IF;
  END IF;
  IF v_evidence IS NOT NULL THEN
    EXECUTE $sql$
      SELECT EXISTS (
        SELECT 1 FROM public.bounty_tier2_evidence e
        WHERE e.leg='sweep_sol' AND e.kind='signature'
      )
    $sql$ INTO v_has_sweep;
    IF v_has_sweep THEN
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute a
        WHERE a.attrelid=v_evidence
          AND a.attname='sol_balance_capture_id' AND a.attnum>0 AND NOT a.attisdropped
      ) INTO v_has_capture_column;
      IF NOT v_has_capture_column
         OR pg_catalog.to_regclass('public.bounty_tier2_sol_balance_captures') IS NULL THEN
        RAISE EXCEPTION 'tier2_prerequisite_failed: legacy sweep lacks finalized balance capture';
      END IF;
      EXECUTE $sql$
        SELECT EXISTS (
          SELECT 1 FROM public.bounty_tier2_evidence e
          LEFT JOIN public.bounty_tier2_sol_balance_captures c
            ON c.id=e.sol_balance_capture_id
          WHERE e.leg='sweep_sol' AND e.kind='signature'
            AND (e.sol_balance_capture_id IS NULL OR c.id IS NULL)
        )
      $sql$ INTO v_bad;
      IF v_bad THEN
        RAISE EXCEPTION 'tier2_prerequisite_failed: legacy sweep lacks finalized balance capture';
      END IF;
    END IF;
  END IF;
END $$;

-- Rejected stage-1 signatures must not survive an overlay/re-apply.
DROP FUNCTION IF EXISTS public.consume_finalize_release(
  uuid,varchar,integer,integer,integer,integer,numeric,numeric,varchar,integer,boolean,text
);
DROP FUNCTION IF EXISTS public.tier2_transition(
  uuid,varchar,varchar,varchar,varchar,varchar,uuid
);
DROP FUNCTION IF EXISTS public.tier2_admit_bounty(
  uuid,varchar,varchar,varchar,varchar,integer,numeric,varchar,varchar,text,varchar,varchar
);
DROP FUNCTION IF EXISTS tier2_trusted.load_depositor(uuid,varchar,uuid);

-- ---------------------------------------------------------------------------
-- Parent coordinates and accounting fences
-- ---------------------------------------------------------------------------

ALTER TABLE public.bounties
  ADD COLUMN IF NOT EXISTS settlement_tier2 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tier2_mint varchar(64),
  ADD COLUMN IF NOT EXISTS tier2_cluster_genesis varchar(64),
  ADD COLUMN IF NOT EXISTS tier2_poster_wallet varchar(64),
  ADD COLUMN IF NOT EXISTS tier2_poster_usdc_ata varchar(64),
  ADD COLUMN IF NOT EXISTS tier2_vault_usdc_ata varchar(64),
  ADD COLUMN IF NOT EXISTS tier2_sol_return_address varchar(64),
  ADD COLUMN IF NOT EXISTS tier2_arithmetic_branch varchar(16),
  ADD COLUMN IF NOT EXISTS tier2_price_formula_version integer,
  ADD COLUMN IF NOT EXISTS payout_expected_atomic numeric(20,0),
  ADD COLUMN IF NOT EXISTS tier2_hunter_ata varchar(64),
  ADD COLUMN IF NOT EXISTS tier2_fee_state varchar(16),
  ADD COLUMN IF NOT EXISTS tier2_fee_budget_lamports numeric(20,0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tier2_fee_spent_lamports numeric(20,0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tier2_ops_grants bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tier2_last_grant_at timestamptz,
  ADD COLUMN IF NOT EXISTS tier2_cancel_intent_at timestamptz,
  ADD COLUMN IF NOT EXISTS tier2_cancel_intent_by uuid,
  ADD COLUMN IF NOT EXISTS price_prior_state varchar(32),
  ADD COLUMN IF NOT EXISTS ops_prior_state varchar(32),
  ADD COLUMN IF NOT EXISTS tier2_escrow_accounting_atomic numeric(20,0),
  ADD COLUMN IF NOT EXISTS tier2_pending_amount_atomic numeric(20,0),
  ADD COLUMN IF NOT EXISTS tier2_free_vault_balance_atomic numeric(20,0),
  ADD COLUMN IF NOT EXISTS tier2_balances_finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS tier2_balance_proof_id uuid,
  ADD COLUMN IF NOT EXISTS tier2_balance_proof_bounty uuid,
  ADD COLUMN IF NOT EXISTS tier2_balance_proof_leg varchar(24),
  ADD COLUMN IF NOT EXISTS tier2_balance_proof_kind varchar(24),
  ADD COLUMN IF NOT EXISTS tier2_vault_closed_proof_id uuid,
  ADD COLUMN IF NOT EXISTS tier2_poster_refund_reservation_operation uuid,
  ADD COLUMN IF NOT EXISTS tier2_poster_refund_reservation_leg varchar(24),
  ADD COLUMN IF NOT EXISTS tier2_poster_refund_reservation_generation bigint,
  ADD COLUMN IF NOT EXISTS composition_state varchar(32);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'b_t2_branch'
  ) THEN
    ALTER TABLE public.bounties ADD CONSTRAINT b_t2_branch CHECK (
      tier2_arithmetic_branch IS NULL OR tier2_arithmetic_branch IN
        ('A_plus_fee','B_grossed_up','C_house_funded')
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'b_t2_budget'
  ) THEN
    ALTER TABLE public.bounties ADD CONSTRAINT b_t2_budget CHECK (
      tier2_fee_budget_lamports >= 0
      AND tier2_fee_spent_lamports >= 0
      AND tier2_fee_budget_lamports <= 18446744073709551615
      AND tier2_fee_spent_lamports <= 18446744073709551615
      AND tier2_fee_spent_lamports <= tier2_fee_budget_lamports
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'b_t2_ops_grants'
  ) THEN
    ALTER TABLE public.bounties ADD CONSTRAINT b_t2_ops_grants
      CHECK (tier2_ops_grants >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'b_t2_cancel_intent_pair'
  ) THEN
    ALTER TABLE public.bounties ADD CONSTRAINT b_t2_cancel_intent_pair CHECK (
      (tier2_cancel_intent_at IS NULL) = (tier2_cancel_intent_by IS NULL)
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'b_t2_asset_uq'
  ) THEN
    ALTER TABLE public.bounties ADD CONSTRAINT b_t2_asset_uq
      UNIQUE (id, tier2_cluster_genesis);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'b_t2_claimable'
  ) THEN
    ALTER TABLE public.bounties ADD CONSTRAINT b_t2_claimable CHECK (
      settlement_tier2 IS NOT TRUE OR status = 'draft'
      OR (composition_state IS NOT NULL AND composition_state NOT IN
        ('fee_pending','fee_unresolved','funding_pending','vault_pending',
         'vault_confirmed','vault_unconfirmed'))
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'b_t2_admission_shape'
  ) THEN
    ALTER TABLE public.bounties ADD CONSTRAINT b_t2_admission_shape CHECK (
      settlement_tier2 IS NOT TRUE OR status = 'draft' OR (
        tier2_mint IS NOT NULL
        AND tier2_cluster_genesis IS NOT NULL
        AND tier2_poster_usdc_ata IS NOT NULL
        AND tier2_arithmetic_branch IS NOT NULL
        AND tier2_price_formula_version IS NOT NULL
        AND payout_expected_atomic IS NOT NULL
        AND tier2_hunter_ata IS NOT NULL
        AND payout_expected_atomic > 0
        AND payout_expected_atomic <= 18446744073709551615
      )
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'b_t2_base58_shape'
  ) THEN
    ALTER TABLE public.bounties ADD CONSTRAINT b_t2_base58_shape CHECK (
      (tier2_mint IS NULL OR tier2_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
      AND (tier2_cluster_genesis IS NULL OR tier2_cluster_genesis ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
      AND (tier2_poster_usdc_ata IS NULL OR tier2_poster_usdc_ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
      AND (tier2_hunter_ata IS NULL OR tier2_hunter_ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'b_t2_chain_balances'
  ) THEN
    ALTER TABLE public.bounties ADD CONSTRAINT b_t2_chain_balances CHECK (
      (tier2_escrow_accounting_atomic IS NULL OR tier2_escrow_accounting_atomic BETWEEN 0 AND 18446744073709551615)
      AND (tier2_pending_amount_atomic IS NULL OR tier2_pending_amount_atomic BETWEEN 0 AND 18446744073709551615)
      AND (tier2_free_vault_balance_atomic IS NULL OR tier2_free_vault_balance_atomic BETWEEN 0 AND 18446744073709551615)
      AND num_nonnulls(tier2_balances_finalized_at,tier2_balance_proof_id,
                       tier2_balance_proof_bounty,tier2_balance_proof_leg,
                       tier2_balance_proof_kind) IN (0,5)
      AND (tier2_balances_finalized_at IS NULL OR
        num_nonnulls(tier2_escrow_accounting_atomic,tier2_pending_amount_atomic,
                     tier2_free_vault_balance_atomic)=3)
      AND (tier2_balance_proof_bounty IS NULL OR tier2_balance_proof_bounty=id)
    );
  END IF;
END $$;

-- Converge the frozen route-coordinate shape on rejected overlays as well as
-- clean databases.  These are independent roles; admission refuses aliases.
ALTER TABLE public.bounties DROP CONSTRAINT IF EXISTS b_t2_admission_shape;
ALTER TABLE public.bounties ADD CONSTRAINT b_t2_admission_shape CHECK (
  settlement_tier2 IS NOT TRUE OR status = 'draft' OR (
    tier2_mint IS NOT NULL
    AND tier2_cluster_genesis IS NOT NULL
    AND tier2_poster_wallet IS NOT NULL
    AND tier2_poster_usdc_ata IS NOT NULL
    AND tier2_vault_usdc_ata IS NOT NULL
    AND tier2_sol_return_address IS NOT NULL
    AND tier2_arithmetic_branch IS NOT NULL
    AND tier2_price_formula_version IS NOT NULL
    AND payout_expected_atomic IS NOT NULL
    AND tier2_hunter_ata IS NOT NULL
    AND payout_expected_atomic > 0
    AND payout_expected_atomic <= 18446744073709551615
  )
);
ALTER TABLE public.bounties DROP CONSTRAINT IF EXISTS b_t2_base58_shape;
ALTER TABLE public.bounties ADD CONSTRAINT b_t2_base58_shape CHECK (
  (tier2_mint IS NULL OR tier2_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  AND (tier2_cluster_genesis IS NULL OR tier2_cluster_genesis ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  AND (tier2_poster_wallet IS NULL OR tier2_poster_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  AND (tier2_poster_usdc_ata IS NULL OR tier2_poster_usdc_ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  AND (tier2_vault_usdc_ata IS NULL OR tier2_vault_usdc_ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  AND (tier2_sol_return_address IS NULL OR tier2_sol_return_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  AND (tier2_hunter_ata IS NULL OR tier2_hunter_ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
ALTER TABLE public.bounties DROP CONSTRAINT IF EXISTS b_t2_route_coordinates_distinct;
ALTER TABLE public.bounties ADD CONSTRAINT b_t2_route_coordinates_distinct CHECK (
  settlement_tier2 IS NOT TRUE OR status = 'draft' OR
  (tier2_poster_wallet <> ALL(ARRAY[tier2_poster_usdc_ata,tier2_vault_usdc_ata,
                                    tier2_sol_return_address,tier2_hunter_ata])
   AND tier2_poster_usdc_ata <> ALL(ARRAY[tier2_vault_usdc_ata,
                                          tier2_sol_return_address,tier2_hunter_ata])
   AND tier2_vault_usdc_ata <> ALL(ARRAY[tier2_sol_return_address,tier2_hunter_ata])
   AND tier2_sol_return_address<>tier2_hunter_ata)
);

CREATE OR REPLACE FUNCTION public.tier2_register_provider(
  p_provider varchar,p_endpoint_fingerprint varchar,p_identity_version integer,
  p_operator varchar,p_failure_domain varchar,p_archival boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_provider IS NULL OR p_endpoint_fingerprint IS NULL
     OR p_endpoint_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_identity_version IS NULL OR p_identity_version<1
     OR p_operator IS NULL OR length(btrim(p_operator))=0
     OR p_failure_domain IS NULL OR length(btrim(p_failure_domain))=0
     OR p_archival IS NULL
  THEN RAISE EXCEPTION 'tier2_provider_registration_invalid'; END IF;
  IF EXISTS (SELECT 1 FROM public.tier2_rpc_providers p
    WHERE p.provider_id=p_provider AND p.endpoint_fingerprint=p_endpoint_fingerprint
      AND p.identity_version=p_identity_version AND p.operator_identity=p_operator
      AND p.failure_domain=p_failure_domain AND p.archival=p_archival AND p.active) THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tier2_rpc_providers p
             WHERE p.provider_id=p_provider AND p.identity_version=p_identity_version)
  THEN RAISE EXCEPTION 'tier2_provider_version_conflict_or_inactive'; END IF;
  INSERT INTO public.tier2_rpc_providers
    (provider_id,endpoint_fingerprint,identity_version,operator_identity,
     failure_domain,archival,active)
    VALUES (p_provider,p_endpoint_fingerprint,p_identity_version,p_operator,
            p_failure_domain,p_archival,true);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_deactivate_provider(
  p_provider varchar,p_identity_version integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_active boolean;
BEGIN
  IF p_provider IS NULL OR p_identity_version IS NULL OR p_identity_version<1
  THEN RAISE EXCEPTION 'tier2_provider_deactivation_invalid'; END IF;
  SELECT p.active INTO v_active FROM public.tier2_rpc_providers p
    WHERE p.provider_id=p_provider AND p.identity_version=p_identity_version
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_provider_identity_missing'; END IF;
  IF v_active IS FALSE THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.bounty_tier2_settle_captures c
             WHERE c.provider_id=p_provider
               AND c.provider_identity_version=p_identity_version)
  THEN RAISE EXCEPTION 'tier2_provider_version_in_use'; END IF;
  UPDATE public.tier2_rpc_providers SET active=false
    WHERE provider_id=p_provider AND identity_version=p_identity_version
      AND active IS TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_provider_deactivation_cas_lost'; END IF;
  RETURN true;
END $$;

-- Closed-world generation/checkpoint admission. Every one of the 18 operation
-- legs and the bounty sentinel is classified; NULL/unknown/terminal states and
-- unknown legs return false.
CREATE OR REPLACE FUNCTION public.t2_leg_state_admitted(
  p_leg varchar,p_state varchar
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_leg
    WHEN 'fee_charge' THEN p_state IN ('fee_pending')
    WHEN 'fee_refund' THEN p_state IN ('create_failed','refund_pending','cleanup_pending')
    WHEN 'funding_sol' THEN p_state IN ('funding_pending')
    WHEN 'funding_usdc' THEN p_state IN ('funding_pending')
    WHEN 'pricing_publish' THEN p_state IN ('funding_pending','vault_pending')
    WHEN 'vault_open' THEN p_state IN ('vault_pending')
    WHEN 'settle' THEN p_state IN ('vault_held','settle_exhausted')
    WHEN 'finalize' THEN p_state IN ('awaiting_finalize','finalize_exhausted')
    WHEN 'payout' THEN p_state IN ('payout_ready','reconcile_payout_failed')
    WHEN 'house_refund_to_poster' THEN p_state IN ('refund_pending')
    WHEN 'withdraw_dust_usdc' THEN p_state IN ('cleanup_pending')
    WHEN 'sweep_dust_usdc' THEN p_state IN ('cleanup_pending')
    WHEN 'refund_withdraw_usdc' THEN
      p_state IN ('vault_held','settle_exhausted','create_failed','refund_pending')
    WHEN 'refund_sweep_usdc' THEN
      p_state IN ('vault_held','settle_exhausted','create_failed','refund_pending')
    WHEN 'close_pending' THEN
      p_state IN ('awaiting_finalize','payout_ready','cleanup_pending')
    WHEN 'close_depositor_ata' THEN p_state IN ('cleanup_pending','refund_pending')
    WHEN 'close_escrow' THEN p_state IN ('cleanup_pending','refund_pending')
    WHEN 'sweep_sol' THEN p_state IN ('cleanup_pending','refund_pending')
    WHEN 'bounty' THEN false
    ELSE false
  END IS TRUE
$$;

-- Canonical digest of the immutable normalized payment coordinate. It is not a
-- Solana decoder: Stage 2 must still prove that the normalized coordinate came
-- from message_bytes. The separators and numeric cast make the encoding stable.
CREATE OR REPLACE FUNCTION public.t2_payment_coordinate_digest(
  p_bounty uuid,p_leg varchar,p_operation uuid,p_generation bigint,
  p_amount numeric,p_destination varchar
) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT pg_catalog.sha256(pg_catalog.convert_to(
    'tier2-payment-v1'||pg_catalog.chr(31)||p_bounty::text||pg_catalog.chr(31)||
    p_leg||pg_catalog.chr(31)||p_operation::text||pg_catalog.chr(31)||
    p_generation::text||pg_catalog.chr(31)||p_amount::numeric(20,0)::text||
    pg_catalog.chr(31)||p_destination,'UTF8'))
$$;

CREATE OR REPLACE FUNCTION public.tier2_admit_bounty(
  p_bounty uuid,p_mint varchar,p_genesis varchar,p_poster_wallet varchar,
  p_poster_ata varchar,p_vault_ata varchar,p_sol_return varchar,
  p_branch varchar,p_formula_version integer,p_payout_atomic numeric,
  p_hunter_ata varchar,p_depositor_public_key varchar,p_depositor_usdc_ata varchar,
  p_encrypted_secret text,
  p_encryption_iv varchar,p_encryption_tag varchar
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_status public.bounty_status; v_tier2 boolean; v_state varchar(32);
        v_auto numeric;
BEGIN
  SELECT b.status,b.settlement_tier2,b.composition_state INTO v_status,v_tier2,v_state
    FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  IF v_tier2 THEN RAISE EXCEPTION 'tier2_bounty_already_admitted'; END IF;
  IF v_status<>'draft' OR v_state IS NOT NULL
  THEN RAISE EXCEPTION 'tier2_admission_requires_uninitialized_draft'; END IF;
  IF p_mint IS NULL OR p_mint !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_genesis IS NULL OR p_genesis !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_poster_wallet IS NULL OR p_poster_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_poster_ata IS NULL OR p_poster_ata !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_vault_ata IS NULL OR p_vault_ata !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_sol_return IS NULL OR p_sol_return !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_hunter_ata IS NULL OR p_hunter_ata !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_depositor_public_key IS NULL
     OR p_depositor_public_key !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_depositor_usdc_ata IS NULL
     OR p_depositor_usdc_ata !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR cardinality(ARRAY(
          SELECT DISTINCT x FROM unnest(ARRAY[p_poster_wallet,p_poster_ata,
            p_depositor_public_key,p_depositor_usdc_ata,p_vault_ata,p_hunter_ata,
            p_sol_return]) x
        ))<>7
     OR p_branch IS NULL OR p_branch NOT IN ('A_plus_fee','B_grossed_up','C_house_funded')
     OR p_formula_version IS NULL OR p_formula_version<1
     OR p_payout_atomic IS NULL OR p_payout_atomic<>trunc(p_payout_atomic)
     OR p_payout_atomic NOT BETWEEN 1 AND 18446744073709551615
     OR p_encrypted_secret IS NULL OR length(p_encrypted_secret)=0
     OR p_encryption_iv IS NULL OR length(p_encryption_iv)=0
     OR p_encryption_tag IS NULL OR length(p_encryption_tag)=0
  THEN RAISE EXCEPTION 'tier2_admission_coordinate_invalid'; END IF;
  SELECT p.value_num INTO v_auto FROM public.tier2_policy p
    WHERE p.key='automatic_fee_budget_lamports' AND p.value_num=trunc(p.value_num)
      AND p.value_num BETWEEN 250000 AND 2500000;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_policy_automatic_budget_out_of_range'; END IF;
  PERFORM public.t2_authorize_transition(
    p_bounty,NULL,'fee_pending','admission','','',NULL);
  UPDATE public.bounties SET settlement_tier2=true,tier2_mint=p_mint,
    tier2_cluster_genesis=p_genesis,tier2_poster_wallet=p_poster_wallet,
    tier2_poster_usdc_ata=p_poster_ata,tier2_vault_usdc_ata=p_vault_ata,
    tier2_sol_return_address=p_sol_return,
    tier2_arithmetic_branch=p_branch,tier2_price_formula_version=p_formula_version,
    payout_expected_atomic=p_payout_atomic,tier2_hunter_ata=p_hunter_ata,
    tier2_fee_state='pending',tier2_fee_budget_lamports=v_auto,
    tier2_fee_spent_lamports=0,tier2_ops_grants=0,composition_state='fee_pending'
    WHERE id=p_bounty;
  INSERT INTO public.bounty_tier2_assets
    (bounty_id,asset_kind,mint,cluster_genesis) VALUES
    (p_bounty,'usdc',p_mint,p_genesis),
    (p_bounty,'sol','So11111111111111111111111111111111111111112',p_genesis);
  INSERT INTO public.bounty_tier2_depositors
    (bounty_id,public_key,usdc_ata,encrypted_secret_key,encryption_iv,encryption_tag)
    VALUES (p_bounty,p_depositor_public_key,p_depositor_usdc_ata,p_encrypted_secret,
            p_encryption_iv,p_encryption_tag);
  INSERT INTO public.bounty_tier2_op_control
    (bounty_id,leg,auto_attempts,last_generation,live_generation,live_operation_id,
     succeeded_generation,succeeded_operation_id,succeeded_at) VALUES
    (p_bounty,'fee_charge',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'fee_refund',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'funding_sol',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'funding_usdc',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'pricing_publish',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'vault_open',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'settle',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'finalize',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'payout',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'house_refund_to_poster',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'withdraw_dust_usdc',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'sweep_dust_usdc',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'refund_withdraw_usdc',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'refund_sweep_usdc',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'close_pending',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'close_depositor_ata',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'close_escrow',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'sweep_sol',0,0,NULL,NULL,NULL,NULL,NULL),
    (p_bounty,'bounty',0,0,NULL,NULL,NULL,NULL,NULL);
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty ORDER BY c.leg FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty ORDER BY o.leg,o.generation FOR UPDATE;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_open_automatic_generation(
  p_bounty uuid,p_leg varchar
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_succeeded uuid; v_live uuid; v_last bigint; v_attempts integer; v_ng bigint; v_op uuid;
        v_composition_state varchar(32);
BEGIN
  SELECT b.composition_state INTO v_composition_state FROM public.bounties b
    WHERE b.id=p_bounty AND b.settlement_tier2 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found_or_not_admitted'; END IF;
  SELECT c.succeeded_operation_id,c.live_operation_id,c.last_generation,c.auto_attempts
    INTO v_succeeded,v_live,v_last,v_attempts FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=p_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg ORDER BY o.generation FOR UPDATE;
  IF NOT public.t2_leg_state_admitted(p_leg,v_composition_state)
  THEN RAISE EXCEPTION 'tier2_generation_leg_illegal_in_state:%:%',p_leg,v_composition_state; END IF;
  IF p_leg IN ('fee_charge','fee_refund','funding_sol','funding_usdc','vault_open',
               'settle','payout','house_refund_to_poster') AND v_succeeded IS NOT NULL
  THEN RAISE EXCEPTION 'tier2_once_only_already_succeeded'; END IF;
  IF v_live IS NOT NULL THEN RAISE EXCEPTION 'tier2_live_operation_exists'; END IF;
  IF v_attempts>=3 THEN RAISE EXCEPTION 'tier2_automatic_attempts_exhausted'; END IF;
  IF EXISTS (SELECT 1 FROM public.bounty_tier2_operations o
             WHERE o.bounty_id=p_bounty AND o.leg=p_leg AND o.state='broadcast_unknown')
  THEN RAISE EXCEPTION 'tier2_unknown_blocks_generation'; END IF;
  SELECT greatest(v_last,coalesce(max(o.generation),0))+1 INTO v_ng
    FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg;
  INSERT INTO public.bounty_tier2_operations (bounty_id,leg,generation,state)
    VALUES (p_bounty,p_leg,v_ng,'pending') RETURNING id INTO v_op;
  UPDATE public.bounty_tier2_op_control SET last_generation=v_ng,
    live_generation=v_ng,live_operation_id=v_op,auto_attempts=auto_attempts+1,
    updated_at=statement_timestamp() WHERE bounty_id=p_bounty AND leg=p_leg;
  RETURN v_op;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_claim_operation(
  p_bounty uuid,p_leg varchar,p_operation uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_live uuid; v_succeeded uuid; v_claim uuid;
BEGIN
  PERFORM 1 FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT c.live_operation_id,c.succeeded_operation_id INTO v_live,v_succeeded
    FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=p_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg ORDER BY o.generation FOR UPDATE;
  IF v_live IS DISTINCT FROM p_operation THEN RAISE EXCEPTION 'tier2_claim_not_live_operation'; END IF;
  IF p_leg IN ('fee_charge','fee_refund','funding_sol','funding_usdc','vault_open',
               'settle','payout','house_refund_to_poster') AND v_succeeded IS NOT NULL
  THEN RAISE EXCEPTION 'tier2_once_only_already_succeeded'; END IF;
  v_claim:=gen_random_uuid();
  UPDATE public.bounty_tier2_operations SET state='claimed',claim_id=v_claim,
    claim_expires_at=statement_timestamp()+interval '5 minutes',claimed_at=statement_timestamp()
    WHERE id=p_operation AND bounty_id=p_bounty AND leg=p_leg AND state='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_claim_cas_lost'; END IF;
  RETURN v_claim;
END $$;


-- ---------------------------------------------------------------------------
-- Frozen 70-row transition policy
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.bounty_tier2_transitions (
  old_state varchar(32) NOT NULL,
  new_state varchar(32) NOT NULL,
  actor varchar(16) NOT NULL,
  evidence_kind varchar(24) NOT NULL DEFAULT '',
  leg varchar(24) NOT NULL DEFAULT '',
  guard text NOT NULL,
  PRIMARY KEY (old_state,new_state,actor,evidence_kind,leg)
);

INSERT INTO public.bounty_tier2_transitions
  (old_state,new_state,actor,evidence_kind,leg,guard) VALUES
('fee_pending','funding_pending','driver','signature','fee_charge','fee_charge finalized AND tier2_fee_state=paid'),
('fee_pending','fee_unresolved','driver','','','fee AMBIGUOUS (broadcast_unknown); holds for exact proof; NO liability opens'),
('fee_pending','cancelled','driver','sends_expired','fee_charge','fee definitively NOT broadcast; nothing charged'),
('fee_pending','cancelled','poster','','','poster cancel before any charge'),
('fee_unresolved','funding_pending','driver','signature','fee_charge','exact landed proof arrived'),
('fee_unresolved','cancelled','driver','sends_expired','fee_charge','exact not-broadcast proof arrived'),
('funding_pending','vault_pending','driver','signature','funding_usdc','funding_sol AND funding_usdc finalized; BOTH asset rows present; both depositor liabilities open'),
('funding_pending','create_failed','driver','','','EVERY funding generation definitively expired/not-broadcast; a broadcast_unknown generation BLOCKS this edge'),
('funding_pending','create_failed','poster','','','poster cancel before vault open'),
('vault_pending','vault_confirmed','driver','signature','vault_open','funded stamp at confirmed'),
('vault_pending','vault_unconfirmed','reconciler','','','ambiguous send'),
('vault_pending','create_failed','driver','sends_expired','vault_open','capture provably not broadcast or expired AND budget exhausted'),
('vault_confirmed','vault_held','reconciler','signature','vault_open','finalized funding proof; exactly one usdc + one sol asset row; ATOMIC with status draft->open'),
('vault_confirmed','vault_unconfirmed','reconciler','','','fork observed after confirm'),
('vault_unconfirmed','vault_held','reconciler','signature','vault_open','finalized escrow existence + fingerprint; ATOMIC with status draft->open'),
('vault_unconfirmed','create_failed','reconciler','sends_expired','vault_open','capture finalized-expired AND escrow absent at finalized'),
('vault_held','awaiting_finalize','settle','signature','settle','settle finalized AND SettlementPendingEvent snapshot persisted'),
('vault_held','settle_snapshot_ops_pending','driver','','','settle finalized but the event is UNRECOVERABLE-AFTER-WINDOW, PROVABLY TRUNCATED, or DIVERGENT after the rung-A/B ladder'),
('awaiting_finalize','settle_snapshot_ops_pending','driver','','','SNAPSHOT CONFLICT: the finalized descendant transfer contradicts the stored pending_amount; snapshot stamped superseded; rung-D re-enters'),
('settle_snapshot_ops_pending','awaiting_finalize','driver','signature','settle','the event became available on some provider; the snapshot is persisted/observed in THIS transaction. Routing to vault_held is DELETED (B1): the settle already landed, and vault_held would make a second settle state-legal'),
('settle_snapshot_ops_pending','awaiting_finalize','ops','ops_settle_derivation','bounty','derived pending PDA + chain-proven credited amount from the finalize transfer; ops AUTHORIZES the path, never the amount'),
('awaiting_finalize','arithmetic_branch_violation','driver','arithmetic_violation','bounty','the finalized credited amount contradicts the persisted branch/formula or exceeds the Branch-C cap; one-shot evidence'),
('arithmetic_branch_violation','payout_ready','ops','ops_release','bounty','ops reviewed; chain-proved credit is within an approved revised cap; reward_payout stays OPEN and releases normally via payout'),
('arithmetic_branch_violation','refund_pending','ops','arithmetic_violation','bounty','ONE locked transaction (consume_arithmetic_violation): consume the one-shot arithmetic_violation and CANCEL reward_payout with it as cancel proof, ALWAYS. Then branch on the chain-proved credit A: A>0 opens house_poster_refund for exactly A to bounties.tier2_poster_usdc_ata; A=0 opens NO liability and NO send. Both branches proceed to residual vault reconciliation. Hunter is NOT paid and is notified. Mutual exclusion with the payout_ready exit comes from this LOCKED current-state transition, not from t2ev_one_arith'),
('vault_held','refund_pending','driver','signature','refund_withdraw_usdc','FULL free-balance withdraw finalized AND post-withdraw escrow balance=0 AND pending_amount=0'),
('vault_held','settle_exhausted','seam_guard','','','settle auto_attempts = 3; sets ops_prior_state'),
('vault_held','price_blocked','seam_guard','','','price out of bound; sets price_prior_state'),
('awaiting_finalize','payout_ready','driver','finalize_release','bounty','exact trace-coordinate finalize proof consumed'),
('awaiting_finalize','finalize_exhausted','seam_guard','','','finalize auto_attempts = 3'),
('awaiting_finalize','price_blocked','seam_guard','','','price out of bound; sets price_prior_state'),
('payout_ready','cleanup_pending','payout','signature','payout','payout release row exists AND reserve fence held — the hunter is PAID here'),
('payout_ready','reconcile_payout_failed','payout','','','definitive payout failure, no send outstanding'),
('payout_ready','price_blocked','seam_guard','','','price out of bound; sets price_prior_state'),
('reconcile_payout_failed','cleanup_pending','payout','signature','payout','payout release row exists AND reserve fence held'),
('reconcile_payout_failed','payout_ready','driver','','','automatic retry admitted within auto_attempts'),
('reconcile_payout_failed','payout_ready','ops','ops_continue','payout','audited continuation grant; auto_attempts reset AND fee budget renewed; broadcast_unknown still blocks; once-only succeeded marker still blocks'),
('cleanup_pending','paid','driver','','','EVERY liability disposition <> open AND escrow accounting zero AND close stamps present or capped accepted_nonrecoverable recorded'),
('cleanup_pending','price_blocked','seam_guard','','','price out of bound; sets price_prior_state'),
('settle_exhausted','awaiting_finalize','ops','signature','settle','a settle landed finalized AND its event snapshot persisted'),
('settle_exhausted','refund_pending','driver','signature','refund_withdraw_usdc','no pending exists; FULL withdraw finalized AND zero accounting'),
('settle_exhausted','vault_held','ops','ops_continue','settle','audited continuation grant; refused if the once-only succeeded marker is set'),
('finalize_exhausted','payout_ready','driver','finalize_release','bounty','exact trace-coordinate finalize proof consumed'),
('finalize_exhausted','awaiting_finalize','ops','ops_continue','finalize','audited continuation grant; auto_attempts reset AND fee budget renewed'),
('price_blocked','vault_held','driver','price_revalidated','bounty','price_prior_state = vault_held'),
('price_blocked','awaiting_finalize','driver','price_revalidated','bounty','price_prior_state = awaiting_finalize'),
('price_blocked','payout_ready','driver','price_revalidated','bounty','price_prior_state = payout_ready'),
('price_blocked','cleanup_pending','driver','price_revalidated','bounty','price_prior_state = cleanup_pending'),
('create_failed','refund_pending','driver','','','at least one open liability OR a vault withdrawal is required'),
('create_failed','cancelled','driver','','','NO open liability and no assets moved, proved by definitive absence/expiry of EVERY fee and funding operation'),
('refund_pending','refunded','driver','','','EVERY liability for this bounty has disposition <> open, each by its exact finalized proof, AND at finalized commitment escrow accounting = 0 AND pending_amount = 0 AND free vault balance = 0. Any chain-proved residual routes through the EXISTING refund_withdraw_usdc -> poster_refund -> refund_sweep_usdc machinery before this edge is legal'),
('vault_held','ops_hold','alarm','','','INVARIANT: is_disputed observed; sets ops_prior_state'),
('settle_snapshot_ops_pending','ops_hold','alarm','','','INVARIANT: is_disputed observed; sets ops_prior_state'),
('awaiting_finalize','ops_hold','alarm','','','INVARIANT: is_disputed observed; sets ops_prior_state'),
('arithmetic_branch_violation','ops_hold','alarm','','','INVARIANT: is_disputed observed; sets ops_prior_state'),
('payout_ready','ops_hold','alarm','','','INVARIANT: is_disputed observed; sets ops_prior_state'),
('reconcile_payout_failed','ops_hold','alarm','','','INVARIANT: is_disputed observed; sets ops_prior_state'),
('cleanup_pending','ops_hold','alarm','','','INVARIANT: is_disputed observed; sets ops_prior_state'),
('settle_exhausted','ops_hold','alarm','','','INVARIANT: is_disputed observed; sets ops_prior_state'),
('finalize_exhausted','ops_hold','alarm','','','INVARIANT: is_disputed observed; sets ops_prior_state'),
('price_blocked','ops_hold','alarm','','','INVARIANT: is_disputed observed; sets ops_prior_state (price_prior_state PRESERVED)'),
('ops_hold','vault_held','ops','ops_release','bounty','ops_prior_state = vault_held'),
('ops_hold','settle_snapshot_ops_pending','ops','ops_release','bounty','ops_prior_state = settle_snapshot_ops_pending'),
('ops_hold','awaiting_finalize','ops','ops_release','bounty','ops_prior_state = awaiting_finalize'),
('ops_hold','arithmetic_branch_violation','ops','ops_release','bounty','ops_prior_state = arithmetic_branch_violation'),
('ops_hold','payout_ready','ops','ops_release','bounty','ops_prior_state = payout_ready'),
('ops_hold','reconcile_payout_failed','ops','ops_release','bounty','ops_prior_state = reconcile_payout_failed'),
('ops_hold','cleanup_pending','ops','ops_release','bounty','ops_prior_state = cleanup_pending'),
('ops_hold','settle_exhausted','ops','ops_release','bounty','ops_prior_state = settle_exhausted'),
('ops_hold','finalize_exhausted','ops','ops_release','bounty','ops_prior_state = finalize_exhausted'),
('ops_hold','price_blocked','ops','ops_release','bounty','ops_prior_state = price_blocked AND price_prior_state preserved')
ON CONFLICT (old_state,new_state,actor,evidence_kind,leg)
DO UPDATE SET guard=EXCLUDED.guard;


-- Legacy approved duplicates are a hard promotion prerequisite.  The trigger is
-- defense in depth; only the unique index is the concurrency authority.
CREATE OR REPLACE FUNCTION public.t2_attempt_one_approved_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status = 'approved' AND EXISTS (
    SELECT 1 FROM public.bounty_attempts a
    WHERE a.bounty_id = NEW.bounty_id AND a.status = 'approved'
      AND a.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'tier2_duplicate_approved_attempt';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE v_predicate text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.bounty_attempts'::regclass
      AND tgname = 'ba_one_approved_guard' AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ba_one_approved_guard
      BEFORE INSERT OR UPDATE OF status, bounty_id ON public.bounty_attempts
      FOR EACH ROW EXECUTE FUNCTION public.t2_attempt_one_approved_guard();
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bounty_attempts
    WHERE status = 'approved'
    GROUP BY bounty_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'tier2_prerequisite_failed: legacy approved-attempt duplicates';
  END IF;
  IF pg_catalog.to_regclass('public.ba_one_approved') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS ba_one_approved
      ON public.bounty_attempts (bounty_id) WHERE status = 'approved';
  ELSE
    SELECT pg_catalog.pg_get_expr(i.indpred,i.indrelid) INTO v_predicate
      FROM pg_catalog.pg_index i
      WHERE i.indexrelid='public.ba_one_approved'::regclass
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND i.indnkeyatts=1
        AND i.indkey[0]=(SELECT a.attnum FROM pg_catalog.pg_attribute a
                         WHERE a.attrelid='public.bounty_attempts'::regclass
                           AND a.attname='bounty_id' AND NOT a.attisdropped);
    IF NOT FOUND OR v_predicate IS DISTINCT FROM
       '(status = ''approved''::bounty_attempt_status)' THEN
      RAISE EXCEPTION 'tier2_schema_drift: ba_one_approved definition mismatch';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Core relations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tier2_rpc_providers (
  provider_id varchar(32) NOT NULL,
  endpoint_fingerprint varchar(64) NOT NULL UNIQUE,
  identity_version integer NOT NULL DEFAULT 1 CHECK (identity_version >= 1),
  operator_identity varchar(128) NOT NULL,
  failure_domain varchar(128) NOT NULL,
  archival boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id,identity_version),
  CONSTRAINT t2rp_fp CHECK (endpoint_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT t2rp_version_uq UNIQUE (provider_id,identity_version),
  CONSTRAINT t2rp_attested_identity UNIQUE
    (operator_identity, failure_domain, identity_version)
);

CREATE TABLE IF NOT EXISTS public.bounty_tier2_assets (
  bounty_id uuid NOT NULL REFERENCES public.bounties(id) ON DELETE RESTRICT,
  asset_kind varchar(8) NOT NULL CHECK (asset_kind IN ('usdc','sol')),
  mint varchar(64) NOT NULL,
  cluster_genesis varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bounty_id, asset_kind),
  CONSTRAINT t2a_uq UNIQUE (bounty_id, asset_kind, mint, cluster_genesis),
  CONSTRAINT t2a_sol_sentinel CHECK (asset_kind <> 'sol'
    OR mint = 'So11111111111111111111111111111111111111112'),
  CONSTRAINT t2a_usdc_not_sentinel CHECK (asset_kind <> 'usdc'
    OR mint <> 'So11111111111111111111111111111111111111112'),
  CONSTRAINT t2a_fmt CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND cluster_genesis ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  CONSTRAINT t2a_admitted_fk FOREIGN KEY (bounty_id, cluster_genesis)
    REFERENCES public.bounties (id, tier2_cluster_genesis) MATCH FULL
);

CREATE TABLE IF NOT EXISTS public.bounty_tier2_op_control (
  bounty_id uuid NOT NULL REFERENCES public.bounties(id) ON DELETE RESTRICT,
  leg varchar(24) NOT NULL CHECK (leg IN ('fee_charge','fee_refund','funding_sol','funding_usdc',
    'pricing_publish','vault_open','settle','finalize','payout','house_refund_to_poster',
    'withdraw_dust_usdc','sweep_dust_usdc','refund_withdraw_usdc','refund_sweep_usdc',
    'close_pending','close_depositor_ata','close_escrow','sweep_sol','bounty')),
  auto_attempts integer NOT NULL DEFAULT 0 CHECK (auto_attempts BETWEEN 0 AND 3),
  last_generation bigint NOT NULL DEFAULT 0,
  live_generation bigint,
  live_operation_id uuid,
  succeeded_generation bigint,
  succeeded_operation_id uuid,
  succeeded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bounty_id, leg),
  CONSTRAINT t2c_live_all_or_none CHECK
    (num_nonnulls(live_generation, live_operation_id) IN (0,2)),
  CONSTRAINT t2c_succ_all_or_none CHECK
    (num_nonnulls(succeeded_generation, succeeded_operation_id, succeeded_at) IN (0,3)),
  CONSTRAINT t2c_generations CHECK (
    last_generation >= 0
    AND (live_generation IS NULL OR live_generation BETWEEN 1 AND last_generation)
    AND (succeeded_generation IS NULL OR succeeded_generation BETWEEN 1 AND last_generation)
  )
);

CREATE TABLE IF NOT EXISTS public.bounty_tier2_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id uuid NOT NULL REFERENCES public.bounties(id) ON DELETE RESTRICT,
  leg varchar(24) NOT NULL CHECK (leg IN ('fee_charge','fee_refund','funding_sol','funding_usdc',
    'pricing_publish','vault_open','settle','finalize','payout','house_refund_to_poster',
    'withdraw_dust_usdc','sweep_dust_usdc','refund_withdraw_usdc','refund_sweep_usdc',
    'close_pending','close_depositor_ata','close_escrow','sweep_sol','bounty')),
  generation bigint NOT NULL CHECK (generation >= 1),
  state varchar(24) NOT NULL CHECK (state IN
    ('pending','claimed','broadcast_unknown','confirmed','terminal_rejected')),
  disposition varchar(24) CHECK
    (disposition IS NULL OR disposition='not_broadcast'),
  claim_id uuid,
  claim_expires_at timestamptz,
  expected_settlement_index numeric(20,0),
  prepared_msg_digest bytea,
  payment_message_digest bytea,
  signature varchar(96),
  blockhash varchar(64),
  last_valid_block_height bigint,
  prepared_slot numeric(20,0),
  claimed_at timestamptz,
  sent_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT t2o_uq UNIQUE (bounty_id, leg, generation),
  CONSTRAINT t2o_fk_target UNIQUE (id, bounty_id, leg, generation),
  CONSTRAINT t2o_ctl_fk FOREIGN KEY (bounty_id, leg)
    REFERENCES public.bounty_tier2_op_control (bounty_id, leg),
  CONSTRAINT t2o_digest_len CHECK (
    (prepared_msg_digest IS NULL AND payment_message_digest IS NULL)
    OR (prepared_msg_digest IS NOT NULL AND octet_length(prepared_msg_digest)=32 AND (
      (leg IN ('pricing_publish','close_pending','close_depositor_ata','close_escrow','bounty')
       AND (payment_message_digest IS NULL OR octet_length(payment_message_digest)=32))
      OR (leg NOT IN ('pricing_publish','close_pending','close_depositor_ata','close_escrow','bounty')
          AND payment_message_digest IS NOT NULL
          AND octet_length(payment_message_digest)=32)
    ))
  ),
  CONSTRAINT t2o_claim_pair CHECK (
    (claim_id IS NULL) = (claim_expires_at IS NULL)
  ),
  CONSTRAINT t2o_claim_state CHECK (
    (state='pending' AND num_nonnulls(claim_id,claim_expires_at,claimed_at)=0)
    OR (state IN ('claimed','broadcast_unknown','confirmed')
        AND num_nonnulls(claim_id,claim_expires_at,claimed_at)=3)
    OR (state='terminal_rejected'
        AND num_nonnulls(claim_id,claim_expires_at,claimed_at) IN (0,3))
  ),
  CONSTRAINT t2o_chain_bounds CHECK (
    (expected_settlement_index IS NULL OR expected_settlement_index BETWEEN 0 AND 18446744073709551615)
    AND (last_valid_block_height IS NULL OR last_valid_block_height >= 0)
    AND (prepared_slot IS NULL OR prepared_slot BETWEEN 0 AND 18446744073709551615)
  ),
  CONSTRAINT t2o_sent_shape CHECK (
    (sent_at IS NULL) = (signature IS NULL)
    AND (state<>'broadcast_unknown' OR sent_at IS NOT NULL)
  ),
  CONSTRAINT t2o_confirm_shape CHECK (state <> 'confirmed' OR
    (signature IS NOT NULL AND sent_at IS NOT NULL AND confirmed_at IS NOT NULL))
);

-- A repeatable withdrawal reserves the one future poster_refund/usdc slot
-- before signing.  The reservation lives on the already-locked bounty row so
-- the two producer legs cannot race each other between prepare and confirm.
ALTER TABLE public.bounties
  DROP CONSTRAINT IF EXISTS b_t2_poster_refund_reservation_shape;
ALTER TABLE public.bounties
  ADD CONSTRAINT b_t2_poster_refund_reservation_shape CHECK (
    num_nonnulls(tier2_poster_refund_reservation_operation,
                 tier2_poster_refund_reservation_leg,
                 tier2_poster_refund_reservation_generation) IN (0,3)
    AND (tier2_poster_refund_reservation_leg IS NULL OR
         tier2_poster_refund_reservation_leg IN
           ('refund_withdraw_usdc','withdraw_dust_usdc'))
    AND (tier2_poster_refund_reservation_generation IS NULL OR
         tier2_poster_refund_reservation_generation >= 1)
  );
ALTER TABLE public.bounties
  DROP CONSTRAINT IF EXISTS b_t2_poster_refund_reservation_fk;
ALTER TABLE public.bounties
  ADD CONSTRAINT b_t2_poster_refund_reservation_fk FOREIGN KEY
    (tier2_poster_refund_reservation_operation)
    REFERENCES public.bounty_tier2_operations (id);

-- Converge the repaired NULL semantics on an overlay of the rejected bytes.
ALTER TABLE public.bounty_tier2_operations DROP CONSTRAINT IF EXISTS t2o_digest_len;
ALTER TABLE public.bounty_tier2_operations ADD CONSTRAINT t2o_digest_len CHECK (
  (prepared_msg_digest IS NULL AND payment_message_digest IS NULL)
  OR (prepared_msg_digest IS NOT NULL AND octet_length(prepared_msg_digest)=32 AND (
    (leg IN ('pricing_publish','close_pending','close_depositor_ata','close_escrow','bounty')
     AND (payment_message_digest IS NULL OR octet_length(payment_message_digest)=32))
    OR (leg NOT IN ('pricing_publish','close_pending','close_depositor_ata','close_escrow','bounty')
        AND payment_message_digest IS NOT NULL
        AND octet_length(payment_message_digest)=32)
  ))
);

-- bounty_id/leg are always non-NULL while the live/succeeded pair is optional,
-- so MATCH FULL would reject every idle control row as a mixed-null key.
-- MATCH SIMPLE plus the all-or-none CHECKs preserves exact binding when live.
ALTER TABLE public.bounty_tier2_op_control DROP CONSTRAINT IF EXISTS t2c_live_fk;
ALTER TABLE public.bounty_tier2_op_control ADD CONSTRAINT t2c_live_fk
  FOREIGN KEY (live_operation_id, bounty_id, leg, live_generation)
  REFERENCES public.bounty_tier2_operations (id, bounty_id, leg, generation)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.bounty_tier2_op_control DROP CONSTRAINT IF EXISTS t2c_succ_fk;
ALTER TABLE public.bounty_tier2_op_control ADD CONSTRAINT t2c_succ_fk
  FOREIGN KEY (succeeded_operation_id, bounty_id, leg, succeeded_generation)
  REFERENCES public.bounty_tier2_operations (id, bounty_id,leg,generation);

CREATE UNIQUE INDEX IF NOT EXISTS t2o_one_live
  ON public.bounty_tier2_operations (bounty_id, leg)
  WHERE state IN ('pending','claimed','broadcast_unknown');
CREATE UNIQUE INDEX IF NOT EXISTS t2o_once_only_confirmed
  ON public.bounty_tier2_operations (bounty_id, leg)
  WHERE state='confirmed' AND leg IN
    ('fee_charge','fee_refund','funding_sol','funding_usdc','vault_open','settle',
     'payout','house_refund_to_poster');
CREATE UNIQUE INDEX IF NOT EXISTS t2o_one_settle
  ON public.bounty_tier2_operations (bounty_id)
  WHERE leg='settle' AND state='confirmed';

CREATE TABLE IF NOT EXISTS public.bounty_tier2_prepared_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  op_bounty_id uuid NOT NULL,
  op_leg varchar(24) NOT NULL,
  generation bigint NOT NULL,
  message_bytes bytea NOT NULL,
  signature varchar(96),
  blockhash varchar(64) NOT NULL,
  last_valid_block_height bigint NOT NULL,
  prepared_slot numeric(20,0) NOT NULL,
  decoded_ok boolean NOT NULL,
  destination varchar(64),
  amount_atomic numeric(20,0),
  liability_bounty_id uuid,
  liability_kind varchar(24),
  liability_asset_kind varchar(8),
  liability_epoch integer,
  estimated_fee_lamports numeric(20,0) NOT NULL DEFAULT 0,
  actual_fee_lamports numeric(20,0),
  predicted_amount_atomic numeric(20,0),
  formula_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  account_version varchar(64),
  account_fingerprint bytea,
  formula_digest bytea,
  pre_sign_reserved_at timestamptz,
  signed_at timestamptz,
  sent_at timestamptz,
  sent_signature varchar(96),
  confirmed_reverted_at timestamptz,
  expired_observed_at timestamptz,
  expired_observed_slot numeric(20,0),
  reconciled_finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT t2ps_uq UNIQUE (operation_id, generation),
  CONSTRAINT t2ps_op_fk FOREIGN KEY (operation_id, op_bounty_id, op_leg, generation)
    REFERENCES public.bounty_tier2_operations (id, bounty_id, leg, generation) MATCH FULL,
  CONSTRAINT t2ps_amounts CHECK (
    (amount_atomic IS NULL OR amount_atomic BETWEEN 0 AND 18446744073709551615)
    AND estimated_fee_lamports BETWEEN 0 AND 18446744073709551615
    AND (actual_fee_lamports IS NULL OR actual_fee_lamports BETWEEN 0 AND 18446744073709551615)
    AND (predicted_amount_atomic IS NULL OR predicted_amount_atomic BETWEEN 0 AND 18446744073709551615)
    AND last_valid_block_height >= 0
    AND prepared_slot BETWEEN 0 AND 18446744073709551615
  ),
  CONSTRAINT t2ps_value_shape CHECK (
    op_leg IN ('pricing_publish','close_pending','close_depositor_ata','close_escrow','bounty')
    OR num_nonnulls(destination,amount_atomic)=2
  ),
  CONSTRAINT t2ps_liability_binding_shape CHECK (
    (op_leg IN ('payout','house_refund_to_poster','fee_refund','vault_open',
                'refund_sweep_usdc','sweep_dust_usdc','sweep_sol')
     AND num_nonnulls(liability_bounty_id,liability_kind,liability_asset_kind,
                      liability_epoch)=4
     AND liability_bounty_id=op_bounty_id)
    OR (op_leg NOT IN ('payout','house_refund_to_poster','fee_refund','vault_open',
                       'refund_sweep_usdc','sweep_dust_usdc','sweep_sol')
        AND num_nonnulls(liability_bounty_id,liability_kind,liability_asset_kind,
                         liability_epoch)=0)
  ),
  CONSTRAINT t2ps_sign_shape CHECK (
    num_nonnulls(signature,signed_at) IN (0,2)
    AND num_nonnulls(sent_at,sent_signature) IN (0,2)
    AND (signed_at IS NULL OR pre_sign_reserved_at IS NOT NULL)
    AND (sent_at IS NULL OR (signed_at IS NOT NULL AND sent_signature=signature))
  ),
  CONSTRAINT t2ps_expired_shape CHECK (
    num_nonnulls(expired_observed_at,expired_observed_slot) IN (0,2)
  ),
  CONSTRAINT t2ps_fingerprint CHECK (
    (account_fingerprint IS NULL OR octet_length(account_fingerprint)=32)
    AND (formula_digest IS NULL OR octet_length(formula_digest)=32)
  )
);

-- Converge exact liability binding columns on an overlay of the rejected bytes.
ALTER TABLE public.bounty_tier2_prepared_sends
  ADD COLUMN IF NOT EXISTS liability_bounty_id uuid,
  ADD COLUMN IF NOT EXISTS liability_kind varchar(24),
  ADD COLUMN IF NOT EXISTS liability_asset_kind varchar(8),
  ADD COLUMN IF NOT EXISTS liability_epoch integer;
ALTER TABLE public.bounty_tier2_prepared_sends
  DROP CONSTRAINT IF EXISTS t2ps_liability_binding_shape;
ALTER TABLE public.bounty_tier2_prepared_sends
  ADD CONSTRAINT t2ps_liability_binding_shape CHECK (
    (op_leg IN ('payout','house_refund_to_poster','fee_refund','vault_open',
                'refund_sweep_usdc','sweep_dust_usdc','sweep_sol')
     AND num_nonnulls(liability_bounty_id,liability_kind,liability_asset_kind,
                      liability_epoch)=4
     AND liability_bounty_id=op_bounty_id)
    OR (op_leg NOT IN ('payout','house_refund_to_poster','fee_refund','vault_open',
                       'refund_sweep_usdc','sweep_dust_usdc','sweep_sol')
        AND num_nonnulls(liability_bounty_id,liability_kind,liability_asset_kind,
                         liability_epoch)=0)
  );

CREATE UNIQUE INDEX IF NOT EXISTS t2ps_signature_uq
  ON public.bounty_tier2_prepared_sends (signature) WHERE signature IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.bounty_tier2_settle_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id uuid NOT NULL REFERENCES public.bounties(id) ON DELETE RESTRICT,
  signature varchar(96) NOT NULL,
  provider_id varchar(32) NOT NULL,
  provider_identity_version integer NOT NULL,
  capture_kind varchar(16) NOT NULL CHECK (capture_kind IN ('settle_event','finalize_transfer')),
  operation_id uuid NOT NULL,
  operation_leg varchar(24) NOT NULL CHECK (operation_leg IN ('settle','finalize')),
  operation_generation bigint NOT NULL CHECK (operation_generation >= 1),
  observed_commitment varchar(16) NOT NULL
    CHECK (observed_commitment IN ('confirmed','finalized')),
  observed_slot numeric(20,0) NOT NULL,
  transaction_bytes bytea NOT NULL,
  transaction_digest bytea NOT NULL,
  raw_log_bytes bytea NOT NULL,
  candidate_event_bytes bytea,
  decoded_ok boolean NOT NULL,
  outer_instruction_index integer,
  inner_instruction_index integer,
  stack_height integer,
  stack_height_raw integer,
  descendant_outer_index integer,
  descendant_inner_index integer,
  descendant_stack_height integer,
  decoded_pending_settlement varchar(64),
  decoded_escrow varchar(64),
  decoded_agent_pda varchar(64),
  decoded_depositor varchar(64),
  decoded_settlement_index numeric(20,0),
  decoded_amount_atomic numeric(20,0),
  decoded_destination varchar(64),
  promotion_state varchar(16) NOT NULL DEFAULT 'captured'
    CHECK (promotion_state IN ('captured','promoted','superseded','divergent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT t2sc_uq UNIQUE (signature, provider_id),
  CONSTRAINT t2sc_op_fk FOREIGN KEY (operation_id,bounty_id,operation_leg,operation_generation)
    REFERENCES public.bounty_tier2_operations(id,bounty_id,leg,generation) MATCH FULL,
  CONSTRAINT t2sc_provider_fk FOREIGN KEY (provider_id,provider_identity_version)
    REFERENCES public.tier2_rpc_providers(provider_id,identity_version) MATCH FULL,
  CONSTRAINT t2sc_provider_version CHECK (provider_identity_version >= 1),
  CONSTRAINT t2sc_bounds CHECK (
    observed_slot BETWEEN 0 AND 18446744073709551615
    AND octet_length(transaction_digest)=32
    AND (outer_instruction_index IS NULL OR outer_instruction_index >= 0)
    AND (inner_instruction_index IS NULL OR inner_instruction_index >= 0)
    AND (stack_height IS NULL OR stack_height >= 1)
    AND (stack_height_raw IS NULL OR stack_height_raw >= 1)
    AND (descendant_outer_index IS NULL OR descendant_outer_index >= 0)
    AND (descendant_inner_index IS NULL OR descendant_inner_index >= 0)
    AND (descendant_stack_height IS NULL OR descendant_stack_height >= 2)
    AND (decoded_settlement_index IS NULL OR decoded_settlement_index BETWEEN 0 AND 18446744073709551615)
    AND (decoded_amount_atomic IS NULL OR decoded_amount_atomic BETWEEN 0 AND 18446744073709551615)
  ),
  CONSTRAINT t2sc_finalize_shape CHECK (capture_kind<>'finalize_transfer' OR (
    operation_leg='finalize' AND observed_commitment='finalized' AND decoded_ok
    AND num_nonnulls(outer_instruction_index,stack_height,descendant_outer_index,
                     descendant_stack_height,decoded_pending_settlement,decoded_escrow,
                     decoded_agent_pda,decoded_depositor,decoded_settlement_index,
                     decoded_amount_atomic,decoded_destination)=11
    AND descendant_stack_height>stack_height
    AND ((inner_instruction_index IS NULL AND stack_height=1 AND stack_height_raw IS NULL)
      OR (inner_instruction_index IS NOT NULL AND stack_height>1
          AND stack_height_raw=stack_height))
    AND decoded_pending_settlement ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND decoded_escrow ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND decoded_agent_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND decoded_depositor ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND decoded_destination ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  )),
  CONSTRAINT t2sc_settle_shape CHECK
    (capture_kind<>'settle_event' OR operation_leg='settle')
);

-- Finalized SOL observations are separate from prepared-send intent.  A
-- transaction capture is bound to the exact landed signature; an account
-- capture supports the explicit no-send zero/sub-fee disposition.
CREATE TABLE IF NOT EXISTS public.bounty_tier2_sol_balance_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id uuid NOT NULL REFERENCES public.bounties(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  operation_leg varchar(24) NOT NULL CHECK (operation_leg='sweep_sol'),
  operation_generation bigint NOT NULL CHECK (operation_generation >= 1),
  capture_kind varchar(16) NOT NULL CHECK (capture_kind IN ('transaction','account')),
  signature varchar(96),
  source_account varchar(64) NOT NULL CHECK
    (source_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  source_account_index integer CHECK (source_account_index IS NULL OR source_account_index >= 0),
  observed_commitment varchar(16) NOT NULL CHECK (observed_commitment='finalized'),
  observed_slot numeric(20,0) NOT NULL CHECK
    (observed_slot BETWEEN 0 AND 18446744073709551615),
  pre_balance_lamports numeric(20,0) NOT NULL CHECK
    (pre_balance_lamports BETWEEN 0 AND 18446744073709551615),
  post_balance_lamports numeric(20,0) NOT NULL CHECK
    (post_balance_lamports BETWEEN 0 AND 18446744073709551615),
  provider_id varchar(32) NOT NULL,
  provider_identity_version integer NOT NULL CHECK (provider_identity_version >= 1),
  capture_breadcrumb bytea NOT NULL CHECK (octet_length(capture_breadcrumb)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT t2sbc_op_fk FOREIGN KEY
    (operation_id,bounty_id,operation_leg,operation_generation)
    REFERENCES public.bounty_tier2_operations(id,bounty_id,leg,generation) MATCH FULL,
  CONSTRAINT t2sbc_provider_fk FOREIGN KEY (provider_id,provider_identity_version)
    REFERENCES public.tier2_rpc_providers(provider_id,identity_version) MATCH FULL,
  CONSTRAINT t2sbc_kind_shape CHECK (
    (capture_kind='transaction' AND signature IS NOT NULL
      AND source_account_index IS NOT NULL)
    OR (capture_kind='account' AND signature IS NULL
      AND source_account_index IS NULL
      AND pre_balance_lamports=post_balance_lamports)
  ),
  CONSTRAINT t2sbc_exact_coordinate_uq UNIQUE
    (operation_id,bounty_id,operation_leg,operation_generation,
     provider_id,provider_identity_version),
  CONSTRAINT t2sbc_signature_uq UNIQUE
    (signature,provider_id,provider_identity_version)
);

-- This caller-supplied 32-byte value is retained only as an audit breadcrumb.
-- It is not recomputed and has no cryptographic binding force.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid='public.bounty_tier2_sol_balance_captures'::regclass
      AND a.attname='capture_digest' AND a.attnum>0 AND NOT a.attisdropped
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid='public.bounty_tier2_sol_balance_captures'::regclass
      AND a.attname='capture_breadcrumb' AND a.attnum>0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.bounty_tier2_sol_balance_captures
      RENAME COLUMN capture_digest TO capture_breadcrumb;
  END IF;
END $$;
COMMENT ON COLUMN public.bounty_tier2_sol_balance_captures.capture_breadcrumb IS
  'Caller-supplied 32-byte audit breadcrumb; not recomputed and not cryptographically binding.';
ALTER TABLE public.bounty_tier2_sol_balance_captures
  DROP CONSTRAINT IF EXISTS t2sbc_exact_coordinate_uq;
ALTER TABLE public.bounty_tier2_sol_balance_captures
  ADD CONSTRAINT t2sbc_exact_coordinate_uq UNIQUE
    (operation_id,bounty_id,operation_leg,operation_generation,
     provider_id,provider_identity_version);
ALTER TABLE public.bounty_tier2_sol_balance_captures
  DROP CONSTRAINT IF EXISTS t2sbc_signature_uq;
ALTER TABLE public.bounty_tier2_sol_balance_captures
  ADD CONSTRAINT t2sbc_signature_uq UNIQUE
    (signature,provider_id,provider_identity_version);

CREATE TABLE IF NOT EXISTS public.bounty_tier2_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id uuid NOT NULL REFERENCES public.bounties(id) ON DELETE RESTRICT,
  leg varchar(24) NOT NULL CHECK (leg IN
    ('fee_charge','fee_refund','funding_sol','funding_usdc','pricing_publish',
     'vault_open','settle','finalize','payout','house_refund_to_poster',
     'withdraw_dust_usdc','sweep_dust_usdc','refund_withdraw_usdc',
     'refund_sweep_usdc','close_pending','close_depositor_ata','close_escrow',
     'sweep_sol','bounty')),
  kind varchar(24) NOT NULL CHECK (kind IN
    ('signature','sends_expired','ops_continue','finalize_release','approval',
     'price_revalidated','ops_release','ops_settle_derivation',
     'arithmetic_violation','accepted_nonrecoverable','sol_balance_disposition')),
  chain_commitment varchar(16) CHECK
    (chain_commitment IS NULL OR chain_commitment='finalized'),
  chain_signature varchar(96),
  tx_succeeded boolean,
  authority varchar(16) CHECK (authority IS NULL OR authority IN ('ops','oracle','app')),
  outer_instruction_index integer,
  inner_instruction_index integer,
  stack_height integer,
  stack_height_raw integer,
  op_id uuid,
  op_bounty_id uuid,
  op_leg varchar(24),
  op_generation bigint,
  amount_atomic numeric(20,0),
  funded_deposit_atomic numeric(20,0),
  expected_destination varchar(64),
  provider_id varchar(32),
  provider_identity_version integer,
  finalize_capture_id uuid,
  funded_proof_id uuid,
  settle_snapshot_proof_id uuid,
  source_finalize_evidence_id uuid,
  predicted_amount_atomic numeric(20,0),
  account_version varchar(64),
  account_fingerprint bytea,
  formula_digest bytea,
  sol_balance_capture_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_by_operation_id uuid,
  consumed_by_bounty_id uuid,
  CONSTRAINT t2ev_scope CHECK (
       (kind IN ('signature','sends_expired') AND leg <> 'bounty'
          AND chain_commitment IS NOT NULL AND authority IS NULL
          AND num_nonnulls(op_id,op_bounty_id,op_leg,op_generation)=4)
    OR (kind='ops_continue' AND leg <> 'bounty'
          AND chain_commitment IS NULL AND authority IS NOT DISTINCT FROM 'ops'
          AND num_nonnulls(op_id,op_bounty_id,op_leg,op_generation)=4)
    OR (kind='sol_balance_disposition' AND leg='sweep_sol'
          AND chain_commitment='finalized' AND chain_signature IS NULL
          AND tx_succeeded IS NULL AND authority IS NULL
          AND num_nonnulls(op_id,op_bounty_id,op_leg,op_generation)=4)
    OR (kind='finalize_release' AND leg='bounty'
          AND chain_commitment IS NOT NULL AND authority IS NULL
          AND chain_signature IS NOT NULL AND outer_instruction_index IS NOT NULL
          AND stack_height IS NOT NULL
          AND num_nonnulls(op_id,op_bounty_id,op_leg,op_generation)=4
          AND op_leg='finalize')
    OR (kind IN ('approval','price_revalidated','ops_release','ops_settle_derivation',
                 'arithmetic_violation','accepted_nonrecoverable') AND leg='bounty'
          AND chain_commitment IS NULL AND authority IS NOT NULL
          AND num_nonnulls(op_id,op_bounty_id,op_leg,op_generation)=0)
  ),
  CONSTRAINT t2ev_sig_success CHECK (kind <> 'signature'
    OR (chain_signature IS NOT NULL AND tx_succeeded IS TRUE)),
  CONSTRAINT t2ev_rel_success CHECK (kind <> 'finalize_release' OR tx_succeeded IS TRUE),
  CONSTRAINT t2ev_arith_amount CHECK (kind <> 'arithmetic_violation' OR
    (amount_atomic IS NOT NULL AND amount_atomic >= 0
     AND funded_deposit_atomic IS NOT NULL
     AND amount_atomic <= funded_deposit_atomic
     AND num_nonnulls(finalize_capture_id,funded_proof_id,settle_snapshot_proof_id,
                      source_finalize_evidence_id,predicted_amount_atomic,
                      account_version,account_fingerprint,formula_digest)=8)),
  CONSTRAINT t2ev_finalize_binding CHECK (kind <> 'finalize_release' OR
    (amount_atomic IS NOT NULL
     AND amount_atomic BETWEEN 0 AND 18446744073709551615
     AND funded_deposit_atomic IS NOT NULL
     AND funded_deposit_atomic BETWEEN 0 AND 18446744073709551615
     AND amount_atomic<=funded_deposit_atomic
     AND num_nonnulls(finalize_capture_id,funded_proof_id,settle_snapshot_proof_id,
                      predicted_amount_atomic,account_version,account_fingerprint,
                      formula_digest)=7
     AND source_finalize_evidence_id IS NULL)),
  CONSTRAINT t2ev_numeric_bounds CHECK (
    (outer_instruction_index IS NULL OR outer_instruction_index >= 0)
    AND (inner_instruction_index IS NULL OR inner_instruction_index >= 0)
    AND (stack_height IS NULL OR stack_height >= 1)
    AND (stack_height_raw IS NULL OR stack_height_raw >= 1)
    AND (op_generation IS NULL OR op_generation >= 1)
    AND (amount_atomic IS NULL OR amount_atomic BETWEEN 0 AND 18446744073709551615)
    AND (funded_deposit_atomic IS NULL OR funded_deposit_atomic BETWEEN 0 AND 18446744073709551615)
    AND (predicted_amount_atomic IS NULL OR predicted_amount_atomic BETWEEN 0 AND 18446744073709551615)
    AND (account_fingerprint IS NULL OR octet_length(account_fingerprint)=32)
    AND (formula_digest IS NULL OR octet_length(formula_digest)=32)
  ),
  CONSTRAINT t2ev_destination_format CHECK (
    expected_destination IS NULL OR
    expected_destination ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  ),
  CONSTRAINT t2ev_op_same_bounty CHECK
    (op_bounty_id IS NULL OR op_bounty_id=bounty_id),
  CONSTRAINT t2ev_op_same_leg CHECK
    (op_leg IS NULL OR op_leg=leg OR (kind='finalize_release' AND op_leg='finalize')),
  CONSTRAINT t2ev_consume CHECK
    (num_nonnulls(consumed_by_operation_id,consumed_by_bounty_id) <= 1),
  CONSTRAINT t2ev_uq_full UNIQUE (id,bounty_id,leg,kind),
  CONSTRAINT t2ev_op_fk FOREIGN KEY (op_id,op_bounty_id,op_leg,op_generation)
    REFERENCES public.bounty_tier2_operations (id,bounty_id,leg,generation) MATCH FULL,
  CONSTRAINT t2ev_provider_pair CHECK
    (num_nonnulls(provider_id,provider_identity_version) IN (0,2)),
  CONSTRAINT t2ev_provider_fk FOREIGN KEY (provider_id,provider_identity_version)
    REFERENCES public.tier2_rpc_providers(provider_id,identity_version) MATCH FULL,
  CONSTRAINT t2ev_capture_fk FOREIGN KEY (finalize_capture_id)
    REFERENCES public.bounty_tier2_settle_captures(id),
  CONSTRAINT t2ev_funded_proof_fk FOREIGN KEY (funded_proof_id)
    REFERENCES public.bounty_tier2_evidence(id),
  CONSTRAINT t2ev_snapshot_proof_fk FOREIGN KEY (settle_snapshot_proof_id)
    REFERENCES public.bounty_tier2_evidence(id),
  CONSTRAINT t2ev_source_finalize_fk FOREIGN KEY (source_finalize_evidence_id)
    REFERENCES public.bounty_tier2_evidence(id),
  CONSTRAINT t2ev_sol_balance_capture_fk FOREIGN KEY (sol_balance_capture_id)
    REFERENCES public.bounty_tier2_sol_balance_captures(id),
  CONSTRAINT t2ev_sol_balance_shape CHECK (
    ((leg='sweep_sol' AND kind IN ('signature','sol_balance_disposition'))
      AND sol_balance_capture_id IS NOT NULL)
    OR ((leg<>'sweep_sol' OR kind NOT IN ('signature','sol_balance_disposition'))
      AND sol_balance_capture_id IS NULL)
  )
);

ALTER TABLE public.bounty_tier2_evidence
  ADD COLUMN IF NOT EXISTS sol_balance_capture_id uuid;
ALTER TABLE public.bounty_tier2_evidence
  DROP CONSTRAINT IF EXISTS bounty_tier2_evidence_kind_check;
ALTER TABLE public.bounty_tier2_evidence
  DROP CONSTRAINT IF EXISTS t2ev_kind;
ALTER TABLE public.bounty_tier2_evidence ADD CONSTRAINT t2ev_kind CHECK (kind IN
  ('signature','sends_expired','ops_continue','finalize_release','approval',
   'price_revalidated','ops_release','ops_settle_derivation',
   'arithmetic_violation','accepted_nonrecoverable','sol_balance_disposition'));
ALTER TABLE public.bounty_tier2_evidence
  DROP CONSTRAINT IF EXISTS t2ev_sol_balance_capture_fk;
ALTER TABLE public.bounty_tier2_evidence ADD CONSTRAINT t2ev_sol_balance_capture_fk
  FOREIGN KEY (sol_balance_capture_id)
  REFERENCES public.bounty_tier2_sol_balance_captures(id);
ALTER TABLE public.bounty_tier2_evidence
  DROP CONSTRAINT IF EXISTS t2ev_sol_balance_shape;
ALTER TABLE public.bounty_tier2_evidence ADD CONSTRAINT t2ev_sol_balance_shape CHECK (
  ((leg='sweep_sol' AND kind IN ('signature','sol_balance_disposition'))
    AND sol_balance_capture_id IS NOT NULL)
  OR ((leg<>'sweep_sol' OR kind NOT IN ('signature','sol_balance_disposition'))
    AND sol_balance_capture_id IS NULL)
);

ALTER TABLE public.bounty_tier2_evidence DROP CONSTRAINT IF EXISTS t2ev_scope;
ALTER TABLE public.bounty_tier2_evidence ADD CONSTRAINT t2ev_scope CHECK (
     (kind IN ('signature','sends_expired') AND leg <> 'bounty'
        AND chain_commitment IS NOT NULL AND authority IS NULL
        AND num_nonnulls(op_id,op_bounty_id,op_leg,op_generation)=4)
  OR (kind='ops_continue' AND leg <> 'bounty'
        AND chain_commitment IS NULL AND authority IS NOT DISTINCT FROM 'ops'
        AND num_nonnulls(op_id,op_bounty_id,op_leg,op_generation)=4)
  OR (kind='sol_balance_disposition' AND leg='sweep_sol'
        AND chain_commitment='finalized' AND chain_signature IS NULL
        AND tx_succeeded IS NULL AND authority IS NULL
        AND num_nonnulls(op_id,op_bounty_id,op_leg,op_generation)=4)
  OR (kind='finalize_release' AND leg='bounty'
        AND chain_commitment IS NOT NULL AND authority IS NULL
        AND chain_signature IS NOT NULL AND outer_instruction_index IS NOT NULL
        AND stack_height IS NOT NULL
        AND num_nonnulls(op_id,op_bounty_id,op_leg,op_generation)=4
        AND op_leg='finalize')
  OR (kind IN ('approval','price_revalidated','ops_release','ops_settle_derivation',
               'arithmetic_violation','accepted_nonrecoverable') AND leg='bounty'
        AND chain_commitment IS NULL AND authority IS NOT NULL
        AND num_nonnulls(op_id,op_bounty_id,op_leg,op_generation)=0)
);
ALTER TABLE public.bounty_tier2_evidence DROP CONSTRAINT IF EXISTS t2ev_finalize_binding;
ALTER TABLE public.bounty_tier2_evidence ADD CONSTRAINT t2ev_finalize_binding CHECK (
  kind <> 'finalize_release' OR (
    amount_atomic IS NOT NULL
    AND amount_atomic BETWEEN 0 AND 18446744073709551615
    AND funded_deposit_atomic IS NOT NULL
    AND funded_deposit_atomic BETWEEN 0 AND 18446744073709551615
    AND amount_atomic<=funded_deposit_atomic
    AND num_nonnulls(finalize_capture_id,funded_proof_id,settle_snapshot_proof_id,
                     predicted_amount_atomic,account_version,account_fingerprint,
                     formula_digest)=7
    AND source_finalize_evidence_id IS NULL
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.bounties'::regclass AND conname='b_t2_balance_proof_fk'
  ) THEN
    ALTER TABLE public.bounties ADD CONSTRAINT b_t2_balance_proof_fk
      FOREIGN KEY (tier2_balance_proof_id,tier2_balance_proof_bounty,
                   tier2_balance_proof_leg,tier2_balance_proof_kind)
      REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS t2ev_one_finalize_release
  ON public.bounty_tier2_evidence (bounty_id) WHERE kind='finalize_release';
CREATE UNIQUE INDEX IF NOT EXISTS t2ev_finalize_sig
  ON public.bounty_tier2_evidence (bounty_id,chain_signature)
  WHERE kind='finalize_release';
CREATE UNIQUE INDEX IF NOT EXISTS t2ev_one_approval
  ON public.bounty_tier2_evidence (bounty_id) WHERE kind='approval';
CREATE UNIQUE INDEX IF NOT EXISTS t2ev_sig_uq
  ON public.bounty_tier2_evidence (chain_signature,leg) WHERE kind='signature';
CREATE UNIQUE INDEX IF NOT EXISTS t2ev_one_arith
  ON public.bounty_tier2_evidence (bounty_id) WHERE kind='arithmetic_violation';

CREATE TABLE IF NOT EXISTS public.bounty_tier2_settle_snapshots (
  bounty_id uuid PRIMARY KEY REFERENCES public.bounties(id) ON DELETE RESTRICT,
  pending_settlement varchar(64) NOT NULL,
  escrow varchar(64) NOT NULL,
  agent_pda varchar(64) NOT NULL,
  depositor varchar(64) NOT NULL,
  settlement_index numeric(20,0) NOT NULL,
  calls_to_settle numeric(20,0) NOT NULL,
  pending_amount numeric(20,0),
  amount_provisional boolean NOT NULL DEFAULT false,
  service_hash bytea NOT NULL,
  release_slot numeric(20,0),
  event_timestamp bigint,
  settle_signature varchar(96) NOT NULL,
  settle_slot numeric(20,0) NOT NULL,
  prepared_msg_digest bytea NOT NULL,
  account_version varchar(64) NOT NULL,
  account_fingerprint bytea NOT NULL,
  formula_inputs jsonb NOT NULL,
  formula_digest bytea NOT NULL,
  superseded_at timestamptz,
  superseded_reason varchar(32),
  proof_id uuid NOT NULL,
  proof_bounty_id uuid NOT NULL,
  proof_leg varchar(24) NOT NULL,
  proof_kind varchar(24) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT t2ss_amt CHECK (
    (amount_provisional AND pending_amount IS NULL
      AND release_slot IS NULL AND event_timestamp IS NULL)
    OR (NOT amount_provisional AND pending_amount IS NOT NULL
      AND release_slot IS NOT NULL AND event_timestamp IS NOT NULL)
  ),
  CONSTRAINT t2ss_bounds CHECK (
    settlement_index BETWEEN 0 AND 18446744073709551615
    AND calls_to_settle BETWEEN 0 AND 18446744073709551615
    AND (pending_amount IS NULL OR pending_amount BETWEEN 0 AND 18446744073709551615)
    AND (release_slot IS NULL OR release_slot BETWEEN 0 AND 18446744073709551615)
    AND (event_timestamp IS NULL OR event_timestamp >= 0)
  ),
  CONSTRAINT t2ss_address_format CHECK (
    pending_settlement ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND escrow ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND agent_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND depositor ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  ),
  CONSTRAINT t2ss_leg CHECK (proof_leg='settle'),
  CONSTRAINT t2ss_kind CHECK (proof_kind='signature'),
  CONSTRAINT t2ss_same CHECK (proof_bounty_id=bounty_id),
  CONSTRAINT t2ss_hash CHECK (
    octet_length(service_hash)=32 AND octet_length(prepared_msg_digest)=32
    AND octet_length(account_fingerprint)=32 AND octet_length(formula_digest)=32
  ),
  CONSTRAINT t2ss_fk FOREIGN KEY (proof_id,proof_bounty_id,proof_leg,proof_kind)
    REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL
);

CREATE TABLE IF NOT EXISTS public.bounty_tier2_payout_releases (
  bounty_id uuid PRIMARY KEY REFERENCES public.bounties(id) ON DELETE RESTRICT,
  evidence_id uuid NOT NULL UNIQUE,
  evidence_bounty_id uuid NOT NULL,
  evidence_leg varchar(24) NOT NULL,
  evidence_kind varchar(24) NOT NULL,
  operation_id uuid NOT NULL UNIQUE,
  operation_generation bigint NOT NULL,
  payment_digest bytea NOT NULL,
  released_atomic numeric(20,0) NOT NULL,
  expected_destination varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT t2pr_leg CHECK
    (evidence_leg='payout' AND evidence_kind='signature'),
  CONSTRAINT t2pr_same CHECK (evidence_bounty_id=bounty_id),
  CONSTRAINT t2pr_digest CHECK (octet_length(payment_digest)=32),
  CONSTRAINT t2pr_amt CHECK (released_atomic BETWEEN 1 AND 18446744073709551615),
  CONSTRAINT t2pr_dest CHECK
    (expected_destination ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  CONSTRAINT t2pr_ev_fk FOREIGN KEY
    (evidence_id,evidence_bounty_id,evidence_leg,evidence_kind)
    REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL,
  CONSTRAINT t2pr_op_fk FOREIGN KEY
    (operation_id,bounty_id,evidence_leg,operation_generation)
    REFERENCES public.bounty_tier2_operations (id,bounty_id,leg,generation) MATCH FULL
);

CREATE TABLE IF NOT EXISTS public.bounty_tier2_depositors (
  bounty_id uuid PRIMARY KEY REFERENCES public.bounties(id) ON DELETE RESTRICT,
  public_key varchar(64) NOT NULL UNIQUE,
  usdc_ata varchar(64) NOT NULL,
  encrypted_secret_key text NOT NULL,
  encryption_iv varchar(32) NOT NULL,
  encryption_tag varchar(32) NOT NULL,
  funded_sol_lamports numeric(20,0),
  funded_sol_proof_id uuid,
  funded_sol_proof_bounty uuid,
  funded_sol_proof_leg varchar(24),
  funded_sol_proof_kind varchar(24),
  funded_usdc_atomic numeric(20,0),
  funded_usdc_proof_id uuid,
  funded_usdc_proof_bounty uuid,
  funded_usdc_proof_leg varchar(24),
  funded_usdc_proof_kind varchar(24),
  swept_at timestamptz,
  swept_sol_proof_id uuid,
  swept_sol_proof_bounty uuid,
  swept_sol_proof_leg varchar(24),
  swept_sol_proof_kind varchar(24),
  ata_closed_at timestamptz,
  ata_closed_proof_id uuid,
  ata_closed_proof_bounty uuid,
  ata_closed_proof_leg varchar(24),
  ata_closed_proof_kind varchar(24),
  escrow_closed_at timestamptz,
  escrow_closed_proof_id uuid,
  escrow_closed_proof_bounty uuid,
  escrow_closed_proof_leg varchar(24),
  escrow_closed_proof_kind varchar(24),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT t2d_pubkey CHECK
    (public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     AND usdc_ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     AND public_key<>usdc_ata),
  CONSTRAINT t2d_amounts CHECK (
    (funded_sol_lamports IS NULL OR funded_sol_lamports BETWEEN 0 AND 18446744073709551615)
    AND (funded_usdc_atomic IS NULL OR funded_usdc_atomic BETWEEN 0 AND 18446744073709551615)
  ),
  CONSTRAINT t2d_sol_all CHECK
    (num_nonnulls(funded_sol_lamports,funded_sol_proof_id,funded_sol_proof_bounty,
                  funded_sol_proof_leg,funded_sol_proof_kind) IN (0,5)),
  CONSTRAINT t2d_usdc_all CHECK
    (num_nonnulls(funded_usdc_atomic,funded_usdc_proof_id,funded_usdc_proof_bounty,
                  funded_usdc_proof_leg,funded_usdc_proof_kind) IN (0,5)),
  CONSTRAINT t2d_sweep_all CHECK
    (num_nonnulls(swept_at,swept_sol_proof_id,swept_sol_proof_bounty,
                  swept_sol_proof_leg,swept_sol_proof_kind) IN (0,5)),
  CONSTRAINT t2d_ata_all CHECK
    (num_nonnulls(ata_closed_at,ata_closed_proof_id,ata_closed_proof_bounty,
                  ata_closed_proof_leg,ata_closed_proof_kind) IN (0,5)),
  CONSTRAINT t2d_escrow_all CHECK
    (num_nonnulls(escrow_closed_at,escrow_closed_proof_id,escrow_closed_proof_bounty,
                  escrow_closed_proof_leg,escrow_closed_proof_kind) IN (0,5)),
  CONSTRAINT t2d_stamp_legs CHECK (
    (funded_sol_proof_id IS NULL OR
      (funded_sol_proof_bounty=bounty_id AND funded_sol_proof_leg='funding_sol'
       AND funded_sol_proof_kind='signature'))
    AND (funded_usdc_proof_id IS NULL OR
      (funded_usdc_proof_bounty=bounty_id AND funded_usdc_proof_leg='funding_usdc'
       AND funded_usdc_proof_kind='signature'))
    AND (swept_sol_proof_id IS NULL OR
      (swept_sol_proof_bounty=bounty_id AND swept_sol_proof_leg='sweep_sol'
       AND swept_sol_proof_kind IN ('signature','sol_balance_disposition')))
    AND (ata_closed_proof_id IS NULL OR
      (ata_closed_proof_bounty=bounty_id AND ata_closed_proof_leg='close_depositor_ata'
       AND ata_closed_proof_kind='signature'))
    AND (escrow_closed_proof_id IS NULL OR
      (escrow_closed_proof_bounty=bounty_id AND escrow_closed_proof_leg='close_escrow'
       AND escrow_closed_proof_kind='signature'))
  ),
  CONSTRAINT t2d_sol_fk FOREIGN KEY
    (funded_sol_proof_id,funded_sol_proof_bounty,funded_sol_proof_leg,funded_sol_proof_kind)
    REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL,
  CONSTRAINT t2d_usdc_fk FOREIGN KEY
    (funded_usdc_proof_id,funded_usdc_proof_bounty,funded_usdc_proof_leg,funded_usdc_proof_kind)
    REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL,
  CONSTRAINT t2d_sweep_fk FOREIGN KEY
    (swept_sol_proof_id,swept_sol_proof_bounty,swept_sol_proof_leg,swept_sol_proof_kind)
    REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL,
  CONSTRAINT t2d_ata_fk FOREIGN KEY
    (ata_closed_proof_id,ata_closed_proof_bounty,ata_closed_proof_leg,ata_closed_proof_kind)
    REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL,
  CONSTRAINT t2d_escrow_fk FOREIGN KEY
    (escrow_closed_proof_id,escrow_closed_proof_bounty,escrow_closed_proof_leg,escrow_closed_proof_kind)
    REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL
);

ALTER TABLE public.bounty_tier2_depositors
  ADD COLUMN IF NOT EXISTS usdc_ata varchar(64);
ALTER TABLE public.bounty_tier2_depositors ALTER COLUMN usdc_ata SET NOT NULL;
ALTER TABLE public.bounty_tier2_depositors DROP CONSTRAINT IF EXISTS t2d_pubkey;
ALTER TABLE public.bounty_tier2_depositors ADD CONSTRAINT t2d_pubkey CHECK (
  public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  AND usdc_ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  AND public_key<>usdc_ata
);
ALTER TABLE public.bounty_tier2_depositors DROP CONSTRAINT IF EXISTS t2d_stamp_legs;
ALTER TABLE public.bounty_tier2_depositors ADD CONSTRAINT t2d_stamp_legs CHECK (
  (funded_sol_proof_id IS NULL OR
    (funded_sol_proof_bounty=bounty_id AND funded_sol_proof_leg='funding_sol'
     AND funded_sol_proof_kind='signature'))
  AND (funded_usdc_proof_id IS NULL OR
    (funded_usdc_proof_bounty=bounty_id AND funded_usdc_proof_leg='funding_usdc'
     AND funded_usdc_proof_kind='signature'))
  AND (swept_sol_proof_id IS NULL OR
    (swept_sol_proof_bounty=bounty_id AND swept_sol_proof_leg='sweep_sol'
     AND swept_sol_proof_kind IN ('signature','sol_balance_disposition')))
  AND (ata_closed_proof_id IS NULL OR
    (ata_closed_proof_bounty=bounty_id AND ata_closed_proof_leg='close_depositor_ata'
     AND ata_closed_proof_kind='signature'))
  AND (escrow_closed_proof_id IS NULL OR
    (escrow_closed_proof_bounty=bounty_id AND escrow_closed_proof_leg='close_escrow'
     AND escrow_closed_proof_kind='signature'))
);
CREATE UNIQUE INDEX IF NOT EXISTS t2d_usdc_ata_uq
  ON public.bounty_tier2_depositors (usdc_ata);

CREATE TABLE IF NOT EXISTS public.bounty_tier2_liabilities (
  bounty_id uuid NOT NULL REFERENCES public.bounties(id) ON DELETE RESTRICT,
  kind varchar(24) NOT NULL CHECK (kind IN
    ('fee_refund','reward_payout','poster_prefund','poster_refund','house_poster_refund')),
  asset_kind varchar(8) NOT NULL CHECK (asset_kind IN ('usdc','sol')),
  mint varchar(64) NOT NULL,
  cluster_genesis varchar(64) NOT NULL,
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  unit varchar(16) NOT NULL CHECK (unit IN ('usdc_atomic','lamports')),
  custody varchar(16) NOT NULL CHECK (custody IN ('house','depositor')),
  settlement_mode varchar(8) NOT NULL CHECK (settlement_mode IN ('exact','drain')),
  liability_atomic numeric(20,0) NOT NULL CHECK
    (liability_atomic > 0 AND liability_atomic <= 18446744073709551615),
  expected_dest varchar(64) NOT NULL CHECK
    (expected_dest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  custody_source varchar(64),
  alternate_dest varchar(64),
  disposition varchar(12) NOT NULL DEFAULT 'open'
    CHECK (disposition IN ('open','released','cancelled')),
  open_proof_id uuid NOT NULL,
  open_proof_bounty uuid NOT NULL,
  open_proof_leg varchar(24) NOT NULL,
  open_proof_kind varchar(24) NOT NULL,
  release_proof_id uuid,
  release_proof_bounty uuid,
  release_proof_leg varchar(24),
  release_proof_kind varchar(24),
  cancel_proof_id uuid,
  cancel_proof_bounty uuid,
  cancel_proof_leg varchar(24),
  cancel_proof_kind varchar(24),
  opened_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  cancelled_at timestamptz,
  PRIMARY KEY (bounty_id,kind,asset_kind,epoch),
  CONSTRAINT t2l_asset_fk FOREIGN KEY (bounty_id,asset_kind,mint,cluster_genesis)
    REFERENCES public.bounty_tier2_assets (bounty_id,asset_kind,mint,cluster_genesis)
    MATCH FULL,
  CONSTRAINT t2l_unit_map CHECK
    ((asset_kind='usdc' AND unit='usdc_atomic') OR
     (asset_kind='sol' AND unit='lamports')),
  CONSTRAINT t2l_route_shape CHECK (
    (kind='poster_prefund' AND asset_kind='usdc'
      AND custody_source IS NOT NULL
      AND custody_source ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      AND alternate_dest IS NOT NULL
      AND alternate_dest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      AND custody_source<>expected_dest AND custody_source<>alternate_dest
      AND expected_dest<>alternate_dest)
    OR (kind='poster_refund'
      AND custody_source IS NOT NULL
      AND custody_source ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      AND alternate_dest IS NULL AND custody_source<>expected_dest)
    OR ((kind<>'poster_prefund' OR asset_kind<>'usdc')
      AND kind<>'poster_refund'
      AND custody_source IS NULL AND alternate_dest IS NULL)
  ),
  CONSTRAINT t2l_open_fk FOREIGN KEY
    (open_proof_id,open_proof_bounty,open_proof_leg,open_proof_kind)
    REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL,
  CONSTRAINT t2l_rel_fk FOREIGN KEY
    (release_proof_id,release_proof_bounty,release_proof_leg,release_proof_kind)
    REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL,
  CONSTRAINT t2l_can_fk FOREIGN KEY
    (cancel_proof_id,cancel_proof_bounty,cancel_proof_leg,cancel_proof_kind)
    REFERENCES public.bounty_tier2_evidence (id,bounty_id,leg,kind) MATCH FULL,
  CONSTRAINT t2l_open_same CHECK (open_proof_bounty=bounty_id),
  CONSTRAINT t2l_rel_same CHECK
    (release_proof_bounty IS NULL OR release_proof_bounty=bounty_id),
  CONSTRAINT t2l_can_same CHECK
    (cancel_proof_bounty IS NULL OR cancel_proof_bounty=bounty_id),
  CONSTRAINT t2l_disp_open CHECK (disposition <> 'open' OR
    num_nonnulls(released_at,release_proof_id,release_proof_bounty,release_proof_leg,
                 release_proof_kind,cancelled_at,cancel_proof_id,cancel_proof_bounty,
                 cancel_proof_leg,cancel_proof_kind)=0),
  CONSTRAINT t2l_disp_rel CHECK (disposition <> 'released' OR
    (num_nonnulls(released_at,release_proof_id,release_proof_bounty,release_proof_leg,
                  release_proof_kind)=5
     AND num_nonnulls(cancelled_at,cancel_proof_id,cancel_proof_bounty,
                      cancel_proof_leg,cancel_proof_kind)=0)),
  CONSTRAINT t2l_disp_can CHECK (disposition <> 'cancelled' OR
    (num_nonnulls(cancelled_at,cancel_proof_id,cancel_proof_bounty,
                  cancel_proof_leg,cancel_proof_kind)=5
     AND num_nonnulls(released_at,release_proof_id,release_proof_bounty,
                      release_proof_leg,release_proof_kind)=0)),
  CONSTRAINT t2l_cancel_narrow CHECK (disposition <> 'cancelled' OR
    (kind='reward_payout' AND cancel_proof_kind='arithmetic_violation'
     AND cancel_proof_leg='bounty')
    OR (kind='poster_refund' AND asset_kind='sol'
     AND settlement_mode='drain' AND cancel_proof_kind='sol_balance_disposition'
     AND cancel_proof_leg='sweep_sol')),
  CONSTRAINT t2l_reward_epoch CHECK (kind <> 'reward_payout' OR epoch=1),
  CONSTRAINT t2l_leg_map CHECK (
       (kind='reward_payout' AND asset_kind='usdc' AND custody='house'
          AND settlement_mode='exact' AND open_proof_leg='bounty'
          AND open_proof_kind='approval'
          AND (release_proof_leg IS NULL OR
               (release_proof_leg='payout' AND release_proof_kind='signature')))
    OR (kind='house_poster_refund' AND asset_kind='usdc' AND custody='house'
          AND settlement_mode='exact' AND open_proof_leg='bounty'
          AND open_proof_kind='arithmetic_violation'
          AND (release_proof_leg IS NULL OR
               (release_proof_leg='house_refund_to_poster'
                AND release_proof_kind='signature')))
    OR (kind='fee_refund' AND asset_kind='usdc' AND custody='house'
          AND settlement_mode='exact' AND open_proof_leg='fee_charge'
          AND open_proof_kind='signature'
          AND (release_proof_leg IS NULL OR
               (release_proof_leg='fee_refund' AND release_proof_kind='signature')))
    OR (kind='poster_prefund' AND asset_kind='usdc' AND custody='depositor'
          AND settlement_mode='exact' AND open_proof_leg='funding_usdc'
          AND open_proof_kind='signature'
          AND (release_proof_leg IS NULL OR
               (release_proof_leg IN ('vault_open','refund_sweep_usdc')
                AND release_proof_kind='signature')))
    OR (kind='poster_refund' AND asset_kind='usdc' AND custody='depositor'
          AND settlement_mode='exact'
          AND open_proof_leg IN ('refund_withdraw_usdc','withdraw_dust_usdc')
          AND open_proof_kind='signature'
          AND (release_proof_leg IS NULL OR
               (release_proof_leg IN ('refund_sweep_usdc','sweep_dust_usdc')
                AND release_proof_kind='signature')))
    OR (kind='poster_refund' AND asset_kind='sol' AND custody='depositor'
          AND settlement_mode='drain' AND open_proof_leg='funding_sol'
          AND open_proof_kind='signature'
          AND (release_proof_leg IS NULL OR
               (release_proof_leg='sweep_sol'
                AND release_proof_kind IN ('signature','sol_balance_disposition'))))
  )
);

ALTER TABLE public.bounty_tier2_liabilities
  ADD COLUMN IF NOT EXISTS custody_source varchar(64),
  ADD COLUMN IF NOT EXISTS alternate_dest varchar(64);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bounty_tier2_liabilities l
    WHERE (l.kind='poster_prefund' AND l.asset_kind='usdc'
           AND (l.custody_source IS NULL OR l.alternate_dest IS NULL))
       OR (l.kind='poster_refund' AND l.custody_source IS NULL)
  ) THEN
    RAISE EXCEPTION 'tier2_prerequisite_failed: legacy liability route coordinates missing';
  END IF;
END $$;
ALTER TABLE public.bounty_tier2_liabilities DROP CONSTRAINT IF EXISTS t2l_route_shape;
ALTER TABLE public.bounty_tier2_liabilities ADD CONSTRAINT t2l_route_shape CHECK (
  (kind='poster_prefund' AND asset_kind='usdc'
    AND custody_source IS NOT NULL
    AND custody_source ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND alternate_dest IS NOT NULL
    AND alternate_dest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND custody_source<>expected_dest AND custody_source<>alternate_dest
    AND expected_dest<>alternate_dest)
  OR (kind='poster_refund'
    AND custody_source IS NOT NULL
    AND custody_source ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND alternate_dest IS NULL AND custody_source<>expected_dest)
  OR ((kind<>'poster_prefund' OR asset_kind<>'usdc')
    AND kind<>'poster_refund'
    AND custody_source IS NULL AND alternate_dest IS NULL)
) NOT VALID;
ALTER TABLE public.bounty_tier2_liabilities VALIDATE CONSTRAINT t2l_route_shape;

ALTER TABLE public.bounty_tier2_liabilities DROP CONSTRAINT IF EXISTS t2l_cancel_narrow;
ALTER TABLE public.bounty_tier2_liabilities ADD CONSTRAINT t2l_cancel_narrow CHECK (
  disposition <> 'cancelled' OR
  (kind='reward_payout' AND cancel_proof_kind='arithmetic_violation'
   AND cancel_proof_leg='bounty')
  OR (kind='poster_refund' AND asset_kind='sol' AND settlement_mode='drain'
   AND cancel_proof_kind='sol_balance_disposition'
   AND cancel_proof_leg='sweep_sol')
);
ALTER TABLE public.bounty_tier2_liabilities DROP CONSTRAINT IF EXISTS t2l_leg_map;
ALTER TABLE public.bounty_tier2_liabilities ADD CONSTRAINT t2l_leg_map CHECK (
     (kind='reward_payout' AND asset_kind='usdc' AND custody='house'
        AND settlement_mode='exact' AND open_proof_leg='bounty'
        AND open_proof_kind='approval'
        AND (release_proof_leg IS NULL OR
             (release_proof_leg='payout' AND release_proof_kind='signature')))
  OR (kind='house_poster_refund' AND asset_kind='usdc' AND custody='house'
        AND settlement_mode='exact' AND open_proof_leg='bounty'
        AND open_proof_kind='arithmetic_violation'
        AND (release_proof_leg IS NULL OR
             (release_proof_leg='house_refund_to_poster'
              AND release_proof_kind='signature')))
  OR (kind='fee_refund' AND asset_kind='usdc' AND custody='house'
        AND settlement_mode='exact' AND open_proof_leg='fee_charge'
        AND open_proof_kind='signature'
        AND (release_proof_leg IS NULL OR
             (release_proof_leg='fee_refund' AND release_proof_kind='signature')))
  OR (kind='poster_prefund' AND asset_kind='usdc' AND custody='depositor'
        AND settlement_mode='exact' AND open_proof_leg='funding_usdc'
        AND open_proof_kind='signature'
        AND (release_proof_leg IS NULL OR
             (release_proof_leg IN ('vault_open','refund_sweep_usdc')
              AND release_proof_kind='signature')))
  OR (kind='poster_refund' AND asset_kind='usdc' AND custody='depositor'
        AND settlement_mode='exact'
        AND open_proof_leg IN ('refund_withdraw_usdc','withdraw_dust_usdc')
        AND open_proof_kind='signature'
        AND (release_proof_leg IS NULL OR
             (release_proof_leg IN ('refund_sweep_usdc','sweep_dust_usdc')
              AND release_proof_kind='signature')))
  OR (kind='poster_refund' AND asset_kind='sol' AND custody='depositor'
        AND settlement_mode='drain' AND open_proof_leg='funding_sol'
        AND open_proof_kind='signature'
        AND (release_proof_leg IS NULL OR
             (release_proof_leg='sweep_sol'
              AND release_proof_kind IN ('signature','sol_balance_disposition'))))
);

CREATE UNIQUE INDEX IF NOT EXISTS t2l_one_live
  ON public.bounty_tier2_liabilities (bounty_id,kind,asset_kind)
  WHERE disposition='open';
CREATE UNIQUE INDEX IF NOT EXISTS t2l_reward_open_proof
  ON public.bounty_tier2_liabilities (open_proof_id)
  WHERE kind='reward_payout';
CREATE INDEX IF NOT EXISTS t2l_live
  ON public.bounty_tier2_liabilities (custody,unit) WHERE disposition='open';

ALTER TABLE public.bounty_tier2_prepared_sends
  DROP CONSTRAINT IF EXISTS t2ps_liability_fk;
ALTER TABLE public.bounty_tier2_prepared_sends
  ADD CONSTRAINT t2ps_liability_fk FOREIGN KEY
    (liability_bounty_id,liability_kind,liability_asset_kind,liability_epoch)
    REFERENCES public.bounty_tier2_liabilities
      (bounty_id,kind,asset_kind,epoch) MATCH FULL;

CREATE TABLE IF NOT EXISTS public.tier2_ops_principals (
  principal_id uuid PRIMARY KEY,
  key_id text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tier2_ops_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES public.tier2_ops_principals(principal_id),
  bounty_id uuid NOT NULL REFERENCES public.bounties(id) ON DELETE RESTRICT,
  leg varchar(24) NOT NULL,
  next_generation bigint NOT NULL CHECK (next_generation >= 1),
  grant_lamports numeric(20,0) NOT NULL CHECK
    (grant_lamports BETWEEN 1 AND 18446744073709551615),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  signature bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT t2auth_once UNIQUE (principal_id,bounty_id,leg,next_generation),
  CONSTRAINT t2auth_consume_pair CHECK
    ((consumed_at IS NULL) = (consumed_by IS NULL))
);

CREATE TABLE IF NOT EXISTS public.tier2_policy (
  key text PRIMARY KEY,
  value_num numeric NOT NULL,
  floor_num numeric NOT NULL,
  ceil_num numeric NOT NULL,
  CONSTRAINT t2pol_bounds CHECK
    (floor_num >= 0 AND value_num >= floor_num AND value_num <= ceil_num),
  CONSTRAINT t2pol_integer CHECK
    (value_num=trunc(value_num) AND floor_num=trunc(floor_num)
     AND ceil_num=trunc(ceil_num))
);

INSERT INTO public.tier2_policy (key,value_num,floor_num,ceil_num) VALUES
  ('ops_continue_min_interval_ms',3600000,60000,86400000),
  ('max_fee_per_send_lamports',250000,5000,500000),
  ('sol_unsweepable_fee_lamports',5000,5000,5000),
  ('ops_continue_fee_grant_lamports',250000,250000,500000),
  ('automatic_fee_budget_lamports',2500000,250000,2500000),
  ('two_key_threshold_grants',5,1,100)
ON CONFLICT (key) DO UPDATE SET
  value_num=EXCLUDED.value_num,
  floor_num=EXCLUDED.floor_num,
  ceil_num=EXCLUDED.ceil_num;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.tier2_policy)<>6 OR EXISTS (
    SELECT 1 FROM public.tier2_policy p WHERE p.key NOT IN
      ('ops_continue_min_interval_ms','max_fee_per_send_lamports',
       'sol_unsweepable_fee_lamports',
       'ops_continue_fee_grant_lamports','automatic_fee_budget_lamports',
       'two_key_threshold_grants'))
  THEN RAISE EXCEPTION 'tier2_policy_unexpected_row_or_count'; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.tier2_ops_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id uuid NOT NULL REFERENCES public.bounties(id) ON DELETE RESTRICT,
  leg varchar(24),
  kind varchar(32) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.tier2_legacy_inventory (
  bounty_id uuid NOT NULL,
  leg smallint NOT NULL CHECK (leg IN (1,2)),
  job_id text NOT NULL,
  escrow_pda varchar(64),
  escrow_nonce varchar(32),
  depositor_avatar_id uuid,
  depositor_wallet_pubkey varchar(64),
  worker_wallet_pubkey varchar(64),
  token_mint varchar(64),
  approved_attempt_id uuid,
  hunter_id uuid,
  approved_calls varchar(32),
  expected_payout_atomic numeric(20,0),
  expected_destination varchar(64),
  onchain_balance numeric(20,0),
  onchain_pending_amount numeric(20,0),
  onchain_settlement_index numeric(20,0),
  onchain_verified_at timestamptz,
  resolution varchar(24) CHECK (resolution IN
    ('finalized_and_paid','finalize_then_pay','withdraw_to_depositor','close_only','no_action')),
  resolution_signature varchar(96),
  resolved_at timestamptz,
  PRIMARY KEY (bounty_id,leg),
  CONSTRAINT t2li_bounty_fk FOREIGN KEY (bounty_id)
    REFERENCES public.bounties(id) ON DELETE RESTRICT,
  CONSTRAINT t2li_attempt_fk FOREIGN KEY (approved_attempt_id)
    REFERENCES public.bounty_attempts(id) ON DELETE RESTRICT
);

DO $$
DECLARE v_owner oid;
BEGIN
  SELECT r.oid INTO STRICT v_owner FROM pg_catalog.pg_roles r
    WHERE r.rolname=current_user;
  IF (SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN (
        'bounty_tier2_assets','bounty_tier2_evidence','bounty_tier2_operations',
        'bounty_tier2_op_control','bounty_tier2_prepared_sends',
        'bounty_tier2_settle_captures','bounty_tier2_sol_balance_captures',
        'bounty_tier2_settle_snapshots',
        'bounty_tier2_payout_releases','bounty_tier2_depositors',
        'bounty_tier2_transitions','bounty_tier2_liabilities','tier2_rpc_providers',
        'tier2_ops_principals','tier2_ops_authorizations','tier2_policy',
        'tier2_ops_alerts','tier2_legacy_inventory'))<>18
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname IN (
         'bounty_tier2_assets','bounty_tier2_evidence','bounty_tier2_operations',
         'bounty_tier2_op_control','bounty_tier2_prepared_sends',
         'bounty_tier2_settle_captures','bounty_tier2_sol_balance_captures',
         'bounty_tier2_settle_snapshots',
         'bounty_tier2_payout_releases','bounty_tier2_depositors',
         'bounty_tier2_transitions','bounty_tier2_liabilities','tier2_rpc_providers',
         'tier2_ops_principals','tier2_ops_authorizations','tier2_policy',
         'tier2_ops_alerts','tier2_legacy_inventory')
         AND c.relowner IS DISTINCT FROM v_owner)
  THEN RAISE EXCEPTION 'tier2_relation_owner_inventory_invalid'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Row-level immutability and state legality
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.t2a_assert_admitted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_mint varchar(64);
  v_genesis varchar(64);
BEGIN
  SELECT b.tier2_mint,b.tier2_cluster_genesis
    INTO v_mint,v_genesis
    FROM public.bounties b WHERE b.id=NEW.bounty_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  IF NEW.asset_kind='usdc' AND NEW.mint IS DISTINCT FROM v_mint THEN
    RAISE EXCEPTION 'tier2_asset_mint_mismatch';
  END IF;
  IF NEW.cluster_genesis IS DISTINCT FROM v_genesis THEN
    RAISE EXCEPTION 'tier2_asset_genesis_mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t2a_freeze()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'tier2_asset_immutable';
END $$;

CREATE OR REPLACE FUNCTION public.b_t2_freeze_admitted()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.bounty_tier2_assets a WHERE a.bounty_id=NEW.id)
     AND (NEW.tier2_mint IS DISTINCT FROM OLD.tier2_mint
       OR NEW.tier2_cluster_genesis IS DISTINCT FROM OLD.tier2_cluster_genesis
       OR NEW.tier2_poster_wallet IS DISTINCT FROM OLD.tier2_poster_wallet
       OR NEW.tier2_arithmetic_branch IS DISTINCT FROM OLD.tier2_arithmetic_branch
       OR NEW.tier2_price_formula_version IS DISTINCT FROM OLD.tier2_price_formula_version
       OR NEW.payout_expected_atomic IS DISTINCT FROM OLD.payout_expected_atomic
       OR NEW.tier2_hunter_ata IS DISTINCT FROM OLD.tier2_hunter_ata
       OR NEW.tier2_poster_usdc_ata IS DISTINCT FROM OLD.tier2_poster_usdc_ata
       OR NEW.tier2_vault_usdc_ata IS DISTINCT FROM OLD.tier2_vault_usdc_ata
       OR NEW.tier2_sol_return_address IS DISTINCT FROM OLD.tier2_sol_return_address)
  THEN RAISE EXCEPTION 'tier2_admitted_coordinates_frozen'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t2c_succ_freeze()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.last_generation < OLD.last_generation THEN
    RAISE EXCEPTION 'tier2_last_generation_cannot_decrease';
  END IF;
  IF OLD.succeeded_operation_id IS NOT NULL AND
     (NEW.succeeded_operation_id IS DISTINCT FROM OLD.succeeded_operation_id
      OR NEW.succeeded_generation IS DISTINCT FROM OLD.succeeded_generation
      OR NEW.succeeded_at IS DISTINCT FROM OLD.succeeded_at)
  THEN RAISE EXCEPTION 'tier2_succeeded_marker_immutable'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t2_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'tier2_append_only:%',TG_TABLE_NAME;
END $$;

CREATE OR REPLACE FUNCTION public.t2rp_freeze()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tier2_rpc_provider_delete_forbidden'; END IF;
  IF NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.endpoint_fingerprint IS DISTINCT FROM OLD.endpoint_fingerprint
     OR NEW.identity_version IS DISTINCT FROM OLD.identity_version
     OR NEW.operator_identity IS DISTINCT FROM OLD.operator_identity
     OR NEW.failure_domain IS DISTINCT FROM OLD.failure_domain
     OR NEW.archival IS DISTINCT FROM OLD.archival
     OR (OLD.active IS FALSE AND NEW.active IS TRUE)
  THEN RAISE EXCEPTION 'tier2_rpc_provider_identity_frozen'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t2ps_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tier2_prepared_send_delete_forbidden'; END IF;
  IF ROW(NEW.id,NEW.operation_id,NEW.op_bounty_id,NEW.op_leg,NEW.generation,
         NEW.message_bytes,NEW.blockhash,NEW.last_valid_block_height,
         NEW.prepared_slot,NEW.decoded_ok,NEW.destination,NEW.amount_atomic,
         NEW.liability_bounty_id,NEW.liability_kind,NEW.liability_asset_kind,
         NEW.liability_epoch,
         NEW.estimated_fee_lamports,NEW.predicted_amount_atomic,NEW.formula_inputs,
         NEW.account_version,NEW.account_fingerprint,NEW.formula_digest,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.operation_id,OLD.op_bounty_id,OLD.op_leg,OLD.generation,
         OLD.message_bytes,OLD.blockhash,OLD.last_valid_block_height,
         OLD.prepared_slot,OLD.decoded_ok,OLD.destination,OLD.amount_atomic,
         OLD.liability_bounty_id,OLD.liability_kind,OLD.liability_asset_kind,
         OLD.liability_epoch,
         OLD.estimated_fee_lamports,OLD.predicted_amount_atomic,OLD.formula_inputs,
         OLD.account_version,OLD.account_fingerprint,OLD.formula_digest,OLD.created_at)
  THEN RAISE EXCEPTION 'tier2_prepared_send_bytes_immutable'; END IF;
  IF (OLD.pre_sign_reserved_at IS NOT NULL AND NEW.pre_sign_reserved_at IS DISTINCT FROM OLD.pre_sign_reserved_at)
     OR (OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature)
     OR (OLD.signed_at IS NOT NULL AND NEW.signed_at IS DISTINCT FROM OLD.signed_at)
     OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
     OR (OLD.sent_signature IS NOT NULL AND NEW.sent_signature IS DISTINCT FROM OLD.sent_signature)
     OR (OLD.actual_fee_lamports IS NOT NULL AND NEW.actual_fee_lamports IS DISTINCT FROM OLD.actual_fee_lamports)
     OR (OLD.confirmed_reverted_at IS NOT NULL AND NEW.confirmed_reverted_at IS DISTINCT FROM OLD.confirmed_reverted_at)
     OR (OLD.expired_observed_at IS NOT NULL AND
         ROW(NEW.expired_observed_at,NEW.expired_observed_slot) IS DISTINCT FROM
         ROW(OLD.expired_observed_at,OLD.expired_observed_slot))
     OR (OLD.reconciled_finalized_at IS NOT NULL AND
         NEW.reconciled_finalized_at IS DISTINCT FROM OLD.reconciled_finalized_at)
  THEN RAISE EXCEPTION 'tier2_prepared_send_stamp_immutable'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t2l_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tier2_liability_delete_forbidden'; END IF;
  IF NEW.bounty_id IS DISTINCT FROM OLD.bounty_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.asset_kind IS DISTINCT FROM OLD.asset_kind
     OR NEW.mint IS DISTINCT FROM OLD.mint
     OR NEW.cluster_genesis IS DISTINCT FROM OLD.cluster_genesis
     OR NEW.epoch IS DISTINCT FROM OLD.epoch
     OR NEW.unit IS DISTINCT FROM OLD.unit
     OR NEW.custody IS DISTINCT FROM OLD.custody
     OR NEW.settlement_mode IS DISTINCT FROM OLD.settlement_mode
     OR NEW.liability_atomic IS DISTINCT FROM OLD.liability_atomic
     OR NEW.expected_dest IS DISTINCT FROM OLD.expected_dest
     OR NEW.custody_source IS DISTINCT FROM OLD.custody_source
     OR NEW.alternate_dest IS DISTINCT FROM OLD.alternate_dest
     OR NEW.open_proof_id IS DISTINCT FROM OLD.open_proof_id
  THEN RAISE EXCEPTION 'tier2_liability_amount_or_identity_immutable'; END IF;
  IF OLD.disposition <> 'open' AND NEW.disposition IS DISTINCT FROM OLD.disposition THEN
    RAISE EXCEPTION 'tier2_liability_disposition_terminal';
  END IF;
  IF OLD.disposition='open' AND NEW.disposition NOT IN ('open','released','cancelled') THEN
    RAISE EXCEPTION 'tier2_liability_disposition_illegal';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t2d_monotonic()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tier2_depositor_delete_forbidden'; END IF;
  IF NEW.bounty_id IS DISTINCT FROM OLD.bounty_id
     OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.usdc_ata IS DISTINCT FROM OLD.usdc_ata
     OR NEW.encrypted_secret_key IS DISTINCT FROM OLD.encrypted_secret_key
     OR NEW.encryption_iv IS DISTINCT FROM OLD.encryption_iv
     OR NEW.encryption_tag IS DISTINCT FROM OLD.encryption_tag
  THEN RAISE EXCEPTION 'tier2_depositor_identity_immutable'; END IF;
  IF (OLD.funded_sol_proof_id IS NOT NULL AND
       ROW(NEW.funded_sol_lamports,NEW.funded_sol_proof_id,NEW.funded_sol_proof_bounty,
           NEW.funded_sol_proof_leg,NEW.funded_sol_proof_kind) IS DISTINCT FROM
       ROW(OLD.funded_sol_lamports,OLD.funded_sol_proof_id,OLD.funded_sol_proof_bounty,
           OLD.funded_sol_proof_leg,OLD.funded_sol_proof_kind))
     OR (OLD.funded_usdc_proof_id IS NOT NULL AND
       ROW(NEW.funded_usdc_atomic,NEW.funded_usdc_proof_id,NEW.funded_usdc_proof_bounty,
           NEW.funded_usdc_proof_leg,NEW.funded_usdc_proof_kind) IS DISTINCT FROM
       ROW(OLD.funded_usdc_atomic,OLD.funded_usdc_proof_id,OLD.funded_usdc_proof_bounty,
           OLD.funded_usdc_proof_leg,OLD.funded_usdc_proof_kind))
     OR (OLD.swept_sol_proof_id IS NOT NULL AND
       ROW(NEW.swept_at,NEW.swept_sol_proof_id) IS DISTINCT FROM
       ROW(OLD.swept_at,OLD.swept_sol_proof_id))
     OR (OLD.ata_closed_proof_id IS NOT NULL AND
       ROW(NEW.ata_closed_at,NEW.ata_closed_proof_id) IS DISTINCT FROM
       ROW(OLD.ata_closed_at,OLD.ata_closed_proof_id))
     OR (OLD.escrow_closed_proof_id IS NOT NULL AND
       ROW(NEW.escrow_closed_at,NEW.escrow_closed_proof_id) IS DISTINCT FROM
       ROW(OLD.escrow_closed_at,OLD.escrow_closed_proof_id))
  THEN RAISE EXCEPTION 'tier2_depositor_stamp_immutable'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t2o_state_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v_state varchar(32); v_succeeded uuid; v_live uuid;
BEGIN
  SELECT b.composition_state INTO v_state
    FROM public.bounties b WHERE b.id=NEW.bounty_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT c.succeeded_operation_id,c.live_operation_id INTO v_succeeded,v_live
    FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=NEW.bounty_id AND c.leg=NEW.leg FOR SHARE;
  IF NEW.leg IN ('fee_charge','fee_refund','funding_sol','funding_usdc','vault_open',
                 'settle','payout','house_refund_to_poster')
     AND v_succeeded IS NOT NULL
  THEN RAISE EXCEPTION 'tier2_once_only_already_succeeded'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state='confirmed' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'tier2_confirmed_operation_immutable';
    END IF;
    IF NEW.bounty_id IS DISTINCT FROM OLD.bounty_id
       OR NEW.leg IS DISTINCT FROM OLD.leg
       OR NEW.generation IS DISTINCT FROM OLD.generation
    THEN RAISE EXCEPTION 'tier2_operation_coordinate_immutable'; END IF;
    IF NEW.state='claimed' AND NEW.state IS DISTINCT FROM OLD.state
       AND OLD.state <> 'pending' THEN
      RAISE EXCEPTION 'tier2_claim_requires_pending';
    END IF;
    IF NEW.state='claimed' AND v_live IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'tier2_claim_not_live_operation';
    END IF;
    IF NEW.state='terminal_rejected' AND
       (OLD.state NOT IN ('pending','claimed') OR OLD.sent_at IS NOT NULL
        OR NEW.disposition IS DISTINCT FROM 'not_broadcast') THEN
      RAISE EXCEPTION 'tier2_terminal_reject_requires_not_broadcast';
    END IF;
  END IF;
  IF NOT public.t2_leg_state_admitted(NEW.leg,v_state)
  THEN RAISE EXCEPTION 'tier2_leg_illegal_in_state:%:%',NEW.leg,v_state; END IF;
  RETURN NEW;
END $$;

-- Shared by prepare, immediate pre-sign, pre-broadcast, and confirmation so a
-- supported checkpoint cannot approve coordinates the consumer will reject.
CREATE OR REPLACE FUNCTION public.t2_assert_send_contract(
  p_bounty uuid,p_leg varchar,p_operation uuid
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_state varchar(32); v_op_state varchar(24); v_generation bigint;
  v_amount numeric; v_destination varchar(64); v_payment_digest bytea;
  v_poster varchar(64); v_hunter varchar(64); v_vault varchar(64);
  v_sol_return varchar(64); v_depositor varchar(64); v_depositor_ata varchar(64);
  v_value_leg boolean; v_formula_inputs jsonb; v_estimated_fee numeric;
  v_liability_kinds varchar[]; v_liability_asset varchar(8);
  v_bound_bounty uuid; v_bound_kind varchar(24); v_bound_asset varchar(8);
  v_bound_epoch integer; v_liability_amount numeric; v_liability_dest varchar(64);
  v_liability_alt varchar(64); v_custody_source varchar(64); v_route_dest varchar(64);
  v_settlement_mode varchar(8); v_source_balance numeric; v_drain_fee numeric;
  v_reserved_operation uuid; v_reserved_leg varchar(24); v_reserved_generation bigint;
BEGIN
  SELECT b.composition_state,b.tier2_poster_usdc_ata,b.tier2_hunter_ata,
         b.tier2_vault_usdc_ata,b.tier2_sol_return_address,d.public_key,d.usdc_ata,
         b.tier2_poster_refund_reservation_operation,
         b.tier2_poster_refund_reservation_leg,
         b.tier2_poster_refund_reservation_generation,
         o.state,o.generation,o.payment_message_digest,s.amount_atomic,s.destination,
         s.formula_inputs,s.estimated_fee_lamports,
         s.liability_bounty_id,s.liability_kind,s.liability_asset_kind,s.liability_epoch
    INTO v_state,v_poster,v_hunter,v_vault,v_sol_return,v_depositor,v_depositor_ata,
         v_reserved_operation,v_reserved_leg,
         v_reserved_generation,v_op_state,v_generation,v_payment_digest,
         v_amount,v_destination,v_formula_inputs,v_estimated_fee,
         v_bound_bounty,v_bound_kind,v_bound_asset,v_bound_epoch
    FROM public.bounties b
    JOIN public.bounty_tier2_depositors d ON d.bounty_id=b.id
    JOIN public.bounty_tier2_operations o
      ON o.bounty_id=b.id AND o.id=p_operation AND o.leg=p_leg
    JOIN public.bounty_tier2_prepared_sends s
      ON s.operation_id=o.id AND s.op_bounty_id=o.bounty_id
     AND s.op_leg=o.leg AND s.generation=o.generation
    WHERE b.id=p_bounty
    FOR UPDATE OF b,o,s;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_send_contract_preparation_missing'; END IF;
  IF v_op_state IS NULL OR v_op_state NOT IN ('claimed','broadcast_unknown')
  THEN RAISE EXCEPTION 'tier2_send_contract_requires_live_send'; END IF;
  IF NOT public.t2_leg_state_admitted(p_leg,v_state)
  THEN RAISE EXCEPTION 'tier2_send_contract_leg_illegal_in_state:%:%',p_leg,v_state; END IF;

  -- Close instructions reclaim only bounded rent and are deliberately treated
  -- as non-value here: their amount/destination/payment digest are not claimed
  -- to be bound. Terminal guards require close proof or a capped ops exception.
  v_value_leg:=p_leg NOT IN
    ('pricing_publish','close_pending','close_depositor_ata','close_escrow','bounty');
  IF v_value_leg AND (
       v_amount IS NULL OR v_destination IS NULL
       OR v_amount<>trunc(v_amount)
       OR v_amount NOT BETWEEN 0 AND 18446744073709551615
       OR v_destination !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
       OR v_payment_digest IS NULL OR octet_length(v_payment_digest)<>32
       OR v_payment_digest IS DISTINCT FROM public.t2_payment_coordinate_digest(
            p_bounty,p_leg,p_operation,v_generation,v_amount,v_destination)
     )
  THEN RAISE EXCEPTION 'tier2_payment_coordinate_digest_invalid'; END IF;
  IF p_leg='funding_sol' AND v_destination IS DISTINCT FROM v_depositor
  THEN RAISE EXCEPTION 'tier2_funding_sol_custody_destination_mismatch'; END IF;
  IF p_leg='funding_usdc' AND v_destination IS DISTINCT FROM v_depositor_ata
  THEN RAISE EXCEPTION 'tier2_funding_usdc_custody_destination_mismatch'; END IF;
  IF p_leg IN ('refund_withdraw_usdc','withdraw_dust_usdc')
     AND v_destination IS DISTINCT FROM v_depositor_ata
  THEN RAISE EXCEPTION 'tier2_withdraw_custody_destination_mismatch'; END IF;
  IF p_leg='vault_open' AND v_destination IS DISTINCT FROM v_vault
  THEN RAISE EXCEPTION 'tier2_vault_destination_mismatch'; END IF;
  IF p_leg='sweep_sol' AND v_destination IS DISTINCT FROM v_sol_return
  THEN RAISE EXCEPTION 'tier2_sol_return_destination_mismatch'; END IF;

  v_liability_kinds:=CASE p_leg
    WHEN 'payout' THEN ARRAY['reward_payout']::varchar[]
    WHEN 'house_refund_to_poster' THEN ARRAY['house_poster_refund']::varchar[]
    WHEN 'fee_refund' THEN ARRAY['fee_refund']::varchar[]
    WHEN 'vault_open' THEN ARRAY['poster_prefund']::varchar[]
    WHEN 'refund_sweep_usdc' THEN ARRAY['poster_prefund','poster_refund']::varchar[]
    WHEN 'sweep_dust_usdc' THEN ARRAY['poster_refund']::varchar[]
    WHEN 'sweep_sol' THEN ARRAY['poster_refund']::varchar[]
    ELSE NULL END;
  v_liability_asset:=CASE WHEN p_leg='sweep_sol' THEN 'sol'
                          WHEN v_liability_kinds IS NOT NULL THEN 'usdc' END;
  IF v_liability_kinds IS NOT NULL THEN
    IF v_bound_bounty IS DISTINCT FROM p_bounty
       OR v_bound_kind IS NULL OR NOT (v_bound_kind=ANY(v_liability_kinds))
       OR v_bound_asset IS DISTINCT FROM v_liability_asset
       OR v_bound_epoch IS NULL
    THEN RAISE EXCEPTION 'tier2_send_contract_liability_binding_missing'; END IF;
    SELECT l.liability_atomic,l.expected_dest,l.alternate_dest,l.custody_source,
           l.settlement_mode
      INTO v_liability_amount,v_liability_dest,v_liability_alt,v_custody_source,
           v_settlement_mode
      FROM public.bounty_tier2_liabilities l
      WHERE l.bounty_id=v_bound_bounty AND l.kind=v_bound_kind
        AND l.asset_kind=v_bound_asset AND l.epoch=v_bound_epoch
        AND l.disposition='open'
      FOR UPDATE;
    v_route_dest:=CASE WHEN v_bound_kind='poster_prefund'
                            AND p_leg='refund_sweep_usdc'
                       THEN v_liability_alt ELSE v_liability_dest END;
    IF v_bound_kind='poster_prefund' AND
       (v_custody_source IS DISTINCT FROM v_depositor_ata
        OR v_liability_dest IS DISTINCT FROM v_vault
        OR v_liability_alt IS DISTINCT FROM v_poster)
    THEN RAISE EXCEPTION 'tier2_send_contract_custody_route_mismatch'; END IF;
    IF v_bound_kind='poster_refund' AND
       (v_custody_source IS DISTINCT FROM
          CASE WHEN v_bound_asset='sol' THEN v_depositor ELSE v_depositor_ata END
        OR v_liability_dest IS DISTINCT FROM
          CASE WHEN v_bound_asset='sol' THEN v_sol_return ELSE v_poster END)
    THEN RAISE EXCEPTION 'tier2_send_contract_custody_route_mismatch'; END IF;
    IF NOT FOUND OR NOT (v_destination IS NOT DISTINCT FROM v_route_dest)
    THEN RAISE EXCEPTION 'tier2_send_contract_liability_mismatch'; END IF;
    IF v_settlement_mode='exact' AND
       NOT (v_amount IS NOT DISTINCT FROM v_liability_amount)
    THEN RAISE EXCEPTION 'tier2_send_contract_liability_mismatch'; END IF;
    IF v_settlement_mode='drain' THEN
      IF p_leg IS DISTINCT FROM 'sweep_sol'
         OR v_formula_inputs->>'source_balance_lamports' IS NULL
         OR v_formula_inputs->>'source_balance_lamports' !~ '^(0|[1-9][0-9]*)$'
         OR v_formula_inputs->>'drain_fee_lamports' IS NULL
         OR v_formula_inputs->>'drain_fee_lamports' !~ '^(0|[1-9][0-9]*)$'
         OR v_formula_inputs->>'post_balance_lamports' IS DISTINCT FROM '0'
      THEN RAISE EXCEPTION 'tier2_sol_drain_proof_invalid'; END IF;
      v_source_balance:=(v_formula_inputs->>'source_balance_lamports')::numeric;
      v_drain_fee:=(v_formula_inputs->>'drain_fee_lamports')::numeric;
      IF v_source_balance NOT BETWEEN 0 AND 18446744073709551615
         OR v_drain_fee NOT BETWEEN 0 AND v_estimated_fee
         OR v_source_balance IS DISTINCT FROM v_amount+v_drain_fee
      THEN RAISE EXCEPTION 'tier2_sol_drain_balance_mismatch'; END IF;
    END IF;
  ELSIF pg_catalog.num_nonnulls(v_bound_bounty,v_bound_kind,v_bound_asset,v_bound_epoch)<>0 THEN
    RAISE EXCEPTION 'tier2_send_contract_unexpected_liability_binding';
  END IF;
  IF p_leg IN ('refund_withdraw_usdc','withdraw_dust_usdc') THEN
    IF v_reserved_operation IS DISTINCT FROM p_operation
       OR v_reserved_leg IS DISTINCT FROM p_leg
       OR v_reserved_generation IS DISTINCT FROM v_generation
    THEN RAISE EXCEPTION 'tier2_poster_refund_slot_not_reserved'; END IF;
    IF EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
               WHERE l.bounty_id=p_bounty AND l.kind='poster_refund'
                 AND l.asset_kind='usdc' AND l.disposition='open')
    THEN RAISE EXCEPTION 'tier2_poster_refund_live_slot_occupied'; END IF;
  END IF;
  IF p_leg='payout' AND v_destination IS DISTINCT FROM v_hunter
  THEN RAISE EXCEPTION 'tier2_hunter_destination_mismatch'; END IF;
  IF p_leg IN ('fee_refund','house_refund_to_poster','refund_sweep_usdc','sweep_dust_usdc')
     AND v_destination IS DISTINCT FROM v_poster
  THEN RAISE EXCEPTION 'tier2_poster_destination_mismatch'; END IF;
  IF p_leg IN ('funding_sol','funding_usdc','sweep_sol','close_depositor_ata','close_escrow') THEN
    PERFORM 1 FROM public.bounty_tier2_depositors d
      WHERE d.bounty_id=p_bounty FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'tier2_depositor_missing'; END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.t2ps_reserve_before_prepare()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_budget numeric; v_spent numeric; v_succeeded uuid; v_live uuid;
        v_state varchar(24); v_max numeric;
BEGIN
  SELECT b.tier2_fee_budget_lamports,b.tier2_fee_spent_lamports
    INTO v_budget,v_spent FROM public.bounties b
    WHERE b.id=NEW.op_bounty_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT c.succeeded_operation_id,c.live_operation_id INTO v_succeeded,v_live
    FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=NEW.op_bounty_id AND c.leg=NEW.op_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  SELECT o.state INTO v_state FROM public.bounty_tier2_operations o
    WHERE o.id=NEW.operation_id AND o.bounty_id=NEW.op_bounty_id
      AND o.leg=NEW.op_leg AND o.generation=NEW.generation FOR UPDATE;
  IF NOT FOUND OR v_live IS DISTINCT FROM NEW.operation_id
  THEN RAISE EXCEPTION 'tier2_pre_sign_requires_live_operation'; END IF;
  IF v_state<>'claimed' THEN RAISE EXCEPTION 'tier2_prepare_requires_claim'; END IF;
  IF NEW.signature IS NOT NULL OR NEW.pre_sign_reserved_at IS NOT NULL
     OR NEW.signed_at IS NOT NULL OR NEW.sent_at IS NOT NULL
  THEN RAISE EXCEPTION 'tier2_prepare_must_be_unsigned'; END IF;
  IF NEW.op_leg IN ('fee_charge','fee_refund','funding_sol','funding_usdc','vault_open',
                    'settle','payout','house_refund_to_poster')
     AND v_succeeded IS NOT NULL
  THEN RAISE EXCEPTION 'tier2_once_only_already_succeeded'; END IF;
  SELECT p.value_num INTO v_max FROM public.tier2_policy p
    WHERE p.key='max_fee_per_send_lamports';
  IF v_max IS NULL OR v_max<>trunc(v_max) OR v_max<5000 OR v_max>500000
     OR NEW.estimated_fee_lamports IS DISTINCT FROM v_max
  THEN RAISE EXCEPTION 'tier2_fee_reservation_invalid'; END IF;
  IF v_spent+NEW.estimated_fee_lamports>v_budget
  THEN RAISE EXCEPTION 'tier2_fee_budget_exhausted'; END IF;
  IF NEW.op_leg='settle' AND
     (NEW.predicted_amount_atomic IS NULL OR NEW.account_version IS NULL
      OR NEW.account_fingerprint IS NULL OR NEW.formula_digest IS NULL
      OR NEW.formula_inputs='{}'::jsonb)
  THEN RAISE EXCEPTION 'tier2_arithmetic_fingerprint_missing'; END IF;
  UPDATE public.bounties SET
    tier2_fee_spent_lamports=tier2_fee_spent_lamports+NEW.estimated_fee_lamports
    WHERE id=NEW.op_bounty_id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.t2_authorize_transition(
  p_bounty uuid,p_old varchar,p_new varchar,p_actor varchar,
  p_evidence_kind varchar,p_leg varchar,p_evidence uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_kind varchar(24):=coalesce(p_evidence_kind,'');
        v_leg varchar(24):=coalesce(p_leg,'');
BEGIN
  IF p_bounty IS NULL OR p_new IS NULL OR p_actor IS NULL
  THEN RAISE EXCEPTION 'tier2_transition_coordinate_null'; END IF;
  IF p_old IS NULL THEN
    IF p_new<>'fee_pending' OR p_actor<>'admission' OR v_kind<>'' OR v_leg<>'' THEN
      RAISE EXCEPTION 'tier2_initial_transition_invalid';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.bounty_tier2_transitions t
    WHERE t.old_state=p_old AND t.new_state=p_new AND t.actor=p_actor
      AND t.evidence_kind=v_kind AND t.leg=v_leg
  ) THEN
    RAISE EXCEPTION 'tier2_transition_not_allowed:%:%:%:%:%',
      p_old,p_new,p_actor,v_kind,v_leg;
  END IF;
  IF v_kind<>'' AND NOT EXISTS (
    SELECT 1 FROM public.bounty_tier2_evidence e
    WHERE e.id=p_evidence AND e.bounty_id=p_bounty AND e.kind=v_kind
      AND (v_leg='' OR e.leg=v_leg)
  ) THEN RAISE EXCEPTION 'tier2_transition_evidence_invalid'; END IF;
  INSERT INTO public.tier2_ops_alerts (bounty_id,leg,kind,payload)
    VALUES (p_bounty,NULLIF(v_leg,''),'transition_intent',jsonb_build_object(
      'xid',pg_catalog.pg_current_xact_id()::text,'old_state',coalesce(p_old,''),
      'new_state',p_new,'actor',p_actor,'evidence_kind',v_kind,'leg',v_leg,
      'evidence_id',p_evidence));
END $$;

CREATE OR REPLACE FUNCTION public.b_t2_transition_validate()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v_token record;
BEGIN
  IF NEW.settlement_tier2 IS TRUE AND
     (NEW.composition_state IS DISTINCT FROM OLD.composition_state
      OR NEW.status IS DISTINCT FROM OLD.status) THEN
    SELECT a.payload INTO v_token
      FROM public.tier2_ops_alerts a
      WHERE a.bounty_id=NEW.id AND a.kind='transition_intent'
        AND a.payload->>'xid'=pg_catalog.pg_current_xact_id()::text
        AND a.payload->>'old_state'=coalesce(OLD.composition_state,'')
        AND a.payload->>'new_state'=coalesce(NEW.composition_state,'')
      ORDER BY a.created_at DESC,a.id DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tier2_transition_authority_missing:%:%',
        OLD.composition_state,NEW.composition_state;
    END IF;
    IF OLD.composition_state IS NULL THEN
      IF OLD.settlement_tier2 IS TRUE OR NEW.composition_state IS NULL
         OR NEW.composition_state<>'fee_pending'
         OR v_token.payload->>'actor'<>'admission'
      THEN RAISE EXCEPTION 'tier2_initial_transition_invalid'; END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.bounty_tier2_transitions t
      WHERE t.old_state=OLD.composition_state AND t.new_state=NEW.composition_state
        AND t.actor=v_token.payload->>'actor'
        AND t.evidence_kind=coalesce(v_token.payload->>'evidence_kind','')
        AND t.leg=coalesce(v_token.payload->>'leg','')
    ) THEN
      RAISE EXCEPTION 'tier2_transition_not_seeded_exactly:%:%',
        OLD.composition_state,NEW.composition_state;
    END IF;
    IF coalesce(v_token.payload->>'evidence_kind','')<>'' AND NOT EXISTS (
      SELECT 1 FROM public.bounty_tier2_evidence e
      WHERE e.id=(v_token.payload->>'evidence_id')::uuid AND e.bounty_id=NEW.id
        AND e.kind=v_token.payload->>'evidence_kind'
        AND (coalesce(v_token.payload->>'leg','')='' OR e.leg=v_token.payload->>'leg')
    ) THEN RAISE EXCEPTION 'tier2_transition_evidence_invalid'; END IF;
  END IF;
  IF NEW.settlement_tier2 IS TRUE AND NEW.composition_state='refunded'
     AND OLD.composition_state IS DISTINCT FROM 'refunded' THEN
    IF EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
               WHERE l.bounty_id=NEW.id AND l.disposition='open')
       OR NEW.tier2_balances_finalized_at IS NULL
       OR NEW.tier2_escrow_accounting_atomic IS DISTINCT FROM 0
       OR NEW.tier2_pending_amount_atomic IS DISTINCT FROM 0
       OR NEW.tier2_free_vault_balance_atomic IS DISTINCT FROM 0
       OR NOT EXISTS (SELECT 1 FROM public.bounty_tier2_evidence e
         WHERE e.id=NEW.tier2_balance_proof_id AND e.bounty_id=NEW.id
           AND e.leg=NEW.tier2_balance_proof_leg AND e.kind=NEW.tier2_balance_proof_kind
           AND e.kind='signature' AND e.chain_commitment='finalized'
           AND e.tx_succeeded IS TRUE AND e.leg IN ('refund_withdraw_usdc','close_escrow'))
       OR (NEW.tier2_vault_closed_proof_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.bounty_tier2_evidence e
         WHERE e.id=NEW.tier2_vault_closed_proof_id AND e.bounty_id=NEW.id
           AND e.leg='close_escrow' AND e.kind='signature'
           AND e.chain_commitment='finalized' AND e.tx_succeeded IS TRUE))
    THEN RAISE EXCEPTION 'tier2_refund_terminal_guard_failed'; END IF;
  END IF;
  IF NEW.settlement_tier2 IS TRUE AND NEW.composition_state='paid'
     AND OLD.composition_state IS DISTINCT FROM 'paid' THEN
    IF EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
               WHERE l.bounty_id=NEW.id AND l.disposition='open')
       OR NEW.tier2_balances_finalized_at IS NULL
       OR NEW.tier2_escrow_accounting_atomic IS DISTINCT FROM 0
       OR NEW.tier2_pending_amount_atomic IS DISTINCT FROM 0
       OR NEW.tier2_free_vault_balance_atomic IS DISTINCT FROM 0
       OR NOT EXISTS (SELECT 1 FROM public.bounty_tier2_evidence e
         WHERE e.id=NEW.tier2_balance_proof_id AND e.bounty_id=NEW.id
           AND e.leg=NEW.tier2_balance_proof_leg AND e.kind=NEW.tier2_balance_proof_kind
           AND e.kind='signature' AND e.chain_commitment='finalized'
           AND e.tx_succeeded IS TRUE)
       OR NOT (
         EXISTS (
           SELECT 1 FROM public.bounty_tier2_depositors d
           JOIN public.bounty_tier2_evidence ae
             ON ae.id=d.ata_closed_proof_id AND ae.bounty_id=d.bounty_id
            AND ae.leg='close_depositor_ata' AND ae.kind='signature'
            AND ae.chain_commitment='finalized' AND ae.tx_succeeded IS TRUE
           JOIN public.bounty_tier2_evidence ee
             ON ee.id=d.escrow_closed_proof_id AND ee.bounty_id=d.bounty_id
            AND ee.leg='close_escrow' AND ee.kind='signature'
            AND ee.chain_commitment='finalized' AND ee.tx_succeeded IS TRUE
           WHERE d.bounty_id=NEW.id AND d.ata_closed_at IS NOT NULL
             AND d.escrow_closed_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.bounty_tier2_evidence pe
               WHERE pe.bounty_id=NEW.id AND pe.leg='close_pending'
                 AND pe.kind='signature' AND pe.chain_commitment='finalized'
                 AND pe.tx_succeeded IS TRUE)
         )
         OR EXISTS (
           SELECT 1 FROM public.bounty_tier2_evidence ne
           WHERE ne.bounty_id=NEW.id AND ne.leg='bounty'
             AND ne.kind='accepted_nonrecoverable'
             AND ne.authority IS NOT DISTINCT FROM 'ops'
             AND ne.payload->>'scope'='cleanup_close_rent'
             AND ne.payload->>'amount_lamports' ~ '^[0-9]+$'
             AND (ne.payload->>'amount_lamports')::numeric BETWEEN 1 AND 9700280
         )
       )
    THEN RAISE EXCEPTION 'tier2_paid_terminal_guard_failed'; END IF;
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_assets'::regclass AND tgname='t2a_admitted' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2a_admitted BEFORE INSERT ON public.bounty_tier2_assets
      FOR EACH ROW EXECUTE FUNCTION public.t2a_assert_admitted();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_assets'::regclass AND tgname='t2a_no_change' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2a_no_change BEFORE UPDATE OR DELETE ON public.bounty_tier2_assets
      FOR EACH ROW EXECUTE FUNCTION public.t2a_freeze();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounties'::regclass AND tgname='b_t2_admitted_frozen' AND NOT tgisinternal) THEN
    CREATE TRIGGER b_t2_admitted_frozen BEFORE UPDATE ON public.bounties
      FOR EACH ROW EXECUTE FUNCTION public.b_t2_freeze_admitted();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_op_control'::regclass AND tgname='t2c_succ_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2c_succ_immutable BEFORE UPDATE ON public.bounty_tier2_op_control
      FOR EACH ROW EXECUTE FUNCTION public.t2c_succ_freeze();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_evidence'::regclass AND tgname='t2ev_append_only' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2ev_append_only BEFORE UPDATE OR DELETE ON public.bounty_tier2_evidence
      FOR EACH ROW EXECUTE FUNCTION public.t2_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_settle_captures'::regclass AND tgname='t2sc_append_only' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2sc_append_only BEFORE UPDATE OR DELETE ON public.bounty_tier2_settle_captures
      FOR EACH ROW EXECUTE FUNCTION public.t2_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_sol_balance_captures'::regclass AND tgname='t2sbc_append_only' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2sbc_append_only BEFORE UPDATE OR DELETE ON public.bounty_tier2_sol_balance_captures
      FOR EACH ROW EXECUTE FUNCTION public.t2_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.tier2_rpc_providers'::regclass AND tgname='t2rp_identity_frozen' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2rp_identity_frozen BEFORE UPDATE OR DELETE ON public.tier2_rpc_providers
      FOR EACH ROW EXECUTE FUNCTION public.t2rp_freeze();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_prepared_sends'::regclass AND tgname='t2ps_append_only' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2ps_append_only BEFORE UPDATE OR DELETE ON public.bounty_tier2_prepared_sends
      FOR EACH ROW EXECUTE FUNCTION public.t2ps_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_prepared_sends'::regclass AND tgname='t2ps_reserve_prepare' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2ps_reserve_prepare BEFORE INSERT ON public.bounty_tier2_prepared_sends
      FOR EACH ROW EXECUTE FUNCTION public.t2ps_reserve_before_prepare();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_settle_snapshots'::regclass AND tgname='t2ss_append_only' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2ss_append_only BEFORE UPDATE OR DELETE ON public.bounty_tier2_settle_snapshots
      FOR EACH ROW EXECUTE FUNCTION public.t2_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_payout_releases'::regclass AND tgname='t2pr_append_only' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2pr_append_only BEFORE UPDATE OR DELETE ON public.bounty_tier2_payout_releases
      FOR EACH ROW EXECUTE FUNCTION public.t2_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_liabilities'::regclass AND tgname='t2l_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2l_immutable BEFORE UPDATE OR DELETE ON public.bounty_tier2_liabilities
      FOR EACH ROW EXECUTE FUNCTION public.t2l_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_depositors'::regclass AND tgname='t2d_monotonic' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2d_monotonic BEFORE UPDATE OR DELETE ON public.bounty_tier2_depositors
      FOR EACH ROW EXECUTE FUNCTION public.t2d_monotonic();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounty_tier2_operations'::regclass AND tgname='t2o_state_legal' AND NOT tgisinternal) THEN
    CREATE TRIGGER t2o_state_legal BEFORE INSERT OR UPDATE ON public.bounty_tier2_operations
      FOR EACH ROW EXECUTE FUNCTION public.t2o_state_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.bounties'::regclass AND tgname='b_t2_transition_valid' AND NOT tgisinternal) THEN
    CREATE TRIGGER b_t2_transition_valid BEFORE UPDATE OF composition_state,status,settlement_tier2 ON public.bounties
      FOR EACH ROW EXECUTE FUNCTION public.b_t2_transition_validate();
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    WITH expected(rel,tgname,fn,tgtype) AS (VALUES
      ('public.bounty_attempts'::regclass,'ba_one_approved_guard','public.t2_attempt_one_approved_guard()'::regprocedure,23),
      ('public.bounty_tier2_assets'::regclass,'t2a_admitted','public.t2a_assert_admitted()'::regprocedure,7),
      ('public.bounty_tier2_assets'::regclass,'t2a_no_change','public.t2a_freeze()'::regprocedure,27),
      ('public.bounties'::regclass,'b_t2_admitted_frozen','public.b_t2_freeze_admitted()'::regprocedure,19),
      ('public.bounty_tier2_op_control'::regclass,'t2c_succ_immutable','public.t2c_succ_freeze()'::regprocedure,19),
      ('public.bounty_tier2_evidence'::regclass,'t2ev_append_only','public.t2_append_only()'::regprocedure,27),
      ('public.bounty_tier2_settle_captures'::regclass,'t2sc_append_only','public.t2_append_only()'::regprocedure,27),
      ('public.bounty_tier2_sol_balance_captures'::regclass,'t2sbc_append_only','public.t2_append_only()'::regprocedure,27),
      ('public.tier2_rpc_providers'::regclass,'t2rp_identity_frozen','public.t2rp_freeze()'::regprocedure,27),
      ('public.bounty_tier2_prepared_sends'::regclass,'t2ps_append_only','public.t2ps_guard()'::regprocedure,27),
      ('public.bounty_tier2_prepared_sends'::regclass,'t2ps_reserve_prepare','public.t2ps_reserve_before_prepare()'::regprocedure,7),
      ('public.bounty_tier2_settle_snapshots'::regclass,'t2ss_append_only','public.t2_append_only()'::regprocedure,27),
      ('public.bounty_tier2_payout_releases'::regclass,'t2pr_append_only','public.t2_append_only()'::regprocedure,27),
      ('public.bounty_tier2_liabilities'::regclass,'t2l_immutable','public.t2l_guard()'::regprocedure,27),
      ('public.bounty_tier2_depositors'::regclass,'t2d_monotonic','public.t2d_monotonic()'::regprocedure,27),
      ('public.bounty_tier2_operations'::regclass,'t2o_state_legal','public.t2o_state_guard()'::regprocedure,23),
      ('public.bounties'::regclass,'b_t2_transition_valid','public.b_t2_transition_validate()'::regprocedure,19)
    )
    SELECT 1 FROM expected e LEFT JOIN pg_catalog.pg_trigger t
      ON t.tgrelid=e.rel AND t.tgname=e.tgname AND NOT t.tgisinternal
     AND t.tgfoid=e.fn AND t.tgtype=e.tgtype AND t.tgenabled='O'
    WHERE t.oid IS NULL
  ) OR (SELECT count(*) FROM pg_catalog.pg_trigger t
        WHERE NOT t.tgisinternal AND
          (t.tgname LIKE 't2%' OR t.tgname LIKE 'b_t2%'
           OR t.tgname='ba_one_approved_guard'))<>17
  THEN RAISE EXCEPTION 'tier2_schema_drift: trigger inventory mismatch'; END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    WITH expected(index_name,table_name,is_unique,key_defs,predicate) AS (VALUES
      ('t2o_one_live','bounty_tier2_operations',true,ARRAY['bounty_id','leg']::text[],
       $pred$((state)::text = ANY ((ARRAY['pending'::character varying, 'claimed'::character varying, 'broadcast_unknown'::character varying])::text[]))$pred$),
      ('t2o_once_only_confirmed','bounty_tier2_operations',true,ARRAY['bounty_id','leg']::text[],
       $pred$(((state)::text = 'confirmed'::text) AND ((leg)::text = ANY ((ARRAY['fee_charge'::character varying, 'fee_refund'::character varying, 'funding_sol'::character varying, 'funding_usdc'::character varying, 'vault_open'::character varying, 'settle'::character varying, 'payout'::character varying, 'house_refund_to_poster'::character varying])::text[])))$pred$),
      ('t2o_one_settle','bounty_tier2_operations',true,ARRAY['bounty_id']::text[],
       $pred$(((leg)::text = 'settle'::text) AND ((state)::text = 'confirmed'::text))$pred$),
      ('t2ps_signature_uq','bounty_tier2_prepared_sends',true,ARRAY['signature']::text[],
       $pred$(signature IS NOT NULL)$pred$),
      ('t2ev_one_finalize_release','bounty_tier2_evidence',true,ARRAY['bounty_id']::text[],
       $pred$((kind)::text = 'finalize_release'::text)$pred$),
      ('t2ev_finalize_sig','bounty_tier2_evidence',true,ARRAY['bounty_id','chain_signature']::text[],
       $pred$((kind)::text = 'finalize_release'::text)$pred$),
      ('t2ev_one_approval','bounty_tier2_evidence',true,ARRAY['bounty_id']::text[],
       $pred$((kind)::text = 'approval'::text)$pred$),
      ('t2ev_sig_uq','bounty_tier2_evidence',true,ARRAY['chain_signature','leg']::text[],
       $pred$((kind)::text = 'signature'::text)$pred$),
      ('t2ev_one_arith','bounty_tier2_evidence',true,ARRAY['bounty_id']::text[],
       $pred$((kind)::text = 'arithmetic_violation'::text)$pred$),
      ('t2l_one_live','bounty_tier2_liabilities',true,ARRAY['bounty_id','kind','asset_kind']::text[],
       $pred$((disposition)::text = 'open'::text)$pred$),
      ('t2l_reward_open_proof','bounty_tier2_liabilities',true,ARRAY['open_proof_id']::text[],
       $pred$((kind)::text = 'reward_payout'::text)$pred$),
      ('t2l_live','bounty_tier2_liabilities',false,ARRAY['custody','unit']::text[],
       $pred$((disposition)::text = 'open'::text)$pred$)
    ), actual AS (
      SELECT c.relname AS index_name,t.relname AS table_name,am.amname,
        i.indisunique,i.indisvalid,i.indisready,i.indnullsnotdistinct,
        i.indnkeyatts,i.indnatts,i.indexprs,
        ARRAY(SELECT pg_catalog.pg_get_indexdef(i.indexrelid,k,true)
              FROM pg_catalog.generate_series(1,i.indnatts) k) AS key_defs,
        pg_catalog.pg_get_expr(i.indpred,i.indrelid) AS predicate
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
      JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
      JOIN pg_catalog.pg_am am ON am.oid=c.relam
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    )
    SELECT 1 FROM expected e LEFT JOIN actual a ON a.index_name=e.index_name
    WHERE a.index_name IS NULL OR a.table_name IS DISTINCT FROM e.table_name
      OR a.amname IS DISTINCT FROM 'btree' OR a.indisunique IS DISTINCT FROM e.is_unique
      OR a.indisvalid IS DISTINCT FROM true OR a.indisready IS DISTINCT FROM true
      OR a.indnullsnotdistinct IS DISTINCT FROM false OR a.indexprs IS NOT NULL
      OR a.indnkeyatts IS DISTINCT FROM cardinality(e.key_defs)
      OR a.indnatts IS DISTINCT FROM cardinality(e.key_defs)
      OR a.key_defs IS DISTINCT FROM e.key_defs
      OR a.predicate IS DISTINCT FROM e.predicate
  ) THEN RAISE EXCEPTION 'tier2_schema_drift: index definition mismatch'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.consume_refund_start(
  p_bounty uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_state varchar(32); v_intent timestamptz; v_fee public.bounty_tier2_evidence%ROWTYPE;
        v_mint varchar(64); v_genesis varchar(64); v_poster varchar(64);
BEGIN
  SELECT b.composition_state,b.tier2_cancel_intent_at,b.tier2_mint,
         b.tier2_cluster_genesis,b.tier2_poster_usdc_ata
    INTO v_state,v_intent,v_mint,v_genesis,v_poster
    FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg='bounty' FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty ORDER BY o.leg,o.generation FOR UPDATE;
  IF v_state='refund_pending' THEN RETURN false; END IF;
  IF v_intent IS NULL THEN RAISE EXCEPTION 'tier2_cancel_intent_missing'; END IF;
  IF EXISTS (SELECT 1 FROM public.bounty_tier2_evidence e
             WHERE e.bounty_id=p_bounty AND e.kind='approval')
     OR EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
                WHERE l.bounty_id=p_bounty AND l.kind='reward_payout'
                  AND l.disposition='open')
     OR EXISTS (SELECT 1 FROM public.bounty_tier2_payout_releases r
                WHERE r.bounty_id=p_bounty)
  THEN RAISE EXCEPTION 'tier2_refund_conflicts_with_approval'; END IF;
  IF v_state IS DISTINCT FROM 'create_failed'
  THEN RAISE EXCEPTION 'tier2_refund_start_illegal_state:%',v_state; END IF;
  SELECT e.* INTO v_fee FROM public.bounty_tier2_evidence e
    WHERE e.bounty_id=p_bounty AND e.leg='fee_charge' AND e.kind='signature'
      AND e.chain_commitment='finalized' AND e.tx_succeeded IS TRUE
    ORDER BY e.created_at,e.id LIMIT 1;
  IF FOUND AND v_fee.amount_atomic>0 THEN
    INSERT INTO public.bounty_tier2_liabilities
      (bounty_id,kind,asset_kind,mint,cluster_genesis,epoch,unit,custody,
       settlement_mode,liability_atomic,expected_dest,disposition,
       open_proof_id,open_proof_bounty,open_proof_leg,open_proof_kind)
      VALUES (p_bounty,'fee_refund','usdc',v_mint,v_genesis,1,'usdc_atomic',
              'house','exact',v_fee.amount_atomic,v_poster,'open',v_fee.id,
              p_bounty,'fee_charge','signature')
      ON CONFLICT (bounty_id,kind,asset_kind,epoch) DO NOTHING;
  END IF;
  PERFORM public.t2_authorize_transition(
    p_bounty,v_state,'refund_pending','driver','','',NULL);
  UPDATE public.bounties SET composition_state='refund_pending' WHERE id=p_bounty;
  INSERT INTO public.tier2_ops_alerts (bounty_id,leg,kind,payload)
    VALUES (p_bounty,'bounty','refund_intent_consumed',
      jsonb_build_object('source_state',v_state));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.consume_finalize_release(
  p_bounty uuid,p_operation uuid,p_capture uuid,p_note text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_rel uuid; v_arith uuid; v_state varchar(32); v_expected numeric;
  v_generation bigint; v_signature varchar(96); v_amount numeric; v_funded numeric;
  v_outer integer; v_inner integer; v_stack integer; v_stack_raw integer;
  v_provider varchar(32); v_provider_version integer; v_capture_digest bytea;
  v_pending varchar(64); v_escrow varchar(64); v_agent varchar(64);
  v_depositor varchar(64); v_credit_destination varchar(64);
  v_index numeric; v_snapshot_amount numeric;
  v_provisional boolean; v_snapshot_proof uuid; v_settle_operation uuid;
  v_predicted numeric; v_account_version varchar(64); v_account_fingerprint bytea;
  v_formula_digest bytea; v_funded_proof uuid; v_contradiction boolean;
BEGIN
  SELECT b.composition_state,b.payout_expected_atomic INTO v_state,v_expected
    FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg='finalize' FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg='finalize' ORDER BY o.generation FOR UPDATE;
  IF v_state IS DISTINCT FROM 'awaiting_finalize'
  THEN RAISE EXCEPTION 'tier2_finalize_release_illegal_state:%',v_state; END IF;

  SELECT o.generation,c.signature,c.decoded_amount_atomic,c.outer_instruction_index,
         c.inner_instruction_index,c.stack_height,c.stack_height_raw,c.provider_id,
         c.provider_identity_version,c.transaction_digest
    INTO v_generation,v_signature,v_amount,v_outer,v_inner,v_stack,v_stack_raw,
         v_provider,v_provider_version,v_capture_digest
    FROM public.bounty_tier2_operations o
    JOIN public.bounty_tier2_settle_captures c
      ON c.id=p_capture AND c.operation_id=o.id AND c.bounty_id=o.bounty_id
     AND c.operation_leg=o.leg AND c.operation_generation=o.generation
    JOIN public.tier2_rpc_providers rp
      ON rp.provider_id=c.provider_id AND rp.identity_version=c.provider_identity_version
    JOIN public.bounty_tier2_evidence se
      ON se.op_id=o.id AND se.op_bounty_id=o.bounty_id AND se.op_leg=o.leg
     AND se.op_generation=o.generation AND se.kind='signature'
     AND se.chain_signature=c.signature AND se.chain_commitment='finalized'
     AND se.tx_succeeded IS TRUE
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg='finalize'
      AND o.state='confirmed' AND c.capture_kind='finalize_transfer'
      AND c.observed_commitment='finalized' AND c.decoded_ok
      AND rp.active AND rp.archival;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_finalize_operation_capture_invalid'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.bounty_tier2_settle_captures c1
    JOIN public.tier2_rpc_providers p1
      ON p1.provider_id=c1.provider_id AND p1.identity_version=c1.provider_identity_version
    JOIN public.bounty_tier2_settle_captures c2
      ON c2.id<>c1.id AND c2.bounty_id=c1.bounty_id
     AND c2.capture_kind=c1.capture_kind AND c2.signature=c1.signature
     AND c2.operation_id=c1.operation_id AND c2.operation_generation=c1.operation_generation
     AND c2.observed_commitment='finalized' AND c2.decoded_ok
     AND c2.transaction_digest=c1.transaction_digest
     AND c2.transaction_bytes=c1.transaction_bytes
     AND ROW(c2.outer_instruction_index,c2.inner_instruction_index,c2.stack_height,
             c2.stack_height_raw,c2.descendant_outer_index,c2.descendant_inner_index,
             c2.descendant_stack_height,c2.decoded_pending_settlement,c2.decoded_escrow,
             c2.decoded_agent_pda,c2.decoded_depositor,c2.decoded_settlement_index,
             c2.decoded_amount_atomic,c2.decoded_destination)
         IS NOT DISTINCT FROM
         ROW(c1.outer_instruction_index,c1.inner_instruction_index,c1.stack_height,
             c1.stack_height_raw,c1.descendant_outer_index,c1.descendant_inner_index,
             c1.descendant_stack_height,c1.decoded_pending_settlement,c1.decoded_escrow,
             c1.decoded_agent_pda,c1.decoded_depositor,c1.decoded_settlement_index,
             c1.decoded_amount_atomic,c1.decoded_destination)
    JOIN public.tier2_rpc_providers p2
      ON p2.provider_id=c2.provider_id AND p2.identity_version=c2.provider_identity_version
    WHERE c1.id=p_capture AND p2.active AND p2.archival
      AND p1.endpoint_fingerprint<>p2.endpoint_fingerprint
      AND p1.operator_identity<>p2.operator_identity
      AND p1.failure_domain<>p2.failure_domain
  ) THEN RAISE EXCEPTION 'tier2_finalize_provider_independence_missing'; END IF;

  SELECT s.pending_settlement,s.escrow,s.agent_pda,s.depositor,s.settlement_index,
         s.pending_amount,s.amount_provisional,s.proof_id,sp.op_id,ps.predicted_amount_atomic,
         ps.account_version,ps.account_fingerprint,ps.formula_digest,
         ps.formula_inputs->>'finalize_destination'
    INTO v_pending,v_escrow,v_agent,v_depositor,v_index,v_snapshot_amount,
         v_provisional,v_snapshot_proof,v_settle_operation,v_predicted,
         v_account_version,v_account_fingerprint,v_formula_digest,v_credit_destination
    FROM public.bounty_tier2_settle_snapshots s
    JOIN public.bounty_tier2_evidence sp
      ON sp.id=s.proof_id AND sp.bounty_id=s.bounty_id AND sp.leg='settle'
     AND sp.kind='signature' AND sp.chain_commitment='finalized' AND sp.tx_succeeded IS TRUE
     AND sp.chain_signature=s.settle_signature
    JOIN public.bounty_tier2_operations so
      ON so.id=sp.op_id AND so.bounty_id=sp.op_bounty_id AND so.leg=sp.op_leg
     AND so.generation=sp.op_generation AND so.state='confirmed'
    JOIN public.bounty_tier2_prepared_sends ps
      ON ps.operation_id=so.id AND ps.op_bounty_id=so.bounty_id
     AND ps.op_leg=so.leg AND ps.generation=so.generation
     AND ps.sent_signature=sp.chain_signature
    WHERE s.bounty_id=p_bounty
      AND s.prepared_msg_digest=so.prepared_msg_digest
      AND s.account_version=ps.account_version
      AND s.account_fingerprint=ps.account_fingerprint
      AND s.formula_inputs=ps.formula_inputs
      AND s.formula_digest=ps.formula_digest;
  IF NOT FOUND OR v_predicted IS NULL OR v_predicted<>trunc(v_predicted)
     OR v_predicted NOT BETWEEN 0 AND 18446744073709551615
     OR v_credit_destination IS NULL
     OR v_credit_destination !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  THEN RAISE EXCEPTION 'tier2_settle_arithmetic_coordinate_invalid'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.bounty_tier2_settle_captures c
    WHERE c.id=p_capture AND c.decoded_pending_settlement=v_pending
      AND c.decoded_escrow=v_escrow AND c.decoded_agent_pda=v_agent
      AND c.decoded_depositor=v_depositor AND c.decoded_settlement_index=v_index
      AND c.decoded_destination=v_credit_destination
  ) THEN RAISE EXCEPTION 'tier2_finalize_snapshot_coordinate_mismatch'; END IF;

  SELECT d.funded_usdc_atomic,d.funded_usdc_proof_id INTO v_funded,v_funded_proof
    FROM public.bounty_tier2_depositors d
    JOIN public.bounty_tier2_evidence fe
      ON fe.id=d.funded_usdc_proof_id AND fe.bounty_id=d.funded_usdc_proof_bounty
     AND fe.leg=d.funded_usdc_proof_leg AND fe.kind=d.funded_usdc_proof_kind
     AND fe.leg='funding_usdc' AND fe.kind='signature'
     AND fe.chain_commitment='finalized' AND fe.tx_succeeded IS TRUE
     AND fe.amount_atomic=d.funded_usdc_atomic
    WHERE d.bounty_id=p_bounty FOR SHARE OF d;
  IF NOT FOUND OR v_amount IS NULL OR v_funded IS NULL
     OR v_amount<>trunc(v_amount) OR v_funded<>trunc(v_funded)
     OR v_amount NOT BETWEEN 0 AND 18446744073709551615
     OR v_funded NOT BETWEEN 0 AND 18446744073709551615 OR v_amount>v_funded
  THEN RAISE EXCEPTION 'tier2_finalized_amount_outside_funded_bound'; END IF;

  v_contradiction:=v_amount IS DISTINCT FROM v_expected
    OR v_amount IS DISTINCT FROM v_predicted
    OR (NOT v_provisional AND v_amount IS DISTINCT FROM v_snapshot_amount);
  INSERT INTO public.bounty_tier2_evidence
    (bounty_id,leg,kind,chain_commitment,chain_signature,tx_succeeded,authority,
     outer_instruction_index,inner_instruction_index,stack_height,stack_height_raw,
     op_id,op_bounty_id,op_leg,op_generation,amount_atomic,funded_deposit_atomic,
     expected_destination,provider_id,provider_identity_version,finalize_capture_id,
     funded_proof_id,settle_snapshot_proof_id,source_finalize_evidence_id,
     predicted_amount_atomic,account_version,account_fingerprint,formula_digest,payload,note,
     consumed_by_operation_id,consumed_by_bounty_id)
    VALUES (p_bounty,'bounty','finalize_release','finalized',v_signature,true,NULL,
      v_outer,v_inner,v_stack,v_stack_raw,p_operation,p_bounty,'finalize',v_generation,
      v_amount,v_funded,v_credit_destination,v_provider,v_provider_version,p_capture,v_funded_proof,
      v_snapshot_proof,NULL,v_predicted,v_account_version,v_account_fingerprint,
      v_formula_digest,jsonb_build_object('settle_operation_id',v_settle_operation,
      'capture_transaction_digest',encode(v_capture_digest,'hex')),p_note,NULL,p_bounty)
    RETURNING id INTO v_rel;
  IF v_contradiction THEN
    INSERT INTO public.bounty_tier2_evidence
      (bounty_id,leg,kind,chain_commitment,chain_signature,tx_succeeded,authority,
       outer_instruction_index,inner_instruction_index,stack_height,stack_height_raw,
       op_id,op_bounty_id,op_leg,op_generation,amount_atomic,funded_deposit_atomic,
       expected_destination,provider_id,provider_identity_version,finalize_capture_id,
       funded_proof_id,settle_snapshot_proof_id,source_finalize_evidence_id,
       predicted_amount_atomic,account_version,account_fingerprint,formula_digest,payload,note,
       consumed_by_operation_id,consumed_by_bounty_id)
      VALUES (p_bounty,'bounty','arithmetic_violation',NULL,NULL,NULL,'oracle',
        NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,v_amount,v_funded,v_credit_destination,
        v_provider,v_provider_version,p_capture,v_funded_proof,v_snapshot_proof,v_rel,
        v_predicted,v_account_version,v_account_fingerprint,v_formula_digest,
        jsonb_build_object('finalize_proof_id',v_rel),
        p_note,NULL,p_bounty) RETURNING id INTO v_arith;
    PERFORM public.t2_authorize_transition(
      p_bounty,v_state,'arithmetic_branch_violation','driver','arithmetic_violation',
      'bounty',v_arith);
    UPDATE public.bounties SET composition_state='arithmetic_branch_violation',
      tier2_pending_amount_atomic=v_amount
      WHERE id=p_bounty;
  ELSE
    PERFORM public.t2_authorize_transition(
      p_bounty,v_state,'payout_ready','driver','finalize_release','bounty',v_rel);
    UPDATE public.bounties SET composition_state='payout_ready',
      tier2_pending_amount_atomic=v_amount
      WHERE id=p_bounty;
  END IF;
  RETURN v_rel;
END $$;

DROP FUNCTION IF EXISTS public.tier2_record_sol_balance_capture(
  uuid,uuid,varchar,varchar,varchar,integer,numeric,numeric,numeric,varchar,integer,bytea
);
CREATE OR REPLACE FUNCTION public.tier2_record_sol_balance_capture(
  p_bounty uuid,p_operation uuid,p_capture_kind varchar,p_signature varchar,
  p_source_account varchar,p_source_account_index integer,p_observed_slot numeric,
  p_pre_balance_lamports numeric,p_post_balance_lamports numeric,
  p_provider_id varchar,p_provider_identity_version integer,p_capture_breadcrumb bytea
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_generation bigint; v_state varchar(24); v_live uuid; v_depositor varchar(64);
  v_existing public.bounty_tier2_sol_balance_captures%ROWTYPE; v_capture uuid;
BEGIN
  SELECT d.public_key INTO v_depositor
    FROM public.bounties b
    JOIN public.bounty_tier2_depositors d ON d.bounty_id=b.id
    WHERE b.id=p_bounty AND b.settlement_tier2 FOR UPDATE OF b,d;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found_or_not_admitted'; END IF;
  SELECT c.live_operation_id INTO v_live
    FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg='sweep_sol' FOR UPDATE;
  SELECT o.generation,o.state INTO v_generation,v_state
    FROM public.bounty_tier2_operations o
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg='sweep_sol'
    FOR UPDATE;
  IF NOT FOUND OR v_live IS DISTINCT FROM p_operation
     OR v_state IS NULL OR v_state NOT IN ('claimed','broadcast_unknown')
  THEN RAISE EXCEPTION 'tier2_sol_capture_operation_invalid'; END IF;
  IF p_capture_kind IS NULL OR p_capture_kind NOT IN ('transaction','account')
     OR p_source_account IS DISTINCT FROM v_depositor
     OR p_observed_slot IS NULL OR p_observed_slot<>trunc(p_observed_slot)
     OR p_observed_slot NOT BETWEEN 0 AND 18446744073709551615
     OR p_pre_balance_lamports IS NULL OR p_post_balance_lamports IS NULL
     OR p_pre_balance_lamports<>trunc(p_pre_balance_lamports)
     OR p_post_balance_lamports<>trunc(p_post_balance_lamports)
     OR p_pre_balance_lamports NOT BETWEEN 0 AND 18446744073709551615
     OR p_post_balance_lamports NOT BETWEEN 0 AND 18446744073709551615
     OR p_capture_breadcrumb IS NULL OR octet_length(p_capture_breadcrumb)<>32
  THEN RAISE EXCEPTION 'tier2_sol_capture_fact_invalid'; END IF;
  PERFORM 1 FROM public.tier2_rpc_providers rp
    WHERE rp.provider_id=p_provider_id
      AND rp.identity_version=p_provider_identity_version
      AND rp.active AND rp.archival FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_sol_capture_provider_invalid'; END IF;
  IF p_capture_kind='transaction' THEN
    IF p_signature IS NULL OR p_source_account_index IS NULL
       OR p_source_account_index<0 OR p_pre_balance_lamports<p_post_balance_lamports
       OR NOT EXISTS (
         SELECT 1 FROM public.bounty_tier2_prepared_sends s
         WHERE s.operation_id=p_operation AND s.op_bounty_id=p_bounty
           AND s.op_leg='sweep_sol' AND s.generation=v_generation
           AND s.signature=p_signature AND s.sent_signature=p_signature
           AND s.sent_at IS NOT NULL)
    THEN RAISE EXCEPTION 'tier2_sol_transaction_capture_coordinate_invalid'; END IF;
  ELSE
    IF p_signature IS NOT NULL OR p_source_account_index IS NOT NULL
       OR p_pre_balance_lamports IS DISTINCT FROM p_post_balance_lamports
       OR v_state IS DISTINCT FROM 'claimed'
       OR EXISTS (
         SELECT 1 FROM public.bounty_tier2_prepared_sends s
         WHERE s.operation_id=p_operation AND s.generation=v_generation)
    THEN RAISE EXCEPTION 'tier2_sol_account_capture_coordinate_invalid'; END IF;
  END IF;
  SELECT c.* INTO v_existing FROM public.bounty_tier2_sol_balance_captures c
    WHERE c.operation_id=p_operation AND c.bounty_id=p_bounty
      AND c.operation_leg='sweep_sol' AND c.operation_generation=v_generation
      AND c.provider_id=p_provider_id
      AND c.provider_identity_version=p_provider_identity_version;
  IF FOUND THEN
    IF ROW(v_existing.capture_kind,v_existing.signature,v_existing.source_account,
           v_existing.source_account_index,v_existing.observed_slot,
           v_existing.pre_balance_lamports,v_existing.post_balance_lamports,
           v_existing.provider_id,v_existing.provider_identity_version,
           v_existing.capture_breadcrumb)
       IS DISTINCT FROM
       ROW(p_capture_kind,p_signature,p_source_account,p_source_account_index,
           p_observed_slot,p_pre_balance_lamports,p_post_balance_lamports,
           p_provider_id,p_provider_identity_version,p_capture_breadcrumb)
    THEN RAISE EXCEPTION 'tier2_sol_capture_conflict'; END IF;
    RETURN v_existing.id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bounty_tier2_sol_balance_captures prior
    WHERE prior.bounty_id=p_bounty AND prior.source_account=p_source_account
      AND prior.operation_generation<v_generation
      AND prior.observed_slot>=p_observed_slot
  ) THEN RAISE EXCEPTION 'tier2_sol_observed_slot_not_increasing'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.bounty_tier2_sol_balance_captures prior
    WHERE prior.bounty_id=p_bounty AND prior.source_account=p_source_account
      AND prior.operation_generation<v_generation
      AND p_pre_balance_lamports<prior.post_balance_lamports
      AND NOT EXISTS (
        SELECT 1 FROM public.bounty_tier2_operations sweep
        WHERE sweep.bounty_id=p_bounty AND sweep.leg='sweep_sol'
          AND sweep.state='confirmed'
          AND sweep.generation>prior.operation_generation
          AND sweep.generation<v_generation)
  ) THEN RAISE EXCEPTION 'tier2_sol_balance_regression_unexplained'; END IF;
  INSERT INTO public.bounty_tier2_sol_balance_captures
    (bounty_id,operation_id,operation_leg,operation_generation,capture_kind,
     signature,source_account,source_account_index,observed_commitment,
     observed_slot,pre_balance_lamports,post_balance_lamports,provider_id,
     provider_identity_version,capture_breadcrumb)
  VALUES (p_bounty,p_operation,'sweep_sol',v_generation,p_capture_kind,p_signature,
          p_source_account,p_source_account_index,'finalized',p_observed_slot,
          p_pre_balance_lamports,p_post_balance_lamports,p_provider_id,
          p_provider_identity_version,p_capture_breadcrumb)
  RETURNING id INTO v_capture;
  RETURN v_capture;
END $$;

CREATE OR REPLACE FUNCTION public.consume_sol_no_send_disposition(
  p_bounty uuid,p_operation uuid,p_capture uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_generation bigint; v_state varchar(24); v_live uuid; v_capture_balance numeric;
  v_capture_breadcrumb bytea; v_depositor varchar(64); v_fee numeric; v_ev uuid;
  v_liability_epoch integer; v_liability_state varchar(12); v_zero boolean;
BEGIN
  SELECT d.public_key INTO v_depositor
    FROM public.bounties b
    JOIN public.bounty_tier2_depositors d ON d.bounty_id=b.id
    WHERE b.id=p_bounty AND b.settlement_tier2 FOR UPDATE OF b,d;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found_or_not_admitted'; END IF;
  SELECT c.live_operation_id INTO v_live
    FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg='sweep_sol' FOR UPDATE;
  SELECT o.generation,o.state INTO v_generation,v_state
    FROM public.bounty_tier2_operations o
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg='sweep_sol'
    FOR UPDATE;
  IF NOT FOUND OR v_live IS DISTINCT FROM p_operation OR v_state IS DISTINCT FROM 'claimed'
  THEN RAISE EXCEPTION 'tier2_sol_no_send_operation_invalid'; END IF;
  IF EXISTS (SELECT 1 FROM public.bounty_tier2_prepared_sends s
             WHERE s.operation_id=p_operation AND s.generation=v_generation)
  THEN RAISE EXCEPTION 'tier2_sol_no_send_prepared_send_exists'; END IF;
  SELECT c.post_balance_lamports,c.capture_breadcrumb
    INTO v_capture_balance,v_capture_breadcrumb
    FROM public.bounty_tier2_sol_balance_captures c
    JOIN public.tier2_rpc_providers rp
      ON rp.provider_id=c.provider_id AND rp.identity_version=c.provider_identity_version
    WHERE c.id=p_capture AND c.bounty_id=p_bounty
      AND c.operation_id=p_operation AND c.operation_leg='sweep_sol'
      AND c.operation_generation=v_generation AND c.capture_kind='account'
      AND c.signature IS NULL AND c.source_account=v_depositor
      AND c.observed_commitment='finalized' AND rp.active AND rp.archival;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_sol_no_send_capture_invalid'; END IF;
  SELECT p.value_num INTO v_fee FROM public.tier2_policy p
    WHERE p.key='sol_unsweepable_fee_lamports';
  IF v_fee IS DISTINCT FROM 5000
  THEN RAISE EXCEPTION 'tier2_sol_unsweepable_policy_invalid'; END IF;
  IF v_capture_balance>=v_fee
  THEN RAISE EXCEPTION 'tier2_sol_remainder_is_sweepable'; END IF;
  SELECT l.epoch,l.disposition INTO v_liability_epoch,v_liability_state
    FROM public.bounty_tier2_liabilities l
    WHERE l.bounty_id=p_bounty AND l.kind='poster_refund' AND l.asset_kind='sol'
      AND l.settlement_mode='drain' FOR UPDATE;
  IF NOT FOUND OR v_liability_state IS DISTINCT FROM 'open'
  THEN RAISE EXCEPTION 'tier2_sol_liability_not_open'; END IF;
  v_zero:=v_capture_balance=0;
  IF v_zero AND NOT EXISTS (
    SELECT 1 FROM public.bounty_tier2_sol_balance_captures c1
    JOIN public.tier2_rpc_providers p1
      ON p1.provider_id=c1.provider_id AND p1.identity_version=c1.provider_identity_version
    JOIN public.bounty_tier2_sol_balance_captures c2
      ON c2.id<>c1.id AND c2.bounty_id=c1.bounty_id
     AND c2.capture_kind=c1.capture_kind
     AND c2.signature IS NOT DISTINCT FROM c1.signature
     AND c2.operation_id=c1.operation_id AND c2.operation_leg=c1.operation_leg
     AND c2.operation_generation=c1.operation_generation
     AND c2.source_account=c1.source_account
     AND c2.observed_commitment='finalized'
     AND c2.pre_balance_lamports=c1.pre_balance_lamports
     AND c2.post_balance_lamports=c1.post_balance_lamports
    JOIN public.tier2_rpc_providers p2
      ON p2.provider_id=c2.provider_id AND p2.identity_version=c2.provider_identity_version
    WHERE c1.id=p_capture AND p2.active AND p2.archival
      AND p1.endpoint_fingerprint<>p2.endpoint_fingerprint
      AND p1.operator_identity<>p2.operator_identity
      AND p1.failure_domain<>p2.failure_domain
  ) THEN RAISE EXCEPTION 'tier2_sol_balance_independence_missing'; END IF;
  INSERT INTO public.bounty_tier2_evidence
    (bounty_id,leg,kind,chain_commitment,chain_signature,tx_succeeded,authority,
     op_id,op_bounty_id,op_leg,op_generation,sol_balance_capture_id,payload,note,
     consumed_by_operation_id,consumed_by_bounty_id)
  VALUES (p_bounty,'sweep_sol','sol_balance_disposition','finalized',NULL,NULL,NULL,
     p_operation,p_bounty,'sweep_sol',v_generation,p_capture,
     jsonb_build_object('disposition',CASE WHEN v_zero THEN 'already_zero'
                                          ELSE 'accepted_sub_fee' END,
                        'finalized_balance_lamports',v_capture_balance,
                        'unsweepable_fee_lamports',v_fee,
                        'capture_breadcrumb',encode(v_capture_breadcrumb,'hex')),
     CASE WHEN v_zero THEN 'finalized source balance already zero; no send required'
          ELSE 'finalized source balance below fixed send-fee floor; governed exception' END,
     p_operation,NULL) RETURNING id INTO v_ev;
  UPDATE public.bounty_tier2_operations
    SET state='terminal_rejected',disposition='not_broadcast'
    WHERE id=p_operation;
  UPDATE public.bounty_tier2_op_control
    SET live_generation=NULL,live_operation_id=NULL,updated_at=statement_timestamp()
    WHERE bounty_id=p_bounty AND leg='sweep_sol';
  IF v_zero THEN
    UPDATE public.bounty_tier2_liabilities SET disposition='released',
      released_at=statement_timestamp(),release_proof_id=v_ev,
      release_proof_bounty=p_bounty,release_proof_leg='sweep_sol',
      release_proof_kind='sol_balance_disposition'
      WHERE bounty_id=p_bounty AND kind='poster_refund' AND asset_kind='sol'
        AND epoch=v_liability_epoch;
    UPDATE public.bounty_tier2_depositors SET swept_at=statement_timestamp(),
      swept_sol_proof_id=v_ev,swept_sol_proof_bounty=p_bounty,
      swept_sol_proof_leg='sweep_sol',swept_sol_proof_kind='sol_balance_disposition'
      WHERE bounty_id=p_bounty;
  ELSE
    UPDATE public.bounty_tier2_liabilities SET disposition='cancelled',
      cancelled_at=statement_timestamp(),cancel_proof_id=v_ev,
      cancel_proof_bounty=p_bounty,cancel_proof_leg='sweep_sol',
      cancel_proof_kind='sol_balance_disposition'
      WHERE bounty_id=p_bounty AND kind='poster_refund' AND asset_kind='sol'
        AND epoch=v_liability_epoch;
    INSERT INTO public.tier2_ops_alerts (bounty_id,leg,kind,payload)
      VALUES (p_bounty,'sweep_sol','sol_sub_fee_governed_exception',
        jsonb_build_object('balance_lamports',v_capture_balance,
                           'fee_floor_lamports',v_fee,'evidence_id',v_ev));
  END IF;
  RETURN v_ev;
END $$;

CREATE OR REPLACE FUNCTION public.consume_operation_confirmed(
  p_bounty uuid,p_leg varchar,p_operation uuid,p_signature varchar,
  p_amount numeric,p_destination varchar,p_actual_fee_lamports numeric
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_generation bigint; v_state varchar(24); v_once boolean; v_succeeded uuid; v_live uuid;
  v_ev uuid; v_estimated numeric; v_budget numeric; v_spent numeric; v_max numeric;
  v_mint varchar(64); v_genesis varchar(64); v_poster varchar(64); v_epoch integer;
  v_hunter varchar(64); v_vault varchar(64); v_sol_return varchar(64);
  v_depositor varchar(64); v_depositor_ata varchar(64);
  v_composition_state varchar(32); v_value_leg boolean;
  v_prepared_amount numeric; v_prepared_dest varchar(64); v_payment_digest bytea;
  v_sol_capture uuid; v_finalized_pre_balance numeric; v_finalized_post_balance numeric;
  v_sol_capture_breadcrumb bytea;
BEGIN
  SELECT b.tier2_fee_budget_lamports,b.tier2_fee_spent_lamports,b.tier2_mint,
         b.tier2_cluster_genesis,b.tier2_poster_usdc_ata,b.tier2_hunter_ata,
         b.tier2_vault_usdc_ata,b.tier2_sol_return_address,d.public_key,d.usdc_ata,
         b.composition_state
    INTO v_budget,v_spent,v_mint,v_genesis,v_poster,v_hunter,v_vault,v_sol_return,
         v_depositor,v_depositor_ata,v_composition_state
    FROM public.bounties b
    JOIN public.bounty_tier2_depositors d ON d.bounty_id=b.id
    WHERE b.id=p_bounty FOR UPDATE OF b,d;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT c.succeeded_operation_id,c.live_operation_id INTO v_succeeded,v_live
    FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=p_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg ORDER BY o.generation FOR UPDATE;
  SELECT o.generation,o.state INTO v_generation,v_state
    FROM public.bounty_tier2_operations o
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg=p_leg;
  IF NOT FOUND OR v_state IS NULL OR v_state NOT IN ('claimed','broadcast_unknown')
  THEN RAISE EXCEPTION 'tier2_confirm_operation_state_invalid'; END IF;
  IF v_live IS DISTINCT FROM p_operation
  THEN RAISE EXCEPTION 'tier2_confirm_requires_live_operation'; END IF;
  v_once:=p_leg IN ('fee_charge','fee_refund','funding_sol','funding_usdc','vault_open',
                    'settle','payout','house_refund_to_poster');
  IF v_once AND v_succeeded IS NOT NULL
  THEN RAISE EXCEPTION 'tier2_once_only_already_succeeded'; END IF;
  v_value_leg:=p_leg NOT IN
    ('pricing_publish','close_pending','close_depositor_ata','close_escrow','bounty');
  IF v_value_leg AND (p_amount IS NULL OR p_destination IS NULL
     OR p_amount<>trunc(p_amount) OR p_amount NOT BETWEEN 0 AND 18446744073709551615
     OR p_destination !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  THEN RAISE EXCEPTION 'tier2_value_confirmation_requires_exact_amount_destination'; END IF;
  PERFORM public.t2_assert_send_contract(p_bounty,p_leg,p_operation);
  SELECT s.estimated_fee_lamports,s.amount_atomic,s.destination,o.payment_message_digest
    INTO v_estimated,v_prepared_amount,v_prepared_dest,v_payment_digest
    FROM public.bounty_tier2_prepared_sends s
    JOIN public.bounty_tier2_operations o ON o.id=s.operation_id
    WHERE s.operation_id=p_operation AND s.generation=v_generation
      AND s.op_bounty_id=p_bounty AND s.op_leg=p_leg
      AND s.signature=p_signature AND s.sent_signature=p_signature
      AND s.sent_at IS NOT NULL
      AND s.destination IS NOT DISTINCT FROM p_destination
      AND s.amount_atomic IS NOT DISTINCT FROM p_amount;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_prepared_send_mismatch'; END IF;
  IF v_value_leg AND (v_prepared_amount IS NULL OR v_prepared_dest IS NULL
     OR v_payment_digest IS NULL OR octet_length(v_payment_digest)<>32
     OR v_payment_digest IS DISTINCT FROM public.t2_payment_coordinate_digest(
          p_bounty,p_leg,p_operation,v_generation,v_prepared_amount,v_prepared_dest))
  THEN RAISE EXCEPTION 'tier2_value_evidence_not_consumable'; END IF;
  IF p_leg IN ('payout') AND p_destination IS DISTINCT FROM v_hunter
  THEN RAISE EXCEPTION 'tier2_hunter_destination_mismatch'; END IF;
  IF p_leg IN ('fee_refund','house_refund_to_poster','refund_sweep_usdc','sweep_dust_usdc')
     AND p_destination IS DISTINCT FROM v_poster
  THEN RAISE EXCEPTION 'tier2_poster_destination_mismatch'; END IF;
  IF p_leg IN ('funding_sol','funding_usdc','sweep_sol','close_depositor_ata','close_escrow') THEN
    PERFORM 1 FROM public.bounty_tier2_depositors d
      WHERE d.bounty_id=p_bounty FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'tier2_depositor_missing'; END IF;
  END IF;
  SELECT p.value_num INTO v_max FROM public.tier2_policy p
    WHERE p.key='max_fee_per_send_lamports';
  IF v_max IS NULL OR v_max<>trunc(v_max) OR v_max<5000 OR v_max>500000
  THEN RAISE EXCEPTION 'tier2_policy_max_fee_out_of_range'; END IF;
  IF p_actual_fee_lamports IS NULL OR p_actual_fee_lamports<0
     OR p_actual_fee_lamports<>trunc(p_actual_fee_lamports)
     OR p_actual_fee_lamports>v_max OR v_spent<v_estimated
  THEN RAISE EXCEPTION 'tier2_actual_fee_invalid'; END IF;
  IF p_leg='sweep_sol' THEN
    SELECT c.id,c.pre_balance_lamports,c.post_balance_lamports,c.capture_breadcrumb
      INTO v_sol_capture,v_finalized_pre_balance,v_finalized_post_balance,
           v_sol_capture_breadcrumb
      FROM public.bounty_tier2_sol_balance_captures c
      JOIN public.tier2_rpc_providers rp
        ON rp.provider_id=c.provider_id AND rp.identity_version=c.provider_identity_version
      WHERE c.bounty_id=p_bounty AND c.operation_id=p_operation
        AND c.operation_leg='sweep_sol' AND c.operation_generation=v_generation
        AND c.capture_kind='transaction' AND c.signature=p_signature
        AND c.source_account=v_depositor AND c.observed_commitment='finalized'
        AND rp.active AND rp.archival;
    IF NOT FOUND OR p_destination IS DISTINCT FROM v_sol_return
       OR v_finalized_pre_balance IS DISTINCT FROM
          p_amount+p_actual_fee_lamports+v_finalized_post_balance
    THEN RAISE EXCEPTION 'tier2_sol_finalized_balance_capture_invalid'; END IF;
  END IF;
  UPDATE public.bounty_tier2_prepared_sends SET
    actual_fee_lamports=p_actual_fee_lamports
    WHERE operation_id=p_operation AND generation=v_generation;
  INSERT INTO public.bounty_tier2_evidence
    (bounty_id,leg,kind,chain_commitment,chain_signature,tx_succeeded,authority,
     outer_instruction_index,inner_instruction_index,stack_height,stack_height_raw,
     op_id,op_bounty_id,op_leg,op_generation,amount_atomic,funded_deposit_atomic,
     expected_destination,provider_id,provider_identity_version,sol_balance_capture_id,
     payload,note,
     consumed_by_operation_id,consumed_by_bounty_id)
    VALUES (p_bounty,p_leg,'signature','finalized',p_signature,true,NULL,
      NULL,NULL,NULL,NULL,p_operation,p_bounty,p_leg,v_generation,p_amount,NULL,
      p_destination,NULL,NULL,v_sol_capture,jsonb_build_object(
        'actual_fee_lamports',p_actual_fee_lamports,
        'finalized_pre_balance_lamports',CASE WHEN p_leg='sweep_sol'
          THEN v_finalized_pre_balance ELSE NULL END,
        'finalized_post_balance_lamports',CASE WHEN p_leg='sweep_sol'
          THEN v_finalized_post_balance ELSE NULL END,
        'balance_capture_breadcrumb',CASE WHEN p_leg='sweep_sol'
          THEN encode(v_sol_capture_breadcrumb,'hex') ELSE NULL END),
      NULL,p_operation,NULL) RETURNING id INTO v_ev;
  UPDATE public.bounty_tier2_operations SET state='confirmed',signature=p_signature,
    sent_at=(SELECT s.sent_at FROM public.bounty_tier2_prepared_sends s
             WHERE s.operation_id=p_operation AND s.generation=v_generation),
    confirmed_at=statement_timestamp() WHERE id=p_operation;
  UPDATE public.bounty_tier2_op_control SET
    live_generation=NULL,live_operation_id=NULL,
    succeeded_generation=CASE WHEN v_once THEN v_generation ELSE succeeded_generation END,
    succeeded_operation_id=CASE WHEN v_once THEN p_operation ELSE succeeded_operation_id END,
    succeeded_at=CASE WHEN v_once THEN statement_timestamp() ELSE succeeded_at END,
    updated_at=statement_timestamp()
    WHERE bounty_id=p_bounty AND leg=p_leg;
  UPDATE public.bounties SET
    tier2_fee_spent_lamports=tier2_fee_spent_lamports-v_estimated+p_actual_fee_lamports
    WHERE id=p_bounty;

  IF p_leg='funding_sol' THEN
    UPDATE public.bounty_tier2_depositors SET funded_sol_lamports=p_amount,
      funded_sol_proof_id=v_ev,funded_sol_proof_bounty=p_bounty,
      funded_sol_proof_leg=p_leg,funded_sol_proof_kind='signature'
      WHERE bounty_id=p_bounty;
    IF NOT FOUND THEN RAISE EXCEPTION 'tier2_depositor_missing'; END IF;
    IF p_amount>0 THEN
      INSERT INTO public.bounty_tier2_liabilities
        (bounty_id,kind,asset_kind,mint,cluster_genesis,epoch,unit,custody,
         settlement_mode,liability_atomic,expected_dest,custody_source,alternate_dest,
         disposition,
         open_proof_id,open_proof_bounty,open_proof_leg,open_proof_kind)
        VALUES (p_bounty,'poster_refund','sol',
          'So11111111111111111111111111111111111111112',v_genesis,1,'lamports',
           'depositor','drain',p_amount,v_sol_return,p_destination,NULL,'open',v_ev,p_bounty,
          'funding_sol','signature');
    END IF;
  ELSIF p_leg='funding_usdc' THEN
    UPDATE public.bounty_tier2_depositors SET funded_usdc_atomic=p_amount,
      funded_usdc_proof_id=v_ev,funded_usdc_proof_bounty=p_bounty,
      funded_usdc_proof_leg=p_leg,funded_usdc_proof_kind='signature'
      WHERE bounty_id=p_bounty;
    IF NOT FOUND THEN RAISE EXCEPTION 'tier2_depositor_missing'; END IF;
    IF p_amount>0 THEN
      INSERT INTO public.bounty_tier2_liabilities
        (bounty_id,kind,asset_kind,mint,cluster_genesis,epoch,unit,custody,
         settlement_mode,liability_atomic,expected_dest,custody_source,alternate_dest,
         disposition,
         open_proof_id,open_proof_bounty,open_proof_leg,open_proof_kind)
        VALUES (p_bounty,'poster_prefund','usdc',v_mint,v_genesis,1,'usdc_atomic',
          'depositor','exact',p_amount,v_vault,p_destination,v_poster,'open',v_ev,p_bounty,
          'funding_usdc','signature');
    END IF;
  ELSIF p_leg='sweep_sol' THEN
    IF v_finalized_post_balance=0 THEN
      UPDATE public.bounty_tier2_depositors SET swept_at=statement_timestamp(),
        swept_sol_proof_id=v_ev,swept_sol_proof_bounty=p_bounty,
        swept_sol_proof_leg=p_leg,swept_sol_proof_kind='signature'
        WHERE bounty_id=p_bounty;
    END IF;
  ELSIF p_leg='close_depositor_ata' THEN
    UPDATE public.bounty_tier2_depositors SET ata_closed_at=statement_timestamp(),
      ata_closed_proof_id=v_ev,ata_closed_proof_bounty=p_bounty,
      ata_closed_proof_leg=p_leg,ata_closed_proof_kind='signature'
      WHERE bounty_id=p_bounty;
  ELSIF p_leg='close_escrow' THEN
    UPDATE public.bounty_tier2_depositors SET escrow_closed_at=statement_timestamp(),
      escrow_closed_proof_id=v_ev,escrow_closed_proof_bounty=p_bounty,
      escrow_closed_proof_leg=p_leg,escrow_closed_proof_kind='signature'
      WHERE bounty_id=p_bounty;
    UPDATE public.bounties SET tier2_escrow_accounting_atomic=0,
      tier2_pending_amount_atomic=0,tier2_free_vault_balance_atomic=0,
      tier2_balances_finalized_at=statement_timestamp(),tier2_balance_proof_id=v_ev,
      tier2_balance_proof_bounty=p_bounty,tier2_balance_proof_leg=p_leg,
      tier2_balance_proof_kind='signature',tier2_vault_closed_proof_id=v_ev
      WHERE id=p_bounty;
  ELSIF p_leg IN ('refund_withdraw_usdc','withdraw_dust_usdc') THEN
    IF p_amount>0 THEN
      SELECT coalesce(max(l.epoch),0)+1 INTO v_epoch
        FROM public.bounty_tier2_liabilities l
        WHERE l.bounty_id=p_bounty AND l.kind='poster_refund' AND l.asset_kind='usdc';
      INSERT INTO public.bounty_tier2_liabilities
      (bounty_id,kind,asset_kind,mint,cluster_genesis,epoch,unit,custody,
       settlement_mode,liability_atomic,expected_dest,custody_source,alternate_dest,
       disposition,
       open_proof_id,open_proof_bounty,open_proof_leg,open_proof_kind,
       release_proof_id,release_proof_bounty,release_proof_leg,release_proof_kind,
       cancel_proof_id,cancel_proof_bounty,cancel_proof_leg,cancel_proof_kind,
       released_at,cancelled_at)
        VALUES (p_bounty,'poster_refund','usdc',v_mint,v_genesis,v_epoch,'usdc_atomic',
        'depositor','exact',p_amount,v_poster,p_destination,NULL,'open',v_ev,p_bounty,p_leg,'signature',
        NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    END IF;
    IF p_leg='refund_withdraw_usdc' THEN
      IF v_composition_state IN ('vault_held','settle_exhausted') THEN
        PERFORM public.t2_authorize_transition(
          p_bounty,v_composition_state,'refund_pending','driver','signature',p_leg,v_ev);
      ELSIF v_composition_state='create_failed' THEN
        INSERT INTO public.bounty_tier2_liabilities
          (bounty_id,kind,asset_kind,mint,cluster_genesis,epoch,unit,custody,
           settlement_mode,liability_atomic,expected_dest,disposition,
           open_proof_id,open_proof_bounty,open_proof_leg,open_proof_kind)
          SELECT p_bounty,'fee_refund','usdc',v_mint,v_genesis,1,'usdc_atomic',
                 'house','exact',e.amount_atomic,v_poster,'open',e.id,p_bounty,
                 'fee_charge','signature'
          FROM public.bounty_tier2_evidence e
          WHERE e.bounty_id=p_bounty AND e.leg='fee_charge' AND e.kind='signature'
            AND e.chain_commitment='finalized' AND e.tx_succeeded IS TRUE
            AND e.amount_atomic>0
          ORDER BY e.created_at,e.id LIMIT 1
          ON CONFLICT (bounty_id,kind,asset_kind,epoch) DO NOTHING;
        PERFORM public.t2_authorize_transition(
          p_bounty,v_composition_state,'refund_pending','driver','','',NULL);
      ELSIF v_composition_state IS DISTINCT FROM 'refund_pending' THEN
        RAISE EXCEPTION 'tier2_refund_withdraw_illegal_state:%',v_composition_state;
      END IF;
      UPDATE public.bounties SET composition_state='refund_pending',
        tier2_escrow_accounting_atomic=0,tier2_pending_amount_atomic=0,
        tier2_free_vault_balance_atomic=0,
        tier2_balances_finalized_at=statement_timestamp(),tier2_balance_proof_id=v_ev,
        tier2_balance_proof_bounty=p_bounty,tier2_balance_proof_leg=p_leg,
        tier2_balance_proof_kind='signature' WHERE id=p_bounty;
    END IF;
    UPDATE public.bounties SET
      tier2_poster_refund_reservation_operation=NULL,
      tier2_poster_refund_reservation_leg=NULL,
      tier2_poster_refund_reservation_generation=NULL
      WHERE id=p_bounty
        AND tier2_poster_refund_reservation_operation=p_operation;
  END IF;
  RETURN v_ev;
END $$;

CREATE OR REPLACE FUNCTION public.consume_arithmetic_violation(
  p_bounty uuid,p_evidence uuid
) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_state varchar(32); v_amount numeric; v_funded numeric; v_mint varchar(64);
        v_genesis varchar(64); v_poster varchar(64); v_source uuid;
BEGIN
  SELECT b.composition_state,b.tier2_mint,b.tier2_cluster_genesis,b.tier2_poster_usdc_ata
    INTO v_state,v_mint,v_genesis,v_poster FROM public.bounties b
    WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg='bounty' FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty ORDER BY o.leg,o.generation FOR UPDATE;
  IF v_state IS DISTINCT FROM 'arithmetic_branch_violation'
  THEN RAISE EXCEPTION 'tier2_arithmetic_refund_lost_state_lock'; END IF;
  SELECT e.amount_atomic,e.funded_deposit_atomic,e.source_finalize_evidence_id
    INTO v_amount,v_funded,v_source
    FROM public.bounty_tier2_evidence e
    JOIN public.bounty_tier2_evidence r
      ON r.id=e.source_finalize_evidence_id AND r.bounty_id=e.bounty_id
     AND r.leg='bounty' AND r.kind='finalize_release'
     AND r.chain_commitment='finalized' AND r.tx_succeeded IS TRUE
     AND r.amount_atomic=e.amount_atomic
     AND r.funded_deposit_atomic=e.funded_deposit_atomic
     AND r.finalize_capture_id=e.finalize_capture_id
     AND r.funded_proof_id=e.funded_proof_id
     AND r.settle_snapshot_proof_id=e.settle_snapshot_proof_id
     AND r.predicted_amount_atomic=e.predicted_amount_atomic
     AND r.account_version=e.account_version
     AND r.account_fingerprint=e.account_fingerprint
     AND r.formula_digest=e.formula_digest
    JOIN public.bounty_tier2_settle_captures c
      ON c.id=e.finalize_capture_id AND c.bounty_id=e.bounty_id
     AND c.operation_id=r.op_id AND c.operation_generation=r.op_generation
     AND c.capture_kind='finalize_transfer' AND c.observed_commitment='finalized'
     AND c.decoded_ok AND c.decoded_amount_atomic=e.amount_atomic
     AND c.signature=r.chain_signature
    JOIN public.bounty_tier2_depositors d
      ON d.bounty_id=e.bounty_id AND d.funded_usdc_proof_id=e.funded_proof_id
     AND d.funded_usdc_atomic=e.funded_deposit_atomic
    JOIN public.bounty_tier2_evidence fe
      ON fe.id=d.funded_usdc_proof_id AND fe.bounty_id=d.funded_usdc_proof_bounty
     AND fe.leg='funding_usdc' AND fe.kind='signature'
     AND fe.chain_commitment='finalized' AND fe.tx_succeeded IS TRUE
     AND fe.amount_atomic=d.funded_usdc_atomic
    JOIN public.bounty_tier2_settle_snapshots s
      ON s.bounty_id=e.bounty_id AND s.proof_id=e.settle_snapshot_proof_id
     AND s.account_version=e.account_version
     AND s.account_fingerprint=e.account_fingerprint
     AND s.formula_digest=e.formula_digest
    WHERE e.id=p_evidence AND e.bounty_id=p_bounty AND e.leg='bounty'
      AND e.kind='arithmetic_violation' FOR SHARE OF e,r,c,d;
  IF NOT FOUND OR v_source IS NULL OR v_amount IS NULL OR v_funded IS NULL
     OR v_amount<>trunc(v_amount) OR v_funded<>trunc(v_funded)
     OR v_amount NOT BETWEEN 0 AND 18446744073709551615
     OR v_funded NOT BETWEEN 0 AND 18446744073709551615 OR v_amount>v_funded
  THEN RAISE EXCEPTION 'tier2_arithmetic_evidence_invalid'; END IF;
  UPDATE public.bounty_tier2_liabilities SET disposition='cancelled',
    cancelled_at=statement_timestamp(),cancel_proof_id=p_evidence,
    cancel_proof_bounty=p_bounty,cancel_proof_leg='bounty',
    cancel_proof_kind='arithmetic_violation'
    WHERE bounty_id=p_bounty AND kind='reward_payout' AND asset_kind='usdc'
      AND disposition='open';
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_reward_liability_not_open'; END IF;
  IF v_amount>0 THEN
    INSERT INTO public.bounty_tier2_liabilities
      (bounty_id,kind,asset_kind,mint,cluster_genesis,epoch,unit,custody,
       settlement_mode,liability_atomic,expected_dest,disposition,
       open_proof_id,open_proof_bounty,open_proof_leg,open_proof_kind,
       release_proof_id,release_proof_bounty,release_proof_leg,release_proof_kind,
       cancel_proof_id,cancel_proof_bounty,cancel_proof_leg,cancel_proof_kind,
       released_at,cancelled_at)
      VALUES (p_bounty,'house_poster_refund','usdc',v_mint,v_genesis,1,
        'usdc_atomic','house','exact',v_amount,v_poster,'open',p_evidence,p_bounty,
        'bounty','arithmetic_violation',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
  END IF;
  PERFORM public.t2_authorize_transition(
    p_bounty,v_state,'refund_pending','ops','arithmetic_violation','bounty',p_evidence);
  UPDATE public.bounties SET composition_state='refund_pending' WHERE id=p_bounty;
  INSERT INTO public.tier2_ops_alerts (bounty_id,leg,kind,payload)
    VALUES (p_bounty,'bounty','arithmetic_refund_started',
      jsonb_build_object('amount_atomic',v_amount,'funded_deposit_atomic',v_funded));
  RETURN v_amount;
END $$;

-- ---------------------------------------------------------------------------
-- Eleven narrow SECURITY DEFINER write/read authorities
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.consume_ops_continue(
  p_bounty uuid,p_leg varchar,p_reason text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_state varchar(32); v_grants bigint; v_last timestamptz;
  v_live bigint; v_last_generation bigint; v_succeeded uuid; v_ng bigint; v_opid uuid;
  v_iv numeric; v_gr numeric; v_thr numeric; v_max numeric;
  v_auto numeric; v_auto_floor numeric; v_auto_ceil numeric;
  v_iv_floor numeric; v_iv_ceil numeric; v_gr_floor numeric; v_gr_ceil numeric;
  v_thr_floor numeric; v_thr_ceil numeric; v_max_floor numeric; v_max_ceil numeric;
  v_a1 uuid; v_p1 uuid; v_a2 uuid; v_p2 uuid;
BEGIN
  SELECT b.composition_state,b.tier2_ops_grants,b.tier2_last_grant_at
    INTO v_state,v_grants,v_last
    FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT c.live_generation,c.last_generation,c.succeeded_operation_id
    INTO v_live,v_last_generation,v_succeeded
    FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=p_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg ORDER BY o.generation FOR UPDATE;

  IF NOT public.t2_leg_state_admitted(p_leg,v_state)
  THEN RAISE EXCEPTION 'tier2_generation_leg_illegal_in_state:%:%',p_leg,v_state; END IF;

  IF p_leg IN ('fee_charge','fee_refund','funding_sol','funding_usdc','vault_open',
               'settle','payout','house_refund_to_poster')
     AND v_succeeded IS NOT NULL
  THEN RAISE EXCEPTION 'tier2_once_only_already_succeeded'; END IF;
  IF EXISTS (SELECT 1 FROM public.bounty_tier2_operations o
             WHERE o.bounty_id=p_bounty AND o.leg=p_leg
               AND o.state='broadcast_unknown')
  THEN RAISE EXCEPTION 'tier2_unknown_blocks_continue'; END IF;
  IF v_live IS NOT NULL THEN RAISE EXCEPTION 'tier2_live_operation_blocks_continue'; END IF;

  SELECT p.value_num,p.floor_num,p.ceil_num INTO v_iv,v_iv_floor,v_iv_ceil
    FROM public.tier2_policy p WHERE p.key='ops_continue_min_interval_ms';
  SELECT p.value_num,p.floor_num,p.ceil_num INTO v_gr,v_gr_floor,v_gr_ceil
    FROM public.tier2_policy p WHERE p.key='ops_continue_fee_grant_lamports';
  SELECT p.value_num,p.floor_num,p.ceil_num INTO v_thr,v_thr_floor,v_thr_ceil
    FROM public.tier2_policy p WHERE p.key='two_key_threshold_grants';
  SELECT p.value_num,p.floor_num,p.ceil_num INTO v_max,v_max_floor,v_max_ceil
    FROM public.tier2_policy p WHERE p.key='max_fee_per_send_lamports';
  SELECT p.value_num,p.floor_num,p.ceil_num INTO v_auto,v_auto_floor,v_auto_ceil
    FROM public.tier2_policy p WHERE p.key='automatic_fee_budget_lamports';
  IF v_iv IS NULL OR v_gr IS NULL OR v_thr IS NULL OR v_max IS NULL OR v_auto IS NULL THEN
    RAISE EXCEPTION 'tier2_policy_missing';
  END IF;
  IF v_iv<>trunc(v_iv) OR v_iv_floor<>trunc(v_iv_floor) OR v_iv_ceil<>trunc(v_iv_ceil)
     OR v_iv<60000 OR v_iv>86400000 OR v_iv_floor<60000 OR v_iv_ceil>86400000
  THEN RAISE EXCEPTION 'tier2_policy_interval_out_of_range'; END IF;
  IF v_max<>trunc(v_max) OR v_max_floor<>trunc(v_max_floor)
     OR v_max_ceil<>trunc(v_max_ceil) OR v_max<5000 OR v_max>500000
     OR v_max_floor<5000 OR v_max_ceil>500000
  THEN RAISE EXCEPTION 'tier2_policy_max_fee_out_of_range'; END IF;
  IF v_gr<>trunc(v_gr) OR v_gr_floor<>trunc(v_gr_floor)
     OR v_gr_ceil<>trunc(v_gr_ceil) OR v_gr<v_max OR v_gr>500000
     OR v_gr_floor<v_max OR v_gr_ceil>500000
  THEN RAISE EXCEPTION 'tier2_policy_grant_out_of_range'; END IF;
  IF v_thr<>trunc(v_thr) OR v_thr_floor<>trunc(v_thr_floor)
     OR v_thr_ceil<>trunc(v_thr_ceil) OR v_thr<1 OR v_thr>100
     OR v_thr_floor<1 OR v_thr_ceil>100
  THEN RAISE EXCEPTION 'tier2_policy_threshold_out_of_range'; END IF;
  IF v_auto<>trunc(v_auto) OR v_auto_floor<>trunc(v_auto_floor)
     OR v_auto_ceil<>trunc(v_auto_ceil) OR v_auto<v_max OR v_auto>2500000
     OR v_auto_floor<v_max OR v_auto_ceil>2500000
  THEN RAISE EXCEPTION 'tier2_policy_automatic_budget_out_of_range'; END IF;
  IF v_last IS NOT NULL AND statement_timestamp()-v_last < v_iv*interval '1 millisecond'
  THEN RAISE EXCEPTION 'tier2_continue_rate_limited'; END IF;

  SELECT greatest(v_last_generation,coalesce(max(o.generation),0))+1 INTO v_ng
    FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg;
  SELECT a.id,a.principal_id INTO v_a1,v_p1
    FROM public.tier2_ops_authorizations a
    JOIN public.tier2_ops_principals p ON p.principal_id=a.principal_id AND p.active
    WHERE a.bounty_id=p_bounty AND a.leg=p_leg AND a.next_generation=v_ng
      AND a.grant_lamports=v_gr AND a.reason=p_reason
      AND a.consumed_at IS NULL AND a.expires_at>statement_timestamp()
    ORDER BY a.id FOR UPDATE OF a LIMIT 1;
  IF v_a1 IS NULL THEN RAISE EXCEPTION 'tier2_authorization_missing'; END IF;
  IF v_grants>=v_thr THEN
    SELECT a.id,a.principal_id INTO v_a2,v_p2
      FROM public.tier2_ops_authorizations a
      JOIN public.tier2_ops_principals p ON p.principal_id=a.principal_id AND p.active
      WHERE a.bounty_id=p_bounty AND a.leg=p_leg AND a.next_generation=v_ng
        AND a.grant_lamports=v_gr AND a.reason=p_reason
        AND a.consumed_at IS NULL AND a.expires_at>statement_timestamp()
        AND a.principal_id<>v_p1
      ORDER BY a.id FOR UPDATE OF a LIMIT 1;
    IF v_a2 IS NULL THEN RAISE EXCEPTION 'tier2_continue_needs_second_authorizer'; END IF;
  END IF;

  INSERT INTO public.bounty_tier2_operations
    (bounty_id,leg,generation,state)
    VALUES (p_bounty,p_leg,v_ng,'pending') RETURNING id INTO v_opid;
  INSERT INTO public.bounty_tier2_evidence
    (bounty_id,leg,kind,chain_commitment,chain_signature,tx_succeeded,authority,
     outer_instruction_index,inner_instruction_index,stack_height,stack_height_raw,
     op_id,op_bounty_id,op_leg,op_generation,amount_atomic,funded_deposit_atomic,
     expected_destination,provider_id,provider_identity_version,payload,note,
     consumed_by_operation_id,consumed_by_bounty_id)
    VALUES (p_bounty,p_leg,'ops_continue',NULL,NULL,NULL,'ops',NULL,NULL,NULL,NULL,
      v_opid,p_bounty,p_leg,v_ng,NULL,NULL,NULL,NULL,NULL,
      jsonb_build_object('auth1',v_a1,'auth2',v_a2,'reason',p_reason,
                         'grant_lamports',v_gr),NULL,NULL,NULL);
  UPDATE public.tier2_ops_authorizations
    SET consumed_at=statement_timestamp(),consumed_by=v_opid
    WHERE id=v_a1 OR (v_a2 IS NOT NULL AND id=v_a2);
  UPDATE public.bounty_tier2_op_control
    SET auto_attempts=0,last_generation=v_ng,live_generation=v_ng,live_operation_id=v_opid,
        updated_at=statement_timestamp()
    WHERE bounty_id=p_bounty AND leg=p_leg;
  UPDATE public.bounties SET
    tier2_fee_budget_lamports=tier2_fee_budget_lamports+v_gr,
    tier2_ops_grants=tier2_ops_grants+1,
    tier2_last_grant_at=statement_timestamp()
    WHERE id=p_bounty;
  INSERT INTO public.tier2_ops_alerts (bounty_id,leg,kind,payload)
    VALUES (p_bounty,p_leg,'ops_continue_granted',
      jsonb_build_object('generation',v_ng,'grant_lamports',v_gr,'reason',p_reason));
  RETURN v_ng;
END $$;

CREATE OR REPLACE FUNCTION public.consume_settle_snapshot(
  p_bounty uuid,p_pending varchar,p_escrow varchar,p_agent varchar,p_depositor varchar,
  p_index numeric,p_calls numeric,p_amount numeric,p_provisional boolean,
  p_service_hash bytea,p_release_slot numeric,p_event_timestamp bigint,
  p_signature varchar,p_settle_slot numeric,p_prepared_digest bytea,
  p_account_version varchar,p_account_fingerprint bytea,p_formula_inputs jsonb,
  p_formula_digest bytea,p_proof uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_existing record; v_state varchar(32);
BEGIN
  SELECT b.composition_state INTO v_state
    FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg='settle' FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg='settle' ORDER BY o.generation FOR UPDATE;
  IF v_state IS NULL OR v_state NOT IN ('vault_held','settle_snapshot_ops_pending','awaiting_finalize')
  THEN RAISE EXCEPTION 'tier2_snapshot_illegal_state:%',v_state; END IF;
  IF p_pending IS NULL OR p_pending !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_escrow IS NULL OR p_escrow !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_agent IS NULL OR p_agent !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_depositor IS NULL OR p_depositor !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_signature IS NULL OR p_account_version IS NULL
     OR p_formula_inputs IS NULL OR p_proof IS NULL
     OR p_index IS NULL OR p_calls IS NULL OR p_settle_slot IS NULL
     OR p_provisional IS NULL
     OR p_index<>trunc(p_index) OR p_calls<>trunc(p_calls)
     OR p_settle_slot<>trunc(p_settle_slot)
     OR p_index NOT BETWEEN 0 AND 18446744073709551615
     OR p_calls NOT BETWEEN 0 AND 18446744073709551615
     OR p_settle_slot NOT BETWEEN 0 AND 18446744073709551615
     OR (p_amount IS NOT NULL AND (p_amount<>trunc(p_amount)
       OR p_amount NOT BETWEEN 0 AND 18446744073709551615))
     OR (p_release_slot IS NOT NULL AND (p_release_slot<>trunc(p_release_slot)
       OR p_release_slot NOT BETWEEN 0 AND 18446744073709551615))
     OR (p_event_timestamp IS NOT NULL AND p_event_timestamp<0)
     OR p_service_hash IS NULL OR octet_length(p_service_hash)<>32
     OR p_prepared_digest IS NULL OR octet_length(p_prepared_digest)<>32
     OR p_account_fingerprint IS NULL OR octet_length(p_account_fingerprint)<>32
     OR p_formula_digest IS NULL OR octet_length(p_formula_digest)<>32
  THEN RAISE EXCEPTION 'tier2_snapshot_numeric_invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bounty_tier2_evidence e
    JOIN public.bounty_tier2_operations o
      ON o.id=e.op_id AND o.bounty_id=e.op_bounty_id AND o.leg=e.op_leg
     AND o.generation=e.op_generation AND o.state='confirmed'
    JOIN public.bounty_tier2_prepared_sends ps
      ON ps.operation_id=o.id AND ps.op_bounty_id=o.bounty_id AND ps.op_leg=o.leg
     AND ps.generation=o.generation AND ps.sent_signature=e.chain_signature
    WHERE e.id=p_proof AND e.bounty_id=p_bounty AND e.leg='settle'
      AND e.kind='signature' AND e.chain_commitment='finalized' AND e.tx_succeeded IS TRUE
      AND e.chain_signature=p_signature AND o.prepared_msg_digest=p_prepared_digest
      AND ps.account_version=p_account_version
      AND ps.account_fingerprint=p_account_fingerprint
      AND ps.formula_inputs=p_formula_inputs AND ps.formula_digest=p_formula_digest)
  THEN RAISE EXCEPTION 'tier2_snapshot_proof_invalid'; END IF;
  IF NOT p_provisional
     AND NOT EXISTS (SELECT 1 FROM public.bounty_tier2_settle_captures c
                     WHERE c.bounty_id=p_bounty AND c.signature=p_signature
                       AND c.observed_commitment='finalized')
     AND NOT EXISTS (
       SELECT 1 FROM public.bounty_tier2_settle_captures c
       JOIN public.tier2_rpc_providers p
         ON p.provider_id=c.provider_id
        AND p.identity_version=c.provider_identity_version
        WHERE c.bounty_id=p_bounty AND c.signature=p_signature AND c.candidate_event_bytes IS NOT NULL
       GROUP BY c.candidate_event_bytes
       HAVING count(DISTINCT p.endpoint_fingerprint)>=2
          AND count(DISTINCT p.operator_identity)>=2
          AND count(DISTINCT p.failure_domain)>=2
     )
  THEN RAISE EXCEPTION 'tier2_snapshot_provider_independence_missing'; END IF;

  SELECT s.pending_settlement,s.escrow,s.agent_pda,s.depositor,s.settlement_index,
         s.calls_to_settle,s.pending_amount,s.amount_provisional,s.service_hash,
         s.release_slot,s.event_timestamp,s.settle_signature,s.settle_slot,
         s.prepared_msg_digest,s.account_version,s.account_fingerprint,
         s.formula_inputs,s.formula_digest,s.proof_id
    INTO v_existing FROM public.bounty_tier2_settle_snapshots s
    WHERE s.bounty_id=p_bounty FOR UPDATE;
  IF FOUND THEN
    IF ROW(v_existing.pending_settlement,v_existing.escrow,v_existing.agent_pda,
           v_existing.depositor,v_existing.settlement_index,v_existing.calls_to_settle,
           v_existing.pending_amount,v_existing.amount_provisional,v_existing.service_hash,
           v_existing.release_slot,v_existing.event_timestamp,v_existing.settle_signature,
           v_existing.settle_slot,v_existing.prepared_msg_digest,v_existing.account_version,
           v_existing.account_fingerprint,v_existing.formula_inputs,
           v_existing.formula_digest,v_existing.proof_id)
       IS DISTINCT FROM
       ROW(p_pending,p_escrow,p_agent,p_depositor,p_index,p_calls,p_amount,p_provisional,
           p_service_hash,p_release_slot,p_event_timestamp,p_signature,p_settle_slot,
           p_prepared_digest,p_account_version,p_account_fingerprint,p_formula_inputs,
           p_formula_digest,p_proof)
    THEN RAISE EXCEPTION 'tier2_snapshot_conflict'; END IF;
    RETURN false;
  END IF;
  IF v_state='awaiting_finalize'
  THEN RAISE EXCEPTION 'tier2_snapshot_missing_in_awaiting_finalize'; END IF;
  INSERT INTO public.bounty_tier2_settle_snapshots
    (bounty_id,pending_settlement,escrow,agent_pda,depositor,settlement_index,
     calls_to_settle,pending_amount,amount_provisional,service_hash,release_slot,
     event_timestamp,settle_signature,settle_slot,prepared_msg_digest,account_version,
     account_fingerprint,formula_inputs,formula_digest,superseded_at,superseded_reason,
     proof_id,proof_bounty_id,proof_leg,proof_kind)
    VALUES (p_bounty,p_pending,p_escrow,p_agent,p_depositor,p_index,p_calls,p_amount,
      p_provisional,p_service_hash,p_release_slot,p_event_timestamp,p_signature,
      p_settle_slot,p_prepared_digest,p_account_version,p_account_fingerprint,
      p_formula_inputs,p_formula_digest,NULL,NULL,p_proof,p_bounty,'settle','signature');
  IF v_state IN ('vault_held','settle_snapshot_ops_pending') THEN
    PERFORM public.t2_authorize_transition(
      p_bounty,v_state,'awaiting_finalize',
      CASE WHEN v_state='vault_held' THEN 'settle' ELSE 'driver' END,
      'signature','settle',p_proof);
    UPDATE public.bounties SET composition_state='awaiting_finalize' WHERE id=p_bounty;
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.consume_approval_open_reward(
  p_bounty uuid,p_attempt uuid,p_amount numeric,p_expected_dest varchar
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_ev uuid; v_mint varchar(64); v_genesis varchar(64); v_hunter varchar(64);
        v_expected numeric; v_state varchar(32);
BEGIN
  SELECT b.tier2_mint,b.tier2_cluster_genesis,b.tier2_hunter_ata,
          b.payout_expected_atomic,b.composition_state
    INTO v_mint,v_genesis,v_hunter,v_expected,v_state FROM public.bounties b
    WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg='bounty' FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty ORDER BY o.leg,o.generation FOR UPDATE;
  IF v_state IS DISTINCT FROM 'vault_held'
  THEN RAISE EXCEPTION 'tier2_approval_illegal_state:%',v_state; END IF;
  IF pg_catalog.to_regclass('public.ba_one_approved') IS NULL
  THEN RAISE EXCEPTION 'tier2_approved_unique_index_missing'; END IF;
  IF p_amount IS NULL OR p_amount<=0 OR p_amount>18446744073709551615
     OR p_amount<>trunc(p_amount)
  THEN RAISE EXCEPTION 'tier2_reward_amount_invalid'; END IF;
  IF p_amount IS DISTINCT FROM v_expected
  THEN RAISE EXCEPTION 'tier2_reward_amount_not_admitted'; END IF;
  IF p_expected_dest IS DISTINCT FROM v_hunter
  THEN RAISE EXCEPTION 'tier2_hunter_destination_mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bounty_attempts a
    WHERE a.id=p_attempt AND a.bounty_id=p_bounty AND a.status='approved')
  THEN RAISE EXCEPTION 'tier2_approved_attempt_missing'; END IF;
  IF EXISTS (SELECT 1 FROM public.bounties b WHERE b.id=p_bounty
             AND b.tier2_cancel_intent_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.bounty_tier2_operations o
                WHERE o.bounty_id=p_bounty AND o.leg IN
                  ('refund_withdraw_usdc','refund_sweep_usdc')
                  AND o.state IN ('pending','claimed','broadcast_unknown','confirmed'))
     OR EXISTS (SELECT 1 FROM public.bounty_tier2_payout_releases r
                WHERE r.bounty_id=p_bounty)
  THEN RAISE EXCEPTION 'tier2_approval_conflicts_with_refund'; END IF;
  INSERT INTO public.bounty_tier2_evidence
    (bounty_id,leg,kind,chain_commitment,chain_signature,tx_succeeded,authority,
     outer_instruction_index,inner_instruction_index,stack_height,stack_height_raw,
     op_id,op_bounty_id,op_leg,op_generation,amount_atomic,funded_deposit_atomic,
     expected_destination,provider_id,provider_identity_version,payload,note,
     consumed_by_operation_id,consumed_by_bounty_id)
    VALUES (p_bounty,'bounty','approval',NULL,NULL,NULL,'app',NULL,NULL,NULL,NULL,
      NULL,NULL,NULL,NULL,p_amount,NULL,p_expected_dest,NULL,NULL,
      jsonb_build_object('approved_attempt_id',p_attempt),NULL,NULL,p_bounty)
    RETURNING id INTO v_ev;
  INSERT INTO public.bounty_tier2_liabilities
    (bounty_id,kind,asset_kind,mint,cluster_genesis,epoch,unit,custody,
     settlement_mode,liability_atomic,expected_dest,disposition,
     open_proof_id,open_proof_bounty,open_proof_leg,open_proof_kind,
     release_proof_id,release_proof_bounty,release_proof_leg,release_proof_kind,
     cancel_proof_id,cancel_proof_bounty,cancel_proof_leg,cancel_proof_kind,
     released_at,cancelled_at)
    VALUES (p_bounty,'reward_payout','usdc',v_mint,v_genesis,1,'usdc_atomic',
      'house','exact',p_amount,p_expected_dest,'open',v_ev,p_bounty,'bounty',
      'approval',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
  RETURN v_ev;
END $$;

CREATE OR REPLACE FUNCTION public.consume_cancel_intent(
  p_bounty uuid,p_actor uuid
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_at timestamptz; v_state varchar(32);
BEGIN
  SELECT b.tier2_cancel_intent_at,b.composition_state INTO v_at,v_state FROM public.bounties b
    WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg='bounty' FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty ORDER BY o.leg,o.generation FOR UPDATE;
  IF v_state IS NULL OR v_state NOT IN ('fee_pending','fee_unresolved','funding_pending','vault_pending',
                     'vault_confirmed','vault_unconfirmed','vault_held',
                     'settle_exhausted','create_failed')
  THEN RAISE EXCEPTION 'tier2_cancel_intent_illegal_state:%',v_state; END IF;
  IF p_actor IS NULL THEN RAISE EXCEPTION 'tier2_cancel_actor_required'; END IF;
  IF EXISTS (SELECT 1 FROM public.bounty_tier2_evidence e
             WHERE e.bounty_id=p_bounty AND e.kind='approval')
     OR EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
                WHERE l.bounty_id=p_bounty AND l.kind='reward_payout'
                  AND l.disposition='open')
     OR EXISTS (SELECT 1 FROM public.bounty_tier2_payout_releases r
                WHERE r.bounty_id=p_bounty)
  THEN RAISE EXCEPTION 'tier2_cancel_conflicts_with_approval'; END IF;
  IF v_at IS NULL THEN
    v_at:=statement_timestamp();
    UPDATE public.bounties SET tier2_cancel_intent_at=v_at,tier2_cancel_intent_by=p_actor
      WHERE id=p_bounty;
  ELSIF EXISTS (SELECT 1 FROM public.bounties b
                WHERE b.id=p_bounty AND b.tier2_cancel_intent_by<>p_actor) THEN
    RAISE EXCEPTION 'tier2_cancel_intent_owned';
  END IF;
  RETURN v_at;
END $$;
CREATE OR REPLACE FUNCTION public.release_liability(
  p_bounty uuid,p_kind varchar,p_asset varchar,p_epoch integer,p_evidence uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_leg varchar(24); v_operation uuid; v_generation bigint; v_amount numeric;
  v_dest varchar(64); v_expected varchar(64); v_liability numeric;
  v_digest bytea; v_poster varchar(64); v_hunter varchar(64); v_disposition varchar(12);
  v_alternate varchar(64); v_route_dest varchar(64); v_mode varchar(8);
  v_actual_fee numeric; v_evidence_payload jsonb; v_custody_source varchar(64);
  v_depositor varchar(64); v_depositor_ata varchar(64); v_sol_capture uuid;
  v_finalized_pre_balance numeric; v_finalized_post_balance numeric;
  v_sol_provider varchar(32); v_sol_provider_version integer; v_sol_observed_slot numeric;
BEGIN
  SELECT b.tier2_poster_usdc_ata,b.tier2_hunter_ata,d.public_key,d.usdc_ata
    INTO v_poster,v_hunter,v_depositor,v_depositor_ata
    FROM public.bounties b
    JOIN public.bounty_tier2_depositors d ON d.bounty_id=b.id
    WHERE b.id=p_bounty FOR UPDATE OF b,d;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT e.leg,e.op_id,e.op_generation,e.amount_atomic,e.expected_destination,e.payload,
         e.sol_balance_capture_id
    INTO v_leg,v_operation,v_generation,v_amount,v_dest,v_evidence_payload,v_sol_capture
    FROM public.bounty_tier2_evidence e
    WHERE e.id=p_evidence AND e.bounty_id=p_bounty AND e.kind='signature'
      AND e.chain_commitment='finalized' AND e.tx_succeeded IS TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_release_evidence_invalid'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=v_leg FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=v_leg ORDER BY o.generation FOR UPDATE;
  SELECT l.expected_dest,l.alternate_dest,l.liability_atomic,l.settlement_mode,
         l.disposition,l.custody_source
    INTO v_expected,v_alternate,v_liability,v_mode,v_disposition,v_custody_source
    FROM public.bounty_tier2_liabilities l
    WHERE l.bounty_id=p_bounty AND l.kind=p_kind AND l.asset_kind=p_asset
      AND l.epoch=p_epoch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_liability_missing'; END IF;
  IF v_disposition='released' THEN RETURN false; END IF;
  IF v_disposition<>'open' THEN RAISE EXCEPTION 'tier2_liability_not_open'; END IF;
  v_route_dest:=CASE WHEN p_kind='poster_prefund' AND v_leg='refund_sweep_usdc'
                     THEN v_alternate ELSE v_expected END;
  IF v_dest IS DISTINCT FROM v_route_dest
  THEN RAISE EXCEPTION 'tier2_liability_release_mismatch'; END IF;
  IF v_mode='exact' AND v_amount IS DISTINCT FROM v_liability
  THEN RAISE EXCEPTION 'tier2_liability_release_mismatch'; END IF;
  IF p_kind IN ('fee_refund','house_poster_refund')
     AND v_route_dest IS DISTINCT FROM v_poster
  THEN RAISE EXCEPTION 'tier2_poster_destination_mismatch'; END IF;
  IF p_kind='poster_refund' AND p_asset='usdc'
     AND v_route_dest IS DISTINCT FROM v_poster
  THEN RAISE EXCEPTION 'tier2_poster_destination_mismatch'; END IF;
  IF p_kind='poster_prefund' AND v_leg='refund_sweep_usdc'
     AND v_route_dest IS DISTINCT FROM v_poster
  THEN RAISE EXCEPTION 'tier2_poster_destination_mismatch'; END IF;
  IF p_kind='reward_payout' AND v_route_dest IS DISTINCT FROM v_hunter
  THEN RAISE EXCEPTION 'tier2_hunter_destination_mismatch'; END IF;
  IF p_kind='poster_prefund' AND p_asset='usdc'
     AND v_custody_source IS DISTINCT FROM v_depositor_ata
  THEN RAISE EXCEPTION 'tier2_liability_source_coordinate_mismatch'; END IF;
  IF p_kind='poster_refund'
     AND v_custody_source IS DISTINCT FROM
       (CASE WHEN p_asset='sol' THEN v_depositor ELSE v_depositor_ata END)
  THEN RAISE EXCEPTION 'tier2_liability_source_coordinate_mismatch'; END IF;
  SELECT o.payment_message_digest,s.actual_fee_lamports
    INTO v_digest,v_actual_fee
    FROM public.bounty_tier2_prepared_sends s
    JOIN public.bounty_tier2_operations o ON o.id=s.operation_id
    WHERE s.operation_id=v_operation AND s.generation=v_generation
      AND s.amount_atomic=v_amount AND s.destination=v_dest
      AND s.liability_bounty_id=p_bounty AND s.liability_kind=p_kind
      AND s.liability_asset_kind=p_asset AND s.liability_epoch=p_epoch
      AND s.sent_signature=(SELECT e.chain_signature FROM public.bounty_tier2_evidence e
                            WHERE e.id=p_evidence);
  IF NOT FOUND OR v_digest IS NULL OR octet_length(v_digest)<>32
     OR v_digest IS DISTINCT FROM public.t2_payment_coordinate_digest(
          p_bounty,v_leg,v_operation,v_generation,v_amount,v_dest)
  THEN RAISE EXCEPTION 'tier2_release_prepared_send_mismatch'; END IF;
  IF v_mode='drain' THEN
    IF v_leg IS DISTINCT FROM 'sweep_sol' OR p_asset IS DISTINCT FROM 'sol'
       OR v_sol_capture IS NULL OR v_actual_fee IS NULL
    THEN RAISE EXCEPTION 'tier2_sol_drain_proof_invalid'; END IF;
    SELECT c.pre_balance_lamports,c.post_balance_lamports,c.provider_id,
           c.provider_identity_version,c.observed_slot
      INTO v_finalized_pre_balance,v_finalized_post_balance,v_sol_provider,
           v_sol_provider_version,v_sol_observed_slot
      FROM public.bounty_tier2_sol_balance_captures c
      JOIN public.tier2_rpc_providers rp
        ON rp.provider_id=c.provider_id AND rp.identity_version=c.provider_identity_version
      JOIN public.bounty_tier2_operations o
        ON o.id=c.operation_id AND o.bounty_id=c.bounty_id
       AND o.leg=c.operation_leg AND o.generation=c.operation_generation
      WHERE c.id=v_sol_capture AND c.bounty_id=p_bounty
        AND c.operation_id=v_operation AND c.operation_leg='sweep_sol'
        AND c.operation_generation=v_generation AND c.capture_kind='transaction'
        AND c.signature=(SELECT e.chain_signature FROM public.bounty_tier2_evidence e
                         WHERE e.id=p_evidence)
        AND c.source_account=v_depositor AND c.observed_commitment='finalized'
        AND rp.active AND rp.archival AND o.state='confirmed';
    IF NOT FOUND OR v_finalized_post_balance IS DISTINCT FROM 0
       OR v_finalized_pre_balance IS DISTINCT FROM v_amount+v_actual_fee
       OR v_evidence_payload->>'finalized_post_balance_lamports' IS DISTINCT FROM '0'
    THEN RAISE EXCEPTION 'tier2_sol_finalized_zero_not_proven'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.bounty_tier2_sol_balance_captures c1
      JOIN public.tier2_rpc_providers p1
        ON p1.provider_id=c1.provider_id AND p1.identity_version=c1.provider_identity_version
      JOIN public.bounty_tier2_sol_balance_captures c2
        ON c2.id<>c1.id AND c2.bounty_id=c1.bounty_id
       AND c2.capture_kind=c1.capture_kind
       AND c2.signature IS NOT DISTINCT FROM c1.signature
       AND c2.operation_id=c1.operation_id AND c2.operation_leg=c1.operation_leg
       AND c2.operation_generation=c1.operation_generation
       AND c2.source_account=c1.source_account
       AND c2.observed_commitment='finalized'
       AND c2.pre_balance_lamports=c1.pre_balance_lamports
       AND c2.post_balance_lamports=c1.post_balance_lamports
      JOIN public.tier2_rpc_providers p2
        ON p2.provider_id=c2.provider_id AND p2.identity_version=c2.provider_identity_version
      WHERE c1.id=v_sol_capture AND p2.active AND p2.archival
        AND p1.endpoint_fingerprint<>p2.endpoint_fingerprint
        AND p1.operator_identity<>p2.operator_identity
        AND p1.failure_domain<>p2.failure_domain
    ) THEN RAISE EXCEPTION 'tier2_sol_balance_independence_missing'; END IF;
  END IF;
  UPDATE public.bounty_tier2_liabilities SET disposition='released',
    released_at=statement_timestamp(),release_proof_id=p_evidence,
    release_proof_bounty=p_bounty,release_proof_leg=v_leg,release_proof_kind='signature'
    WHERE bounty_id=p_bounty AND kind=p_kind AND asset_kind=p_asset AND epoch=p_epoch;
  IF p_kind='reward_payout' THEN
    INSERT INTO public.bounty_tier2_payout_releases
      (bounty_id,evidence_id,evidence_bounty_id,evidence_leg,evidence_kind,
       operation_id,operation_generation,payment_digest,released_atomic,
       expected_destination)
      VALUES (p_bounty,p_evidence,p_bounty,'payout','signature',v_operation,
              v_generation,v_digest,v_amount,v_dest);
  END IF;
  IF v_mode='drain' THEN
    INSERT INTO public.tier2_ops_alerts (bounty_id,leg,kind,payload)
      VALUES (p_bounty,'sweep_sol','sol_drain_liability_released',
        jsonb_build_object('capture_id',v_sol_capture,
                           'provider_id',v_sol_provider,
                           'provider_identity_version',v_sol_provider_version,
                           'observed_slot',v_sol_observed_slot,
                           'pre_balance_lamports',v_finalized_pre_balance,
                           'post_balance_lamports',v_finalized_post_balance));
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_transition(
  p_bounty uuid,p_old varchar,p_new varchar,
  p_evidence_kind varchar,p_leg varchar,p_evidence uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_state varchar(32); v_evidence_kind varchar(24):=coalesce(p_evidence_kind,'');
        v_leg varchar(24):=coalesce(p_leg,'');
BEGIN
  IF p_old IS NULL OR p_new IS NULL
  THEN RAISE EXCEPTION 'tier2_transition_coordinate_null'; END IF;
  SELECT b.composition_state INTO v_state FROM public.bounties b
    WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=CASE WHEN v_leg='' THEN 'bounty' ELSE v_leg END
    FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty ORDER BY o.leg,o.generation FOR UPDATE;
  IF v_state IS NOT DISTINCT FROM p_new THEN RETURN false; END IF;
  IF v_state IS DISTINCT FROM p_old
  THEN RAISE EXCEPTION 'tier2_transition_stale:%:%',v_state,p_old; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bounty_tier2_transitions t
    WHERE t.old_state=p_old AND t.new_state=p_new AND t.actor='ops'
      AND t.evidence_kind=v_evidence_kind AND t.leg=v_leg)
  THEN RAISE EXCEPTION 'tier2_transition_not_allowed'; END IF;
  IF v_evidence_kind<>'' AND NOT EXISTS (
    SELECT 1 FROM public.bounty_tier2_evidence e
    WHERE e.id=p_evidence AND e.bounty_id=p_bounty
      AND e.kind=v_evidence_kind AND (v_leg='' OR e.leg=v_leg)
  ) THEN RAISE EXCEPTION 'tier2_transition_evidence_invalid'; END IF;
  IF p_old='refund_pending' AND p_new='refunded' THEN
    IF EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
               WHERE l.bounty_id=p_bounty AND l.disposition='open')
       OR NOT EXISTS (SELECT 1 FROM public.bounties b WHERE b.id=p_bounty
         AND b.tier2_balances_finalized_at IS NOT NULL
         AND b.tier2_escrow_accounting_atomic=0
         AND b.tier2_pending_amount_atomic=0
         AND b.tier2_free_vault_balance_atomic=0
         AND EXISTS (SELECT 1 FROM public.bounty_tier2_evidence e
           WHERE e.id=b.tier2_balance_proof_id AND e.bounty_id=b.id
             AND e.leg=b.tier2_balance_proof_leg
             AND e.kind=b.tier2_balance_proof_kind
             AND e.kind='signature' AND e.chain_commitment='finalized'
             AND e.tx_succeeded IS TRUE
             AND e.leg IN ('refund_withdraw_usdc','close_escrow'))
         AND (b.tier2_vault_closed_proof_id IS NULL OR EXISTS (
           SELECT 1 FROM public.bounty_tier2_evidence ce
           WHERE ce.id=b.tier2_vault_closed_proof_id AND ce.bounty_id=b.id
             AND ce.leg='close_escrow' AND ce.kind='signature'
             AND ce.chain_commitment='finalized' AND ce.tx_succeeded IS TRUE)))
    THEN RAISE EXCEPTION 'tier2_refund_terminal_guard_failed'; END IF;
  END IF;
  IF p_old='cleanup_pending' AND p_new='paid' THEN
    IF EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
               WHERE l.bounty_id=p_bounty AND l.disposition='open')
       OR NOT EXISTS (SELECT 1 FROM public.bounties b WHERE b.id=p_bounty
         AND b.tier2_balances_finalized_at IS NOT NULL
         AND b.tier2_escrow_accounting_atomic=0
         AND b.tier2_pending_amount_atomic=0
         AND b.tier2_free_vault_balance_atomic=0
         AND EXISTS (SELECT 1 FROM public.bounty_tier2_evidence e
           WHERE e.id=b.tier2_balance_proof_id AND e.bounty_id=b.id
             AND e.leg=b.tier2_balance_proof_leg
             AND e.kind=b.tier2_balance_proof_kind
             AND e.kind='signature' AND e.chain_commitment='finalized'
             AND e.tx_succeeded IS TRUE)
         AND (
           EXISTS (
             SELECT 1 FROM public.bounty_tier2_depositors d
             JOIN public.bounty_tier2_evidence ae
               ON ae.id=d.ata_closed_proof_id AND ae.bounty_id=d.bounty_id
              AND ae.leg='close_depositor_ata' AND ae.kind='signature'
              AND ae.chain_commitment='finalized' AND ae.tx_succeeded IS TRUE
             JOIN public.bounty_tier2_evidence ee
               ON ee.id=d.escrow_closed_proof_id AND ee.bounty_id=d.bounty_id
              AND ee.leg='close_escrow' AND ee.kind='signature'
              AND ee.chain_commitment='finalized' AND ee.tx_succeeded IS TRUE
             WHERE d.bounty_id=b.id AND d.ata_closed_at IS NOT NULL
               AND d.escrow_closed_at IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.bounty_tier2_evidence pe
                 WHERE pe.bounty_id=b.id AND pe.leg='close_pending'
                   AND pe.kind='signature' AND pe.chain_commitment='finalized'
                   AND pe.tx_succeeded IS TRUE)
           )
           OR EXISTS (
             SELECT 1 FROM public.bounty_tier2_evidence ne
             WHERE ne.bounty_id=b.id AND ne.leg='bounty'
               AND ne.kind='accepted_nonrecoverable'
               AND ne.authority IS NOT DISTINCT FROM 'ops'
               AND ne.payload->>'scope'='cleanup_close_rent'
               AND ne.payload->>'amount_lamports' ~ '^[0-9]+$'
               AND (ne.payload->>'amount_lamports')::numeric BETWEEN 1 AND 9700280
           )
         ))
    THEN RAISE EXCEPTION 'tier2_paid_terminal_guard_failed'; END IF;
  END IF;
  PERFORM public.t2_authorize_transition(
    p_bounty,p_old,p_new,'ops',v_evidence_kind,v_leg,p_evidence);
  UPDATE public.bounties SET composition_state=p_new WHERE id=p_bounty;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_record_provider_capture(
  p_bounty uuid,p_provider varchar,p_provider_version integer,p_capture_kind varchar,
  p_operation uuid,p_signature varchar,p_commitment varchar,p_observed_slot numeric,
  p_transaction_bytes bytea,p_transaction_digest bytea,p_raw_logs bytea,
  p_candidate_event bytea,p_decoded_ok boolean,p_outer integer,p_inner integer,
  p_stack integer,p_stack_raw integer,p_desc_outer integer,p_desc_inner integer,
  p_desc_stack integer,p_pending varchar,p_escrow varchar,p_agent varchar,
  p_depositor varchar,p_settlement_index numeric,p_amount numeric,p_destination varchar
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_leg varchar(24); v_generation bigint; v_capture uuid;
BEGIN
  PERFORM 1 FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  v_leg:=CASE p_capture_kind WHEN 'settle_event' THEN 'settle'
                             WHEN 'finalize_transfer' THEN 'finalize' END;
  IF v_leg IS NULL THEN RAISE EXCEPTION 'tier2_capture_kind_invalid'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=v_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=v_leg ORDER BY o.generation FOR UPDATE;
  SELECT o.generation INTO v_generation FROM public.bounty_tier2_operations o
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg=v_leg
      AND o.state='confirmed';
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_capture_operation_not_finalized'; END IF;
  PERFORM 1 FROM public.tier2_rpc_providers p
    WHERE p.provider_id=p_provider AND p.identity_version=p_provider_version AND p.active
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_provider_identity_invalid'; END IF;
  IF p_commitment IS NULL OR p_commitment NOT IN ('confirmed','finalized')
     OR p_decoded_ok IS NULL OR p_observed_slot IS NULL
     OR p_observed_slot<>trunc(p_observed_slot)
     OR p_observed_slot NOT BETWEEN 0 AND 18446744073709551615
     OR p_transaction_bytes IS NULL OR p_transaction_digest IS NULL
     OR octet_length(p_transaction_digest)<>32
     OR p_raw_logs IS NULL OR p_signature IS NULL
     OR (p_settlement_index IS NOT NULL AND (p_settlement_index<>trunc(p_settlement_index)
       OR p_settlement_index NOT BETWEEN 0 AND 18446744073709551615))
     OR (p_amount IS NOT NULL AND (p_amount<>trunc(p_amount)
       OR p_amount NOT BETWEEN 0 AND 18446744073709551615))
  THEN RAISE EXCEPTION 'tier2_capture_numeric_or_bytes_invalid'; END IF;
  IF p_capture_kind='finalize_transfer' AND
     (p_commitment<>'finalized' OR p_decoded_ok IS DISTINCT FROM true
      OR p_outer IS NULL OR p_outer<0
      OR p_stack IS NULL OR p_stack<1 OR p_desc_outer IS NULL OR p_desc_outer<0
      OR p_desc_stack IS NULL OR p_desc_stack<=p_stack
      OR p_pending IS NULL OR p_escrow IS NULL OR p_agent IS NULL OR p_depositor IS NULL
      OR p_settlement_index IS NULL OR p_amount IS NULL OR p_destination IS NULL
      OR NOT ((p_inner IS NULL AND p_stack=1 AND p_stack_raw IS NULL)
              OR (p_inner IS NOT NULL AND p_inner>=0 AND p_stack>1
                  AND p_stack_raw=p_stack)))
  THEN RAISE EXCEPTION 'tier2_finalize_capture_decode_invalid'; END IF;
  INSERT INTO public.bounty_tier2_settle_captures
    (bounty_id,signature,provider_id,provider_identity_version,capture_kind,
     operation_id,operation_leg,operation_generation,observed_commitment,observed_slot,
     transaction_bytes,transaction_digest,raw_log_bytes,candidate_event_bytes,decoded_ok,
     outer_instruction_index,inner_instruction_index,stack_height,stack_height_raw,
     descendant_outer_index,descendant_inner_index,descendant_stack_height,
     decoded_pending_settlement,decoded_escrow,decoded_agent_pda,decoded_depositor,
     decoded_settlement_index,decoded_amount_atomic,decoded_destination,promotion_state)
    VALUES (p_bounty,p_signature,p_provider,p_provider_version,p_capture_kind,
      p_operation,v_leg,v_generation,p_commitment,p_observed_slot,p_transaction_bytes,
      p_transaction_digest,p_raw_logs,p_candidate_event,p_decoded_ok,p_outer,p_inner,
      p_stack,p_stack_raw,p_desc_outer,p_desc_inner,p_desc_stack,p_pending,p_escrow,
      p_agent,p_depositor,p_settlement_index,p_amount,p_destination,'captured')
    RETURNING id INTO v_capture;
  RETURN v_capture;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_prepare_send(
  p_bounty uuid,p_leg varchar,p_operation uuid,p_message_bytes bytea,
  p_blockhash varchar,p_last_valid_height bigint,p_prepared_slot numeric,
  p_decoded_ok boolean,p_destination varchar,p_amount numeric,p_estimated_fee numeric,
  p_predicted_amount numeric,p_formula_inputs jsonb,p_account_version varchar,
  p_account_fingerprint bytea,p_formula_digest bytea,p_prepared_digest bytea,
  p_payment_digest bytea
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_generation bigint; v_live uuid; v_state varchar(24); v_send uuid;
        v_value_leg boolean;
        v_poster varchar(64); v_vault varchar(64); v_sol_return varchar(64);
        v_depositor varchar(64); v_depositor_ata varchar(64);
        v_liability_kinds varchar[]; v_liability_asset varchar(8);
        v_liability_count integer; v_liability_kind varchar(24); v_liability_epoch integer;
        v_liability_amount numeric; v_liability_dest varchar(64);
        v_liability_alt varchar(64); v_settlement_mode varchar(8);
        v_route_dest varchar(64); v_source_balance numeric; v_drain_fee numeric;
BEGIN
  SELECT b.tier2_poster_usdc_ata,b.tier2_vault_usdc_ata,
         b.tier2_sol_return_address,d.public_key,d.usdc_ata
    INTO v_poster,v_vault,v_sol_return,v_depositor,v_depositor_ata
    FROM public.bounties b
    JOIN public.bounty_tier2_depositors d ON d.bounty_id=b.id
    WHERE b.id=p_bounty FOR UPDATE OF b,d;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT c.live_operation_id INTO v_live FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=p_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg ORDER BY o.generation FOR UPDATE;
  SELECT o.generation,o.state INTO v_generation,v_state
    FROM public.bounty_tier2_operations o
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg=p_leg;
  IF NOT FOUND OR v_live IS DISTINCT FROM p_operation OR v_state<>'claimed'
  THEN RAISE EXCEPTION 'tier2_prepare_requires_live_claim'; END IF;
  -- Close legs are the bounded rent-recovery exception documented by the
  -- shared send-contract validator; they intentionally do not claim value binding.
  v_value_leg:=p_leg NOT IN
    ('pricing_publish','close_pending','close_depositor_ata','close_escrow','bounty');
  IF p_message_bytes IS NULL OR p_blockhash IS NULL OR p_last_valid_height IS NULL
     OR p_last_valid_height<0 OR p_decoded_ok IS NOT TRUE
     OR p_prepared_slot IS NULL OR p_prepared_slot<>trunc(p_prepared_slot)
     OR p_prepared_slot NOT BETWEEN 0 AND 18446744073709551615
     OR p_estimated_fee IS NULL OR p_estimated_fee<>trunc(p_estimated_fee)
     OR p_estimated_fee NOT BETWEEN 0 AND 18446744073709551615
     OR p_prepared_digest IS NULL OR octet_length(p_prepared_digest)<>32
     OR (NOT v_value_leg AND p_payment_digest IS NOT NULL
         AND octet_length(p_payment_digest)<>32)
     OR (v_value_leg
       AND (p_destination IS NULL OR p_destination !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
            OR p_amount IS NULL OR p_amount<>trunc(p_amount)
            OR p_amount NOT BETWEEN 0 AND 18446744073709551615
            OR p_payment_digest IS NULL OR octet_length(p_payment_digest)<>32
            OR p_payment_digest IS DISTINCT FROM public.t2_payment_coordinate_digest(
                 p_bounty,p_leg,p_operation,v_generation,p_amount,p_destination)))
     OR (p_predicted_amount IS NOT NULL AND (p_predicted_amount<>trunc(p_predicted_amount)
       OR p_predicted_amount NOT BETWEEN 0 AND 18446744073709551615))
  THEN RAISE EXCEPTION 'tier2_prepare_coordinate_invalid'; END IF;
  IF p_leg='funding_sol' AND p_destination IS DISTINCT FROM v_depositor
  THEN RAISE EXCEPTION 'tier2_funding_sol_custody_destination_mismatch'; END IF;
  IF p_leg='funding_usdc' AND p_destination IS DISTINCT FROM v_depositor_ata
  THEN RAISE EXCEPTION 'tier2_funding_usdc_custody_destination_mismatch'; END IF;
  IF p_leg IN ('refund_withdraw_usdc','withdraw_dust_usdc')
     AND p_destination IS DISTINCT FROM v_depositor_ata
  THEN RAISE EXCEPTION 'tier2_withdraw_custody_destination_mismatch'; END IF;
  IF p_leg='vault_open' AND p_destination IS DISTINCT FROM v_vault
  THEN RAISE EXCEPTION 'tier2_vault_destination_mismatch'; END IF;
  IF p_leg IN ('fee_refund','house_refund_to_poster','refund_sweep_usdc','sweep_dust_usdc')
     AND p_destination IS DISTINCT FROM v_poster
  THEN RAISE EXCEPTION 'tier2_poster_destination_mismatch'; END IF;
  IF p_leg='sweep_sol' AND p_destination IS DISTINCT FROM v_sol_return
  THEN RAISE EXCEPTION 'tier2_sol_return_destination_mismatch'; END IF;
  IF p_leg='settle' AND
     (p_predicted_amount IS NULL OR p_account_version IS NULL
      OR p_account_fingerprint IS NULL OR octet_length(p_account_fingerprint)<>32
      OR p_formula_digest IS NULL OR octet_length(p_formula_digest)<>32
      OR p_formula_inputs IS NULL
      OR p_formula_inputs->>'finalize_destination' IS NULL
      OR p_formula_inputs->>'finalize_destination' !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  THEN RAISE EXCEPTION 'tier2_arithmetic_fingerprint_missing'; END IF;

  IF p_leg IN ('refund_withdraw_usdc','withdraw_dust_usdc') THEN
    IF EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
               WHERE l.bounty_id=p_bounty AND l.kind='poster_refund'
                 AND l.asset_kind='usdc' AND l.disposition='open')
    THEN RAISE EXCEPTION 'tier2_poster_refund_live_slot_occupied'; END IF;
    UPDATE public.bounties SET
      tier2_poster_refund_reservation_operation=p_operation,
      tier2_poster_refund_reservation_leg=p_leg,
      tier2_poster_refund_reservation_generation=v_generation
      WHERE id=p_bounty
        AND (tier2_poster_refund_reservation_operation IS NULL OR
             tier2_poster_refund_reservation_operation=p_operation);
    IF NOT FOUND THEN RAISE EXCEPTION 'tier2_poster_refund_slot_reserved'; END IF;
  END IF;

  -- Bind an exact immutable liability row before the prepared transaction exists.
  -- Later liabilities cannot make this send ambiguous or redirect its release.
  v_liability_kinds:=CASE p_leg
    WHEN 'payout' THEN ARRAY['reward_payout']::varchar[]
    WHEN 'house_refund_to_poster' THEN ARRAY['house_poster_refund']::varchar[]
    WHEN 'fee_refund' THEN ARRAY['fee_refund']::varchar[]
    WHEN 'vault_open' THEN ARRAY['poster_prefund']::varchar[]
    WHEN 'refund_sweep_usdc' THEN ARRAY['poster_prefund','poster_refund']::varchar[]
    WHEN 'sweep_dust_usdc' THEN ARRAY['poster_refund']::varchar[]
    WHEN 'sweep_sol' THEN ARRAY['poster_refund']::varchar[]
    ELSE NULL END;
  v_liability_asset:=CASE WHEN p_leg='sweep_sol' THEN 'sol'
                          WHEN v_liability_kinds IS NOT NULL THEN 'usdc' END;
  IF v_liability_kinds IS NOT NULL THEN
    PERFORM 1 FROM public.bounty_tier2_liabilities l
      WHERE l.bounty_id=p_bounty AND l.kind=ANY(v_liability_kinds)
        AND l.asset_kind=v_liability_asset AND l.disposition='open'
      ORDER BY l.kind,l.epoch FOR UPDATE;
    SELECT count(*),min(l.kind),min(l.epoch),min(l.liability_atomic),min(l.expected_dest),
           min(l.alternate_dest),min(l.settlement_mode)
      INTO v_liability_count,v_liability_kind,v_liability_epoch,
           v_liability_amount,v_liability_dest,v_liability_alt,v_settlement_mode
      FROM public.bounty_tier2_liabilities l
      WHERE l.bounty_id=p_bounty AND l.kind=ANY(v_liability_kinds)
        AND l.asset_kind=v_liability_asset AND l.disposition='open';
    v_route_dest:=CASE WHEN v_liability_kind='poster_prefund'
                            AND p_leg='refund_sweep_usdc'
                       THEN v_liability_alt ELSE v_liability_dest END;
    IF v_liability_count IS DISTINCT FROM 1
       OR NOT (p_destination IS NOT DISTINCT FROM v_route_dest)
    THEN RAISE EXCEPTION 'tier2_prepare_liability_mismatch'; END IF;
    IF v_settlement_mode='exact' AND
       NOT (p_amount IS NOT DISTINCT FROM v_liability_amount)
    THEN RAISE EXCEPTION 'tier2_prepare_liability_mismatch'; END IF;
    IF v_settlement_mode='drain' THEN
      IF p_leg IS DISTINCT FROM 'sweep_sol'
         OR p_formula_inputs->>'source_balance_lamports' IS NULL
         OR p_formula_inputs->>'source_balance_lamports' !~ '^(0|[1-9][0-9]*)$'
         OR p_formula_inputs->>'drain_fee_lamports' IS NULL
         OR p_formula_inputs->>'drain_fee_lamports' !~ '^(0|[1-9][0-9]*)$'
         OR p_formula_inputs->>'post_balance_lamports' IS DISTINCT FROM '0'
      THEN RAISE EXCEPTION 'tier2_sol_drain_proof_invalid'; END IF;
      v_source_balance:=(p_formula_inputs->>'source_balance_lamports')::numeric;
      v_drain_fee:=(p_formula_inputs->>'drain_fee_lamports')::numeric;
      IF v_source_balance NOT BETWEEN 0 AND 18446744073709551615
         OR v_drain_fee NOT BETWEEN 0 AND p_estimated_fee
         OR v_source_balance IS DISTINCT FROM p_amount+v_drain_fee
      THEN RAISE EXCEPTION 'tier2_sol_drain_balance_mismatch'; END IF;
    END IF;
  END IF;
  UPDATE public.bounty_tier2_operations SET prepared_msg_digest=p_prepared_digest,
    payment_message_digest=p_payment_digest,blockhash=p_blockhash,
    last_valid_block_height=p_last_valid_height,prepared_slot=p_prepared_slot
    WHERE id=p_operation;
  INSERT INTO public.bounty_tier2_prepared_sends
    (operation_id,op_bounty_id,op_leg,generation,message_bytes,signature,blockhash,
     last_valid_block_height,prepared_slot,decoded_ok,destination,amount_atomic,
     liability_bounty_id,liability_kind,liability_asset_kind,liability_epoch,
     estimated_fee_lamports,actual_fee_lamports,predicted_amount_atomic,formula_inputs,
     account_version,account_fingerprint,formula_digest,pre_sign_reserved_at,signed_at,
     sent_at,sent_signature)
    VALUES (p_operation,p_bounty,p_leg,v_generation,p_message_bytes,NULL,p_blockhash,
       p_last_valid_height,p_prepared_slot,p_decoded_ok,p_destination,p_amount,
       CASE WHEN v_liability_kinds IS NULL THEN NULL ELSE p_bounty END,
       v_liability_kind,v_liability_asset,v_liability_epoch,
       p_estimated_fee,NULL,p_predicted_amount,coalesce(p_formula_inputs,'{}'::jsonb),
      p_account_version,p_account_fingerprint,p_formula_digest,NULL,NULL,NULL,NULL)
    RETURNING id INTO v_send;
  PERFORM public.t2_assert_send_contract(p_bounty,p_leg,p_operation);
  RETURN v_send;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_pre_sign_checkpoint(
  p_bounty uuid,p_leg varchar,p_operation uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_live uuid; v_succeeded uuid; v_state varchar(24); v_reserved timestamptz;
        v_claim_expires timestamptz;
BEGIN
  PERFORM 1 FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT c.live_operation_id,c.succeeded_operation_id INTO v_live,v_succeeded
    FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=p_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg ORDER BY o.generation FOR UPDATE;
  SELECT o.state,o.claim_expires_at INTO v_state,v_claim_expires FROM public.bounty_tier2_operations o
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg=p_leg;
  IF NOT FOUND OR v_live IS DISTINCT FROM p_operation OR v_state<>'claimed'
     OR v_claim_expires IS NULL OR v_claim_expires<=statement_timestamp()
  THEN RAISE EXCEPTION 'tier2_pre_sign_requires_live_claim'; END IF;
  IF p_leg IN ('fee_charge','fee_refund','funding_sol','funding_usdc','vault_open',
               'settle','payout','house_refund_to_poster') AND v_succeeded IS NOT NULL
  THEN RAISE EXCEPTION 'tier2_once_only_already_succeeded'; END IF;
  SELECT s.pre_sign_reserved_at INTO v_reserved FROM public.bounty_tier2_prepared_sends s
    WHERE s.operation_id=p_operation AND s.op_bounty_id=p_bounty AND s.op_leg=p_leg
      AND s.signature IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_unsigned_preparation_missing'; END IF;
  PERFORM public.t2_assert_send_contract(p_bounty,p_leg,p_operation);
  IF v_reserved IS NOT NULL THEN RETURN false; END IF;
  UPDATE public.bounty_tier2_prepared_sends SET pre_sign_reserved_at=statement_timestamp()
    WHERE operation_id=p_operation;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_pre_broadcast_checkpoint(
  p_bounty uuid,p_leg varchar,p_operation uuid,p_signature varchar
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_live uuid; v_succeeded uuid; v_state varchar(24); v_existing varchar(96);
        v_claim_expires timestamptz;
BEGIN
  PERFORM 1 FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT c.live_operation_id,c.succeeded_operation_id INTO v_live,v_succeeded
    FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=p_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg ORDER BY o.generation FOR UPDATE;
  SELECT o.state,o.claim_expires_at INTO v_state,v_claim_expires FROM public.bounty_tier2_operations o
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg=p_leg;
  IF NOT FOUND OR v_live IS DISTINCT FROM p_operation OR v_state<>'claimed'
     OR v_claim_expires IS NULL OR v_claim_expires<=statement_timestamp()
  THEN RAISE EXCEPTION 'tier2_pre_broadcast_requires_live_claim'; END IF;
  IF p_leg IN ('fee_charge','fee_refund','funding_sol','funding_usdc','vault_open',
               'settle','payout','house_refund_to_poster') AND v_succeeded IS NOT NULL
  THEN RAISE EXCEPTION 'tier2_once_only_already_succeeded'; END IF;
  IF p_signature IS NULL OR length(p_signature)=0
  THEN RAISE EXCEPTION 'tier2_signature_required'; END IF;
  SELECT s.signature INTO v_existing FROM public.bounty_tier2_prepared_sends s
    WHERE s.operation_id=p_operation AND s.op_bounty_id=p_bounty AND s.op_leg=p_leg
      AND s.pre_sign_reserved_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_pre_sign_checkpoint_missing'; END IF;
  PERFORM public.t2_assert_send_contract(p_bounty,p_leg,p_operation);
  IF v_existing IS NOT NULL THEN
    IF v_existing=p_signature THEN RETURN false; END IF;
    RAISE EXCEPTION 'tier2_pre_broadcast_signature_conflict';
  END IF;
  UPDATE public.bounty_tier2_prepared_sends SET signature=p_signature,
    signed_at=statement_timestamp(),sent_at=statement_timestamp(),sent_signature=p_signature
    WHERE operation_id=p_operation AND signature IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_pre_broadcast_cas_lost'; END IF;
  UPDATE public.bounty_tier2_operations SET signature=p_signature,
    sent_at=statement_timestamp() WHERE id=p_operation AND state='claimed';
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_pre_broadcast_operation_lost'; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_mark_broadcast_unknown(
  p_bounty uuid,p_leg varchar,p_operation uuid,p_signature varchar
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_live uuid; v_state varchar(24);
BEGIN
  PERFORM 1 FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT c.live_operation_id INTO v_live FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=p_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg ORDER BY o.generation FOR UPDATE;
  SELECT o.state INTO v_state FROM public.bounty_tier2_operations o
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg=p_leg;
  IF NOT FOUND OR v_live IS DISTINCT FROM p_operation
  THEN RAISE EXCEPTION 'tier2_broadcast_unknown_not_live'; END IF;
  IF v_state='broadcast_unknown' THEN RETURN false; END IF;
  IF v_state<>'claimed' OR NOT EXISTS (
    SELECT 1 FROM public.bounty_tier2_prepared_sends s
    WHERE s.operation_id=p_operation AND s.op_bounty_id=p_bounty AND s.op_leg=p_leg
      AND s.signature=p_signature AND s.sent_signature=p_signature AND s.sent_at IS NOT NULL)
  THEN RAISE EXCEPTION 'tier2_broadcast_unknown_proof_invalid'; END IF;
  UPDATE public.bounty_tier2_operations SET state='broadcast_unknown'
    WHERE id=p_operation AND state='claimed';
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_reject_not_broadcast(
  p_bounty uuid,p_leg varchar,p_operation uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_live uuid; v_state varchar(24);
BEGIN
  PERFORM 1 FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  SELECT c.live_operation_id INTO v_live FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=p_leg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_no_control_row'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg ORDER BY o.generation FOR UPDATE;
  SELECT o.state INTO v_state FROM public.bounty_tier2_operations o
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg=p_leg;
  IF NOT FOUND OR v_live IS DISTINCT FROM p_operation OR v_state NOT IN ('pending','claimed')
     OR EXISTS (SELECT 1 FROM public.bounty_tier2_prepared_sends s
                WHERE s.operation_id=p_operation AND (s.signature IS NOT NULL OR s.sent_at IS NOT NULL))
  THEN RAISE EXCEPTION 'tier2_not_broadcast_retirement_invalid'; END IF;
  UPDATE public.bounty_tier2_operations SET state='terminal_rejected',
    disposition='not_broadcast' WHERE id=p_operation;
  UPDATE public.bounty_tier2_op_control SET live_generation=NULL,live_operation_id=NULL,
    updated_at=statement_timestamp() WHERE bounty_id=p_bounty AND leg=p_leg;
  UPDATE public.bounties SET
    tier2_poster_refund_reservation_operation=NULL,
    tier2_poster_refund_reservation_leg=NULL,
    tier2_poster_refund_reservation_generation=NULL
    WHERE id=p_bounty
      AND tier2_poster_refund_reservation_operation=p_operation;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION tier2_trusted.load_depositor(
  p_bounty uuid,p_leg varchar,p_operation uuid
) RETURNS TABLE (
  bounty_id uuid,public_key varchar,usdc_ata varchar,encrypted_secret_key text,
  encryption_iv varchar,encryption_tag varchar
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.bounties b WHERE b.id=p_bounty FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=p_leg
      AND c.live_operation_id=p_operation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_depositor_load_requires_live_operation'; END IF;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty AND o.leg=p_leg ORDER BY o.generation FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.bounty_tier2_operations o
    WHERE o.id=p_operation AND o.bounty_id=p_bounty AND o.leg=p_leg
      AND o.state='claimed')
  THEN RAISE EXCEPTION 'tier2_depositor_load_requires_claim'; END IF;
  RETURN QUERY SELECT d.bounty_id,d.public_key,d.usdc_ata,d.encrypted_secret_key,
                      d.encryption_iv,d.encryption_tag
    FROM public.bounty_tier2_depositors d WHERE d.bounty_id=p_bounty;
END $$;

REVOKE ALL ON SCHEMA tier2_trusted FROM PUBLIC,clawville_app,clawville_ops;
DO $$
DECLARE r record; v_role text;
BEGIN
  FOR r IN
    SELECT a.grantee FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
    WHERE n.nspname='tier2_trusted' AND a.grantee<>n.nspowner
  LOOP
    IF r.grantee=0 THEN v_role:='PUBLIC';
    ELSE SELECT pr.rolname INTO v_role FROM pg_catalog.pg_roles pr WHERE pr.oid=r.grantee; END IF;
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON SCHEMA tier2_trusted FROM %s',
      CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(v_role) END);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA tier2_trusted TO clawville_app;

-- A pre-existing table-level UPDATE grant would dominate column revokes. Remove
-- it, remove any stale sensitive column grants, then restore only non-Tier-2
-- application columns. The transition trigger additionally fences status on
-- admitted Tier-2 rows.
DO $$
DECLARE r record; v_role text;
BEGIN
  -- Normalize table-level UPDATE on bounties for every direct non-owner grantee,
  -- not only the three named runtime principals.
  FOR r IN
    SELECT DISTINCT a.grantee,b.oid::regclass AS relation
    FROM pg_catalog.pg_class b
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(b.relacl,pg_catalog.acldefault('r',b.relowner))) a
    WHERE b.oid='public.bounties'::regclass AND a.grantee<>b.relowner
      AND a.privilege_type='UPDATE'
  LOOP
    IF r.grantee=0 THEN v_role:='PUBLIC';
    ELSE SELECT pr.rolname INTO STRICT v_role FROM pg_catalog.pg_roles pr
         WHERE pr.oid=r.grantee; END IF;
    EXECUTE pg_catalog.format('REVOKE UPDATE ON TABLE %s FROM %s',r.relation,
      CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(v_role) END);
  END LOOP;

  -- pg_class.relacl does not cover pg_attribute.attacl. Erase every direct
  -- non-owner column grant on the 17 new relations, plus every sensitive Tier-2
  -- bounty column, before applying the explicit allowlist below.
  FOR r IN
    SELECT DISTINCT c.oid::regclass AS relation,a.attname,x.grantee,c.relowner
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
      AND NOT a.attisdropped AND a.attacl IS NOT NULL
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
    WHERE x.grantee<>c.relowner AND n.nspname='public' AND (
      c.relname IN (
        'bounty_tier2_assets','bounty_tier2_evidence','bounty_tier2_operations',
        'bounty_tier2_op_control','bounty_tier2_prepared_sends',
        'bounty_tier2_settle_captures','bounty_tier2_sol_balance_captures',
        'bounty_tier2_settle_snapshots',
        'bounty_tier2_payout_releases','bounty_tier2_depositors',
        'bounty_tier2_transitions','bounty_tier2_liabilities','tier2_rpc_providers',
        'tier2_ops_principals','tier2_ops_authorizations','tier2_policy',
        'tier2_ops_alerts','tier2_legacy_inventory')
      OR (c.relname='bounties' AND (
        a.attname='settlement_tier2' OR a.attname LIKE 'tier2\_%' ESCAPE '\'
        OR a.attname IN ('payout_expected_atomic','price_prior_state',
                         'ops_prior_state','composition_state')))
    )
  LOOP
    IF r.grantee=0 THEN v_role:='PUBLIC';
    ELSE SELECT pr.rolname INTO STRICT v_role FROM pg_catalog.pg_roles pr
         WHERE pr.oid=r.grantee; END IF;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM %s',r.attname,r.relation,
      CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(v_role) END);
  END LOOP;
END $$;
REVOKE UPDATE ON TABLE public.bounties FROM PUBLIC,clawville_app,clawville_ops;
REVOKE UPDATE
  (settlement_tier2,tier2_mint,tier2_cluster_genesis,tier2_poster_usdc_ata,
   tier2_arithmetic_branch,tier2_price_formula_version,payout_expected_atomic,
   tier2_hunter_ata,tier2_fee_state,tier2_fee_budget_lamports,
   tier2_fee_spent_lamports,tier2_ops_grants,tier2_last_grant_at,
   tier2_cancel_intent_at,tier2_cancel_intent_by,price_prior_state,ops_prior_state,
   tier2_escrow_accounting_atomic,tier2_pending_amount_atomic,
   tier2_free_vault_balance_atomic,tier2_balances_finalized_at,
   tier2_balance_proof_id,tier2_balance_proof_bounty,tier2_balance_proof_leg,
   tier2_balance_proof_kind,tier2_vault_closed_proof_id,composition_state)
ON public.bounties FROM PUBLIC,clawville_app,clawville_ops;
GRANT UPDATE
  (title,description,requirements,difficulty,status,token_reward,max_attempts,
   current_attempts,is_featured,tags,acceptance_criteria,payment_rail,escrow_pda,
   escrow_job_id,payout_escrow_pda,composition_refund_signature,
   composition_refund_claim_id,composition_refund_claimed_at,
   covenant_audit_root_hex,covenant_verification_passed,covenant_verdict_id,
   verdict_required,expires_at,completed_at,updated_at)
ON public.bounties TO clawville_app;

REVOKE ALL ON TABLE
  public.bounty_tier2_assets,public.bounty_tier2_evidence,
  public.bounty_tier2_operations,public.bounty_tier2_op_control,
  public.bounty_tier2_prepared_sends,public.bounty_tier2_settle_captures,
  public.bounty_tier2_sol_balance_captures,
  public.bounty_tier2_settle_snapshots,public.bounty_tier2_payout_releases,
  public.bounty_tier2_depositors,public.bounty_tier2_transitions,
  public.bounty_tier2_liabilities,public.tier2_rpc_providers,
  public.tier2_ops_principals,public.tier2_ops_authorizations,
  public.tier2_policy,public.tier2_ops_alerts,public.tier2_legacy_inventory
FROM PUBLIC,clawville_app,clawville_ops;

DO $$
DECLARE r record; v_role text;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS relation,a.grantee
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    WHERE n.nspname IN ('public','tier2_trusted') AND a.grantee<>c.relowner
      AND c.relname IN ('bounty_tier2_assets','bounty_tier2_evidence',
        'bounty_tier2_operations','bounty_tier2_op_control','bounty_tier2_prepared_sends',
        'bounty_tier2_settle_captures','bounty_tier2_sol_balance_captures',
        'bounty_tier2_settle_snapshots',
        'bounty_tier2_payout_releases','bounty_tier2_depositors',
        'bounty_tier2_transitions','bounty_tier2_liabilities','tier2_rpc_providers',
        'tier2_ops_principals','tier2_ops_authorizations','tier2_policy',
        'tier2_ops_alerts','tier2_legacy_inventory')
  LOOP
    IF r.grantee=0 THEN v_role:='PUBLIC';
    ELSE SELECT pr.rolname INTO v_role FROM pg_catalog.pg_roles pr WHERE pr.oid=r.grantee; END IF;
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE %s FROM %s',
      r.relation,CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(v_role) END);
  END LOOP;
END $$;

GRANT SELECT ON TABLE
  public.bounty_tier2_assets,public.bounty_tier2_evidence,
  public.bounty_tier2_operations,public.bounty_tier2_op_control,
  public.bounty_tier2_prepared_sends,public.bounty_tier2_settle_captures,
  public.bounty_tier2_sol_balance_captures,
  public.bounty_tier2_settle_snapshots,public.bounty_tier2_payout_releases,
  public.bounty_tier2_transitions,public.bounty_tier2_liabilities,
  public.tier2_rpc_providers,public.tier2_ops_principals,
  public.tier2_ops_authorizations,public.tier2_policy,
  public.tier2_ops_alerts,public.tier2_legacy_inventory
TO clawville_app,clawville_ops;
GRANT SELECT
  (bounty_id,public_key,funded_sol_lamports,funded_usdc_atomic,swept_at,
   ata_closed_at,escrow_closed_at,created_at)
ON public.bounty_tier2_depositors TO clawville_app,clawville_ops;
GRANT INSERT,UPDATE ON TABLE public.tier2_ops_principals TO clawville_ops;
GRANT INSERT ON TABLE public.tier2_ops_authorizations TO clawville_ops;

REVOKE INSERT,UPDATE,DELETE ON TABLE
  public.bounty_tier2_evidence,public.bounty_tier2_settle_captures,
  public.bounty_tier2_liabilities,public.bounty_tier2_assets
FROM PUBLIC,clawville_app,clawville_ops;
REVOKE UPDATE,DELETE ON TABLE public.bounty_tier2_operations
FROM PUBLIC,clawville_app,clawville_ops;

REVOKE EXECUTE ON FUNCTION public.consume_ops_continue(uuid,varchar,text) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.consume_settle_snapshot(uuid,varchar,varchar,varchar,varchar,numeric,numeric,numeric,boolean,bytea,numeric,bigint,varchar,numeric,bytea,varchar,bytea,jsonb,bytea,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.consume_approval_open_reward(uuid,uuid,numeric,varchar) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.consume_cancel_intent(uuid,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.consume_refund_start(uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.consume_finalize_release(uuid,uuid,uuid,text) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.consume_operation_confirmed(uuid,varchar,uuid,varchar,numeric,varchar,numeric) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_record_sol_balance_capture(uuid,uuid,varchar,varchar,varchar,integer,numeric,numeric,numeric,varchar,integer,bytea) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.consume_sol_no_send_disposition(uuid,uuid,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.consume_arithmetic_violation(uuid,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.release_liability(uuid,varchar,varchar,integer,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_transition(uuid,varchar,varchar,varchar,varchar,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION tier2_trusted.load_depositor(uuid,varchar,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_register_provider(varchar,varchar,integer,varchar,varchar,boolean) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_deactivate_provider(varchar,integer) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_admit_bounty(uuid,varchar,varchar,varchar,varchar,varchar,varchar,varchar,integer,numeric,varchar,varchar,varchar,text,varchar,varchar) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_open_automatic_generation(uuid,varchar) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_claim_operation(uuid,varchar,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_record_provider_capture(uuid,varchar,integer,varchar,uuid,varchar,varchar,numeric,bytea,bytea,bytea,bytea,boolean,integer,integer,integer,integer,integer,integer,integer,varchar,varchar,varchar,varchar,numeric,numeric,varchar) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_prepare_send(uuid,varchar,uuid,bytea,varchar,bigint,numeric,boolean,varchar,numeric,numeric,numeric,jsonb,varchar,bytea,bytea,bytea,bytea) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_pre_sign_checkpoint(uuid,varchar,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_pre_broadcast_checkpoint(uuid,varchar,uuid,varchar) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_mark_broadcast_unknown(uuid,varchar,uuid,varchar) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_reject_not_broadcast(uuid,varchar,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2_authorize_transition(uuid,varchar,varchar,varchar,varchar,varchar,uuid) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2_leg_state_admitted(varchar,varchar) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2_payment_coordinate_digest(uuid,varchar,uuid,bigint,numeric,varchar) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2_assert_send_contract(uuid,varchar,uuid) FROM PUBLIC,clawville_app,clawville_ops;

-- CREATE OR REPLACE preserves stale owners and ACL entries. Normalize every
-- migration-owned routine to the applying role and erase all non-owner EXECUTE
-- entries before the explicit grants below.
DO $$
DECLARE r record; v_role text;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='public' AND p.proname IN (
      't2_attempt_one_approved_guard','t2a_assert_admitted','t2a_freeze',
      'b_t2_freeze_admitted','t2c_succ_freeze','t2_append_only','t2rp_freeze',
      't2ps_guard','t2l_guard','t2d_monotonic','t2o_state_guard',
      't2ps_reserve_before_prepare','t2_authorize_transition','b_t2_transition_validate',
      't2_leg_state_admitted','t2_payment_coordinate_digest','t2_assert_send_contract',
      'consume_refund_start','consume_finalize_release','consume_operation_confirmed',
      'tier2_record_sol_balance_capture','consume_sol_no_send_disposition',
      'consume_arithmetic_violation','consume_ops_continue','consume_settle_snapshot',
      'consume_approval_open_reward','consume_cancel_intent','release_liability',
      'tier2_transition','tier2_register_provider','tier2_deactivate_provider','tier2_admit_bounty',
      'tier2_open_automatic_generation','tier2_claim_operation',
      'tier2_record_provider_capture','tier2_prepare_send','tier2_pre_sign_checkpoint',
      'tier2_pre_broadcast_checkpoint','tier2_mark_broadcast_unknown',
      'tier2_reject_not_broadcast'))
      OR (n.nspname='tier2_trusted' AND p.proname='load_depositor')
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO CURRENT_USER',r.signature);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS signature,a.grantee
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND (
      (n.nspname='public' AND p.proname IN (
        't2_attempt_one_approved_guard','t2a_assert_admitted','t2a_freeze',
        'b_t2_freeze_admitted','t2c_succ_freeze','t2_append_only','t2rp_freeze',
        't2ps_guard','t2l_guard','t2d_monotonic','t2o_state_guard',
        't2ps_reserve_before_prepare','t2_authorize_transition','b_t2_transition_validate',
        't2_leg_state_admitted','t2_payment_coordinate_digest','t2_assert_send_contract',
        'consume_refund_start','consume_finalize_release','consume_operation_confirmed',
        'tier2_record_sol_balance_capture','consume_sol_no_send_disposition',
        'consume_arithmetic_violation','consume_ops_continue','consume_settle_snapshot',
        'consume_approval_open_reward','consume_cancel_intent','release_liability',
        'tier2_transition','tier2_register_provider','tier2_deactivate_provider','tier2_admit_bounty',
        'tier2_open_automatic_generation','tier2_claim_operation',
        'tier2_record_provider_capture','tier2_prepare_send','tier2_pre_sign_checkpoint',
        'tier2_pre_broadcast_checkpoint','tier2_mark_broadcast_unknown',
        'tier2_reject_not_broadcast'))
      OR (n.nspname='tier2_trusted' AND p.proname='load_depositor'))
  LOOP
    IF r.grantee=0 THEN v_role:='PUBLIC';
    ELSE SELECT pr.rolname INTO v_role FROM pg_catalog.pg_roles pr WHERE pr.oid=r.grantee; END IF;
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s',
      r.signature,CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(v_role) END);
  END LOOP;
END $$;

-- Exact migration-owned routine inventory. Same-name overloads are not merely
-- de-privileged: any signature outside this closed list aborts the apply.
DO $$
DECLARE
  v_owner oid;
  v_expected text[]:=ARRAY[
    'public.tier2_register_provider(varchar,varchar,integer,varchar,varchar,boolean)',
    'public.tier2_deactivate_provider(varchar,integer)',
    'public.t2_leg_state_admitted(varchar,varchar)',
    'public.t2_payment_coordinate_digest(uuid,varchar,uuid,bigint,numeric,varchar)',
    'public.tier2_admit_bounty(uuid,varchar,varchar,varchar,varchar,varchar,varchar,varchar,integer,numeric,varchar,varchar,varchar,text,varchar,varchar)',
    'public.tier2_open_automatic_generation(uuid,varchar)',
    'public.tier2_claim_operation(uuid,varchar,uuid)',
    'public.t2_attempt_one_approved_guard()',
    'public.t2a_assert_admitted()',
    'public.t2a_freeze()',
    'public.b_t2_freeze_admitted()',
    'public.t2c_succ_freeze()',
    'public.t2_append_only()',
    'public.t2rp_freeze()',
    'public.t2ps_guard()',
    'public.t2l_guard()',
    'public.t2d_monotonic()',
    'public.t2o_state_guard()',
    'public.t2_assert_send_contract(uuid,varchar,uuid)',
    'public.t2ps_reserve_before_prepare()',
    'public.t2_authorize_transition(uuid,varchar,varchar,varchar,varchar,varchar,uuid)',
    'public.b_t2_transition_validate()',
    'public.consume_refund_start(uuid)',
    'public.consume_finalize_release(uuid,uuid,uuid,text)',
    'public.consume_operation_confirmed(uuid,varchar,uuid,varchar,numeric,varchar,numeric)',
    'public.tier2_record_sol_balance_capture(uuid,uuid,varchar,varchar,varchar,integer,numeric,numeric,numeric,varchar,integer,bytea)',
    'public.consume_sol_no_send_disposition(uuid,uuid,uuid)',
    'public.consume_arithmetic_violation(uuid,uuid)',
    'public.consume_ops_continue(uuid,varchar,text)',
    'public.consume_settle_snapshot(uuid,varchar,varchar,varchar,varchar,numeric,numeric,numeric,boolean,bytea,numeric,bigint,varchar,numeric,bytea,varchar,bytea,jsonb,bytea,uuid)',
    'public.consume_approval_open_reward(uuid,uuid,numeric,varchar)',
    'public.consume_cancel_intent(uuid,uuid)',
    'public.release_liability(uuid,varchar,varchar,integer,uuid)',
    'public.tier2_transition(uuid,varchar,varchar,varchar,varchar,uuid)',
    'public.tier2_record_provider_capture(uuid,varchar,integer,varchar,uuid,varchar,varchar,numeric,bytea,bytea,bytea,bytea,boolean,integer,integer,integer,integer,integer,integer,integer,varchar,varchar,varchar,varchar,numeric,numeric,varchar)',
    'public.tier2_prepare_send(uuid,varchar,uuid,bytea,varchar,bigint,numeric,boolean,varchar,numeric,numeric,numeric,jsonb,varchar,bytea,bytea,bytea,bytea)',
    'public.tier2_pre_sign_checkpoint(uuid,varchar,uuid)',
    'public.tier2_pre_broadcast_checkpoint(uuid,varchar,uuid,varchar)',
    'public.tier2_mark_broadcast_unknown(uuid,varchar,uuid,varchar)',
    'public.tier2_reject_not_broadcast(uuid,varchar,uuid)',
    'tier2_trusted.load_depositor(uuid,varchar,uuid)'
  ];
BEGIN
  SELECT r.oid INTO STRICT v_owner FROM pg_catalog.pg_roles r
    WHERE r.rolname=current_user;
  IF pg_catalog.to_regprocedure('public.t2ps_reserve_before_sign()') IS NOT NULL
     OR EXISTS (
       WITH expected(signature,expected_oid) AS (
         SELECT e.signature,pg_catalog.to_regprocedure(e.signature)::oid
         FROM unnest(v_expected) e(signature)
       ), actual AS (
         SELECT p.oid,p.oid::regprocedure::text AS signature,p.proowner,p.proconfig
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
         WHERE (n.nspname='public' AND p.proname::text=ANY(ARRAY[
           'tier2_register_provider','tier2_deactivate_provider',
           't2_leg_state_admitted','t2_payment_coordinate_digest',
           'tier2_admit_bounty','tier2_open_automatic_generation','tier2_claim_operation',
           't2_attempt_one_approved_guard','t2a_assert_admitted','t2a_freeze',
           'b_t2_freeze_admitted','t2c_succ_freeze','t2_append_only','t2rp_freeze',
           't2ps_guard','t2l_guard','t2d_monotonic','t2o_state_guard',
           't2_assert_send_contract','t2ps_reserve_before_prepare','t2_authorize_transition',
           'b_t2_transition_validate','consume_refund_start','consume_finalize_release',
           'consume_operation_confirmed','tier2_record_sol_balance_capture',
           'consume_sol_no_send_disposition','consume_arithmetic_violation','consume_ops_continue',
           'consume_settle_snapshot','consume_approval_open_reward','consume_cancel_intent',
           'release_liability','tier2_transition','tier2_record_provider_capture',
           'tier2_prepare_send','tier2_pre_sign_checkpoint','tier2_pre_broadcast_checkpoint',
           'tier2_mark_broadcast_unknown','tier2_reject_not_broadcast']))
           OR (n.nspname='tier2_trusted' AND p.proname='load_depositor')
       )
       SELECT 1 FROM expected e FULL JOIN actual a ON a.oid=e.expected_oid
       WHERE e.signature IS NULL OR e.expected_oid IS NULL OR a.oid IS NULL
          OR a.proowner IS DISTINCT FROM v_owner
          OR NOT (coalesce(a.proconfig,ARRAY[]::text[]) @>
                  ARRAY['search_path=pg_catalog'])
     )
  THEN RAISE EXCEPTION 'tier2_routine_signature_owner_or_search_path_inventory_invalid'; END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.consume_ops_continue(uuid,varchar,text) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.consume_settle_snapshot(uuid,varchar,varchar,varchar,varchar,numeric,numeric,numeric,boolean,bytea,numeric,bigint,varchar,numeric,bytea,varchar,bytea,jsonb,bytea,uuid) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.consume_approval_open_reward(uuid,uuid,numeric,varchar) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.consume_cancel_intent(uuid,uuid) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.consume_refund_start(uuid) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.consume_finalize_release(uuid,uuid,uuid,text) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.consume_operation_confirmed(uuid,varchar,uuid,varchar,numeric,varchar,numeric) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_record_sol_balance_capture(uuid,uuid,varchar,varchar,varchar,integer,numeric,numeric,numeric,varchar,integer,bytea) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.consume_sol_no_send_disposition(uuid,uuid,uuid) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.release_liability(uuid,varchar,varchar,integer,uuid) TO clawville_app;
GRANT EXECUTE ON FUNCTION tier2_trusted.load_depositor(uuid,varchar,uuid) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.consume_arithmetic_violation(uuid,uuid) TO clawville_ops;
GRANT EXECUTE ON FUNCTION public.tier2_transition(uuid,varchar,varchar,varchar,varchar,uuid) TO clawville_ops;
GRANT EXECUTE ON FUNCTION public.tier2_register_provider(varchar,varchar,integer,varchar,varchar,boolean) TO clawville_ops;
GRANT EXECUTE ON FUNCTION public.tier2_deactivate_provider(varchar,integer) TO clawville_ops;
GRANT EXECUTE ON FUNCTION public.tier2_admit_bounty(uuid,varchar,varchar,varchar,varchar,varchar,varchar,varchar,integer,numeric,varchar,varchar,varchar,text,varchar,varchar) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_open_automatic_generation(uuid,varchar) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_claim_operation(uuid,varchar,uuid) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_record_provider_capture(uuid,varchar,integer,varchar,uuid,varchar,varchar,numeric,bytea,bytea,bytea,bytea,boolean,integer,integer,integer,integer,integer,integer,integer,varchar,varchar,varchar,varchar,numeric,numeric,varchar) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_prepare_send(uuid,varchar,uuid,bytea,varchar,bigint,numeric,boolean,varchar,numeric,numeric,numeric,jsonb,varchar,bytea,bytea,bytea,bytea) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_pre_sign_checkpoint(uuid,varchar,uuid) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_pre_broadcast_checkpoint(uuid,varchar,uuid,varchar) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_mark_broadcast_unknown(uuid,varchar,uuid,varchar) TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_reject_not_broadcast(uuid,varchar,uuid) TO clawville_app;

REVOKE EXECUTE ON FUNCTION public.t2_attempt_one_approved_guard() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2a_assert_admitted() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2a_freeze() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.b_t2_freeze_admitted() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2c_succ_freeze() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2_append_only() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2rp_freeze() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2ps_guard() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2l_guard() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2d_monotonic() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2o_state_guard() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2ps_reserve_before_prepare() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.b_t2_transition_validate() FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2_leg_state_admitted(varchar,varchar) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2_payment_coordinate_digest(uuid,varchar,uuid,bigint,numeric,varchar) FROM PUBLIC,clawville_app,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.t2_assert_send_contract(uuid,varchar,uuid) FROM PUBLIC,clawville_app,clawville_ops;

DO $$
DECLARE v_owner text:=current_user;
BEGIN
  -- Effective checks include direct, inherited, PUBLIC, and built-in role paths.
  IF pg_catalog.pg_has_role('clawville_app',v_owner,'MEMBER')
     OR pg_catalog.pg_has_role('clawville_ops',v_owner,'MEMBER')
     OR EXISTS (
       SELECT 1 FROM (VALUES ('clawville_app'),('clawville_ops')) rr(role_name)
       JOIN pg_catalog.pg_attribute a ON a.attrelid='public.bounties'::regclass
         AND a.attnum>0 AND NOT a.attisdropped
       WHERE (a.attname='settlement_tier2' OR a.attname LIKE 'tier2\_%' ESCAPE '\'
              OR a.attname IN ('payout_expected_atomic','price_prior_state',
                               'ops_prior_state','composition_state'))
         AND pg_catalog.has_column_privilege(
               rr.role_name,'public.bounties',a.attname,'UPDATE'))
     OR pg_catalog.has_column_privilege(
          'clawville_app','public.bounty_tier2_depositors','encrypted_secret_key','SELECT')
     OR pg_catalog.has_column_privilege(
          'clawville_ops','public.bounty_tier2_depositors','encrypted_secret_key','SELECT')
     OR EXISTS (
       SELECT 1 FROM (VALUES ('clawville_app'),('clawville_ops')) rr(role_name)
       CROSS JOIN (VALUES
         ('public.t2_authorize_transition(uuid,varchar,varchar,varchar,varchar,varchar,uuid)'),
         ('public.t2_leg_state_admitted(varchar,varchar)'),
         ('public.t2_payment_coordinate_digest(uuid,varchar,uuid,bigint,numeric,varchar)'),
         ('public.t2_assert_send_contract(uuid,varchar,uuid)'),
         ('public.b_t2_transition_validate()'),('public.t2o_state_guard()'),
         ('public.t2ps_reserve_before_prepare()')) ff(signature)
       WHERE pg_catalog.has_function_privilege(
               rr.role_name,pg_catalog.to_regprocedure(ff.signature),'EXECUTE'))
     OR EXISTS (
       SELECT 1 FROM (VALUES ('clawville_app'),('clawville_ops')) rr(role_name)
       JOIN pg_catalog.pg_class c ON c.relname IN (
         'bounty_tier2_assets','bounty_tier2_evidence','bounty_tier2_operations',
         'bounty_tier2_op_control','bounty_tier2_prepared_sends',
         'bounty_tier2_settle_captures','bounty_tier2_sol_balance_captures',
         'bounty_tier2_settle_snapshots',
         'bounty_tier2_payout_releases','bounty_tier2_depositors',
         'bounty_tier2_transitions','bounty_tier2_liabilities','tier2_rpc_providers',
         'tier2_policy','tier2_ops_alerts','tier2_legacy_inventory')
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
       WHERE pg_catalog.has_table_privilege(rr.role_name,c.oid,'INSERT')
          OR pg_catalog.has_table_privilege(rr.role_name,c.oid,'UPDATE')
          OR pg_catalog.has_table_privilege(rr.role_name,c.oid,'DELETE')
          OR pg_catalog.has_any_column_privilege(rr.role_name,c.oid,'INSERT')
          OR pg_catalog.has_any_column_privilege(rr.role_name,c.oid,'UPDATE'))
  THEN RAISE EXCEPTION 'tier2_effective_acl_or_inherited_role_path_invalid'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
      AND NOT a.attisdropped AND a.attacl IS NOT NULL
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
    LEFT JOIN pg_catalog.pg_roles gr ON gr.oid=x.grantee
    WHERE x.grantee<>c.relowner AND n.nspname='public' AND (
      (c.relname='bounties' AND (
        a.attname='settlement_tier2' OR a.attname LIKE 'tier2\_%' ESCAPE '\'
        OR a.attname IN ('payout_expected_atomic','price_prior_state',
                         'ops_prior_state','composition_state')))
      OR (c.relname IN (
        'bounty_tier2_assets','bounty_tier2_evidence','bounty_tier2_operations',
        'bounty_tier2_op_control','bounty_tier2_prepared_sends',
        'bounty_tier2_settle_captures','bounty_tier2_sol_balance_captures',
        'bounty_tier2_settle_snapshots',
        'bounty_tier2_payout_releases','bounty_tier2_transitions',
        'bounty_tier2_liabilities','tier2_rpc_providers','tier2_ops_principals',
        'tier2_ops_authorizations','tier2_policy','tier2_ops_alerts',
        'tier2_legacy_inventory'))
      OR (c.relname='bounty_tier2_depositors' AND NOT (
        gr.rolname IN ('clawville_app','clawville_ops')
        AND x.privilege_type='SELECT'
        AND a.attname IN ('bounty_id','public_key','funded_sol_lamports',
          'funded_usdc_atomic','swept_at','ata_closed_at','escrow_closed_at','created_at')))
    )
  ) THEN RAISE EXCEPTION 'tier2_direct_column_acl_inventory_invalid'; END IF;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA tier2_trusted REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA tier2_trusted REVOKE ALL ON FUNCTIONS FROM PUBLIC;
