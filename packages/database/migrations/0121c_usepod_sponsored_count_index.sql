-- UsePod fee wallet: partial index for the sponsored-deposit counts (global and
-- per avatar, today in UTC) that admission reads under its locks. Additive,
-- idempotent. After 0121 (it needs the fee_payer column); migrate-ci applies
-- files in lexicographic order: 0121_ < 0121a < 0121b < 0121c.
CREATE INDEX IF NOT EXISTS vendor_spend_ledger_usepod_sponsored_created_idx
  ON vendor_spend_ledger (created_at)
  WHERE vendor = 'usepod' AND fee_payer IS NOT NULL;
