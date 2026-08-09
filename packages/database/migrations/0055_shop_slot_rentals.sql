-- Land gamification P5a: recurring SHOP slot rentals. Idempotent DDL; migrate-ci
-- applies the file atomically.
--
-- WHY: the home side got a large one-time giveback (piece fees cut to a third,
-- the Lv2 upgrade made free). Shops fund it. A shop's listing slot is now
-- rented weekly rather than owned outright, and a premium "featured" slot costs
-- more. This is the recurring sink that makes the home reprice affordable to
-- the treasury instead of a permanent hole.
--
-- Two cursors, deliberately separate: `slot_paid_through` governs whether the
-- listing is sellable at all, `featured_paid_through` governs only the premium
-- placement. A shop that can pay for its slot but not its feature keeps
-- selling and quietly loses the feature. `featured` is the owner's standing
-- INTENT; "featured right now" is `featured AND featured_paid_through > now()`.
--
-- Fail-closed refusal SUSPENDS, never deletes: an unaffordable week sets
-- `slot_suspended_at` and leaves the row, the title, and the price untouched.
-- Funding the account un-suspends it on the next sweep.

ALTER TABLE "service_listings"
  ADD COLUMN IF NOT EXISTS "featured" boolean NOT NULL DEFAULT false;
ALTER TABLE "service_listings"
  ADD COLUMN IF NOT EXISTS "slot_paid_through" timestamptz;
ALTER TABLE "service_listings"
  ADD COLUMN IF NOT EXISTS "featured_paid_through" timestamptz;
ALTER TABLE "service_listings"
  ADD COLUMN IF NOT EXISTS "slot_suspended_at" timestamptz;

-- Existing listings are granted the current week rather than being charged
-- retroactively for weeks they were never told about. Guarded so a re-run
-- cannot extend anyone's paid-through a second time.
UPDATE "service_listings"
SET "slot_paid_through" = now() + interval '7 days'
WHERE "slot_paid_through" IS NULL;

-- The sweeper's hot path: due, non-suspended, active listings.
CREATE INDEX IF NOT EXISTS "service_listings_slot_sweep_idx"
  ON "service_listings" ("slot_paid_through")
  WHERE "status" = 'active';

CREATE INDEX IF NOT EXISTS "service_listings_featured_sweep_idx"
  ON "service_listings" ("featured_paid_through")
  WHERE "featured" = true AND "status" = 'active';
