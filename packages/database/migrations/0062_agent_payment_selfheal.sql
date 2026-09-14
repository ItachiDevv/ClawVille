-- Durable Tier-1 alert delivery state and observed-signature ownership lookup.
ALTER TABLE bounty_usdc_holds ADD COLUMN IF NOT EXISTS last_wedge_alert_at timestamptz;
ALTER TABLE bounty_usdc_holds ADD COLUMN IF NOT EXISTS wedge_alert_count integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS agent_payments_reconcile_txsig_idx ON agent_payments (reconcile_tx_signature) WHERE reconcile_tx_signature IS NOT NULL;
