/**
 * /reconnect agent-session mint — focused DB-free coverage (P0 gate fix,
 * 2026-07-03; found live by scripts/agent-connect/restart-survival-proof.ts).
 *
 * Covers the pure planner (`agent-reconnect-session.ts`) + the sim-level
 * replace-not-duplicate mechanics the route relies on:
 *   (1) credential zod trio is byte-identical in intent to connectSchema's
 *       (url gatewayUrl, non-empty authToken, 4-value protocol enum);
 *   (2) DORMANT-INERT fallback: a real-gateway type without credentials mints
 *       a fail-soft 'nanoclaw' config (no outbound POST target ever armed);
 *   (3) full outbound rebuild when credentials are re-supplied (incl. the
 *       authToken-only re-arm against a persisted real gateway URL);
 *   (4) proof-carrying ledger rule: ledgerCapable IFF bot.userId === provenUserId;
 *   (5) reserved partner rows (hatcher) are NEVER minted — the route keeps its
 *       legacy ticket-only response shape for them (backward compat);
 *   (6) old-hash invalidation: the plan's persisted sessionKeyHash is the NEW
 *       bearer's hash (≠ the old bearer's), which is exactly what makes
 *       validateLiveAgentSession tear down / refuse the old bearer;
 *   (7) ONE body per agentId: the evict→re-register sequence the route runs
 *       replaces the deterministic `ocb-` body, never duplicates it, and the
 *       old sessionId is no longer a valid RAM session.
 *
 * DB-free by design — the planner is dependency-light (no route import: the
 * agent-gateway route graph throws at module load without FINGERPRINT_SECRET).
 * Sim mechanics use the real `npcSimulation` singleton with the same
 * clear-in-beforeEach isolation as agent-control-handback.test.ts.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { z } from 'zod';
import type { AgentSubstrateClient } from '../agent-substrate-client';
import { npcSimulation } from '../npc-simulation';
import { sha256Hex } from '../session-digest';
import {
  gatewayCredentialZodFields,
  planReconnectSession,
  type ReconnectBotRow,
} from '../agent-reconnect-session';

const credSchema = z.object(gatewayCredentialZodFields);

function botRow(overrides: Partial<ReconnectBotRow> = {}): ReconnectBotRow {
  return {
    agentId: 'reconnect-test-agent',
    identityType: 'openclaw',
    protocol: 'openai-compat',
    gatewayUrl: 'https://agent.example.com/gw',
    userId: 'user-1',
    mode: 'avatar',
    name: 'ReconnectTest',
    species: 'milady_official_1',
    color: 0x336699,
    targetNpcId: null,
    metadata: {
      personality: 'test',
      homeX: 2560,
      homeY: 2560,
      patrolRadius: 100,
      stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
      lastX: 1200,
      lastY: 1300,
    },
    ...overrides,
  };
}

const NEW_SID = 'ag-new-bearer-for-tests';
const OLD_SID = 'ag-old-bearer-for-tests';

describe('(1) gateway-credential zod trio (connectSchema parity shapes)', () => {
  it('accepts an all-absent body and a full valid trio', () => {
    expect(credSchema.safeParse({}).success).toBe(true);
    expect(
      credSchema.safeParse({
        gatewayUrl: 'https://agent.example.com/gw',
        authToken: 'tok-123',
        protocol: 'openai-compat',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-URL gatewayUrl, an empty authToken, and an unknown protocol', () => {
    expect(credSchema.safeParse({ gatewayUrl: 'not-a-url' }).success).toBe(false);
    expect(credSchema.safeParse({ authToken: '' }).success).toBe(false);
    expect(credSchema.safeParse({ protocol: 'hatcher-proxy' }).success).toBe(false);
    expect(credSchema.safeParse({ protocol: 'smoke-signals' }).success).toBe(false);
  });
});

describe('(2) dormant-inert fallback (real-gateway type, no credentials)', () => {
  it('mints a fail-soft nanoclaw config — never an armed outbound client', () => {
    const plan = planReconnectSession({
      bot: botRow(),
      provenUserId: 'user-1',
      sessionId: NEW_SID,
    });
    if (!plan.mint) throw new Error('expected mint');
    expect(plan.dormant).toBe(true);
    // The fail-soft wire: AgentSubstrateClient.chat() for 'nanoclaw' returns '' with
    // NO network call, so the body is mute-but-alive (perceive/move/act works).
    expect(plan.config.protocol).toBe('nanoclaw');
    expect(plan.config.authToken).toBe('');
    // No credential was supplied → nothing to persist beyond the hash.
    expect(plan.persist.gatewayUrl).toBeUndefined();
    expect(plan.persist.protocol).toBeUndefined();
    // Body respawns at its last known position.
    expect(plan.restoredState).toEqual({ lastX: 1200, lastY: 1300 });
  });

  it('every real-gateway identity type dorms without credentials (openclaw/ironclaw/custom)', () => {
    for (const identityType of ['openclaw', 'ironclaw', 'custom']) {
      const plan = planReconnectSession({
        bot: botRow({ identityType }),
        provenUserId: 'user-1',
        sessionId: NEW_SID,
      });
      if (!plan.mint) throw new Error(`expected mint for ${identityType}`);
      expect(plan.dormant).toBe(true);
      expect(plan.config.protocol).toBe('nanoclaw');
    }
  });

  it('a restorable no-gateway type (hermes) is NOT dormant — its wire is natively fail-soft', () => {
    const plan = planReconnectSession({
      bot: botRow({ identityType: 'hermes', gatewayUrl: null, protocol: 'nanoclaw' }),
      provenUserId: 'user-1',
      sessionId: NEW_SID,
    });
    if (!plan.mint) throw new Error('expected mint');
    expect(plan.dormant).toBe(false);
    // Derived from identityType (D1 rule); the host-it-for-me gate is off in
    // tests, so hermes resolves to the fail-soft 'nanoclaw'.
    expect(plan.config.protocol).toBe('nanoclaw');
    expect(plan.config.autonomyMode).toBe('self-managed');
  });
});

describe('(3) full outbound rebuild when credentials are re-supplied', () => {
  it('gatewayUrl + authToken + protocol → armed client config + persisted url/protocol', () => {
    const plan = planReconnectSession({
      bot: botRow(),
      provenUserId: 'user-1',
      sessionId: NEW_SID,
      credentials: {
        gatewayUrl: 'https://fresh.example.com/gw2',
        authToken: 'fresh-token',
        protocol: 'anthropic',
      },
    });
    if (!plan.mint) throw new Error('expected mint');
    expect(plan.dormant).toBe(false);
    expect(plan.config.gatewayUrl).toBe('https://fresh.example.com/gw2');
    expect(plan.config.authToken).toBe('fresh-token');
    expect(plan.config.protocol).toBe('anthropic');
    // Mirror /connect's returning-row persistence.
    expect(plan.persist.gatewayUrl).toBe('https://fresh.example.com/gw2');
    expect(plan.persist.protocol).toBe('anthropic');
  });

  it('authToken alone re-arms against the row-persisted REAL gateway', () => {
    const plan = planReconnectSession({
      bot: botRow(),
      provenUserId: 'user-1',
      sessionId: NEW_SID,
      credentials: { authToken: 'rearmed-token' },
    });
    if (!plan.mint) throw new Error('expected mint');
    expect(plan.dormant).toBe(false);
    expect(plan.config.gatewayUrl).toBe('https://agent.example.com/gw');
    expect(plan.config.authToken).toBe('rearmed-token');
    // The stored protocol drives the wire when none is re-supplied.
    expect(plan.config.protocol).toBe('openai-compat');
    // authToken is request-scoped: NEVER in the persist set.
    expect(plan.persist.gatewayUrl).toBeUndefined();
    expect(plan.persist.protocol).toBeUndefined();
    expect(JSON.stringify(plan.persist)).not.toContain('rearmed-token');
  });

  it('authToken alone against a dummy/absent row gateway stays DORMANT (never a broken localhost:0 client)', () => {
    for (const gatewayUrl of [null, 'http://localhost:0']) {
      const plan = planReconnectSession({
        bot: botRow({ gatewayUrl }),
        provenUserId: 'user-1',
        sessionId: NEW_SID,
        credentials: { authToken: 'token-without-a-target' },
      });
      if (!plan.mint) throw new Error('expected mint');
      expect(plan.dormant).toBe(true);
      expect(plan.config.protocol).toBe('nanoclaw');
      expect(plan.config.authToken).toBe('');
    }
  });
});

describe('(4) proof-carrying ledger rule', () => {
  it('ledgerCapable true IFF the row is bound to the proven user', () => {
    const bound = planReconnectSession({
      bot: botRow({ userId: 'user-1' }),
      provenUserId: 'user-1',
      sessionId: NEW_SID,
    });
    if (!bound.mint) throw new Error('expected mint');
    expect(bound.ledgerCapable).toBe(true);
    expect(bound.config.boundUserId).toBe('user-1');

    const unbound = planReconnectSession({
      bot: botRow({ userId: null }),
      provenUserId: 'user-1',
      sessionId: NEW_SID,
    });
    if (!unbound.mint) throw new Error('expected mint');
    expect(unbound.ledgerCapable).toBe(false);

    const otherOwner = planReconnectSession({
      bot: botRow({ userId: 'user-2' }),
      provenUserId: 'user-1',
      sessionId: NEW_SID,
    });
    if (!otherOwner.mint) throw new Error('expected mint');
    expect(otherOwner.ledgerCapable).toBe(false);
    // boundUserId stays the ROW's owner so resolveAgentSession's rebind
    // backstop sees the truth (and demotes/evicts as designed).
    expect(otherOwner.config.boundUserId).toBe('user-2');
  });
});

describe('(5) refusals — partner rows + unseatable overrides', () => {
  it('a reserved partner identity type (hatcher) is never minted', () => {
    const plan = planReconnectSession({
      bot: botRow({ identityType: 'hatcher', agentId: 'hatcher:partner-owned' }),
      provenUserId: 'user-1',
      sessionId: NEW_SID,
    });
    expect(plan.mint).toBe(false);
    if (plan.mint) throw new Error('unreachable');
    expect(plan.reason).toBe('reserved_partner_type');
  });

  it('an override-mode row without a target NPC cannot be re-seated', () => {
    const plan = planReconnectSession({
      bot: botRow({ mode: 'override', targetNpcId: null }),
      provenUserId: 'user-1',
      sessionId: NEW_SID,
    });
    expect(plan.mint).toBe(false);
    if (plan.mint) throw new Error('unreachable');
    expect(plan.reason).toBe('override_missing_target');
  });
});

describe('(6) old-hash invalidation', () => {
  it('the persisted sessionKeyHash is the NEW bearer hash and differs from the old', () => {
    const plan = planReconnectSession({
      bot: botRow(),
      provenUserId: 'user-1',
      sessionId: NEW_SID,
    });
    if (!plan.mint) throw new Error('expected mint');
    // Writing this hash is the invalidation: lazy restore matches rows by
    // session_key_hash, and validateLiveAgentSession tears down a RAM session
    // whose bearer hash is present-and-mismatched against the row.
    expect(plan.persist.sessionKeyHash).toBe(sha256Hex(NEW_SID));
    expect(plan.persist.sessionKeyHash).not.toBe(sha256Hex(OLD_SID));
    // And the raw bearer itself never appears in the persist payload.
    expect(JSON.stringify(plan.persist)).not.toContain(NEW_SID);
  });
});

// ---------------------------------------------------------------------------
// (7) sim mechanics — the evict→re-register sequence the route runs yields
// EXACTLY ONE deterministic `ocb-` body and kills the old RAM session.
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

// Stub client — nanoclaw wires never POST; the sim only stores the instance.
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

describe('(7) reconnect replaces the body — never duplicates, never leaves the old bearer live', () => {
  it('evict → re-register yields ONE ocb- body owned by the new session; old session is gone', () => {
    const sim = asSim();
    const agentId = 'reconnect-body-agent';
    const bodyId = bodyIdFor(agentId);
    const bot = botRow({ agentId });

    // Original (pre-restart) session, registered the way /connect does — use
    // the DORMANT plan config so no outbound wire is ever armed in tests.
    const oldPlan = planReconnectSession({ bot, provenUserId: 'user-1', sessionId: OLD_SID });
    if (!oldPlan.mint) throw new Error('expected mint');
    npcSimulation.registerAgentBot(oldPlan.config, stubClient(), oldPlan.restoredState);
    expect(npcSimulation.isValidAgentSession(OLD_SID)).toBe(true);
    expect(sim.npcs.has(bodyId)).toBe(true);

    // The route's reconnect sequence: plan → evict stale sessions → register.
    const plan = planReconnectSession({ bot, provenUserId: 'user-1', sessionId: NEW_SID });
    if (!plan.mint) throw new Error('expected mint');
    for (const stale of npcSimulation.findActiveSessionsByAgentIds([agentId])) {
      npcSimulation.unregisterAgentBot(stale);
    }
    npcSimulation.registerAgentBot(plan.config, stubClient(), plan.restoredState);

    // EXACTLY ONE body (the deterministic ocb- id — Map.set replaces), owned
    // by the NEW session; the old bearer is no longer a valid RAM session.
    const bodies = [...sim.npcs.keys()].filter((id) => id === bodyId);
    expect(bodies.length).toBe(1);
    expect(sim.npcOverrides.get(bodyId)).toBe(NEW_SID);
    expect(npcSimulation.isValidAgentSession(NEW_SID)).toBe(true);
    expect(npcSimulation.isValidAgentSession(OLD_SID)).toBe(false);
    // And no second ocb- body for this agent exists under any other id.
    const allOcb = [...sim.npcs.keys()].filter((id) => String(id).startsWith('ocb-'));
    expect(allOcb).toEqual([bodyId]);
  });
});
