import { beforeEach, describe, expect, it } from 'bun:test';
import {
  findPath,
  getFindPathCallCount,
  isCollisionFreeWorld,
  resetFindPathCallCount,
  type PathNode,
} from '../pathfinding';
import {
  npcSimulation,
  type NpcConversation,
  type NpcRuntimeState,
} from '../npc-simulation';

type Sim = {
  npcs: Map<string, NpcRuntimeState>;
  conversations: Map<string, NpcConversation>;
  directedRoutes: WeakSet<PathNode[]>;
  tickCount: number;
  npcOverrides: Map<string, string>;
  agentBotSessions: Map<string, unknown>;
  initNpcs: () => void;
  moveNpcs: () => void;
  progressConversations: () => void;
  handleActivityDurations: () => void;
  resolveNpcNpcOverlaps: () => void;
};

const sim = npcSimulation as unknown as Sim;

function npc(id: string): NpcRuntimeState {
  const found = sim.npcs.get(id);
  if (!found) throw new Error(`Missing NPC fixture ${id}`);
  return found;
}

function isolatePair(): [NpcRuntimeState, NpcRuntimeState] {
  const body = npc('chibi-eliza');
  const partner = npc('chibi-milady');
  sim.npcs.clear();
  sim.npcs.set(body.id, body);
  sim.npcs.set(partner.id, partner);

  body.x = 11264;
  body.y = 11264;
  body.isOpenClaw = true;
  body.autonomyMode = 'server-managed';
  body.inConversation = true;
  body.inCombat = false;
  body.isDead = false;
  body.path = [];
  body.pathIndex = 0;
  body.activity = 'idle';
  body.activityEndsAt = 0;
  body.behaviorCooldown = 0;

  partner.x = 18000;
  partner.y = 18000;
  partner.inConversation = true;
  partner.inCombat = false;
  partner.isDead = false;
  partner.path = [];
  partner.pathIndex = 0;
  partner.activity = 'idle';
  partner.activityEndsAt = 0;

  return [body, partner];
}

function finishConversation(body: NpcRuntimeState, partner: NpcRuntimeState): NpcConversation {
  const conversation: NpcConversation = {
    id: 'directed-release',
    npc1Id: body.id,
    npc2Id: partner.id,
    messages: [{ npcId: body.id, npcName: body.name, text: 'On my way.' }],
    currentIndex: 0,
    nextMessageAt: Date.now() - 1,
    state: 'active',
    typingNpcId: null,
    typingUntil: 0,
  };
  sim.conversations.set(conversation.id, conversation);
  sim.progressConversations();
  return conversation;
}

function pipelineTick(): void {
  sim.tickCount++;
  sim.handleActivityDurations();
  sim.moveNpcs();
  sim.resolveNpcNpcOverlaps();
}

function placeNearCove(body: NpcRuntimeState): void {
  const cove = npcSimulation.buildPerception(body.id)?.places
    .find((place) => place.destinationId === 'cove');
  if (!cove) throw new Error('Missing Cove perception fixture');
  for (let index = 0; index < 16; index++) {
    const angle = (index / 16) * Math.PI * 2;
    const x = cove.centerX + Math.cos(angle) * 400;
    const y = cove.centerY + Math.sin(angle) * 400;
    if (!isCollisionFreeWorld(x, y, 30)) continue;
    if (findPath(x, y, cove.centerX, cove.centerY).length === 0) continue;
    body.x = x;
    body.y = y;
    return;
  }
  throw new Error('No pathable near-Cove body fixture found');
}

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  sim.conversations.clear();
  sim.npcOverrides.clear();
  sim.agentBotSessions.clear();
});

describe('conversation release preserves directed routes', () => {
  it('C0: enter_cove plus emote resumes the same route, clears the timer, and arrives', () => {
    const [body, partner] = isolatePair();
    placeNearCove(body);
    const originalRandom = Math.random;
    let cleaned = '';
    Math.random = () => 0.5;
    try {
      cleaned = npcSimulation.dispatchHatcherActions(
        body.id,
        'On my way. [ACTION: enter_cove()] [ACTION: emote(name=wave)]',
      );
    } finally {
      Math.random = originalRandom;
    }

    expect(cleaned).toBe('On my way.');
    expect(sim.directedRoutes.has(body.path)).toBe(true);
    expect(body.destinationBuildingId).toBe('cove');
    expect(body.path.length).toBeGreaterThan(0);
    expect(body.activity).not.toBe('walking');
    expect(body.activityEndsAt).toBeGreaterThan(0);

    const directedPath = body.path;
    finishConversation(body, partner);

    expect(body.inConversation).toBe(false);
    expect(body.activity).toBe('walking');
    expect(body.activityEndsAt).toBe(0);
    expect(body.path).toBe(directedPath);
    expect(body.pathIndex).toBe(0);
    expect(sim.directedRoutes.has(body.path)).toBe(true);
    expect(body.destinationBuildingId).toBe('cove');
    expect(body.behaviorCooldown).toBe(200);

    sim.handleActivityDurations();
    expect(body.activity).toBe('walking');
    expect(body.destinationBuildingId).toBe('cove');

    let ticks = 0;
    while (body.path.length > 0 && ticks < 400) {
      pipelineTick();
      ticks++;
    }
    expect(ticks).toBeLessThan(400);
    expect(body.path).toHaveLength(0);
    expect(body.activityEndsAt).toBeGreaterThan(0);
    expect(body.activity).not.toBe('idle');
    expect(sim.directedRoutes.has(body.path)).toBe(true);
  });

  it('C1: a lone directed enter keeps route identity and presentation fields', () => {
    const [body, partner] = isolatePair();
    const path = [{ x: body.x + 600, y: body.y }];
    npcSimulation.setNpcPath(body.id, path, 'cove');
    npcSimulation.setNpcActivityEmoji(body.id, '🎰');

    finishConversation(body, partner);

    expect(body.inConversation).toBe(false);
    expect(body.activity).toBe('walking');
    expect(body.activityEndsAt).toBe(0);
    expect(body.activityEmoji).toBe('🎰');
    expect(body.path).toBe(path);
    expect(body.pathIndex).toBe(0);
    expect(body.behaviorCooldown).toBe(200);
    expect(body.destinationBuildingId).toBe('cove');
    expect(sim.directedRoutes.has(body.path)).toBe(true);
    expect(body.conversationCooldownUntil).toBeGreaterThan(Date.now());
  });

  it('C2: an ambient participant keeps the historical reset payload', () => {
    const [body, partner] = isolatePair();
    body.path = [{ x: body.x + 10, y: body.y }];
    body.pathIndex = 0;
    body.activity = 'walking';
    body.activityEmoji = '💬';
    body.behaviorCooldown = 77;
    body.destinationBuildingId = null;

    finishConversation(body, partner);

    expect(body.inConversation).toBe(false);
    expect(body.activity as string).toBe('idle');
    expect(body.activityEmoji).toBe('');
    expect(body.path).toHaveLength(0);
    expect(body.pathIndex).toBe(0);
    expect(body.behaviorCooldown).toBe(3);
    expect(body.conversationCooldownUntil).toBeGreaterThan(Date.now());
  });

  it('C3: the released body walks without any tick-time A*', () => {
    const [body, partner] = isolatePair();
    const path = [{ x: body.x + 1_000, y: body.y }];
    npcSimulation.setNpcPath(body.id, path, 'cove');
    finishConversation(body, partner);
    const before = { x: body.x, y: body.y };
    const remainingBefore = npcSimulation.getRemainingPathLengthWu(body.id);

    resetFindPathCallCount();
    sim.moveNpcs();

    const remainingAfter = npcSimulation.getRemainingPathLengthWu(body.id);
    expect(Math.hypot(body.x - before.x, body.y - before.y)).toBeGreaterThan(0);
    expect(Math.hypot(body.x - before.x, body.y - before.y)).toBeLessThanOrEqual(44 + 1e-6);
    expect(remainingBefore).not.toBeNull();
    expect(remainingAfter).not.toBeNull();
    expect(remainingAfter!).toBeLessThan(remainingBefore!);
    expect(getFindPathCallCount()).toBe(0);
    expect(body.path).toBe(path);
  });

  it('C4: a missing second participant is a no-op', () => {
    const [body, partner] = isolatePair();
    const path = [{ x: body.x + 600, y: body.y }];
    npcSimulation.setNpcPath(body.id, path, 'cove');
    const conversation: NpcConversation = {
      id: 'missing-participant',
      npc1Id: body.id,
      npc2Id: 'does-not-exist',
      messages: [{ npcId: partner.id, npcName: partner.name, text: 'x' }],
      currentIndex: 0,
      nextMessageAt: Date.now() - 1,
      state: 'active',
      typingNpcId: null,
      typingUntil: 0,
    };
    sim.conversations.set(conversation.id, conversation);

    expect(() => sim.progressConversations()).not.toThrow();
    expect(conversation.state).toBe('done');
    expect(body.activity).toBe('walking');
    expect(body.path).toBe(path);
  });
});
