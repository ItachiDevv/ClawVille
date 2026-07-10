-- SAP V2 two-phase release ledger retrofit.
--
-- ADDITIVE + IDEMPOTENT ONLY. Existing V1 rows receive escrow_version='v1';
-- every other V2 field remains NULL until its lifecycle leg occurs. Fee,
-- reserved principal, and released principal are intentionally separate money
-- legs and must never be coalesced into an existing column's meaning.

ALTER TABLE "sap_escrow_settlements"
  ADD COLUMN IF NOT EXISTS "escrow_version" varchar(8) NOT NULL DEFAULT 'v1';

ALTER TABLE "sap_escrow_settlements"
  ADD COLUMN IF NOT EXISTS "escrow_nonce" varchar(32);

ALTER TABLE "sap_escrow_settlements"
  ADD COLUMN IF NOT EXISTS "settlement_index" varchar(32);

ALTER TABLE "sap_escrow_settlements"
  ADD COLUMN IF NOT EXISTS "finalize_signature" varchar(128);

ALTER TABLE "sap_escrow_settlements"
  ADD COLUMN IF NOT EXISTS "fee_amount" varchar(32);

ALTER TABLE "sap_escrow_settlements"
  ADD COLUMN IF NOT EXISTS "reserved_principal_amount" varchar(32);
