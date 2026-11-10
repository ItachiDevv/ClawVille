-- Additive, idempotent Own AI part B. migrate-ci discovers SQL by filename; no Drizzle journal.
ALTER TABLE agent_ai_settings ADD COLUMN IF NOT EXISTS usepod_deposit_code text;
ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS signed_tx_b64 text;
ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS last_valid_block_height bigint;
ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS fee_lamports bigint;
ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS credit_status varchar(16);
ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS deposit_terms jsonb;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_ai_settings_deposit_code_check') THEN
  ALTER TABLE agent_ai_settings ADD CONSTRAINT agent_ai_settings_deposit_code_check CHECK (usepod_deposit_code IS NULL OR usepod_deposit_code ~ '^[0-9a-f]{16}$');
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_spend_ledger_credit_status_check') THEN
  ALTER TABLE vendor_spend_ledger ADD CONSTRAINT vendor_spend_ledger_credit_status_check CHECK (credit_status IS NULL OR credit_status IN ('unknown', 'seen'));
 END IF;
END $$;
