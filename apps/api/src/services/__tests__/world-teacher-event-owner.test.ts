/**
 * Security pass 2026-10-04 — owner attribution on the AUTONOMOUS agent events.
 *
 * The durable agent event history and the driver's own wake-seed
 * (`agent-event-query.ts`) return a row only when `events.user_id` equals the
 * agent row's current owner. `conductTeacherTurn` (agent.chat.turn) and
 * `settleBuildingArrival` (building.visited) therefore CLAIM the `userId` the
 * driver enrolled the agent under (`entry.houseUserId`: the house user for a
 * house agent, the owner for a user-owned agent; the driver side is pinned in
 * `world-teacher-settle.test.ts`), and claim nobody when the caller has no owner.
 *
 * Codex round 4: the claim is checked INSIDE the event INSERT (the owned
 * variant `logOwnedAgentEvent`; SQL pinned in `event-logger-owned-insert.test.ts`,
 * proven on PostgreSQL in `agent-owner-since.db.test.ts`), with `actedAt` = the
 * start of the turn / arrival settle, so an owner change during the turn (even
 * a complete A -> B -> A round trip) leaves the row NULL. Both emits must use
 * the owned variant, never the plain `logEvent` with a pre-resolved user id.
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

/** Captured `logOwnedAgentEvent` inputs. */
let logged: Array<Record<string, unknown>>;
/** Captured plain `logEvent` inputs (must hold no chat turn / visit). */
let loggedPlain: Array<Record<string, unknown>>;

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
    loggedPlain.push(input);
  },
  logOwnedAgentEvent: async (input: Record<string, unknown>) => {
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

/** The one owned emit of `type`: a claim (no userId) and an ISO actedAt in [before, now]. */
function ownedEventOf(type: string, before: number): Record<string, unknown> {
  expect(loggedPlain.filter((e) => e.eventType === type)).toEqual([]);
  const rows = logged.filter((e) => e.eventType === type);
  expect(rows.length).toBe(1);
  const row = rows[0]!;
  expect('userId' in row).toBe(false);
  expect('claimedOwnerUserId' in row).toBe(true);
  expect(typeof row.actedAt).toBe('string');
  const actedAtMs = Date.parse(row.actedAt as string);
  expect(new Date(actedAtMs).toISOString()).toBe(row.actedAt as string);
  expect(actedAtMs).toBeGreaterThanOrEqual(before);
  expect(actedAtMs).toBeLessThanOrEqual(Date.now());
  return row;
}

beforeEach(() => {
  (npcSimulation as unknown as { stop: () => void }).stop();
  asSim().initNpcs();
  asSim().agentBotSessions.clear();
  asSim().npcOverrides.clear();
  logged = [];
  loggedPlain = [];
});

describe('conductTeacherTurn — agent.chat.turn claims the enrolled owner (checked in the insert)', () => {
  test.each([
    ['a user-owned autonomous agent (its owner)', OWNER],
    ['a house agent (the dedicated house user)', HOUSE_USER],
  ] as const)('%s', async (_label, userId) => {
    const bodyId = `ocb-wt-turn-${userId.slice(0, 2)}`;
    registerNearBody(bodyId);
    const before = Date.now();
    const result = await conductTeacherTurn({
      agentId: `agent-${bodyId}`, bodyId, avatarId: `av-${bodyId}`, userId,
      buildingId: TARGET, message: 'teach me webhooks',
    });
    expect(result).not.toBeNull();
    expect(ownedEventOf('agent.chat.turn', before)).toMatchObject({
      claimedOwnerUserId: userId, agentId: `agent-${bodyId}`, avatarId: `av-${bodyId}`, buildingId: TARGET,
    });
  });

  test('no owner (null) claims nobody (NULL user_id, stays hidden from history)', async () => {
    const bodyId = 'ocb-wt-turn-null';
    registerNearBody(bodyId);
    const before = Date.now();
    await conductTeacherTurn({
      agentId: `agent-${bodyId}`, bodyId, avatarId: `av-${bodyId}`, userId: null,
      buildingId: TARGET, message: 'teach me webhooks',
    });
    expect(ownedEventOf('agent.chat.turn', before).claimedOwnerUserId).toBeNull();
  });
});

describe('settleBuildingArrival — building.visited claims the enrolled owner (checked in the insert)', () => {
  test.each([
    ['a user-owned autonomous agent (its owner)', OWNER],
    ['a house agent (the dedicated house user)', HOUSE_USER],
  ] as const)('%s', async (_label, userId) => {
    const bodyId = `ocb-wt-visit-${userId.slice(0, 2)}`;
    registerNearBody(bodyId);
    const before = Date.now();
    await settleBuildingArrival({
      agentId: `agent-${bodyId}`, bodyId, avatarId: `av-${bodyId}`, userId, buildingId: TARGET,
    });
    expect(ownedEventOf('building.visited', before)).toMatchObject({
      claimedOwnerUserId: userId, agentId: `agent-${bodyId}`, avatarId: `av-${bodyId}`, buildingId: TARGET,
    });
  });

  test('no owner (null) claims nobody', async () => {
    const bodyId = 'ocb-wt-visit-null';
    registerNearBody(bodyId);
    const before = Date.now();
    await settleBuildingArrival({
      agentId: `agent-${bodyId}`, bodyId, avatarId: `av-${bodyId}`, userId: null, buildingId: TARGET,
    });
    expect(ownedEventOf('building.visited', before).claimedOwnerUserId).toBeNull();
  });
});
