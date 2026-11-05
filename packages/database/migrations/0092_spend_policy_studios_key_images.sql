-- 0092_spend_policy_studios_key_images.sql
-- MCP hub step 2, phase 2b follow-up (founder 2026-11-05): each user's own
-- agent pays for its own tools under the user's own rules, so ClawVille sets
-- no fixed image limits. The spend caps already bound the wallet mode. They do
-- not cover the human's own Studios credits (mode A), so the human sets one
-- more rule: how many Studios images per UTC day the avatar may make with the
-- human's own Studios key (any actor, any surface).
--
-- NULL = the default in code (STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT = 10). Written
-- only by services/spend-policy.ts applySpendPolicyChange: a value above the
-- saved one is a raise and needs the linked-wallet signature, like a cap.
-- The upper bound is a typo guard, not a product limit.
--
-- Additive and idempotent: one nullable column and one CHECK.

ALTER TABLE "user_spend_policies" ADD COLUMN IF NOT EXISTS "studios_key_images_per_day" integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_spend_policies_studios_key_images_check'
  ) THEN
    ALTER TABLE "user_spend_policies" ADD CONSTRAINT "user_spend_policies_studios_key_images_check"
      CHECK ("studios_key_images_per_day" IS NULL
        OR ("studios_key_images_per_day" >= 0 AND "studios_key_images_per_day" <= 1000));
  END IF;
END $$;
