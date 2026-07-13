-- 0028 — Covenant action-record stream (2026-07-13).
--
-- Founder directive: "the agents' actions should be managed with covenants."
-- Append-only record of every economic agent-relevant action, written in the
-- same transaction as the business write (claw-token-ledger credits/debits,
-- quest lifecycle, bounty lifecycle). A background sealer assigns a gapless
-- hash chain (chain_position + prev_hash/record_hash) AFTER commit so money
-- paths never serialize on a global lock; covenant_seal_batches records each
-- seal pass (batch_root = chain head — the future anchor_receipt_batch input).
--
-- Tamper guard: DELETE is always refused; UPDATE may only perform the one-shot
-- NULL→value assignment of the four seal columns (identity/payload columns are
-- frozen at insert). In-DB defense-in-depth until on-chain anchoring lands.
--
-- Idempotent throughout — safe to re-run.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS covenant_action_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  actor_kind text,
  payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  chain_position bigint,
  prev_hash char(64),
  record_hash char(64),
  sealed_at timestamptz,
  -- Seal columns move NULL→value together, once (enforced by the trigger too).
  CONSTRAINT covenant_records_seal_all_or_none CHECK (
    (chain_position IS NULL AND prev_hash IS NULL AND record_hash IS NULL AND sealed_at IS NULL)
    OR
    (chain_position IS NOT NULL AND prev_hash IS NOT NULL AND record_hash IS NOT NULL AND sealed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS covenant_action_records_seq_unique
  ON covenant_action_records (seq);
CREATE UNIQUE INDEX IF NOT EXISTS covenant_action_records_chain_position_unique
  ON covenant_action_records (chain_position);
CREATE INDEX IF NOT EXISTS idx_covenant_records_action
  ON covenant_action_records (action, chain_position);
CREATE INDEX IF NOT EXISTS idx_covenant_records_subject
  ON covenant_action_records (subject_id, chain_position);
CREATE INDEX IF NOT EXISTS idx_covenant_records_created_at
  ON covenant_action_records (created_at);
-- Sealer scan: unsealed rows only, in arrival order.
CREATE INDEX IF NOT EXISTS idx_covenant_records_unsealed
  ON covenant_action_records (seq) WHERE chain_position IS NULL;

CREATE TABLE IF NOT EXISTS covenant_seal_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_position bigint NOT NULL,
  last_position bigint NOT NULL,
  record_count bigint NOT NULL,
  batch_root char(64) NOT NULL,
  prev_batch_root char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS covenant_seal_batches_last_position_unique
  ON covenant_seal_batches (last_position);

-- ── Tamper guard ─────────────────────────────────────────────────────────────
-- Records are immutable once inserted; the ONLY legal UPDATE is the sealer's
-- one-shot seal-column assignment (NULL → value, identity columns untouched).
CREATE OR REPLACE FUNCTION covenant_action_records_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'covenant_action_records is append-only — DELETE refused';
  END IF;
  -- Identity/payload columns are frozen at insert.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.actor_kind IS DISTINCT FROM OLD.actor_kind
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'covenant_action_records identity columns are immutable';
  END IF;
  -- Seal columns are one-shot: writable only while currently NULL.
  IF OLD.chain_position IS NOT NULL AND (
       NEW.chain_position IS DISTINCT FROM OLD.chain_position
       OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash
       OR NEW.record_hash IS DISTINCT FROM OLD.record_hash
       OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
     ) THEN
    RAISE EXCEPTION 'covenant_action_records seal columns are write-once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS covenant_action_records_guard_trg ON covenant_action_records;
CREATE TRIGGER covenant_action_records_guard_trg
  BEFORE UPDATE OR DELETE ON covenant_action_records
  FOR EACH ROW EXECUTE FUNCTION covenant_action_records_guard();

-- Seal batches are equally append-only (no legal UPDATE at all).
CREATE OR REPLACE FUNCTION covenant_seal_batches_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'covenant_seal_batches is append-only — % refused', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS covenant_seal_batches_guard_trg ON covenant_seal_batches;
CREATE TRIGGER covenant_seal_batches_guard_trg
  BEFORE UPDATE OR DELETE ON covenant_seal_batches
  FOR EACH ROW EXECUTE FUNCTION covenant_seal_batches_guard();
