-- 0096_studios_signin_mode.sql
-- MCP hub phase 3c, part 2 (2026-11-06): every Studios operation can run
-- through the human's Studios sign-in (OAuth + the Studios MCP server).
--
-- user_spend_policies.studios_pay_mode: who pays for a Studios call, chosen by
-- the human. NULL keeps the earlier rule (the saved Studios key when there is
-- one, else the avatar wallet). 'wallet' = the avatar wallet (x402),
-- 'key' = the saved Studios API key, 'signin' = the Studios sign-in. A mode
-- that is not usable refuses (studios_key_missing, studios_signin_missing,
-- studios_signin_broken); there is no silent fallback. Any change needs the
-- linked-wallet signature (services/spend-policy.ts).
--
-- vendor_call_requests.mode and avatar_media.mode gain 'signin'. Row mode
-- 'account' stays the saved Studios key (policy 'key'); historical rows are
-- not renamed. A sign-in row keeps SHA-256 of the sign-in link id in
-- credential_sha256, so an approval or a long job refuses when the human
-- signed in again (maybe to another Studios account) after the request.
--
-- Additive and idempotent (the CI runner may apply it twice). The CHECK
-- changes only widen: old code writes only 'wallet' and 'account'.

ALTER TABLE "user_spend_policies" ADD COLUMN IF NOT EXISTS "studios_pay_mode" varchar(16);

ALTER TABLE "user_spend_policies" DROP CONSTRAINT IF EXISTS "user_spend_policies_studios_pay_mode_check";
ALTER TABLE "user_spend_policies" ADD CONSTRAINT "user_spend_policies_studios_pay_mode_check"
  CHECK ("studios_pay_mode" IS NULL OR "studios_pay_mode" IN ('wallet', 'key', 'signin'));

ALTER TABLE "vendor_call_requests" DROP CONSTRAINT IF EXISTS "vendor_call_requests_mode_check";
ALTER TABLE "vendor_call_requests" ADD CONSTRAINT "vendor_call_requests_mode_check"
  CHECK ("mode" IN ('wallet', 'account', 'signin'));

ALTER TABLE "avatar_media" DROP CONSTRAINT IF EXISTS "avatar_media_mode_check";
ALTER TABLE "avatar_media" ADD CONSTRAINT "avatar_media_mode_check"
  CHECK ("mode" IN ('wallet', 'account', 'signin'));
