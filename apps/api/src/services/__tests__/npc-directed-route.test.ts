import { beforeEach, describe, expect, it } from 'bun:test';
import { NPC_BUILDING_CENTERS } from '@clawville/shared';
import {
  getFindPathCallCount,
  isCollisionFreeWorld,
  resetFindPathCallCount,
  type PathNode,
} from '../pathfinding';
import {
  NPC_WORLD_WALK_SPEED_WU_PER_S,
  npcSimulation,
  type NpcRuntimeState,
} from '../npc-simulation';

type Sim = {
  npcs: Map<string, NpcRuntimeState>;
  initNpcs: () => void;
  moveNpcs: () => void;
  handleActivityDurations: () => void;
  planNpcBehaviors: () => void;
  getIdleAliveNpcs: () => NpcRuntimeState[];
  findNearestIdleNpc: (npc: NpcRuntimeState, maxDist: number) => NpcRuntimeState | null;
  planCenterWander: (npc: NpcRuntimeState) => void;
};

const sim = npcSimulation as unknown as Sim;

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

function moveWithoutPathfinding(): void {
  resetFindPathCallCount();
  sim.moveNpcs();
  expect(getFindPathCallCount()).toBe(0);
}

function findStraightFixture(skipY = -1): { x: number; y: number } {
  for (let y = 512; y < 22_000; y += 256) {
    if (y === skipY) continue;
    for (let x = 512; x < 21_000; x += 256) {
      let clear = true;
      for (let dx = 0; dx <= 1_000; dx += 44) {
        if (!isCollisionFreeWorld(x + dx, y, 30)) {
          clear = false;
          break;
        }
      }
      if (clear && isCollisionFreeWorld(x + 1_000, y, 30)) return { x, y };
    }
  }
  throw new Error('No long collision-free straight fixture found');
}

function grazeFixture(): {
  start: PathNode;
  blocked: PathNode;
  far: PathNode;
} {
  const center = NPC_BUILDING_CENTERS['code-development'];
  let firstFree: PathNode | null = null;
  for (let px = center.x; px < 22_496; px += 8) {
    if (isCollisionFreeWorld(px, center.y, 30)) {
      firstFree = { x: px, y: center.y };
      break;
    }
  }
  expect(firstFree).not.toBeNull();
  if (!firstFree) throw new Error('No code-development graze point found');

  const blocked = { x: firstFree.x - 16, y: center.y };
  const start = { x: firstFree.x + 28, y: center.y };
  expect(isCollisionFreeWorld(blocked.x, blocked.y, 30)).toBe(false);
  expect(isCollisionFreeWorld(start.x, start.y, 30)).toBe(true);
  expect(Math.hypot(blocked.x - start.x, blocked.y - start.y)).toBe(44);
  return { start, blocked, far: { x: 11264, y: 11264 } };
}

function prepareWalker(
  body: NpcRuntimeState,
  start: PathNode,
  path: PathNode[],
): void {
  body.x = start.x;
  body.y = start.y;
  body.path = path;
  body.pathIndex = 0;
  body.activity = 'walking';
  body.activityEmoji = '';
  body.direction = 'right';
  body.destinationBuildingId = null;
  body.behaviorCooldown = 0;
  body.stuckTicks = 0;
  body.inCombat = false;
  body.inConversation = false;
  body.isDead = false;
}

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
});

describe('directed NPC routes', () => {
  it('T1: moveNpcs adds zero A* calls for a multi-body tick', () => {
    const [directed, ambient] = isolate('chibi-eliza', 'chibi-milady');
    const first = findStraightFixture();
    const second = findStraightFixture(first.y);
    const directedPath = [{ x: first.x + 1_000, y: first.y }];
    prepareWalker(directed, first, directedPath);
    npcSimulation.setNpcPath(directed.id, directedPath, 'cove');
    prepareWalker(ambient, second, [{ x: second.x + 1_000, y: second.y }]);

    moveWithoutPathfinding();

    expect(directed.path).toBe(directedPath);
    expect(ambient.path.length).toBeGreaterThan(0);
  });

  it('T2: exports the exact 44 wu x 5 Hz speed mirror', () => {
    expect(NPC_WORLD_WALK_SPEED_WU_PER_S).toBe(44 * 5);
  });

  it('T3: moves exactly 44 wu on a long straight free segment', () => {
    const [body] = isolate('chibi-eliza');
    const start = findStraightFixture();
    prepareWalker(body, start, [{ x: start.x + 1_000, y: start.y }]);

    moveWithoutPathfinding();

    expect(Math.hypot(body.x - start.x, body.y - start.y)).toBeCloseTo(44, 3);
  });

  it('T4: a directed graze wall-slides without abandoning', () => {
    const [body] = isolate('chibi-eliza');
    const { start, blocked, far } = grazeFixture();
    const path = [blocked, far];
    prepareWalker(body, start, path);
    npcSimulation.setNpcPath(body.id, path, 'cove');

    moveWithoutPathfinding();

    expect(body.path).toBe(path);
    expect(body.pathIndex).toBe(0);
    expect(body.activity as NpcRuntimeState['activity']).toBe('walking');
    expect(body.destinationBuildingId).toBe('cove');
    expect(body.behaviorCooldown).toBe(200);
    expect(isCollisionFreeWorld(body.x, body.y, 30)).toBe(true);
  });

  it('T5: an ambient graze keeps the original abandon behavior', () => {
    const [body] = isolate('chibi-eliza');
    const { start, blocked, far } = grazeFixture();
    prepareWalker(body, start, [blocked, far]);
    body.destinationBuildingId = 'code-development';

    moveWithoutPathfinding();

    expect(body.path).toHaveLength(0);
    expect(body.activity).toBe('idle');
    expect(body.destinationBuildingId).toBeNull();
    expect(body.direction).toBe('idle');
    expect(body.behaviorCooldown).toBeGreaterThanOrEqual(5);
    expect(body.behaviorCooldown).toBeLessThanOrEqual(14);
    expect(body.stuckTicks).toBe(0);
  });

  it('T6: a directed wall-slide makes progress without losing route ownership', () => {
    const [body] = isolate('chibi-eliza');
    const { start, blocked, far } = grazeFixture();
    const path = [blocked, far];
    prepareWalker(body, start, path);
    npcSimulation.setNpcPath(body.id, path, 'cove');
    const displacements: number[] = [];
    let previous = { x: body.x, y: body.y };

    for (let i = 0; i < 50; i++) {
      moveWithoutPathfinding();
      displacements.push(Math.hypot(body.x - previous.x, body.y - previous.y));
      previous = { x: body.x, y: body.y };
      expect(body.path).toBe(path);
      expect(body.activity).toBe('walking');
      expect(body.destinationBuildingId).toBe('cove');
      expect(isCollisionFreeWorld(body.x, body.y, 30)).toBe(true);
    }

    expect(displacements).toHaveLength(50);
    expect(displacements.every((distance) => Number.isFinite(distance) && distance >= 0)).toBe(true);
    expect(displacements.map((distance) => Number(distance.toFixed(6)))).toEqual([
      35, 27.970269, 16.288749, 11.696467, 8.234528, 5.941308, 4.242875,
      3.060318, 2.19509, 1.581909, 1.136614, 0.818579, 0.588603, 0.423741,
      0.304802, 0.219382, 0.157833, 0.113587, 0.081727, 0.058812, 0.042318,
      0.030452, 0.021912, 0.015767, 0.011346, 0.008164, 0.005875, 0.004227,
      0.003042, 0.002189, 0.001575, 0.001133, 0.000816, 0.000587, 0.000422,
      0.000304, 0.000219, 0.000157, 0.000113, 0.000081, 0.000059, 0.000042,
      0.00003, 0.000022, 0.000016, 0.000011, 0.000008, 0.000006, 0.000004,
      0.000003,
    ]);
    expect(Math.hypot(body.x - start.x, body.y - start.y)).toBeGreaterThan(0);
  });

  it('T7: stuckTicks >= 4 does not abandon a directed route', () => {
    const [body] = isolate('chibi-eliza');
    const { start, blocked, far } = grazeFixture();
    const path = [blocked, far];
    prepareWalker(body, start, path);
    npcSimulation.setNpcPath(body.id, path, 'cove');
    body.stuckTicks = 10;

    moveWithoutPathfinding();

    expect(body.path).toBe(path);
    expect(body.activity as NpcRuntimeState['activity']).toBe('walking');
  });

  it('T8: stuckTicks >= 4 still abandons an ambient route', () => {
    const [body] = isolate('chibi-eliza');
    const { start, blocked, far } = grazeFixture();
    prepareWalker(body, start, [blocked, far]);
    body.stuckTicks = 10;

    moveWithoutPathfinding();

    expect(body.path).toHaveLength(0);
    expect(body.activity).toBe('idle');
  });

  it('T9: a server-managed directed route survives expiry and ambient planning', () => {
    const [body] = isolate('chibi-eliza');
    const start = findStraightFixture();
    const path = [{ x: start.x + 1_000, y: start.y }];
    prepareWalker(body, start, path);
    body.isOpenClaw = true;
    body.autonomyMode = 'server-managed';
    npcSimulation.setNpcPath(body.id, path, 'cove');
    npcSimulation.setNpcActivity(body.id, 'trading', '🎰');
    body.activityEndsAt = Date.now() - 1;

    sim.handleActivityDurations();
    expect(body.activity).toBe('idle');
    expect(body.destinationBuildingId).toBeNull();
    expect(body.path).toBe(path);

    body.behaviorCooldown = 0;
    sim.planNpcBehaviors();
    expect(body.path).toBe(path);
    expect(body.activity).toBe('idle');
    expect(body.behaviorCooldown).toBe(0);
  });

  it('T10: directed bodies are excluded from ambient conversation selection', () => {
    const [body, other] = isolate('chibi-eliza', 'chibi-milady');
    const start = findStraightFixture();
    const path = [{ x: start.x + 1_000, y: start.y }];
    prepareWalker(body, start, path);
    body.isOpenClaw = true;
    body.autonomyMode = 'server-managed';
    npcSimulation.setNpcPath(body.id, path, 'cove');
    body.activity = 'idle';
    body.destinationBuildingId = null;
    other.x = body.x + 100;
    other.y = body.y;
    other.conversationCooldownUntil = 0;
    other.invulnerableUntil = 0;

    expect(sim.getIdleAliveNpcs()).not.toContain(body);
    expect(sim.findNearestIdleNpc(other, 999_999)).not.toBe(body);
  });

  it('T11: ordinary ambient bodies remain selectable and replannable', () => {
    const [body, other] = isolate('chibi-eliza', 'chibi-milady');
    body.x = 11264;
    body.y = 11264;
    body.activity = 'idle';
    body.isOpenClaw = false;
    body.autonomyMode = 'server-managed';
    body.path = [];
    body.behaviorCooldown = 0;
    body.conversationCooldownUntil = 0;
    body.invulnerableUntil = 0;
    other.x = body.x + 100;
    other.y = body.y;
    other.activity = 'idle';
    other.behaviorCooldown = 999;
    other.conversationCooldownUntil = 0;
    other.invulnerableUntil = 0;
    const planned = [{ x: body.x + 500, y: body.y }];
    const originalPlanCenterWander = sim.planCenterWander;
    sim.planCenterWander = (candidate) => {
      if (candidate === body) {
        candidate.path = planned;
        candidate.pathIndex = 0;
        candidate.activity = 'walking';
      }
    };

    try {
      expect(sim.getIdleAliveNpcs()).toContain(body);
      expect(sim.findNearestIdleNpc(other, 999_999)).toBe(body);
      sim.planNpcBehaviors();
    } finally {
      sim.planCenterWander = originalPlanCenterWander;
    }

    expect(body.path).toBe(planned);
    expect(body.activity as NpcRuntimeState['activity']).toBe('walking');
  });

  it('T12: reports exact remaining polyline length', () => {
    const [body] = isolate('chibi-eliza');
    expect(npcSimulation.getRemainingPathLengthWu('unknown-body')).toBeNull();
    body.path = [];
    body.pathIndex = 0;
    expect(npcSimulation.getRemainingPathLengthWu(body.id)).toBe(0);

    body.x = 0;
    body.y = 0;
    body.path = [{ x: 3, y: 4 }, { x: 6, y: 8 }, { x: 6, y: 10 }];
    body.pathIndex = 0;
    expect(npcSimulation.getRemainingPathLengthWu(body.id)).toBeCloseTo(12, 6);
  });

  it('T13: re-routes teaching, cove, and portal destinations exactly once each', () => {
    const [body] = isolate('chibi-eliza');
    for (const destination of ['code-development', 'cove', 'kelp-forest-portal']) {
      resetFindPathCallCount();
      expect(npcSimulation.repathToDestination(body.id, destination)).toBe(true);
      expect(getFindPathCallCount()).toBe(1);
      expect(body.path.length).toBeGreaterThan(0);
      expect(body.destinationBuildingId).toBe(destination);
    }
  });

  it('T14: invalid destinations and unknown bodies fail before A*', () => {
    const [body] = isolate('chibi-eliza');
    const originalPath = [{ x: body.x + 10, y: body.y }];
    body.path = originalPath;
    body.pathIndex = 0;
    body.destinationBuildingId = 'original';
    const before = {
      path: body.path,
      pathIndex: body.pathIndex,
      destinationBuildingId: body.destinationBuildingId,
      activity: body.activity,
    };

    resetFindPathCallCount();
    for (const destination of ['nope', '__proto__', 'constructor']) {
      expect(npcSimulation.repathToDestination(body.id, destination)).toBe(false);
    }
    expect(npcSimulation.repathToDestination('unknown-body', 'cove')).toBe(false);
    expect(getFindPathCallCount()).toBe(0);
    expect({
      path: body.path,
      pathIndex: body.pathIndex,
      destinationBuildingId: body.destinationBuildingId,
      activity: body.activity,
    }).toEqual(before);
  });

  it('T15: clearing a destination de-directs the existing path array', () => {
    const [body] = isolate('chibi-eliza');
    const { start, blocked, far } = grazeFixture();
    const path = [blocked, far];
    prepareWalker(body, start, path);
    npcSimulation.setNpcPath(body.id, path, 'cove');
    npcSimulation.clearDestinationBuilding(body.id);

    moveWithoutPathfinding();

    expect(body.path).toHaveLength(0);
    expect(body.activity).toBe('idle');
    expect(body.destinationBuildingId).toBeNull();
  });
});
