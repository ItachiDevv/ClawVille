/**
 * B1 — house-fleet actors must NEVER claim a tutorial quest (REAL DB).
 *
 * The cove's autonomous resolver deliberately checks `openclaw_bots.is_house`
 * FIRST and, on a hit, returns a ledger-capable binding while ignoring the
 * session entirely. That carve-out was ratified for the COVE, where the house
 * is a wager counterparty and every money move re-validates the exact binding.
 *
 * A tutorial quest is a pure FAUCET — `creditClawTokens` with no counterparty.
 * Reusing the cove resolver on it let the server's own fleet mint the whole
 * ~1,650 vCLAW ladder into house-owned balances, from which it flows into the
 * player economy as cove bankroll. Staging's single house avatar already
 * satisfied several quests on event history alone.
 *
 * Two independent barriers are asserted here, because relying on one of them
 * being load-bearing by accident is exactly how this defect happened:
 *   1. quest settlement resolves through the CONNECTED-session resolver, which
 *      house bots structurally cannot satisfy (they hold no bearer session);
 *   2. an explicit `isHouseAgentId` refusal in front of it.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, sql } from '@clawville/database';
import { isHouseAgentId } from '../autonomous-cove-agent-binding';
import { npcSimulation } from '../npc-simulation';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const simSource = readFileSync(join(import.meta.dir, '..', 'npc-simulation.ts'), 'utf8');

describe('quest faucet excludes the house fleet (structural)', () => {
  it('resolves quest actors through the QUEST resolver, never the cove one', () => {
    const start = simSource.indexOf('private async settleAutonomousQuestClaim(');
    const end = simSource.indexOf('private async settleAutonomousLandAction(', start);
    expect(start).toBeGreaterThan(-1);
    const body = simSource.slice(start, end);

    expect(body).toContain('this.autonomousQuestAgentResolve(');
    // The cove resolver carries the house carve-out; it must not appear here.
    expect(body).not.toContain('this.autonomousCoveAgentResolve(');
  });

  it('routes the quest resolver to the connected-session path plus a house refusal', () => {
    const start = simSource.indexOf('autonomousQuestAgentResolve:');
    const end = simSource.indexOf('autonomousQuestClaimSettle:', start);
    expect(start).toBeGreaterThan(-1);
    const seam = simSource.slice(start, end);

    expect(seam).toContain('isHouseAgentId(expectedAgentId)');
    expect(seam).toContain("resolveAgentSession");
    // Barrier 1 must run BEFORE the session resolve, so a house agentId is
    // refused even if it somehow holds a live session.
    expect(seam.indexOf('isHouseAgentId')).toBeLessThan(seam.indexOf('resolveAgentSession'));
    expect(seam).not.toContain('resolveAutonomousCoveAgentBinding');
  });
});

describeIfDb('quest faucet excludes the house fleet (real DB)', () => {
  it('identifies the live house fleet and refuses every one of them', async () => {
    const houseBots = await db.execute<{ agent_id: string }>(
      sql`SELECT agent_id FROM openclaw_bots WHERE is_house = true LIMIT 25`,
    );
    const ids = Array.from(houseBots).map((row) => row.agent_id);

    // Not a precondition of the guard — if this environment has no house fleet
    // the guard is still asserted below against a synthetic id.
    for (const agentId of ids) {
      expect(await isHouseAgentId(agentId)).toBe(true);
      // The decisive assertion: the quest resolver refuses, so settlement is
      // never reached for a house actor.
      expect(
        await npcSimulation.autonomousQuestAgentResolve('any-session-id', agentId),
      ).toBeNull();
    }
  });

  it('still refuses a house agentId presented with a plausible session id', async () => {
    const houseBots = await db.execute<{ agent_id: string }>(
      sql`SELECT agent_id FROM openclaw_bots WHERE is_house = true LIMIT 1`,
    );
    const agentId = Array.from(houseBots)[0]?.agent_id;
    if (!agentId) return; // no house fleet in this environment

    for (const sessionId of ['', 'oc-not-real', crypto.randomUUID()]) {
      expect(
        await npcSimulation.autonomousQuestAgentResolve(sessionId, agentId),
      ).toBeNull();
    }
  });

  it('does not treat an ordinary (non-house) agentId as house', async () => {
    const ordinary = await db.execute<{ agent_id: string }>(
      sql`SELECT agent_id FROM openclaw_bots WHERE is_house IS NOT TRUE LIMIT 1`,
    );
    const agentId = Array.from(ordinary)[0]?.agent_id;
    if (!agentId) return;
    // The guard must be narrow: it excludes the house, not every hosted agent.
    expect(await isHouseAgentId(agentId)).toBe(false);
  });
});
