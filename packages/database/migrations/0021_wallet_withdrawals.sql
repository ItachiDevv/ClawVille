-- 0021_wallet_withdrawals.sql
-- Custodial wallet WITHDRAW (2026-07-08) — durable exactly-once ledger for
-- users moving their OWN deposited on-chain assets (SOL / USDC / CLV) out of
-- their in-game custodial avatar wallet to a self-custody destination.
-- (DARK: the whole feature ships behind the default-OFF `WALLET_WITHDRAW_ENABLED`
-- flag — `apps/api/src/services/wallet-withdraw-executor.ts` + the
-- `POST /api/wallet/withdraw` route both refuse while it is unset.)
--
-- WHY: a withdrawal SIGNS with the user's custodial keypair and moves REAL
-- mainnet assets — a double-send is a real double-withdrawal. This table is the
-- durable state machine that makes the send exactly-once (the x402-checkout /
-- market-payout-executor discipline):
--
--   pending  → sending    ATOMIC CLAIM (claim_id) BEFORE any decrypt/sign/send;
--                          double-claim ⇒ 0 rows ⇒ refuse.
--   sending  + signature   CAPTURE-BEFORE-SEND: the deterministic first tx
--                          signature persists in its OWN committed UPDATE
--                          (partial-UNIQUE below) BEFORE the wire is touched.
--   sending  → sent        send + confirm succeeded (sent_at stamped; a 'sent'
--                          row ALWAYS carries its signature — DB CHECK).
--   sending  → failed      DEFINITIVE failure: the tx landed on-chain with an
--                          error (no assets moved) or custody refused before
--                          anything was signed. Terminal, auditable.
--   sending  → reconcile   AMBIGUOUS send/confirm (threw mid-wire): money-state
--                          UNKNOWN — TERMINAL, NEVER auto-retried; the captured
--                          signature is the chain-poll anchor for the operator.
--   sending  → pending     pre-capture failure only (guarded tx_signature IS
--                          NULL): nothing signed-and-captured ⇒ nothing sent ⇒
--                          clean retry.
--
-- Exactly-once guards (mirror x402_checkouts / market_settlements):
--   * withdrawals_txsig_unique (partial UNIQUE on tx_signature WHERE NOT NULL)
--     — one on-chain send binds to exactly one withdrawal row.
--   * withdrawals_idem_unique (partial UNIQUE on (subject_type, avatar_id,
--     idempotency_key) WHERE NOT NULL) — a retried POST with the same
--     Idempotency-Key replays the EXISTING row's state, never a 2nd withdrawal.
--
-- E5 PARITY: subject_type ∈ ('user','agent') — a human (Lucia) and a
-- connected/hosted ledger-capable agent both withdraw from THEIR OWN avatar's
-- custodial wallet (avatar_id is middleware-resolved, never body-supplied).
-- Guests + non-ledger agent sessions are refused at the route (never inserted).
--
-- LEDGER-UNTOUCHED: this moves ON-CHAIN custody assets, NOT internal vCLAW —
-- nothing here (or in the executor) touches `avatars.clawTokens` or the CT
-- ledger. amount_atomic is an on-chain base-unit integer (lamports / µUSDC /
-- CLV atomic), NEVER a ClawToken amount.
--
-- IDEMPOTENT + ADDITIVE ONLY: guarded CREATE TYPE (duplicate_object pattern —
-- a brand-new enum, so no ALTER TYPE ... ADD VALUE anywhere in this file and it
-- is single-transaction-safe for migrate-ci), CREATE TABLE IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS. A re-run where everything exists is a total
-- no-op. NEVER a DROP.
--
-- CONSTRAINT/INDEX NAMING follows drizzle-kit's rendering convention (per
-- 0001/0016/0020): names reproduce the explicit Drizzle schema names in
-- packages/database/src/schema/withdrawals.ts.

-- ── new enum (duplicate-safe; NEW type ⇒ txn-safe, unlike ADD VALUE) ─────────
DO $$ BEGIN
  CREATE TYPE withdrawal_status AS ENUM ('pending', 'sending', 'sent', 'reconcile', 'failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── the withdrawal ledger ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "withdrawals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_type" text NOT NULL,
  "avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "asset" text NOT NULL,
  "amount_atomic" numeric(30, 0) NOT NULL,
  "destination" varchar(64) NOT NULL,
  "status" withdrawal_status NOT NULL DEFAULT 'pending',
  "tx_signature" text,
  "claim_id" uuid,
  "claimed_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "failure_reason" text,
  "idempotency_key" varchar(64),
  "network" text NOT NULL DEFAULT 'mainnet',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawals_subject_type_valid" CHECK ("subject_type" IN ('user', 'agent')),
  CONSTRAINT "withdrawals_asset_valid" CHECK ("asset" IN ('SOL', 'USDC', 'CLV')),
  -- Amount discipline backstop — a zero/negative withdrawal can never persist.
  CONSTRAINT "withdrawals_amount_positive" CHECK ("amount_atomic" > 0),
  -- A 'sent' row ALWAYS carries the money proof.
  CONSTRAINT "withdrawals_sent_has_signature"
    CHECK ("status" <> 'sent' OR "tx_signature" IS NOT NULL)
);

-- Exactly-once guards:
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_txsig_unique"
  ON "withdrawals" ("tx_signature") WHERE tx_signature IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "withdrawals_idem_unique"
  ON "withdrawals" ("subject_type", "avatar_id", "idempotency_key") WHERE idempotency_key IS NOT NULL;

-- Resume/ops scan hot path (stale 'sending' claims) + admin listing.
CREATE INDEX IF NOT EXISTS "withdrawals_status_created_idx"
  ON "withdrawals" ("status", "created_at");

-- Per-subject history + the daily-cap SUM window.
CREATE INDEX IF NOT EXISTS "withdrawals_avatar_idx"
  ON "withdrawals" ("avatar_id", "created_at");
