import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  BUILDING_INTERACTION_RADIUS,
  NPC_BUILDING_CENTERS,
  type AutonomyStatusThought,
} from '@clawville/shared';
import {
  MAX_WALK_EPISODE_MS,
  MAX_WALK_REPLANS,
  WALK_BUDGET_CEIL_MS,
  WALK_BUDGET_FLOOR_MS,
  agentAutonomyDriver,
  walkBudgetMsForRouteLength,
} from '../agent-autonomy-driver';
import { agentOrchestrator } from '../agent-orchestrator';
import {
  getFindPathCallCount,
  isCollisionFreeWorld,
  resetFindPathCallCount,
} from '../pathfinding';
import { npcSimulation } from '../npc-simulation';

type DriverEntry = {
  agentId: string;
  bodyId: string;
  platformAgentId: string;
  phase: 'deciding' | 'walking' | 'arrived' | 'talking';
  phaseSince: number;
  targetBuildingId: string | null;
  lastBuildingId: string | null;
  walkDeadline: number;
  walkEpisodeDeadline: number;
  walkReplans: number;
  lastRemainingWu: number | null;
  cursorSeeded: boolean;
  directivePending: boolean;
  recentThoughts: AutonomyStatusThought[];
};

type DriverInternals = {
  houseAgents: Map<string, DriverEntry>;
  userAgents: Map<string, DriverEntry>;
  readDirectiveBounded: (platformAgentId: string) => Promise<null>;
  readRecentLessons: () => Promise<string[]>;
  readRecentKnowledge: () => Promise<string[]>;
  arrivalSettle: (...args: any[]) => Promise<null>;
};

type SimInternals = {
  npcs: Map<string, any>;
  initNpcs: () => void;
};

const driver = agentAutonomyDriver as unknown as DriverInternals;
const sim = npcSimulation as unknown as SimInternals;
const AGENT = 'walk-budget-agent';
const BODY = 'walk-budget-body';
const PLATFORM = 'walk-budget-platform';
const OWNER = 'walk-budget-owner';

const originalDirectiveRead = driver.readDirectiveBounded;
const originalLessonRead = driver.readRecentLessons;
const originalKnowledgeRead = driver.readRecentKnowledge;
const originalArrivalSettle = driver.arrivalSettle;
const originalCovenantRecord = agentAutonomyDriver.covenantRecord;
const originalGetRuntime = agentOrchestrator.getRunningAgentRuntime;
const originalEnsureRuntime = agentOrchestrator.ensureAgentRuntime;

function makeBody(id: string, x = 11264, y = 11264) {
  return {
    id,
    name: 'WalkBudgetAgent',
    x,
    y,
    hp: 100,
    maxHp: 100,
    level: 1,
    kills: 0,
    xp: 0,
    inventory: [] as string[],
    activity: 'idle' as string,
    activityEmoji: '',
    inCombat: false,
    isDead: false,
    combatAction: null,
    direction: 'idle' as const,
    species: 'milady_official_1',
    isOpenClaw: true,
    autonomyMode: 'self-managed' as const,
    inConversation: false,
    conversationCooldownUntil: 0,
    invulnerableUntil: 0,
    path: [] as Array<{ x: number; y: number }>,
    pathIndex: 0,
    destinationBuildingId: null as string | null,
    behaviorCooldown: 0,
  };
}

function registerHouse(): DriverEntry {
  sim.npcs.set(BODY, makeBody(BODY));
  expect(agentAutonomyDriver.registerHouseAgent({
    agentId: AGENT,
    bodyId: BODY,
    platformAgentId: PLATFORM,
    systemUserId: `system-${OWNER}`,
    houseUserId: OWNER,
    avatarId: `avatar-${AGENT}`,
  })).toBe(true);
  const entry = driver.houseAgents.get(AGENT)!;
  entry.cursorSeeded = true;
  return entry;
}

function body(): ReturnType<typeof makeBody> {
  const found = sim.npcs.get(BODY);
  if (!found) throw new Error('Missing walk-budget body');
  return found;
}

function stampFarWalk(entry: DriverEntry): number {
  const npc = body();
  npc.x = 11264;
  npc.y = 11264;
  npc.activity = 'walking';
  npc.path = [{ x: 13000, y: 11264 }];
  npc.pathIndex = 0;
  npc.destinationBuildingId = 'cove';
  entry.phase = 'walking';
  entry.targetBuildingId = 'cove';
  entry.phaseSince = Date.now();
  return npcSimulation.getRemainingPathLengthWu(BODY)!;
}

function firstFreeBuildingEdge(buildingId: string): { x: number; y: number } {
  const center = NPC_BUILDING_CENTERS[buildingId];
  let farthest: { x: number; y: number; distance: number } | null = null;
  for (let sample = 0; sample < 32; sample++) {
    const angle = (sample / 32) * Math.PI * 2;
    for (let distance = 0; distance < 3_000; distance++) {
      const x = Math.round(center.x + Math.cos(angle) * distance);
      const y = Math.round(center.y + Math.sin(angle) * distance);
      if (!isCollisionFreeWorld(x, y, 30)) continue;
      const measured = Math.hypot(x - center.x, y - center.y);
      if (!farthest || measured > farthest.distance) {
        farthest = { x, y, distance: measured };
      }
      break;
    }
  }
  if (farthest) return { x: farthest.x, y: farthest.y };
  throw new Error(`No free edge found for ${buildingId}`);
}

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  for (const id of agentAutonomyDriver.getHouseAgentIds()) {
    agentAutonomyDriver.unregisterHouseAgent(id);
  }
  for (const id of agentAutonomyDriver.getUserAgentIds()) {
    agentAutonomyDriver.unregisterUserAgent(id);
  }
  driver.readDirectiveBounded = async () => null;
  driver.readRecentLessons = async () => [];
  driver.readRecentKnowledge = async () => [];
  driver.arrivalSettle = async () => null;
  agentAutonomyDriver.covenantRecord = async () => ({ id: 'walk-budget', deduped: false });
  resetFindPathCallCount();
});

afterEach(() => {
  driver.readDirectiveBounded = originalDirectiveRead;
  driver.readRecentLessons = originalLessonRead;
  driver.readRecentKnowledge = originalKnowledgeRead;
  driver.arrivalSettle = originalArrivalSettle;
  agentAutonomyDriver.covenantRecord = originalCovenantRecord;
  agentOrchestrator.getRunningAgentRuntime = originalGetRuntime;
  agentOrchestrator.ensureAgentRuntime = originalEnsureRuntime;
  for (const id of agentAutonomyDriver.getHouseAgentIds()) {
    agentAutonomyDriver.unregisterHouseAgent(id);
  }
  for (const id of agentAutonomyDriver.getUserAgentIds()) {
    agentAutonomyDriver.unregisterUserAgent(id);
  }
});

describe('route-scaled autonomy walk budget', () => {
  it('T1: applies the 120 second floor', () => {
    expect(walkBudgetMsForRouteLength(0)).toBe(120_000);
    expect(walkBudgetMsForRouteLength(1)).toBe(120_000);
    expect(walkBudgetMsForRouteLength(11_000)).toBe(120_000);
    expect(WALK_BUDGET_FLOOR_MS).toBe(120_000);
  });

  it('T2: scales a 13,000 wu route deterministically', () => {
    expect(walkBudgetMsForRouteLength(13_000)).toBe(138_182);
  });

  it('T3: applies the 180 second ceiling', () => {
    expect(walkBudgetMsForRouteLength(17_600)).toBe(180_000);
    expect(walkBudgetMsForRouteLength(31_859)).toBe(180_000);
    expect(walkBudgetMsForRouteLength(1e9)).toBe(180_000);
    expect(WALK_BUDGET_CEIL_MS).toBe(180_000);
  });

  it('T4: maps junk lengths to the floor', () => {
    expect(walkBudgetMsForRouteLength(Number.NaN)).toBe(120_000);
    expect(walkBudgetMsForRouteLength(-5)).toBe(120_000);
    expect(walkBudgetMsForRouteLength(Number.POSITIVE_INFINITY)).toBe(120_000);
  });

  it('T5: walk start initializes all four episode fields', async () => {
    const entry = registerHouse();

    await agentAutonomyDriver.driveOnce(
      AGENT,
      async () => 'Cards first. [ACTION: enter_cove()]',
    );

    expect(entry.phase).toBe('walking');
    expect(entry.targetBuildingId).toBe('cove');
    expect(entry.walkDeadline - entry.phaseSince).toBeGreaterThanOrEqual(120_000);
    expect(entry.walkDeadline - entry.phaseSince).toBeLessThanOrEqual(180_000);
    expect(entry.walkEpisodeDeadline - entry.phaseSince).toBe(MAX_WALK_EPISODE_MS);
    expect(entry.walkReplans).toBe(0);
    expect(entry.lastRemainingWu).toBeNull();
  });

  it('T6: wedge re-routes without an LLM call', async () => {
    const entry = registerHouse();
    const remaining = stampFarWalk(entry);
    const now = Date.now();
    entry.walkDeadline = now + 999_999;
    entry.walkEpisodeDeadline = now + 300_000;
    entry.lastRemainingWu = remaining;
    const episodeDeadline = entry.walkEpisodeDeadline;
    let decides = 0;
    resetFindPathCallCount();

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      decides++;
      throw new Error('walking must not decide');
    });

    expect(decides).toBe(0);
    expect(entry.phase).toBe('walking');
    expect(entry.walkReplans).toBe(1);
    expect(entry.walkEpisodeDeadline).toBe(episodeDeadline);
    expect(body().path.length).toBeGreaterThan(0);
    expect(entry.recentThoughts.at(-1)?.text).toBe(
      'Path blocked — re-routing to the same destination',
    );
    expect(getFindPathCallCount()).toBe(1);
  });

  it('T7: deadline overrun re-routes without an LLM call', async () => {
    const entry = registerHouse();
    stampFarWalk(entry);
    const now = Date.now();
    entry.walkDeadline = now - 1;
    entry.walkEpisodeDeadline = now + 300_000;
    entry.lastRemainingWu = null;
    let decides = 0;
    resetFindPathCallCount();

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      decides++;
      throw new Error('walking must not decide');
    });

    expect(decides).toBe(0);
    expect(entry.phase).toBe('walking');
    expect(entry.walkReplans).toBe(1);
    expect(entry.recentThoughts.at(-1)?.text).toBe(
      'Walk overran — re-routing to the same destination',
    );
    expect(getFindPathCallCount()).toBe(1);
  });

  it('T8: an exhausted replan budget falls back to deciding', async () => {
    const entry = registerHouse();
    stampFarWalk(entry);
    entry.walkDeadline = Date.now() - 1;
    entry.walkEpisodeDeadline = Date.now() + 300_000;
    entry.walkReplans = MAX_WALK_REPLANS;
    entry.lastRemainingWu = null;
    resetFindPathCallCount();

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      throw new Error('walking must not decide');
    });

    expect(entry.phase).toBe('deciding');
    expect(entry.targetBuildingId).toBeNull();
    expect(entry.walkDeadline).toBe(0);
    expect(entry.walkEpisodeDeadline).toBe(0);
    expect(entry.walkReplans).toBe(0);
    expect(entry.lastRemainingWu).toBeNull();
    expect(entry.recentThoughts.at(-1)?.text).toBe('Walk timed out — re-deciding');
    expect(getFindPathCallCount()).toBe(0);
  });

  it('T9: the episode ceiling forces a re-decision before another replan', async () => {
    const entry = registerHouse();
    stampFarWalk(entry);
    entry.walkDeadline = Date.now() - 1;
    entry.walkEpisodeDeadline = Date.now() - 1;
    entry.walkReplans = 0;
    entry.lastRemainingWu = null;
    resetFindPathCallCount();

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      throw new Error('walking must not decide');
    });

    expect(entry.phase).toBe('deciding');
    expect(getFindPathCallCount()).toBe(0);
  });

  it('T10: a legacy entry keeps the flat-timeout re-decision behavior', async () => {
    const entry = registerHouse();
    stampFarWalk(entry);
    entry.walkDeadline = 0;
    entry.walkEpisodeDeadline = 0;
    entry.walkReplans = 0;
    entry.phaseSince = Date.now() - 121_000;
    resetFindPathCallCount();

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      throw new Error('walking must not decide');
    });

    expect(entry.phase).toBe('deciding');
    expect(entry.recentThoughts.at(-1)?.text).toBe('Walk timed out — re-deciding');
    expect(getFindPathCallCount()).toBe(0);
  });

  it('T11: a legacy entry is never wedge-checked', async () => {
    const entry = registerHouse();
    const remaining = stampFarWalk(entry);
    entry.walkDeadline = 0;
    entry.walkEpisodeDeadline = 0;
    entry.phaseSince = Date.now() - 1_000;
    entry.lastRemainingWu = remaining;
    resetFindPathCallCount();

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      throw new Error('walking must not decide');
    });

    expect(entry.phase).toBe('walking');
    expect(getFindPathCallCount()).toBe(0);
  });

  it('T12: collider-edge arrival at large buildings never re-routes', async () => {
    const entry = registerHouse();
    for (const buildingId of ['memory-rag', 'api-integrations', 'messaging-channels']) {
      const edge = firstFreeBuildingEdge(buildingId);
      const center = NPC_BUILDING_CENTERS[buildingId];
      const npc = body();
      npc.x = edge.x;
      npc.y = edge.y;
      npc.path = [{ x: center.x, y: center.y }];
      npc.pathIndex = 0;
      npc.activity = 'walking';
      entry.phase = 'walking';
      entry.phaseSince = Date.now();
      entry.targetBuildingId = buildingId;
      entry.walkDeadline = Date.now() - 1;
      entry.walkEpisodeDeadline = Date.now() + 300_000;
      entry.walkReplans = 0;
      entry.lastRemainingWu = null;
      const perception = npcSimulation.buildPerception(BODY)!;
      const building = perception.nearbyBuildings.find(
        (candidate) => candidate.buildingId === buildingId,
      );
      expect(Math.hypot(edge.x - center.x, edge.y - center.y)).toBeGreaterThan(1_000);
      expect(building?.edgeDistance).toBeGreaterThanOrEqual(0);
      expect(building?.edgeDistance).toBeLessThan(50);
      expect(building?.edgeDistance).toBeLessThanOrEqual(BUILDING_INTERACTION_RADIUS);
      resetFindPathCallCount();

      await agentAutonomyDriver.driveOnce(AGENT, async () => {
        throw new Error('arrival must not decide');
      });

      expect(entry.phase as DriverEntry['phase']).toBe('arrived');
      expect(getFindPathCallCount()).toBe(0);
    }
  });

  it('T13: the cycle after timeout fallback really decides', async () => {
    const entry = registerHouse();
    stampFarWalk(entry);
    entry.walkDeadline = 0;
    entry.phaseSince = Date.now() - 121_000;
    resetFindPathCallCount();

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      throw new Error('walking must not decide');
    });
    expect(entry.phase).toBe('deciding');

    let decides = 0;
    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      decides++;
      return '';
    });

    expect(decides).toBeGreaterThanOrEqual(1);
  });

  it('T14: walking progresses even when no cognition runtime is available', async () => {
    const entry = registerHouse();
    stampFarWalk(entry);
    entry.walkDeadline = Date.now() - 1;
    entry.walkEpisodeDeadline = Date.now() + 300_000;
    entry.lastRemainingWu = null;
    agentOrchestrator.getRunningAgentRuntime = () => null;
    agentOrchestrator.ensureAgentRuntime = async () => null;

    expect(await agentAutonomyDriver.driveAgentNow(AGENT)).toBe(true);
    expect(
      (entry.phase === 'walking' && entry.walkReplans === 1)
      || entry.phase === 'deciding',
    ).toBe(true);
  });

  it('T15: pending directives still take the warm-runtime path', async () => {
    const entry = registerHouse();
    stampFarWalk(entry);
    entry.walkDeadline = Date.now() - 1;
    entry.walkEpisodeDeadline = Date.now() + 300_000;
    entry.directivePending = true;
    agentOrchestrator.getRunningAgentRuntime = () => null;
    agentOrchestrator.ensureAgentRuntime = async () => null;

    expect(await agentAutonomyDriver.driveAgentNow(AGENT)).toBe(false);
    expect(entry.phase).toBe('walking');
    expect(entry.walkReplans).toBe(0);
  });

  it('T16: arrival clears all walk episode state', async () => {
    const entry = registerHouse();
    const cove = npcSimulation.buildPerception(BODY)!.places.find(
      (place) => place.destinationId === 'cove',
    )!;
    const npc = body();
    npc.x = cove.centerX;
    npc.y = cove.centerY;
    entry.phase = 'walking';
    entry.phaseSince = Date.now();
    entry.targetBuildingId = 'cove';
    entry.walkDeadline = Date.now() + 180_000;
    entry.walkEpisodeDeadline = Date.now() + 300_000;
    entry.walkReplans = 2;
    entry.lastRemainingWu = 123;
    let decides = 0;

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      decides++;
      return '';
    });

    expect(decides).toBe(0);
    expect(entry.phase as DriverEntry['phase']).toBe('talking');
    expect(entry.walkDeadline).toBe(0);
    expect(entry.walkEpisodeDeadline).toBe(0);
    expect(entry.walkReplans).toBe(0);
    expect(entry.lastRemainingWu).toBeNull();
  });

  it('T17: directive preemption still outranks an active walk', async () => {
    const entry = registerHouse();
    stampFarWalk(entry);
    entry.walkDeadline = Date.now() + 180_000;
    entry.walkEpisodeDeadline = Date.now() + 300_000;
    entry.directivePending = true;
    let decides = 0;

    await agentAutonomyDriver.driveOnce(AGENT, async () => {
      decides++;
      return '';
    });

    expect(entry.phase).toBe('deciding');
    expect(entry.targetBuildingId).toBeNull();
    expect(decides).toBe(1);
  });
});
