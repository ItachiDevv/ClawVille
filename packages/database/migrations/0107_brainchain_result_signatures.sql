-- Private typed signatures only. This migration does not activate signing.
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_result_signer_owner ON brainchain_task_results(id,binding_id,avatar_id,environment,chain_id);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_operation_result_owner ON brainchain_signer_operations(id,binding_id,avatar_id,environment,chain_id);
CREATE TABLE IF NOT EXISTS brainchain_result_submissions (
 result_id uuid PRIMARY KEY,operation_id uuid NOT NULL UNIQUE,binding_id uuid NOT NULL,avatar_id uuid NOT NULL,environment varchar(8) NOT NULL,chain_id integer NOT NULL,
 CONSTRAINT brainchain_submission_result_owner FOREIGN KEY(result_id,binding_id,avatar_id,environment,chain_id) REFERENCES brainchain_task_results(id,binding_id,avatar_id,environment,chain_id),
 CONSTRAINT brainchain_submission_operation_owner FOREIGN KEY(operation_id,binding_id,avatar_id,environment,chain_id) REFERENCES brainchain_signer_operations(id,binding_id,avatar_id,environment,chain_id),
 CONSTRAINT brainchain_submission_testnet CHECK(environment='testnet' AND chain_id=274630)
);
CREATE OR REPLACE FUNCTION brainchain_submission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM brainchain_signer_operations o JOIN brainchain_task_results r ON r.id=NEW.result_id
    WHERE o.id=NEW.operation_id AND o.kind='submit' AND o.intent->'request'->>'resultId'=r.id::text
    AND o.intent->'request'->>'hash'=r.result_hash AND o.intent->'request'->>'uri'=r.result_uri AND r.state='prepared')
  THEN RAISE EXCEPTION 'brainchain_submission_intent_mismatch'; END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'brainchain_submission_is_immutable';
END $$;
DROP TRIGGER IF EXISTS brainchain_submission_immutable ON brainchain_result_submissions;
CREATE TRIGGER brainchain_submission_immutable BEFORE INSERT OR UPDATE OR DELETE ON brainchain_result_submissions FOR EACH ROW EXECUTE FUNCTION brainchain_submission_immutable();
CREATE TABLE IF NOT EXISTS brainchain_result_signatures (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),result_id uuid NOT NULL UNIQUE,authority_id uuid NOT NULL UNIQUE,
 binding_id uuid NOT NULL,avatar_id uuid NOT NULL,environment varchar(8) NOT NULL,chain_id integer NOT NULL,
 signer_address varchar(42) NOT NULL,generation integer NOT NULL,intent jsonb NOT NULL,intent_hash varchar(64) NOT NULL,
 state varchar(16) NOT NULL DEFAULT 'accepted',accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 signature_ref varchar(64),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_signature_result_owner FOREIGN KEY(result_id,binding_id,avatar_id,environment,chain_id) REFERENCES brainchain_task_results(id,binding_id,avatar_id,environment,chain_id),
 CONSTRAINT brainchain_signature_authority_owner FOREIGN KEY(authority_id,binding_id,avatar_id,environment,chain_id,signer_address) REFERENCES brainchain_signer_authorities(id,binding_id,avatar_id,environment,chain_id,signer_address),
 CONSTRAINT brainchain_signature_values CHECK(environment='testnet' AND chain_id=274630 AND generation>0 AND intent_hash ~ '^[a-f0-9]{64}$'
 AND ((state IN ('accepted','uncertain') AND signature_ref IS NULL) OR (state='captured' AND signature_ref IS NOT NULL AND signature_ref ~ '^[a-f0-9]{64}$')))
);
CREATE OR REPLACE FUNCTION brainchain_signature_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'brainchain_signature_is_immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM brainchain_signer_authorities a JOIN brainchain_signer_streams s ON s.binding_id=a.binding_id
    JOIN brainchain_task_results r ON r.id=NEW.result_id JOIN brainchain_worker_tasks t ON t.id=r.task_id
    WHERE a.id=NEW.authority_id AND a.purpose='result-signature' AND a.max_atomic=0 AND a.request_hash=NEW.intent_hash
    AND a.generation=NEW.generation AND s.generation=NEW.generation AND NOT s.stopped AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
    AND NEW.intent->>'domain'='brainchain-result-v2' AND NEW.intent->>'chainId'='274630' AND NEW.intent->>'resultId'=r.id::text
    AND NEW.intent->>'board'=t.board_address AND NEW.intent->>'task'=t.task_id::text AND NEW.intent->>'hash'=r.result_hash AND NEW.intent->>'worker'=NEW.signer_address)
  THEN RAISE EXCEPTION 'brainchain_signature_intent_mismatch'; END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(OLD)-'state'-'signature_ref'-'updated_at') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'signature_ref'-'updated_at')
 OR (OLD.signature_ref IS NOT NULL AND OLD.signature_ref IS DISTINCT FROM NEW.signature_ref)
 OR (OLD.state='captured' AND NEW.state<>'captured') THEN RAISE EXCEPTION 'brainchain_signature_is_immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_signature_immutable ON brainchain_result_signatures;
CREATE TRIGGER brainchain_signature_immutable BEFORE INSERT OR UPDATE OR DELETE ON brainchain_result_signatures FOR EACH ROW EXECUTE FUNCTION brainchain_signature_immutable();
ALTER TABLE brainchain_signer_authorities DROP CONSTRAINT IF EXISTS brainchain_authority_values;
ALTER TABLE brainchain_signer_authorities ADD CONSTRAINT brainchain_authority_values CHECK(generation>0 AND purpose IN ('gas','faucet','approve-stake','approve-bond','stake','apply','leave','withdraw','result-signature','submit') AND request_hash ~ '^[a-f0-9]{64}$' AND max_atomic BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND expires_at>created_at AND expires_at<=created_at+interval '1 day');
ALTER TABLE brainchain_signer_operations DROP CONSTRAINT IF EXISTS brainchain_operation_values;
ALTER TABLE brainchain_signer_operations ADD CONSTRAINT brainchain_operation_values CHECK(generation>0 AND authority_id<>gas_authority_id AND kind IN ('faucet','approve-stake','approve-bond','stake','apply','leave','withdraw','submit') AND request_hash ~ '^[a-f0-9]{64}$' AND idempotency_key ~ '^[a-zA-Z0-9_-]{1,96}$' AND state IN ('prepared','reserved','accepting','signed','broadcast','confirmed','uncertain','rejected') AND gas_limit>0 AND max_fee_per_gas>0 AND max_priority_fee_per_gas>=0 AND max_priority_fee_per_gas<=max_fee_per_gas AND (nonce IS NULL OR nonce BETWEEN 0 AND 18446744073709551615) AND expires_at>created_at);
CREATE OR REPLACE FUNCTION brainchain_assert_submit_result(rid uuid,aid uuid,bid uuid,task_number text,result_digest text,result_location text,observed_hash text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE evidence record;
BEGIN
 SELECT t.id INTO evidence FROM brainchain_worker_tasks t JOIN brainchain_task_results r ON r.task_id=t.id WHERE r.id=rid AND r.avatar_id=aid AND r.binding_id=bid FOR UPDATE OF t;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT a.lease_until,e.expires_at,t.deadline_unix INTO evidence
 FROM brainchain_task_results r JOIN brainchain_worker_tasks t ON t.id=r.task_id
 JOIN brainchain_task_attempts a ON a.id=r.attempt_id JOIN brainchain_execution_authorities e ON e.id=a.authority_id
 JOIN brainchain_worker_bindings w ON w.id=r.binding_id JOIN brainchain_compute_calls c ON c.id=r.call_id
 WHERE r.id=rid AND r.avatar_id=aid AND r.binding_id=bid AND r.environment='testnet' AND r.chain_id=274630 AND r.state='prepared'
 AND r.result_hash=result_digest AND r.result_uri=result_location AND t.task_id::text=task_number AND t.observed_block_hash=observed_hash
 AND t.canonical AND t.status=2 AND t.lease_generation=r.generation AND a.generation=r.generation AND a.lease_owner=r.lease_owner
 AND a.purpose='execution' AND a.state='executing' AND e.revoked_at IS NULL AND e.consumed_at IS NOT NULL
 AND w.requested_state IN ('running','draining') AND c.state='settled' AND c.output=r.result_text AND c.charged_micros IS NOT NULL
 FOR UPDATE OF r,a,e,w,c;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN evidence.lease_until>clock_timestamp() AND evidence.expires_at>clock_timestamp() AND evidence.deadline_unix>EXTRACT(EPOCH FROM clock_timestamp());
END $$;
