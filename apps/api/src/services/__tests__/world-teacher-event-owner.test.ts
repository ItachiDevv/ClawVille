/**
 * Security pass 2026-10-04 — owner attribution on the AUTONOMOUS agent events.
 *
 * The durable agent event history and the driver's own wake-seed
 * (`agent-event-query.ts`) return a row only when `events.user_id` equals the
 * agent row's current owner. `conductTeacherTurn` (agent.chat.turn) and
 * `settleBuildingArrival` (building.visited) therefore log the `userId` the
 * driver enrolled the agent under (`entry.houseUserId`: the house user for a
 * house agent, the owner for a user-owned agent; the driver side is pinned in
 * `world-teacher-settle.test.ts`), and NULL when the caller has no owner.
 *
 * No DB / LLM: the teacher seeder, orchestrator, reward ledger, lesson memory
 * and event logger are mocked; the body is a real npc-simulation entry standing
 * inside the building footprint (proximity passes for real).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { NPC_BUILDING_CENTERS } from '@clawville/shared';

const TARGET = 'api-integrations';
const OWNER = '71111111-1111-4111-8111-111111111111';
const HOUSE_USER = '72222222-2222-4222-8222-222222222222';

let logged: Array<Record<string, unknown>>;

const realSeeder = await import('../system-npc-seeder');
mock.module('../system-npc-seeder', () => ({
  ...realSeeder,
  getSystemNpcAgent: async () => ({
    locationAgent: { platformAgentId: 'teacher-platform-agent', agentName: 'Sandy' },
    systemUserId: 'system-user',
  }),
}));

const realOrchestrator = await import('../agent-orchestrator');
mock.module('../agent-orchestrator', () => ({
  ...realOrchestrator,
  agentOrchestrator: {
    ensureAgentRuntime: async () => ({
      processMessage: async () => ({ content: 'Webhooks beat polling for event-driven APIs.' }),
    }),
    stopAgent: async () => undefined,
  },
}));

const realReward = await import('../building-reward');
mock.module('../building-reward', () => ({
  ...realReward,
  creditBuildingRewardOncePerDay: async () => true,
  creditBuildingChatRewardOncePerDay: async () => true,
}));

const realEarned = await import('../earned-skill-memory');
mock.module('../earned-skill-memory', () => ({
  ...realEarned,
  recordEarnedSkillLesson: async () => undefined,
  readEarnedSkillLessons: async () => [],
}));

const realEventLogger = await import('../event-logger');
mock.module('../event-logger', () => ({
  ...realEventLogger,
  logEvent: async (input: Record<string, unknown>) => {
    logged.push(input);
  },
}));

const { npcSimulation } = await import('../npc-simulation');
const { conductTeacherTurn, settleBuildingArrival } = await import('../world-teacher-chat');

type Sim = {
  npcs: Map<string, any>;
  agentBotSessions: Map<string, any>;
  npcOverrides: Map<string, string>;
  initNpcs: () => void;
};
const asSim = () => npcSimulation as unknown as Sim;

/** A self-managed body standing next to the target building. */
function registerNearBody(bodyId: string): void {
  const center = NPC_BUILDING_CENTERS[TARGET];
  const sim = asSim();
  sim.npcs.set(bodyId, {
    id: bodyId, name: 'Coralia-Test', x: center.x + 100, y: center.y,
    hp: 100, maxHp: 100, level: 1, kills: 0, xp: 0, inventory: [],
    activity: 'idle', activityEmoji: '', inCombat: false, isDead: false, combatAction: null,
    direction: 'idle', species: 'milady_official_1', isOpenClaw: true, autonomyMode: 'self-managed',
    inConversation: false, conversationCooldownUntil: 0, invulnerableUntil: 0,
    path: [], pathIndex: 0, destinationBuildingId: null, behaviorCooldown: 0,
  });
}

function eventsOf(type: string) {
  return logged.filter((e) => e.eventType === type);
}

beforeEach(() => {
  (npcSimulation as unknown as { stop: () => void }).stop();
  asSim().initNpcs();
  asSim().agentBotSessions.clear();
  asSim().npcOverrides.clear();
  logged = [];
});

describe('conductTeacherTurn — agent.chat.turn carries the enrolled owner', () => {
  test.each([
    ['a user-owned autonomous agent (its owner)', OWNER],
    ['a house agent (the dedicated house user)', HOUSE_USER],
  ] as const)('%s', async (_label, userId) => {
    const bodyId = `ocb-wt-turn-${userId.slice(0, 2)}`;
    registerNearBody(bodyId);
    const result = await conductTeacherTurn({
      agentId: `agent-${bodyId}`, bodyId, avatarId: `av-${bodyId}`, userId,
      buildingId: TARGET, message: 'teach me webhooks',
    });
    expect(result).not.toBeNull();
    const chat = eventsOf('agent.chat.turn');
    expect(chat.length).toBe(1);
    expect(chat[0]).toMatchObject({
      userId, agentId: `agent-${bodyId}`, avatarId: `av-${bodyId}`, buildingId: TARGET,
    });
  });

  test('no owner (null) logs a NULL user_id (stays hidden from history)', async () => {
    const bodyId = 'ocb-wt-turn-null';
    registerNearBody(bodyId);
    await conductTeacherTurn({
      agentId: `agent-${bodyId}`, bodyId, avatarId: `av-${bodyId}`, userId: null,
      buildingId: TARGET, message: 'teach me webhooks',
    });
    const chat = eventsOf('agent.chat.turn');
    expect(chat.length).toBe(1);
    expect(chat[0]!.userId).toBeNull();
  });
});

describe('settleBuildingArrival — building.visited carries the enrolled owner', () => {
  test.each([
    ['a user-owned autonomous agent (its owner)', OWNER],
    ['a house agent (the dedicated house user)', HOUSE_USER],
  ] as const)('%s', async (_label, userId) => {
    const bodyId = `ocb-wt-visit-${userId.slice(0, 2)}`;
    registerNearBody(bodyId);
    await settleBuildingArrival({
      agentId: `agent-${bodyId}`, bodyId, avatarId: `av-${bodyId}`, userId, buildingId: TARGET,
    });
    const visits = eventsOf('building.visited');
    expect(visits.length).toBe(1);
    expect(visits[0]).toMatchObject({
      userId, agentId: `agent-${bodyId}`, avatarId: `av-${bodyId}`, buildingId: TARGET,
    });
  });

  test('no owner (null) logs a NULL user_id', async () => {
    const bodyId = 'ocb-wt-visit-null';
    registerNearBody(bodyId);
    await settleBuildingArrival({
      agentId: `agent-${bodyId}`, bodyId, avatarId: `av-${bodyId}`, userId: null, buildingId: TARGET,
    });
    const visits = eventsOf('building.visited');
    expect(visits.length).toBe(1);
    expect(visits[0]!.userId).toBeNull();
  });
});
