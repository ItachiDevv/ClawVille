/**
 * Hosted avatar-agent internal session (§B.2, 2026-07-08) — DB-free coverage of
 * the mint plan + the sim mechanics the orchestration runs, mirroring the
 * agent-reconnect-session.test.ts pattern (the DB upsert + advisory lock are
 * exercised on the staging wire, not here — the route graph crashes at module load
 * without FINGERPRINT_SECRET, and the dual-lock pattern is byte-identical to the
 * already-proven partner-hatcher register).
 *
 * Asserts the five money/session invariants:
 *   (1) agentId derivation — verbatim platformAgentId, reserved-namespace refusal;
 *   (2) config binding — ledgerCapable=true + boundUserId=owner + self-managed +
 *       fail-soft 'nanoclaw' wire (trap 4 / no-outbound-gateway);
 *   (3) row values — Milady identity, is_house=false, owner-bound, non-null
 *       future TTL (fail-closed), atomic hash;
 *   (4) reuse decision — reuse ONLY when RAM-live AND body-present;
 *   (5) sim mechanics — ONE deterministic ocb- body; the gate-relevant config is
 *       readable via getAgentBotConfig; a re-mint replaces (never duplicates) the
 *       body and kills the old bearer; a "restart" (Map clear) is NOT reusable.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import type { AgentSubstrateClient } from '../agent-substrate-client';
import { npcSimulation } from '../npc-simulation';
import { sha256Hex } from '../session-digest';
import {
  hostedAvatarAgentId,
  buildHostedAvatarAgentConfig,
  hostedAvatarBotRowValues,
  isHostedSessionReusable,
  HOSTED_AVATAR_IDENTITY_TYPE,
} from '../hosted-avatar-agent-session-plan';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PLATFORM_AGENT_ID = '22222222-2222-4222-8222-222222222222';
const MODEL_KEY = 'milady_official_1';
const NAME = 'TestHostedAgent';

// ---------------------------------------------------------------------------
// (1) agentId derivation
// ---------------------------------------------------------------------------
describe('(1) hostedAvatarAgentId', () => {
  it('returns the platformAgentId verbatim (opaque, deterministic, non-reserved)', () => {
    expect(hostedAvatarAgentId(PLATFORM_AGENT_ID)).toBe(PLATFORM_AGENT_ID);
  });

  it('throws on empty and on a reserved partner namespace', () => {
    expect(() => hostedAvatarAgentId('')).toThrow();
    expect(() => hostedAvatarAgentId('hatcher:partner-owned')).toThrow(/reserved partner/);
  });
});

// ---------------------------------------------------------------------------
// (2) config binding — the trap-4 ledger binding + fail-soft wire
// ---------------------------------------------------------------------------
describe('(2) buildHostedAvatarAgentConfig', () => {
  const config = buildHostedAvatarAgentConfig({
    agentId: PLATFORM_AGENT_ID,
    sessionId: 'oc-bearer-under-test',
    ownerUserId: OWNER,
    modelKey: MODEL_KEY,
    name: NAME,
  });

  it('binds ledgerCapable=true AND boundUserId=owner (both, or the cove 403s)', () => {
    expect(config.ledgerCapable).toBe(true);
    expect(config.boundUserId).toBe(OWNER);
  });

  it('is a self-managed, fail-soft nanoclaw avatar body (no outbound POST)', () => {
    expect(config.mode).toBe('avatar');
    expect(config.autonomyMode).toBe('self-managed');
    // The wire is the fail-soft 'nanoclaw' stub — .chat() returns '' with NO
    // network call, so the body never POSTs to a gateway.
    expect(config.protocol).toBe('nanoclaw');
    expect(config.gatewayUrl).toBe('http://localhost:0');
    expect(config.authToken).toBe('');
  });

  it('renders as the avatar (species = the owner-avatar model key), sessionId = bearer', () => {
    if (config.mode !== 'avatar') throw new Error('expected avatar-mode config');
    expect(config.species).toBe(MODEL_KEY);
    expect(config.sessionId).toBe('oc-bearer-under-test');
  });
});

// ---------------------------------------------------------------------------
// (3) row values — identity, is_house, owner binding, fail-closed TTL, hash
// ---------------------------------------------------------------------------
describe('(3) hostedAvatarBotRowValues', () => {
  const expiresAt = new Date(Date.now() + 86_400_000);
  const bearer = 'oc-row-bearer';
  const values = hostedAvatarBotRowValues({
    ownerUserId: OWNER,
    sessionKeyHash: sha256Hex(bearer),
    sessionExpiresAt: expiresAt,
    modelKey: MODEL_KEY,
    name: NAME,
  });

  it('is a non-house, owner-bound Milady avatar row using the fail-soft wire', () => {
    expect(values.identityType).toBe(HOSTED_AVATAR_IDENTITY_TYPE);
    expect(values.identityType).toBe('milady');
    expect(values.protocol).toBe('nanoclaw');
    expect(values.mode).toBe('avatar');
    expect(values.isHouse).toBe(false);
    expect(values.userId).toBe(OWNER);
    expect(values.gatewayUrl).toBeNull();
  });

  it('carries a NON-NULL future TTL (null = expired downstream) + the one-way hash, never the raw bearer', () => {
    expect(values.sessionExpiresAt).toBe(expiresAt);
    expect(values.sessionExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(values.sessionKeyHash).toBe(sha256Hex(bearer));
    expect(JSON.stringify(values)).not.toContain(bearer);
    expect(values.sessionSweptAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (4) reuse decision
// ---------------------------------------------------------------------------
describe('(4) isHostedSessionReusable', () => {
  it('reuses ONLY when RAM-live AND body-present', () => {
    expect(isHostedSessionReusable({ mapValid: true, bodyPresent: true })).toBe(true);
    expect(isHostedSessionReusable({ mapValid: true, bodyPresent: false })).toBe(false);
    expect(isHostedSessionReusable({ mapValid: false, bodyPresent: true })).toBe(false);
    expect(isHostedSessionReusable({ mapValid: false, bodyPresent: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (5) sim mechanics — the register/evict sequence the orchestration runs
// ---------------------------------------------------------------------------
type Sim = {
  npcs: Map<string, unknown>;
  agentBotSessions: Map<string, unknown>;
  npcOverrides: Map<string, string>;
  avatarBodyOwners: Map<string, string>;
  humanControlledOpenClawUntil: Map<string, number>;
  initNpcs: () => void;
};
const asSim = () => npcSimulation as unknown as Sim;
const bodyIdFor = (agentId: string) =>
  `ocb-${Buffer.from(agentId, 'utf8').toString('base64url')}`;
const stubClient = () =>
  ({ getProtocol: () => 'nanoclaw' } as unknown as AgentSubstrateClient);

beforeEach(() => {
  const sim = asSim();
  (npcSimulation as unknown as { stop: () => void }).stop();
  sim.initNpcs();
  sim.agentBotSessions.clear();
  sim.npcOverrides.clear();
  sim.avatarBodyOwners.clear();
  sim.humanControlledOpenClawUntil.clear();
});

function registerHosted(sessionId: string) {
  const config = buildHostedAvatarAgentConfig({
    agentId: PLATFORM_AGENT_ID,
    sessionId,
    ownerUserId: OWNER,
    modelKey: MODEL_KEY,
    name: NAME,
  });
  npcSimulation.registerAgentBot(config, stubClient());
  return config;
}

describe('(5) sim mechanics', () => {
  it('registers ONE deterministic ocb- body with the gate-relevant ledger config', () => {
    const sim = asSim();
    const bearer = 'oc-first-bearer';
    registerHosted(bearer);

    const bodyId = bodyIdFor(PLATFORM_AGENT_ID);
    expect(npcSimulation.isValidAgentSession(bearer)).toBe(true);
    expect(npcSimulation.getNpcIdForSession(bearer)).toBe(bodyId);
    expect(sim.npcs.has(bodyId)).toBe(true);

    // The gate reads these off getAgentBotConfig — proving resolveAgentSession
    // keeps the session ledger-capable when the row.userId === boundUserId.
    const cfg = npcSimulation.getAgentBotConfig(bearer)!;
    expect(cfg.ledgerCapable).toBe(true);
    expect(cfg.boundUserId).toBe(OWNER);
    expect(cfg.autonomyMode).toBe('self-managed');
  });

  it('re-mint (register new → evict old) keeps ONE body owned by the new bearer; old bearer dies', () => {
    const sim = asSim();
    const oldBearer = 'oc-old-bearer';
    const newBearer = 'oc-new-bearer';
    const bodyId = bodyIdFor(PLATFORM_AGENT_ID);

    registerHosted(oldBearer);
    expect(sim.npcs.has(bodyId)).toBe(true);

    // The service sequence: register the NEW session first (rebinds the body),
    // then unregister the OLD held session (ownership-scoped → drops only the
    // stale Map entry, never the live body).
    registerHosted(newBearer);
    npcSimulation.unregisterAgentBot(oldBearer);

    // Exactly ONE ocb- body, owned by the new session.
    const ocbBodies = [...sim.npcs.keys()].filter((k) => k.startsWith('ocb-'));
    expect(ocbBodies).toEqual([bodyId]);
    expect(sim.npcOverrides.get(bodyId)).toBe(newBearer);
    // Old bearer is no longer a live session; new one is.
    expect(npcSimulation.isValidAgentSession(oldBearer)).toBe(false);
    expect(npcSimulation.isValidAgentSession(newBearer)).toBe(true);
    expect(npcSimulation.getNpcIdForSession(newBearer)).toBe(bodyId);
  });

  it('a reaped body with a surviving session is NOT reusable (getNpcById, not getNpcIdForSession)', () => {
    // Guards the reuse check: getNpcIdForSession derives the body id from the
    // session config even when the body was removed from this.npcs, so it stays
    // TRUTHY for a body-less session that would 404 at resolveSession. The reuse
    // gate must consult getNpcById (actual presence). Simulate the divergence.
    const sim = asSim();
    const bearer = 'oc-body-reaped';
    registerHosted(bearer);
    const bodyId = bodyIdFor(PLATFORM_AGENT_ID);

    // Remove ONLY the body, leaving the session Map entry intact.
    sim.npcs.delete(bodyId);

    const mapValid = npcSimulation.isValidAgentSession(bearer);
    const derivedBodyId = npcSimulation.getNpcIdForSession(bearer); // still truthy
    const actuallyPresent = !!npcSimulation.getNpcById(bodyId);
    expect(mapValid).toBe(true);
    expect(derivedBodyId).toBe(bodyId); // the trap: truthy despite a reaped body
    expect(actuallyPresent).toBe(false);
    // So the reuse gate (mapValid && getNpcById-present) must NOT reuse.
    expect(isHostedSessionReusable({ mapValid, bodyPresent: actuallyPresent })).toBe(false);
  });

  it('after a "restart" (Map cleared) the old bearer is NOT reusable → re-mint restores a live body', () => {
    const oldBearer = 'oc-pre-restart';
    registerHosted(oldBearer);
    expect(npcSimulation.isValidAgentSession(oldBearer)).toBe(true);

    // Simulate the process restart the in-memory registry + sim Map suffer.
    const sim = asSim();
    sim.agentBotSessions.clear();
    sim.npcOverrides.clear();
    sim.avatarBodyOwners.clear();
    sim.npcs.clear();

    // The reuse gate observes a dead Map → re-mint path is taken.
    const mapValid = npcSimulation.isValidAgentSession(oldBearer);
    expect(mapValid).toBe(false);
    expect(isHostedSessionReusable({ mapValid, bodyPresent: false })).toBe(false);

    // Re-mint with a FRESH bearer restores the body, ledger-capable.
    const freshBearer = 'oc-post-restart';
    registerHosted(freshBearer);
    expect(npcSimulation.isValidAgentSession(freshBearer)).toBe(true);
    const cfg = npcSimulation.getAgentBotConfig(freshBearer)!;
    expect(cfg.ledgerCapable).toBe(true);
    expect(cfg.boundUserId).toBe(OWNER);
    expect(npcSimulation.getNpcIdForSession(freshBearer)).toBe(bodyIdFor(PLATFORM_AGENT_ID));
  });
});
