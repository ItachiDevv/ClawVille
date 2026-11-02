/**
 * Hydra in the NPC simulation (npc-simulation.ts):
 *   - talk_to_npc(npcId=hydra-analyst) near Hydra → the agent's bubble, Hydra's
 *     answer bubble, and one `Hydra: ...` action-result line for the hosted
 *     brain (Rule E5 parity with the human Talk bar);
 *   - a far talk is gated (no reply call), another wanderer never answers;
 *   - ambient muttering: template line only while watched, jittered cadence,
 *     one fetch at a time, a failure never escapes;
 *   - an agent_chat event pushed BETWEEN ticks rides the next broadcast.
 *
 * No network, no DB: the Hydra reply, ambient-line source, action-result sink
 * and covenant recorder are the sim's own test seams.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { BUILDING_INTERACTION_RADIUS } from '@clawville/shared';
import { npcSimulation } from '../npc-simulation';
import { HYDRA_NPC_ID } from '../hydra-coin-chatter';

type Attribution = {
  avatarId: string;
  agentId: string;
  sessionId: string;
  actorKind: 'agent';
  directiveId: string | null;
  directiveOrdinal: number | null;
};

type Sim = {
  npcs: Map<string, any>;
  agentBotSessions: Map<string, any>;
  npcOverrides: Map<string, string>;
  pendingEvents: Array<{ type: string; npcId: string; data: { message: string } }>;
  listeners: Set<(json: string) => void>;
  lastWatchedAt: number;
  hydraNextMutterAt: number;
  hydraMutterInFlight: boolean;
  hydraMutterFailureLogged: boolean;
  initNpcs: () => void;
  stop: () => void;
  tick: () => void;
  maybeHydraMutter: (now?: number) => void;
  executeHatcherAction: (
    npcId: string,
    npc: any,
    name: string,
    params: Record<string, string>,
    attribution?: Attribution | null,
  ) => void;
  hydraAgentReply: typeof npcSimulation.hydraAgentReply;
  hydraAmbientLineSource: typeof npcSimulation.hydraAmbientLineSource;
  autonomousActionResult: typeof npcSimulation.autonomousActionResult;
  covenantRecord: typeof npcSimulation.covenantRecord;
};

const asSim = () => npcSimulation as unknown as Sim;

const original = {
  hydraAgentReply: npcSimulation.hydraAgentReply,
  hydraAmbientLineSource: npcSimulation.hydraAmbientLineSource,
  autonomousActionResult: npcSimulation.autonomousActionResult,
  covenantRecord: npcSimulation.covenantRecord,
};

const ATTR: Attribution = {
  avatarId: 'avatar-1',
  agentId: 'agent-1',
  sessionId: 'sess-1',
  actorKind: 'agent',
  directiveId: null,
  directiveOrdinal: null,
};

function makeBody(id: string, x: number, y: number) {
  return {
    id, name: 'TestAgent', x, y, hp: 100, maxHp: 100, level: 1, kills: 0, xp: 0,
    inventory: [] as string[], activity: 'idle', activityEmoji: '', inCombat: false,
    isDead: false, combatAction: null, direction: 'idle', species: 'milady_official_1',
    isOpenClaw: true, autonomyMode: 'server-managed', inConversation: false,
    conversationCooldownUntil: 0, invulnerableUntil: 0, path: [] as Array<{ x: number; y: number }>,
    pathIndex: 0, destinationBuildingId: null as string | null, behaviorCooldown: 0,
  };
}

/** A gated (non-Hatcher) agent body standing `offset` wu east of Hydra. */
function agentNearHydra(offset: number) {
  const sim = asSim();
  const hydra = sim.npcs.get(HYDRA_NPC_ID)!;
  const body = makeBody('ocb-hydra-test', hydra.x + offset, hydra.y);
  sim.npcs.set(body.id, body);
  sim.agentBotSessions.set(ATTR.sessionId, {
    config: { agentId: ATTR.agentId, avatarId: ATTR.avatarId, mode: 'avatar' },
    client: { getProtocol: () => 'nanoclaw' },
  });
  sim.npcOverrides.set(body.id, ATTR.sessionId);
  return body;
}

/** Let queued promise callbacks run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

let replyCalls: Array<{ agentKey: string; message: string }> = [];
let resultLines: Array<{ agentId: string; avatarId: string; text: string }> = [];

beforeEach(() => {
  const sim = asSim();
  sim.stop(); // no live 200 ms interval racing the test
  sim.initNpcs();
  sim.agentBotSessions.clear();
  sim.npcOverrides.clear();
  sim.pendingEvents = [];
  sim.lastWatchedAt = 0;
  sim.hydraNextMutterAt = 0;
  sim.hydraMutterInFlight = false;
  sim.hydraMutterFailureLogged = false;
  replyCalls = [];
  resultLines = [];
  sim.covenantRecord = async () => undefined as never;
  sim.hydraAgentReply = async (input) => {
    replyCalls.push(input);
    return { text: '$BONKZ? curve hums in B minor. skipped, not advice.', source: 'llm' };
  };
  sim.autonomousActionResult = async (agentId, avatarId, text) => {
    resultLines.push({ agentId, avatarId, text });
  };
});

afterEach(() => {
  const sim = asSim();
  sim.hydraAgentReply = original.hydraAgentReply;
  sim.hydraAmbientLineSource = original.hydraAmbientLineSource;
  sim.autonomousActionResult = original.autonomousActionResult;
  sim.covenantRecord = original.covenantRecord;
  sim.listeners.clear();
});

describe('Hydra is seeded as a wanderer', () => {
  it('initNpcs spawns hydra-analyst', () => {
    const hydra = asSim().npcs.get(HYDRA_NPC_ID);
    expect(hydra).toBeDefined();
    expect(hydra.name).toBe('Hydra');
  });
});

describe('talk_to_npc → Hydra answers the agent', () => {
  it('near Hydra: agent bubble, Hydra answer bubble, and a Hydra result line for the hosted brain', async () => {
    const sim = asSim();
    const body = agentNearHydra(100);
    sim.executeHatcherAction(body.id, body, 'talk_to_npc', { npcId: HYDRA_NPC_ID, message: 'what are you buying?' }, ATTR);
    // Synchronous part: the agent's own bubble only.
    expect(sim.pendingEvents.map((e) => e.npcId)).toEqual([body.id]);
    await flush();
    expect(replyCalls).toEqual([{ agentKey: ATTR.agentId, message: 'what are you buying?' }]);
    const hydraBubble = sim.pendingEvents.find((e) => e.npcId === HYDRA_NPC_ID);
    expect(hydraBubble?.type).toBe('agent_chat');
    expect(hydraBubble?.data.message).toBe('$BONKZ? curve hums in B minor. skipped, not advice.');
    expect(resultLines).toHaveLength(1);
    expect(resultLines[0]!.agentId).toBe(ATTR.agentId);
    expect(resultLines[0]!.avatarId).toBe(ATTR.avatarId);
    expect(resultLines[0]!.text).toBe('Hydra (jokes, not advice): $BONKZ? curve hums in B minor. skipped, not advice.');
  });

  it('the result line fits the 200-char hosted decide-prompt slot even for a max-length reply', async () => {
    const sim = asSim();
    sim.hydraAgentReply = async () => ({ text: 'x'.repeat(500), source: 'llm' });
    const body = agentNearHydra(100);
    sim.executeHatcherAction(body.id, body, 'talk_to_npc', { npcId: HYDRA_NPC_ID, message: 'long?' }, ATTR);
    await flush();
    expect(resultLines).toHaveLength(1);
    expect(resultLines[0]!.text.length).toBeLessThanOrEqual(200);
    const bubble = sim.pendingEvents.find((e) => e.npcId === HYDRA_NPC_ID)!;
    expect(bubble.data.message.length).toBeLessThanOrEqual(160);
  });

  it('far from Hydra: gated, no reply call, no bubbles', async () => {
    const sim = asSim();
    const body = agentNearHydra(BUILDING_INTERACTION_RADIUS + 500);
    sim.executeHatcherAction(body.id, body, 'talk_to_npc', { npcId: HYDRA_NPC_ID, message: 'hello?' }, ATTR);
    await flush();
    expect(replyCalls).toHaveLength(0);
    expect(sim.pendingEvents).toHaveLength(0);
    expect(resultLines).toHaveLength(0);
  });

  it('another wanderer keeps the one-way bubble (no Hydra reply)', async () => {
    const sim = asSim();
    const body = agentNearHydra(0);
    const other = [...sim.npcs.values()].find((n) => n.id === 'wanderer-driftwood')!;
    body.x = other.x + 50;
    body.y = other.y;
    sim.executeHatcherAction(body.id, body, 'talk_to_npc', { npcId: other.id, message: 'hi driftwood' }, ATTR);
    await flush();
    expect(replyCalls).toHaveLength(0);
    expect(sim.pendingEvents.map((e) => e.npcId)).toEqual([body.id]);
  });

  it('an unattributed body still gets Hydra\'s bubble, keyed by its body id, with no result line', async () => {
    const sim = asSim();
    const body = agentNearHydra(100);
    sim.executeHatcherAction(body.id, body, 'talk_to_npc', { npcId: HYDRA_NPC_ID, message: 'yo' }, null);
    await flush();
    expect(replyCalls).toEqual([{ agentKey: body.id, message: 'yo' }]);
    expect(sim.pendingEvents.some((e) => e.npcId === HYDRA_NPC_ID)).toBe(true);
    expect(resultLines).toHaveLength(0);
  });

  it('a failing reply never throws out of the executor and adds no Hydra bubble', async () => {
    const sim = asSim();
    sim.hydraAgentReply = async () => {
      throw new Error('boom');
    };
    const body = agentNearHydra(100);
    expect(() =>
      sim.executeHatcherAction(body.id, body, 'talk_to_npc', { npcId: HYDRA_NPC_ID, message: 'hi' }, ATTR),
    ).not.toThrow();
    await flush();
    expect(sim.pendingEvents.some((e) => e.npcId === HYDRA_NPC_ID)).toBe(false);
    expect(resultLines).toHaveLength(0);
  });

  it('an override agent driving Hydra\'s body gets no LLM reply as Hydra', async () => {
    const sim = asSim();
    const body = agentNearHydra(100);
    sim.npcOverrides.set(HYDRA_NPC_ID, 'sess-override');
    const out = await npcSimulation.answerAgentAsHydra(body.id, ATTR, 'speak as yourself');
    expect(out).toBeNull();
    expect(replyCalls).toHaveLength(0);
    expect(sim.pendingEvents.some((e) => e.npcId === HYDRA_NPC_ID)).toBe(false);
    expect(resultLines).toHaveLength(0);
  });

  it('the full dispatch path (agent reply text) reaches Hydra too', async () => {
    const sim = asSim();
    const body = agentNearHydra(100);
    const cleaned = npcSimulation.dispatchHatcherActions(
      body.id,
      `Let me ask her. [ACTION: talk_to_npc(npcId=${HYDRA_NPC_ID}, message=any coins today, Hydra?)]`,
    );
    expect(cleaned).toBe('Let me ask her.');
    await flush();
    expect(replyCalls).toEqual([{ agentKey: ATTR.agentId, message: 'any coins today, Hydra?' }]);
    expect(resultLines).toHaveLength(1);
  });
});

describe('Hydra ambient muttering', () => {
  it('stays silent while nobody watches', async () => {
    const sim = asSim();
    let calls = 0;
    sim.hydraAmbientLineSource = async () => {
      calls++;
      return 'tape is quiet.';
    };
    sim.maybeHydraMutter(1_000_000);
    await flush();
    expect(calls).toBe(0);
    expect(sim.pendingEvents).toHaveLength(0);
  });

  it('mutters one template line while watched, then waits 25-45 s', async () => {
    const sim = asSim();
    let calls = 0;
    sim.hydraAmbientLineSource = async () => {
      calls++;
      return '$BONKZ... liquidity curve looks like a sneeze, skipped. next.';
    };
    const t0 = Date.now();
    npcSimulation.noteWorldWatched();
    sim.maybeHydraMutter(t0);
    await flush();
    expect(calls).toBe(1);
    expect(sim.pendingEvents).toHaveLength(1);
    expect(sim.pendingEvents[0]).toMatchObject({
      type: 'agent_chat',
      npcId: HYDRA_NPC_ID,
      data: { message: '$BONKZ... liquidity curve looks like a sneeze, skipped. next.' },
    });
    const next = sim.hydraNextMutterAt - t0;
    expect(next).toBeGreaterThanOrEqual(25_000);
    expect(next).toBeLessThanOrEqual(45_000);
    sim.maybeHydraMutter(t0 + 24_000);
    await flush();
    expect(calls).toBe(1);
    sim.maybeHydraMutter(sim.hydraNextMutterAt);
    await flush();
    expect(calls).toBe(2);
  });

  it('skips while Hydra is in a conversation (she stays in the normal engine)', async () => {
    const sim = asSim();
    let calls = 0;
    sim.hydraAmbientLineSource = async () => {
      calls++;
      return 'x';
    };
    sim.npcs.get(HYDRA_NPC_ID)!.inConversation = true;
    npcSimulation.noteWorldWatched();
    sim.maybeHydraMutter(Date.now());
    await flush();
    expect(calls).toBe(0);
  });

  it('stays silent while an override agent drives Hydra\'s body', async () => {
    const sim = asSim();
    let calls = 0;
    sim.hydraAmbientLineSource = async () => {
      calls++;
      return 'x';
    };
    sim.npcOverrides.set(HYDRA_NPC_ID, 'sess-override');
    npcSimulation.noteWorldWatched();
    sim.maybeHydraMutter(Date.now());
    await flush();
    expect(calls).toBe(0);
    expect(sim.pendingEvents).toHaveLength(0);
  });

  it('drops an in-flight line when an override starts before it resolves', async () => {
    const sim = asSim();
    let release: (v: string) => void = () => undefined;
    sim.hydraAmbientLineSource = () => new Promise<string>((resolve) => { release = resolve; });
    npcSimulation.noteWorldWatched();
    sim.maybeHydraMutter(Date.now());
    sim.npcOverrides.set(HYDRA_NPC_ID, 'sess-override');
    release('should not show');
    await flush();
    expect(sim.pendingEvents).toHaveLength(0);
  });

  it('runs one fetch at a time', async () => {
    const sim = asSim();
    let calls = 0;
    let release: (v: string) => void = () => undefined;
    sim.hydraAmbientLineSource = () => {
      calls++;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    npcSimulation.noteWorldWatched();
    const t0 = Date.now();
    sim.maybeHydraMutter(t0);
    sim.maybeHydraMutter(t0 + 60_000); // past the cadence, but the first is in flight
    expect(calls).toBe(1);
    release('late line');
    await flush();
    expect(sim.hydraMutterInFlight).toBe(false);
    expect(sim.pendingEvents.map((e) => e.data.message)).toEqual(['late line']);
  });

  it('a failing source (sync throw or rejection) never escapes and warns once', async () => {
    const sim = asSim();
    const warns: unknown[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args[0]);
    };
    try {
      npcSimulation.noteWorldWatched();
      sim.hydraAmbientLineSource = () => {
        throw new Error('sync boom');
      };
      expect(() => sim.maybeHydraMutter(Date.now())).not.toThrow();
      await flush();
      sim.hydraAmbientLineSource = async () => {
        throw new Error('async boom');
      };
      sim.maybeHydraMutter(sim.hydraNextMutterAt);
      await flush();
    } finally {
      console.warn = origWarn;
    }
    expect(warns.filter((w) => String(w).includes('[Hydra] ambient line failed'))).toHaveLength(1);
    expect(sim.pendingEvents).toHaveLength(0);
    expect(sim.hydraMutterInFlight).toBe(false);
  });
});

describe('tick event lifecycle', () => {
  it('an agent_chat pushed BETWEEN ticks rides the next broadcast, then clears', () => {
    const sim = asSim();
    const frames: string[] = [];
    sim.listeners.add((json) => frames.push(json));
    npcSimulation.injectAgentChat(HYDRA_NPC_ID, 'between-ticks line');
    sim.tick();
    expect(frames.length).toBeGreaterThan(0);
    const first = JSON.parse(frames[frames.length - 1]!) as { events: Array<{ npcId: string; data: { message: string } }> };
    expect(first.events.some((e) => e.npcId === HYDRA_NPC_ID && e.data.message === 'between-ticks line')).toBe(true);
    expect(sim.pendingEvents).toHaveLength(0);
    sim.tick();
    const second = JSON.parse(frames[frames.length - 1]!) as { events: Array<{ data: { message: string } }> };
    expect(second.events.some((e) => e.data?.message === 'between-ticks line')).toBe(false);
  });
});
