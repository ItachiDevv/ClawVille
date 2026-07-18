const DATABASE_URL_WAS_SET = !!process.env.DATABASE_URL;
if (!DATABASE_URL_WAS_SET) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMiddleware } from 'hono/factory';
import * as realDatabase from '@clawville/database';
import {
  KELP_REALM_BEACON_GRAPH,
  KELP_REALM_PLAYER_SPEED_WU_PER_SEC,
  KELP_REALM_SPEED_GRACE_MULTIPLIER,
  KELP_REALM_TOKEN_TTL_MS,
} from '@clawville/shared';
import type {
  ActivityAuthContext,
  ActivityIdentity,
} from '../../middleware/require-auth-or-agent';
import { npcSimulation } from '../../services/npc-simulation';

const SECRET = 'kelp-route-test-secret';
const BASE_TIME = 2_000_000_000_000;
const USER_IDENTITY = {
  kind: 'user',
  userId: 'user-1',
  avatarId: 'avatar-human',
  agentId: null,
} satisfies ActivityIdentity;
const AGENT_IDENTITY = {
  kind: 'agent',
  userId: 'user-2',
  avatarId: 'avatar-agent',
  agentId: 'agent-1',
  sessionId: 'session-1',
  ledgerCapable: true,
} satisfies ActivityIdentity;

let interceptDatabase = true;
let caller: 'human' | 'guest' | 'agent' = 'human';
const delegateDb = (realDatabase as unknown as { db: Record<string, unknown> }).db;
const fakeDb = {
  ...delegateDb,
  query: {
    ...((delegateDb.query ?? {}) as Record<string, unknown>),
    agentBots: {
      findFirst: async () => ({
        agentId: AGENT_IDENTITY.agentId,
        userId: AGENT_IDENTITY.userId,
        sessionExpiresAt: new Date(BASE_TIME + 60_000),
      }),
    },
    avatars: {
      findFirst: async () => ({
        id: caller === 'agent' ? AGENT_IDENTITY.avatarId : USER_IDENTITY.avatarId,
      }),
    },
    users: { findFirst: async () => ({ isGuest: caller === 'guest' }) },
  },
};
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: new Proxy(fakeDb, {
    get: (target, property, receiver) => interceptDatabase
      ? Reflect.get(target, property, receiver)
      : Reflect.get(delegateDb, property, delegateDb),
  }),
}));

const {
  createKelpRoutes,
  grantPearlRewardInTransaction,
  issueKelpBeaconToken,
  verifyKelpBeaconToken,
} = await import('../kelp');
if (!DATABASE_URL_WAS_SET) delete process.env.DATABASE_URL;

const pass = createMiddleware<ActivityAuthContext>(async (_c, next) => next());
const testSession = createMiddleware<ActivityAuthContext>(async (c, next) => {
  c.set('user', caller === 'agent'
    ? null
    : ({ id: caller === 'guest' ? 'guest-user' : USER_IDENTITY.userId } as never));
  c.set('session', null);
  c.set('fpHash', 'kelp-test-fp');
  c.set('ipPrefixHash', 'kelp-test-ip');
  return next();
});

interface SimulationInternals {
  agentBotSessions: Map<string, {
    config: {
      agentId: string;
      mode: 'avatar';
      avatarId: string;
      boundUserId: string;
      ledgerCapable: boolean;
    };
    client: { getProtocol: () => string };
  }>;
}
const simulation = npcSimulation as unknown as SimulationInternals;

afterAll(() => {
  interceptDatabase = false;
  simulation.agentBotSessions.delete(AGENT_IDENTITY.sessionId);
});

describe('Kelp Forest authenticated traversal and Pearl claim', () => {
  let nowMs = BASE_TIME;
  let alreadyOwned = false;
  let grantCalls: string[];
  let completionIdentities: ActivityIdentity[];

  function routes() {
    return createKelpRoutes({
      nowMs: () => nowMs,
      secret: () => SECRET,
      session: testSession,
      noStore: pass,
      grantReward: async (avatarId) => {
        grantCalls.push(avatarId);
        const result = { alreadyOwned };
        alreadyOwned = true;
        return result;
      },
      recordCompletion: (_c, identity) => completionIdentities.push(identity),
    });
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const requestHeaders: Record<string, string> = { 'content-type': 'application/json', ...headers };
    if (caller === 'agent') {
      requestHeaders['X-Clawville-Agent-Session'] = AGENT_IDENTITY.sessionId;
    }
    return routes().request(path, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    nowMs = BASE_TIME;
    caller = 'human';
    alreadyOwned = false;
    grantCalls = [];
    completionIdentities = [];
    simulation.agentBotSessions.set(AGENT_IDENTITY.sessionId, {
      config: {
        agentId: AGENT_IDENTITY.agentId,
        mode: 'avatar',
        avatarId: AGENT_IDENTITY.avatarId,
        boundUserId: AGENT_IDENTITY.userId,
        ledgerCapable: true,
      },
      client: { getProtocol: () => 'hatcher-proxy' },
    });
  });

  it('starts only at entry and reveals adjacent descriptors without hidden graph paths', async () => {
    const response = await post('/beacon/entry/visit', {});
    expect(response.status).toBe(200);
    const body = await response.json() as {
      token: string;
      adjacent: Array<Record<string, unknown>>;
    };
    expect(verifyKelpBeaconToken(body.token, USER_IDENTITY.avatarId, nowMs, SECRET)).toMatchObject({
      ok: true,
      beaconId: 'entry',
    });
    expect(body.adjacent.length).toBeGreaterThan(0);
    expect(Object.keys(body.adjacent[0]!).sort()).toEqual([
      'bearingDeg',
      'distanceWu',
      'id',
      'kind',
    ]);
    expect(JSON.stringify(body)).not.toContain('path');
  });

  it('rejects a missing predecessor and a non-adjacent predecessor', async () => {
    const target = KELP_REALM_BEACON_GRAPH.nodes.find((node) => node.kind !== 'entry')!;
    const missing = await post(`/beacon/${target.id}/visit`, {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: 'prev_token_required' });

    const nonAdjacent = KELP_REALM_BEACON_GRAPH.nodes.find((node) =>
      node.kind !== 'entry' && !KELP_REALM_BEACON_GRAPH.edges.some((edge) =>
        (edge.from === 'entry' && edge.to === node.id) ||
        (edge.to === 'entry' && edge.from === node.id),
      ),
    )!;
    const entryToken = issueKelpBeaconToken(USER_IDENTITY.avatarId, 'entry', nowMs, SECRET);
    const response = await post(`/beacon/${nonAdjacent.id}/visit`, { prevToken: entryToken });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'non_adjacent_beacon' });
  });

  it('rejects forged, cross-avatar, and expired predecessor tokens', async () => {
    const edge = KELP_REALM_BEACON_GRAPH.edges.find((candidate) =>
      candidate.from === 'entry' || candidate.to === 'entry',
    )!;
    const targetId = edge.from === 'entry' ? edge.to : edge.from;
    const valid = issueKelpBeaconToken(USER_IDENTITY.avatarId, 'entry', nowMs, SECRET);
    const [beaconId, issuedAt, signature] = valid.split('.');
    const forged = `${beaconId}.${issuedAt}.${signature!.startsWith('A') ? 'B' : 'A'}${signature!.slice(1)}`;
    expect((await post(`/beacon/${targetId}/visit`, { prevToken: forged })).status).toBe(400);

    const otherAvatar = issueKelpBeaconToken('different-avatar', 'entry', nowMs, SECRET);
    expect(await (await post(`/beacon/${targetId}/visit`, { prevToken: otherAvatar })).json())
      .toMatchObject({ code: 'invalid_token' });

    const expired = issueKelpBeaconToken(
      USER_IDENTITY.avatarId,
      'entry',
      nowMs - KELP_REALM_TOKEN_TTL_MS,
      SECRET,
    );
    expect(await (await post(`/beacon/${targetId}/visit`, { prevToken: expired })).json())
      .toMatchObject({ code: 'expired_token' });
  });

  it('enforces the shared physical time floor, then permits the adjacent visit', async () => {
    const edge = KELP_REALM_BEACON_GRAPH.edges.find((candidate) =>
      candidate.from === 'entry' || candidate.to === 'entry',
    )!;
    const targetId = edge.from === 'entry' ? edge.to : edge.from;
    const entryToken = issueKelpBeaconToken(USER_IDENTITY.avatarId, 'entry', nowMs, SECRET);
    const early = await post(`/beacon/${targetId}/visit`, { prevToken: entryToken });
    expect(early.status).toBe(429);
    const earlyBody = await early.json() as { error: string; code: string; retryAfterMs: number };
    const floorMs = Math.ceil(
      edge.distanceWu /
      (KELP_REALM_PLAYER_SPEED_WU_PER_SEC * KELP_REALM_SPEED_GRACE_MULTIPLIER) * 1000,
    );
    expect(earlyBody).toEqual({ error: 'too_fast', code: 'too_fast', retryAfterMs: floorMs });

    nowMs += floorMs;
    const arrived = await post(`/beacon/${targetId}/visit`, { prevToken: entryToken });
    expect(arrived.status).toBe(200);
    expect(await arrived.json()).toMatchObject({ adjacent: expect.any(Array) });
  });

  it('grants the center reward once and returns idempotent success thereafter', async () => {
    const centerToken = issueKelpBeaconToken(USER_IDENTITY.avatarId, 'center', nowMs, SECRET);
    const first = await post('/claim', { centerToken });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, alreadyOwned: false });
    expect(completionIdentities).toEqual([USER_IDENTITY]);

    const second = await post('/claim', { centerToken });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, alreadyOwned: true });
    expect(grantCalls).toEqual([USER_IDENTITY.avatarId, USER_IDENTITY.avatarId]);
    expect(completionIdentities).toEqual([USER_IDENTITY]);
  });

  it('blocks guests from the reward claim', async () => {
    caller = 'guest';
    const centerToken = issueKelpBeaconToken(USER_IDENTITY.avatarId, 'center', nowMs, SECRET);
    const response = await post('/claim', { centerToken });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'guest_not_allowed' });
    expect(grantCalls).toEqual([]);
  });

  it('resolves the named agent-session header to its bound avatar for the identical claim path', async () => {
    caller = 'agent';
    const centerToken = issueKelpBeaconToken(AGENT_IDENTITY.avatarId, 'center', nowMs, SECRET);
    const response = await post('/claim', { centerToken });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, alreadyOwned: false });
    expect(grantCalls).toEqual([AGENT_IDENTITY.avatarId]);
    expect(completionIdentities).toEqual([AGENT_IDENTITY]);
  });

  it('fails closed for an agent session without ledger capability', async () => {
    caller = 'agent';
    simulation.agentBotSessions.get(AGENT_IDENTITY.sessionId)!.config.ledgerCapable = false;
    const centerToken = issueKelpBeaconToken(AGENT_IDENTITY.avatarId, 'center', nowMs, SECRET);
    const response = await post('/claim', { centerToken });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('agent_session_not_ledger_authorized');
    expect(grantCalls).toEqual([]);
  });

  it('executes the production reward transaction with idempotent provenance and equip state', async () => {
    const values: Array<Record<string, unknown>> = [];
    const conflictTargets: unknown[] = [];
    let insertAttempt = 0;
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{
              id: 'pearl-sku',
              category: 'aura',
              exclusiveCurrency: 'REWARD_ONLY',
            }],
          }),
        }),
      }),
      insert: () => ({
        values: (input: Record<string, unknown>) => {
          values.push(input);
          return {
            onConflictDoNothing: (options: { target: unknown }) => {
              conflictTargets.push(options.target);
              return {
                returning: async () => insertAttempt++ === 0 ? [{ id: 'skin-1' }] : [],
              };
            },
          };
        },
      }),
    };

    const first = await grantPearlRewardInTransaction(tx as never, USER_IDENTITY.avatarId, nowMs);
    const second = await grantPearlRewardInTransaction(tx as never, USER_IDENTITY.avatarId, nowMs);
    expect(first).toEqual({ alreadyOwned: false });
    expect(second).toEqual({ alreadyOwned: true });
    expect(values).toEqual([
      expect.objectContaining({
        avatarId: USER_IDENTITY.avatarId,
        skuId: 'pearl-sku',
        acquiredVia: 'reward',
        ledgerId: null,
        equipped: true,
      }),
      expect.objectContaining({
        avatarId: USER_IDENTITY.avatarId,
        skuId: 'pearl-sku',
        acquiredVia: 'reward',
        ledgerId: null,
        equipped: true,
      }),
    ]);
    expect(conflictTargets).toHaveLength(2);
  });

  it('keeps the reward-only sentinel out of the public cosmetics catalog query', async () => {
    const cosmeticsSource = await Bun.file(new URL('../cosmetics.ts', import.meta.url)).text();
    const catalogStart = cosmeticsSource.indexOf("cosmeticsRoutes.get('/catalog'");
    const catalogEnd = cosmeticsSource.indexOf('cosmeticsRoutes.get(', catalogStart + 1);
    const catalogHandler = cosmeticsSource.slice(catalogStart, catalogEnd);
    expect(catalogHandler).toContain('REWARD_ONLY_COSMETIC_CURRENCY');
    expect(catalogHandler).toContain('ne(cosmeticSkus.exclusiveCurrency');
  });
});
