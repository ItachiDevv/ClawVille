/**
 * Hatcher partner P5-2 in-memory primitive tests (Codex pass-5, 2026-06-12).
 *
 * These run against the REAL `npcSimulation` singleton (NO DB, NO network) to
 * prove the two npc-simulation behaviours the P5-2 route fix relies on:
 *
 *   1. TRIGGER — `registerOpenClaw` THROWS when an override target NPC is already
 *      overridden. That throw is exactly what the register/PATCH override paths now
 *      catch to roll the DB write back and return a 503 (instead of ok:true +
 *      spawned:false handing the partner a bearer for a body that never appeared).
 *
 *   2. RECOVERY — a failed override re-register can RESTORE the prior body from a
 *      snapshot (config + client) captured BEFORE teardown, so a failed override
 *      PATCH leaves the agent's previous working session intact (no orphan).
 *
 * The full handler-driven (stubbed-db) cases that assert the HTTP 503 + held-tx
 * span live in `partner-hatcher-p5-handler.test.ts` (which mocks
 * `@clawville/database`, so it is a separate file to avoid mock cross-talk with
 * the real-module imports here).
 */

import { describe, it, expect, beforeAll } from 'bun:test';

describe('Hatcher P5-2 — in-memory override-occupied + restore primitives', () => {
  let sim: typeof import('../../services/npc-simulation');
  let NPC_IDS: string[];

  beforeAll(async () => {
    sim = await import('../../services/npc-simulation');
    const shared = await import('@clawville/shared');
    NPC_IDS = shared.NPC_IDS as string[];
    sim.startSimulation(false);
  });

  class MockClient {
    getProtocol() { return 'hatcher-proxy' as const; }
    setWorldStateProvider() {}
    setSystemContextProvider() {}
  }

  function overrideConfig(agentId: string, sessionId: string, targetNpcId: string) {
    return {
      agentId, sessionId, sessionKey: sessionId, gatewayUrl: 'http://localhost:0',
      authToken: '', protocol: 'hatcher-proxy', mode: 'override',
      autonomyMode: 'server-managed', targetNpcId, ledgerCapable: true, boundUserId: null,
    } as unknown as Parameters<typeof sim.npcSimulation.registerOpenClaw>[0];
  }

  it('registerOpenClaw throws the TYPED OverrideTargetUnavailableError when the target is occupied (P5-2 trigger; nit #1 sentinel)', () => {
    const target = NPC_IDS[1];
    const aSid = 'p5-occupant-A';
    sim.npcSimulation.registerOpenClaw(
      overrideConfig('hatcher:occupant-A', aSid, target),
      new MockClient() as never,
    );
    // A DIFFERENT agent attempting the SAME target must throw the TYPED sentinel
    // (not a bare Error) so the partner-hatcher 409-vs-503 split keys on
    // `instanceof`, never a message-string regex that could silently degrade.
    let caught: unknown;
    try {
      sim.npcSimulation.registerOpenClaw(
        overrideConfig('hatcher:intruder-B', 'p5-intruder-B', target),
        new MockClient() as never,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(sim.OverrideTargetUnavailableError);
    expect((caught as InstanceType<typeof sim.OverrideTargetUnavailableError>).targetNpcId).toBe(target);
    sim.npcSimulation.unregisterOpenClaw(aSid);
  });

  it('a failed override re-register can RESTORE the prior body from the captured snapshot (P5-2 PATCH path)', () => {
    const target = NPC_IDS[2];
    const agentId = 'hatcher:patch-restore';
    const oldSid = 'p5-old-session';
    const oldCfg = overrideConfig(agentId, oldSid, target);
    const oldClient = new MockClient();
    sim.npcSimulation.registerOpenClaw(oldCfg, oldClient as never);

    // Capture config+client BEFORE teardown (exactly what the PATCH handler does
    // so it can restore on a re-register failure).
    const liveSessions = sim.npcSimulation.findActiveSessionsByAgentIds([agentId]);
    expect(liveSessions).toContain(oldSid);
    const snap = liveSessions.map((sid) => ({
      config: sim.npcSimulation.getOpenClawBotConfig(sid)!,
      client: sim.npcSimulation.getOpenClawClientBySession(sid)!,
    }));
    expect(snap[0].config).toBeTruthy();
    expect(snap[0].client).toBeTruthy();

    // Tear down (PATCH unregisters the old body before re-register).
    for (const sid of liveSessions) sim.npcSimulation.unregisterOpenClaw(sid);
    expect(sim.npcSimulation.findActiveSessionsByAgentIds([agentId])).toHaveLength(0);

    // Occupy the target with someone ELSE so the agent's re-register would fail.
    const blockerSid = 'p5-blocker';
    sim.npcSimulation.registerOpenClaw(
      overrideConfig('hatcher:blocker', blockerSid, target),
      new MockClient() as never,
    );

    // Re-register the agent's NEW body fails (target occupied by the blocker).
    expect(() =>
      sim.npcSimulation.registerOpenClaw(
        overrideConfig(agentId, 'p5-new-session', target),
        new MockClient() as never,
      ),
    ).toThrow();

    // Free the blocker's slot so the restore can re-take the agent's prior body.
    sim.npcSimulation.unregisterOpenClaw(blockerSid);

    // RESTORE the prior body from the captured snapshot.
    for (const s of snap) sim.npcSimulation.registerOpenClaw(s.config, s.client as never);
    // The agent's prior session is live again — not orphaned.
    expect(sim.npcSimulation.findActiveSessionsByAgentIds([agentId])).toContain(oldSid);

    sim.npcSimulation.unregisterOpenClaw(oldSid);
  });
});
