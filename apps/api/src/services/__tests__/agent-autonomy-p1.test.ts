/**
 * Agent-metaverse P1 (slices 1 + 3) — proximity gate + autonomy driver.
 *
 * Covers the three assertions the P1 plan requires:
 *   (i)   the proximity gate DROPS a far `talk_to_npc` and PASSES a near one
 *         for a non-hatcher-proxy body (the house/fleet agent path);
 *   (ii)  a hatcher-proxy body is NEVER gated (the live-partner exemption);
 *   (iii) the driver picks a teacher (prompt lists teachers) and emits an
 *         `enter_building` [ACTION:] that walks the body toward the choice.
 *
 * Uses the `npcSimulation` singleton via the `as any` escape hatch (same
 * pattern as npc-overlap-deadlock.test.ts) — the gate lives inside the private
 * `executeHatcherAction`, not worth exposing publicly just for the test.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { NPC_BUILDING_CENTERS, BUILDING_INTERACTION_RADIUS } from '@clawville/shared';
import { npcSimulation } from '../npc-simulation';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import { buildHouseAvatarConfig } from '../house-agent-seeder';
import { agentOrchestrator } from '../agent-orchestrator';

type Sim = {
  npcs: Map<string, any>;
  openClawBots: Map<string, any>;
  npcOverrides: Map<string, string>;
  pendingEvents: any[];
  initNpcs: () => void;
  executeHatcherAction: (
    npcId: string,
    npc: any,
    name: string,
    params: Record<string, string>,
  ) => void;
  getNpcById: (id: string) => any;
};

const asSim = () => npcSimulation as unknown as Sim;

/** A body with every field buildPerception + executeHatcherAction read. */
function makeBody(id: string, x: number, y: number) {
  return {
    id,
    name: 'TestAgent',
    x,
    y,
    hp: 100,
    maxHp: 100,
    level: 1,
    kills: 0,
    xp: 0,
    inventory: [] as string[],
    activity: 'idle',
    activityEmoji: '',
    inCombat: false,
    isDead: false,
    combatAction: null,
    direction: 'idle',
    species: 'milady_official_1',
    isOpenClaw: true,
    // Default server-managed; N4 tests override to 'self-managed' where needed.
    autonomyMode: 'server-managed' as 'server-managed' | 'self-managed' | 'native',
    // Fields the ambient-conversation partner filters read (getIdleAliveNpcs /
    // findNearestIdleNpc) — default to "eligible" so a test body is selectable
    // unless it is deliberately excluded (dead / in-conversation / self-managed).
    inConversation: false,
    conversationCooldownUntil: 0,
    invulnerableUntil: 0,
    path: [] as Array<{ x: number; y: number }>,
    pathIndex: 0,
    destinationBuildingId: null as string | null,
    behaviorCooldown: 0,
  };
}

/** Register a body + a fake OpenClaw client with the given wire protocol. */
function registerBody(bodyId: string, sessionId: string, protocol: string, x: number, y: number) {
  const sim = asSim();
  const npc = makeBody(bodyId, x, y);
  sim.npcs.set(bodyId, npc);
  sim.openClawBots.set(sessionId, {
    config: { agentId: bodyId, mode: 'avatar' },
    client: { getProtocol: () => protocol },
  });
  sim.npcOverrides.set(bodyId, sessionId);
  return npc;
}

beforeEach(() => {
  const sim = asSim();
  // Stop any live 200ms sim interval a prior test FILE may have left running —
  // an active tick would race our async driveOnce (move the body or clear its
  // destination between dispatch and assertion). stop() also clears the npc
  // maps; we re-seed immediately below. Singletons are shared across the whole
  // `bun test` process, so this isolation is mandatory, not defensive.
  (npcSimulation as unknown as { stop: () => void }).stop();
  sim.initNpcs();
  sim.openClawBots.clear();
  sim.npcOverrides.clear();
  sim.pendingEvents = [];
  // Reset the shared autonomy-driver registry so a leaked entry from a prior
  // test can't perturb the count or behavior.
  for (const id of agentAutonomyDriver.getHouseAgentIds()) {
    agentAutonomyDriver.unregisterHouseAgent(id);
  }
});

const TARGET = 'api-integrations';

describe('P1 proximity gate — executeHatcherAction talk_to_npc', () => {
  it('DROPS a far talk_to_npc for a non-hatcher-proxy body', () => {
    const sim = asSim();
    const center = NPC_BUILDING_CENTERS[TARGET];
    const npc = registerBody(
      'ocb-far',
      'oc-far',
      'nanoclaw',
      center.x + BUILDING_INTERACTION_RADIUS + 500, // beyond the radius
      center.y,
    );
    sim.pendingEvents = [];
    sim.executeHatcherAction('ocb-far', npc, 'talk_to_npc', {
      buildingId: TARGET,
      message: 'hello teacher',
    });
    expect(sim.pendingEvents.length).toBe(0); // gated → no chat bubble
  });

  it('PASSES a near talk_to_npc for a non-hatcher-proxy body', () => {
    const sim = asSim();
    const center = NPC_BUILDING_CENTERS[TARGET];
    const npc = registerBody(
      'ocb-near',
      'oc-near',
      'nanoclaw',
      center.x + (BUILDING_INTERACTION_RADIUS - 200), // inside the radius
      center.y,
    );
    sim.pendingEvents = [];
    sim.executeHatcherAction('ocb-near', npc, 'talk_to_npc', {
      buildingId: TARGET,
      message: 'hello teacher',
    });
    expect(sim.pendingEvents.length).toBe(1);
    expect(sim.pendingEvents[0].type).toBe('agent_chat');
    expect(sim.pendingEvents[0].data.message).toBe('hello teacher');
  });

  it('does NOT gate a hatcher-proxy body (far still passes — live-partner exemption)', () => {
    const sim = asSim();
    const center = NPC_BUILDING_CENTERS[TARGET];
    const npc = registerBody(
      'ocb-hat',
      'oc-hat',
      'hatcher-proxy',
      center.x + BUILDING_INTERACTION_RADIUS + 5000, // very far
      center.y,
    );
    sim.pendingEvents = [];
    sim.executeHatcherAction('ocb-hat', npc, 'talk_to_npc', {
      buildingId: TARGET,
      message: 'hello teacher',
    });
    expect(sim.pendingEvents.length).toBe(1); // exempt → passes despite distance
    expect(sim.pendingEvents[0].type).toBe('agent_chat');
  });
});

describe('P1 autonomy driver — decide → enter_building', () => {
  it('picks a teacher (prompt lists teachers) and emits an enter_building action', async () => {
    const bodyId = 'ocb-house-test';
    const sessionId = 'oc-house-test';
    const chosen = 'messaging-channels'; // a real teaching building
    // Town center — buildPerception reads the body's pose + ALL 10 buildings.
    registerBody(bodyId, sessionId, 'nanoclaw', 11264, 11264);
    agentAutonomyDriver.registerHouseAgent({
      agentId: bodyId,
      bodyId,
      platformAgentId: 'pa-house-test',
      systemUserId: 'sys-house-test',
    });

    // Spy on the sim's action executor so the assertion tests the DRIVER's
    // contract — perceive → decide → FORWARD the [ACTION:] reply — independent of
    // the sim's A* pathfinding (a separately-tested concern; the proximity-gate
    // tests above drive the REAL executor). We still delegate to the real
    // dispatch so the executor runs end-to-end (its walk outcome depends on A*
    // and is not what THIS unit asserts).
    const dispatched: Array<{ npcId: string; reply: string }> = [];
    const realDispatch = npcSimulation.dispatchHatcherActions.bind(npcSimulation);
    (npcSimulation as unknown as { dispatchHatcherActions: unknown }).dispatchHatcherActions = (
      npcId: string,
      reply: string,
    ) => {
      dispatched.push({ npcId, reply });
      return realDispatch(npcId, reply);
    };

    try {
      let capturedPrompt = '';
      await agentAutonomyDriver.driveOnce(bodyId, async (prompt) => {
        capturedPrompt = prompt;
        return `I want to learn messaging. [ACTION: enter_building(buildingId=${chosen})]`;
      });

      // The decision prompt presented teacher options (need-based choice) + the tag.
      expect(capturedPrompt.toLowerCase()).toContain('teacher');
      expect(capturedPrompt).toContain('enter_building');
      expect(capturedPrompt).toContain(chosen);

      // The driver FORWARDED exactly the enter_building action to the executor.
      expect(dispatched.length).toBe(1);
      expect(dispatched[0].npcId).toBe(bodyId);
      expect(dispatched[0].reply).toContain(`enter_building(buildingId=${chosen})`);
    } finally {
      (npcSimulation as unknown as { dispatchHatcherActions: unknown }).dispatchHatcherActions =
        realDispatch;
    }

    expect(agentAutonomyDriver.getHouseAgentIds()).toContain(bodyId);
    agentAutonomyDriver.unregisterHouseAgent(bodyId);
  });

  it('registry is bounded and register/unregister round-trips', () => {
    agentAutonomyDriver.registerHouseAgent({
      agentId: 'ocb-a',
      bodyId: 'ocb-a',
      platformAgentId: 'pa-a',
      systemUserId: 'sys-a',
    });
    expect(agentAutonomyDriver.hasHouseAgent('ocb-a')).toBe(true);
    agentAutonomyDriver.unregisterHouseAgent('ocb-a');
    expect(agentAutonomyDriver.hasHouseAgent('ocb-a')).toBe(false);
  });

  // Boot-timing robustness (2026-07-01 staging bug): the seeder no longer warms
  // the ElizaOS runtime at boot (that raced a 30s plugin-init timeout in the boot
  // crush and could leave the agent bodyless). The driver LAZY-warms on tick:
  // when the runtime isn't ready it must call
  // ensureAgentRuntime(platformAgentId, systemUserId, {isHouse:true}) — preserving
  // the inactivity-sweep exemption — and NOT drive; the `warming` overlap guard
  // must prevent a second concurrent warm on the next tick.
  it('lazy-warms the runtime on tick when the brain is not ready, preserving isHouse (boot-timing)', () => {
    const orch = agentOrchestrator as unknown as {
      getRunningAgentRuntime: (id: string) => unknown;
      ensureAgentRuntime: (id: string, userId?: string, opts?: { isHouse?: boolean }) => Promise<unknown>;
    };
    const realGet = orch.getRunningAgentRuntime;
    const realEnsure = orch.ensureAgentRuntime;
    const ensureCalls: Array<[string, string | undefined, { isHouse?: boolean } | undefined]> = [];
    orch.getRunningAgentRuntime = () => null; // brain never ready in this test
    orch.ensureAgentRuntime = async (id, userId, opts) => {
      ensureCalls.push([id, userId, opts]);
      return null;
    };
    try {
      agentAutonomyDriver.registerHouseAgent({
        agentId: 'ocb-warm',
        bodyId: 'ocb-warm',
        platformAgentId: 'pa-warm',
        systemUserId: 'sys-warm',
      });
      // Two synchronous ticks: the overlap guard must launch EXACTLY one warm.
      (agentAutonomyDriver as unknown as { tick: () => void }).tick();
      (agentAutonomyDriver as unknown as { tick: () => void }).tick();
      expect(ensureCalls.length).toBe(1);
      expect(ensureCalls[0]).toEqual(['pa-warm', 'sys-warm', { isHouse: true }]);
    } finally {
      agentAutonomyDriver.unregisterHouseAgent('ocb-warm');
      orch.getRunningAgentRuntime = realGet;
      orch.ensureAgentRuntime = realEnsure;
    }
  });
});

describe('P1 house agent config + ambient-conversation exclusion', () => {
  // B1 regression guard: the seeder must register the in-world body as
  // 'self-managed' so the 200ms sim planner leaves it to the autonomy driver.
  it("house avatar config registers the body as self-managed (B1)", () => {
    const cfg = buildHouseAvatarConfig('oc-house-cfg', 'milady_official_1');
    expect(cfg.autonomyMode).toBe('self-managed');
    expect(cfg.protocol).toBe('nanoclaw');
    expect(cfg.mode).toBe('avatar');
  });

  // N4 guard: a self-managed OpenClaw body is never picked as an ambient
  // NPC↔NPC conversation partner, while a server-managed (Hatcher-like) body
  // still is — proving the exclusion is scoped and does not regress Hatcher.
  it('excludes a self-managed OpenClaw body from ambient-conversation selection, not a server-managed one (N4)', () => {
    const sim = asSim() as unknown as {
      npcs: Map<string, any>;
      getIdleAliveNpcs: () => any[];
      findNearestIdleNpc: (npc: any, maxDist: number) => any | null;
    };
    // Isolate to our 3 bodies so nearest-partner selection is deterministic
    // (initNpcs seeds the default roster in beforeEach).
    sim.npcs.clear();
    const seeker = makeBody('npc-seeker', 11264, 11264);
    const houseBody = makeBody('ocb-selfmanaged', 11314, 11264); // NEARER (50 wu)
    houseBody.autonomyMode = 'self-managed';
    const hatcherBody = makeBody('ocb-servermanaged', 11164, 11264); // farther (100 wu)
    hatcherBody.autonomyMode = 'server-managed';
    sim.npcs.set(seeker.id, seeker);
    sim.npcs.set(houseBody.id, houseBody);
    sim.npcs.set(hatcherBody.id, hatcherBody);

    const idleIds = sim.getIdleAliveNpcs().map((n) => n.id);
    expect(idleIds).not.toContain('ocb-selfmanaged'); // self-managed excluded
    expect(idleIds).toContain('ocb-servermanaged'); // Hatcher (server-managed) unaffected

    // Even though the self-managed body is NEARER, the partner search skips it
    // and returns the server-managed body — proving the exclusion is scoped.
    const partner = sim.findNearestIdleNpc(seeker, 5000);
    expect(partner?.id).toBe('ocb-servermanaged');
  });
});
