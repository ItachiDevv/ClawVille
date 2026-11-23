-- Read-only recovery progress. This migration grants no liability release.
ALTER TABLE brainchain_buyer_orders ADD COLUMN IF NOT EXISTS solana_discovery jsonb;
ALTER TABLE brainchain_buyer_orders DROP CONSTRAINT IF EXISTS brainchain_buyer_discovery_shape;
ALTER TABLE brainchain_buyer_orders ADD CONSTRAINT brainchain_buyer_discovery_shape CHECK
 (solana_discovery IS NULL OR (network='solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' AND solana_artifact IS NOT NULL
  AND captured IS NOT NULL AND first_send_at IS NOT NULL AND jsonb_typeof(solana_discovery)='object'
  AND octet_length(solana_discovery::text)<=4096));
