-- SAP Option C — on-chain USDC escrow gate: FULL settlement-ledger schema
-- (ADDITIVE, IDEMPOTENT). Re-authored onto the tokenomics build branch 2026-06-30.
--
-- Creates the two net-new tables + one enum that back the verify-before-release
-- USDC escrow gate (the backend at-most-once-settle + depositor-approval guard
-- that the deployed 0.18.0 program does NOT enforce on-chain):
--   * `sap_escrow_settlement_status` enum (8 lifecycle values, INCLUDING the
--     #4 'refunding' + #5 'funding_unknown' recovery states — created complete
--     here, not via a later ADD VALUE).
--   * `sap_escrow_settlements` — one row per (escrow_pda, job_id); the
--     (escrow_pda, job_id) UNIQUE index is the at-most-once-settle lock that
--     replaces the missing on-chain receipt. Carries the per-job + escrow-wide
--     funds-ledger columns (max_calls/funded/released/refunded) and the
--     funding_signature recovery column.
--   * `sap_escrow_approvals` — the depositor's PERSISTED, authenticated approval
--     (the ONLY thing that authorizes a settle; a worker can no longer forge a
--     request-body approval). One row per (escrow_pda, job_id).
--
-- Source of truth: packages/database/src/schema/sap-escrow.ts +
-- apps/api/src/services/sap/escrow-gate.ts. Both tables bind to avatars.id (the
-- human+agent Rule-E5 parity seam: depositor + worker are each an avatar that a
-- Lucia human OR a connected/hosted agent session resolves to).
--
-- NOTHING moves money here — the rail is triple-gated OFF (SAP_ENABLED=false,
-- SAP_ESCROW_ENABLED=false, SAP_USDC_ESCROW_ENABLED=false) + SAP_DRY_RUN=true by
-- default, so no row is ever written until a deliberate flip-to-live.
--
-- ⚠️ APPLY BY HAND — NOT `bun run db:push`. `db:push` is `drizzle-kit push --force`
-- (silent destructive: it drops any table NOT in the pushing branch's schema, no
-- prompt — it dropped the poker-MTT tables from staging on 2026-06-16). Apply this
-- file directly, e.g. via `packages/database/scripts/apply-sap-escrow.ts`
-- (takes an EXPLICIT $TOKENOMICS_DATABASE_URL) or psql:
--   psql "$TOKENOMICS_DATABASE_URL" -f 2026-06-30_sap_escrow.sql
--
-- Fully idempotent — safe to run repeatedly: CREATE TYPE guarded, CREATE TABLE /
-- INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, and ADD VALUE IF NOT EXISTS for
-- the enum (so a partial prior state from the older incremental migration is
-- reconciled to the full schema without error).

-- ── (1) Lifecycle enum (idempotent CREATE with ALL 8 values) ─────────────────
DO $$
BEGIN
  CREATE TYPE sap_escrow_settlement_status AS ENUM (
    'open',
    'submitted',
    'settling',
    'settled',
    'refunding',
    'refunded',
    'failed',
    'funding_unknown'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END
$$;

-- Reconcile an older incremental-migration enum (which may lack the #4/#5 values)
-- to the full set. ADD VALUE IF NOT EXISTS is a no-op when already present.
ALTER TYPE sap_escrow_settlement_status ADD VALUE IF NOT EXISTS 'refunding';
ALTER TYPE sap_escrow_settlement_status ADD VALUE IF NOT EXISTS 'funding_unknown';

-- ── (2) sap_escrow_settlements — the at-most-once-settle ledger ───────────────
CREATE TABLE IF NOT EXISTS sap_escrow_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- identity of the escrow + job (the idempotency key)
  escrow_pda varchar(64) NOT NULL,
  job_id varchar(128) NOT NULL,

  -- the two parties (Rule E5 parity — both are avatars)
  depositor_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  worker_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,

  -- on-chain coordinates (base58; recorded for audit + idempotent re-derive)
  worker_wallet_pubkey varchar(64) NOT NULL,
  depositor_wallet_pubkey varchar(64) NOT NULL,
  token_mint varchar(64) NOT NULL,

  -- economics (string-encoded u64 base units; USDC = 6 decimals)
  price_per_call varchar(32) NOT NULL,
  max_calls varchar(32),
  funded_amount varchar(32),
  calls_settled varchar(32),
  released_amount varchar(32),
  refunded_amount varchar(32),

  -- verification provenance (WHY the release was authorized)
  verification_provider varchar(64),
  verification_passed boolean,
  audit_root_hex varchar(64),
  verification_detail text,

  -- settle outcome
  status sap_escrow_settlement_status NOT NULL DEFAULT 'open',
  settle_signature varchar(128),
  funding_signature varchar(128),
  dry_run boolean NOT NULL DEFAULT true,

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

-- Defensive ADD COLUMN IF NOT EXISTS for the security-fix columns, so a DB that
-- already has an older (pre-fix) sap_escrow_settlements table is upgraded in place
-- rather than left missing the accounting/recovery columns.
ALTER TABLE IF EXISTS sap_escrow_settlements
  ADD COLUMN IF NOT EXISTS max_calls varchar(32),
  ADD COLUMN IF NOT EXISTS funded_amount varchar(32),
  ADD COLUMN IF NOT EXISTS released_amount varchar(32),
  ADD COLUMN IF NOT EXISTS refunded_amount varchar(32),
  ADD COLUMN IF NOT EXISTS funding_signature varchar(128);

-- THE at-most-once-settle guard.
CREATE UNIQUE INDEX IF NOT EXISTS sap_escrow_settlements_escrow_job_unique
  ON sap_escrow_settlements (escrow_pda, job_id);
CREATE INDEX IF NOT EXISTS sap_escrow_settlements_escrow_idx
  ON sap_escrow_settlements (escrow_pda, created_at);
CREATE INDEX IF NOT EXISTS sap_escrow_settlements_depositor_idx
  ON sap_escrow_settlements (depositor_avatar_id, created_at);
CREATE INDEX IF NOT EXISTS sap_escrow_settlements_worker_idx
  ON sap_escrow_settlements (worker_avatar_id, created_at);
CREATE INDEX IF NOT EXISTS sap_escrow_settlements_status_idx
  ON sap_escrow_settlements (status, created_at);

-- ── (3) sap_escrow_approvals — the depositor-authenticated approval gate ──────
CREATE TABLE IF NOT EXISTS sap_escrow_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_pda varchar(64) NOT NULL,
  job_id varchar(128) NOT NULL,
  approver_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  worker_avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  approved_calls varchar(32),
  approved_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sap_escrow_approvals_escrow_job_unique
  ON sap_escrow_approvals (escrow_pda, job_id);
CREATE INDEX IF NOT EXISTS sap_escrow_approvals_approver_idx
  ON sap_escrow_approvals (approver_avatar_id, approved_at);
