import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { BUILDING_INTERACTION_RADIUS, NPC_BUILDING_CENTERS } from '@clawville/shared';
import { agentAutonomyDriver } from '../agent-autonomy-driver';
import { agentOrchestrator } from '../agent-orchestrator';
import {
  armAutonomy,
  autonomyStandbyTestSeams,
  enterStandby,
} from '../autonomy-standby';
import {
  getFindPathCallCount,
  isCollisionFreeWorld,
  resetFindPathCallCount,
} from '../pathfinding';
import { npcSimulation } from '../npc-simulation';

// Phase-edge poll (founder 2026-10-20: "faster path, same decision"). The poll
// wakes an agent between 30 s ticks ONLY at a phase edge, through the same
// driveAgentNow the tick calls. These tests pin which entries it wakes and that
// a woken arrival takes the real arrival branch, never the wedge/re-route one.

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
  edgeDecideAt: number;
};

type DriverInternals = {
  houseAgents: Map<string, DriverEntry>;
  userAgents: Map<string, DriverEntry>;
  inFlight: Set<string>;
  warming: Map<string, number>;
  arrivalSettling: Map<string, object>;
  tick: () => void;
  runReconcile: () => Promise<void>;
  interval: ReturnType<typeof setInterval> | null;
  phaseEdgeInterval: ReturnType<typeof setInterval> | null;
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
const AGENT = 'phase-edge-agent';
const BODY = 'phase-edge-body';
const PLATFORM = 'phase-edge-platform';
const OWNER = 'phase-edge-owner';
const USER_AGENT = 'phase-edge-user-agent';
const USER_BODY = 'phase-edge-user-body';
const USER_PLATFORM = 'phase-edge-user-platform';
const USER_OWNER = 'phase-edge-user-owner';
const TALK_COOLDOWN_MS = 60_000; // mirrors the driver's private constant

const originalDriveAgentNow = agentAutonomyDriver.driveAgentNow;
const originalRunReconcile = driver.runReconcile;
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
    name: 'PhaseEdgeAgent',
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
  if (!found) throw new Error(`Missing phase-edge body ${id}`);
  return found;
}

function coveCenter(): { x: number; y: number } {
  const cove = npcSimulation.buildPerception(BODY)!.places.find(
    (place) => place.destinationId === 'cove',
  )!;
  return { x: cove.centerX, y: cove.centerY };
}

/** A real driver-stamped walk toward the Cove (deadlines in the future). */
function stampWalk(entry: DriverEntry, now = Date.now()): void {
  entry.phase = 'walking';
  entry.phaseSince = now;
  entry.targetBuildingId = 'cove';
  entry.walkDeadline = now + 999_999;
  entry.walkEpisodeDeadline = now + 300_000;
  entry.walkReplans = 0;
  entry.lastRemainingWu = null;
}

/** Same helper as agent-autonomy-walk-budget.test.ts (T12). */
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

const warmRuntime = () => ({}) as never;
const coldRuntime = () => null;

let drive: ReturnType<typeof mock>;

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
  driver.runReconcile = async () => {};
  driver.readDirectiveBounded = async () => null;
  driver.readRecentLessons = async () => [];
  driver.readRecentKnowledge = async () => [];
  driver.arrivalSettle = async () => null;
  agentAutonomyDriver.covenantRecord = async () => ({ id: 'phase-edge', deduped: false });
  // Never let a poll in these tests warm or reach a real runtime.
  agentOrchestrator.ensureAgentRuntime = async () => null;
  agentOrchestrator.getRunningAgentRuntime = coldRuntime;
  drive = mock(async () => true);
  agentAutonomyDriver.driveAgentNow = drive as unknown as typeof agentAutonomyDriver.driveAgentNow;
  armAutonomy(15);
  resetFindPathCallCount();
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
  agentAutonomyDriver.covenantRecord = originalCovenantRecord;
  agentOrchestrator.getRunningAgentRuntime = originalGetRuntime;
  agentOrchestrator.ensureAgentRuntime = originalEnsureRuntime;
  driver.inFlight.clear();
  driver.warming.clear();
  driver.arrivalSettling.clear();
  for (const id of agentAutonomyDriver.getHouseAgentIds()) {
    agentAutonomyDriver.unregisterHouseAgent(id);
  }
  for (const id of agentAutonomyDriver.getUserAgentIds()) {
    agentAutonomyDriver.unregisterUserAgent(id);
  }
  autonomyStandbyTestSeams.restoreDefault();
});

describe('phase-edge poll: which entries wake', () => {
  it('standby returns [] and drives nothing', () => {
    const entry = registerHouse();
    const cove = coveCenter();
    body().x = cove.x;
    body().y = cove.y;
    stampWalk(entry);
    enterStandby();

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(drive).not.toHaveBeenCalled();
  });

  it('wakes a walk that has arrived', () => {
    const entry = registerHouse();
    const cove = coveCenter();
    body().x = cove.x;
    body().y = cove.y;
    stampWalk(entry);

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    expect(drive).toHaveBeenCalledTimes(1);
    expect(drive).toHaveBeenCalledWith(AGENT);
  });

  it('does not wake a walk that has not arrived', () => {
    const entry = registerHouse();
    stampWalk(entry);
    const cove = npcSimulation.buildPerception(BODY)!.places.find(
      (place) => place.destinationId === 'cove',
    )!;
    // The default spawn is far from the Cove: this walk is mid-route.
    expect(cove.distance).toBeGreaterThan(BUILDING_INTERACTION_RADIUS);

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(drive).not.toHaveBeenCalled();
  });

  it('does not wake an arrived walk with a pending directive', () => {
    const entry = registerHouse();
    const cove = coveCenter();
    body().x = cove.x;
    body().y = cove.y;
    stampWalk(entry);
    entry.directivePending = true;

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(drive).not.toHaveBeenCalled();
  });

  it('wakes arrived with a warm runtime, not with a cold one', () => {
    const entry = registerHouse();
    entry.phase = 'arrived';
    entry.phaseSince = Date.now();
    entry.targetBuildingId = 'memory-rag';

    agentOrchestrator.getRunningAgentRuntime = coldRuntime;
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(drive).not.toHaveBeenCalled();

    agentOrchestrator.getRunningAgentRuntime = warmRuntime;
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    expect(drive).toHaveBeenCalledTimes(1);
  });

  it('does not wake arrived with no target (that drive would be a decide)', () => {
    const entry = registerHouse();
    entry.phase = 'arrived';
    entry.targetBuildingId = null;
    agentOrchestrator.getRunningAgentRuntime = warmRuntime;

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(drive).not.toHaveBeenCalled();
  });

  it('talking wakes only after TALK_COOLDOWN_MS and only with a warm runtime', () => {
    const entry = registerHouse();
    const now = 1_000_000_000;
    entry.phase = 'talking';
    entry.phaseSince = now;
    entry.targetBuildingId = 'cove';

    agentOrchestrator.getRunningAgentRuntime = warmRuntime;
    expect(agentAutonomyDriver.phaseEdgePoll(now + TALK_COOLDOWN_MS - 1)).toEqual([]);
    expect(drive).not.toHaveBeenCalled();

    agentOrchestrator.getRunningAgentRuntime = coldRuntime;
    expect(agentAutonomyDriver.phaseEdgePoll(now + TALK_COOLDOWN_MS)).toEqual([]);
    expect(drive).not.toHaveBeenCalled();

    agentOrchestrator.getRunningAgentRuntime = warmRuntime;
    expect(agentAutonomyDriver.phaseEdgePoll(now + TALK_COOLDOWN_MS)).toEqual([AGENT]);
    expect(drive).toHaveBeenCalledTimes(1);
  });

  it('never wakes deciding', () => {
    const entry = registerHouse();
    entry.phase = 'deciding';
    entry.phaseSince = 0;
    agentOrchestrator.getRunningAgentRuntime = warmRuntime;

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(drive).not.toHaveBeenCalled();
  });

  it('skips an agent in flight or warming', () => {
    const entry = registerHouse();
    entry.phase = 'arrived';
    entry.targetBuildingId = 'memory-rag';
    agentOrchestrator.getRunningAgentRuntime = warmRuntime;

    driver.inFlight.add(AGENT);
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    driver.inFlight.delete(AGENT);

    driver.warming.set(AGENT, Date.now());
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    driver.warming.delete(AGENT);

    expect(drive).not.toHaveBeenCalled();
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
  });

  it('polls user-registry agents too, not only the house fleet', () => {
    const house = registerHouse();
    house.phase = 'deciding';
    const user = registerUser();
    user.phase = 'arrived';
    user.targetBuildingId = 'memory-rag';
    agentOrchestrator.getRunningAgentRuntime = warmRuntime;

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([USER_AGENT]);
    expect(drive).toHaveBeenCalledWith(USER_AGENT);
  });
});

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

/** Let settled promise callbacks (catch/finally chains) run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A teaching-building walk that arrives on the next drive. */
function stampArrivingTeachingWalk(entry: DriverEntry, buildingId = 'memory-rag'): void {
  const edge = firstFreeBuildingEdge(buildingId);
  const npc = body();
  npc.x = edge.x;
  npc.y = edge.y;
  stampWalk(entry);
  entry.targetBuildingId = buildingId;
}

describe('phase-edge poll: woken drives run the real phase machine', () => {
  it('an arrived teaching walk ends in arrived through stepWalkingPhase, no wedge re-route', async () => {
    const entry = registerHouse();
    const buildingId = 'memory-rag';
    const edge = firstFreeBuildingEdge(buildingId);
    const center = NPC_BUILDING_CENTERS[buildingId];
    const npc = body();
    npc.x = edge.x;
    npc.y = edge.y;
    npc.path = [{ x: center.x, y: center.y }];
    npc.pathIndex = 0;
    npc.activity = 'walking';
    const now = Date.now();
    entry.phase = 'walking';
    entry.phaseSince = now;
    entry.targetBuildingId = buildingId;
    entry.walkDeadline = now + 999_999;
    entry.walkEpisodeDeadline = now + 300_000;
    entry.walkReplans = 0;
    // A stamped walk with no progress since the last drive: the wedge branch
    // WOULD fire if arrival did not short-circuit it.
    entry.lastRemainingWu = npcSimulation.getRemainingPathLengthWu(BODY);
    expect(entry.lastRemainingWu).not.toBeNull();
    let settles = 0;
    driver.arrivalSettle = async () => {
      settles++;
      return null;
    };
    const drives = captureRealDrives();
    resetFindPathCallCount();

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    expect(await Promise.all(drives)).toEqual([true]);

    expect(entry.phase as DriverEntry['phase']).toBe('arrived');
    expect(entry.targetBuildingId).toBe(buildingId);
    expect(entry.walkReplans).toBe(0);
    expect(entry.lastRemainingWu).toBeNull();
    expect(getFindPathCallCount()).toBe(0);
    expect(settles).toBe(1);
  });

  it('an arrived non-teaching walk ends in talking with no settle and no re-route', async () => {
    const entry = registerHouse();
    const cove = coveCenter();
    body().x = cove.x;
    body().y = cove.y;
    stampWalk(entry);
    entry.lastRemainingWu = 5_000;
    let settles = 0;
    driver.arrivalSettle = async () => {
      settles++;
      return null;
    };
    const drives = captureRealDrives();
    resetFindPathCallCount();

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    expect(await Promise.all(drives)).toEqual([true]);

    expect(entry.phase as DriverEntry['phase']).toBe('talking');
    expect(entry.walkReplans).toBe(0);
    expect(getFindPathCallCount()).toBe(0);
    expect(settles).toBe(0);
    // The linger has just started: the next poll does not wake it again.
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
  });

  it('an arrived edge runs exactly one talk decide, then the next poll skips', async () => {
    const entry = registerHouse();
    const buildingId = 'memory-rag';
    const edge = firstFreeBuildingEdge(buildingId);
    body().x = edge.x;
    body().y = edge.y;
    entry.phase = 'arrived';
    entry.phaseSince = Date.now();
    entry.targetBuildingId = buildingId;
    let decides = 0;
    const runtime = {
      decide: async () => {
        decides++;
        return '';
      },
    };
    agentOrchestrator.getRunningAgentRuntime = (() => runtime) as never;
    const drives = captureRealDrives();

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    expect(await Promise.all(drives)).toEqual([true]);

    expect(decides).toBe(1);
    expect(entry.phase as DriverEntry['phase']).toBe('talking');
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(decides).toBe(1);
  });
});

describe('phase-edge poll: decide spacing after a poll-woken talking edge', () => {
  // Real "now" (not a fixed date) so an armed standby window from beforeEach
  // cannot expire inside the frozen clock.
  let T0 = 0;
  beforeEach(() => {
    T0 = Date.now();
  });

  it('an empty poll decide is not retried by a tick 5 s later, only 30 s later', async () => {
    setSystemTime(new Date(T0));
    const entry = registerHouse();
    entry.phase = 'talking';
    entry.phaseSince = T0 - TALK_COOLDOWN_MS;
    entry.targetBuildingId = 'cove';
    let decides = 0;
    const runtime = {
      decide: async () => {
        decides++;
        return '';
      },
    };
    agentOrchestrator.getRunningAgentRuntime = (() => runtime) as never;
    const drives = captureRealDrives();

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    expect(entry.edgeDecideAt).toBe(T0);
    expect(await Promise.all(drives)).toEqual([true]);
    expect(decides).toBe(1);
    expect(entry.phase as DriverEntry['phase']).toBe('deciding');
    expect(entry.directivePending).toBe(false);

    setSystemTime(new Date(T0 + 5_000));
    driver.tick();
    expect(drives).toHaveLength(1);
    expect(decides).toBe(1);

    setSystemTime(new Date(T0 + 30_000));
    driver.tick();
    expect(drives).toHaveLength(2);
    await Promise.all(drives);
    expect(decides).toBe(2);
  });

  it('a pending directive is not blocked by the spacing', () => {
    setSystemTime(new Date(T0));
    const entry = registerHouse();
    entry.phase = 'talking';
    entry.phaseSince = T0 - TALK_COOLDOWN_MS;
    agentOrchestrator.getRunningAgentRuntime = warmRuntime;
    // Simulate the woken drive's empty decide: the entry is left 'deciding'.
    drive.mockImplementation(async () => {
      entry.phase = 'deciding';
      return true;
    });

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    expect(entry.phase as DriverEntry['phase']).toBe('deciding');
    expect(drive).toHaveBeenCalledTimes(1);

    setSystemTime(new Date(T0 + 5_000));
    driver.tick();
    expect(drive).toHaveBeenCalledTimes(1);

    entry.directivePending = true;
    driver.tick();
    expect(drive).toHaveBeenCalledTimes(2);
  });

  it('the spacing boundary is exact: 24_999 ms skips, 25_000 ms drives', () => {
    setSystemTime(new Date(T0));
    const entry = registerHouse();
    entry.phase = 'talking';
    entry.phaseSince = T0 - TALK_COOLDOWN_MS;
    agentOrchestrator.getRunningAgentRuntime = warmRuntime;
    drive.mockImplementation(async () => {
      entry.phase = 'deciding';
      return true;
    });

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    expect(entry.edgeDecideAt).toBe(T0);
    expect(drive).toHaveBeenCalledTimes(1);

    setSystemTime(new Date(T0 + 24_999));
    driver.tick();
    expect(drive).toHaveBeenCalledTimes(1);

    setSystemTime(new Date(T0 + 25_000));
    driver.tick();
    expect(drive).toHaveBeenCalledTimes(2);
  });

  it('a deciding entry that was never poll-woken is never skipped by tick', () => {
    setSystemTime(new Date(T0));
    const entry = registerHouse();
    entry.phase = 'deciding';
    expect(entry.edgeDecideAt).toBe(0);

    driver.tick();
    expect(drive).toHaveBeenCalledTimes(1);
  });
});

describe('phase-edge poll: arrival settle runs before the arrived edge', () => {
  it('waits for a pending arrival settle, then wakes the arrived edge', async () => {
    const entry = registerHouse();
    stampArrivingTeachingWalk(entry);
    let resolveSettle!: () => void;
    driver.arrivalSettle = () => new Promise<null>((resolve) => {
      resolveSettle = () => resolve(null);
    });
    agentOrchestrator.getRunningAgentRuntime = warmRuntime;
    const drives = captureRealDrives();

    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    expect(await Promise.all(drives)).toEqual([true]);
    expect(entry.phase as DriverEntry['phase']).toBe('arrived');
    expect(driver.arrivalSettling.has(AGENT)).toBe(true);

    agentAutonomyDriver.driveAgentNow = drive as unknown as typeof agentAutonomyDriver.driveAgentNow;
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
    expect(drive).not.toHaveBeenCalled();

    resolveSettle();
    await flushMicrotasks();
    expect(driver.arrivalSettling.has(AGENT)).toBe(false);
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    expect(drive).toHaveBeenCalledTimes(1);
  });

  it('a tick drive during a pending settle does not talk; after resolve the next drive talks', async () => {
    const entry = registerHouse();
    stampArrivingTeachingWalk(entry);
    let resolveSettle!: () => void;
    driver.arrivalSettle = () => new Promise<null>((resolve) => {
      resolveSettle = () => resolve(null);
    });
    let decides = 0;
    const runtime = {
      decide: async () => {
        decides++;
        return '';
      },
    };
    agentOrchestrator.getRunningAgentRuntime = (() => runtime) as never;
    const drives = captureRealDrives();

    // The poll detects arrival and starts the settle.
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    await Promise.all(drives);
    expect(entry.phase as DriverEntry['phase']).toBe('arrived');
    expect(driver.arrivalSettling.has(AGENT)).toBe(true);

    // A tick lands while the settle is still pending: no teacher talk.
    driver.tick();
    expect(drives).toHaveLength(2);
    expect(await Promise.all(drives)).toEqual([true, true]);
    expect(decides).toBe(0);
    expect(entry.phase as DriverEntry['phase']).toBe('arrived');

    resolveSettle();
    await flushMicrotasks();
    expect(driver.arrivalSettling.has(AGENT)).toBe(false);

    // The next drive runs the talk exactly once.
    driver.tick();
    expect(drives).toHaveLength(3);
    await Promise.all(drives);
    expect(decides).toBe(1);
    expect(entry.phase as DriverEntry['phase']).toBe('talking');
  });

  it('a settle pending for >= 15 s no longer blocks the talk and warns once', async () => {
    const T0 = Date.now();
    setSystemTime(new Date(T0));
    const entry = registerHouse();
    stampArrivingTeachingWalk(entry);
    driver.arrivalSettle = () => new Promise<null>(() => {}); // hung settle
    let decides = 0;
    const runtime = {
      decide: async () => {
        decides++;
        return '';
      },
    };
    agentOrchestrator.getRunningAgentRuntime = (() => runtime) as never;
    const drives = captureRealDrives();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
      await Promise.all(drives);
      expect(entry.phase as DriverEntry['phase']).toBe('arrived');

      // Just under the bound: still blocked, poll does not wake, no warn.
      setSystemTime(new Date(T0 + 14_999));
      expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([]);
      driver.tick();
      await Promise.all(drives);
      expect(decides).toBe(0);
      expect(entry.phase as DriverEntry['phase']).toBe('arrived');

      // At the bound: the poll wakes it and the talk runs.
      setSystemTime(new Date(T0 + 15_000));
      expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
      await Promise.all(drives);
      expect(decides).toBe(1);
      expect(entry.phase as DriverEntry['phase']).toBe('talking');

      // A second arrived drive on the same hung settle talks again, no new warn.
      entry.phase = 'arrived';
      driver.tick();
      await Promise.all(drives);
      expect(decides).toBe(2);
    } finally {
      console.warn = originalWarn;
    }
    const expiryWarnings = warnings.filter((w) => w.includes('arrival settle still running after 15000ms'));
    expect(expiryWarnings).toHaveLength(1);
    expect(expiryWarnings[0]).toContain('talking anyway');
    // A hung settle never reaches its finally: the expired read drops the token.
    expect(driver.arrivalSettling.has(AGENT)).toBe(false);
  });

  it('unregister drops a hung settle guard so the map cannot grow', async () => {
    const entry = registerHouse();
    stampArrivingTeachingWalk(entry);
    driver.arrivalSettle = () => new Promise<null>(() => {}); // hung settle
    const drives = captureRealDrives();
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    await Promise.all(drives);
    expect(driver.arrivalSettling.has(AGENT)).toBe(true);
    agentAutonomyDriver.unregisterHouseAgent(AGENT);
    expect(driver.arrivalSettling.has(AGENT)).toBe(false);
  });

  it('a rejected arrival settle also clears the guard', async () => {
    const entry = registerHouse();
    stampArrivingTeachingWalk(entry);
    let rejectSettle!: (err: Error) => void;
    driver.arrivalSettle = () => new Promise<null>((_resolve, reject) => {
      rejectSettle = reject;
    });
    agentOrchestrator.getRunningAgentRuntime = warmRuntime;
    const drives = captureRealDrives();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
      await Promise.all(drives);
      expect(driver.arrivalSettling.has(AGENT)).toBe(true);

      rejectSettle(new Error('settle failed'));
      await flushMicrotasks();
    } finally {
      console.warn = originalWarn;
    }
    expect(driver.arrivalSettling.has(AGENT)).toBe(false);
    agentAutonomyDriver.driveAgentNow = drive as unknown as typeof agentAutonomyDriver.driveAgentNow;
    expect(entry.phase as DriverEntry['phase']).toBe('arrived');
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
  });

  it('an older settle that finishes late does not clear a newer settle guard', async () => {
    const entry = registerHouse();
    const resolvers: Array<() => void> = [];
    driver.arrivalSettle = () => new Promise<null>((resolve) => {
      resolvers.push(() => resolve(null));
    });
    const drives = captureRealDrives();

    stampArrivingTeachingWalk(entry, 'memory-rag');
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    await Promise.all(drives);
    stampArrivingTeachingWalk(entry, 'api-integrations');
    expect(agentAutonomyDriver.phaseEdgePoll()).toEqual([AGENT]);
    await Promise.all(drives);
    expect(resolvers).toHaveLength(2);

    resolvers[0]!();
    await flushMicrotasks();
    expect(driver.arrivalSettling.has(AGENT)).toBe(true);
    resolvers[1]!();
    await flushMicrotasks();
    expect(driver.arrivalSettling.has(AGENT)).toBe(false);
  });
});

describe('phase-edge poll: lifecycle', () => {
  it('start() creates both intervals and stop() clears both', () => {
    agentAutonomyDriver.stop();
    expect(driver.interval).toBeNull();
    expect(driver.phaseEdgeInterval).toBeNull();

    agentAutonomyDriver.start();
    try {
      expect(driver.interval).not.toBeNull();
      expect(driver.phaseEdgeInterval).not.toBeNull();
      // A second start() is a no-op: it must not leak another 5 s timer.
      const edgeTimer = driver.phaseEdgeInterval;
      agentAutonomyDriver.start();
      expect(driver.phaseEdgeInterval).toBe(edgeTimer);
    } finally {
      agentAutonomyDriver.stop();
    }
    expect(driver.interval).toBeNull();
    expect(driver.phaseEdgeInterval).toBeNull();
  });
});
