import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import {
  KELP_MAZE_ENTRY,
  KELP_MAZE_PHOTO_SPOT,
  NPC_BUILDING_CENTERS,
  WORLD_CENTER_PX,
} from '@clawville/shared';
import { npcSimulation } from '../npc-simulation';
import type { CovenantActionInput } from '../covenant-action-recorder';

interface TestNpc {
  id: string;
  name: string;
  x: number;
  y: number;
  path: Array<{ x: number; y: number }>;
  [key: string]: unknown;
}

interface SimInternals {
  npcs: Map<string, TestNpc>;
  agentBotSessions: Map<string, {
    config: { agentId: string; mode: 'avatar'; avatarId?: string };
    client: { getProtocol: () => string };
  }>;
  npcOverrides: Map<string, string>;
  pendingEvents: Array<{ type: string; data: { message: string } }>;
  missingActionAttributionWarned: Set<string>;
  emoteOwnershipQuery: (avatarId: string, animationKey: string) => Promise<boolean>;
  initNpcs: () => void;
  executeHatcherAction: (
    npcId: string,
    npc: TestNpc,
    name: string,
    params: Record<string, string>,
    attribution?: { avatarId: string; actorKind: 'agent' } | null,
  ) => void;
}

const sim = npcSimulation as unknown as SimInternals;
const originalCovenantRecord = npcSimulation.covenantRecord;
const originalEmoteOwnershipQuery = npcSimulation.emoteOwnershipQuery;
const AVATAR = 'executor-avatar';

function body(id: string, x = 11264, y = 11264): TestNpc {
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
    autonomyMode: 'self-managed',
  };
}

beforeEach(() => {
  npcSimulation.stop();
  sim.initNpcs();
  sim.agentBotSessions.clear();
  sim.npcOverrides.clear();
  sim.pendingEvents = [];
  sim.missingActionAttributionWarned.clear();
});

afterEach(() => {
  npcSimulation.covenantRecord = originalCovenantRecord;
  npcSimulation.emoteOwnershipQuery = originalEmoteOwnershipQuery;
});

async function flushEmoteLookup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('in-world executor covenant hooks', () => {
  it('broadcasts an owned+equipped emote and serializes its monotonic sequence', async () => {
    const lookups: Array<{ avatarId: string; animationKey: string }> = [];
    npcSimulation.emoteOwnershipQuery = async (avatarId, animationKey) => {
      lookups.push({ avatarId, animationKey });
      return true;
    };
    const npc = body('owned-emote-body');
    sim.npcs.set(npc.id, npc);
    sim.agentBotSessions.set('owned-emote-session', {
      config: { agentId: npc.id, mode: 'avatar', avatarId: AVATAR },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
    sim.npcOverrides.set(npc.id, 'owned-emote-session');

    npcSimulation.dispatchHatcherActions(
      npc.id,
      '[ACTION: emote(name=breakdance)]',
    );
    await flushEmoteLookup();

    expect(lookups).toEqual([{ avatarId: AVATAR, animationKey: 'breakdance' }]);
    expect(npc.emoteClip).toBe('breakdance');
    expect(npc.emoteSeq).toBe(1);
    const serialized = npcSimulation.getSnapshot().npcs.find((entry) => entry.id === npc.id);
    expect(serialized?.emoteClip).toBe('breakdance');
    expect(serialized?.emoteSeq).toBe(1);

    npcSimulation.dispatchHatcherActions(
      npc.id,
      '[ACTION: emote(name=breakdance)]',
    );
    await flushEmoteLookup();
    expect(npc.emoteSeq).toBe(2);
  });

  it('keeps legacy think immediate while an equipped think SKU adds its clip broadcast', async () => {
    let resolveOwned: ((owned: boolean) => void) | undefined;
    npcSimulation.emoteOwnershipQuery = () => new Promise<boolean>((resolve) => {
      resolveOwned = resolve;
    });
    const npc = body('legacy-think-owned-body');
    sim.npcs.set(npc.id, npc);
    sim.agentBotSessions.set('legacy-think-owned-session', {
      config: { agentId: npc.id, mode: 'avatar', avatarId: AVATAR },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
    sim.npcOverrides.set(npc.id, 'legacy-think-owned-session');

    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: emote(name=think)]');
    expect(npc.activity).toBe('thinking');
    expect(npc.emoteClip).toBeUndefined();

    resolveOwned?.(true);
    await flushEmoteLookup();
    expect(npc.activity).toBe('thinking');
    expect(npc.emoteClip).toBe('think');
    expect(npc.emoteSeq).toBe(1);

    npcSimulation.emoteOwnershipQuery = async () => false;
    const unowned = body('legacy-think-unowned-body');
    sim.npcs.set(unowned.id, unowned);
    sim.agentBotSessions.set('legacy-think-unowned-session', {
      config: { agentId: unowned.id, mode: 'avatar', avatarId: AVATAR },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
    sim.npcOverrides.set(unowned.id, 'legacy-think-unowned-session');
    npcSimulation.dispatchHatcherActions(unowned.id, '[ACTION: emote(name=think)]');
    await flushEmoteLookup();
    expect(unowned.activity).toBe('thinking');
    expect(unowned.emoteSeq).toBeUndefined();

    let unattributedLookups = 0;
    npcSimulation.emoteOwnershipQuery = async () => {
      unattributedLookups++;
      return true;
    };
    const unattributed = body('legacy-think-unattributed-body');
    sim.npcs.set(unattributed.id, unattributed);
    sim.executeHatcherAction(
      unattributed.id,
      unattributed,
      'emote',
      { name: 'think' },
      null,
    );
    await flushEmoteLookup();
    expect(unattributed.activity).toBe('thinking');
    expect(unattributed.emoteSeq).toBeUndefined();
    expect(unattributedLookups).toBe(0);
  });

  it('drops owned-but-unequipped and unowned emote keys', async () => {
    const lookups: string[] = [];
    npcSimulation.emoteOwnershipQuery = async (_avatarId, animationKey) => {
      lookups.push(animationKey);
      return false;
    };
    const npc = body('not-equipped-emote-body');
    sim.npcs.set(npc.id, npc);
    sim.agentBotSessions.set('not-equipped-emote-session', {
      config: { agentId: npc.id, mode: 'avatar', avatarId: AVATAR },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
    sim.npcOverrides.set(npc.id, 'not-equipped-emote-session');

    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: emote(name=shrug)]');
    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: emote(name=not_owned)]');
    await flushEmoteLookup();

    expect(lookups).toEqual(['shrug', 'not_owned']);
    expect(npc.emoteClip).toBeUndefined();
    expect(npc.emoteSeq).toBeUndefined();
  });

  it('shape/prototype/missing gates drop before any emote ownership query', async () => {
    const lookups: string[] = [];
    npcSimulation.emoteOwnershipQuery = async (_avatarId, animationKey) => {
      lookups.push(animationKey);
      return true;
    };
    const npc = body('invalid-emote-body');
    sim.npcs.set(npc.id, npc);
    sim.agentBotSessions.set('invalid-emote-session', {
      config: { agentId: npc.id, mode: 'avatar', avatarId: AVATAR },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
    sim.npcOverrides.set(npc.id, 'invalid-emote-session');

    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: emote(name=bad-name!)]');
    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: emote(name=constructor)]');
    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: emote(name=__proto__)]');
    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: emote()]');
    sim.executeHatcherAction(
      npc.id,
      npc,
      'emote',
      { name: 7 as unknown as string },
      { avatarId: AVATAR, actorKind: 'agent' },
    );
    sim.executeHatcherAction(npc.id, npc, 'emote', { name: 'handstand' }, null);
    await flushEmoteLookup();

    expect(lookups).toEqual([]);
    expect(npc.emoteClip).toBeUndefined();
    expect(npc.emoteSeq).toBeUndefined();
  });

  it('does not apply an owned-emote result to a despawned/replaced body', async () => {
    let resolveOwned: ((owned: boolean) => void) | undefined;
    npcSimulation.emoteOwnershipQuery = () => new Promise<boolean>((resolve) => {
      resolveOwned = resolve;
    });
    const npc = body('stale-emote-body');
    sim.npcs.set(npc.id, npc);
    sim.agentBotSessions.set('stale-emote-session', {
      config: { agentId: npc.id, mode: 'avatar', avatarId: AVATAR },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
    sim.npcOverrides.set(npc.id, 'stale-emote-session');

    npcSimulation.dispatchHatcherActions(npc.id, '[ACTION: emote(name=clap)]');
    const replacement = body(npc.id);
    sim.npcs.set(npc.id, replacement);
    resolveOwned?.(true);
    await flushEmoteLookup();

    expect(npc.emoteClip).toBeUndefined();
    expect(replacement.emoteClip).toBeUndefined();
  });

  it('accepts a move from outside the kelp maze and raster-paths to its photo spot', () => {
    const npc = body(
      'kelp-maze-executor-body',
      KELP_MAZE_ENTRY.approachWorldX + WORLD_CENTER_PX.x,
      KELP_MAZE_ENTRY.approachWorldZ + WORLD_CENTER_PX.y,
    );
    sim.npcs.set(npc.id, npc);

    sim.executeHatcherAction(npc.id, npc, 'move', {
      x: String(KELP_MAZE_PHOTO_SPOT.worldX + WORLD_CENTER_PX.x),
      y: String(KELP_MAZE_PHOTO_SPOT.worldZ + WORLD_CENTER_PX.y),
    });

    expect(npc.path.length).toBeGreaterThan(0);
  });

  it('completes late identityKey/Milady avatar attribution before connect returns', async () => {
    const source = await Bun.file(
      new URL('../../routes/agent-gateway.ts', import.meta.url),
    ).text();
    const resolvedAt = source.indexOf('const resolved = await mintSessionTicketFromConnect');
    const bindAt = source.indexOf(
      'npcSimulation.bindAgentAvatarAttribution(sessionId, resolved.avatarId)',
      resolvedAt,
    );
    const responseAt = source.indexOf('return c.json(', bindAt);
    expect(resolvedAt).toBeGreaterThanOrEqual(0);
    expect(bindAt).toBeGreaterThan(resolvedAt);
    expect(responseAt).toBeGreaterThan(bindAt);
  });

  it('records validated move/building/cove/poker/chat decisions with ids and hashes only', () => {
    const records: CovenantActionInput[] = [];
    npcSimulation.covenantRecord = async (input) => {
      records.push(input);
      return { id: 'record', deduped: false };
    };
    const attribution = { avatarId: AVATAR, actorKind: 'agent' as const };
    const npc = body('executor-body');
    sim.npcs.set(npc.id, npc);

    sim.executeHatcherAction(npc.id, npc, 'move', { x: '11300', y: '11264' }, attribution);
    sim.executeHatcherAction(
      npc.id,
      npc,
      'enter_building',
      { buildingId: 'api-integrations' },
      attribution,
    );
    sim.executeHatcherAction(npc.id, npc, 'enter_cove', {}, attribution);
    sim.executeHatcherAction(npc.id, npc, 'enter_poker_room', {}, attribution);

    // Hatcher protocol is contractually proximity-exempt; the executor still
    // validates the target and message before injecting/recording.
    sim.agentBotSessions.set('executor-session', {
      config: { agentId: npc.id, mode: 'avatar', avatarId: AVATAR },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
    sim.npcOverrides.set(npc.id, 'executor-session');
    const message = 'teach me about APIs';
    sim.executeHatcherAction(
      npc.id,
      npc,
      'talk_to_npc',
      { buildingId: 'api-integrations', message },
      attribution,
    );

    expect(records).toEqual([
      expect.objectContaining({
        action: 'agent.move',
        subjectId: AVATAR,
        actorKind: 'agent',
        payload: { x: 11300, y: 11264 },
      }),
      expect.objectContaining({
        action: 'agent.move',
        payload: { destination: 'api-integrations' },
      }),
      expect.objectContaining({
        action: 'agent.move',
        payload: { destination: 'cove', venue: 'cove' },
      }),
      expect.objectContaining({
        action: 'agent.move',
        payload: { destination: 'cove', venue: 'poker' },
      }),
      expect.objectContaining({
        action: 'agent.chat',
        payload: {
          target: 'api-integrations',
          msgSha256: createHash('sha256').update(message, 'utf8').digest('hex'),
          len: message.length,
        },
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain(message);
  });

  it('records nothing for dropped actions or emotes', () => {
    const records: CovenantActionInput[] = [];
    npcSimulation.covenantRecord = async (input) => {
      records.push(input);
      return { id: 'record', deduped: false };
    };
    const attribution = { avatarId: AVATAR, actorKind: 'agent' as const };
    const center = NPC_BUILDING_CENTERS['api-integrations'];
    const npc = body('dropped-body', center.x + 4_000, center.y);
    sim.npcs.set(npc.id, npc);
    sim.agentBotSessions.set('dropped-session', {
      config: { agentId: npc.id, mode: 'avatar', avatarId: AVATAR },
      client: { getProtocol: () => 'nanoclaw' },
    });
    sim.npcOverrides.set(npc.id, 'dropped-session');

    sim.executeHatcherAction(npc.id, npc, 'move', { x: '-1', y: '0' }, attribution);
    sim.executeHatcherAction(npc.id, npc, 'enter_building', { buildingId: 'constructor' }, attribution);
    sim.executeHatcherAction(npc.id, npc, 'talk_to_npc', {
      buildingId: 'api-integrations',
      message: 'too far',
    }, attribution);
    sim.executeHatcherAction(npc.id, npc, 'emote', { name: 'wave' }, attribution);

    expect(records).toEqual([]);
  });

  it('parses talk_to_npc message robustly: space-separated params and commas inside the message', () => {
    const records: CovenantActionInput[] = [];
    npcSimulation.covenantRecord = async (input) => {
      records.push(input);
      return { id: 'record', deduped: false };
    };
    const npc = body('parser-body');
    sim.npcs.set(npc.id, npc);
    sim.agentBotSessions.set('parser-session', {
      config: { agentId: npc.id, mode: 'avatar', avatarId: AVATAR },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
    sim.npcOverrides.set(npc.id, 'parser-session');

    // Live staging drop 2026-07-15: the model omitted the comma between params.
    // The old comma-split glued ` message=…` onto buildingId and dropped the
    // action as an unknown target — no bubble, no record, no teacher settle.
    const spaceMsg = 'How do I effectively use MCP servers in custom tool development';
    npcSimulation.dispatchHatcherActions(
      npc.id,
      `[ACTION: talk_to_npc(buildingId=api-integrations message=${spaceMsg})]`,
    );

    // A message containing commas must reach the bubble/record IN FULL — the
    // old parser truncated it at the first comma.
    const commaMsg = 'Hello, teacher, tell me about APIs';
    npcSimulation.dispatchHatcherActions(
      npc.id,
      `[ACTION: talk_to_npc(buildingId=api-integrations, message=${commaMsg})]`,
    );

    expect(sim.pendingEvents).toHaveLength(2);
    expect(sim.pendingEvents[0].data.message).toBe(spaceMsg);
    expect(sim.pendingEvents[1].data.message).toBe(commaMsg);
    expect(records).toEqual([
      expect.objectContaining({
        action: 'agent.chat',
        payload: {
          target: 'api-integrations',
          msgSha256: createHash('sha256').update(spaceMsg, 'utf8').digest('hex'),
          len: spaceMsg.length,
        },
      }),
      expect.objectContaining({
        action: 'agent.chat',
        payload: {
          target: 'api-integrations',
          msgSha256: createHash('sha256').update(commaMsg, 'utf8').digest('hex'),
          len: commaMsg.length,
        },
      }),
    ]);
  });

  it('missing attribution executes without a record or throw and warns once per body', () => {
    const records: CovenantActionInput[] = [];
    npcSimulation.covenantRecord = async (input) => {
      records.push(input);
      return { id: 'record', deduped: false };
    };
    const npc = body('unattributed-body');
    sim.npcs.set(npc.id, npc);
    sim.agentBotSessions.set('unattributed-session', {
      config: { agentId: npc.id, mode: 'avatar' },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
    sim.npcOverrides.set(npc.id, 'unattributed-session');

    expect(() => npcSimulation.dispatchHatcherActions(
      npc.id,
      '[ACTION: talk_to_npc(buildingId=api-integrations, message=hello)]',
    )).not.toThrow();
    expect(() => npcSimulation.dispatchHatcherActions(
      npc.id,
      '[ACTION: talk_to_npc(buildingId=api-integrations, message=again)]',
    )).not.toThrow();
    expect(sim.pendingEvents).toHaveLength(2);
    expect(records).toEqual([]);
    expect(sim.missingActionAttributionWarned).toEqual(new Set([npc.id]));
  });

  it('resolves config.avatarId through dispatch and supports post-connect binding', () => {
    const records: CovenantActionInput[] = [];
    npcSimulation.covenantRecord = async (input) => {
      records.push(input);
      return { id: 'record', deduped: false };
    };
    const npc = body('late-bound-body');
    sim.npcs.set(npc.id, npc);
    sim.agentBotSessions.set('late-bound-session', {
      config: { agentId: npc.id, mode: 'avatar' },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
    sim.npcOverrides.set(npc.id, 'late-bound-session');

    expect(npcSimulation.bindAgentAvatarAttribution('late-bound-session', AVATAR)).toBe(true);
    npcSimulation.dispatchHatcherActions(
      npc.id,
      '[ACTION: talk_to_npc(buildingId=api-integrations, message=bound hello)]',
    );

    expect(records).toEqual([
      expect.objectContaining({
        action: 'agent.chat',
        subjectId: AVATAR,
        actorKind: 'agent',
        payload: expect.objectContaining({ target: 'api-integrations' }),
      }),
    ]);
  });
});
