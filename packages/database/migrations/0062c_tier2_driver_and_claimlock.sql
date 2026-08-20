-- Tier-2 app driver/reconciler/payout executors and deferred hunter payee.
-- Forward-only, additive except for the three frozen payee-seam re-opens.

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

CREATE TABLE IF NOT EXISTS public.tier2_app_allowed_edges (
  actor varchar(16) NOT NULL,
  old_state varchar(32) NOT NULL,
  new_state varchar(32) NOT NULL,
  evidence_kind varchar(24) NOT NULL DEFAULT '',
  leg varchar(24) NOT NULL DEFAULT '',
  PRIMARY KEY (actor,old_state,new_state,evidence_kind,leg),
  CONSTRAINT t2aae_actor CHECK (actor IN ('driver','reconciler','payout'))
);

INSERT INTO public.tier2_app_allowed_edges
  (actor,old_state,new_state,evidence_kind,leg) VALUES
  ('driver','fee_pending','funding_pending','signature','fee_charge'),
  ('driver','fee_pending','fee_unresolved','',''),
  ('driver','fee_pending','cancelled','sends_expired','fee_charge'),
  ('driver','fee_unresolved','funding_pending','signature','fee_charge'),
  ('driver','fee_unresolved','cancelled','sends_expired','fee_charge'),
  ('driver','funding_pending','vault_pending','signature','funding_usdc'),
  ('driver','funding_pending','create_failed','',''),
  ('driver','vault_pending','vault_confirmed','signature','vault_open'),
  ('driver','vault_pending','create_failed','sends_expired','vault_open'),
  ('driver','vault_held','settle_snapshot_ops_pending','',''),
  ('driver','awaiting_finalize','settle_snapshot_ops_pending','',''),
  ('driver','reconcile_payout_failed','payout_ready','',''),
  ('driver','cleanup_pending','paid','',''),
  ('driver','finalize_exhausted','payout_ready','finalize_release','bounty'),
  ('driver','price_blocked','vault_held','price_revalidated','bounty'),
  ('driver','price_blocked','awaiting_finalize','price_revalidated','bounty'),
  ('driver','price_blocked','payout_ready','price_revalidated','bounty'),
  ('driver','price_blocked','cleanup_pending','price_revalidated','bounty'),
  ('driver','create_failed','cancelled','',''),
  ('driver','refund_pending','refunded','',''),
  ('reconciler','vault_confirmed','vault_held','signature','vault_open'),
  ('reconciler','vault_unconfirmed','vault_held','signature','vault_open'),
  ('payout','payout_ready','cleanup_pending','signature','payout'),
  ('payout','reconcile_payout_failed','cleanup_pending','signature','payout'),
  ('payout','payout_ready','reconcile_payout_failed','','')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.tier2_driver_transition(
  p_bounty uuid,p_old varchar,p_new varchar,
  p_evidence_kind varchar,p_leg varchar,p_evidence uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_state varchar(32); v_evidence_kind varchar(24):=coalesce(p_evidence_kind,'');
        v_leg varchar(24):=coalesce(p_leg,'');
BEGIN
  IF p_old IS NULL OR p_new IS NULL
  THEN RAISE EXCEPTION 'tier2_transition_coordinate_null'; END IF;
  SELECT b.composition_state INTO v_state FROM public.bounties b
    WHERE b.id=p_bounty AND b.settlement_tier2 IS TRUE FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=CASE WHEN v_leg='' THEN 'bounty' ELSE v_leg END
    FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty ORDER BY o.leg,o.generation FOR UPDATE;
  IF v_state IS NOT DISTINCT FROM p_new THEN RETURN false; END IF;
  IF v_state IS DISTINCT FROM p_old
  THEN RAISE EXCEPTION 'tier2_transition_stale:%:%',v_state,p_old; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tier2_app_allowed_edges a
    WHERE a.actor='driver' AND a.old_state=p_old AND a.new_state=p_new
      AND a.evidence_kind=v_evidence_kind AND a.leg=v_leg)
  THEN RAISE EXCEPTION 'tier2_driver_transition_not_allowed:%:%:%:%',
    p_old,p_new,v_evidence_kind,v_leg; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bounty_tier2_transitions t
    WHERE t.old_state=p_old AND t.new_state=p_new AND t.actor='driver'
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
    p_bounty,p_old,p_new,'driver',v_evidence_kind,v_leg,p_evidence);
  UPDATE public.bounties SET composition_state=p_new WHERE id=p_bounty;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_reconciler_transition(
  p_bounty uuid,p_old varchar,p_new varchar,
  p_evidence_kind varchar,p_leg varchar,p_evidence uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_state varchar(32); v_status public.bounty_status;
        v_evidence_kind varchar(24):=coalesce(p_evidence_kind,'');
        v_leg varchar(24):=coalesce(p_leg,'');
BEGIN
  IF p_old IS NULL OR p_new IS NULL
  THEN RAISE EXCEPTION 'tier2_transition_coordinate_null'; END IF;
  SELECT b.composition_state,b.status INTO v_state,v_status FROM public.bounties b
    WHERE b.id=p_bounty AND b.settlement_tier2 IS TRUE FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=CASE WHEN v_leg='' THEN 'bounty' ELSE v_leg END
    FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty ORDER BY o.leg,o.generation FOR UPDATE;
  IF v_state IS NOT DISTINCT FROM p_new THEN RETURN false; END IF;
  IF v_state IS DISTINCT FROM p_old
  THEN RAISE EXCEPTION 'tier2_transition_stale:%:%',v_state,p_old; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tier2_app_allowed_edges a
    WHERE a.actor='reconciler' AND a.old_state=p_old AND a.new_state=p_new
      AND a.evidence_kind=v_evidence_kind AND a.leg=v_leg)
  THEN RAISE EXCEPTION 'tier2_reconciler_transition_not_allowed:%:%',p_old,p_new; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bounty_tier2_transitions t
    WHERE t.old_state=p_old AND t.new_state=p_new AND t.actor='reconciler'
      AND t.evidence_kind=v_evidence_kind AND t.leg=v_leg)
  THEN RAISE EXCEPTION 'tier2_transition_not_allowed'; END IF;
  IF v_evidence_kind<>'' AND NOT EXISTS (
    SELECT 1 FROM public.bounty_tier2_evidence e
    WHERE e.id=p_evidence AND e.bounty_id=p_bounty
      AND e.kind=v_evidence_kind AND (v_leg='' OR e.leg=v_leg)
  ) THEN RAISE EXCEPTION 'tier2_transition_evidence_invalid'; END IF;
  IF (SELECT count(*) FROM public.bounty_tier2_assets a
      WHERE a.bounty_id=p_bounty AND a.asset_kind='usdc')<>1
     OR (SELECT count(*) FROM public.bounty_tier2_assets a
         WHERE a.bounty_id=p_bounty AND a.asset_kind='sol')<>1
  THEN RAISE EXCEPTION 'tier2_reconciler_asset_shape_invalid'; END IF;
  PERFORM public.t2_authorize_transition(
    p_bounty,p_old,p_new,'reconciler',v_evidence_kind,v_leg,p_evidence);
  UPDATE public.bounties SET composition_state=p_new,status='open' WHERE id=p_bounty;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_payout_transition(
  p_bounty uuid,p_old varchar,p_new varchar,
  p_evidence_kind varchar,p_leg varchar,p_evidence uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_state varchar(32); v_evidence_kind varchar(24):=coalesce(p_evidence_kind,'');
        v_leg varchar(24):=coalesce(p_leg,'');
BEGIN
  IF p_old IS NULL OR p_new IS NULL
  THEN RAISE EXCEPTION 'tier2_transition_coordinate_null'; END IF;
  SELECT b.composition_state INTO v_state FROM public.bounties b
    WHERE b.id=p_bounty AND b.settlement_tier2 IS TRUE FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  PERFORM 1 FROM public.bounty_tier2_op_control c
    WHERE c.bounty_id=p_bounty AND c.leg=CASE WHEN v_leg='' THEN 'bounty' ELSE v_leg END
    FOR UPDATE;
  PERFORM 1 FROM public.bounty_tier2_operations o
    WHERE o.bounty_id=p_bounty ORDER BY o.leg,o.generation FOR UPDATE;
  IF v_state IS NOT DISTINCT FROM p_new THEN RETURN false; END IF;
  IF v_state IS DISTINCT FROM p_old
  THEN RAISE EXCEPTION 'tier2_transition_stale:%:%',v_state,p_old; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tier2_app_allowed_edges a
    WHERE a.actor='payout' AND a.old_state=p_old AND a.new_state=p_new
      AND a.evidence_kind=v_evidence_kind AND a.leg=v_leg)
  THEN RAISE EXCEPTION 'tier2_payout_transition_not_allowed:%:%',p_old,p_new; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bounty_tier2_transitions t
    WHERE t.old_state=p_old AND t.new_state=p_new AND t.actor='payout'
      AND t.evidence_kind=v_evidence_kind AND t.leg=v_leg)
  THEN RAISE EXCEPTION 'tier2_transition_not_allowed'; END IF;
  IF v_evidence_kind<>'' AND NOT EXISTS (
    SELECT 1 FROM public.bounty_tier2_evidence e
    WHERE e.id=p_evidence AND e.bounty_id=p_bounty
      AND e.kind=v_evidence_kind AND (v_leg='' OR e.leg=v_leg)
  ) THEN RAISE EXCEPTION 'tier2_transition_evidence_invalid'; END IF;
  IF p_new='cleanup_pending' AND (
       NOT EXISTS (SELECT 1 FROM public.bounty_tier2_payout_releases r
                   WHERE r.bounty_id=p_bounty AND r.evidence_id=p_evidence)
       OR NOT EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
                      WHERE l.bounty_id=p_bounty AND l.kind='reward_payout'
                        AND l.disposition='released')
     )
  THEN RAISE EXCEPTION 'tier2_payout_release_not_proven'; END IF;
  PERFORM public.t2_authorize_transition(
    p_bounty,p_old,p_new,'payout',v_evidence_kind,v_leg,p_evidence);
  UPDATE public.bounties SET composition_state=p_new WHERE id=p_bounty;
  RETURN true;
END $$;

-- Deferred payee seam: a funded/open bounty may remain unbound until approval.
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
    AND payout_expected_atomic > 0
    AND payout_expected_atomic <= 18446744073709551615
  )
);

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
     OR (p_hunter_ata IS NOT NULL
         AND p_hunter_ata !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
     OR p_depositor_public_key IS NULL
     OR p_depositor_public_key !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR p_depositor_usdc_ata IS NULL
     OR p_depositor_usdc_ata !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     OR (p_hunter_ata IS NULL AND cardinality(ARRAY(
          SELECT DISTINCT x FROM unnest(ARRAY[p_poster_wallet,p_poster_ata,
            p_depositor_public_key,p_depositor_usdc_ata,p_vault_ata,
            p_sol_return]) x
        ))<>6)
     OR (p_hunter_ata IS NOT NULL AND cardinality(ARRAY(
          SELECT DISTINCT x FROM unnest(ARRAY[p_poster_wallet,p_poster_ata,
            p_depositor_public_key,p_depositor_usdc_ata,p_vault_ata,p_hunter_ata,
            p_sol_return]) x
        ))<>7)
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
       OR NEW.tier2_poster_usdc_ata IS DISTINCT FROM OLD.tier2_poster_usdc_ata
       OR NEW.tier2_vault_usdc_ata IS DISTINCT FROM OLD.tier2_vault_usdc_ata
       OR NEW.tier2_sol_return_address IS DISTINCT FROM OLD.tier2_sol_return_address)
  THEN RAISE EXCEPTION 'tier2_admitted_coordinates_frozen'; END IF;
  IF EXISTS (SELECT 1 FROM public.bounty_tier2_assets a WHERE a.bounty_id=NEW.id)
     AND OLD.tier2_hunter_ata IS NOT NULL
     AND NEW.tier2_hunter_ata IS DISTINCT FROM OLD.tier2_hunter_ata
  THEN RAISE EXCEPTION 'tier2_admitted_coordinates_frozen'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.tier2_bind_hunter_payee(
  p_bounty uuid,p_hunter_ata varchar
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_state varchar(32); v_hunter varchar(64); v_poster_wallet varchar(64);
        v_poster_ata varchar(64); v_vault_ata varchar(64); v_sol_return varchar(64);
        v_depositor_public_key varchar(64); v_depositor_usdc_ata varchar(64);
BEGIN
  SELECT b.composition_state,b.tier2_hunter_ata,b.tier2_poster_wallet,
         b.tier2_poster_usdc_ata,b.tier2_vault_usdc_ata,
         b.tier2_sol_return_address,d.public_key,d.usdc_ata
    INTO v_state,v_hunter,v_poster_wallet,v_poster_ata,v_vault_ata,
         v_sol_return,v_depositor_public_key,v_depositor_usdc_ata
    FROM public.bounties b
    JOIN public.bounty_tier2_depositors d ON d.bounty_id=b.id
    WHERE b.id=p_bounty AND b.settlement_tier2
    FOR UPDATE OF b,d;
  IF NOT FOUND THEN RAISE EXCEPTION 'tier2_bounty_not_found'; END IF;
  IF p_hunter_ata IS NULL OR p_hunter_ata !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  THEN RAISE EXCEPTION 'tier2_hunter_ata_invalid'; END IF;
  IF v_state IS DISTINCT FROM 'vault_held'
  THEN RAISE EXCEPTION 'tier2_bind_illegal_state:%',v_state; END IF;
  IF EXISTS (SELECT 1 FROM public.bounty_tier2_evidence e
             WHERE e.bounty_id=p_bounty AND e.kind='approval')
     OR EXISTS (SELECT 1 FROM public.bounty_tier2_liabilities l
                WHERE l.bounty_id=p_bounty AND l.kind='reward_payout'
                  AND l.disposition='open')
     OR EXISTS (SELECT 1 FROM public.bounty_tier2_payout_releases r
                WHERE r.bounty_id=p_bounty)
  THEN RAISE EXCEPTION 'tier2_payee_already_locked'; END IF;
  IF v_hunter IS NOT DISTINCT FROM p_hunter_ata THEN RETURN false; END IF;
  IF v_hunter IS NOT NULL THEN RAISE EXCEPTION 'tier2_hunter_ata_frozen'; END IF;
  IF p_hunter_ata IN (v_poster_wallet,v_poster_ata,v_vault_ata,v_sol_return,
                      v_depositor_public_key,v_depositor_usdc_ata)
  THEN RAISE EXCEPTION 'tier2_hunter_ata_not_distinct'; END IF;
  UPDATE public.bounties SET tier2_hunter_ata=p_hunter_ata WHERE id=p_bounty;
  RETURN true;
END $$;

-- CREATE OR REPLACE preserves stale owners and ACL entries. Normalize the four
-- new companion routines, erase every non-owner EXECUTE, then grant app only.
DO $$
DECLARE r record; v_role text;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'tier2_driver_transition','tier2_reconciler_transition',
      'tier2_payout_transition','tier2_bind_hunter_payee')
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO CURRENT_USER',r.signature);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS signature,a.grantee
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE n.nspname='public' AND p.proname IN (
      'tier2_driver_transition','tier2_reconciler_transition',
      'tier2_payout_transition','tier2_bind_hunter_payee')
      AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner
  LOOP
    IF r.grantee=0 THEN v_role:='PUBLIC';
    ELSE SELECT pr.rolname INTO v_role FROM pg_catalog.pg_roles pr WHERE pr.oid=r.grantee; END IF;
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s',
      r.signature,CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(v_role) END);
  END LOOP;
END $$;

REVOKE ALL ON TABLE public.tier2_app_allowed_edges FROM PUBLIC,clawville_app,clawville_ops;
REVOKE ALL (actor,old_state,new_state,evidence_kind,leg)
  ON TABLE public.tier2_app_allowed_edges FROM PUBLIC,clawville_app,clawville_ops;
GRANT SELECT ON TABLE public.tier2_app_allowed_edges TO clawville_app,clawville_ops;

REVOKE EXECUTE ON FUNCTION public.tier2_driver_transition(uuid,varchar,varchar,varchar,varchar,uuid)
  FROM PUBLIC,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_reconciler_transition(uuid,varchar,varchar,varchar,varchar,uuid)
  FROM PUBLIC,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_payout_transition(uuid,varchar,varchar,varchar,varchar,uuid)
  FROM PUBLIC,clawville_ops;
REVOKE EXECUTE ON FUNCTION public.tier2_bind_hunter_payee(uuid,varchar)
  FROM PUBLIC,clawville_ops;
GRANT EXECUTE ON FUNCTION public.tier2_driver_transition(uuid,varchar,varchar,varchar,varchar,uuid)
  TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_reconciler_transition(uuid,varchar,varchar,varchar,varchar,uuid)
  TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_payout_transition(uuid,varchar,varchar,varchar,varchar,uuid)
  TO clawville_app;
GRANT EXECUTE ON FUNCTION public.tier2_bind_hunter_payee(uuid,varchar)
  TO clawville_app;

-- Closed inventory for the new routines: exact signatures, owner, search path,
-- SECURITY DEFINER, and the direct/effective app-only EXECUTE boundary.
DO $$
DECLARE
  v_owner oid;
  v_app oid;
  v_ops oid;
  v_expected text[]:=ARRAY[
    'public.tier2_driver_transition(uuid,varchar,varchar,varchar,varchar,uuid)',
    'public.tier2_reconciler_transition(uuid,varchar,varchar,varchar,varchar,uuid)',
    'public.tier2_payout_transition(uuid,varchar,varchar,varchar,varchar,uuid)',
    'public.tier2_bind_hunter_payee(uuid,varchar)'
  ];
BEGIN
  SELECT r.oid INTO STRICT v_owner FROM pg_catalog.pg_roles r WHERE r.rolname=current_user;
  SELECT r.oid INTO STRICT v_app FROM pg_catalog.pg_roles r WHERE r.rolname='clawville_app';
  SELECT r.oid INTO STRICT v_ops FROM pg_catalog.pg_roles r WHERE r.rolname='clawville_ops';

  IF EXISTS (
    WITH expected(signature,expected_oid) AS (
      SELECT e.signature,pg_catalog.to_regprocedure(e.signature)::oid
      FROM unnest(v_expected) e(signature)
    ), actual AS (
      SELECT p.oid,p.oid::regprocedure::text AS signature,p.proowner,p.proconfig,p.prosecdef
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname::text=ANY(ARRAY[
        'tier2_driver_transition','tier2_reconciler_transition',
        'tier2_payout_transition','tier2_bind_hunter_payee'])
    )
    SELECT 1 FROM expected e FULL JOIN actual a ON a.oid=e.expected_oid
    WHERE e.signature IS NULL OR e.expected_oid IS NULL OR a.oid IS NULL
       OR a.proowner IS DISTINCT FROM v_owner OR NOT a.prosecdef
       OR NOT (coalesce(a.proconfig,ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog'])
  ) THEN RAISE EXCEPTION 'tier2_0062c_routine_inventory_invalid'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname::text=ANY(ARRAY[
      'tier2_driver_transition','tier2_reconciler_transition',
      'tier2_payout_transition','tier2_bind_hunter_payee'])
      AND (
        NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(
            coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
          WHERE a.grantee=v_app AND a.privilege_type='EXECUTE'
        )
        OR pg_catalog.has_function_privilege('clawville_ops',p.oid,'EXECUTE')
        OR EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(
            coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
          WHERE a.privilege_type='EXECUTE'
            AND a.grantee NOT IN (p.proowner,v_app)
        )
      )
  ) THEN RAISE EXCEPTION 'tier2_0062c_routine_acl_inventory_invalid'; END IF;
END $$;

-- The policy table is owner-seeded and read-only to both runtime roles. Its
-- contents are the exact 20 driver + 2 reconciler + 3 payout frozen slices.
DO $$
DECLARE v_owner oid; v_app oid; v_ops oid; v_table oid;
BEGIN
  SELECT r.oid INTO STRICT v_owner FROM pg_catalog.pg_roles r WHERE r.rolname=current_user;
  SELECT r.oid INTO STRICT v_app FROM pg_catalog.pg_roles r WHERE r.rolname='clawville_app';
  SELECT r.oid INTO STRICT v_ops FROM pg_catalog.pg_roles r WHERE r.rolname='clawville_ops';
  SELECT c.oid INTO STRICT v_table FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='tier2_app_allowed_edges'
      AND c.relkind='r' AND c.relowner=v_owner;

  IF (SELECT count(*) FROM public.tier2_app_allowed_edges)<>25
     OR (SELECT count(*) FROM public.tier2_app_allowed_edges WHERE actor='driver')<>20
     OR (SELECT count(*) FROM public.tier2_app_allowed_edges WHERE actor='reconciler')<>2
     OR (SELECT count(*) FROM public.tier2_app_allowed_edges WHERE actor='payout')<>3
     OR EXISTS (
       SELECT 1 FROM public.tier2_app_allowed_edges a
       WHERE NOT EXISTS (
         SELECT 1 FROM public.bounty_tier2_transitions t
         WHERE t.old_state=a.old_state AND t.new_state=a.new_state AND t.actor=a.actor
           AND t.evidence_kind=a.evidence_kind AND t.leg=a.leg
       )
     )
  THEN RAISE EXCEPTION 'tier2_0062c_allow_list_inventory_invalid'; END IF;

  IF NOT pg_catalog.has_table_privilege('clawville_app',v_table,'SELECT')
     OR NOT pg_catalog.has_table_privilege('clawville_ops',v_table,'SELECT')
     OR pg_catalog.has_table_privilege('clawville_app',v_table,'INSERT')
     OR pg_catalog.has_table_privilege('clawville_app',v_table,'UPDATE')
     OR pg_catalog.has_table_privilege('clawville_app',v_table,'DELETE')
     OR pg_catalog.has_table_privilege('clawville_app',v_table,'TRUNCATE')
     OR pg_catalog.has_table_privilege('clawville_ops',v_table,'INSERT')
     OR pg_catalog.has_table_privilege('clawville_ops',v_table,'UPDATE')
     OR pg_catalog.has_table_privilege('clawville_ops',v_table,'DELETE')
     OR pg_catalog.has_table_privilege('clawville_ops',v_table,'TRUNCATE')
     OR pg_catalog.has_any_column_privilege('clawville_app',v_table,'INSERT')
     OR pg_catalog.has_any_column_privilege('clawville_app',v_table,'UPDATE')
     OR pg_catalog.has_any_column_privilege('clawville_ops',v_table,'INSERT')
     OR pg_catalog.has_any_column_privilege('clawville_ops',v_table,'UPDATE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(
         coalesce((SELECT c.relacl FROM pg_catalog.pg_class c WHERE c.oid=v_table),
                  pg_catalog.acldefault('r',v_owner))) a
       WHERE a.grantee<>v_owner AND NOT (
         a.grantee IN (v_app,v_ops) AND a.privilege_type='SELECT'
       )
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute pa
       CROSS JOIN LATERAL pg_catalog.aclexplode(pa.attacl) a
       WHERE pa.attrelid=v_table AND pa.attnum>0 AND NOT pa.attisdropped
         AND pa.attacl IS NOT NULL AND a.grantee<>v_owner
     )
  THEN RAISE EXCEPTION 'tier2_0062c_allow_list_acl_inventory_invalid'; END IF;
END $$;
