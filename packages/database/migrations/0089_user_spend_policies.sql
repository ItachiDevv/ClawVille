-- 0089_user_spend_policies.sql: per-avatar spend rules for paid third-party tools (MCP hub step 2, phase 1;
-- founder 2026-11-04: users spend on these tools from their own wallet under their own rules).
--
-- ADDITIVE + IDEMPOTENT. Creates one new table. It alters, drops, or rewrites no existing table, column, index,
-- or row. The file runs as one implicit transaction, so a failure applies nothing. NEVER apply via drizzle-kit push.
--
-- One row per avatar. Only a logged-in human (the avatar's owner) writes it: PUT /api/wallet/spend-policy is a
-- Lucia-session route and refuses agent sessions, so an agent can never raise its own cap. Agents read it.
--
-- Caps start UNSET (founder: "it should be unset"): NULL means the human has not chosen a cap yet, and every paid
-- call is refused until they do. No row is the same as a row with NULL caps and no vendors.
--   daily_cap_usd_cents     total paid per UTC day, in US cents (NULL = not set)
--   per_call_cap_usd_cents  largest single paid call, in US cents (NULL = not set)
--   allowed_vendors         vendor ids the agent may pay (from @clawville/shared SPEND_VENDOR_IDS)
-- The upper bound (100000 cents = $1000/day) is a typo guard, not a product limit.

CREATE TABLE IF NOT EXISTS "user_spend_policies" (
  "avatar_id" uuid PRIMARY KEY REFERENCES "avatars"("id") ON DELETE CASCADE,
  "daily_cap_usd_cents" integer,
  "per_call_cap_usd_cents" integer,
  "allowed_vendors" text[] NOT NULL DEFAULT '{}',
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_spend_policies_daily_cap_check"
    CHECK ("daily_cap_usd_cents" IS NULL OR ("daily_cap_usd_cents" >= 0 AND "daily_cap_usd_cents" <= 100000)),
  CONSTRAINT "user_spend_policies_per_call_cap_check"
    CHECK ("per_call_cap_usd_cents" IS NULL OR ("per_call_cap_usd_cents" >= 0 AND "per_call_cap_usd_cents" <= 100000)),
  CONSTRAINT "user_spend_policies_per_call_le_daily_check"
    CHECK ("daily_cap_usd_cents" IS NULL OR "per_call_cap_usd_cents" IS NULL
      OR "per_call_cap_usd_cents" <= "daily_cap_usd_cents")
);
