-- 0076_special_event_sol_refunds.sql — security pass 2026-10-03 (Codex r1 + r2 on
-- the special-event cancel route).
--
-- ADDITIVE + IDEMPOTENT. Creates two new tables and their indexes, and copies the
-- existing SOL entry signatures into the new signature guard. It alters, drops,
-- or rewrites no existing table, column, index, or row. The file runs as one
-- implicit transaction, so a failure applies nothing.
--
-- WHY: POST /api/events/:slug/cancel refunds vCLAW entries in its transaction,
-- but a SOL entry can only go back by an on-chain transfer. Before this table the
-- cancel only listed SOL entries in its response, so a cancelled event could
-- leave a SOL payment with no durable record and no guard against two payouts.
--
-- 1. special_event_sol_refunds holds ONE row per SOL signup (UNIQUE signup_id),
-- written in the same transaction as the event's 'cancelled' CAS:
--   'owed'     -> the treasury owes `lamports` to `destination_pubkey`
--   'refunded' -> a named admin recorded the payout with
--                 POST /api/events/:slug/sol-refunds/:signupId/paid; the API
--                 verified on chain that `refund_tx_sig` pays >= `lamports` to
--                 `destination_pubkey` and that System transfers FROM
--                 `receiving_pubkey` TO `destination_pubkey` sum to >= `lamports`.
-- `receiving_pubkey` is the wallet that received the entry (the treasury,
-- entry_proof_json.toPubkey); the payout must come from it (Codex r2).
-- `destination_pubkey` is the single source whose OWN System transfers into the
-- receiving wallet cover the full credited entry amount (Codex r2), never the
-- client-claimed wallet. When the chain proves no such source it stays NULL until
-- a named admin sets it with POST /api/events/:slug/sol-refunds/:signupId/destination
-- (`destination_set_by` / `destination_set_at` record who and when; both NULL
-- for a chain-proven destination). `refund_tx_sig` is globally unique: one payout
-- settles one refund. The SOL signup row stays 'confirmed', so its entry tx sig
-- stays reserved by special_event_signups_sol_txsig_global_unique.
--
-- No FK on signup_id / avatar_id on purpose: the refund obligation must outlive
-- an avatar delete (special_event_signups cascades with its avatar).
--
-- 2. special_event_used_tx_sigs (Codex r2): ONE row per transaction signature
-- that a special event consumed, as a SOL entry ('entry') or as a SOL refund
-- payout ('refund'). PRIMARY KEY tx_sig. The signup and the mark-paid paths
-- insert into it in the same transaction as their own write, so one signature
-- can never be both an entry and a refund, even under concurrency (the second
-- insert waits on the first and then conflicts). The backfill copies every
-- existing SOL entry signature.

CREATE TABLE IF NOT EXISTS "special_event_sol_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "special_events"("id"),
  "signup_id" uuid NOT NULL,
  "avatar_id" uuid NOT NULL,
  "entry_tx_sig" text NOT NULL,
  "lamports" text NOT NULL,
  "receiving_pubkey" text NOT NULL,
  "destination_pubkey" text,
  "destination_set_by" uuid,
  "destination_set_at" timestamp with time zone,
  "status" text DEFAULT 'owed' NOT NULL,
  "refund_tx_sig" text,
  "refunded_at" timestamp with time zone,
  "refunded_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "special_event_sol_refunds_status_check"
    CHECK (status IN ('owed', 'refunded')),
  CONSTRAINT "special_event_sol_refunds_paid_check"
    CHECK (status = 'owed' OR (refund_tx_sig IS NOT NULL AND refunded_at IS NOT NULL AND destination_pubkey IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "special_event_sol_refunds_signup_unique"
  ON "special_event_sol_refunds" USING btree ("signup_id");

CREATE UNIQUE INDEX IF NOT EXISTS "special_event_sol_refunds_refund_tx_unique"
  ON "special_event_sol_refunds" USING btree ("refund_tx_sig")
  WHERE refund_tx_sig IS NOT NULL;

CREATE INDEX IF NOT EXISTS "special_event_sol_refunds_event_idx"
  ON "special_event_sol_refunds" USING btree ("event_id");

CREATE TABLE IF NOT EXISTS "special_event_used_tx_sigs" (
  "tx_sig" text PRIMARY KEY NOT NULL,
  "use_kind" text NOT NULL,
  "signup_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "special_event_used_tx_sigs_use_kind_check"
    CHECK (use_kind IN ('entry', 'refund'))
);

INSERT INTO "special_event_used_tx_sigs" ("tx_sig", "use_kind", "signup_id", "created_at")
SELECT s.entry_proof_json->>'txSig', 'entry', s.id, s.created_at
  FROM "special_event_signups" s
 WHERE s.entry_method = 'sol'
   AND s.entry_proof_json->>'txSig' IS NOT NULL
 ORDER BY s.created_at ASC
ON CONFLICT ("tx_sig") DO NOTHING;
