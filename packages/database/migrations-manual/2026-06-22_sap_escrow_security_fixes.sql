-- SAP Option C escrow gate — security-fix schema (2026-06-22). See
-- apps/api/src/services/sap/escrow-gate.ts + packages/database/src/schema/sap-escrow.ts.
--
-- WHY: the five BLOCKING money-path fixes added before any flip-to-live of the
-- USDC escrow rail (gated OFF today: SAP_ESCROW_ENABLED=false, SAP_DRY_RUN=true,
-- SAP_USDC_ESCROW_ENABLED=false — NO row is written until a deliberate flip):
--
--   #1 forged-approval fix — sap_escrow_approvals: the depositor's PERSISTED,
--      authenticated approval. settleJob reads THIS row to build the verification
--      signal server-side; the forgeable request-body `approval` is removed. Only
--      the depositor (asserted) writes it; one row per (escrow_pda, job_id).
--   #2 over-release fix — max_calls: the job's authorized call ceiling, recorded
--      at open so settle clamps callsToSettle to maxCalls − callsSettled.
--   #3 cross-job drain fix — funded_amount / released_amount / refunded_amount:
--      the per-job + escrow-wide funds ledger that enforces
--      sum(released)+sum(refunded) ≤ sum(funded) across the nonce-less shared vault.
--   #4 refund-vs-settle TOCTOU fix — new 'refunding' enum value (the atomic refund
--      claim before any chain send).
--   #5 orphaned-deposit fix — new 'funding_unknown' enum value + funding_signature
--      (a broadcast-but-unconfirmed open is held for reconciliation, never deleted).
--
-- Idempotent: ADD VALUE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
-- CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS — safe to re-run.
-- Drizzle db:push would emit the same from the schema; this manual SQL is the
-- deterministic, NON-destructive fallback (per CLAUDE.md, prefer targeted
-- idempotent DDL over a full db:push from a partial-schema branch on a shared DB).
--
-- DO NOT RUN as part of the impl diff — the orchestrator applies it manually
-- against the target DB, and ONLY as a flip-to-live prerequisite.

-- ── #4 + #5 — new lifecycle enum values (must be committed before use) ──────────
ALTER TYPE sap_escrow_settlement_status ADD VALUE IF NOT EXISTS 'refunding';
ALTER TYPE sap_escrow_settlement_status ADD VALUE IF NOT EXISTS 'funding_unknown';

-- ── #2 + #3 + #5 — accounting + recovery columns on the settlement ledger ───────
ALTER TABLE IF EXISTS sap_escrow_settlements
  ADD COLUMN IF NOT EXISTS max_calls varchar(32),
  ADD COLUMN IF NOT EXISTS funded_amount varchar(32),
  ADD COLUMN IF NOT EXISTS released_amount varchar(32),
  ADD COLUMN IF NOT EXISTS refunded_amount varchar(32),
  ADD COLUMN IF NOT EXISTS funding_signature varchar(128);

-- ── #1 — the depositor-authenticated approval table ─────────────────────────────
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
