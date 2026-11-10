-- Owner wallet grants are separate from worker address ownership and provider root budgets.
CREATE TABLE IF NOT EXISTS brainchain_worker_policy_budgets (
 binding_id uuid PRIMARY KEY REFERENCES brainchain_worker_bindings(id) ON DELETE RESTRICT,
 avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE RESTRICT,
 environment varchar(8) NOT NULL DEFAULT 'testnet',chain_id integer NOT NULL DEFAULT 274630,
 gas_committed numeric(78,0) NOT NULL DEFAULT 0, brain_committed numeric(78,0) NOT NULL DEFAULT 0,
 openai_committed bigint NOT NULL DEFAULT 0, openrouter_committed bigint NOT NULL DEFAULT 0,
 tasks_committed integer NOT NULL DEFAULT 0,
 CONSTRAINT brainchain_policy_budget_owner FOREIGN KEY(binding_id,avatar_id,environment,chain_id) REFERENCES brainchain_worker_bindings(id,avatar_id,environment,chain_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_policy_budget_bounds CHECK(environment='testnet' AND chain_id=274630 AND gas_committed>=0 AND gas_committed<2::numeric^256 AND brain_committed>=0 AND brain_committed<2::numeric^256 AND openai_committed BETWEEN 0 AND 10000000 AND openrouter_committed BETWEEN 0 AND 10000000 AND tasks_committed>=0)
);
CREATE TABLE IF NOT EXISTS brainchain_worker_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),binding_id uuid NOT NULL,avatar_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 environment varchar(8) NOT NULL DEFAULT 'testnet',chain_id integer NOT NULL DEFAULT 274630,
 revision integer NOT NULL,payload jsonb NOT NULL,payload_hash varchar(64) NOT NULL,state varchar(12) NOT NULL DEFAULT 'requested',
 owner_grant_id varchar(64),approved_at timestamptz,revoked_at timestamptz,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_worker_policy_owner FOREIGN KEY(binding_id,avatar_id,environment,chain_id) REFERENCES brainchain_worker_bindings(id,avatar_id,environment,chain_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_worker_policy_revision UNIQUE(binding_id,revision),
 CONSTRAINT brainchain_worker_policy_tuple UNIQUE(id,binding_id,avatar_id),
 CONSTRAINT brainchain_worker_policy_user_tuple UNIQUE(id,binding_id,avatar_id,user_id),
 CONSTRAINT brainchain_worker_policy_bounds CHECK(environment='testnet' AND chain_id=274630 AND revision>0 AND payload_hash~'^[a-f0-9]{64}$' AND jsonb_typeof(payload)='object'
  AND state IN ('requested','active','paused','revoked') AND expires_at>created_at AND expires_at<=created_at+interval '1 day'
  AND (state<>'active' OR (owner_grant_id IS NOT NULL AND approved_at IS NOT NULL)))
);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_worker_policy_one_active ON brainchain_worker_policies(binding_id) WHERE state='active';
CREATE TABLE IF NOT EXISTS brainchain_worker_policy_challenges (
 nonce_hash varchar(64) PRIMARY KEY,policy_id uuid NOT NULL,binding_id uuid NOT NULL,avatar_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 wallet varchar(44) NOT NULL,domain varchar(80) NOT NULL,message text NOT NULL,message_hash varchar(64) NOT NULL,attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,consumed_at timestamptz,
 CONSTRAINT brainchain_worker_policy_challenge_owner FOREIGN KEY(policy_id,binding_id,avatar_id,user_id) REFERENCES brainchain_worker_policies(id,binding_id,avatar_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_worker_policy_challenge_tuple UNIQUE(nonce_hash,binding_id,avatar_id,user_id),
 CONSTRAINT brainchain_worker_policy_challenge_bounds CHECK(nonce_hash~'^[a-f0-9]{64}$' AND message_hash~'^[a-f0-9]{64}$' AND attempts BETWEEN 0 AND 5 AND expires_at>created_at AND expires_at<=created_at+interval '2 minutes' AND (consumed_at IS NULL OR (consumed_at>=created_at AND consumed_at<expires_at)))
);
DO $$BEGIN ALTER TABLE brainchain_worker_policies ADD CONSTRAINT brainchain_worker_policy_owner_proof FOREIGN KEY(owner_grant_id) REFERENCES brainchain_worker_policy_challenges(nonce_hash) ON DELETE RESTRICT;EXCEPTION WHEN duplicate_object THEN NULL;END$$;
DO $$BEGIN ALTER TABLE brainchain_worker_policies ADD CONSTRAINT brainchain_worker_policy_owner_proof_scope FOREIGN KEY(owner_grant_id,binding_id,avatar_id,user_id) REFERENCES brainchain_worker_policy_challenges(nonce_hash,binding_id,avatar_id,user_id) ON DELETE RESTRICT;EXCEPTION WHEN duplicate_object THEN NULL;END$$;
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_signer_policy_owner ON brainchain_signer_authorities(id,binding_id,avatar_id);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_execution_policy_owner ON brainchain_execution_authorities(id,binding_id,avatar_id);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_delivery_policy_owner ON brainchain_delivery_authorities(id,binding_id,avatar_id);
CREATE TABLE IF NOT EXISTS brainchain_worker_policy_issuances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),policy_id uuid NOT NULL,binding_id uuid NOT NULL,avatar_id uuid NOT NULL,action_key varchar(128) NOT NULL,
 kind varchar(24) NOT NULL,request_hash varchar(64) NOT NULL,assignment_hash varchar(64),evidence jsonb NOT NULL,
 signer_authority_id uuid REFERENCES brainchain_signer_authorities(id) ON DELETE RESTRICT,gas_authority_id uuid REFERENCES brainchain_signer_authorities(id) ON DELETE RESTRICT,
 execution_authority_id uuid REFERENCES brainchain_execution_authorities(id) ON DELETE RESTRICT,delivery_authority_id uuid REFERENCES brainchain_delivery_authorities(id) ON DELETE RESTRICT,
 gas_reserved numeric(78,0) NOT NULL DEFAULT 0,brain_reserved numeric(78,0) NOT NULL DEFAULT 0,compute_reserved bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_worker_policy_issue_owner FOREIGN KEY(policy_id,binding_id,avatar_id) REFERENCES brainchain_worker_policies(id,binding_id,avatar_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_policy_signer_owner FOREIGN KEY(signer_authority_id,binding_id,avatar_id) REFERENCES brainchain_signer_authorities(id,binding_id,avatar_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_policy_gas_owner FOREIGN KEY(gas_authority_id,binding_id,avatar_id) REFERENCES brainchain_signer_authorities(id,binding_id,avatar_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_policy_execution_owner FOREIGN KEY(execution_authority_id,binding_id,avatar_id) REFERENCES brainchain_execution_authorities(id,binding_id,avatar_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_policy_delivery_owner FOREIGN KEY(delivery_authority_id,binding_id,avatar_id) REFERENCES brainchain_delivery_authorities(id,binding_id,avatar_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_policy_issue_kind CHECK(
  (kind IN ('faucet','approve-stake','approve-bond','stake','apply','submit','leave','withdraw') AND signer_authority_id IS NOT NULL AND gas_authority_id IS NOT NULL AND execution_authority_id IS NULL AND delivery_authority_id IS NULL AND assignment_hash IS NULL AND compute_reserved=0)
  OR (kind='result-signature' AND signer_authority_id IS NOT NULL AND gas_authority_id IS NULL AND execution_authority_id IS NULL AND delivery_authority_id IS NULL AND assignment_hash IS NULL AND gas_reserved=0 AND brain_reserved=0 AND compute_reserved=0)
  OR (kind='execution' AND signer_authority_id IS NULL AND gas_authority_id IS NULL AND execution_authority_id IS NOT NULL AND delivery_authority_id IS NULL AND assignment_hash IS NOT NULL AND gas_reserved=0 AND brain_reserved=0 AND compute_reserved>0)
  OR (kind='delivery' AND signer_authority_id IS NULL AND gas_authority_id IS NULL AND execution_authority_id IS NULL AND delivery_authority_id IS NOT NULL AND assignment_hash IS NULL AND gas_reserved=0 AND brain_reserved=0 AND compute_reserved=0)),
 CONSTRAINT brainchain_worker_policy_issue_key UNIQUE(binding_id,action_key),
 CONSTRAINT brainchain_worker_policy_issue_bounds CHECK(request_hash~'^[a-f0-9]{64}$' AND (assignment_hash IS NULL OR assignment_hash~'^[a-f0-9]{64}$') AND gas_reserved>=0 AND gas_reserved<2::numeric^256 AND brain_reserved>=0 AND brain_reserved<2::numeric^256 AND compute_reserved BETWEEN 0 AND 10000000 AND jsonb_typeof(evidence)='object')
);
CREATE OR REPLACE FUNCTION brainchain_worker_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'brainchain_worker_policy_retained'; END IF;
 IF TG_TABLE_NAME='brainchain_worker_policies' THEN
  IF (to_jsonb(NEW)-ARRAY['state','owner_grant_id','approved_at','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','owner_grant_id','approved_at','revoked_at']) OR OLD.state='revoked' THEN RAISE EXCEPTION 'brainchain_worker_policy_immutable'; END IF;
 ELSIF TG_TABLE_NAME='brainchain_worker_policy_challenges' THEN
  IF (to_jsonb(NEW)-ARRAY['attempts','consumed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['attempts','consumed_at']) OR NEW.attempts<OLD.attempts OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN RAISE EXCEPTION 'brainchain_worker_policy_proof_immutable'; END IF;
 ELSIF TG_TABLE_NAME='brainchain_worker_policy_budgets' THEN
  IF NEW.binding_id<>OLD.binding_id OR NEW.avatar_id<>OLD.avatar_id OR NEW.gas_committed<OLD.gas_committed OR NEW.brain_committed<OLD.brain_committed OR NEW.openai_committed<OLD.openai_committed OR NEW.openrouter_committed<OLD.openrouter_committed OR NEW.tasks_committed<OLD.tasks_committed THEN RAISE EXCEPTION 'brainchain_worker_policy_liability_retained'; END IF;
 ELSE RAISE EXCEPTION 'brainchain_worker_policy_issuance_immutable'; END IF;RETURN NEW;
END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['brainchain_worker_policies','brainchain_worker_policy_challenges','brainchain_worker_policy_budgets','brainchain_worker_policy_issuances'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS brainchain_worker_policy_immutable ON %I',t);
 EXECUTE format('CREATE TRIGGER brainchain_worker_policy_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION brainchain_worker_policy_immutable()',t);
END LOOP;END$$;
CREATE OR REPLACE FUNCTION brainchain_worker_policy_revoke_issued() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.state IN ('paused','revoked') THEN
  UPDATE brainchain_signer_authorities SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL AND id IN (SELECT signer_authority_id FROM brainchain_worker_policy_issuances WHERE policy_id=NEW.id UNION SELECT gas_authority_id FROM brainchain_worker_policy_issuances WHERE policy_id=NEW.id);
  UPDATE brainchain_execution_authorities SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL AND id IN (SELECT execution_authority_id FROM brainchain_worker_policy_issuances WHERE policy_id=NEW.id);
  UPDATE brainchain_delivery_authorities SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL AND id IN (SELECT delivery_authority_id FROM brainchain_worker_policy_issuances WHERE policy_id=NEW.id);
 END IF;RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS brainchain_worker_policy_revoke_issued ON brainchain_worker_policies;
CREATE TRIGGER brainchain_worker_policy_revoke_issued AFTER UPDATE OF state ON brainchain_worker_policies FOR EACH ROW EXECUTE FUNCTION brainchain_worker_policy_revoke_issued();
CREATE OR REPLACE FUNCTION brainchain_worker_policy_wallet_rotation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.linked_wallet_pubkey IS DISTINCT FROM OLD.linked_wallet_pubkey OR (to_jsonb(NEW)->'linked_wallet_at') IS DISTINCT FROM (to_jsonb(OLD)->'linked_wallet_at') THEN UPDATE brainchain_worker_policies SET state='revoked',revoked_at=clock_timestamp() WHERE user_id=NEW.id AND state<>'revoked'; END IF;RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS brainchain_worker_policy_wallet_rotation ON users;
CREATE TRIGGER brainchain_worker_policy_wallet_rotation AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION brainchain_worker_policy_wallet_rotation();

-- Scheduler leases never extend previously issued authority. Pending plans survive host failure.
CREATE TABLE IF NOT EXISTS brainchain_worker_jobs (
 binding_id uuid PRIMARY KEY,avatar_id uuid NOT NULL,policy_id uuid NOT NULL,
 generation integer NOT NULL,lease_owner uuid NOT NULL,claimed_at timestamptz NOT NULL,lease_until timestamptz NOT NULL,
 pending_plan jsonb,last_state varchar(96),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_worker_job_policy FOREIGN KEY(policy_id,binding_id,avatar_id) REFERENCES brainchain_worker_policies(id,binding_id,avatar_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_worker_job_bounds CHECK(generation>0 AND lease_until>claimed_at AND lease_until<=claimed_at+interval '60 seconds' AND (pending_plan IS NULL OR (jsonb_typeof(pending_plan)='object' AND octet_length(pending_plan::text)<=32768)))
);
CREATE OR REPLACE FUNCTION brainchain_worker_job_fence() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'brainchain_worker_job_retained';END IF;
 IF NEW.binding_id<>OLD.binding_id OR NEW.avatar_id<>OLD.avatar_id OR NEW.generation<OLD.generation THEN RAISE EXCEPTION 'brainchain_worker_job_fence';END IF;
 IF NEW.generation=OLD.generation THEN
  IF NEW.policy_id<>OLD.policy_id OR NEW.lease_owner<>OLD.lease_owner OR NEW.claimed_at<>OLD.claimed_at OR NEW.lease_until<>OLD.lease_until OR (OLD.pending_plan IS NOT NULL AND NEW.pending_plan IS NOT NULL AND OLD.pending_plan IS DISTINCT FROM NEW.pending_plan) THEN RAISE EXCEPTION 'brainchain_worker_job_immutable';END IF;
 ELSE
  IF NEW.generation<>OLD.generation+1 OR OLD.lease_until>clock_timestamp() OR NEW.pending_plan IS DISTINCT FROM OLD.pending_plan THEN RAISE EXCEPTION 'brainchain_worker_job_takeover';END IF;
 END IF;RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS brainchain_worker_job_fence ON brainchain_worker_jobs;
CREATE TRIGGER brainchain_worker_job_fence BEFORE UPDATE OR DELETE ON brainchain_worker_jobs FOR EACH ROW EXECUTE FUNCTION brainchain_worker_job_fence();

CREATE UNIQUE INDEX IF NOT EXISTS brainchain_operation_receipt_owner ON brainchain_signer_operations(id,generation,transaction_hash);
CREATE TABLE IF NOT EXISTS brainchain_signer_receipt_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),operation_id uuid NOT NULL,generation integer NOT NULL,transaction_hash varchar(66) NOT NULL,
 evidence_hash varchar(64) NOT NULL,evidence jsonb NOT NULL,state varchar(12) NOT NULL,observed_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_signer_receipt_owner FOREIGN KEY(operation_id,generation,transaction_hash) REFERENCES brainchain_signer_operations(id,generation,transaction_hash) ON DELETE RESTRICT,
 CONSTRAINT brainchain_signer_receipt_once UNIQUE(operation_id,evidence_hash),
 CONSTRAINT brainchain_signer_receipt_bounds CHECK(generation>0 AND transaction_hash~'^0x[a-f0-9]{64}$' AND evidence_hash~'^[a-f0-9]{64}$' AND state IN ('pending','orphaned','included') AND jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=8192)
);
CREATE OR REPLACE FUNCTION brainchain_signer_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'brainchain_signer_receipt_retained';END$$;
DROP TRIGGER IF EXISTS brainchain_signer_receipt_immutable ON brainchain_signer_receipt_observations;
CREATE TRIGGER brainchain_signer_receipt_immutable BEFORE UPDATE OR DELETE ON brainchain_signer_receipt_observations FOR EACH ROW EXECUTE FUNCTION brainchain_signer_receipt_immutable();
