-- UsePod fee wallet (founder 2026-11-11). Additive, idempotent.
-- fee_payer: the ClawVille fee wallet that paid the network fee of a UsePod
-- deposit. NULL = the avatar wallet paid (every row before this migration).
-- The global daily cap on sponsored deposits counts the rows where it is set.
ALTER TABLE vendor_spend_ledger ADD COLUMN IF NOT EXISTS fee_payer varchar(64);
