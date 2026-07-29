import { beforeEach, describe, expect, it } from 'bun:test';
import {
  isCollisionFreeWorld,
  type PathNode,
} from '../pathfinding';
import {
  npcSimulation,
  type NpcRuntimeState,
} from '../npc-simulation';

type Sim = {
  npcs: Map<string, NpcRuntimeState>;
  directedRoutes: WeakSet<PathNode[]>;
  tickCount: number;
  initNpcs: () => void;
  moveNpcs: () => void;
  handleActivityDurations: () => void;
  resolveNpcNpcOverlaps: () => void;
};

const sim = npcSimulation as unknown as Sim;
const DIRECTED_OVERLAP_ABANDON = 10;

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

function prepare(
  body: NpcRuntimeState,
  x: number,
  y: number,
  path: PathNode[],
  directed: boolean,
): void {
  body.x = x;
  body.y = y;
  body.targetX = x;
  body.targetY = y;
  body.path = path;
  body.pathIndex = 0;
  body.activity = path.length > 0 ? 'walking' : 'idle';
  body.activityEmoji = '';
  body.destinationBuildingId = null;
  body.direction = 'idle';
  body.intentDescription = '';
  body.behaviorCooldown = 0;
  body.stuckTicks = 0;
  body.overlapTicks = 0;
  body.inCombat = false;
  body.inConversation = false;
  body.isDead = false;
  if (directed) npcSimulation.setNpcPath(body.id, path, 'cove');
}

function pipelineTick(): void {
  sim.tickCount++;
  sim.handleActivityDurations();
  sim.moveNpcs();
  sim.resolveNpcNpcOverlaps();
}

function expectAbandonPayload(body: NpcRuntimeState): void {
  expect(body.path).toHaveLength(0);
  expect(body.activity).toBe('idle');
  expect(body.activityEmoji).toBe('');
  expect(body.destinationBuildingId).toBeNull();
  expect(body.direction).toBe('idle');
  expect(body.intentDescription).toBe('Stepping aside');
  expect(body.behaviorCooldown).toBeGreaterThanOrEqual(8);
  expect(body.behaviorCooldown).toBeLessThanOrEqual(15);
  expect(body.overlapTicks).toBe(0);
}

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
});

describe('directed overlap grace and bounded recovery', () => {
  it('O0: a non-chibi head-on wedge is real and survives the old 3-tick threshold', () => {
    const [a, b] = isolate('hermes-cyrus', 'hermes-mira');
    const pathA = [{ x: 5400, y: 5000 }];
    const pathB = [{ x: 4600, y: 5000 }];
    prepare(a!, 5000, 5000, pathA, true);
    prepare(b!, 5090, 5000, pathB, true);
    const startA = a!.x;
    const startB = b!.x;

    for (let tick = 1; tick <= 5; tick++) {
      pipelineTick();
      expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeLessThanOrEqual(100 + 1e-6);
      expect(a!.path).toBe(pathA);
      expect(b!.path).toBe(pathB);
      expect(sim.directedRoutes.has(a!.path)).toBe(true);
      expect(sim.directedRoutes.has(b!.path)).toBe(true);
      expect(a!.intentDescription).not.toBe('Stepping aside');
      expect(b!.intentDescription).not.toBe('Stepping aside');
    }

    expect(a!.overlapTicks).toBeGreaterThanOrEqual(4);
    expect(b!.overlapTicks).toBeGreaterThanOrEqual(4);
    expect(Math.abs(a!.x - startA)).toBeLessThanOrEqual(6);
    expect(Math.abs(b!.x - startB)).toBeLessThanOrEqual(6);
  });

  it('O1: a directed route survives a transient overlap and completes', () => {
    const [directed, ambient] = isolate('hermes-cyrus', 'hermes-mira');
    const path = [{ x: 5500, y: 5000 }];
    prepare(directed!, 5000, 5000, path, true);
    prepare(ambient!, 5090, 5070, [], false);
    const destination = directed!.destinationBuildingId;
    let maxOverlapTicks = 0;
    let completed = false;

    for (let tick = 0; tick < 60; tick++) {
      pipelineTick();
      maxOverlapTicks = Math.max(maxOverlapTicks, directed!.overlapTicks);
      expect(directed!.path).toBe(path);
      expect(sim.directedRoutes.has(directed!.path)).toBe(true);
      expect(directed!.destinationBuildingId).toBe(destination);
      expect(directed!.intentDescription).not.toBe('Stepping aside');
      if (directed!.pathIndex >= directed!.path.length) {
        completed = true;
        break;
      }
    }

    expect(maxOverlapTicks).toBeGreaterThan(0);
    expect(maxOverlapTicks).toBeLessThan(DIRECTED_OVERLAP_ABANDON);
    expect(completed).toBe(true);
  });

  it('O2: both members of a persistent directed head-on wedge abandon on tick 10', () => {
    const [a, b] = isolate('hermes-cyrus', 'hermes-mira');
    prepare(a!, 5000, 5000, [{ x: 5400, y: 5000 }], true);
    prepare(b!, 5090, 5000, [{ x: 4600, y: 5000 }], true);

    for (let tick = 1; tick < DIRECTED_OVERLAP_ABANDON; tick++) {
      pipelineTick();
      expect(a!.path.length).toBeGreaterThan(0);
      expect(b!.path.length).toBeGreaterThan(0);
      expect(a!.overlapTicks).toBe(tick);
      expect(b!.overlapTicks).toBe(tick);
    }
    pipelineTick();

    expectAbandonPayload(a!);
    expectAbandonPayload(b!);
    expect(isCollisionFreeWorld(a!.x, a!.y, 30)).toBe(true);
    expect(isCollisionFreeWorld(b!.x, b!.y, 30)).toBe(true);
  });

  it('O3: a wall-pinned directed lex-higher body recovers beside a pathless lower', () => {
    const [lower, higher] = isolate('hermes-cyrus', 'hermes-mira');
    expect(lower!.id < higher!.id).toBe(true);
    prepare(lower!, 16, 6000, [], false);
    prepare(higher!, 106, 6000, [{ x: -1000, y: 6000 }], true);

    for (let tick = 1; tick < DIRECTED_OVERLAP_ABANDON; tick++) {
      pipelineTick();
      expect(Math.hypot(lower!.x - higher!.x, lower!.y - higher!.y)).toBeLessThan(100);
      expect(higher!.path.length).toBeGreaterThan(0);
      expect(higher!.overlapTicks).toBe(tick);
      expect(lower!.path).toHaveLength(0);
    }
    pipelineTick();

    expectAbandonPayload(higher!);
    expect(lower!.path).toHaveLength(0);
    expect(lower!.intentDescription).not.toBe('Stepping aside');
    expect(isCollisionFreeWorld(lower!.x, lower!.y, 30)).toBe(true);
    expect(isCollisionFreeWorld(higher!.x, higher!.y, 30)).toBe(true);
  });

  it('O4: a wall-pinned nonzero three-body pile remains recorded through tick 9, then all abandon', () => {
    const bodies = isolate('hermes-cyrus', 'hermes-mira', 'hermes-tekk');
    const starts = [
      { x: 16, y: 6990 },
      { x: 74, y: 7000 },
      { x: 132, y: 7010 },
    ];
    bodies.forEach((body, index) => {
      const start = starts[index]!;
      prepare(body, start.x, start.y, [{ x: -1000, y: start.y }], true);
    });

    for (let tick = 1; tick < DIRECTED_OVERLAP_ABANDON; tick++) {
      pipelineTick();
      for (const body of bodies) {
        expect(body.overlapTicks).toBe(tick);
        expect(body.path.length).toBeGreaterThan(0);
        expect(sim.directedRoutes.has(body.path)).toBe(true);
      }
      const pairDistances = [
        Math.hypot(bodies[0]!.x - bodies[1]!.x, bodies[0]!.y - bodies[1]!.y),
        Math.hypot(bodies[0]!.x - bodies[2]!.x, bodies[0]!.y - bodies[2]!.y),
        Math.hypot(bodies[1]!.x - bodies[2]!.x, bodies[1]!.y - bodies[2]!.y),
      ];
      expect(pairDistances.every((distance) => distance > 1e-6)).toBe(true);
      expect(pairDistances.some((distance) => distance < 100)).toBe(true);
    }

    pipelineTick();
    for (const body of bodies) {
      expectAbandonPayload(body);
      expect(isCollisionFreeWorld(body.x, body.y, 30)).toBe(true);
    }
  });

  it('MF1-i: exact-coincident active directed bodies pinned at a wall abandon by tick 10', () => {
    const [a, b] = isolate('hermes-cyrus', 'hermes-mira');
    prepare(a!, 16, 8000, [{ x: -1000, y: 8000 }], true);
    prepare(b!, 16, 8000, [{ x: -1000, y: 8000 }], true);

    for (let tick = 1; tick < DIRECTED_OVERLAP_ABANDON; tick++) {
      pipelineTick();
      expect(a!.x).toBe(16);
      expect(b!.x).toBe(16);
      expect(a!.y).toBe(b!.y);
      expect(a!.overlapTicks).toBe(tick);
      expect(b!.overlapTicks).toBe(tick);
      expect(a!.path.length).toBeGreaterThan(0);
      expect(b!.path.length).toBeGreaterThan(0);
    }
    pipelineTick();

    expectAbandonPayload(a!);
    expectAbandonPayload(b!);
  });

  it('MF1-ii: an exact-overlapped parked empty directed route is byte-stable beyond the grace', () => {
    const [parked, ambient] = isolate('hermes-cyrus', 'hermes-mira');
    prepare(parked!, 9000, 9000, [{ x: 9010, y: 9000 }], true);
    parked!.pathIndex = parked!.path.length;
    sim.handleActivityDurations();
    expect(parked!.path).toHaveLength(0);
    expect(sim.directedRoutes.has(parked!.path)).toBe(true);
    prepare(ambient!, parked!.x, parked!.y, [], false);
    const parkedPath = parked!.path;
    const before = { ...parked!, inventory: [...parked!.inventory], path: parked!.path };

    for (let tick = 0; tick < DIRECTED_OVERLAP_ABANDON + 2; tick++) {
      sim.resolveNpcNpcOverlaps();
    }

    expect(parked!.path).toBe(parkedPath);
    expect({ ...parked!, inventory: [...parked!.inventory], path: parked!.path }).toEqual(before);
    expect(sim.directedRoutes.has(parked!.path)).toBe(true);
  });

  it('MF1-iii: an exact-coincident all-ambient pair remains the historical no-op', () => {
    const [a, b] = isolate('hermes-cyrus', 'hermes-mira');
    prepare(a!, 10000, 10000, [{ x: 10500, y: 10000 }], false);
    prepare(b!, 10000, 10000, [{ x: 9500, y: 10000 }], false);
    const beforeA = { ...a!, inventory: [...a!.inventory], path: a!.path };
    const beforeB = { ...b!, inventory: [...b!.inventory], path: b!.path };

    for (let tick = 0; tick < DIRECTED_OVERLAP_ABANDON + 2; tick++) {
      sim.resolveNpcNpcOverlaps();
    }

    expect({ ...a!, inventory: [...a!.inventory], path: a!.path }).toEqual(beforeA);
    expect({ ...b!, inventory: [...b!.inventory], path: b!.path }).toEqual(beforeB);
    expect(a!.overlapTicks).toBe(0);
    expect(b!.overlapTicks).toBe(0);
  });
});
