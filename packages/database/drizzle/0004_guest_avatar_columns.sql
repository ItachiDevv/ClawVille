-- Guest avatar auto-create (2026-04-23)
-- Additive, non-destructive. Adds:
--   - users.is_guest             (bool, default false, NOT NULL)
--   - users.guest_expires_at     (timestamptz, nullable)
--   - avatars.is_guest              (bool, default false, NOT NULL)
-- Existing rows backfill to is_guest=false via the column DEFAULT.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_guest" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "guest_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "avatars" ADD COLUMN IF NOT EXISTS "is_guest" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Partial index supports the cleanup cron's "expired guests" scan
-- (rare query, but cheap to add — sees only the small guest subset).
CREATE INDEX IF NOT EXISTS "idx_users_guest_expires" ON "users" ("guest_expires_at") WHERE "is_guest" = true;
--> statement-breakpoint
-- Joinless filter helper for the per-activity leaderboard SQL —
-- bots already use isActive=false, guests use is_guest=true.
CREATE INDEX IF NOT EXISTS "idx_avatars_is_guest" ON "avatars" ("is_guest") WHERE "is_guest" = true;
