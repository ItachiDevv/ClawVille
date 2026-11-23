-- Additive devnet adapter. Existing EVM orders keep their original network.
ALTER TABLE brainchain_buyer_payers ADD COLUMN IF NOT EXISTS network varchar(64) NOT NULL DEFAULT 'eip155:84532';
ALTER TABLE brainchain_buyer_payers ALTER COLUMN chain_id DROP NOT NULL;
ALTER TABLE brainchain_buyer_payers ALTER COLUMN address TYPE varchar(44);
ALTER TABLE brainchain_buyer_payers DROP CONSTRAINT IF EXISTS brainchain_buyer_payers_chain_id_check;
ALTER TABLE brainchain_buyer_payers DROP CONSTRAINT IF EXISTS brainchain_buyer_payers_address_check;
ALTER TABLE brainchain_buyer_payers DROP CONSTRAINT IF EXISTS brainchain_buyer_payer_network;
ALTER TABLE brainchain_buyer_payers ADD CONSTRAINT brainchain_buyer_payer_network CHECK
 ((network='eip155:84532' AND chain_id IS NOT NULL AND chain_id=84532 AND address ~ '^0x[0-9a-f]{40}$') OR
  (network='solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' AND chain_id IS NULL AND address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'));
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_buyer_payer_network_once ON brainchain_buyer_payers(network,address);
ALTER TABLE brainchain_buyer_orders ADD COLUMN IF NOT EXISTS network varchar(64) NOT NULL DEFAULT 'eip155:84532';
ALTER TABLE brainchain_buyer_orders ADD COLUMN IF NOT EXISTS solana_artifact jsonb;
ALTER TABLE brainchain_buyer_orders ALTER COLUMN payer TYPE varchar(44);
ALTER TABLE brainchain_buyer_orders ALTER COLUMN payment_transaction TYPE varchar(88);
ALTER TABLE brainchain_buyer_orders ALTER COLUMN refund_transaction TYPE varchar(88);
ALTER TABLE brainchain_buyer_events ALTER COLUMN transaction TYPE varchar(88);
ALTER TABLE brainchain_buyer_orders DROP CONSTRAINT IF EXISTS brainchain_buyer_orders_payer_check;
ALTER TABLE brainchain_buyer_orders DROP CONSTRAINT IF EXISTS brainchain_buyer_order_network;
ALTER TABLE brainchain_buyer_orders ADD CONSTRAINT brainchain_buyer_order_network CHECK
 ((network='eip155:84532' AND solana_artifact IS NULL AND (payer IS NULL OR payer ~ '^0x[0-9a-f]{40}$')) OR
  (network='solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' AND (payer IS NULL OR payer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
   AND (terms IS NULL OR (solana_artifact IS NOT NULL AND jsonb_typeof(solana_artifact)='object'))));
CREATE OR REPLACE FUNCTION brainchain_buyer_network_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.network IS DISTINCT FROM OLD.network THEN RAISE EXCEPTION 'Buyer network is immutable'; END IF;
 IF OLD.solana_artifact IS NOT NULL AND NEW.solana_artifact IS DISTINCT FROM OLD.solana_artifact THEN RAISE EXCEPTION 'Buyer transaction is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_buyer_network_immutable_row ON brainchain_buyer_orders;
CREATE TRIGGER brainchain_buyer_network_immutable_row BEFORE UPDATE ON brainchain_buyer_orders FOR EACH ROW EXECUTE FUNCTION brainchain_buyer_network_immutable();
