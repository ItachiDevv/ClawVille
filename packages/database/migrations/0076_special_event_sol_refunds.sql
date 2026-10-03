-- 0076_special_event_sol_refunds.sql — security pass 2026-10-03 (Codex r1 on the
-- special-event cancel route).
--
-- ADDITIVE + IDEMPOTENT. Creates one new table and its indexes. It alters,
-- drops, or rewrites no existing table, column, index, or row. The file runs as
-- one implicit transaction, so a failure applies nothing.
--
-- WHY: POST /api/events/:slug/cancel refunds vCLAW entries in its transaction,
-- but a SOL entry can only go back by an on-chain transfer. Before this table the
-- cancel only listed SOL entries in its response, so a cancelled event could
-- leave a SOL payment with no durable record and no guard against two payouts.
--
-- special_event_sol_refunds holds ONE row per SOL signup (UNIQUE signup_id),
-- written in the same transaction as the event's 'cancelled' CAS:
--   'owed'     -> the treasury owes `lamports` to `destination_pubkey`
--   'refunded' -> a named admin recorded the payout with
--                 POST /api/events/:slug/sol-refunds/:signupId/paid; the API
--                 verified on chain that `refund_tx_sig` pays >= `lamports` to
--                 `destination_pubkey`.
-- `destination_pubkey` is the sender PROVEN by the entry transfer (the single
-- System-program transfer source into the treasury), never the client-claimed
-- wallet. `refund_tx_sig` is globally unique: one payout settles one refund.
-- The SOL signup row stays 'confirmed', so its entry tx sig stays reserved by
-- special_event_signups_sol_txsig_global_unique.
--
-- No FK on signup_id / avatar_id on purpose: the refund obligation must outlive
-- an avatar delete (special_event_signups cascades with its avatar).

CREATE TABLE IF NOT EXISTS "special_event_sol_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "special_events"("id"),
  "signup_id" uuid NOT NULL,
  "avatar_id" uuid NOT NULL,
  "entry_tx_sig" text NOT NULL,
  "lamports" text NOT NULL,
  "destination_pubkey" text,
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
