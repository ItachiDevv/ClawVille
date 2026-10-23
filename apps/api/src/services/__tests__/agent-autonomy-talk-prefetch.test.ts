import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { BUILDING_INTERACTION_RADIUS, NPC_BUILDING_CENTERS } from '@clawville/shared';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import { decidePriorTalkQuestionsWrite, type PriorTalkQuestionsSnapshot } from '../agent-autonomy-state';
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
  priorQuestionsHydrated: boolean;
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
  priorTalkQuestions: Map<string, string[]>;
  priorQuestionsOwner: Map<string, { owner: string | null; setAt: number }>;
  lastPriorQuestionsOwnerStamp: number;
  getPriorQuestions: (agentId: string, buildingId: string) => readonly string[];
  recordPriorQuestion: (agentId: string, buildingId: string, raw: string) => void;
  hydratePriorQuestionsOnce: (entry: DriverEntry) => Promise<void>;
  priorQuestionsRead: (platformAgentId: string, ownerUserId: string | null) => Promise<PriorTalkQuestionsSnapshot>;
  priorQuestionsWrite: (
    platformAgentId: string,
    ownerUserId: string | null,
    buildingId: string,
    questions: readonly string[],
    ownerSetAt: number,
  ) => Promise<void>;
  runReconcile: () => Promise<void>;
  readDirectiveBounded: (platformAgentId: string) => Promise<null>;
  readRecentLessons: () => Promise<string[]>;
  readRecentKnowledge: () => Promise<string[]>;
  arrivalSettle: (...args: any[]) => Promise<null>;
  teacherTurn: (...args: any[]) => Promise<unknown>;
  buildTalkPrompt: (
    buildingId: string,
    label: string | undefined,
    cryptoFocus: string | undefined,
    priorQuestions: readonly string[],
  ) => string;
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
const originalPriorRead = driver.priorQuestionsRead;
const originalPriorWrite = driver.priorQuestionsWrite;
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

/** The talk prompt for `buildingId` with an explicit prior-question list. */
function expectedPrompt(buildingId = BUILDING, prior: readonly string[] = []): string {
  const building = npcSimulation.buildPerception(BODY)!.nearbyBuildings.find(
    (b) => b.buildingId === buildingId,
  )!;
  return driver.buildTalkPrompt(buildingId, building.label, building.cryptoFocus, prior);
}

let drive: ReturnType<typeof mock>;
let dispatched: string[];
let teacherCalls: Array<{ buildingId: string; message: string }>;
type PriorWrite = { platformAgentId: string; ownerUserId: string | null; buildingId: string; questions: string[] };
let priorWrites: PriorWrite[];
let priorWriteStamps: number[];
let priorReads: Array<{ platformAgentId: string; ownerUserId: string | null }>;

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
  driver.priorTalkQuestions.clear();
  driver.priorQuestionsOwner.clear();
  driver.lastPriorQuestionsOwnerStamp = 0;
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
  priorWrites = [];
  priorWriteStamps = [];
  priorReads = [];
  driver.priorQuestionsRead = async (platformAgentId, ownerUserId) => {
    priorReads.push({ platformAgentId, ownerUserId });
    return { questions: new Map(), present: false, storedOwnerUserId: null, storedOwnerSetAt: null };
  };
  driver.priorQuestionsWrite = async (platformAgentId, ownerUserId, buildingId, questions, ownerSetAt) => {
    priorWrites.push({ platformAgentId, ownerUserId, buildingId, questions: [...questions] });
    priorWriteStamps.push(ownerSetAt);
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
  driver.priorQuestionsRead = originalPriorRead;
  driver.priorQuestionsWrite = originalPriorWrite;
  agentAutonomyDriver.covenantRecord = originalCovenantRecord;
  agentOrchestrator.getRunningAgentRuntime = originalGetRuntime;
  agentOrchestrator.ensureAgentRuntime = originalEnsureRuntime;
  npcSimulation.dispatchHatcherActions = originalDispatch;
  npcSimulation.getRemainingPathLengthWu = originalRemaining;
  driver.inFlight.clear();
  driver.warming.clear();
  driver.arrivalSettling.clear();
  driver.talkCooldownUntil.clear();
  driver.priorTalkQuestions.clear();
  driver.priorQuestionsOwner.clear();
  driver.lastPriorQuestionsOwnerStamp = 0;
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

// Founder 2026-10-22: the talk prompt lists the agent's own last 4 questions to
// that teacher so it stops asking the same question on every visit. The list
// changes only at the talk mutation point (after extractTalkMessage), so a
// prefetch built during the approach still equals the arrival prompt.
describe('talk prompt: prior questions to the same teacher', () => {
  function talkReply(buildingId: string, message: string): string {
    return `[ACTION: talk_to_npc(buildingId=${buildingId}, message=${message})]`;
  }

  /** One arrived-branch talk at `buildingId` (no prefetch), via the real drive. */
  async function talkAt(entry: DriverEntry, buildingId: string, message: string): Promise<DecideCall[]> {
    driver.talkCooldownUntil.clear();
    const calls = installRuntime([talkReply(buildingId, message)]);
    placeAtBuilding(buildingId);
    entry.phase = 'arrived';
    entry.targetBuildingId = buildingId;
    entry.talkPrefetch = null;
    captureRealDrives();
    await agentAutonomyDriver.driveAgentNow(AGENT);
    expect(calls).toHaveLength(1);
    return calls;
  }

  function captureLogs(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    return { lines, restore: () => { console.log = original; } };
  }

  it('first visit: the prompt is byte-identical to the pre-2026-10-22 form and logs prior=0', async () => {
    const entry = registerHouse();
    const building = npcSimulation.buildPerception(BODY)!.nearbyBuildings.find(
      (b) => b.buildingId === BUILDING,
    )!;
    const legacy = [
      `You have arrived at "${building.label}"${building.cryptoFocus ? `, which teaches ${building.cryptoFocus}` : ''}.`,
      'Greet the teacher and ask ONE focused question about their topic.',
      'Reply with EXACTLY this action tag (the message must be a single short clause',
      'with NO commas and NO parentheses):',
      `[ACTION: talk_to_npc(buildingId=${BUILDING}, message=your short question here)]`,
    ].join('\n');
    expect(expectedPrompt()).toBe(legacy);

    const logs = captureLogs();
    let calls: DecideCall[];
    try {
      calls = await talkAt(entry, BUILDING, 'what is a vector index');
    } finally {
      logs.restore();
    }
    expect(calls[0]!.prompt).toBe(legacy);
    expect(calls[0]!.prompt).not.toContain('You already asked');
    expect(logs.lines.some((l) => l.includes('[AutonomyDriver][debug] talk ') && l.includes(' prior=0 '))).toBe(true);
  });

  it('the empty-list prompt equals a LITERAL string (byte equality pinned independently of buildTalkPrompt)', async () => {
    const entry = registerHouse();
    const literal = 'You have arrived at "Squidward\'s House", which teaches RAG pipelines, vector databases, text embeddings, semantic search, and context management.\n'
      + 'Greet the teacher and ask ONE focused question about their topic.\n'
      + 'Reply with EXACTLY this action tag (the message must be a single short clause\n'
      + 'with NO commas and NO parentheses):\n'
      + '[ACTION: talk_to_npc(buildingId=memory-rag, message=your short question here)]';
    const calls = await talkAt(entry, BUILDING, 'what is a vector index');
    expect(calls[0]!.prompt).toBe(literal);
  });

  it('a question asked at X appears in the next prompt at X, not at Y', async () => {
    const entry = registerHouse();
    await talkAt(entry, BUILDING, 'what is a vector index');

    const atX = await talkAt(entry, BUILDING, 'how does chunking work');
    expect(atX[0]!.prompt).toBe(expectedPrompt(BUILDING, ['what is a vector index']));
    expect(atX[0]!.prompt).toContain(
      'Greet the teacher and ask ONE focused question about their topic.\n'
      + 'You already asked this teacher (your own past questions, shown only so you do not repeat them):\n'
      + '- what is a vector index\n'
      + 'Ask about a DIFFERENT part of the topic. Do not repeat or rephrase these questions.\n'
      + 'Reply with EXACTLY this action tag',
    );
    expect(atX[0]!.prompt).toContain(
      `[ACTION: talk_to_npc(buildingId=${BUILDING}, message=your short question here)]`,
    );

    const atY = await talkAt(entry, OTHER_BUILDING, 'what is an api key');
    expect(atY[0]!.prompt).toBe(expectedPrompt(OTHER_BUILDING, []));
    expect(atY[0]!.prompt).not.toContain('vector index');
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual([
      'what is a vector index',
      'how does chunking work',
    ]);
    expect(driver.getPriorQuestions(AGENT, OTHER_BUILDING)).toEqual(['what is an api key']);
  });

  it('keeps only the last 4 questions (newest last)', async () => {
    const entry = registerHouse();
    const asked = ['ask alpha', 'ask bravo', 'ask charlie', 'ask delta', 'ask echo'];
    for (const q of asked) await talkAt(entry, BUILDING, q);
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual(asked.slice(1));

    const next = await talkAt(entry, BUILDING, 'ask foxtrot');
    expect(next[0]!.prompt).toBe(expectedPrompt(BUILDING, asked.slice(1)));
    expect(next[0]!.prompt).not.toContain('ask alpha');
  });

  it('normalizes: whitespace collapses, trimmed, capped at 160 chars, empty skipped, repeat moves to newest', () => {
    driver.recordPriorQuestion(AGENT, BUILDING, '  what is\n\n  a   vector\tindex  ');
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual(['what is a vector index']);

    driver.recordPriorQuestion(AGENT, BUILDING, ' \n\t ');
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toHaveLength(1);

    const long = 'x'.repeat(300);
    driver.recordPriorQuestion(AGENT, BUILDING, long);
    const stored = driver.getPriorQuestions(AGENT, BUILDING);
    expect(stored).toHaveLength(2);
    expect(stored[1]).toBe('x'.repeat(160));

    driver.recordPriorQuestion(AGENT, BUILDING, 'what is a vector index');
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual(['x'.repeat(160), 'what is a vector index']);
  });

  it('a prefetch built with a non-empty prior list is still used; its question shows only in the NEXT prompt', async () => {
    const entry = registerHouse();
    driver.recordPriorQuestion(AGENT, BUILDING, 'what is a vector index');
    stampApproach(entry, 1_000);
    const calls = installRuntime([TALK_REPLY]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(calls).toHaveLength(1);
    const prefetchPrompt = expectedPrompt(BUILDING, ['what is a vector index']);
    expect(calls[0]!.prompt).toBe(prefetchPrompt);
    expect(entry.talkPrefetch!.prompt).toBe(prefetchPrompt);

    placeAtBuilding();
    entry.phase = 'arrived';
    captureRealDrives();
    const logs = captureLogs();
    try {
      await agentAutonomyDriver.driveAgentNow(AGENT);
    } finally {
      logs.restore();
    }

    expect(calls).toHaveLength(1); // the prefetch was the only decide call
    expect(logs.lines.some((l) => l.includes('talk prefetch used'))).toBe(true);
    expect(logs.lines.some((l) => l.includes('[AutonomyDriver][debug] talk ') && l.includes(' prior=1 '))).toBe(true);
    expect(calls[0]!.prompt).not.toContain('how do embeddings rank memories');
    expect(dispatched).toEqual([TALK_REPLY]);
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual([
      'what is a vector index',
      'how do embeddings rank memories',
    ]);

    const next = await talkAt(entry, BUILDING, 'how does chunking work');
    expect(next[0]!.prompt).toBe(
      expectedPrompt(BUILDING, ['what is a vector index', 'how do embeddings rank memories']),
    );
  });

  it('records the question even when the teacher turn returns null (no cooldown stamp)', async () => {
    const entry = registerHouse();
    driver.teacherTurn = async (input: { buildingId: string; message: string }) => {
      teacherCalls.push({ buildingId: input.buildingId, message: input.message });
      return null;
    };
    await talkAt(entry, BUILDING, 'what is a vector index');
    expect(teacherCalls).toEqual([{ buildingId: BUILDING, message: 'what is a vector index' }]);
    expect(driver.talkCooldownUntil.has(`${AGENT}:${BUILDING}`)).toBe(false);
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual(['what is a vector index']);
    expect(priorWrites).toEqual([
      { platformAgentId: PLATFORM, ownerUserId: OWNER, buildingId: BUILDING, questions: ['what is a vector index'] },
    ]);
  });

  it('a reply with no talk tag records nothing', async () => {
    const entry = registerHouse();
    const calls = installRuntime(['I will just look around.']);
    placeAtBuilding();
    entry.phase = 'arrived';
    entry.targetBuildingId = BUILDING;
    captureRealDrives();
    await agentAutonomyDriver.driveAgentNow(AGENT);
    expect(calls).toHaveLength(1);
    expect(teacherCalls).toEqual([]);
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual([]);
    expect(priorWrites).toEqual([]);
  });
});

// Founder 2026-10-22 ("make it so it survives a restart"): the prior-question
// list is persisted after each talk (config.priorTalkQuestions) and reloaded
// once per entry on the first deciding drive, before any walk or prefetch.
describe('prior questions: persist after a talk, reload once after a restart', () => {
  function talkReply(buildingId: string, message: string): string {
    return `[ACTION: talk_to_npc(buildingId=${buildingId}, message=${message})]`;
  }

  async function talkAt(entry: DriverEntry, buildingId: string, message: string): Promise<DecideCall[]> {
    driver.talkCooldownUntil.clear();
    const calls = installRuntime([talkReply(buildingId, message)]);
    placeAtBuilding(buildingId);
    entry.phase = 'arrived';
    entry.targetBuildingId = buildingId;
    entry.talkPrefetch = null;
    captureRealDrives();
    await agentAutonomyDriver.driveAgentNow(AGENT);
    expect(calls).toHaveLength(1);
    return calls;
  }

  function captureLogs(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    return { lines, restore: () => { console.log = original; } };
  }

  /** A same-owner stored snapshot without a stamp (pre-stamp row shape). */
  function storedMap(entries: Array<[string, string[]]>): PriorTalkQuestionsSnapshot {
    return { questions: new Map(entries), present: true, storedOwnerUserId: OWNER, storedOwnerSetAt: null };
  }

  it('each talk writes the full normalized list once, keyed by platform agent + owner + building', async () => {
    const entry = registerHouse();
    await talkAt(entry, BUILDING, 'what is a vector index');
    await talkAt(entry, BUILDING, 'how does chunking work');
    await talkAt(entry, OTHER_BUILDING, 'what is an api key');
    expect(priorWrites).toEqual([
      { platformAgentId: PLATFORM, ownerUserId: OWNER, buildingId: BUILDING, questions: ['what is a vector index'] },
      {
        platformAgentId: PLATFORM,
        ownerUserId: OWNER,
        buildingId: BUILDING,
        questions: ['what is a vector index', 'how does chunking work'],
      },
      { platformAgentId: PLATFORM, ownerUserId: OWNER, buildingId: OTHER_BUILDING, questions: ['what is an api key'] },
    ]);
  });

  it('a failed write is fail-soft: the talk completes, the in-memory list stays, the warn is digest-only', async () => {
    const entry = registerHouse();
    driver.priorQuestionsWrite = async () => {
      throw new Error('db down');
    };
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      await talkAt(entry, BUILDING, 'what is a vector index');
      await flushMicrotasks();
    } finally {
      console.warn = originalWarn;
    }
    expect(entry.phase as DriverEntry['phase']).toBe('talking');
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual(['what is a vector index']);
    const persistWarns = warns.filter((w) => w.includes('prior questions persist failed'));
    expect(persistWarns).toHaveLength(1);
    expect(persistWarns[0]).not.toContain(AGENT);
    expect(persistWarns[0]).not.toContain('vector index');
    expect(persistWarns[0]).not.toContain('db down');
  });

  it('hydrate fills only keys missing in memory (in-memory wins)', async () => {
    const entry = registerHouse();
    driver.recordPriorQuestion(AGENT, BUILDING, 'question from memory');
    driver.priorQuestionsRead = async (platformAgentId, ownerUserId) => {
      priorReads.push({ platformAgentId, ownerUserId });
      return storedMap([
        [BUILDING, ['stored question here']],
        [OTHER_BUILDING, ['stored other question']],
      ]);
    };
    const logs = captureLogs();
    try {
      await driver.hydratePriorQuestionsOnce(entry);
    } finally {
      logs.restore();
    }
    expect(priorReads).toEqual([{ platformAgentId: PLATFORM, ownerUserId: OWNER }]);
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual(['question from memory']);
    expect(driver.getPriorQuestions(AGENT, OTHER_BUILDING)).toEqual(['stored other question']);
    expect(entry.priorQuestionsHydrated).toBe(true);
    expect(logs.lines.some((l) => l.includes('prior questions hydrated') && l.includes('buildings=1'))).toBe(true);
    expect(logs.lines.some((l) => l.includes(AGENT))).toBe(false);
  });

  it('the first deciding drive hydrates once per entry; a hydrated question shows in the first talk prompt with prior=1', async () => {
    const entry = registerHouse();
    expect(entry.priorQuestionsHydrated).toBe(false);
    driver.priorQuestionsRead = async (platformAgentId, ownerUserId) => {
      priorReads.push({ platformAgentId, ownerUserId });
      return storedMap([[BUILDING, ['what is a vector index']]]);
    };
    installRuntime(['']);
    captureRealDrives();
    await agentAutonomyDriver.driveAgentNow(AGENT);
    expect(entry.phase as DriverEntry['phase']).toBe('deciding');
    expect(priorReads).toEqual([{ platformAgentId: PLATFORM, ownerUserId: OWNER }]);
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual(['what is a vector index']);

    // A second deciding drive does not read again.
    entry.edgeDecideAt = 0;
    await agentAutonomyDriver.driveAgentNow(AGENT);
    expect(priorReads).toHaveLength(1);

    const logs = captureLogs();
    let calls: DecideCall[];
    try {
      calls = await talkAt(entry, BUILDING, 'how does chunking work');
    } finally {
      logs.restore();
    }
    expect(calls[0]!.prompt).toBe(expectedPrompt(BUILDING, ['what is a vector index']));
    expect(logs.lines.some((l) => l.includes('[AutonomyDriver][debug] talk ') && l.includes(' prior=1 '))).toBe(true);
    expect(priorWrites.at(-1)!.questions).toEqual(['what is a vector index', 'how does chunking work']);
  });

  it('a hydrate result that arrives after the timeout is never applied', async () => {
    const entry = registerHouse();
    let release!: (value: PriorTalkQuestionsSnapshot) => void;
    driver.priorQuestionsRead = (platformAgentId, ownerUserId) => {
      priorReads.push({ platformAgentId, ownerUserId });
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const stampBefore = driver.priorQuestionsOwner.get(AGENT)!.setAt;
    const startedAt = Date.now();
    const logs = captureLogs();
    try {
      await driver.hydratePriorQuestionsOnce(entry);
    } finally {
      logs.restore();
    }
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual([]);
    expect(logs.lines.some((l) => l.includes('prior questions reload unavailable') && l.includes('stamp not reconciled'))).toBe(true);
    expect(logs.lines.some((l) => l.includes(AGENT))).toBe(false);

    // A late snapshot with a far-future stored stamp changes neither the
    // questions nor the stamp.
    release({
      questions: new Map([[BUILDING, ['late stored question']]]),
      present: true,
      storedOwnerUserId: 'some-other-owner',
      storedOwnerSetAt: Date.now() + 600_000,
    });
    await flushMicrotasks();
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual([]);
    expect(driver.priorQuestionsOwner.get(AGENT)!.setAt).toBe(stampBefore);
    // The guard was set before the read: no second attempt.
    await driver.hydratePriorQuestionsOnce(entry);
    expect(priorReads).toHaveLength(1);
  });

  it('a failed hydrate read is fail-soft (empty) and is not retried', async () => {
    const entry = registerHouse();
    driver.priorQuestionsRead = async (platformAgentId, ownerUserId) => {
      priorReads.push({ platformAgentId, ownerUserId });
      throw new Error('db down');
    };
    await driver.hydratePriorQuestionsOnce(entry);
    await driver.hydratePriorQuestionsOnce(entry);
    expect(priorReads).toHaveLength(1);
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual([]);
  });

  it('questions recorded under owner A are not in the prompt nor the write after a re-register under owner B', async () => {
    const OWNER_B = 'talk-prefetch-owner-b';
    const entry = registerHouse();
    await talkAt(entry, BUILDING, 'question from owner a');
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual(['question from owner a']);

    // Same owner re-register keeps the list (survives off/on) and the stamp.
    const same = registerHouse();
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual(['question from owner a']);
    expect(same).not.toBe(entry);
    await talkAt(same, OTHER_BUILDING, 'second question from owner a');
    expect(priorWriteStamps).toHaveLength(2);
    expect(Number.isSafeInteger(priorWriteStamps[0])).toBe(true);
    expect(priorWriteStamps[1]).toBe(priorWriteStamps[0]);
    const stampA = priorWriteStamps[0]!;

    sim.npcs.set(BODY, makeBody(BODY));
    expect(agentAutonomyDriver.registerHouseAgent({
      agentId: AGENT,
      bodyId: BODY,
      platformAgentId: PLATFORM,
      systemUserId: `system-${OWNER_B}`,
      houseUserId: OWNER_B,
      avatarId: `avatar-${AGENT}`,
    })).toBe(true);
    const entryB = driver.houseAgents.get(AGENT)!;
    entryB.cursorSeeded = true;
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual([]);

    priorWrites = [];
    priorWriteStamps = [];
    const calls = await talkAt(entryB, BUILDING, 'question from owner b');
    expect(calls[0]!.prompt).toBe(expectedPrompt(BUILDING, []));
    expect(calls[0]!.prompt).not.toContain('owner a');
    expect(priorWrites).toEqual([
      { platformAgentId: PLATFORM, ownerUserId: OWNER_B, buildingId: BUILDING, questions: ['question from owner b'] },
    ]);
    // The new owner generation carries a strictly larger stamp.
    expect(priorWriteStamps).toHaveLength(1);
    expect(priorWriteStamps[0]!).toBeGreaterThan(stampA);
  });

  it('a user re-enroll with the same body and avatar but a new owner re-seats and drops the old questions', () => {
    const user = registerUser();
    driver.recordPriorQuestion(USER_AGENT, BUILDING, 'user owner a question');
    const sizeBefore = agentAutonomyDriver.getUserAgentIds().length;
    // Same-owner keepalive: reused, live entry untouched, list kept.
    expect(agentAutonomyDriver.registerUserAgent({
      agentId: USER_AGENT,
      bodyId: USER_BODY,
      platformAgentId: USER_PLATFORM,
      systemUserId: USER_OWNER,
      houseUserId: USER_OWNER,
      avatarId: `avatar-${USER_AGENT}`,
    })).toEqual({ ok: true, reused: true });
    expect(driver.userAgents.get(USER_AGENT)).toBe(user);
    expect(driver.getPriorQuestions(USER_AGENT, BUILDING)).toEqual(['user owner a question']);

    expect(agentAutonomyDriver.registerUserAgent({
      agentId: USER_AGENT,
      bodyId: USER_BODY,
      platformAgentId: USER_PLATFORM,
      systemUserId: 'talk-prefetch-user-owner-b',
      houseUserId: 'talk-prefetch-user-owner-b',
      avatarId: `avatar-${USER_AGENT}`,
    })).toEqual({ ok: true, reused: true });
    const reseated = driver.userAgents.get(USER_AGENT)!;
    expect(reseated).not.toBe(user);
    expect(driver.getPriorQuestions(USER_AGENT, BUILDING)).toEqual([]);
    expect(agentAutonomyDriver.isOwnerEnrolled(USER_OWNER)).toBe(false);
    expect(agentAutonomyDriver.isOwnerEnrolled('talk-prefetch-user-owner-b')).toBe(true);
    expect(agentAutonomyDriver.getUserAgentIds()).toHaveLength(sizeBefore);
  });

  it('a hydrate result for an entry re-seated during the read is not applied', async () => {
    const entry = registerHouse();
    let release!: (value: PriorTalkQuestionsSnapshot) => void;
    driver.priorQuestionsRead = () => new Promise((resolve) => {
      release = resolve;
    });
    const pending = driver.hydratePriorQuestionsOnce(entry);
    await flushMicrotasks(); // the read starts on a microtask
    expect(typeof release).toBe('function');
    sim.npcs.set(BODY, makeBody(BODY));
    agentAutonomyDriver.registerHouseAgent({
      agentId: AGENT,
      bodyId: BODY,
      platformAgentId: PLATFORM,
      systemUserId: 'system-other',
      houseUserId: 'talk-prefetch-owner-b',
      avatarId: `avatar-${AGENT}`,
    });
    release(storedMap([[BUILDING, ['owner a stored question']]]));
    await pending;
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual([]);
  });

  // Codex r2 P2: a clock rollback across a restart must not leave the driver
  // below the stored stamp (the write CASE would skip its writes forever).
  it('restart with a rolled-back clock: owner B after hydrate writes above the stored owner-A stamp (replace); a delayed A write is skipped', async () => {
    const OWNER_A = 'talk-prefetch-owner-a';
    const storedStamp = Date.now() + 600_000; // written by a process with a fast clock
    // This process saw owner A first, then the agent moved to OWNER (B).
    sim.npcs.set(BODY, makeBody(BODY));
    agentAutonomyDriver.registerHouseAgent({
      agentId: AGENT,
      bodyId: BODY,
      platformAgentId: PLATFORM,
      systemUserId: `system-${OWNER_A}`,
      houseUserId: OWNER_A,
      avatarId: `avatar-${AGENT}`,
    });
    const stampAThisProcess = driver.priorQuestionsOwner.get(AGENT)!.setAt;
    const entry = registerHouse(); // owner B = OWNER
    expect(driver.priorQuestionsOwner.get(AGENT)!.setAt).toBeLessThan(storedStamp);

    const storedObject = { ownerUserId: OWNER_A, ownerSetAt: storedStamp, byBuilding: { [BUILDING]: ['owner a question'] } };
    driver.priorQuestionsRead = async () => ({
      questions: new Map(), // owner mismatch: no questions for B
      present: true,
      storedOwnerUserId: OWNER_A,
      storedOwnerSetAt: storedStamp,
    });
    await driver.hydratePriorQuestionsOnce(entry);
    expect(driver.getPriorQuestions(AGENT, BUILDING)).toEqual([]);
    expect(driver.priorQuestionsOwner.get(AGENT)!.setAt).toBe(storedStamp + 1);

    await talkAt(entry, BUILDING, 'question from owner b');
    const stampB = priorWriteStamps.at(-1)!;
    expect(stampB).toBeGreaterThan(storedStamp);
    expect(decidePriorTalkQuestionsWrite(storedObject, OWNER, stampB)).toBe('replace');

    // After B's write, a delayed owner-A write from this process is skipped.
    const afterB = { ownerUserId: OWNER, ownerSetAt: stampB, byBuilding: { [BUILDING]: ['question from owner b'] } };
    expect(stampAThisProcess).toBeLessThan(stampB);
    expect(decidePriorTalkQuestionsWrite(afterB, OWNER_A, stampAThisProcess)).toBe('skip');

    // Later owner changes in this process get even larger stamps.
    sim.npcs.set(BODY, makeBody(BODY));
    agentAutonomyDriver.registerHouseAgent({
      agentId: AGENT,
      bodyId: BODY,
      platformAgentId: PLATFORM,
      systemUserId: 'system-owner-c',
      houseUserId: 'talk-prefetch-owner-c',
      avatarId: `avatar-${AGENT}`,
    });
    expect(driver.priorQuestionsOwner.get(AGENT)!.setAt).toBeGreaterThan(stampB);
  });

  it('restart with a rolled-back clock, same owner: the stamp is raised to the stored value (merge)', async () => {
    const storedStamp = Date.now() + 600_000;
    const entry = registerHouse();
    driver.priorQuestionsRead = async () => ({
      questions: new Map([[BUILDING, ['what is a vector index']]]),
      present: true,
      storedOwnerUserId: OWNER,
      storedOwnerSetAt: storedStamp,
    });
    await driver.hydratePriorQuestionsOnce(entry);
    expect(driver.priorQuestionsOwner.get(AGENT)!.setAt).toBe(storedStamp);
    await talkAt(entry, BUILDING, 'how does chunking work');
    expect(priorWriteStamps).toEqual([storedStamp]);
    const storedObject = { ownerUserId: OWNER, ownerSetAt: storedStamp, byBuilding: { [BUILDING]: ['what is a vector index'] } };
    expect(decidePriorTalkQuestionsWrite(storedObject, OWNER, storedStamp)).toBe('merge');
  });

  it('a stored stamp below the in-memory stamp is never used to lower it', async () => {
    const entry = registerHouse();
    const before = driver.priorQuestionsOwner.get(AGENT)!.setAt;
    driver.priorQuestionsRead = async () => ({
      questions: new Map(),
      present: true,
      storedOwnerUserId: 'talk-prefetch-owner-a',
      storedOwnerSetAt: before - 10_000,
    });
    await driver.hydratePriorQuestionsOnce(entry);
    expect(driver.priorQuestionsOwner.get(AGENT)!.setAt).toBe(before);
  });

  it('a talk prefetch built from a hydrated list is still used at arrival', async () => {
    const entry = registerHouse();
    driver.priorQuestionsRead = async () => storedMap([[BUILDING, ['what is a vector index']]]);
    await driver.hydratePriorQuestionsOnce(entry);

    stampApproach(entry, 1_000);
    const calls = installRuntime([TALK_REPLY]);
    agentAutonomyDriver.phaseEdgePoll();
    expect(calls).toHaveLength(1);
    expect(entry.talkPrefetch!.prompt).toBe(expectedPrompt(BUILDING, ['what is a vector index']));

    placeAtBuilding();
    entry.phase = 'arrived';
    captureRealDrives();
    const logs = captureLogs();
    try {
      await agentAutonomyDriver.driveAgentNow(AGENT);
    } finally {
      logs.restore();
    }
    expect(calls).toHaveLength(1);
    expect(logs.lines.some((l) => l.includes('talk prefetch used'))).toBe(true);
    expect(logs.lines.some((l) => l.includes('[AutonomyDriver][debug] talk ') && l.includes(' prior=1 '))).toBe(true);
    expect(dispatched).toEqual([TALK_REPLY]);
    expect(priorWrites).toEqual([
      {
        platformAgentId: PLATFORM,
        ownerUserId: OWNER,
        buildingId: BUILDING,
        questions: ['what is a vector index', 'how do embeddings rank memories'],
      },
    ]);
  });
});
