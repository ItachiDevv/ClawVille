-- Exact-result delivery is a separate authority. Original compute and liabilities remain immutable.
CREATE TABLE IF NOT EXISTS brainchain_recovery_owner_controls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),policy_id uuid NOT NULL REFERENCES brainchain_worker_policies(id),
 binding_id uuid NOT NULL,avatar_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),policy_revision integer NOT NULL,
 actor varchar(8) NOT NULL CHECK(actor IN ('human','agent')),action varchar(8) NOT NULL CHECK(action IN ('pause','revoke','narrow')),
 transaction_id bigint NOT NULL DEFAULT txid_current(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(policy_id,binding_id,avatar_id,user_id) REFERENCES brainchain_worker_policies(id,binding_id,avatar_id,user_id),
 UNIQUE(transaction_id,policy_id)
);
CREATE TABLE IF NOT EXISTS brainchain_recovery_owner_revocations (
 authority_id uuid NOT NULL,authority_kind varchar(12) NOT NULL CHECK(authority_kind IN ('execution','signer','delivery')),
 control_id uuid NOT NULL REFERENCES brainchain_recovery_owner_controls(id),revoked_at timestamptz NOT NULL,
 PRIMARY KEY(authority_kind,authority_id)
);
CREATE OR REPLACE FUNCTION brainchain_record_owner_recovery_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE control uuid; revocation_kind text;
BEGIN
 IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RETURN NEW; END IF;
 revocation_kind:=CASE TG_TABLE_NAME WHEN 'brainchain_execution_authorities' THEN 'execution' WHEN 'brainchain_signer_authorities' THEN 'signer' ELSE 'delivery' END;
 SELECT c.id INTO control FROM brainchain_recovery_owner_controls c JOIN brainchain_worker_policy_issuances i ON i.policy_id=c.policy_id
 WHERE c.transaction_id=txid_current() AND c.binding_id=NEW.binding_id AND c.avatar_id=NEW.avatar_id
 AND ((revocation_kind='execution' AND i.execution_authority_id=NEW.id) OR (revocation_kind='signer' AND (i.signer_authority_id=NEW.id OR i.gas_authority_id=NEW.id)) OR (revocation_kind='delivery' AND i.delivery_authority_id=NEW.id));
 IF control IS NOT NULL THEN INSERT INTO brainchain_recovery_owner_revocations(authority_id,authority_kind,control_id,revoked_at) VALUES(NEW.id,revocation_kind,control,NEW.revoked_at); END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['brainchain_execution_authorities','brainchain_signer_authorities','brainchain_delivery_authorities'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS brainchain_owner_recovery_revocation ON %I',tab);
 EXECUTE format('CREATE TRIGGER brainchain_owner_recovery_revocation AFTER UPDATE OF revoked_at ON %I FOR EACH ROW EXECUTE FUNCTION brainchain_record_owner_recovery_revocation()',tab);
END LOOP; END $$;

-- Exact owner consent is checked inside the same signer transaction. Legacy leases retain the old function.
CREATE OR REPLACE FUNCTION brainchain_exact_recovery_consent(cid uuid,rid uuid,aid uuid,bid uuid,wanted_stage text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE found_consent record;
BEGIN
 SELECT c.id,c.expires_at,s.expires_at AS session_until,t.deadline_unix INTO found_consent
 FROM brainchain_exact_result_consents c JOIN brainchain_task_results r ON r.id=c.result_id
 JOIN brainchain_worker_tasks t ON t.id=r.task_id JOIN brainchain_task_attempts a ON a.id=r.attempt_id
 JOIN brainchain_execution_authorities e ON e.id=a.authority_id JOIN brainchain_compute_calls calls ON calls.id=r.call_id
 JOIN brainchain_worker_bindings w ON w.id=r.binding_id JOIN brainchain_signer_streams stream ON stream.binding_id=w.id
 JOIN users u ON u.id=c.user_id JOIN avatars avatar ON avatar.id=c.avatar_id
 JOIN brainchain_exact_result_challenges p ON p.nonce_hash=c.approval_nonce AND p.consent_id=c.id JOIN sessions s ON s.id=p.session_id
 LEFT JOIN brainchain_recovery_owner_revocations rev ON rev.authority_kind='execution' AND rev.authority_id=e.id AND rev.revoked_at=e.revoked_at
 WHERE c.id=cid AND c.result_id=rid AND c.avatar_id=aid AND c.binding_id=bid AND c.state='approved' AND c.revoked_at IS NULL
 AND c.payload->'stages' ? wanted_stage AND c.wallet=u.linked_wallet_pubkey AND c.wallet_version=u.linked_wallet_authority_version
 AND p.wallet=c.wallet AND p.wallet_version=c.wallet_version AND p.consumed_at IS NOT NULL
 AND s.user_id=u.id AND s.created_via IN ('password','magic_link','avatar_create') AND avatar.user_id=u.id AND NOT avatar.is_guest AND NOT u.is_guest
 AND r.environment='testnet' AND r.chain_id=274630 AND t.canonical AND NOT stream.stopped
 AND e.consumed_at IS NOT NULL AND calls.state='settled' AND calls.output=r.result_text AND calls.charged_micros IS NOT NULL AND a.state<>'suspended'
 AND c.payload->>'avatarId'=aid::text AND c.payload->>'workerId'=bid::text AND c.payload->>'resultId'=rid::text
 AND c.payload->>'taskId'=t.id::text AND c.payload->>'attemptId'=a.id::text AND c.payload->>'callId'=calls.id::text
 AND c.payload->>'executionAuthorityId'=e.id::text AND c.payload->>'resultGeneration'=r.generation::text
 AND c.payload->>'taskGeneration'=t.lease_generation::text AND c.payload->>'signerGeneration'=stream.generation::text
 AND c.payload->>'walletVersion'=u.linked_wallet_authority_version::text
 AND c.payload->>'resultHash'=r.result_hash AND c.payload->>'resultSha256'=r.result_sha256 AND c.payload->>'hireSnapshotHash'=r.hire_snapshot_hash
 AND (e.revoked_at IS NULL AND c.payload->>'executionRevokedAt' IS NULL OR
      e.revoked_at IS NOT NULL AND rev.control_id::text=c.payload->'provenance'->>'controlId')
 AND r.hire_snapshot->>'environment'='testnet' AND r.hire_snapshot->>'chainId'='274630' AND r.hire_snapshot->>'board'=t.board_address
 AND r.hire_snapshot->>'task'=t.task_id::text AND r.hire_snapshot->>'model'='0x'||repeat('0',24)||substring(w.address from 3)
 AND r.hire_snapshot->>'expectedPayee'=w.address AND r.hire_snapshot->>'briefHash'=t.brief_hash AND r.hire_snapshot->>'hireBlock'=t.hire_block::text
 AND r.hire_snapshot->>'hireBlockHash'=t.hire_block_hash AND r.hire_snapshot->>'hireTxHash'=t.hire_tx_hash AND r.hire_snapshot->>'hireLogIndex'=t.hire_log_index::text
 FOR UPDATE OF c,r,t,a,e,calls,w,stream,u,avatar,p,s;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF found_consent.expires_at<=clock_timestamp() OR found_consent.session_until<=clock_timestamp() OR found_consent.deadline_unix<=EXTRACT(EPOCH FROM clock_timestamp()) THEN RETURN NULL; END IF;
 RETURN found_consent.id;
END $$;
DO $$ BEGIN
 IF to_regprocedure('brainchain_assert_legacy_recovery_submit(uuid,uuid,uuid,uuid,uuid,text,text,text,text)') IS NULL THEN
 ALTER FUNCTION brainchain_assert_recovery_submit(uuid,uuid,uuid,uuid,uuid,text,text,text,text) RENAME TO brainchain_assert_legacy_recovery_submit;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION brainchain_assert_recovery_submit(rid uuid,aid uuid,bid uuid,lid uuid,lease_actor uuid,task_number text,result_digest text,result_location text,observed_hash text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE proof record;
BEGIN
 SELECT d.exact_consent_id,d.id AS authority_id,d.expires_at,l.expires_at AS lease_until,l.stage,d.observation_policy INTO proof
 FROM brainchain_delivery_leases l JOIN brainchain_delivery_authorities d ON d.id=l.authority_id
 WHERE l.id=lid AND l.lease_owner=lease_actor AND l.avatar_id=aid AND l.binding_id=bid AND l.result_id=rid
 AND d.revoked_at IS NULL AND d.consumed_at IS NOT NULL FOR UPDATE OF l,d;
 IF NOT FOUND THEN RETURN false; END IF;
 IF proof.exact_consent_id IS NULL THEN RETURN brainchain_assert_legacy_recovery_submit(rid,aid,bid,lid,lease_actor,task_number,result_digest,result_location,observed_hash); END IF;
 IF proof.stage<>'prepare-submit' OR brainchain_exact_recovery_consent(proof.exact_consent_id,rid,aid,bid,'prepare-submit') IS NULL THEN RETURN false; END IF;
 PERFORM 1 FROM brainchain_task_results r JOIN brainchain_worker_tasks t ON t.id=r.task_id
 JOIN brainchain_exact_result_consents c ON c.id=proof.exact_consent_id JOIN brainchain_exact_result_issuances i ON i.consent_id=c.id
 WHERE r.id=rid AND r.state='prepared' AND r.result_hash=result_digest AND r.result_uri=result_location
 AND t.status=2 AND t.task_id::text=task_number AND t.observed_block_hash=observed_hash
 AND i.stage='prepare-submit' AND i.delivery_authority_id=proof.authority_id AND c.payload->>'observationPolicy'=proof.observation_policy;
 RETURN FOUND AND proof.expires_at>clock_timestamp() AND proof.lease_until>clock_timestamp();
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS brainchain_result_exact_owner ON brainchain_task_results(id,binding_id,avatar_id);
CREATE TABLE IF NOT EXISTS brainchain_exact_result_consents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),binding_id uuid NOT NULL,avatar_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),result_id uuid NOT NULL,
 payload jsonb NOT NULL,payload_hash varchar(64) NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 state varchar(12) NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','approved','revoked')),
 approval_nonce varchar(64),wallet varchar(44),wallet_version bigint,approved_at timestamptz,revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 FOREIGN KEY(result_id,binding_id,avatar_id) REFERENCES brainchain_task_results(id,binding_id,avatar_id),
 CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8192 AND expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
 CHECK(state<>'approved' OR (approval_nonce IS NOT NULL AND wallet IS NOT NULL AND wallet_version IS NOT NULL AND approved_at IS NOT NULL)),
 UNIQUE(id,result_id,binding_id,avatar_id)
);
CREATE TABLE IF NOT EXISTS brainchain_exact_result_challenges (
 nonce_hash varchar(64) PRIMARY KEY CHECK(nonce_hash ~ '^[a-f0-9]{64}$'),consent_id uuid NOT NULL REFERENCES brainchain_exact_result_consents(id),
 session_id varchar(255) NOT NULL,wallet varchar(44) NOT NULL,wallet_version bigint NOT NULL,message text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '2 minutes')
);
ALTER TABLE brainchain_delivery_authorities ADD COLUMN IF NOT EXISTS exact_consent_id uuid REFERENCES brainchain_exact_result_consents(id);
ALTER TABLE brainchain_delivery_authorities ADD COLUMN IF NOT EXISTS observation_policy varchar(40) NOT NULL DEFAULT 'legacy-depth12-age120-v1';
ALTER TABLE brainchain_delivery_authorities DROP CONSTRAINT IF EXISTS brainchain_delivery_observation_policy;
ALTER TABLE brainchain_delivery_authorities ADD CONSTRAINT brainchain_delivery_observation_policy CHECK(observation_policy IN ('legacy-depth12-age120-v1','nitro-testnet-latest-v1') AND (exact_consent_id IS NOT NULL OR observation_policy='legacy-depth12-age120-v1'));
CREATE TABLE IF NOT EXISTS brainchain_exact_result_issuances (
 consent_id uuid NOT NULL REFERENCES brainchain_exact_result_consents(id),stage varchar(24) NOT NULL,
 delivery_authority_id uuid NOT NULL UNIQUE REFERENCES brainchain_delivery_authorities(id),
 signer_authority_id uuid REFERENCES brainchain_signer_authorities(id),gas_authority_id uuid REFERENCES brainchain_signer_authorities(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(consent_id,stage),
 CHECK(stage IN ('signature','upload','prepare-submit','broadcast','reconcile'))
);
CREATE OR REPLACE FUNCTION brainchain_exact_recovery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'exact_recovery_retained'; END IF;
 IF TG_TABLE_NAME='brainchain_exact_result_consents' THEN
  IF (to_jsonb(NEW)-ARRAY['state','approval_nonce','wallet','wallet_version','approved_at','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','approval_nonce','wallet','wallet_version','approved_at','revoked_at'])
   OR OLD.state='revoked' OR (OLD.state='approved' AND (NEW.state<>'revoked' OR NEW.approval_nonce IS DISTINCT FROM OLD.approval_nonce OR NEW.wallet IS DISTINCT FROM OLD.wallet OR NEW.wallet_version IS DISTINCT FROM OLD.wallet_version OR NEW.approved_at IS DISTINCT FROM OLD.approved_at))
   OR (NEW.state='approved' AND OLD.state<>'requested') THEN RAISE EXCEPTION 'exact_recovery_consent_immutable'; END IF;
 ELSIF TG_TABLE_NAME='brainchain_exact_result_challenges' THEN
  IF (to_jsonb(NEW)-ARRAY['attempts','consumed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['attempts','consumed_at']) OR NEW.attempts<OLD.attempts OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN RAISE EXCEPTION 'exact_recovery_proof_immutable'; END IF;
 ELSE RAISE EXCEPTION 'exact_recovery_retained'; END IF; RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['brainchain_recovery_owner_controls','brainchain_recovery_owner_revocations','brainchain_exact_result_consents','brainchain_exact_result_challenges','brainchain_exact_result_issuances'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS brainchain_exact_recovery_immutable ON %I',tab);
 EXECUTE format('CREATE TRIGGER brainchain_exact_recovery_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION brainchain_exact_recovery_immutable()',tab);
END LOOP; END $$;

ALTER TABLE brainchain_exact_result_issuances DROP CONSTRAINT IF EXISTS brainchain_exact_result_issuances_stage_check;
ALTER TABLE brainchain_exact_result_issuances ADD CONSTRAINT brainchain_exact_result_issuances_stage_check CHECK(stage IN ('signature','upload','prepare-submit','broadcast','reconcile'));
