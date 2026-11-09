CREATE UNIQUE INDEX IF NOT EXISTS brainchain_attempt_delivery_owner ON brainchain_task_attempts(id,task_id,binding_id,avatar_id,environment,chain_id,generation,lease_owner,prompt_hash);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_compute_call_owner_tuple ON brainchain_compute_calls(id,task_id,attempt_id,avatar_id,generation,lease_owner,prompt_hash);
CREATE TABLE IF NOT EXISTS brainchain_task_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL,binding_id uuid NOT NULL,avatar_id uuid NOT NULL,
 environment varchar(8) NOT NULL,chain_id integer NOT NULL,attempt_id uuid NOT NULL,call_id uuid NOT NULL,
 generation integer NOT NULL,lease_owner uuid NOT NULL,prompt_hash varchar(64) NOT NULL,
 result_text text NOT NULL,result_sha256 varchar(64) NOT NULL,result_hash varchar(66) NOT NULL,
 state varchar(24) NOT NULL DEFAULT 'frozen',upload_token uuid,upload_started_at timestamptz,result_uri text,submission jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_result_task_owner FOREIGN KEY(task_id,binding_id,avatar_id,environment,chain_id) REFERENCES brainchain_worker_tasks(id,binding_id,avatar_id,environment,chain_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_result_attempt_owner FOREIGN KEY(attempt_id,task_id,binding_id,avatar_id,environment,chain_id,generation,lease_owner,prompt_hash)
 REFERENCES brainchain_task_attempts(id,task_id,binding_id,avatar_id,environment,chain_id,generation,lease_owner,prompt_hash) ON DELETE RESTRICT,
 CONSTRAINT brainchain_result_call_owner FOREIGN KEY(call_id,task_id,attempt_id,avatar_id,generation,lease_owner,prompt_hash)
 REFERENCES brainchain_compute_calls(id,task_id,attempt_id,avatar_id,generation,lease_owner,prompt_hash) ON DELETE RESTRICT,
 CONSTRAINT brainchain_result_values CHECK(environment='testnet' AND chain_id=274630 AND generation>0 AND octet_length(result_text) BETWEEN 1 AND 32768 AND result_sha256 ~ '^[a-f0-9]{64}$' AND result_hash ~ '^0x[a-f0-9]{64}$'),
 CONSTRAINT brainchain_result_lifecycle CHECK(
 (state='frozen' AND upload_token IS NULL AND upload_started_at IS NULL AND result_uri IS NULL AND submission IS NULL)
 OR (state IN ('uploading','upload_uncertain') AND upload_token IS NOT NULL AND upload_started_at IS NOT NULL AND result_uri IS NULL AND submission IS NULL)
 OR (state IN ('uploaded','prepared') AND upload_token IS NOT NULL AND upload_started_at IS NOT NULL AND result_uri IS NOT NULL
 AND result_uri=('https://brain.testnet.usebrainchain.com/records/'||result_hash||'.txt')
 AND ((state='uploaded' AND submission IS NULL) OR (state='prepared' AND submission IS NOT NULL))))
);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_result_task_once ON brainchain_task_results(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_result_attempt_once ON brainchain_task_results(attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_result_call_once ON brainchain_task_results(call_id);
CREATE OR REPLACE FUNCTION brainchain_result_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM brainchain_compute_calls c WHERE c.id=NEW.call_id AND c.state='settled' AND c.charged_micros IS NOT NULL AND c.output=NEW.result_text)
  THEN RAISE EXCEPTION 'brainchain_result_requires_settled_output'; END IF;
 ELSE
  IF (to_jsonb(OLD)-'state'-'upload_token'-'upload_started_at'-'result_uri'-'submission'-'updated_at') IS DISTINCT FROM
     (to_jsonb(NEW)-'state'-'upload_token'-'upload_started_at'-'result_uri'-'submission'-'updated_at')
   OR (OLD.upload_token IS NOT NULL AND OLD.upload_token IS DISTINCT FROM NEW.upload_token)
   OR (OLD.upload_started_at IS NOT NULL AND OLD.upload_started_at IS DISTINCT FROM NEW.upload_started_at)
   OR (OLD.result_uri IS NOT NULL AND OLD.result_uri IS DISTINCT FROM NEW.result_uri)
   OR (OLD.submission IS NOT NULL AND OLD.submission IS DISTINCT FROM NEW.submission)
   OR (OLD.state='frozen' AND NEW.state NOT IN ('frozen','uploading'))
   OR (OLD.state='uploading' AND NEW.state NOT IN ('uploading','upload_uncertain','uploaded'))
   OR (OLD.state='upload_uncertain' AND NEW.state NOT IN ('upload_uncertain','uploaded'))
   OR (OLD.state='uploaded' AND NEW.state NOT IN ('uploaded','prepared'))
   OR (OLD.state='prepared' AND NEW.state<>'prepared')
  THEN RAISE EXCEPTION 'brainchain_result_is_immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_result_immutable ON brainchain_task_results;
CREATE TRIGGER brainchain_result_immutable BEFORE INSERT OR UPDATE ON brainchain_task_results FOR EACH ROW EXECUTE FUNCTION brainchain_result_immutable();
