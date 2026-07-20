/**
 * Magic-link onboarding — control handback (D1/D3/D4/D5, 2026-07-02).
 *
 * DB-free unit coverage for the four seams this build added:
 *   (a) human-control suppression now covers AVATAR-mode (`ocb-`) bodies via
 *       the new `avatarBodyOwners` map — including the exact regression the
 *       map exists for (owner-session churn dangling the npcOverrides chain) —
 *       and lapses after the TTL;
 *   (b) `bindAgentOwner` fills a live config's `boundUserId` (the in-memory
 *       half of bind-at-redemption) and NEVER clobbers a different owner;
 *   (c) the shared `canBindAgentOwner` never-clobber predicate (the testable
 *       statement of the /enter SQL guard's WHERE clause);
 *   (d) the status response shape — stats/ownership mechanically null for an
 *       unbound session (Rule E5 honesty) and the read-side ledger predicate
 *       mirroring resolveAgentSession's grant condition.
 *
 * Uses the `npcSimulation` singleton via the `as any` escape hatch (same
 * pattern as agent-autonomy-p1.test.ts) — the suppression predicate is
 * private, not worth exposing publicly just for the test. The pure helpers in
 * `agent-owner-binding.ts` are dependency-free by design so this file never
 * loads the agent-gateway route graph (which throws at module load without
 * FINGERPRINT_SECRET).
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import type { AgentSubstrateClient } from '../agent-substrate-client';
import { npcSimulation } from '../npc-simulation';
import { buildAvatarSessionConfig } from '../agent-session-config';
import {
  canBindAgentOwner,
  sessionLedgerCapable,
  buildAgentStatusResponse,
} from '../agent-owner-binding';

type Sim = {
  npcs: Map<string, unknown>;
  agentBotSessions: Map<string, { config: { agentId: string; boundUserId?: string | null } }>;
  npcOverrides: Map<string, string>;
  avatarBodyOwners: Map<string, string>;
  humanControlledOpenClawUntil: Map<string, number>;
  isHumanControlledOpenClawNpc: (npcId: string, now?: number) => boolean;
  initNpcs: () => void;
};

const asSim = () => npcSimulation as unknown as Sim;

/** The deterministic avatar body id (`ocb-<base64url(agentId)>`). */
function bodyIdFor(agentId: string): string {
  return `ocb-${Buffer.from(agentId, 'utf8').toString('base64url')}`;
}

/** Register a REAL avatar-mode body through the actual registerAgentBot path
 *  (nanoclaw fail-soft wire — no network, no DB), so `avatarBodyOwners` is
 *  populated exactly the way production populates it. */
function registerAvatarBody(agentId: string, sessionId: string, boundUserId: string | null = null) {
  const config = buildAvatarSessionConfig({
    mode: 'avatar',
    agentId,
    sessionId,
    identityType: 'milady',
    storedProtocol: 'nanoclaw',
    autonomyMode: 'self-managed',
    name: 'Handback',
    species: 'milady_official_1',
    color: 0x123456,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 11264,
    homeY: 11264,
    patrolRadius: 100,
    personality: '',
    ledgerCapable: true,
    boundUserId,
  });
  // Stub client — nanoclaw bodies never POST anywhere; the sim only stores it.
  const client = { getProtocol: () => 'nanoclaw' } as unknown as AgentSubstrateClient;
  npcSimulation.registerAgentBot(config, client);
  return config;
}

beforeEach(() => {
  const sim = asSim();
  // Stop any live 200ms sim interval a prior test FILE may have left running,
  // then clear every registry this file touches. Singletons are shared across
  // the whole `bun test` process, so this isolation is mandatory.
  (npcSimulation as unknown as { stop: () => void }).stop();
  sim.initNpcs();
  sim.agentBotSessions.clear();
  sim.npcOverrides.clear();
  sim.avatarBodyOwners.clear();
  sim.humanControlledOpenClawUntil.clear();
});

describe('(a) suppression covers avatar-mode ocb- bodies (avatarBodyOwners)', () => {
  it('marked avatar body is suppressed, and lapses after the TTL', () => {
    const sim = asSim();
    const agentId = 'handback-agent';
    const bodyId = bodyIdFor(agentId);
    registerAvatarBody(agentId, 'ag-handback-1');

    // Registration recorded the direct npcId → agentId link.
    expect(sim.avatarBodyOwners.get(bodyId)).toBe(agentId);

    // Unmarked → not suppressed.
    expect(sim.isHumanControlledOpenClawNpc(bodyId)).toBe(false);
    expect(npcSimulation.isAgentHumanControlled(agentId)).toBe(false);

    // Mark (the heartbeat controlMode:'player' path) → suppressed.
    npcSimulation.markHumanControlledOpenClaw(agentId, 15_000);
    expect(sim.isHumanControlledOpenClawNpc(bodyId)).toBe(true);
    expect(npcSimulation.isAgentHumanControlled(agentId)).toBe(true);

    // TTL lapse (clock injection, no sleep) → released again.
    const afterTtl = Date.now() + 15_001;
    expect(sim.isHumanControlledOpenClawNpc(bodyId, afterTtl)).toBe(false);
    expect(npcSimulation.isAgentHumanControlled(agentId, afterTtl)).toBe(false);
  });

  it('suppression survives owner-session churn (the exact pre-fix ocb- gap)', () => {
    const sim = asSim();
    const agentId = 'churn-agent';
    const bodyId = bodyIdFor(agentId);
    registerAvatarBody(agentId, 'ag-churn-1');

    // Simulate the churn window: the owning session vanishes from the session
    // map (rebind eviction / sweeper race) while the body persists. The OLD
    // npcOverrides→agentBotSessions chain now dangles — pre-fix this returned
    // false and the human's driven avatar got a second, auto-walking body.
    sim.agentBotSessions.delete('ag-churn-1');

    npcSimulation.markHumanControlledOpenClaw(agentId, 15_000);
    expect(sim.isHumanControlledOpenClawNpc(bodyId)).toBe(true);
  });

  it('buildPerception carries the humanControlled signal for the body', () => {
    const agentId = 'percept-agent';
    const bodyId = bodyIdFor(agentId);
    registerAvatarBody(agentId, 'ag-percept-1');

    expect(npcSimulation.buildPerception(bodyId)?.humanControlled).toBe(false);
    npcSimulation.markHumanControlledOpenClaw(agentId, 15_000);
    expect(npcSimulation.buildPerception(bodyId)?.humanControlled).toBe(true);
  });

  it('ownership-scoped teardown clears the avatarBodyOwners entry', () => {
    const sim = asSim();
    const agentId = 'teardown-agent';
    const bodyId = bodyIdFor(agentId);
    registerAvatarBody(agentId, 'ag-teardown-1');
    expect(sim.avatarBodyOwners.has(bodyId)).toBe(true);

    npcSimulation.unregisterAgentBot('ag-teardown-1');
    expect(sim.avatarBodyOwners.has(bodyId)).toBe(false);
    // A stale (non-owning) unregister must NOT strip the live body's entry:
    registerAvatarBody(agentId, 'ag-teardown-2'); // rebinds npcOverrides to -2
    sim.agentBotSessions.set('ag-teardown-stale', {
      config: { agentId, boundUserId: null },
    } as never);
    npcSimulation.unregisterAgentBot('ag-teardown-stale'); // does not own the body
    expect(sim.avatarBodyOwners.get(bodyId)).toBe(agentId);
  });
});

describe('(b) bindAgentOwner — in-memory half of bind-at-redemption', () => {
  it('fills a live config boundUserId and reports the update count', () => {
    const config = registerAvatarBody('bind-agent', 'ag-bind-1', null);
    expect(config.boundUserId).toBeNull();

    const updated = npcSimulation.bindAgentOwner('bind-agent', 'user-1');
    expect(updated).toBe(1);
    expect(config.boundUserId).toBe('user-1');

    // Idempotent re-affirmation of the SAME user still counts as an update.
    expect(npcSimulation.bindAgentOwner('bind-agent', 'user-1')).toBe(1);
    expect(config.boundUserId).toBe('user-1');
  });

  it('never clobbers a config bound to a DIFFERENT user', () => {
    const config = registerAvatarBody('clobber-agent', 'ag-clobber-1', 'user-A');
    expect(npcSimulation.bindAgentOwner('clobber-agent', 'user-B')).toBe(0);
    expect(config.boundUserId).toBe('user-A');
  });

  it('returns 0 when the agent has no live session (row bind still stands)', () => {
    expect(npcSimulation.bindAgentOwner('ghost-agent', 'user-1')).toBe(0);
  });
});

describe('(c) canBindAgentOwner — the /enter SQL guard as a predicate', () => {
  it('unowned row → bindable', () => {
    expect(canBindAgentOwner(null, 'user-1')).toBe(true);
  });
  it('same owner → bindable (idempotent returning scenario)', () => {
    expect(canBindAgentOwner('user-1', 'user-1')).toBe(true);
  });
  it('DIFFERENT owner → never clobbered', () => {
    expect(canBindAgentOwner('user-A', 'user-B')).toBe(false);
  });
});

describe('(d) status shape — E5 honesty + read-side ledger predicate', () => {
  const realStats = {
    ct: 12345,
    level: 7,
    xp: 999,
    leaderboard: { score: 42, rank: 3 as number | null },
  };
  const realOwnership = { landParcels: 2, ownedSkills: ['clawville-memory-rag'] };

  it('UNBOUND session: stats/ownership forced null even when values were passed', () => {
    const res = buildAgentStatusResponse({
      agentId: 'a-1',
      identityType: 'milady',
      expiresAt: '2026-07-03T00:00:00.000Z',
      humanControlled: false,
      botUserId: null,
      config: { ledgerCapable: true, boundUserId: null },
      // Deliberately non-null — the shape builder must refuse them for an
      // unbound session so a demo session can never present a real economy.
      stats: realStats,
      ownership: realOwnership,
    });
    expect(res.stats).toBeNull();
    expect(res.ownership).toBeNull();
    expect(res.session.boundUser).toBe(false);
    expect(res.session.ledgerCapable).toBe(false);
    expect(res.agentId).toBe('a-1');
    expect(res.identityType).toBe('milady');
  });

  it('BOUND session: stats/ownership pass through; ledgerCapable mirrors the spend gate', () => {
    const res = buildAgentStatusResponse({
      agentId: 'a-2',
      identityType: 'openclaw',
      expiresAt: null,
      humanControlled: true,
      botUserId: 'user-1',
      config: { ledgerCapable: true, boundUserId: 'user-1' },
      stats: realStats,
      ownership: realOwnership,
    });
    expect(res.stats).toEqual(realStats);
    expect(res.ownership).toEqual(realOwnership);
    expect(res.session.boundUser).toBe(true);
    expect(res.session.humanControlled).toBe(true);
    expect(res.session.ledgerCapable).toBe(true);
  });

  it('SECURITY: row-bound but UNPROVEN session (non-ledger reconnect to a victim agentId) must NOT leak the victim economy', () => {
    // The account-takeover-adjacent info-leak the adversarial panel found: a
    // caller who knows a victim's PUBLIC agentId can reconnect (agentId-only →
    // ledgerCapable=false) and hit /status. botUserId=victim, so keying the
    // null-ing on `botUserId != null` leaked the victim's CT/leaderboard/land.
    // The fix keys on PROVEN ownership (sessionLedgerCapable) — so real numbers
    // are withheld even though the row IS owned. session.boundUser stays honest.
    const res = buildAgentStatusResponse({
      agentId: 'a-victim',
      identityType: 'openclaw',
      expiresAt: null,
      humanControlled: false,
      botUserId: 'victim-user', // row IS bound…
      config: { ledgerCapable: false, boundUserId: null }, // …but THIS session did not prove it
      stats: realStats,
      ownership: realOwnership,
    });
    expect(res.stats).toBeNull();
    expect(res.ownership).toBeNull();
    expect(res.session.ledgerCapable).toBe(false);
    // Honest signal that the row has AN owner (not that THIS caller is it):
    expect(res.session.boundUser).toBe(true);
  });

  it('sessionLedgerCapable — the exact resolveAgentSession grant condition', () => {
    // Grant: flag true + boundUserId matches the live row's userId.
    expect(sessionLedgerCapable({ ledgerCapable: true, boundUserId: 'u1' }, 'u1')).toBe(true);
    // Demotions: flag false / null bind / row rebound to a different user /
    // unbound row — all read as non-ledger, matching the spend gate.
    expect(sessionLedgerCapable({ ledgerCapable: false, boundUserId: 'u1' }, 'u1')).toBe(false);
    expect(sessionLedgerCapable({ ledgerCapable: true, boundUserId: null }, 'u1')).toBe(false);
    expect(sessionLedgerCapable({ ledgerCapable: true, boundUserId: 'u1' }, 'u2')).toBe(false);
    expect(sessionLedgerCapable({ ledgerCapable: true, boundUserId: 'u1' }, null)).toBe(false);
    expect(sessionLedgerCapable({}, 'u1')).toBe(false);
  });
});
