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
// The REAL shared building-center guard used by /visit-building, /building/:id/chat
// and /move — imported from its dependency-free module so F1 exercises the ACTUAL
// money-path guard (not a copy) without dragging the agent-gateway route graph
// (which throws at module load without FINGERPRINT_SECRET) into the test env.
import { resolveBuildingCenter, resolveBuildingId } from '../building-center';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';

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
      // Gate now measures EDGE distance. api-integrations has an 850+28 wu
      // half-extent, so this must clear the footprint edge by > RADIUS: +2500
      // from center ⇒ ~1622 wu from the edge, unambiguously gated.
      center.x + 2500,
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

  it('PASSES at a large building where the OLD center-distance gate was unsatisfiable (the fix)', () => {
    // api-integrations footprint half-extent ≈ 878 wu. A body standing just off
    // the footprint edge sits ~1050 wu from CENTER — the OLD `distToCenter <=
    // 1000` gate would WRONGLY drop it (the pathfinder can't get closer than the
    // collider edge, so the building was un-interactable). Edge-distance (~172 wu
    // here) passes, which is the bug fix.
    const sim = asSim();
    const center = NPC_BUILDING_CENTERS[TARGET];
    const distFromCenter = 1050;
    expect(distFromCenter).toBeGreaterThan(BUILDING_INTERACTION_RADIUS); // old gate WOULD have dropped it
    const npc = registerBody('ocb-edge', 'oc-edge', 'nanoclaw', center.x + distFromCenter, center.y);
    sim.pendingEvents = [];
    sim.executeHatcherAction('ocb-edge', npc, 'talk_to_npc', { buildingId: TARGET, message: 'hello teacher' });
    expect(sim.pendingEvents.length).toBe(1); // edge-distance ≪ RADIUS → passes
    expect(sim.pendingEvents[0].type).toBe('agent_chat');
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

  // NO-MONEY INVARIANT (P1 slice 4 is DEFERRED): the driver + the [ACTION:]
  // executor must NOT settle any CT. Proven structurally + behaviorally — the
  // executor switch (move/emote/enter_building/enter_cove/talk_to_npc) has ZERO
  // ledger dependency: enter_building/move/emote only mutate in-world path/activity
  // (emit NO event), and talk emits exactly one `agent_chat` speech bubble. So the
  // ONLY event a decide→enter_building→talk turn can produce is `agent_chat` —
  // never a settlement/token event. Locks the invariant so slice 4 can only add
  // money through the authed, session-bound ledger path, never the action parser.
  it('driver + executor settle ZERO CT during a decide → enter_building → talk turn (no-money invariant)', async () => {
    const bodyId = 'ocb-nomoney';
    const sessionId = 'oc-nomoney';
    const target = 'api-integrations'; // a real teaching building
    const sim = asSim();
    const center = NPC_BUILDING_CENTERS[target];
    // Body placed INSIDE the radius so the proximity gate PASSES the talk — the
    // richest side-effect path in the P1 loop; if a reward existed, it would fire
    // here. The sim interval is stopped (beforeEach), so the body stays put.
    registerBody(bodyId, sessionId, 'nanoclaw', center.x + (BUILDING_INTERACTION_RADIUS - 100), center.y);
    agentAutonomyDriver.registerHouseAgent({
      agentId: bodyId,
      bodyId,
      platformAgentId: 'pa-nomoney',
      systemUserId: 'sys-nomoney',
    });
    sim.pendingEvents = [];
    try {
      // A full decide turn (LLM stub → enter_building; no ledger, no event) …
      await agentAutonomyDriver.driveOnce(
        bodyId,
        async () => `Learning. [ACTION: enter_building(buildingId=${target})]`,
      );
      // … then a near talk through the REAL executor (emits its speech bubble).
      sim.executeHatcherAction(bodyId, sim.getNpcById(bodyId), 'talk_to_npc', {
        buildingId: target,
        message: 'teach me about integrations',
      });
      expect(sim.pendingEvents.length).toBeGreaterThan(0); // the talk actually ran
      for (const ev of sim.pendingEvents) {
        // Speech only — never a settlement/token event. (If the executor ever
        // touched claw-token-ledger it would also throw here in the DB-less test
        // env, so a clean pass is a second, implicit no-money proof.)
        expect(ev.type).toBe('agent_chat');
      }
    } finally {
      agentAutonomyDriver.unregisterHouseAgent(bodyId);
    }
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

describe('F1 — resolveBuildingCenter prototype-key guard (real-CT money path)', () => {
  // A prototype key ("constructor"/"__proto__"/"toString"/"hasOwnProperty"/…) is
  // TRUTHY under bare bracket access but is NOT an own property. A pre-fix
  // `const center = NPC_BUILDING_CENTERS[id]; if (!center)` truthy guard admitted
  // it, then `dx = npc.x - center.x` = `n - undefined` = NaN, and
  // `NaN > BUILDING_INTERACTION_RADIUS` is FALSE → the proximity check was SKIPPED
  // → the real-CT building credit fired FROM ANYWHERE (a CT farm). The fix is the
  // shared `resolveBuildingCenter` (Object.hasOwn own-property lookup) used by
  // /visit-building, /building/:id/chat AND /move so all three share ONE guard.
  // These assertions exercise the REAL exported helper, not an inline re-impl.
  it('resolveBuildingCenter returns null for prototype keys (credit path unreachable)', () => {
    expect(resolveBuildingCenter('constructor')).toBeNull();
    expect(resolveBuildingCenter('__proto__')).toBeNull();
    expect(resolveBuildingCenter('toString')).toBeNull();
    expect(resolveBuildingCenter('hasOwnProperty')).toBeNull();
  });

  it('resolveBuildingCenter returns real coords for a genuine buildingId', () => {
    const realId = Object.keys(NPC_BUILDING_CENTERS)[0];
    const center = resolveBuildingCenter(realId);
    expect(center).not.toBeNull();
    expect(typeof center!.x).toBe('number');
    expect(typeof center!.y).toBe('number');
    expect(center).toEqual(NPC_BUILDING_CENTERS[realId]);
  });

  it('demonstrates WHY the guard matters: a bare proto key yields a NaN distance the > RADIUS check cannot reject', () => {
    const proto = NPC_BUILDING_CENTERS as unknown as Record<string, { x: number; y: number } | undefined>;
    // Bare bracket access on a prototype key IS truthy (what the old guard saw)…
    expect(proto.constructor).toBeTruthy();
    // …and yields a NaN distance the `> RADIUS` check can never reject:
    const dx = 11264 - ((proto.constructor as unknown as { x?: number }).x as number); // n - undefined = NaN
    expect(Number.isNaN(dx)).toBe(true);
    expect(NaN > BUILDING_INTERACTION_RADIUS).toBe(false); // proximity NOT rejected
    // …which is exactly why the shared guard returns null for such keys (→ 400, the
    // real-CT credit is NEVER reached):
    expect(resolveBuildingCenter('constructor')).toBeNull();
  });
});

describe('resolveBuildingId — label-tolerant slug resolution (dropped-decide-tick fix)', () => {
  // The autonomy/Hatcher perception lists each building as "<label> [<slug>]".
  // The LLM usually emits the slug, but occasionally the human LABEL instead
  // (observed live: `enter_building(buildingId=Chum Bucket)` → a dropped tick).
  // resolveBuildingId maps EITHER form to the canonical slug, and — like
  // resolveBuildingCenter — never resolves an inherited prototype key.
  it('passes a genuine slug through unchanged', () => {
    const slug = Object.keys(NPC_BUILDING_CENTERS)[0];
    expect(resolveBuildingId(slug)).toBe(slug);
  });

  it('resolves a human label to its canonical slug', () => {
    // code-development ⇔ "Chum Bucket" is the exact live-observed miss.
    expect(resolveBuildingId('Chum Bucket')).toBe('code-development');
    // Every themed teaching building resolves by its label.
    for (const slug of Object.keys(NPC_BUILDING_CENTERS)) {
      const label = BUILDING_OPENCLAW_THEMES[slug]?.label;
      if (label) expect(resolveBuildingId(label)).toBe(slug);
    }
  });

  it('is case/punctuation-insensitive for labels and slugs', () => {
    expect(resolveBuildingId('chum bucket')).toBe('code-development');
    expect(resolveBuildingId('  CHUM-BUCKET  ')).toBe('code-development');
    expect(resolveBuildingId('CODE_DEVELOPMENT')).toBe('code-development');
  });

  it('returns null for prototype keys and unknown targets (no CT-farm alias)', () => {
    expect(resolveBuildingId('constructor')).toBeNull();
    expect(resolveBuildingId('__proto__')).toBeNull();
    expect(resolveBuildingId('toString')).toBeNull();
    expect(resolveBuildingId('hasOwnProperty')).toBeNull();
    expect(resolveBuildingId('not-a-building')).toBeNull();
    expect(resolveBuildingId('')).toBeNull();
    expect(resolveBuildingId(null)).toBeNull();
    expect(resolveBuildingId(undefined)).toBeNull();
  });

  it('only ever returns an own-property teaching-building slug', () => {
    const resolved = resolveBuildingId('Chum Bucket');
    expect(resolved).not.toBeNull();
    expect(Object.hasOwn(NPC_BUILDING_CENTERS, resolved!)).toBe(true);
  });
});
