-- 0086_floor_arena_house_clawpump.sql: unlink the 5 Trading Floor arena HOUSE agents from the LIVE ClawPump
-- trading agents and queue them for their own NEW private ClawPump agents (founder 2026-10-16).
-- Spec: ops/house-traders/SPEC_house-clawpump-x402_2026-10-16.md (TRAP B, task T2).
-- Why: ensureHouseAgents (apps/api/src/services/floor-arena/engine.ts) seeded house:genesis and house:runner with
-- the live Genesis and Runner ClawPump ids and never updates an existing row. The shared seed now carries null and
-- the permanent deny set FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS (packages/shared/src/constants/floor-arena.ts) holds
-- the live ids. This file clears the live ids from the rows and sets provision_state 'pending' so the D8
-- provisioning path can create the new agents.
-- Schema: no column, index or constraint change (Drizzle mirror packages/database/src/schema/floor-arena.ts is
-- unchanged). The floor_arena_house_facts table and the house add-on-call index come with the feed task, not here.
-- Idempotent and re-run safe:
--   * A house row that holds a LIVE trader id is always cleared, whatever its state (a live id must never stay).
--   * A house row with no ClawPump id moves to 'pending' only from 'none' or 'failed', so a re-run never resets a
--     row that a worker holds ('creating') or that already has its new agent (its id is not a live id).
-- User rows (kind = 'user') are never touched. No DROP. No lock beyond the row locks of the 5 house rows.

UPDATE "floor_arena_agents"
SET "clawpump_agent_id" = NULL,
    "clawpump_wallet" = NULL,
    "provision_state" = 'pending',
    "provision_error" = NULL,
    "provision_attempts" = 0,
    "provision_next_at" = NULL,
    "updated_at" = now()
WHERE "kind" = 'house'
  AND "id" LIKE 'house:%'
  AND (
    "clawpump_agent_id" IN (
      '0f600d73-05a0-4c2e-8215-ab2a770ba192', -- Genesis (live)
      '1a0a153e-cc2c-4b2a-8a38-04e4417ce3c1', -- Runner (live)
      'a7d7c928-1725-4c1d-8d4c-b6eed7af559b'  -- Dip Hunter (live)
    )
    OR ("clawpump_agent_id" IS NULL AND "provision_state" IN ('none', 'failed'))
  );
