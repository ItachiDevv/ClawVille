import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { BUILDING_INTERACTION_RADIUS, NPC_BUILDING_CENTERS } from '@clawville/shared';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import { agentOrchestrator } from '../agent-orchestrator';
import { armAutonomy, autonomyStandbyTestSeams } from '../autonomy-standby';
import { isCollisionFreeWorld } from '../pathfinding';
import { NPC_WORLD_WALK_SPEED_WU_PER_S, npcSimulation } from '../npc-simulation';

// Teacher-talk prefetch (founder 2026-10-20: "faster path, same decision").
// The phase-edge poll starts the arrival talk call during the final approach
// (walk ETA <= 10 s) and the arrived branch uses that reply. These tests pin the
// gates, that the poll still never drives a not-arrived walk, that a used
// prefetch is the ONLY decide call, and every discard path.

type TalkPrefetch = {
  buildingId: string;
  prompt: string;
  directiveRevision: number;
  startedAt: number;
  promise: Promise<string>;
};

type DriverEntry = {
  agentId: string;
  bodyId: string;
  platformAgentId: string;
  phase: 'deciding' | 'walking' | 'arrived' | 'talking';
  phaseSince: number;
  targetBuildingId: string | null;
  walkDeadline: number;
  walkEpisodeDeadline: number;
  walkReplans: number;
  lastRemainingWu: number | null;
  cursorSeeded: boolean;
  directivePending: boolean;
  directiveRevision: number;
  edgeDecideAt: number;
  talkPrefetch: TalkPrefetch | null;
};

type DriverInternals = {
  houseAgents: Map<string, DriverEntry>;
  userAgents: Map<string, DriverEntry>;
  inFlight: Set<string>;
  warming: Map<string, number>;
  arrivalSettling: Map<string, object>;
  talkCooldownUntil: Map<string, number>;
  runReconcile: () => Promise<void>;
  readDirectiveBounded: (platformAgentId: string) => Promise<null>;
  readRecentLessons: () => Promise<string[]>;
  readRecentKnowledge: () => Promise<string[]>;
  arrivalSettle: (...args: any[]) => Promise<null>;
  teacherTurn: (...args: any[]) => Promise<unknown>;
  buildTalkPrompt: (buildingId: string, label?: string, cryptoFocus?: string) => string;
};

type SimInternals = {
  npcs: Map<string, any>;
  initNpcs: () => void;
};

const driver = agentAutonomyDriver as unknown as DriverInternals;
const sim = npcSimulation as unknown as SimInternals;
const AGENT = 'talk-prefetch-agent';
const BODY = 'talk-prefetch-body';
const PLATFORM = 'talk-prefetch-platform';
const OWNER = 'talk-prefetch-owner';
const USER_AGENT = 'talk-prefetch-user-agent';
const USER_BODY = 'talk-prefetch-user-body';
const USER_PLATFORM = 'talk-prefetch-user-platform';
const USER_OWNER = 'talk-prefetch-user-owner';
const BUILDING = 'memory-rag';
const OTHER_BUILDING = 'api-integrations';
const TALK_REPLY = `[ACTION: talk_to_npc(buildingId=${BUILDING}, message=how do embeddings rank memories)]`;

const originalDriveAgentNow = agentAutonomyDriver.driveAgentNow;
const originalRunReconcile = driver.runReconcile;
const originalDirectiveRead = driver.readDirectiveBounded;
const originalLessonRead = driver.readRecentLessons;
const originalKnowledgeRead = driver.readRecentKnowledge;
const originalArrivalSettle = driver.arrivalSettle;
const originalTeacherTurn = driver.teacherTurn;
const originalCovenantRecord = agentAutonomyDriver.covenantRecord;
const originalGetRuntime = agentOrchestrator.getRunningAgentRuntime;
const originalEnsureRuntime = agentOrchestrator.ensureAgentRuntime;
const originalDispatch = npcSimulation.dispatchHatcherActions;
const originalRemaining = npcSimulation.getRemainingPathLengthWu;

function makeBody(id: string, x = 11264, y = 11264) {
  return {
    id,
    name: 'TalkPrefetchAgent',
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

function registerUser(): DriverEntry {
  sim.npcs.set(USER_BODY, makeBody(USER_BODY));
  expect(agentAutonomyDriver.registerUserAgent({
    agentId: USER_AGENT,
    bodyId: USER_BODY,
    platformAgentId: USER_PLATFORM,
    systemUserId: USER_OWNER,
    houseUserId: USER_OWNER,
    avatarId: `avatar-${USER_AGENT}`,
  })).toEqual({ ok: true, reused: false });
  const entry = driver.userAgents.get(USER_AGENT)!;
  entry.cursorSeeded = true;
  return entry;
}

function body(id = BODY): ReturnType<typeof makeBody> {
  const found = sim.npcs.get(id);
  if (!found) throw new Error(`Missing talk-prefetch body ${id}`);
  return found;
}

/** Same helper as agent-autonomy-phase-edge.test.ts. */
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

/**
 * A driver-stamped walk to `target` that has NOT arrived, with exactly
 * `remainingWu` of path left (one straight waypoint).
 */
function stampApproach(
  entry: DriverEntry,
  remainingWu: number,
  target = BUILDING,
  bodyId = BODY,
): void {
  const now = Date.now();
  entry.phase = 'walking';
  entry.phaseSince = now;
  entry.targetBuildingId = target;
  entry.walkDeadline = now + 999_999;
  entry.walkEpisodeDeadline = now + 300_000;
  entry.walkReplans = 0;
  entry.lastRemainingWu = null;
  const npc = body(bodyId);
  npc.path = [{ x: npc.x + remainingWu, y: npc.y }];
  npc.pathIndex = 0;
  expect(npcSimulation.getRemainingPathLengthWu(bodyId)).toBe(remainingWu);
}

/** Put the body inside the target's interaction radius. */
function placeAtBuilding(buildingId = BUILDING): void {
  const edge = firstFreeBuildingEdge(buildingId);
  const npc = body();
  npc.x = edge.x;
  npc.y = edge.y;
  npc.path = [];
  npc.pathIndex = 0;
}

/** Wrap (not mock) driveAgentNow so the real drive runs and can be awaited. */
function captureRealDrives(): Promise<boolean>[] {
  const drives: Promise<boolean>[] = [];
  const real = originalDriveAgentNow.bind(agentAutonomyDriver);
  agentAutonomyDriver.driveAgentNow = ((id: string, followup?: boolean) => {
    const p = real(id, followup);
    drives.push(p);
    return p;
  }) as typeof agentAutonomyDriver.driveAgentNow;
  return drives;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

type DecideCall = { prompt: string; opts: unknown };

/** A warm runtime whose decide() records every call. */
function installRuntime(replies: Array<string | Error>): DecideCall[] {
  const calls: DecideCall[] = [];
  const runtime = {
    decide: async (prompt: string, opts: unknown) => {
      calls.push({ prompt, opts });
      const next = replies.length > 1 ? replies.shift()! : (replies[0] ?? '');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  agentOrchestrator.getRunningAgentRuntime = (() => runtime) as never;
  return calls;
}

function expectedPrompt(buildingId = BUILDING): string {
  const building = npcSimulation.buildPerception(BODY)!.nearbyBuildings.find(
    (b) => b.buildingId === buildingId,
  )!;
  return driver.buildTalkPrompt(buildingId, building.label, building.cryptoFocus);
}

let drive: ReturnType<typeof mock>;
let dispatched: string[];
let teacherCalls: Array<{ buildingId: string; message: string }>;

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  for (const id of agentAutonomyDriver.getHouseAgentIds()) {
    agentAutonomyDriver.unregisterHouseAgent(id);
  }
  for (const id of agentAutonomyDriver.getUserAgentIds()) {
    agentAutonomyDriver.unregisterUserAgent(id);
  }
  driver.inFlight.clear();
  driver.warming.clear();
  driver.arrivalSettling.clear();
  driver.talkCooldownUntil.clear();
  driver.runReconcile = async () => {};
  driver.readDirectiveBounded = async () => null;
  driver.readRecentLessons = async () => [];
  driver.readRecentKnowledge = async () => [];
  driver.arrivalSettle = async () => null;
  teacherCalls = [];
  driver.teacherTurn = async (input: { buildingId: string; message: string }) => {
    teacherCalls.push({ buildingId: input.buildingId, message: input.message });
    return { reply: 'Embeddings rank by cosine similarity.', teacherName: 'Teacher' };
  };
  dispatched = [];
  npcSimulation.dispatchHatcherActions = ((_bodyId: string, reply: string) => {
    dispatched.push(reply);
  }) as typeof npcSimulation.dispatchHatcherActions;
  agentAutonomyDriver.covenantRecord = async () => ({ id: 'talk-prefetch', deduped: false });
  agentOrchestrator.ensureAgentRuntime = async () => null;
  agentOrchestrator.getRunningAgentRuntime = () => null;
  drive = mock(async () => true);
  agentAutonomyDriver.driveAgentNow = drive as unknown as typeof agentAutonomyDriver.driveAgentNow;
  armAutonomy(15);
});

afterEach(() => {
  agentAutonomyDriver.stop();
  setSystemTime();
  agentAutonomyDriver.driveAgentNow = originalDriveAgentNow;
  driver.runReconcile = originalRunReconcile;
  driver.readDirectiveBounded = originalDirectiveRead;
  driver.readRecentLessons = originalLessonRead;
  driver.readRecentKnowledge = originalKnowledgeRead;
  driver.arrivalSettle = originalArrivalSettle;
  driver.teacherTurn = originalTeacherTurn;
  agentAutonomyDriver.covenantRecord = originalCovenantRecord;
  agentOrchestrator.getRunningAgentRuntime = originalGetRuntime;
  agentOrchestrator.ensureAgentRuntime = originalEnsureRuntime;
  npcSimulation.dispatchHatcherActions = originalDispatch;
  npcSimulation.getRemainingPathLengthWu = originalRemaining;
  driver.inFlight.clear();
  driver.warming.clear();
  driver.arrivalSettling.clear();
  driver.talkCooldownUntil.clear();
  for (const id of agentAutonomyDriver.getHouseAgentIds()) {
    agentAutonomyDriver.unregisterHouseAgent(id);
  }
  for (const id of agentAutonomyDriver.getUserAgentIds()) {
    agentAutonomyDriver.unregisterUserAgent(id);
  }
  autonomyStandbyTestSeams.restoreDefault();
});

describe('talk prefetch: when the poll starts it', () => {
  it('the spawn is outside the interaction radius of the test building', () => {
    registerHouse();
    const building = npcSimulation.buildPerception(BODY)!.nearbyBuildings.find(
      (b) => b.buildingId === BUILDING,
    )!;
    expect(building.edgeDistance).toBeGreaterThan(BUILDING_INTERACTION_RADIUS);
  });

  it('starts when ETA <= 10 s, without waking a drive, with the driveAgentNow call shape', async () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000); // ETA 4.5 s
    const calls = installRuntime([TALK_REPLY]);

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(drive).not.toHaveBeenCalled();
    expect(entry.phase as DriverEntry['phase']).toBe('walking');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe(expectedPrompt());
    expect(calls[0]!.opts).toEqual({ maxTokens: 200, localAttemptTimeoutMs: 6_000 });
    expect(entry.talkPrefetch).not.toBeNull();
    expect(entry.talkPrefetch!.buildingId).toBe(BUILDING);
    expect(entry.talkPrefetch!.prompt).toBe(expectedPrompt());
    expect(entry.talkPrefetch!.directiveRevision).toBe(0);
    expect(await entry.talkPrefetch!.promise).toBe(TALK_REPLY);

    // One prefetch per target: a later poll does not call decide again.
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(drive).not.toHaveBeenCalled();
  });

  it('the ETA boundary is exact: 2200 wu (10 000 ms) starts, 2201 wu does not', () => {
    const entry = registerHouse();
    const calls = installRuntime([TALK_REPLY]);
    expect(2_200 / NPC_WORLD_WALK_SPEED_WU_PER_S * 1000).toBe(10_000);

    stampApproach(entry, 2_201);
    agentAutonomyDriver.phaseEdgePoll();
    expect(entry.talkPrefetch).toBeNull();
    expect(calls).toHaveLength(0);

    stampApproach(entry, 2_200);
    agentAutonomyDriver.phaseEdgePoll();
    expect(entry.talkPrefetch).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('does not start when ETA > 10 s', () => {
    const entry = registerHouse();
    stampApproach(entry, 3_000); // ETA 13.6 s
    const calls = installRuntime([TALK_REPLY]);
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(entry.talkPrefetch).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('does not start when the remaining length is unknown (null)', () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    npcSimulation.getRemainingPathLengthWu = () => null;
    const calls = installRuntime([TALK_REPLY]);
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(entry.talkPrefetch).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('never starts for a non-teaching place (cove)', () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000, 'cove');
    const calls = installRuntime([TALK_REPLY]);
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(entry.talkPrefetch).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('does not start while the talk cooldown is active for (agent, building)', () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    driver.talkCooldownUntil.set(`${AGENT}:${BUILDING}`, Date.now() + 60_000);
    const calls = installRuntime([TALK_REPLY]);
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(entry.talkPrefetch).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('does not start with a cold runtime', () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    agentOrchestrator.getRunningAgentRuntime = () => null;
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(entry.talkPrefetch).toBeNull();
  });

  it('does not start with a pending directive', () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    entry.directivePending = true;
    const calls = installRuntime([TALK_REPLY]);
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(entry.talkPrefetch).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('does not start for an agent in flight or warming', () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    const calls = installRuntime([TALK_REPLY]);

    driver.inFlight.add(AGENT);
    agentAutonomyDriver.phaseEdgePoll();
    driver.inFlight.delete(AGENT);
    driver.warming.set(AGENT, Date.now());
    agentAutonomyDriver.phaseEdgePoll();
    driver.warming.delete(AGENT);
    expect(entry.talkPrefetch).toBeNull();
    expect(calls).toHaveLength(0);

    agentAutonomyDriver.phaseEdgePoll();
    expect(entry.talkPrefetch).not.toBeNull();
    expect(drive).not.toHaveBeenCalled();
  });

  it('applies the same rule to a user agent', () => {
    const user = registerUser();
    stampApproach(user, 1_000, BUILDING, USER_BODY);
    const calls = installRuntime([TALK_REPLY]);
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(user.talkPrefetch).not.toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('talk prefetch: use at arrival', () => {
  it('the full walk -> arrived -> talk path uses the prefetched reply with one decide total', async () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    const calls = installRuntime([TALK_REPLY]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(calls).toHaveLength(1);

    // The body reaches the building: the poll wakes the walking edge.
    placeAtBuilding();
    const drives = captureRealDrives();
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    await Promise.all(drives);
    await flushMicrotasks(); // arrival settle finally clears its guard
    expect(entry.phase as DriverEntry['phase']).toBe('arrived');
    expect(entry.talkPrefetch).not.toBeNull();

    // The arrived edge runs the talk with the prefetched reply.
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    await Promise.all(drives);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe(expectedPrompt());
    expect(dispatched).toEqual([TALK_REPLY]);
    expect(teacherCalls).toEqual([{ buildingId: BUILDING, message: 'how do embeddings rank memories' }]);
    expect(entry.phase as DriverEntry['phase']).toBe('talking');
    expect(entry.talkPrefetch).toBeNull();
    expect(driver.talkCooldownUntil.has(`${AGENT}:${BUILDING}`)).toBe(true);
  });

  it('a prefetch whose directiveRevision changed is discarded and a fresh decide runs', async () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    const calls = installRuntime(['stale-reply', TALK_REPLY]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(calls).toHaveLength(1);

    placeAtBuilding();
    entry.phase = 'arrived';
    entry.directiveRevision++; // fence only (no pending directive)
    const drives = captureRealDrives();
    await agentAutonomyDriver.driveAgentNow(AGENT);
    await Promise.all(drives);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toBe(expectedPrompt());
    expect(dispatched).toEqual([TALK_REPLY]);
    expect(entry.talkPrefetch).toBeNull();
  });

  it('a directive kick clears the prefetch at once', () => {
    const user = registerUser();
    stampApproach(user, 1_000, BUILDING, USER_BODY);
    installRuntime([TALK_REPLY]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(user.talkPrefetch).not.toBeNull();

    expect(agentAutonomyDriver.kickEnrolledOwnerNow(USER_OWNER, USER_PLATFORM)).toBe(true);
    expect(user.talkPrefetch).toBeNull();
  });

  it('a prefetch for building A is not used at building B', async () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    const otherReply = `[ACTION: talk_to_npc(buildingId=${OTHER_BUILDING}, message=what is an api key)]`;
    const calls = installRuntime([TALK_REPLY, otherReply]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(entry.talkPrefetch!.buildingId).toBe(BUILDING);

    placeAtBuilding(OTHER_BUILDING);
    entry.phase = 'arrived';
    entry.targetBuildingId = OTHER_BUILDING;
    const drives = captureRealDrives();
    await agentAutonomyDriver.driveAgentNow(AGENT);
    await Promise.all(drives);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toBe(expectedPrompt(OTHER_BUILDING));
    expect(dispatched).toEqual([otherReply]);
    expect(teacherCalls).toEqual([{ buildingId: OTHER_BUILDING, message: 'what is an api key' }]);
  });

  it('a prefetch older than 60 s is not used; exactly 60 s is', async () => {
    const T0 = Date.now();
    setSystemTime(new Date(T0));
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    const calls = installRuntime(['stale-reply', TALK_REPLY]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(entry.talkPrefetch!.startedAt).toBe(T0);

    placeAtBuilding();
    entry.phase = 'arrived';
    setSystemTime(new Date(T0 + 60_001));
    const drives = captureRealDrives();
    await agentAutonomyDriver.driveAgentNow(AGENT);
    await Promise.all(drives);
    expect(calls).toHaveLength(2);
    expect(dispatched).toEqual([TALK_REPLY]);

    // Exactly 60 s old is still used.
    driver.talkCooldownUntil.clear();
    setSystemTime(new Date(T0 + 100_000));
    body().x = 11264; // back to the spawn, outside the radius
    body().y = 11264;
    stampApproach(entry, 1_000);
    const calls2 = installRuntime([TALK_REPLY]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(calls2).toHaveLength(1);
    placeAtBuilding();
    entry.phase = 'arrived';
    setSystemTime(new Date(T0 + 160_000));
    await agentAutonomyDriver.driveAgentNow(AGENT);
    await Promise.all(drives);
    expect(calls2).toHaveLength(1);
  });

  it('a rejected prefetch acts exactly like an empty decide (no retry, no teacher turn)', async () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    const calls = installRuntime([new Error('model 429'), TALK_REPLY]);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      agentAutonomyDriver.phaseEdgePoll();
      expect(await entry.talkPrefetch!.promise).toBe('');

      placeAtBuilding();
      entry.phase = 'arrived';
      const drives = captureRealDrives();
      await agentAutonomyDriver.driveAgentNow(AGENT);
      await Promise.all(drives);
    } finally {
      console.warn = originalWarn;
    }

    expect(calls).toHaveLength(1);
    expect(dispatched).toEqual(['']);
    expect(teacherCalls).toEqual([]);
    expect(entry.phase as DriverEntry['phase']).toBe('talking');
    expect(driver.talkCooldownUntil.has(`${AGENT}:${BUILDING}`)).toBe(false);
  });
});

describe('talk prefetch: discard paths', () => {
  it('unregister clears the prefetch (house and user)', () => {
    const house = registerHouse();
    stampApproach(house, 1_000);
    const user = registerUser();
    stampApproach(user, 1_000, BUILDING, USER_BODY);
    installRuntime([TALK_REPLY]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(house.talkPrefetch).not.toBeNull();
    expect(user.talkPrefetch).not.toBeNull();

    agentAutonomyDriver.unregisterHouseAgent(AGENT);
    agentAutonomyDriver.unregisterUserAgent(USER_AGENT);
    expect(house.talkPrefetch).toBeNull();
    expect(user.talkPrefetch).toBeNull();
  });

  it('a walk timeout that re-decides clears the prefetch', async () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    installRuntime([TALK_REPLY]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(entry.talkPrefetch).not.toBeNull();

    // Both deadlines in the past: no free re-route, terminal re-decide.
    const now = Date.now();
    entry.walkDeadline = now - 1;
    entry.walkEpisodeDeadline = now - 1;
    const drives = captureRealDrives();
    await agentAutonomyDriver.driveAgentNow(AGENT);
    await Promise.all(drives);

    expect(entry.phase as DriverEntry['phase']).toBe('deciding');
    expect(entry.targetBuildingId).toBeNull();
    expect(entry.talkPrefetch).toBeNull();
  });

  it('the talk cooldown at arrival clears the prefetch and skips the talk', async () => {
    const entry = registerHouse();
    stampApproach(entry, 1_000);
    const calls = installRuntime([TALK_REPLY]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(entry.talkPrefetch).not.toBeNull();

    driver.talkCooldownUntil.set(`${AGENT}:${BUILDING}`, Date.now() + 60_000);
    placeAtBuilding();
    entry.phase = 'arrived';
    const drives = captureRealDrives();
    await agentAutonomyDriver.driveAgentNow(AGENT);
    await Promise.all(drives);

    expect(calls).toHaveLength(1);
    expect(dispatched).toEqual([]);
    expect(entry.phase as DriverEntry['phase']).toBe('talking');
    expect(entry.talkPrefetch).toBeNull();
  });
});
