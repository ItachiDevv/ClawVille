import { beforeEach, describe, expect, it } from 'bun:test';
import {
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
  npcOverrides: Map<string, string>;
  agentBotSessions: Map<string, unknown>;
  executeHatcherAction: (
    npcId: string, npc: NpcRuntimeState, name: string,
    params: Record<string, string>, attribution?: unknown,
  ) => void;
};

const sim = npcSimulation as unknown as Sim;
const NPC_ID = 'oq1-gateway-body';

function body(id: string, x = 11264, y = 11264): NpcRuntimeState {
  return {
    id,
    name: 'ExecutorAgent',
    x,
    y,
    targetX: x,
    targetY: y,
    homeX: x,
    homeY: y,
    patrolRadius: 100,
    direction: 'idle',
    species: 'milady_official_1',
    color: 0,
    inConversation: false,
    conversationCooldownUntil: 0,
    activity: 'idle',
    activityEmoji: '',
    destinationBuildingId: null,
    path: [],
    pathIndex: 0,
    activityEndsAt: 0,
    behaviorCooldown: 0,
    intentDescription: '',
    stuckTicks: 0,
    overlapTicks: 0,
    headingAngle: 0,
    hp: 100,
    maxHp: 100,
    attack: 10,
    defense: 10,
    speed: 10,
    inCombat: false,
    inventory: [],
    isDead: false,
    respawnAt: 0,
    hasSword: false,
    isOpenClaw: true,
    level: 1,
    kills: 0,
    xp: 0,
    baseAttack: 10,
    baseDefense: 10,
    baseSpeed: 10,
    baseMaxHp: 100,
    combatTargetId: null,
    lastAttackAt: 0,
    lastHitAt: 0,
    respawnedAt: 0,
    invulnerableUntil: 0,
    combatAction: null,
    combatActionAt: 0,
    autonomyMode: 'server-managed',
  };
}

function npc(): NpcRuntimeState {
  const found = sim.npcs.get(NPC_ID);
  if (!found) throw new Error(`Missing NPC fixture ${NPC_ID}`);
  return found;
}

function dispatch(name: string, params: Record<string, string> = {}): void {
  const current = npc();
  sim.executeHatcherAction(NPC_ID, current, name, params, null);
}

function expectFirstFocusedMovementStep(
  name: 'enter_cove' | 'enter_poker_room' | 'enter_kelp_forest',
  emoji: string,
  destinationBuildingId: string,
): void {
  dispatch(name);
  const current = npc();
  const dispatched = {
    activity: current.activity,
    activityEmoji: current.activityEmoji,
    activityEndsAt: current.activityEndsAt,
    destinationBuildingId: current.destinationBuildingId,
    pathLength: current.path.length,
  };
  const before = { x: current.x, y: current.y };
  const r0 = npcSimulation.getRemainingPathLengthWu(NPC_ID);
  if (r0 === null) throw new Error('Expected a remaining path length');

  sim.moveNpcs();

  const moved = Math.hypot(current.x - before.x, current.y - before.y);
  const r1 = npcSimulation.getRemainingPathLengthWu(NPC_ID);
  if (r1 === null) throw new Error('Expected a remaining path length after movement');
  expect(moved).toBeGreaterThan(0);
  expect(moved).toBeLessThanOrEqual(44 + 1e-6);
  expect(r1).toBeLessThan(r0);
  expect(dispatched.activity).toBe('walking');
  expect(dispatched.activityEmoji).toBe(emoji);
  expect(dispatched.activityEndsAt).toBe(0);
  expect(dispatched.destinationBuildingId).toBe(destinationBuildingId);
  expect(dispatched.pathLength).toBeGreaterThan(0);
  expect(current.activity).toBe('walking');
  expect(current.destinationBuildingId).toBe(destinationBuildingId);
  expect(current.activityEmoji).toBe(emoji);
  expect(current.activityEndsAt).toBe(0);
}

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  sim.npcOverrides.clear();
  sim.agentBotSessions.clear();
  sim.npcs.clear();
  const fixture = body(NPC_ID);
  sim.npcs.set(fixture.id, fixture);
});

describe('OQ-1 gateway enter freeze', () => {
  it('G1: enter_cove moves on the FIRST focused movement step', () => {
    expectFirstFocusedMovementStep('enter_cove', '🎰', 'cove');
  });

  it('G2: enter_poker_room moves on the FIRST focused movement step', () => {
    expectFirstFocusedMovementStep('enter_poker_room', '♠️', 'cove');
  });

  it('G3: enter_kelp_forest moves on the FIRST focused movement step', () => {
    expectFirstFocusedMovementStep('enter_kelp_forest', '🫧', 'kelp-forest-portal');
  });

  it('G4: setNpcPath clears a stale clock for gateway and move routes', () => {
    const current = npc();
    npcSimulation.setNpcActivity(NPC_ID, 'thinking', '💭');
    current.activityEndsAt = Date.now() - 1;

    dispatch('enter_cove');
    expect(current.activityEndsAt).toBe(0);
    sim.handleActivityDurations();
    expect(current.destinationBuildingId).toBe('cove');
    expect(current.activity).toBe('walking');

    npcSimulation.setNpcActivity(NPC_ID, 'thinking', '💭');
    current.activityEndsAt = Date.now() - 1;
    dispatch('move', { x: '11300', y: '11264' });
    expect(current.activityEndsAt).toBe(0);
    sim.handleActivityDurations();
    expect(current.activity).toBe('walking');
  });

  it('G5: gateway arrival lifecycle parks, excludes, and explicitly releases in one lifecycle', () => {
    dispatch('enter_cove');
    const current = npc();
    current.pathIndex = current.path.length;

    sim.handleActivityDurations();
    expect(current.path).toHaveLength(0);
    expect(current.activity).toBe('thinking');
    expect(current.activityEmoji).toBe('💭');
    expect(current.activityEndsAt).toBeGreaterThan(0);
    expect(current.destinationBuildingId).toBe('cove');

    current.activityEndsAt = Date.now() - 1;
    sim.handleActivityDurations();
    expect(current.activity).toBe('idle');
    expect(current.destinationBuildingId).toBeNull();

    const parked = current.path;
    current.behaviorCooldown = 0;
    sim.planNpcBehaviors();
    expect(current.path).toBe(parked);
    expect(current.activity).toBe('idle');
    expect(current.behaviorCooldown).toBe(0);

    expect(sim.getIdleAliveNpcs()).not.toContain(current);
    npcSimulation.clearDestinationBuilding(current.id);
    expect(sim.getIdleAliveNpcs()).toContain(current);
  });

  it('G6: enter_kelp_forest arrival parks too', () => {
    dispatch('enter_kelp_forest');
    const current = npc();
    current.pathIndex = current.path.length;

    sim.handleActivityDurations();
    expect(current.path).toHaveLength(0);
    expect(current.activity).toBe('thinking');
    expect(current.activityEmoji).toBe('💭');
    expect(current.activityEndsAt).toBeGreaterThan(0);
    expect(current.destinationBuildingId).toBe('kelp-forest-portal');

    current.activityEndsAt = Date.now() - 1;
    sim.handleActivityDurations();
    expect(current.activity).toBe('idle');
    expect(current.destinationBuildingId).toBeNull();

    const parked = current.path;
    current.behaviorCooldown = 0;
    sim.planNpcBehaviors();
    expect(current.path).toBe(parked);
    expect(current.activity).toBe('idle');
    expect(current.behaviorCooldown).toBe(0);
  });

  it('G7a: enter_building arrival is NOT stranded', () => {
    dispatch('enter_building', { buildingId: 'api-integrations' });
    const current = npc();
    current.pathIndex = current.path.length;

    sim.handleActivityDurations();
    expect(current.path).toHaveLength(0);
    expect(current.activityEndsAt).toBeGreaterThan(0);

    current.activityEndsAt = Date.now() - 1;
    sim.handleActivityDurations();
    expect(current.activity).toBe('idle');
    expect(sim.getIdleAliveNpcs()).toContain(current);

    current.behaviorCooldown = 0;
    sim.planNpcBehaviors();
    expect(current.behaviorCooldown).not.toBe(0);
  });

  it('G7b: REST /move?buildingId sim-call mirror arrival is NOT stranded', () => {
    const current = npc();
    const path = [{ x: current.x + 10, y: current.y }];
    npcSimulation.setNpcPath(NPC_ID, path, 'code-development');
    current.pathIndex = current.path.length;

    sim.handleActivityDurations();
    expect(current.path).toHaveLength(0);
    expect(current.activityEndsAt).toBeGreaterThan(0);

    current.activityEndsAt = Date.now() - 1;
    sim.handleActivityDurations();
    expect(current.activity).toBe('idle');
    expect(sim.getIdleAliveNpcs()).toContain(current);
  });

  it('G7c: ambient arrival preserves release byte-identity', () => {
    const current = npc();
    current.activity = 'walking';
    current.path = [{ x: current.x + 10, y: current.y }];
    current.pathIndex = 1;
    current.destinationBuildingId = 'code-development';

    sim.handleActivityDurations();
    expect(current.path).toHaveLength(0);
    expect(current.activityEndsAt).toBeGreaterThan(0);
    expect(sim.getIdleAliveNpcs()).toContain(current);

    current.activityEndsAt = Date.now() - 1;
    sim.handleActivityDurations();
    current.behaviorCooldown = 0;
    sim.planNpcBehaviors();
    expect(current.behaviorCooldown).not.toBe(0);
  });

  it('G8: emote still intentionally holds the pose across focused movement steps', () => {
    dispatch('move', { x: '11300', y: '11264' });
    dispatch('emote', { name: 'wave' });
    const current = npc();
    expect(current.activity).not.toBe('walking');
    expect(current.activityEndsAt).toBeGreaterThan(0);
    const before = { x: current.x, y: current.y };

    sim.moveNpcs();
    sim.moveNpcs();
    sim.moveNpcs();

    expect(current.x).toBe(before.x);
    expect(current.y).toBe(before.y);
  });
});
