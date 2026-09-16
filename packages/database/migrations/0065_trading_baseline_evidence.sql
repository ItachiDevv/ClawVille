-- Write-once evidence for the fleet equity baseline captured by the arm route.
-- Existing links are unarmed, so this additive nullable column is safe to apply.
ALTER TABLE "clawpump_agent_links"
  ADD COLUMN IF NOT EXISTS "baseline_evidence" jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'clawpump_agent_links_armed_needs_evidence'
      AND conrelid = 'clawpump_agent_links'::regclass
  ) THEN
    ALTER TABLE "clawpump_agent_links"
      ADD CONSTRAINT "clawpump_agent_links_armed_needs_evidence"
      CHECK ("armed" = false OR "baseline_evidence" IS NOT NULL);
  END IF;
END $$;
