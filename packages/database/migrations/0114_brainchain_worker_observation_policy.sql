-- Worker-only provisional response freshness. No finality or liability-release authority.
ALTER TABLE brainchain_execution_authorities ADD COLUMN IF NOT EXISTS observation_policy varchar(40) NOT NULL DEFAULT 'legacy-depth12-age120-v1';
ALTER TABLE brainchain_signer_authorities ADD COLUMN IF NOT EXISTS observation_policy varchar(40) NOT NULL DEFAULT 'legacy-depth12-age120-v1';
ALTER TABLE brainchain_signer_operations ADD COLUMN IF NOT EXISTS observation_policy varchar(40) NOT NULL DEFAULT 'legacy-depth12-age120-v1';
DO $$DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['brainchain_execution_authorities','brainchain_signer_authorities','brainchain_signer_operations'] LOOP
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',table_name,table_name||'_observation_policy');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(observation_policy IN (''legacy-depth12-age120-v1'',''nitro-testnet-latest-v1''))',table_name,table_name||'_observation_policy');
 END LOOP;
END$$;
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_signer_observation_owner ON brainchain_signer_authorities(id,observation_policy);
ALTER TABLE brainchain_signer_operations DROP CONSTRAINT IF EXISTS brainchain_operation_observation_intent;
ALTER TABLE brainchain_signer_operations ADD CONSTRAINT brainchain_operation_observation_intent FOREIGN KEY(authority_id,observation_policy) REFERENCES brainchain_signer_authorities(id,observation_policy);
ALTER TABLE brainchain_signer_operations DROP CONSTRAINT IF EXISTS brainchain_operation_observation_gas;
ALTER TABLE brainchain_signer_operations ADD CONSTRAINT brainchain_operation_observation_gas FOREIGN KEY(gas_authority_id,observation_policy) REFERENCES brainchain_signer_authorities(id,observation_policy);
CREATE OR REPLACE FUNCTION brainchain_worker_observation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.observation_policy IS DISTINCT FROM OLD.observation_policy THEN RAISE EXCEPTION 'brainchain_observation_policy_immutable';END IF;RETURN NEW;
END$$;
DO $$DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['brainchain_execution_authorities','brainchain_signer_authorities','brainchain_signer_operations'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS brainchain_worker_observation_immutable ON %I',table_name);
  EXECUTE format('CREATE TRIGGER brainchain_worker_observation_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION brainchain_worker_observation_immutable()',table_name);
 END LOOP;
END$$;
