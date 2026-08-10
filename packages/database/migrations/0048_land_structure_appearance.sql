ALTER TABLE "land_structures"
  ADD COLUMN IF NOT EXISTS "shell_key" text;

ALTER TABLE "land_structures"
  ADD COLUMN IF NOT EXISTS "palette_key" text;

-- Deterministic compatibility backfill: existing structures retain the exact
-- coastal/classic appearance rendered before P1. The NULL predicates keep a
-- migration retry from overwriting a choice already made by the new binary.
UPDATE "land_structures"
SET "shell_key" = 'coastal-cottage'
WHERE "shell_key" IS NULL;

UPDATE "land_structures"
SET "palette_key" = 'classic'
WHERE "palette_key" IS NULL;

-- FOLLOW-UP: after the P1 binary is live everywhere, add NOT NULL constraints
-- for shell_key and palette_key in a separate migration and later push.
