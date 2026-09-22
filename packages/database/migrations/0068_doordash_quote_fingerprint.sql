-- Additive: old API containers and historical order rows remain compatible.
-- The new API refuses a legacy preview until the operator requests a fresh quote.
-- Only a SHA256 digest is stored, never raw vendor items, options, or addresses.
ALTER TABLE doordash_orders ADD COLUMN IF NOT EXISTS quote_fingerprint text;
