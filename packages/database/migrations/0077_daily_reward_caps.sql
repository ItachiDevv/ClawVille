-- 0077_daily_reward_caps.sql — security pass 2026-10-04 (founder faucet caps).
--
-- ADDITIVE + IDEMPOTENT. Creates one new table. It alters, drops, or rewrites no
-- existing table, column, index, or row. The file runs as one implicit
-- transaction, so a failure applies nothing. NEVER apply via drizzle-kit push.
--
-- WHY: three vCLAW faucets had no durable daily limit per avatar:
--   * idle-avatar building visits paid 1 vCLAW on EVERY arrival (no limit);
--   * Town Guide (Nori) chat paid 1 vCLAW per turn behind only an in-memory
--     60 s cooldown (up to 1440/day, reset on every API restart);
--   * activity match rewards had no daily total.
-- Founder decision 2026-10-04, per avatar per UTC day:
--   building_visit = 10 paid arrivals, nori_chat = 10 paid turns,
--   activity = 500 vCLAW total. Values live in @clawville/shared
--   DAILY_REWARD_CAPS; the database stores only the counters.
--
-- One row per (avatar, UTC day, kind). Humans, connected agents and hosted /
-- autonomous agents settle to the same avatars.id, so they share ONE counter.
-- apps/api/src/services/daily-reward-cap.ts claims allowance with ONE statement,
-- in the same transaction as the ledger credit:
--   INSERT ... ON CONFLICT (avatar_id, reward_day, kind) DO UPDATE
--     SET last_granted = LEAST(want, cap - used), used = used + LEAST(want, cap - used)
--     WHERE used < cap RETURNING last_granted
-- ON CONFLICT DO UPDATE row-locks the latest committed row version, so two
-- concurrent claims serialize and `used` can never pass the cap. A failed credit
-- rolls the claim back with its transaction. `last_granted` exists only so the
-- statement can RETURN the granted amount (RETURNING sees the new row only).

CREATE TABLE IF NOT EXISTS "daily_reward_caps" (
  "avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "reward_day" date NOT NULL,
  "kind" text NOT NULL,
  "used" integer NOT NULL DEFAULT 0,
  "last_granted" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "daily_reward_caps_pkey" PRIMARY KEY ("avatar_id", "reward_day", "kind"),
  CONSTRAINT "daily_reward_caps_kind_check"
    CHECK ("kind" IN ('building_visit', 'nori_chat', 'activity')),
  CONSTRAINT "daily_reward_caps_amounts_check"
    CHECK ("used" >= 0 AND "last_granted" >= 0)
);
