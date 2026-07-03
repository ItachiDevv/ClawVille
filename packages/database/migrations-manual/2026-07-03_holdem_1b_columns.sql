-- Cove Hold'em Increment 1b — deal-replay + close-replay idempotency columns.
--
-- Purely ADDITIVE (two new nullable columns + one partial unique index on an
-- EXISTING table). Safe to re-run (every statement is IF NOT EXISTS). Apply via
-- `packages/database/scripts/apply-holdem-1b-columns.ts`, NEVER `db:push`
-- (drizzle-kit push force-drops tables/columns not present in the running
-- checkout's schema — see CLAUDE.md "Drizzle-Kit Introspection Bug").

-- `holdem_hands.deal_idempotency_key` — the client's Idempotency-Key on
-- POST /hand/deal, kept SEPARATE from the existing settle-replay
-- `idempotency_key` column (which is overwritten at settle) so deal-replay
-- never collides with or couples to the terminal-settle machinery.
ALTER TABLE holdem_hands ADD COLUMN IF NOT EXISTS deal_idempotency_key text;

-- Race-safe backstop for two concurrent first-deals reusing the same key on
-- the same table (defense-in-depth; the table's FOR UPDATE lock already
-- serializes this in practice).
CREATE UNIQUE INDEX IF NOT EXISTS holdem_hands_table_deal_idem_unique
  ON holdem_hands (table_id, deal_idempotency_key)
  WHERE deal_idempotency_key IS NOT NULL;

-- `holdem_tables.cash_out` — the stringified-bigint amount cashed out at
-- POST /session/close, persisted so a close-replay (table already 'closed',
-- same owner re-POSTs) can reconstruct the ORIGINAL response without
-- re-crediting. playerStack is zeroed at close, so without this column the
-- cashed-out figure would be unrecoverable for a replay.
ALTER TABLE holdem_tables ADD COLUMN IF NOT EXISTS cash_out text;
