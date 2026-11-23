-- Expiry-only delivery authority. Existing results deliberately receive no inferred snapshot.
ALTER TABLE brainchain_task_results ADD COLUMN IF NOT EXISTS hire_snapshot jsonb;
ALTER TABLE brainchain_task_results ADD COLUMN IF NOT EXISTS hire_snapshot_hash varchar(64);
ALTER TABLE brainchain_task_results DROP CONSTRAINT IF EXISTS brainchain_result_hire_snapshot;
ALTER TABLE brainchain_task_results ADD CONSTRAINT brainchain_result_hire_snapshot CHECK
 ((hire_snapshot IS NULL AND hire_snapshot_hash IS NULL) OR (hire_snapshot IS NOT NULL AND hire_snapshot_hash IS NOT NULL AND jsonb_typeof(hire_snapshot)='object' AND hire_snapshot_hash ~ '^[a-f0-9]{64}$'));
CREATE TABLE IF NOT EXISTS brainchain_delivery_authorities(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),result_id uuid NOT NULL,binding_id uuid NOT NULL,avatar_id uuid NOT NULL,
 environment varchar(8) NOT NULL,chain_id integer NOT NULL,stage varchar(24) NOT NULL,task_generation integer NOT NULL,
 hire_snapshot_hash varchar(64) NOT NULL,result_hash varchar(66) NOT NULL,result_sha256 varchar(64) NOT NULL,
 operation_id uuid REFERENCES brainchain_signer_operations(id),transaction_hash varchar(66),nonce numeric(20,0),gas_ceiling numeric(78,0),
 approved_by varchar(128) NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_delivery_authority_owner FOREIGN KEY(result_id,binding_id,avatar_id,environment,chain_id) REFERENCES brainchain_task_results(id,binding_id,avatar_id,environment,chain_id),
 CONSTRAINT brainchain_delivery_authority_values CHECK(environment='testnet' AND chain_id=274630 AND task_generation>0 AND stage IN ('signature','upload','prepare-submit','broadcast','reconcile')
 AND hire_snapshot_hash ~ '^[a-f0-9]{64}$' AND result_hash ~ '^0x[a-f0-9]{64}$' AND result_sha256 ~ '^[a-f0-9]{64}$' AND length(approved_by)>0
 AND expires_at>created_at AND expires_at<=created_at+interval '10 minutes' AND (consumed_at IS NULL OR (consumed_at>=created_at AND consumed_at<expires_at))
 AND ((stage='broadcast' AND operation_id IS NOT NULL AND transaction_hash IS NOT NULL AND transaction_hash ~ '^0x[a-f0-9]{64}$' AND nonce IS NOT NULL AND nonce BETWEEN 0 AND 18446744073709551615 AND gas_ceiling IS NOT NULL AND gas_ceiling BETWEEN 1 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935)
 OR (stage<>'broadcast' AND operation_id IS NULL AND transaction_hash IS NULL AND nonce IS NULL AND gas_ceiling IS NULL)))
);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_delivery_authority_tuple ON brainchain_delivery_authorities(id,result_id,binding_id,avatar_id,environment,chain_id,stage,task_generation);
ALTER TABLE brainchain_delivery_authorities DROP CONSTRAINT IF EXISTS brainchain_delivery_numeric_bounds;
ALTER TABLE brainchain_delivery_authorities ADD CONSTRAINT brainchain_delivery_numeric_bounds CHECK((nonce IS NULL OR nonce BETWEEN 0 AND 18446744073709551615) AND (gas_ceiling IS NULL OR gas_ceiling BETWEEN 1 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935));
CREATE TABLE IF NOT EXISTS brainchain_delivery_leases(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),authority_id uuid NOT NULL UNIQUE,result_id uuid NOT NULL,binding_id uuid NOT NULL,avatar_id uuid NOT NULL,
 environment varchar(8) NOT NULL,chain_id integer NOT NULL,stage varchar(24) NOT NULL,task_generation integer NOT NULL,
 generation integer NOT NULL,lease_owner uuid NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_delivery_lease_authority FOREIGN KEY(authority_id,result_id,binding_id,avatar_id,environment,chain_id,stage,task_generation)
 REFERENCES brainchain_delivery_authorities(id,result_id,binding_id,avatar_id,environment,chain_id,stage,task_generation),
 CONSTRAINT brainchain_delivery_lease_values CHECK(environment='testnet' AND chain_id=274630 AND generation>0 AND expires_at>created_at AND expires_at<=created_at+interval '60 seconds'),
 UNIQUE(result_id,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_delivery_lease_result ON brainchain_delivery_leases(id,result_id);
CREATE TABLE IF NOT EXISTS brainchain_delivery_reconciliations(
 lease_id uuid PRIMARY KEY,result_id uuid NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(lease_id,result_id) REFERENCES brainchain_delivery_leases(id,result_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_submission_operation_result ON brainchain_result_submissions(operation_id,result_id);
CREATE TABLE IF NOT EXISTS brainchain_delivery_submit_leases(
 operation_id uuid PRIMARY KEY REFERENCES brainchain_signer_operations(id),lease_id uuid NOT NULL,result_id uuid NOT NULL,
 FOREIGN KEY(lease_id,result_id) REFERENCES brainchain_delivery_leases(id,result_id),
 FOREIGN KEY(operation_id,result_id) REFERENCES brainchain_result_submissions(operation_id,result_id)
);
CREATE OR REPLACE FUNCTION brainchain_delivery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'brainchain_delivery_is_immutable'; END IF;
 IF TG_TABLE_NAME='brainchain_delivery_authorities' THEN
  IF (to_jsonb(OLD)-'consumed_at'-'revoked_at') IS DISTINCT FROM (to_jsonb(NEW)-'consumed_at'-'revoked_at')
   OR (OLD.consumed_at IS NOT NULL AND OLD.consumed_at IS DISTINCT FROM NEW.consumed_at)
   OR (OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
  THEN RAISE EXCEPTION 'brainchain_delivery_is_immutable'; END IF;
 ELSE RAISE EXCEPTION 'brainchain_delivery_is_immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_delivery_authority_immutable ON brainchain_delivery_authorities;
CREATE TRIGGER brainchain_delivery_authority_immutable BEFORE UPDATE OR DELETE ON brainchain_delivery_authorities FOR EACH ROW EXECUTE FUNCTION brainchain_delivery_immutable();
DROP TRIGGER IF EXISTS brainchain_delivery_lease_immutable ON brainchain_delivery_leases;
CREATE TRIGGER brainchain_delivery_lease_immutable BEFORE UPDATE OR DELETE ON brainchain_delivery_leases FOR EACH ROW EXECUTE FUNCTION brainchain_delivery_immutable();
DROP TRIGGER IF EXISTS brainchain_delivery_reconciliation_immutable ON brainchain_delivery_reconciliations;
CREATE TRIGGER brainchain_delivery_reconciliation_immutable BEFORE UPDATE OR DELETE ON brainchain_delivery_reconciliations FOR EACH ROW EXECUTE FUNCTION brainchain_delivery_immutable();
DROP TRIGGER IF EXISTS brainchain_delivery_submit_immutable ON brainchain_delivery_submit_leases;
CREATE TRIGGER brainchain_delivery_submit_immutable BEFORE UPDATE OR DELETE ON brainchain_delivery_submit_leases FOR EACH ROW EXECUTE FUNCTION brainchain_delivery_immutable();
CREATE OR REPLACE FUNCTION brainchain_assert_recovery_submit(rid uuid,aid uuid,bid uuid,lid uuid,lease_actor uuid,task_number text,result_digest text,result_location text,observed_hash text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE evidence record;
BEGIN
 PERFORM t.id FROM brainchain_worker_tasks t JOIN brainchain_task_results r ON r.task_id=t.id WHERE r.id=rid AND r.avatar_id=aid AND r.binding_id=bid FOR UPDATE OF t;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT l.expires_at AS lease_until,d.expires_at,t.deadline_unix INTO evidence
 FROM brainchain_task_results r JOIN brainchain_worker_tasks t ON t.id=r.task_id JOIN brainchain_task_attempts a ON a.id=r.attempt_id
 JOIN brainchain_execution_authorities e ON e.id=a.authority_id JOIN brainchain_compute_calls c ON c.id=r.call_id
 JOIN brainchain_delivery_leases l ON l.result_id=r.id JOIN brainchain_delivery_authorities d ON d.id=l.authority_id
 JOIN brainchain_worker_bindings w ON w.id=r.binding_id JOIN brainchain_signer_streams s ON s.binding_id=r.binding_id
 WHERE r.id=rid AND r.avatar_id=aid AND r.binding_id=bid AND r.state='prepared' AND r.environment='testnet' AND r.chain_id=274630
 AND r.result_hash=result_digest AND r.result_uri=result_location AND t.task_id::text=task_number AND t.observed_block_hash=observed_hash
 AND t.canonical AND t.status=2 AND e.revoked_at IS NULL AND e.consumed_at IS NOT NULL AND a.state<>'suspended' AND c.state='settled' AND c.output=r.result_text AND c.charged_micros IS NOT NULL
 AND w.requested_state IN ('running','draining') AND NOT s.stopped AND l.id=lid AND l.lease_owner=lease_actor AND l.stage='prepare-submit'
 AND l.task_generation=t.lease_generation AND d.task_generation=t.lease_generation AND d.revoked_at IS NULL AND d.consumed_at IS NOT NULL
 AND d.hire_snapshot_hash=r.hire_snapshot_hash AND d.result_hash=r.result_hash AND d.result_sha256=r.result_sha256
 AND r.hire_snapshot->>'environment'='testnet' AND r.hire_snapshot->>'chainId'='274630' AND r.hire_snapshot->>'board'=t.board_address AND r.hire_snapshot->>'task'=t.task_id::text
 AND r.hire_snapshot->>'model'='0x'||repeat('0',24)||substring(w.address from 3) AND r.hire_snapshot->>'expectedPayee'=w.address
 AND r.hire_snapshot->>'briefHash'=t.brief_hash AND r.hire_snapshot->>'hireBlock'=t.hire_block::text AND r.hire_snapshot->>'hireBlockHash'=t.hire_block_hash
 AND r.hire_snapshot->>'hireTxHash'=t.hire_tx_hash AND r.hire_snapshot->>'hireLogIndex'=t.hire_log_index::text
 FOR UPDATE OF r,a,e,c,l,d,w,s;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN evidence.lease_until>clock_timestamp() AND evidence.expires_at>clock_timestamp() AND evidence.deadline_unix>EXTRACT(EPOCH FROM clock_timestamp());
END $$;
