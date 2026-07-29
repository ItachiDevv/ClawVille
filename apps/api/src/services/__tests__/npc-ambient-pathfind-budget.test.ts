import { beforeEach, describe, expect, it } from 'bun:test';
import {
  __setFindPathOverride,
  findPath,
  getFindPathCallCount,
  isCollisionFreeWorld,
  isPathCollisionFree,
  resetFindPathCallCount,
  type PathNode,
} from '../pathfinding';
import {
  AMBIENT_PATHFIND_BUDGET_PER_TICK,
  npcSimulation,
  type NpcRuntimeState,
} from '../npc-simulation';

type AmbientPathAttempt =
  | { status: 'ok'; path: PathNode[] }
  | { status: 'no-path' }
  | { status: 'budget-exhausted' };

type Sim = {
  npcs: Map<string, NpcRuntimeState>;
  planCursor: number;
  ambientPathfindsThisTick: number;
  npcOverrides: Map<string, string>;
  agentBotSessions: Map<string, unknown>;
  initNpcs: () => void;
  moveNpcs: () => void;
  planNpcBehaviors: () => void;
  findSafePath: (
    npc: NpcRuntimeState,
    tx: number,
    ty: number,
    entityHalf?: number,
  ) => AmbientPathAttempt;
  snapPlannerTarget: (
    tx: number,
    ty: number,
    entityHalf?: number,
  ) => { x: number; y: number } | null;
  planWander: (npc: NpcRuntimeState) => void;
  planApproachNpc: (npc: NpcRuntimeState) => void;
  planApproachNearbyNpc: (npc: NpcRuntimeState) => void;
  planCenterWander: (npc: NpcRuntimeState) => void;
};

const sim = npcSimulation as unknown as Sim;
const RETRY_COOLDOWN = 1;
let cachedStraightFixture: { start: PathNode; target: PathNode } | null = null;

function npc(id: string): NpcRuntimeState {
  const found = sim.npcs.get(id);
  if (!found) throw new Error(`Missing NPC fixture ${id}`);
  return found;
}

function isolate(...ids: string[]): NpcRuntimeState[] {
  const selected = ids.map(npc);
  sim.npcs.clear();
  for (const body of selected) sim.npcs.set(body.id, body);
  return selected;
}

function arm(body: NpcRuntimeState, x: number, y: number): void {
  body.x = x;
  body.y = y;
  body.targetX = x;
  body.targetY = y;
  body.path = [];
  body.pathIndex = 0;
  body.activity = 'idle';
  body.activityEmoji = '';
  body.destinationBuildingId = null;
  body.behaviorCooldown = 0;
  body.stuckTicks = 0;
  body.overlapTicks = 0;
  body.headingAngle = 0;
  body.inConversation = false;
  body.inCombat = false;
  body.isDead = false;
  body.isOpenClaw = false;
  body.autonomyMode = 'native';
}

function findStraightFixture(): { start: PathNode; target: PathNode } {
  if (cachedStraightFixture) return cachedStraightFixture;
  for (let y = 512; y < 22_000; y += 256) {
    for (let x = 512; x < 21_000; x += 256) {
      const target = { x: x + 512, y };
      if (!isCollisionFreeWorld(x, y, 30) || !isCollisionFreeWorld(target.x, target.y, 30)) continue;
      const path = findPath(x, y, target.x, target.y);
      if (path.length > 0 && isPathCollisionFree(x, y, path, 30)) {
        cachedStraightFixture = { start: { x, y }, target };
        return cachedStraightFixture;
      }
    }
  }
  throw new Error('No collision-free path fixture found');
}

function resetAmbientBudget(): void {
  sim.ambientPathfindsThisTick = 0;
}

function sixEligibleBodies(start: PathNode): NpcRuntimeState[] {
  const bodies = isolate(
    'milady-miu',
    'milady-kyoko',
    'milady-vivi',
    'hermes-mira',
    'hermes-cyrus',
    'hermes-tekk',
  );
  bodies.forEach((body) => arm(body, start.x, start.y));
  return bodies;
}

function withRandomSequence<T>(values: number[], run: () => T): T {
  const originalRandom = Math.random;
  let index = 0;
  Math.random = () => values[Math.min(index++, values.length - 1)] ?? 0.5;
  try {
    return run();
  } finally {
    Math.random = originalRandom;
  }
}

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  sim.planCursor = 0;
  sim.ambientPathfindsThisTick = 0;
  sim.npcOverrides.clear();
  sim.agentBotSessions.clear();
});

describe('ambient pathfinding budget', () => {
  it('P1: the chokepoint distinguishes ok, budget-exhausted, and no-path', () => {
    const fixture = findStraightFixture();
    const [body] = isolate('chibi-eliza');
    arm(body!, fixture.start.x, fixture.start.y);
    resetAmbientBudget();
    resetFindPathCallCount();

    const first = sim.findSafePath(body!, fixture.target.x, fixture.target.y);
    const denied = Array.from({ length: 4 }, () =>
      sim.findSafePath(body!, fixture.target.x, fixture.target.y));

    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('Expected pathable fixture');
    expect(first.path.length).toBeGreaterThan(0);
    expect(getFindPathCallCount()).toBe(1);
    expect(denied.map((result) => result.status)).toEqual([
      'budget-exhausted',
      'budget-exhausted',
      'budget-exhausted',
      'budget-exhausted',
    ]);
    expect(getFindPathCallCount()).toBe(1);

    resetAmbientBudget();
    __setFindPathOverride(() => []);
    try {
      const miss = sim.findSafePath(body!, fixture.target.x, fixture.target.y);
      expect(miss.status).toBe('no-path');
    } finally {
      __setFindPathOverride(null);
    }
  });

  it('P2: a deferral does not change the route returned after the budget resets', () => {
    const fixture = findStraightFixture();
    const [body] = isolate('chibi-eliza');
    arm(body!, fixture.start.x, fixture.start.y);
    resetAmbientBudget();

    const first = sim.findSafePath(body!, fixture.target.x, fixture.target.y);
    const deferred = sim.findSafePath(body!, fixture.target.x, fixture.target.y);
    resetAmbientBudget();
    const second = sim.findSafePath(body!, fixture.target.x, fixture.target.y);

    expect(first.status).toBe('ok');
    expect(deferred.status).toBe('budget-exhausted');
    expect(second.status).toBe('ok');
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('Expected pathable fixture');
    expect(second.path).toEqual(first.path);
  });

  it('P3: one pass spends one search and denied bodies retry next pass', () => {
    const fixture = findStraightFixture();
    const bodies = sixEligibleBodies(fixture.start);
    const originalSnap = sim.snapPlannerTarget;
    sim.snapPlannerTarget = () => fixture.target;
    resetFindPathCallCount();

    try {
      sim.planNpcBehaviors();
    } finally {
      sim.snapPlannerTarget = originalSnap;
    }

    expect(getFindPathCallCount()).toBe(AMBIENT_PATHFIND_BUDGET_PER_TICK);
    const planned = bodies.filter((body) => body.path.length > 0);
    expect(planned.length).toBeLessThanOrEqual(AMBIENT_PATHFIND_BUDGET_PER_TICK);
    const denied = bodies.filter((body) => body.path.length === 0);
    expect(denied.every((body) => body.behaviorCooldown === RETRY_COOLDOWN)).toBe(true);
    expect(denied.every((body) => body.activity === 'idle')).toBe(true);
  });

  it('P4: a spent pass performs no second snap', () => {
    const fixture = findStraightFixture();
    sixEligibleBodies(fixture.start);
    const originalSnap = sim.snapPlannerTarget;
    let snapCalls = 0;
    sim.snapPlannerTarget = () => {
      snapCalls++;
      return fixture.target;
    };

    try {
      sim.planNpcBehaviors();
    } finally {
      sim.snapPlannerTarget = originalSnap;
    }

    expect(snapCalls).toBe(1);
  });

  it('P5: every fully eligible pass searches exactly the expected round-robin body', () => {
    const fixture = findStraightFixture();
    const bodies = sixEligibleBodies(fixture.start);
    const initialCursor = sim.planCursor;
    const originalSnap = sim.snapPlannerTarget;
    const originalFindSafePath = sim.findSafePath;
    const passes: Array<{ findPathCalls: number; attemptedNpcIds: string[] }> = [];
    let attemptedNpcIds: string[] = [];

    sim.snapPlannerTarget = () => fixture.target;
    sim.findSafePath = (body, tx, ty, half) => {
      const result = originalFindSafePath.call(sim, body, tx, ty, half);
      if (result.status !== 'budget-exhausted') attemptedNpcIds.push(body.id);
      return body.id === bodies[0]!.id && result.status === 'ok'
        ? { status: 'no-path' }
        : result;
    };

    try {
      for (let pass = 0; pass < bodies.length * 2; pass++) {
        bodies.forEach((body) => arm(body, fixture.start.x, fixture.start.y));
        attemptedNpcIds = [];
        resetFindPathCallCount();
        sim.planNpcBehaviors();
        passes.push({
          findPathCalls: getFindPathCallCount(),
          attemptedNpcIds: [...attemptedNpcIds],
        });
      }
    } finally {
      sim.snapPlannerTarget = originalSnap;
      sim.findSafePath = originalFindSafePath;
    }

    passes.forEach((record, pass) => {
      expect(record).toEqual({
        findPathCalls: 1,
        attemptedNpcIds: [bodies[(initialCursor + pass) % bodies.length]!.id],
      });
    });
  });

  it('P6: executor and driver reroutes remain outside the ambient budget', () => {
    const fixture = findStraightFixture();
    const [body] = isolate('chibi-eliza');
    arm(body!, fixture.start.x, fixture.start.y);
    resetAmbientBudget();
    expect(sim.findSafePath(body!, fixture.target.x, fixture.target.y).status).toBe('ok');
    expect(sim.findSafePath(body!, fixture.target.x, fixture.target.y).status).toBe('budget-exhausted');

    resetFindPathCallCount();
    expect(npcSimulation.repathToDestination(body!.id, 'cove')).toBe(true);
    expect(npcSimulation.repathToDestination(body!.id, 'code-development')).toBe(true);
    expect(getFindPathCallCount()).toBe(2);
    expect(body!.path.length).toBeGreaterThan(0);
    expect(body!.destinationBuildingId).toBe('code-development');
  });

  it('P7: a random planner reaches a second candidate next pass without a false cooldown', () => {
    const fixture = findStraightFixture();
    const [body] = isolate('chibi-eliza');
    arm(body!, fixture.start.x, fixture.start.y);
    const originalSnap = sim.snapPlannerTarget;
    sim.snapPlannerTarget = () => fixture.target;

    try {
      resetAmbientBudget();
      resetFindPathCallCount();
      __setFindPathOverride(() => []);
      try {
        sim.planWander(body!);
      } finally {
        __setFindPathOverride(null);
      }
      expect(getFindPathCallCount()).toBe(1);
      expect(body!.path).toHaveLength(0);
      expect(body!.behaviorCooldown).toBe(RETRY_COOLDOWN);

      resetAmbientBudget();
      sim.planWander(body!);
      expect(getFindPathCallCount()).toBe(2);
      expect(body!.path.length).toBeGreaterThan(0);
      expect(body!.activity).toBe('walking');
    } finally {
      __setFindPathOverride(null);
      sim.snapPlannerTarget = originalSnap;
    }
  });

  it('P8: planApproachNpc searches random points on the stand-off circle', () => {
    const fixture = findStraightFixture();
    const [approacher, target] = isolate('hermes-cyrus', 'hermes-mira');
    arm(approacher!, fixture.start.x, fixture.start.y);
    arm(target!, fixture.start.x + 500, fixture.start.y);
    const originalSnap = sim.snapPlannerTarget;
    const originalFindSafePath = sim.findSafePath;
    const points: PathNode[] = [];
    sim.snapPlannerTarget = (x, y) => ({ x, y });
    sim.findSafePath = (body, tx, ty, half) => {
      points.push({ x: tx, y: ty });
      const result = originalFindSafePath.call(sim, body, tx, ty, half);
      return result.status === 'budget-exhausted' ? result : { status: 'no-path' };
    };

    try {
      for (let pass = 0; pass < 10; pass++) {
        arm(approacher!, fixture.start.x, fixture.start.y);
        resetAmbientBudget();
        withRandomSequence([0, pass / 10], () => sim.planApproachNpc(approacher!));
      }
    } finally {
      sim.snapPlannerTarget = originalSnap;
      sim.findSafePath = originalFindSafePath;
    }

    const distinct = new Set(points.map((point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
    expect(points.every((point) =>
      Math.abs(Math.hypot(point.x - target!.x, point.y - target!.y) - 80) < 1e-3,
    )).toBe(true);
  });

  it('P9a: forcing the wander family performs exactly one real fallback search', () => {
    const fixture = findStraightFixture();
    const [body, target] = isolate('hermes-cyrus', 'hermes-mira');
    arm(body!, fixture.start.x, fixture.start.y);
    arm(target!, 11264 + 2000, 11264);
    const originalSnap = sim.snapPlannerTarget;
    sim.snapPlannerTarget = () => fixture.target;

    try {
      resetAmbientBudget();
      resetFindPathCallCount();
      withRandomSequence([0, 0.99, 0, 0.99, 0.5], () => sim.planApproachNearbyNpc(body!));
    } finally {
      sim.snapPlannerTarget = originalSnap;
    }

    expect(getFindPathCallCount()).toBe(1);
    expect(body!.path.length).toBeGreaterThan(0);
    expect(body!.intentDescription).toBe('Strolling the town ring');
  });

  it('P9b: forcing the approach family still approaches the nearby target with one search', () => {
    const fixture = findStraightFixture();
    const [body, target] = isolate('hermes-cyrus', 'hermes-mira');
    arm(body!, fixture.start.x, fixture.start.y);
    arm(target!, 11264 + 2000, 11264);
    const originalSnap = sim.snapPlannerTarget;
    sim.snapPlannerTarget = () => fixture.target;

    try {
      resetAmbientBudget();
      resetFindPathCallCount();
      withRandomSequence([0, 0, 0], () => sim.planApproachNearbyNpc(body!));
    } finally {
      sim.snapPlannerTarget = originalSnap;
    }

    expect(getFindPathCallCount()).toBe(1);
    expect(body!.path.length).toBeGreaterThan(0);
    expect(body!.intentDescription).toBe(`Approaching ${target!.name}`);
  });

  it('P9c: a real approach miss consumes one search and retries without a futile nested fallback', () => {
    const fixture = findStraightFixture();
    const [body, target] = isolate('hermes-cyrus', 'hermes-mira');
    arm(body!, fixture.start.x, fixture.start.y);
    arm(target!, 11264 + 2000, 11264);
    const originalSnap = sim.snapPlannerTarget;
    sim.snapPlannerTarget = () => fixture.target;

    try {
      resetAmbientBudget();
      resetFindPathCallCount();
      __setFindPathOverride(() => []);
      try {
        withRandomSequence([0, 0, 0], () => sim.planApproachNearbyNpc(body!));
      } finally {
        __setFindPathOverride(null);
      }
    } finally {
      __setFindPathOverride(null);
      sim.snapPlannerTarget = originalSnap;
    }

    expect(getFindPathCallCount()).toBe(1);
    expect(body!.path).toHaveLength(0);
    expect(body!.behaviorCooldown).toBe(RETRY_COOLDOWN);
  });

  it('P10: moveNpcs still performs zero A*', () => {
    resetFindPathCallCount();
    sim.moveNpcs();
    expect(getFindPathCallCount()).toBe(0);
  });

  it('P11: the exported budget remains one search per pass', () => {
    expect(AMBIENT_PATHFIND_BUDGET_PER_TICK).toBe(1);
  });
});
