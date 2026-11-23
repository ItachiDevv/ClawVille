-- Fresh exact consent can authorize first capture of a retained unsigned submit only.
-- Original operation, authority rows, fees and revocation evidence are never renewed.
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_exact_consent_capture_owner ON brainchain_exact_result_consents(id,result_id,binding_id,avatar_id);
CREATE TABLE IF NOT EXISTS brainchain_exact_capture_authorities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 consent_id uuid NOT NULL UNIQUE REFERENCES brainchain_exact_result_consents(id),
 operation_id uuid NOT NULL, result_id uuid NOT NULL, binding_id uuid NOT NULL, avatar_id uuid NOT NULL,
 environment varchar(8) NOT NULL DEFAULT 'testnet', chain_id integer NOT NULL DEFAULT 274630,
 generation integer NOT NULL, nonce numeric(78,0) NOT NULL, UNIQUE(id,operation_id),
 intent jsonb NOT NULL, intent_hash varchar(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 CONSTRAINT brainchain_capture_consent_owner FOREIGN KEY(consent_id,result_id,binding_id,avatar_id) REFERENCES brainchain_exact_result_consents(id,result_id,binding_id,avatar_id),
 CONSTRAINT brainchain_capture_operation_owner FOREIGN KEY(operation_id,binding_id,avatar_id,environment,chain_id)
 REFERENCES brainchain_signer_operations(id,binding_id,avatar_id,environment,chain_id),
 CONSTRAINT brainchain_capture_result_owner FOREIGN KEY(result_id,binding_id,avatar_id,environment,chain_id)
 REFERENCES brainchain_task_results(id,binding_id,avatar_id,environment,chain_id),
 CONSTRAINT brainchain_capture_submission FOREIGN KEY(operation_id,result_id) REFERENCES brainchain_result_submissions(operation_id,result_id),
 CONSTRAINT brainchain_capture_values CHECK(environment='testnet' AND chain_id=274630 AND generation>0 AND nonce>=0 AND nonce<=9007199254740991
 AND intent_hash ~ '^[a-f0-9]{64}$' AND jsonb_typeof(intent)='object' AND expires_at>created_at)
);
CREATE OR REPLACE FUNCTION brainchain_exact_capture_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Exact capture authority is append-only'; END $$;
DROP TRIGGER IF EXISTS brainchain_exact_capture_immutable ON brainchain_exact_capture_authorities;
CREATE TRIGGER brainchain_exact_capture_immutable BEFORE UPDATE OR DELETE ON brainchain_exact_capture_authorities
 FOR EACH ROW EXECUTE FUNCTION brainchain_exact_capture_immutable();

CREATE TABLE IF NOT EXISTS brainchain_exact_capture_acceptances (
 operation_id uuid PRIMARY KEY REFERENCES brainchain_signer_operations(id),
 authority_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(authority_id,operation_id) REFERENCES brainchain_exact_capture_authorities(id,operation_id),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS brainchain_exact_capture_acceptance_immutable ON brainchain_exact_capture_acceptances;
CREATE TRIGGER brainchain_exact_capture_acceptance_immutable BEFORE UPDATE OR DELETE ON brainchain_exact_capture_acceptances
 FOR EACH ROW EXECUTE FUNCTION brainchain_exact_capture_immutable();

-- Replace only the old-expiry upper bound with a mandatory late-acceptance trigger.
-- Existing immutable intent and state-transition triggers remain unchanged.
ALTER TABLE brainchain_signer_operations DROP CONSTRAINT IF EXISTS brainchain_operation_capture;
ALTER TABLE brainchain_signer_operations ADD CONSTRAINT brainchain_operation_capture CHECK(
 ((state='prepared' AND nonce IS NULL) OR state='rejected' OR (state IN ('reserved','accepting','signed','broadcast','confirmed','uncertain') AND nonce IS NOT NULL))
 AND ((signed_payload_ref IS NULL AND transaction_hash IS NULL AND ((accepted_at IS NULL AND state IN ('prepared','reserved','rejected','uncertain'))
 OR (accepted_at IS NOT NULL AND state IN ('accepting','uncertain') AND accepted_at>=created_at)))
 OR (signed_payload_ref IS NOT NULL AND transaction_hash IS NOT NULL AND accepted_at IS NOT NULL AND state IN ('signed','broadcast','confirmed','uncertain')
 AND accepted_at>=created_at AND signed_payload_ref ~ '^[a-f0-9]{64}$' AND transaction_hash ~ '^0x[a-f0-9]{64}$')));

CREATE OR REPLACE FUNCTION brainchain_assert_exact_capture(oid uuid,aid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a record; o record; c record; s record; r record; grant_row record;
BEGIN
 SELECT * INTO a FROM brainchain_exact_capture_authorities WHERE id=aid AND operation_id=oid;
 SELECT * INTO o FROM brainchain_signer_operations WHERE id=oid;
 IF a.id IS NULL OR o.id IS NULL OR o.kind<>'submit' OR o.state<>'reserved' OR o.accepted_at IS NOT NULL
 OR o.signed_payload_ref IS NOT NULL OR o.transaction_hash IS NOT NULL THEN RAISE EXCEPTION 'Unsigned reserved operation required'; END IF;
 SELECT * INTO s FROM brainchain_signer_streams WHERE binding_id=o.binding_id FOR UPDATE;
 SELECT * INTO c FROM brainchain_exact_result_consents WHERE id=a.consent_id FOR UPDATE;
 SELECT * INTO r FROM brainchain_task_results WHERE id=a.result_id;
 IF s.binding_id IS NULL OR s.stopped OR s.generation<>o.generation OR a.generation<>o.generation
 OR a.nonce<>o.nonce OR s.next_nonce<>o.nonce+1 OR c.id IS NULL OR r.id IS NULL
 OR brainchain_exact_recovery_consent(c.id,r.id,o.avatar_id,o.binding_id,'capture-submit') IS DISTINCT FROM c.id
 OR c.payload->'captureIntent' IS DISTINCT FROM a.intent
 OR a.intent->>'operationId' IS DISTINCT FROM o.id::text OR a.intent->>'resultId' IS DISTINCT FROM r.id::text
 OR a.intent->>'workerId' IS DISTINCT FROM o.binding_id::text OR a.intent->>'avatarId' IS DISTINCT FROM o.avatar_id::text
 OR a.intent->>'operationHash' IS DISTINCT FROM o.request_hash OR a.intent->>'authorityId' IS DISTINCT FROM o.authority_id::text
 OR a.intent->>'gasAuthorityId' IS DISTINCT FROM o.gas_authority_id::text OR a.intent->>'signer' IS DISTINCT FROM s.signer_address
 OR a.intent->>'generation' IS DISTINCT FROM o.generation::text OR a.intent->>'chainId' IS DISTINCT FROM '274630'
 OR a.intent->>'nonce' IS DISTINCT FROM o.nonce::text OR a.intent->>'gas' IS DISTINCT FROM o.gas_limit::text
 OR a.intent->>'maxFeePerGas' IS DISTINCT FROM o.max_fee_per_gas::text OR a.intent->>'maxPriorityFeePerGas' IS DISTINCT FROM o.max_priority_fee_per_gas::text
 OR a.intent->>'to' IS DISTINCT FROM o.intent#>>'{transaction,to}' OR a.intent->>'data' IS DISTINCT FROM o.intent#>>'{transaction,data}'
 OR a.intent->>'task' IS DISTINCT FROM o.intent#>>'{request,task}' OR o.intent#>>'{request,resultId}' IS DISTINCT FROM r.id::text
 OR a.intent->>'value' IS DISTINCT FROM '0' OR a.intent->>'resultHash' IS DISTINCT FROM r.result_hash OR a.intent->>'resultUri' IS DISTINCT FROM r.result_uri
 OR o.gas_limit*o.max_fee_per_gas>(c.payload->>'maxGasWei')::numeric
 OR a.expires_at>c.expires_at OR a.expires_at<=clock_timestamp() OR c.expires_at<=clock_timestamp()
 THEN RAISE EXCEPTION 'Current exact capture consent required'; END IF;
 FOR grant_row IN SELECT * FROM brainchain_signer_authorities WHERE id IN (o.authority_id,o.gas_authority_id) FOR UPDATE LOOP
  IF grant_row.revoked_at IS NOT NULL THEN
   PERFORM 1 FROM brainchain_recovery_owner_revocations p JOIN brainchain_recovery_owner_controls ctrl ON ctrl.id=p.control_id
    WHERE p.authority_kind='signer' AND p.authority_id=grant_row.id AND p.revoked_at=grant_row.revoked_at
    AND ctrl.binding_id=o.binding_id AND ctrl.avatar_id=o.avatar_id AND ctrl.user_id=c.user_id
    AND p.control_id::text=c.payload->'captured'->(CASE WHEN grant_row.id=o.authority_id THEN 'intentProvenance' ELSE 'gasProvenance' END)->>'controlId';
   IF NOT FOUND THEN RAISE EXCEPTION 'Unknown signer revocation cannot authorize exact capture'; END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM brainchain_exact_result_issuances i JOIN brainchain_exact_result_consents old_c ON old_c.id=i.consent_id
 WHERE (i.signer_authority_id=o.authority_id OR i.gas_authority_id=o.gas_authority_id) AND (old_c.revoked_at IS NOT NULL OR old_c.state='revoked'))
 THEN RAISE EXCEPTION 'Original consent revocation lacks capture provenance'; END IF;
 IF a.expires_at<=clock_timestamp() OR c.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Capture expired after locks'; END IF;
END $$;
CREATE OR REPLACE FUNCTION brainchain_exact_capture_admit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM brainchain_assert_exact_capture(NEW.operation_id,NEW.authority_id);
 IF NEW.accepted_at>clock_timestamp() OR NEW.accepted_at<clock_timestamp()-interval '1 second' THEN RAISE EXCEPTION 'Current capture acceptance time required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_exact_capture_admit ON brainchain_exact_capture_acceptances;
CREATE TRIGGER brainchain_exact_capture_admit BEFORE INSERT ON brainchain_exact_capture_acceptances FOR EACH ROW EXECUTE FUNCTION brainchain_exact_capture_admit();
CREATE OR REPLACE FUNCTION brainchain_operation_acceptance_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted record;
BEGIN
 IF NEW.accepted_at IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.accepted_at IS NOT NULL THEN RETURN NEW; END IF;
 IF NEW.accepted_at<=NEW.expires_at THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN RAISE EXCEPTION 'Late acceptance cannot be inserted'; END IF;
 SELECT * INTO accepted FROM brainchain_exact_capture_acceptances WHERE operation_id=NEW.id AND accepted_at=NEW.accepted_at;
 IF accepted.operation_id IS NULL THEN RAISE EXCEPTION 'Late acceptance requires exact capture authority'; END IF;
 PERFORM brainchain_assert_exact_capture(NEW.id,accepted.authority_id);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_operation_acceptance_expiry ON brainchain_signer_operations;
CREATE TRIGGER brainchain_operation_acceptance_expiry BEFORE INSERT OR UPDATE ON brainchain_signer_operations FOR EACH ROW EXECUTE FUNCTION brainchain_operation_acceptance_expiry();
