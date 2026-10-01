import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { NPC_IDS } from '@clawville/shared';
import type { AgentSubstrateRegistration } from '@clawville/shared';
import type { AgentSubstrateClient } from '../agent-substrate-client';

// Connect-sec round 4, Codex round-2 BLOCK (2026-10-01): an owner-bind
// eviction that threw used to be logged and skipped, so a stray session could
// stay in the session Map and keep a cognition client, an [ACTION:] path and a
// public roster entry for the owner's body. These tests pin:
//   - `unregisterAgentBot` removes the session before any hook, so a hook throw
//     cannot leave it in the Map;
//   - `fenceAndEvictOnOwnerBind` verifies and QUARANTINES the agent when a stray
//     is left or an enumeration threw; a retried throw that the verify proves
//     clean does not quarantine;
//   - every Map-only reader skips a quarantined agent;
//   - the next registration evicts the rest and releases the quarantine, and
//     keeps it when a stray still cannot be evicted;
//   - Hatcher register / patch / restore registrations release a quarantine
//     and are never quarantined by a clean owner-bind path.
// DB-free: the real simulation singleton, no mock.module.

const { npcSimulation } = await import('../npc-simulation');
const { buildAvatarSessionConfig, buildOverrideSessionConfig } = await import('../agent-session-config');
const { fenceAndEvictOnOwnerBind, evictAgentSessionsOrQuarantine } = await import('../agent-owner-bind-eviction');
const { isAgentQuarantined, quarantineAgent, __resetAgentOwnerFenceForTests } = await import('../agent-owner-fence');

const OWNER_ID = '81111111-1111-4111-8111-111111111111';
const liveSessions = new Set<string>();
const restores: Array<() => void> = [];

function stubClient(protocol: string): AgentSubstrateClient {
  return {
    getProtocol: () => protocol,
    setWorldStateProvider: () => {},
    setSystemContextProvider: () => {},
  } as unknown as AgentSubstrateClient;
}

function avatarConfig(agentId: string, sessionId: string, boundUserId: string | null): AgentSubstrateRegistration {
  const config = buildAvatarSessionConfig({
    mode: 'avatar',
    agentId,
    sessionId,
    identityType: 'custom',
    storedProtocol: 'nanoclaw',
    autonomyMode: 'server-managed',
    name: 'Quarantine Test',
    species: 'milady_official_1',
    color: 0x123456,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: '',
    ledgerCapable: boundUserId !== null,
    boundUserId,
  });
  // nanoclaw resolves to self-managed, which never joins ambient conversations;
  // a server-managed body shows the conversation-picker gate.
  config.autonomyMode = 'server-managed';
  return config;
}

/** Same builder inputs as the Hatcher register / patch / restore avatar path. */
function hatcherAvatarConfig(agentId: string, sessionId: string, boundUserId: string | null): AgentSubstrateRegistration {
  return buildAvatarSessionConfig({
    mode: 'avatar',
    agentId,
    sessionId,
    identityType: 'hatcher',
    storedProtocol: 'hatcher-proxy',
    autonomyMode: 'server-managed',
    name: 'Hatcher Test',
    species: null,
    color: null,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 11264,
    homeY: 11264,
    patrolRadius: 100,
    personality: '',
    ledgerCapable: true,
    boundUserId,
    protocolOverride: 'hatcher-proxy',
  });
}

function register(config: AgentSubstrateRegistration, protocol = 'nanoclaw'): AgentSubstrateClient {
  const client = stubClient(protocol);
  npcSimulation.registerAgentBot(config, client);
  liveSessions.add(config.sessionId);
  return client;
}

function bodyIdFor(agentId: string): string {
  return `ocb-${Buffer.from(agentId, 'utf8').toString('base64url')}`;
}

function idleCandidates(): string[] {
  const sim = npcSimulation as unknown as { getIdleAliveNpcs(): Array<{ id: string }> };
  return sim.getIdleAliveNpcs().map((npc) => npc.id);
}

/** Every Map-only reader for this agent, in one readable shape. */
function mapOnlyView(agentId: string, sessionId: string) {
  const bodyId = bodyIdFor(agentId);
  return {
    clientByBody: npcSimulation.getAgentBotClient(bodyId) !== null,
    clientBySession: npcSimulation.getAgentBotClientBySession(sessionId) !== null,
    inRoster: npcSimulation.getActiveAgentBots().some((bot) => bot.agentId === agentId),
    conversationCandidate: idleCandidates().includes(bodyId),
  };
}

function alwaysThrowFor(sessionId: string) {
  const realUnregister = npcSimulation.unregisterAgentBot.bind(npcSimulation);
  const spy = spyOn(npcSimulation, 'unregisterAgentBot').mockImplementation((sid: string) => {
    if (sid === sessionId) throw new Error('simulated eviction fault');
    return realUnregister(sid);
  });
  restores.push(() => spy.mockRestore());
  return spy;
}

beforeAll(() => {
  // The override test needs the static NPC bodies (start() is never called here).
  (npcSimulation as unknown as { initNpcs(): void }).initNpcs();
});

beforeEach(() => {
  __resetAgentOwnerFenceForTests();
});

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  for (const sid of liveSessions) npcSimulation.unregisterAgentBot(sid);
  liveSessions.clear();
  __resetAgentOwnerFenceForTests();
});

describe('unregisterAgentBot: Map removal never throws', () => {
  test('a throwing combat hook cannot leave the session or its body in the Map', () => {
    const agentId = 'q-hook-throw';
    const sid = 'ag-q-hook-throw';
    register(avatarConfig(agentId, sid, null));
    const instance = npcSimulation as unknown as Record<string, unknown>;
    instance.cleanupNpcFromCombats = () => {
      throw new Error('simulated hook fault');
    };
    restores.push(() => {
      delete instance.cleanupNpcFromCombats;
    });

    expect(npcSimulation.unregisterAgentBot(sid)).toBe(true);
    expect(npcSimulation.isValidAgentSession(sid)).toBe(false);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([]);
    expect(npcSimulation.getNpcById(bodyIdFor(agentId))).toBeNull();
  });
});

describe('fenceAndEvictOnOwnerBind: verify + quarantine', () => {
  test('an eviction that keeps throwing quarantines the agent and every Map-only reader skips it', () => {
    const agentId = 'q-evict-throw';
    const straySid = 'ag-q-evict-throw-stray';
    register(avatarConfig(agentId, straySid, null));
    expect(mapOnlyView(agentId, straySid)).toEqual({
      clientByBody: true,
      clientBySession: true,
      inRoster: true,
      conversationCandidate: true,
    });
    const spy = alwaysThrowFor(straySid);

    fenceAndEvictOnOwnerBind(agentId);

    // Two passes, then the verify: the stray is still in the Map.
    expect(spy.mock.calls.filter(([sid]) => sid === straySid)).toHaveLength(2);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([straySid]);
    expect(isAgentQuarantined(agentId)).toBe(true);
    expect(mapOnlyView(agentId, straySid)).toEqual({
      clientByBody: false,
      clientBySession: false,
      inRoster: false,
      conversationCandidate: false,
    });
    // [ACTION:] dispatch: the tag is stripped and nothing runs on the body.
    const body = npcSimulation.getNpcById(bodyIdFor(agentId))!;
    const activityBefore = body.activity;
    const speech = npcSimulation.dispatchHatcherActions(bodyIdFor(agentId), 'hello [ACTION: emote(name=wave)]');
    expect(speech).toBe('hello');
    expect(npcSimulation.getNpcById(bodyIdFor(agentId))!.activity).toBe(activityBefore);
  });

  test('a fresh owner session evicts the stray, releases the quarantine, and the readers work again', () => {
    const agentId = 'q-release';
    const straySid = 'ag-q-release-stray';
    const ownerSid = 'ag-q-release-owner';
    register(avatarConfig(agentId, straySid, null));
    const spy = alwaysThrowFor(straySid);
    fenceAndEvictOnOwnerBind(agentId);
    expect(isAgentQuarantined(agentId)).toBe(true);
    spy.mockRestore();

    register(avatarConfig(agentId, ownerSid, OWNER_ID));

    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([ownerSid]);
    expect(isAgentQuarantined(agentId)).toBe(false);
    expect(mapOnlyView(agentId, ownerSid)).toEqual({
      clientByBody: true,
      clientBySession: true,
      inRoster: true,
      conversationCandidate: true,
    });
    npcSimulation.dispatchHatcherActions(bodyIdFor(agentId), '[ACTION: emote(name=wave)]');
    expect(npcSimulation.getNpcById(bodyIdFor(agentId))!.activity).toBe('socializing');
  });

  test('a registration that still cannot evict the stray keeps the quarantine (fail closed)', () => {
    const agentId = 'q-keep';
    const straySid = 'ag-q-keep-stray';
    const ownerSid = 'ag-q-keep-owner';
    register(avatarConfig(agentId, straySid, null));
    alwaysThrowFor(straySid);
    fenceAndEvictOnOwnerBind(agentId);

    register(avatarConfig(agentId, ownerSid, OWNER_ID));

    expect(npcSimulation.findActiveSessionsByAgentIds([agentId]).sort()).toEqual([ownerSid, straySid].sort());
    expect(isAgentQuarantined(agentId)).toBe(true);
    expect(npcSimulation.getAgentBotClientBySession(ownerSid)).toBeNull();
    expect(npcSimulation.getAgentBotClientBySession(straySid)).toBeNull();
  });

  test('a session enumeration that throws quarantines the agent even when the Map ends clean', () => {
    const agentId = 'q-enum-throw';
    const straySid = 'ag-q-enum-throw-stray';
    register(avatarConfig(agentId, straySid, null));
    const realFind = npcSimulation.findActiveSessionsByAgentIds.bind(npcSimulation);
    let calls = 0;
    const spy = spyOn(npcSimulation, 'findActiveSessionsByAgentIds').mockImplementation((ids: Iterable<string>) => {
      calls++;
      if (calls === 1) throw new Error('simulated enumeration fault');
      return realFind(ids);
    });
    restores.push(() => spy.mockRestore());

    const result = evictAgentSessionsOrQuarantine(agentId, { source: 'test' });

    expect(result.enumerationFailed).toBe(true);
    expect(result.strays).toBe(0);
    expect(result.quarantined).toBe(true);
    expect(isAgentQuarantined(agentId)).toBe(true);
    expect(realFind([agentId])).toEqual([]);
  });

  test('an eviction throw that the second pass fixes is proven clean and does not quarantine', () => {
    const agentId = 'q-retry-clean';
    const straySid = 'ag-q-retry-clean-stray';
    register(avatarConfig(agentId, straySid, null));
    const realUnregister = npcSimulation.unregisterAgentBot.bind(npcSimulation);
    let strayCalls = 0;
    const spy = spyOn(npcSimulation, 'unregisterAgentBot').mockImplementation((sid: string) => {
      if (sid === straySid && ++strayCalls === 1) throw new Error('simulated eviction fault');
      return realUnregister(sid);
    });
    restores.push(() => spy.mockRestore());

    fenceAndEvictOnOwnerBind(agentId);

    expect(strayCalls).toBe(2);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([]);
    expect(isAgentQuarantined(agentId)).toBe(false);
  });
});

describe('Hatcher sessions and the quarantine', () => {
  test('a clean owner-bind eviction never quarantines a Hatcher agent', () => {
    const agentId = 'hatcher:q-clean';
    const sid = 'hat-q-clean';
    register(hatcherAvatarConfig(agentId, sid, null), 'hatcher-proxy');

    fenceAndEvictOnOwnerBind(agentId);

    expect(isAgentQuarantined(agentId)).toBe(false);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([]);
  });

  test('a Hatcher register (anonymous, ledger-capable) on a quarantined agent releases it', () => {
    const agentId = 'hatcher:q-register';
    const straySid = 'hat-q-register-stale';
    const freshSid = 'hat-q-register-fresh';
    register(hatcherAvatarConfig(agentId, straySid, null), 'hatcher-proxy');
    quarantineAgent(agentId);

    register(hatcherAvatarConfig(agentId, freshSid, null), 'hatcher-proxy');

    expect(isAgentQuarantined(agentId)).toBe(false);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([freshSid]);
    expect(npcSimulation.getAgentBotClientBySession(freshSid)).not.toBeNull();
    expect(npcSimulation.getAgentBotClient(bodyIdFor(agentId))).not.toBeNull();
    expect(npcSimulation.getAgentBotConfig(freshSid)?.ledgerCapable).toBe(true);
  });

  test('a Hatcher patch or restore (same bearer re-registered) on a quarantined agent releases it', () => {
    const agentId = 'hatcher:q-patch';
    const sid = 'hat-q-patch-preserved';
    register(hatcherAvatarConfig(agentId, sid, OWNER_ID), 'hatcher-proxy');
    quarantineAgent(agentId);
    expect(npcSimulation.getAgentBotClientBySession(sid)).toBeNull();

    // The patch path unregisters the live session and re-registers the SAME
    // bearer; restore re-registers it by its row hash. Both reach registerAgentBot.
    npcSimulation.unregisterAgentBot(sid);
    register(hatcherAvatarConfig(agentId, sid, OWNER_ID), 'hatcher-proxy');

    expect(isAgentQuarantined(agentId)).toBe(false);
    expect(npcSimulation.getAgentBotClientBySession(sid)).not.toBeNull();
  });

  test('a Hatcher override register on a quarantined agent takes the seat back from the stray and releases it', () => {
    const agentId = 'hatcher:q-override';
    const straySid = 'hat-q-override-stale';
    const freshSid = 'hat-q-override-fresh';
    const targetNpcId = NPC_IDS[1];
    const overrideConfig = (sessionId: string) => buildOverrideSessionConfig({
      mode: 'override',
      agentId,
      sessionId,
      identityType: 'hatcher',
      storedProtocol: 'hatcher-proxy',
      autonomyMode: 'server-managed',
      targetNpcId,
      ledgerCapable: true,
      boundUserId: null,
      protocolOverride: 'hatcher-proxy',
    });
    register(overrideConfig(straySid), 'hatcher-proxy');
    quarantineAgent(agentId);
    expect(npcSimulation.getAgentBotClient(targetNpcId)).toBeNull();

    register(overrideConfig(freshSid), 'hatcher-proxy');

    expect(isAgentQuarantined(agentId)).toBe(false);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([freshSid]);
    expect(npcSimulation.getAgentBotClient(targetNpcId)).toBe(npcSimulation.getAgentBotClientBySession(freshSid));
  });
});
