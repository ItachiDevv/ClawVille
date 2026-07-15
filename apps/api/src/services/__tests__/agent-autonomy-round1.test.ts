import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  BUILDING_INTERACTION_RADIUS,
  DECISION_SCOPE,
  HATCHER_ACTION_VERBS,
  MAP_LOCATIONS,
} from '@clawville/shared';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import { agentOrchestrator } from '../agent-orchestrator';
import { npcSimulation } from '../npc-simulation';

type RuntimeState = ReturnType<typeof agentOrchestrator.getRunningAgentRuntime>;
type DriverEntry = {
  agentId: string;
  platformAgentId: string;
  phase: 'deciding' | 'walking' | 'arrived' | 'talking';
  phaseSince: number;
  targetBuildingId: string | null;
  lastBuildingId: string | null;
  cursorSeeded: boolean;
  recentEventSummary: string | null;
  lastLesson: string | null;
};

type DriverInternals = {
  houseAgents: Map<string, DriverEntry>;
  userAgents: Map<string, DriverEntry>;
  inFlight: Set<string>;
  warming: Map<string, number>;
  tick: () => void;
  driveOnce: (agentId: string, decide: (prompt: string) => Promise<string>) => Promise<void>;
  readDirectiveBounded: (platformAgentId: string) => Promise<null>;
  readRecentLessons: () => Promise<string[]>;
};

type SimInternals = {
  npcs: Map<string, any>;
  initNpcs: () => void;
};

const driver = agentAutonomyDriver as unknown as DriverInternals;
const sim = npcSimulation as unknown as SimInternals;

function body(id: string, x = 11264, y = 11264) {
  return {
    id,
    name: 'RoundOneAgent',
    x,
    y,
    hp: 100,
    maxHp: 100,
    level: 1,
    kills: 0,
    xp: 0,
    inventory: [],
    activity: 'idle',
    activityEmoji: '',
    inCombat: false,
    isDead: false,
    combatAction: null,
    direction: 'idle',
    species: 'milady_official_1',
    isOpenClaw: true,
    autonomyMode: 'self-managed',
    inConversation: false,
    conversationCooldownUntil: 0,
    invulnerableUntil: 0,
    path: [],
    pathIndex: 0,
    destinationBuildingId: null,
    behaviorCooldown: 0,
  };
}

function registerHouse(agentId: string, platformAgentId = `platform-${agentId}`) {
  sim.npcs.set(agentId, body(agentId));
  agentAutonomyDriver.registerHouseAgent({
    agentId,
    bodyId: agentId,
    platformAgentId,
    systemUserId: `system-${agentId}`,
    houseUserId: `house-${agentId}`,
    avatarId: `avatar-${agentId}`,
  });
  return driver.houseAgents.get(agentId)!;
}

const originalGetRuntime = agentOrchestrator.getRunningAgentRuntime;
const originalEnsureRuntime = agentOrchestrator.ensureAgentRuntime;
const originalDriveOnce = driver.driveOnce;
const originalDirectiveRead = driver.readDirectiveBounded;
const originalLessonRead = driver.readRecentLessons;

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  for (const id of agentAutonomyDriver.getHouseAgentIds()) agentAutonomyDriver.unregisterHouseAgent(id);
  for (const id of agentAutonomyDriver.getUserAgentIds()) agentAutonomyDriver.unregisterUserAgent(id);
});

afterEach(() => {
  agentOrchestrator.getRunningAgentRuntime = originalGetRuntime;
  agentOrchestrator.ensureAgentRuntime = originalEnsureRuntime;
  driver.driveOnce = originalDriveOnce;
  driver.readDirectiveBounded = originalDirectiveRead;
  driver.readRecentLessons = originalLessonRead;
  for (const id of agentAutonomyDriver.getHouseAgentIds()) agentAutonomyDriver.unregisterHouseAgent(id);
  for (const id of agentAutonomyDriver.getUserAgentIds()) agentAutonomyDriver.unregisterUserAgent(id);
});

describe('round 1 perception + decision prompt', () => {
  it('derives cove and poker places from MAP_LOCATIONS with exact executor syntax', () => {
    const id = 'places-agent';
    registerHouse(id);
    const perception = npcSimulation.buildPerception(id)!;
    const coveLocation = MAP_LOCATIONS.find((location) => location.id === 'cove')!;
    const centerX = coveLocation.positionX + coveLocation.width / 2;
    const centerY = coveLocation.positionY + coveLocation.height / 2;

    expect(perception.places).toEqual(expect.arrayContaining([
      expect.objectContaining({
        placeId: 'cove',
        actionVerb: 'enter_cove',
        actionSyntax: 'enter_cove()',
        destinationId: 'cove',
        centerX,
        centerY,
      }),
      expect.objectContaining({
        placeId: 'poker-room',
        actionVerb: 'enter_poker_room',
        actionSyntax: 'enter_poker_room()',
        destinationId: 'cove',
        centerX,
        centerY,
      }),
    ]));
  });

  it('renders directive first, then compact scope + full executor menu + cove place', () => {
    const id = 'prompt-agent';
    const entry = registerHouse(id);
    const perception = npcSimulation.buildPerception(id)!;
    const prompt = agentAutonomyDriver.buildDecisionPrompt(
      perception,
      entry as never,
      [],
      'go play cards',
    );

    const directiveAt = prompt.indexOf('go play cards');
    const scopeAt = prompt.indexOf(DECISION_SCOPE[0]);
    const menuAt = prompt.indexOf('Available actions');
    expect(directiveAt).toBeGreaterThanOrEqual(0);
    expect(directiveAt).toBeLessThan(scopeAt);
    expect(scopeAt).toBeLessThan(menuAt);
    expect(prompt).toContain('cove');
    expect(prompt).toContain('enter_cove()');
    expect(prompt).toContain('satisfy it before learning');
    for (const verb of HATCHER_ACTION_VERBS) expect(prompt).toContain(verb);
  });

  it('dispatches a cove destination but keeps one-shot emote in deciding', async () => {
    const id = 'dispatch-agent';
    const entry = registerHouse(id);
    entry.cursorSeeded = true;
    driver.readDirectiveBounded = async () => null;
    driver.readRecentLessons = async () => [];

    await agentAutonomyDriver.driveOnce(
      id,
      async () => 'Cards first. [ACTION: enter_cove()]',
    );
    expect(sim.npcs.get(id).destinationBuildingId).toBe('cove');
    expect(entry.phase).toBe('walking');
    expect(entry.targetBuildingId).toBe('cove');

    entry.phase = 'deciding';
    entry.targetBuildingId = null;
    await agentAutonomyDriver.driveOnce(
      id,
      async () => 'Celebrating. [ACTION: emote(name=celebrate)]',
    );
    expect(sim.npcs.get(id).activity).toBe('socializing');
    expect(sim.npcs.get(id).destinationBuildingId).toBeNull();
    expect(entry.phase).toBe('deciding');
  });

  it('recognizes cove arrival without teacher talk or settlement', async () => {
    const id = 'arrival-agent';
    const entry = registerHouse(id);
    const cove = npcSimulation.buildPerception(id)!.places.find((place) => place.placeId === 'cove')!;
    const npc = sim.npcs.get(id);
    npc.x = cove.centerX;
    npc.y = cove.centerY;
    entry.phase = 'walking';
    entry.targetBuildingId = 'cove';
    entry.phaseSince = Date.now();

    let settled = 0;
    const realSettle = agentAutonomyDriver.arrivalSettle;
    agentAutonomyDriver.arrivalSettle = async () => {
      settled++;
      return null as never;
    };
    let decided = 0;
    try {
      await agentAutonomyDriver.driveOnce(id, async () => {
        decided++;
        return '';
      });
    } finally {
      agentAutonomyDriver.arrivalSettle = realSettle;
    }

    expect(cove.distance).toBeGreaterThan(BUILDING_INTERACTION_RADIUS);
    expect(settled).toBe(0);
    expect(decided).toBe(0);
    const arrivedEntry = driver.houseAgents.get(id)!;
    expect(arrivedEntry.phase).toBe('talking');
    expect(arrivedEntry.targetBuildingId).toBeNull();
  });
});

describe('round 1 cadence', () => {
  it('kicks only the actively-enrolled owner agent whose platform identity matches', async () => {
    const ownerUserId = 'directive-owner';
    const agentId = 'hosted-agent-handle';
    const platformAgentId = 'platform-agent-row';
    agentAutonomyDriver.registerUserAgent({
      agentId,
      bodyId: 'directive-body',
      platformAgentId,
      systemUserId: ownerUserId,
      houseUserId: ownerUserId,
      avatarId: 'directive-avatar',
    });
    const realDriveNow = agentAutonomyDriver.driveAgentNow;
    const kicked: string[] = [];
    agentAutonomyDriver.driveAgentNow = async (id: string) => {
      kicked.push(id);
      return true;
    };
    try {
      expect(agentAutonomyDriver.kickEnrolledOwnerNow(ownerUserId, 'stale-platform-row')).toBe(false);
      expect(agentAutonomyDriver.kickEnrolledOwnerNow(ownerUserId, platformAgentId)).toBe(true);
      await Promise.resolve();
      expect(kicked).toEqual([agentId]);
    } finally {
      agentAutonomyDriver.driveAgentNow = realDriveNow;
    }
  });

  it('warms then drives in the same cycle and passes the 6s local attempt budget', async () => {
    const entry = registerHouse('warm-drive-agent');
    const decideOptions: unknown[] = [];
    const runtime = {
      decide: async (_prompt: string, opts: unknown) => {
        decideOptions.push(opts);
        return '';
      },
    } as RuntimeState;
    agentOrchestrator.getRunningAgentRuntime = () => null;
    agentOrchestrator.ensureAgentRuntime = async () => runtime;
    driver.driveOnce = async (_agentId, decide) => {
      await decide('test prompt');
    };

    expect(await agentAutonomyDriver.driveAgentNow(entry.agentId)).toBe(true);
    expect(decideOptions).toEqual([{ maxTokens: 200, localAttemptTimeoutMs: 6_000 }]);
  });

  it('does not serialize a warm agent behind another agent cold-warming', async () => {
    registerHouse('cold-agent', 'platform-cold');
    registerHouse('warm-agent', 'platform-warm');
    let resolveCold!: (runtime: RuntimeState) => void;
    const coldRuntime = { decide: async () => '' } as unknown as RuntimeState;
    const warmRuntime = { decide: async () => '' } as unknown as RuntimeState;
    const coldWarm = new Promise<RuntimeState>((resolve) => { resolveCold = resolve; });
    agentOrchestrator.getRunningAgentRuntime = (id) => id === 'platform-warm' ? warmRuntime : null;
    agentOrchestrator.ensureAgentRuntime = async () => coldWarm;
    const driven: string[] = [];
    driver.driveOnce = async (agentId) => { driven.push(agentId); };

    driver.tick();
    await Promise.resolve();
    expect(driven).toContain('warm-agent');
    expect(driven).not.toContain('cold-agent');

    resolveCold(coldRuntime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(driven).toContain('cold-agent');
  });

  it('skips an overlapping kick for the same agent instead of queueing it', async () => {
    const entry = registerHouse('overlap-agent');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runtime = { decide: async () => '' } as unknown as RuntimeState;
    agentOrchestrator.getRunningAgentRuntime = () => runtime;
    let drives = 0;
    driver.driveOnce = async () => {
      drives++;
      await held;
    };

    const first = agentAutonomyDriver.driveAgentNow(entry.agentId);
    expect(await agentAutonomyDriver.driveAgentNow(entry.agentId)).toBe(false);
    expect(drives).toBe(1);
    release();
    expect(await first).toBe(true);
  });

  it('preserves the guard across same-id unregister and re-register', async () => {
    const agentId = 'toggle-race-agent';
    const ownerUserId = 'toggle-race-owner';
    const registration = {
      agentId,
      bodyId: 'toggle-race-body',
      platformAgentId: 'toggle-race-platform',
      systemUserId: ownerUserId,
      houseUserId: ownerUserId,
      avatarId: 'toggle-race-avatar',
    };
    agentAutonomyDriver.registerUserAgent(registration);

    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runtime = { decide: async () => '' } as unknown as RuntimeState;
    agentOrchestrator.getRunningAgentRuntime = () => runtime;
    let concurrent = 0;
    let maxConcurrent = 0;
    let drives = 0;
    driver.driveOnce = async () => {
      drives++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (drives === 1) await firstHeld;
      concurrent--;
    };

    const first = agentAutonomyDriver.driveAgentNow(agentId);
    await Promise.resolve();
    expect(drives).toBe(1);

    // Controlled handback + immediate Autonomous re-enrollment with the SAME
    // stable agent id cannot cancel the old work. Its guard must survive.
    agentAutonomyDriver.unregisterUserAgent(agentId);
    expect(agentAutonomyDriver.registerUserAgent(registration).ok).toBe(true);
    expect(await agentAutonomyDriver.driveAgentNow(agentId)).toBe(false);
    expect(maxConcurrent).toBe(1);

    releaseFirst();
    expect(await first).toBe(true);
    expect(await agentAutonomyDriver.driveAgentNow(agentId)).toBe(true);
    expect(drives).toBe(2);
    expect(maxConcurrent).toBe(1);
  });
});
