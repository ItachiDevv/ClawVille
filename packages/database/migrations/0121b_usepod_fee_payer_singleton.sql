-- Exactly ONE ACTIVE UsePod fee wallet. It lives here, not in 0121a, because the
-- enum value is usable only after 0121a commits (same shape as 0060b).
-- Scoped to active rows: a rotated-out wallet keeps its row and its key.
CREATE UNIQUE INDEX IF NOT EXISTS treasury_wallets_usepod_fee_payer_singleton
  ON treasury_wallets (purpose)
  WHERE purpose = 'usepod-fee-payer' AND retired_at IS NULL;
