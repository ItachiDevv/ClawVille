-- Agent-pay daily-cap accounting: only proof-of-no-broadcast rows are exempt.
-- Nullable by design: NULL/false count fail-closed for historical and uncertain rows.

ALTER TABLE "agent_payments"
  ADD COLUMN IF NOT EXISTS "cap_exempt" boolean;
