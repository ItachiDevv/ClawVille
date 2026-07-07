-- 0010_cosmetic_bonus_grants.sql
-- Tokenomics Phase A / Slice A2 (2026-07-07) — cosmetics-scoped signup bonus.
--
-- A one-time promo balance spendable ONLY in the cosmetic shop. It lives in its
-- OWN scoped table, entirely OUTSIDE avatars.clawTokens, so the F1 provenance
-- CHECK (claw_tokens = soft + bought + earned) is TRIVIALLY intact and the grant
-- is never spendable in cove/land. user_id is UNIQUE — the grant is idempotent
-- by construction (INSERT … ON CONFLICT (user_id) DO NOTHING).
--
-- Idempotent + additive-only (migrate-ci discipline — NEVER db:push). No DROP.
-- The ×10 ¢-peg redenomination (migration 0011) multiplies amount_granted +
-- amount_remaining here in the same guarded pass as the avatar balances, so the
-- $5 purchasing power is preserved across the rename.

CREATE TABLE IF NOT EXISTS "cosmetic_bonus_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "amount_granted" integer NOT NULL,
  "amount_remaining" integer NOT NULL,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cosmetic_bonus_remaining_valid"
    CHECK ("amount_remaining" >= 0 AND "amount_remaining" <= "amount_granted")
);

-- One grant per user (the idempotency guard). Unique index name matches the
-- Drizzle `.unique()` convention so introspection stays consistent.
CREATE UNIQUE INDEX IF NOT EXISTS "cosmetic_bonus_grants_user_id_unique"
  ON "cosmetic_bonus_grants" ("user_id");
