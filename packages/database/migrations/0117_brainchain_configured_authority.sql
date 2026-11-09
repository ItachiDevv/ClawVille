-- Configured testnet authority evidence. Historical NULL pairs remain historical; no approved backfill.
ALTER TABLE brainchain_signer_authorities ADD COLUMN IF NOT EXISTS authority_policy_version varchar(64);
ALTER TABLE brainchain_signer_authorities ADD COLUMN IF NOT EXISTS authority_policy_digest varchar(64);
ALTER TABLE brainchain_signer_authorities DROP CONSTRAINT IF EXISTS brainchain_signer_authorities_configured_pair;
ALTER TABLE brainchain_signer_authorities ADD CONSTRAINT brainchain_signer_authorities_configured_pair CHECK ((authority_policy_version IS NULL AND authority_policy_digest IS NULL) OR (authority_policy_version IS NOT NULL AND authority_policy_digest IS NOT NULL AND authority_policy_version='brainchain-testnet-configured-authority-v1' AND authority_policy_digest='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6'));
ALTER TABLE brainchain_signer_operations ADD COLUMN IF NOT EXISTS authority_policy_version varchar(64);
ALTER TABLE brainchain_signer_operations ADD COLUMN IF NOT EXISTS authority_policy_digest varchar(64);
ALTER TABLE brainchain_signer_operations DROP CONSTRAINT IF EXISTS brainchain_signer_operations_configured_pair;
ALTER TABLE brainchain_signer_operations ADD CONSTRAINT brainchain_signer_operations_configured_pair CHECK ((authority_policy_version IS NULL AND authority_policy_digest IS NULL) OR (authority_policy_version IS NOT NULL AND authority_policy_digest IS NOT NULL AND authority_policy_version='brainchain-testnet-configured-authority-v1' AND authority_policy_digest='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6'));
ALTER TABLE brainchain_execution_authorities ADD COLUMN IF NOT EXISTS authority_policy_version varchar(64);
ALTER TABLE brainchain_execution_authorities ADD COLUMN IF NOT EXISTS authority_policy_digest varchar(64);
ALTER TABLE brainchain_execution_authorities DROP CONSTRAINT IF EXISTS brainchain_execution_authorities_configured_pair;
ALTER TABLE brainchain_execution_authorities ADD CONSTRAINT brainchain_execution_authorities_configured_pair CHECK ((authority_policy_version IS NULL AND authority_policy_digest IS NULL) OR (authority_policy_version IS NOT NULL AND authority_policy_digest IS NOT NULL AND authority_policy_version='brainchain-testnet-configured-authority-v1' AND authority_policy_digest='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6'));
ALTER TABLE brainchain_delivery_authorities ADD COLUMN IF NOT EXISTS authority_policy_version varchar(64);
ALTER TABLE brainchain_delivery_authorities ADD COLUMN IF NOT EXISTS authority_policy_digest varchar(64);
ALTER TABLE brainchain_delivery_authorities DROP CONSTRAINT IF EXISTS brainchain_delivery_authorities_configured_pair;
ALTER TABLE brainchain_delivery_authorities ADD CONSTRAINT brainchain_delivery_authorities_configured_pair CHECK ((authority_policy_version IS NULL AND authority_policy_digest IS NULL) OR (authority_policy_version IS NOT NULL AND authority_policy_digest IS NOT NULL AND authority_policy_version='brainchain-testnet-configured-authority-v1' AND authority_policy_digest='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6'));
ALTER TABLE brainchain_exact_capture_authorities ADD COLUMN IF NOT EXISTS authority_policy_version varchar(64);
ALTER TABLE brainchain_exact_capture_authorities ADD COLUMN IF NOT EXISTS authority_policy_digest varchar(64);
ALTER TABLE brainchain_exact_capture_authorities DROP CONSTRAINT IF EXISTS brainchain_exact_capture_authorities_configured_pair;
ALTER TABLE brainchain_exact_capture_authorities ADD CONSTRAINT brainchain_exact_capture_authorities_configured_pair CHECK ((authority_policy_version IS NULL AND authority_policy_digest IS NULL) OR (authority_policy_version IS NOT NULL AND authority_policy_digest IS NOT NULL AND authority_policy_version='brainchain-testnet-configured-authority-v1' AND authority_policy_digest='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6'));
CREATE OR REPLACE FUNCTION brainchain_configured_pair_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.authority_policy_version IS DISTINCT FROM OLD.authority_policy_version OR NEW.authority_policy_digest IS DISTINCT FROM OLD.authority_policy_digest THEN RAISE EXCEPTION 'brainchain_configured_policy_immutable'; END IF; RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS brainchain_configured_pair_immutable ON brainchain_signer_authorities;
CREATE TRIGGER brainchain_configured_pair_immutable BEFORE UPDATE ON brainchain_signer_authorities FOR EACH ROW EXECUTE FUNCTION brainchain_configured_pair_immutable();
DROP TRIGGER IF EXISTS brainchain_configured_pair_immutable ON brainchain_signer_operations;
CREATE TRIGGER brainchain_configured_pair_immutable BEFORE UPDATE ON brainchain_signer_operations FOR EACH ROW EXECUTE FUNCTION brainchain_configured_pair_immutable();
DROP TRIGGER IF EXISTS brainchain_configured_pair_immutable ON brainchain_execution_authorities;
CREATE TRIGGER brainchain_configured_pair_immutable BEFORE UPDATE ON brainchain_execution_authorities FOR EACH ROW EXECUTE FUNCTION brainchain_configured_pair_immutable();
DROP TRIGGER IF EXISTS brainchain_configured_pair_immutable ON brainchain_delivery_authorities;
CREATE TRIGGER brainchain_configured_pair_immutable BEFORE UPDATE ON brainchain_delivery_authorities FOR EACH ROW EXECUTE FUNCTION brainchain_configured_pair_immutable();
DROP TRIGGER IF EXISTS brainchain_configured_pair_immutable ON brainchain_exact_capture_authorities;
CREATE TRIGGER brainchain_configured_pair_immutable BEFORE UPDATE ON brainchain_exact_capture_authorities FOR EACH ROW EXECUTE FUNCTION brainchain_configured_pair_immutable();
CREATE OR REPLACE FUNCTION brainchain_configured_operation_link() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE intent record; gas record; BEGIN
 SELECT authority_policy_version,authority_policy_digest INTO intent FROM brainchain_signer_authorities WHERE id=NEW.authority_id;
 SELECT authority_policy_version,authority_policy_digest INTO gas FROM brainchain_signer_authorities WHERE id=NEW.gas_authority_id;
 IF NOT FOUND OR ROW(NEW.authority_policy_version,NEW.authority_policy_digest) IS DISTINCT FROM ROW(intent.authority_policy_version,intent.authority_policy_digest)
 OR ROW(NEW.authority_policy_version,NEW.authority_policy_digest) IS DISTINCT FROM ROW(gas.authority_policy_version,gas.authority_policy_digest)
 THEN RAISE EXCEPTION 'brainchain_configured_operation_link'; END IF;RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS brainchain_configured_operation_link ON brainchain_signer_operations;
CREATE TRIGGER brainchain_configured_operation_link BEFORE INSERT OR UPDATE ON brainchain_signer_operations FOR EACH ROW EXECUTE FUNCTION brainchain_configured_operation_link();

CREATE OR REPLACE FUNCTION brainchain_configured_delivery_link() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE origin record; consent jsonb; BEGIN
 IF NEW.authority_policy_version IS NULL THEN RETURN NEW; END IF;
 IF NEW.exact_consent_id IS NOT NULL THEN
  SELECT payload INTO consent FROM brainchain_exact_result_consents WHERE id=NEW.exact_consent_id AND result_id=NEW.result_id AND binding_id=NEW.binding_id AND avatar_id=NEW.avatar_id;
  IF NOT FOUND OR ROW(consent->>'authorityPolicyVersion',consent->>'authorityPolicyDigest') IS DISTINCT FROM ROW(NEW.authority_policy_version::text,NEW.authority_policy_digest::text) THEN RAISE EXCEPTION 'brainchain_configured_delivery_consent';END IF;
 ELSE
  SELECT a.authority_policy_version,a.authority_policy_digest INTO origin FROM brainchain_task_results r JOIN brainchain_task_attempts t ON t.id=r.attempt_id JOIN brainchain_execution_authorities a ON a.id=t.authority_id WHERE r.id=NEW.result_id;
  IF NOT FOUND OR ROW(origin.authority_policy_version,origin.authority_policy_digest) IS DISTINCT FROM ROW(NEW.authority_policy_version,NEW.authority_policy_digest) THEN RAISE EXCEPTION 'brainchain_configured_delivery_origin';END IF;
 END IF;RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS brainchain_configured_delivery_link ON brainchain_delivery_authorities;
CREATE TRIGGER brainchain_configured_delivery_link BEFORE INSERT ON brainchain_delivery_authorities FOR EACH ROW EXECUTE FUNCTION brainchain_configured_delivery_link();
CREATE OR REPLACE FUNCTION brainchain_configured_capture_link() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE consent jsonb;BEGIN
 IF NEW.authority_policy_version IS NULL THEN RETURN NEW; END IF;
 SELECT payload INTO consent FROM brainchain_exact_result_consents WHERE id=NEW.consent_id AND result_id=NEW.result_id AND binding_id=NEW.binding_id AND avatar_id=NEW.avatar_id;
 IF NOT FOUND OR ROW(consent->>'authorityPolicyVersion',consent->>'authorityPolicyDigest') IS DISTINCT FROM ROW(NEW.authority_policy_version::text,NEW.authority_policy_digest::text) THEN RAISE EXCEPTION 'brainchain_configured_capture_consent';END IF;RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS brainchain_configured_capture_link ON brainchain_exact_capture_authorities;
CREATE TRIGGER brainchain_configured_capture_link BEFORE INSERT ON brainchain_exact_capture_authorities FOR EACH ROW EXECUTE FUNCTION brainchain_configured_capture_link();

-- A historical operation can retain bytes; first acceptance needs current policy from its own grant
-- or the separate exact capture acceptance. The latter never rewrites original operation evidence.
CREATE OR REPLACE FUNCTION brainchain_configured_first_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.accepted_at IS NOT NULL AND (TG_OP='INSERT' OR OLD.accepted_at IS NULL) AND NEW.authority_policy_version IS NULL THEN
  IF TG_OP='INSERT' OR NOT EXISTS(SELECT 1 FROM brainchain_exact_capture_acceptances x JOIN brainchain_exact_capture_authorities a ON a.id=x.authority_id
    WHERE x.operation_id=NEW.id AND a.operation_id=NEW.id AND a.authority_policy_version='brainchain-testnet-configured-authority-v1'
    AND a.authority_policy_digest='21dab2c362d854e881f88785a7b3a23b7ac7e159ae179ded0cb22bda521ab9b6' AND a.expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'brainchain_configured_acceptance_required';END IF;
 END IF;RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS brainchain_configured_first_acceptance ON brainchain_signer_operations;
CREATE TRIGGER brainchain_configured_first_acceptance BEFORE INSERT OR UPDATE ON brainchain_signer_operations FOR EACH ROW EXECUTE FUNCTION brainchain_configured_first_acceptance();
