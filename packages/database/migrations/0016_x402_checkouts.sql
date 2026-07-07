-- 0016_x402_checkouts.sql
-- Tokenomics C — checkout stage (2026-07-07): the generic x402 checkout ledger
-- + the land escrow USDC-prepay audit kind.
--
-- WHY: any vCLAW-priced thing (cosmetic, land-rent prepay, later marketplace/
-- tournament) can settle as a REAL x402 USDC payment. `x402_checkouts` is the
-- pending→settled ledger; the settle route flips the row + runs the item's
-- fulfiller in ONE transaction (apps/api/src/services/x402-checkout.ts).
-- Structure copies `ct_topups` — the proven on-ramp money path — including its
-- two partial-UNIQUE exactly-once guards:
--   * tx_signature UNIQUE WHERE NOT NULL  → one settled payment fulfills ONCE
--     (a duplicate settle 23505s and the whole tx, fulfiller writes included,
--     rolls back; the route replays the already-fulfilled row);
--   * (avatar_id, idempotency_key) UNIQUE WHERE NOT NULL → retried settles
--     replay the cached fulfillment.
--
-- `price_vclaw` is the QUOTE unit only (¢-peg 1 vCLAW = $0.01, so usd_cents ==
-- price_vclaw at quote time; both stored so the peg-at-purchase survives a
-- future rate change). The buyer's internal vCLAW is NEVER debited on this
-- path; this migration never touches `avatars.clawTokens` or the CT ledger.
--
-- `land_transaction_kind` += 'land_deposit_prepay_usdc': the rent-prepay
-- fulfiller credits a deposit parcel's escrow remainder BACKED BY a recorded
-- USDC settlement (usd_basis in the row metadata) instead of an avatar debit —
-- the documented extension of the escrow-conservation invariant on
-- `land_parcels.deposit_remaining_ct` (see packages/database/src/schema/land.ts
-- and the LAND-DOMAIN comment in
-- apps/api/src/services/checkout-fulfillers/rent-prepay.ts).
--
-- IDEMPOTENT + ADDITIVE ONLY: guarded CREATE TYPEs, one enum value add, one
-- CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS. A re-run where
-- everything exists is a total no-op. NEVER author a DROP of data.
--
-- ⚠ APPLY MODE: run statement-by-statement in AUTOCOMMIT (plain `psql -f`, or a
-- per-statement client). `ALTER TYPE ... ADD VALUE` cannot run inside a
-- transaction block on older PG (and a value can't be USED in the txn that
-- added it) — same rule as 0013/0014. Nothing below uses
-- 'land_deposit_prepay_usdc' after adding it, but keep the apply mode uniform.
--
-- CONSTRAINT/INDEX NAMING follows drizzle-kit's rendering convention (load-
-- bearing for drift-prevention, per 0001/0007/0014): names reproduce the
-- explicit Drizzle schema names in packages/database/src/schema/checkout.ts.

-- ── new enum types (duplicate-safe) ──────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE checkout_item_kind AS ENUM (
    'rent_payment', 'cosmetic_purchase', 'marketplace_purchase', 'tournament_entry'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE checkout_status AS ENUM ('pending', 'settled', 'failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── land audit kind for the USDC escrow prepay (own autocommit statement) ────
ALTER TYPE land_transaction_kind ADD VALUE IF NOT EXISTS 'land_deposit_prepay_usdc';

-- ── the checkout ledger ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "x402_checkouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "item_kind" checkout_item_kind NOT NULL,
  "item_ref" varchar(128) NOT NULL,
  "price_vclaw" integer NOT NULL,
  "usd_cents" integer NOT NULL,
  "tx_signature" text,
  "usd_basis_at_receipt" numeric,
  "status" checkout_status NOT NULL DEFAULT 'pending',
  "idempotency_key" varchar(64),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "x402_checkouts_price_vclaw_positive" CHECK ("price_vclaw" > 0),
  CONSTRAINT "x402_checkouts_usd_cents_positive" CHECK ("usd_cents" > 0)
);

CREATE INDEX IF NOT EXISTS "x402_checkouts_avatar_idx"
  ON "x402_checkouts" ("avatar_id", "created_at");

-- Exactly-once guards (the whole point — mirror ct_topups):
CREATE UNIQUE INDEX IF NOT EXISTS "x402_checkouts_txsig_unique"
  ON "x402_checkouts" ("tx_signature") WHERE tx_signature IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "x402_checkouts_idem_unique"
  ON "x402_checkouts" ("avatar_id", "idempotency_key") WHERE idempotency_key IS NOT NULL;
