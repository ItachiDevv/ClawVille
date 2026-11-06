-- 0095_studios_operations.sql
-- MCP hub phase 3b (2026-11-06): every Studios operation, not images only.
-- Operations: image (wallet + key), video (wallet + key), character_shots
-- (key only), recast (key only). One pipeline for all of them
-- (apps/api/src/services/studios-images.ts + services/vendors/studios-operations.ts).
--
-- vendor_call_requests gains:
--   operation        which Studios operation the row is; existing rows = 'image'.
--   params           the operation's validated input (our own JSON shape; never
--                    vendor text). The approval signs its SHA-256.
--   vendor_job_id    Studios' job id for an asynchronous job (recast), stored
--                    right after the start call, so a restart resumes polling.
--   vendor_media_id  the Studios My Media id a key-mode job reports (reference
--                    only; ClawVille never fetches by it).
--   result           our own result fields (the media id of each character shot).
--   lease_until      a long job's runner renews it while it works; a 'running'
--                    row whose lease ran out belongs to a dead runner and is
--                    recovered (never called or paid again).
--   job_deadline_at  the hard end of a long job (recast polling).
-- Two new statuses:
--   running    a long job (video, recast) runs in the API background runner;
--              the route answered 202 and the agent reads the row.
--   ambiguous  a wallet-mode payment was signed and sent, and its outcome is
--              unknown (the runner died). Terminal for the request; the spend
--              ledger row goes to the existing reconcile path. Never retried.
--
-- avatar_media also stores video (video/mp4, video/webm). The size check now
-- depends on the type: images 1 byte .. 8 MB, videos 1 byte .. 50 MB. The
-- per-avatar total quota (500 MB) is enforced in code before any spend.
--
-- user_spend_policies gains three per-UTC-day counts the human owns, one per
-- operation class, used in key mode AND wallet mode (images keep their
-- key-only count, studios_key_images_per_day). NULL = the default in code
-- (videos 2, character shots 5, recasts 1); 0 turns the class off. A raise
-- needs the linked-wallet signature, like a cap raise. The upper bound is a
-- typo guard, not a product limit.
--
-- Additive and idempotent (the CI runner may apply it twice). The CHECK
-- changes only widen: old code writes only image rows and old statuses.

ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "operation" varchar(32) DEFAULT 'image' NOT NULL;
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "params" jsonb;
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "vendor_job_id" varchar(128);
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "vendor_media_id" varchar(128);
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "result" jsonb;
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "lease_until" timestamp with time zone;
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "job_deadline_at" timestamp with time zone;

ALTER TABLE "vendor_call_requests" DROP CONSTRAINT IF EXISTS "vendor_call_requests_operation_check";
ALTER TABLE "vendor_call_requests" ADD CONSTRAINT "vendor_call_requests_operation_check"
  CHECK ("operation" IN ('image', 'video', 'character_shots', 'recast'));

ALTER TABLE "vendor_call_requests" DROP CONSTRAINT IF EXISTS "vendor_call_requests_status_check";
ALTER TABLE "vendor_call_requests" ADD CONSTRAINT "vendor_call_requests_status_check"
  CHECK ("status" IN ('awaiting_approval', 'pending', 'running', 'done', 'failed', 'ambiguous', 'declined', 'expired'));

-- The runner's recovery pass reads unfinished rows only.
CREATE INDEX IF NOT EXISTS "vendor_call_requests_unfinished_idx"
  ON "vendor_call_requests" ("status", "lease_until") WHERE "status" IN ('pending', 'running');

ALTER TABLE "avatar_media" DROP CONSTRAINT IF EXISTS "avatar_media_mime_check";
ALTER TABLE "avatar_media" ADD CONSTRAINT "avatar_media_mime_check"
  CHECK ("mime_type" IN ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'));

ALTER TABLE "avatar_media" DROP CONSTRAINT IF EXISTS "avatar_media_size_check";
ALTER TABLE "avatar_media" ADD CONSTRAINT "avatar_media_size_check"
  CHECK (
    ("mime_type" LIKE 'image/%' AND octet_length("bytes") BETWEEN 1 AND 8388608)
    OR ("mime_type" LIKE 'video/%' AND octet_length("bytes") BETWEEN 1 AND 52428800)
  );

-- Store new media bytes uncompressed out of line, so a Range request reads
-- only its slice (substring on a compressed value reads all of it). Images and
-- videos are already compressed formats. Catalog-only: existing rows keep
-- their storage; no table rewrite.
ALTER TABLE "avatar_media" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;

ALTER TABLE "user_spend_policies" ADD COLUMN IF NOT EXISTS "studios_videos_per_day" integer;
ALTER TABLE "user_spend_policies" ADD COLUMN IF NOT EXISTS "studios_character_shots_per_day" integer;
ALTER TABLE "user_spend_policies" ADD COLUMN IF NOT EXISTS "studios_recasts_per_day" integer;

ALTER TABLE "user_spend_policies" DROP CONSTRAINT IF EXISTS "user_spend_policies_studios_class_counts_check";
ALTER TABLE "user_spend_policies" ADD CONSTRAINT "user_spend_policies_studios_class_counts_check"
  CHECK (
    ("studios_videos_per_day" IS NULL OR ("studios_videos_per_day" >= 0 AND "studios_videos_per_day" <= 1000))
    AND ("studios_character_shots_per_day" IS NULL OR ("studios_character_shots_per_day" >= 0 AND "studios_character_shots_per_day" <= 1000))
    AND ("studios_recasts_per_day" IS NULL OR ("studios_recasts_per_day" >= 0 AND "studios_recasts_per_day" <= 1000))
  );
