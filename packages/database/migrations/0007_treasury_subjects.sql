-- 0007_treasury_subjects.sql
-- Tokenomics T0 — house-treasury subject registry (2026-07-07).
--
-- WHY: T0 converts every LIVE silent-burn fee (blackjack net-winnings rake,
-- hold'em pot-rake human share, baccarat banker commission, MTT tournament
-- rake, cosmetics/book purchases, land sale/upgrade/rent) into an audited
-- `creditClawTokens(...)` to a singleton HOUSE-TREASURY avatar, composed into
-- the SAME settlement/purchase transaction that already debits the player.
-- The ClawToken ledger can only hold a balance on an `avatars` row (every
-- `claw_token_transactions` row requires `avatar_id`; the
-- `avatars_vclaw_balance_sum` CHECK lives there), so the treasury IS a system
-- avatar — `treasury_subjects` is the durable registry that NAMES it as a
-- first-class subject (`purpose='house-fees'` → avatar_id). Seeded
-- idempotently on boot by `apps/api/src/services/house-treasury-seeder.ts`
-- (mirrors the audited cash-house-seeder pattern; NO bankroll mint — the
-- treasury starts at 0 and only accumulates routed fees).
--
-- IDEMPOTENT: single guarded `CREATE TABLE IF NOT EXISTS` — a re-run where the
-- table already exists is a total no-op. ADDITIVE-ONLY: one net-new table; no
-- enum changes (fee credits reuse `claw_token_source` 'system'); references
-- only the pre-existing "avatars"("id"). NEVER author a DROP of data.
--
-- CONSTRAINT NAMING follows drizzle-kit's rendering convention (load-bearing
-- for drift-prevention, per 0001): `.unique()` → "<table>_<col>_unique",
-- `.references()` → "<table>_<col>_<reftable>_<refcol>_fk". ON DELETE RESTRICT:
-- the treasury avatar must never be cascade-deleted out from under the
-- registry (it holds the accumulated revenue).

CREATE TABLE IF NOT EXISTS "treasury_subjects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "purpose" text NOT NULL CONSTRAINT "treasury_subjects_purpose_unique" UNIQUE,
  "avatar_id" uuid NOT NULL CONSTRAINT "treasury_subjects_avatar_id_avatars_id_fk" REFERENCES "avatars"("id") ON DELETE RESTRICT,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
