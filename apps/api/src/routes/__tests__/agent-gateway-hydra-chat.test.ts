/**
 * Hydra REST/MCP parity (Rule E5): `POST /api/agent/:sessionId/chat` with
 * `targetNpcId: 'hydra-analyst'` answers through the same
 * `npcSimulation.answerAgentAsHydra` the hosted `talk_to_npc` verb uses, and
 * returns her reply as `npcReply`. The proximity gate mirrors the executor
 * (same radius, Hatcher exempt). Every other target keeps the old
 * `{ success, response }` body, and a dead session is refused as before.
 *
 * No network, no DB: the session liveness gate, the TTL slide, the event log
 * and the Hydra model call are module mocks; the sim is the real singleton with
 * its maps seeded directly (the pattern of hydra-npc-simulation.test.ts).
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { BUILDING_INTERACTION_RADIUS, NPC_IDS } from '@clawville/shared';

process.env.FINGERPRINT_SECRET ??= '43'.repeat(32);

const LIVE_SESSION = 'sess-hydra-live';
const AGENT_ID = 'agent-hydra-rest';
const AVATAR_ID = 'avatar-hydra-rest';
const AGENT_BODY = `ocb-${Buffer.from(AGENT_ID, 'utf8').toString('base64url')}`;
const HYDRA_TEXT = '$BONKZ? curve hums in B minor. skipped it, not advice.';

let replyCalls: Array<{ agentKey: string; message: string }> = [];
let replyText = HYDRA_TEXT;
let liveChecks: string[] = [];
let loggedEvents: Array<Record<string, unknown>> = [];

const restoreModules: Array<[string, Record<string, unknown>]> = [];

const realAuth = await import('../../middleware/require-auth-or-agent');
restoreModules.push(['../../middleware/require-auth-or-agent', { ...realAuth }]);
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAuth,
  // Live only for the seeded session; the real gate's DB row check is out of scope.
  validateLiveAgentSession: async (sessionId: string) => {
    liveChecks.push(sessionId);
    if (sessionId !== LIVE_SESSION) return null;
    const config = npcSimulation.getAgentBotConfig(sessionId);
    return config ? ({ config, bot: { agentId: AGENT_ID } } as never) : null;
  },
}));

const realSweeper = await import('../../services/agent-session-sweeper');
restoreModules.push(['../../services/agent-session-sweeper', { ...realSweeper }]);
mock.module('../../services/agent-session-sweeper', () => ({
  ...realSweeper,
  extendSessionTtl: async () => {},
}));

const realEventOwner = await import('../../services/agent-event-owner');
restoreModules.push(['../../services/agent-event-owner', { ...realEventOwner }]);
mock.module('../../services/agent-event-owner', () => ({
  ...realEventOwner,
  logGatewayAgentEvent: async (_c: unknown, _sid: string, input: Record<string, unknown>) => {
    loggedEvents.push(input);
  },
}));

const realHydraReply = await import('../../services/hydra-agent-reply');
restoreModules.push(['../../services/hydra-agent-reply', { ...realHydraReply }]);
mock.module('../../services/hydra-agent-reply', () => ({
  ...realHydraReply,
  replyToAgentAsHydra: async (input: { agentKey: string; message: string }) => {
    replyCalls.push(input);
    return { text: replyText, source: 'llm' as const };
  },
}));

const { agentGatewayRoutes } = await import('../agent-gateway');
const { npcSimulation } = await import('../../services/npc-simulation');
const { HYDRA_NPC_ID } = await import('../../services/hydra-coin-chatter');
const { GAME_TOOL_ROUTES } = await import('../../services/agent-mcp-tools');

type Sim = {
  npcs: Map<string, any>;
  agentBotSessions: Map<string, any>;
  npcOverrides: Map<string, string>;
  pendingEvents: Array<{ type: string; npcId: string; data: { message: string } }>;
  initNpcs: () => void;
  stop: () => void;
  autonomousActionResult: typeof npcSimulation.autonomousActionResult;
};
const asSim = () => npcSimulation as unknown as Sim;
const originalActionResult = npcSimulation.autonomousActionResult;
let resultLines: Array<{ agentId: string; avatarId: string; text: string }> = [];

function makeBody(id: string, x: number, y: number) {
  return {
    id, name: 'RestAgent', x, y, hp: 100, maxHp: 100, level: 1, kills: 0, xp: 0,
    inventory: [] as string[], activity: 'idle', activityEmoji: '', inCombat: false,
    isDead: false, combatAction: null, direction: 'idle', species: 'milady_official_1',
    isOpenClaw: true, autonomyMode: 'agent-driven', inConversation: false,
    conversationCooldownUntil: 0, invulnerableUntil: 0, path: [] as Array<{ x: number; y: number }>,
    pathIndex: 0, destinationBuildingId: null as string | null, behaviorCooldown: 0,
  };
}

/** A connected avatar-mode agent body `offset` wu east of Hydra. */
function seedAgent(offset: number, protocol = 'nanoclaw') {
  const sim = asSim();
  const hydra = sim.npcs.get(HYDRA_NPC_ID)!;
  sim.npcs.set(AGENT_BODY, makeBody(AGENT_BODY, hydra.x + offset, hydra.y));
  sim.agentBotSessions.set(LIVE_SESSION, {
    config: { agentId: AGENT_ID, avatarId: AVATAR_ID, mode: 'avatar' },
    client: { getProtocol: () => protocol },
  });
  sim.npcOverrides.set(AGENT_BODY, LIVE_SESSION);
}

function postChat(sessionId: string, body: Record<string, unknown>) {
  return agentGatewayRoutes.request(`/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const chatEvents = () => asSim().pendingEvents.filter((e) => e.type === 'agent_chat');

beforeEach(() => {
  const sim = asSim();
  sim.stop();
  sim.initNpcs();
  sim.agentBotSessions.clear();
  sim.npcOverrides.clear();
  sim.pendingEvents = [];
  replyCalls = [];
  replyText = HYDRA_TEXT;
  liveChecks = [];
  loggedEvents = [];
  resultLines = [];
  sim.autonomousActionResult = async (agentId, avatarId, text) => {
    resultLines.push({ agentId, avatarId, text });
  };
});

afterEach(() => {
  const sim = asSim();
  sim.autonomousActionResult = originalActionResult;
  sim.agentBotSessions.clear();
  sim.npcOverrides.clear();
  sim.npcs.delete(AGENT_BODY);
});

afterAll(() => {
  for (const [path, real] of restoreModules) mock.module(path, () => real);
});

describe('POST /api/agent/:sessionId/chat to Hydra', () => {
  test('a near agent gets Hydra\'s reply in npcReply, and both bubbles are public', async () => {
    seedAgent(BUILDING_INTERACTION_RADIUS - 50);
    const res = await postChat(LIVE_SESSION, { message: 'what did you buy today?', targetNpcId: HYDRA_NPC_ID });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      response: null,
      npcReply: { npcId: 'hydra-analyst', name: 'Hydra', message: HYDRA_TEXT },
    });
    // Rate-limit key is the session's agent id (the same key the executor uses).
    expect(replyCalls).toEqual([{ agentKey: AGENT_ID, message: 'what did you buy today?' }]);
    expect(chatEvents().map((e) => [e.npcId, e.data.message])).toEqual([
      [AGENT_BODY, 'what did you buy today?'],
      [HYDRA_NPC_ID, HYDRA_TEXT],
    ]);
    await flush();
    expect(resultLines).toEqual([
      { agentId: AGENT_ID, avatarId: AVATAR_ID, text: `Hydra (jokes, not advice): ${HYDRA_TEXT}` },
    ]);
    expect(loggedEvents[0]?.payload).toMatchObject({ targetNpcId: HYDRA_NPC_ID });
  });

  test('a far agent is refused before any bubble or model call', async () => {
    seedAgent(BUILDING_INTERACTION_RADIUS + 200);
    const res = await postChat(LIVE_SESSION, { message: 'hi', targetNpcId: HYDRA_NPC_ID });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toStartWith('Too far from Hydra (');
    expect(replyCalls).toEqual([]);
    expect(chatEvents()).toEqual([]);
  });

  test('a Hatcher proxy body is exempt from the distance gate, as in talk_to_npc', async () => {
    seedAgent(BUILDING_INTERACTION_RADIUS * 5, 'hatcher-proxy');
    const res = await postChat(LIVE_SESSION, { message: 'hi', targetNpcId: HYDRA_NPC_ID });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { npcReply: { message: string } }).npcReply.message).toBe(HYDRA_TEXT);
    expect(replyCalls.length).toBe(1);
  });

  test('a dead Hydra gives 409 and no side effect', async () => {
    seedAgent(10);
    asSim().npcs.get(HYDRA_NPC_ID)!.isDead = true;
    const res = await postChat(LIVE_SESSION, { message: 'hi', targetNpcId: HYDRA_NPC_ID });
    expect(res.status).toBe(409);
    expect(replyCalls).toEqual([]);
    expect(chatEvents()).toEqual([]);
  });

  test('an empty reply gives npcReply null, never a Hydra bubble', async () => {
    seedAgent(10);
    replyText = '   ';
    const res = await postChat(LIVE_SESSION, { message: 'hi', targetNpcId: HYDRA_NPC_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, response: null, npcReply: null });
    expect(chatEvents().map((e) => e.npcId)).toEqual([AGENT_BODY]);
  });

  test('an invalid session is refused with the old 404 and never reaches Hydra', async () => {
    seedAgent(10);
    const res = await postChat('sess-not-live', { message: 'hi', targetNpcId: HYDRA_NPC_ID });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Invalid or expired agent session' });
    expect(liveChecks).toEqual(['sess-not-live']);
    expect(replyCalls).toEqual([]);
    expect(chatEvents()).toEqual([]);
  });
});

describe('POST /api/agent/:sessionId/chat to anyone else is unchanged', () => {
  const other = NPC_IDS.find((id) => id !== HYDRA_NPC_ID)!;

  test.each([
    ['another NPC', { message: 'hello', targetNpcId: other }],
    ['no target', { message: 'hello' }],
  ])('%s: { success, response } only, no Hydra call', async (_label, payload) => {
    seedAgent(10);
    const res = await postChat(LIVE_SESSION, payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, response: null });
    expect(replyCalls).toEqual([]);
    expect(chatEvents().map((e) => e.npcId)).toEqual([AGENT_BODY]);
  });

  test('a far agent talking to another NPC is not distance-gated (old behavior)', async () => {
    seedAgent(BUILDING_INTERACTION_RADIUS * 5);
    const res = await postChat(LIVE_SESSION, { message: 'hello', targetNpcId: other });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, response: null });
  });

  test('an invalid body is still a 400', async () => {
    seedAgent(10);
    const res = await postChat(LIVE_SESSION, { targetNpcId: HYDRA_NPC_ID });
    expect(res.status).toBe(400);
    expect(replyCalls).toEqual([]);
  });
});

describe('MCP clawville_chat_avatar', () => {
  test('forwards targetNpcId to the chat route', () => {
    const calls = GAME_TOOL_ROUTES.clawville_chat_avatar!.calls(
      { sid: LIVE_SESSION, agentId: AGENT_ID },
      { message: 'hi', targetNpcId: HYDRA_NPC_ID },
    );
    expect(calls).toEqual([
      { method: 'POST', path: `/api/agent/${LIVE_SESSION}/chat`, body: { message: 'hi', targetNpcId: HYDRA_NPC_ID } },
    ]);
  });

  test('omits targetNpcId when the caller does not send it', () => {
    const calls = GAME_TOOL_ROUTES.clawville_chat_avatar!.calls({ sid: LIVE_SESSION, agentId: AGENT_ID }, { message: 'hi' });
    expect(calls[0]!.body).toEqual({ message: 'hi' });
  });
});
