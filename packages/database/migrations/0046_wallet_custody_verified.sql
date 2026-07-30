ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS custody_verified boolean NOT NULL DEFAULT false;
