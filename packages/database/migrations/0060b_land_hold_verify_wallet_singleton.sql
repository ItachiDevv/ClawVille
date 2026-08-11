-- Exactly ONE ACTIVE land-hold verify wallet may exist. Two ACTIVE rows would
-- mean door-2 dust is sent to an address nothing watches (real user SOL lost).
-- Same singleton shape as treasury_wallets_sap_gas_sponsor_singleton in 0057b;
-- it lives here rather than in 0060 because the enum value it references is only
-- usable after 0060a commits.
--
-- SCOPED TO ACTIVE ROWS (`retired_at IS NULL`). An unscoped singleton allowed at
-- most ONE such row ever, which made rotation impossible to represent: the
-- refund path, the rotated-destination discovery and the retention obligation in
-- ARCHITECTURE.md all assume a retired address can still exist alongside the
-- live one, and an operator told to "keep the previous row, never delete it"
-- literally could not comply. Retired rows now persist beside exactly one active
-- wallet, which is what keeps their dust recoverable.
CREATE UNIQUE INDEX IF NOT EXISTS treasury_wallets_land_hold_verify_singleton
  ON treasury_wallets (purpose)
  WHERE purpose = 'land-hold-verify' AND retired_at IS NULL;
