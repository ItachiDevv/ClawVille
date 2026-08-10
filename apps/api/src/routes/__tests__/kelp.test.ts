const DATABASE_URL_WAS_SET = !!process.env.DATABASE_URL;
if (!DATABASE_URL_WAS_SET) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMiddleware } from 'hono/factory';
import * as realDatabase from '@clawville/database';
import {
  KELP_REALM_BEACON_GRAPH,
  KELP_REALM_PLAYER_SPEED_WU_PER_SEC,
  KELP_REALM_SPORE_BEACON_IDS,
  KELP_REALM_SPORE_COUNT,
  KELP_REALM_SPORE_FULL_MASK,
  KELP_REALM_SPEED_GRACE_MULTIPLIER,
  KELP_REALM_SPRINT_SPEED_MULTIPLIER,
  KELP_REALM_TOKEN_TTL_MS,
} from '@clawville/shared';
import type {
  ActivityAuthContext,
  ActivityIdentity,
} from '../../middleware/require-auth-or-agent';
import { npcSimulation } from '../../services/npc-simulation';
import type { RewardGrantResult } from '../kelp';

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
  grantKelpCollectibleInTransaction,
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

describe('Kelp Forest authenticated traversal and collectible claim', () => {
  let nowMs = BASE_TIME;
  let alreadyOwned = false;
  let rewardFailure: 'missing' | 'misconfigured' | null;
  let grantCalls: string[];
  let completionIdentities: ActivityIdentity[];
  let rewardConfigurationErrors: Array<{ slug: string; reason: string }>;

  function routes(
    grantReward: (
      avatarId: string,
      nowMs: number,
    ) => Promise<RewardGrantResult> = async (avatarId) => {
      grantCalls.push(avatarId);
      if (rewardFailure) return { ok: false, reason: rewardFailure };
      const result = { ok: true as const, alreadyOwned, skuId: 'collectible-sku' };
      alreadyOwned = true;
      return result;
    },
  ) {
    return createKelpRoutes({
      nowMs: () => nowMs,
      secret: () => SECRET,
      session: testSession,
      noStore: pass,
      grantReward,
      recordCompletion: (_c, identity) => completionIdentities.push(identity),
      logRewardConfigurationError: (details) => rewardConfigurationErrors.push(details),
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
    rewardFailure = null;
    grantCalls = [];
    completionIdentities = [];
    rewardConfigurationErrors = [];
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
      spores: { found: number; total: number };
    };
    expect(verifyKelpBeaconToken(body.token, USER_IDENTITY.avatarId, nowMs, SECRET)).toMatchObject({
      ok: true,
      beaconId: 'entry',
      sporeMask: 0,
    });
    expect(body.spores).toEqual({ found: 0, total: KELP_REALM_SPORE_COUNT });
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
    const [beaconId, issuedAt, sporeMask, signature] = valid.split('.');
    const forged = `${beaconId}.${issuedAt}.${sporeMask}.${signature!.startsWith('A') ? 'B' : 'A'}${signature!.slice(1)}`;
    expect((await post(`/beacon/${targetId}/visit`, { prevToken: forged })).status).toBe(400);
    const forgedMask = `${beaconId}.${issuedAt}.7.${signature}`;
    expect(await (await post(`/beacon/${targetId}/visit`, { prevToken: forgedMask })).json())
      .toMatchObject({ code: 'invalid_token' });

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
      (KELP_REALM_PLAYER_SPEED_WU_PER_SEC *
        KELP_REALM_SPRINT_SPEED_MULTIPLIER *
        KELP_REALM_SPEED_GRACE_MULTIPLIER) * 1000,
    );
    expect(earlyBody).toEqual({ error: 'too_fast', code: 'too_fast', retryAfterMs: floorMs });

    nowMs += floorMs;
    const arrived = await post(`/beacon/${targetId}/visit`, { prevToken: entryToken });
    expect(arrived.status).toBe(200);
    expect(await arrived.json()).toMatchObject({
      adjacent: expect.any(Array),
      spores: { found: 0, total: KELP_REALM_SPORE_COUNT },
    });
  });

  it('carries the signed spore mask and marks a visited spore beacon', async () => {
    const sporeId = KELP_REALM_SPORE_BEACON_IDS[0]!;
    const edge = KELP_REALM_BEACON_GRAPH.edges.find(
      (candidate) => candidate.from === sporeId || candidate.to === sporeId,
    )!;
    const predecessorId = edge.from === sporeId ? edge.to : edge.from;
    const carriedMask = 1 << 1;
    const predecessorToken = issueKelpBeaconToken(
      USER_IDENTITY.avatarId,
      predecessorId,
      nowMs,
      SECRET,
      carriedMask,
    );
    nowMs += Math.ceil(
      edge.distanceWu /
      (KELP_REALM_PLAYER_SPEED_WU_PER_SEC *
        KELP_REALM_SPRINT_SPEED_MULTIPLIER *
        KELP_REALM_SPEED_GRACE_MULTIPLIER) * 1000,
    );

    const response = await post(`/beacon/${sporeId}/visit`, { prevToken: predecessorToken });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      token: string;
      spore: boolean;
      spores: { found: number; total: number };
    };
    expect(body.spore).toBe(true);
    expect(body.spores).toEqual({ found: 2, total: KELP_REALM_SPORE_COUNT });
    expect(verifyKelpBeaconToken(body.token, USER_IDENTITY.avatarId, nowMs, SECRET)).toMatchObject({
      ok: true,
      beaconId: sporeId,
      sporeMask: carriedMask | 1,
    });
  });

  it('shuffles adjacency deterministically per avatar and beacon', async () => {
    const candidates = KELP_REALM_BEACON_GRAPH.nodes.filter((node) =>
      node.kind !== 'entry' && KELP_REALM_BEACON_GRAPH.edges.filter(
        (edge) => edge.from === node.id || edge.to === node.id,
      ).length >= 2,
    );
    nowMs = BASE_TIME + 120_000;
    let foundDifferentOrder = false;

    for (const node of candidates) {
      const edge = KELP_REALM_BEACON_GRAPH.edges.find(
        (candidate) => candidate.from === node.id || candidate.to === node.id,
      )!;
      const predecessorId = edge.from === node.id ? edge.to : edge.from;
      caller = 'human';
      const humanToken = issueKelpBeaconToken(
        USER_IDENTITY.avatarId,
        predecessorId,
        BASE_TIME,
        SECRET,
      );
      const first = await post(`/beacon/${node.id}/visit`, { prevToken: humanToken });
      const second = await post(`/beacon/${node.id}/visit`, { prevToken: humanToken });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstOrder = ((await first.json()) as { adjacent: Array<{ id: string }> })
        .adjacent.map(({ id }) => id);
      const secondOrder = ((await second.json()) as { adjacent: Array<{ id: string }> })
        .adjacent.map(({ id }) => id);
      expect(secondOrder).toEqual(firstOrder);

      caller = 'agent';
      const agentToken = issueKelpBeaconToken(
        AGENT_IDENTITY.avatarId,
        predecessorId,
        BASE_TIME,
        SECRET,
      );
      const agentResponse = await post(`/beacon/${node.id}/visit`, { prevToken: agentToken });
      expect(agentResponse.status).toBe(200);
      const agentOrder = ((await agentResponse.json()) as { adjacent: Array<{ id: string }> })
        .adjacent.map(({ id }) => id);
      if (agentOrder.join('|') !== firstOrder.join('|')) foundDifferentOrder = true;
    }

    expect(foundDifferentOrder).toBe(true);
  });

  it('returns spores_missing without granting when the center mask is incomplete', async () => {
    const centerToken = issueKelpBeaconToken(
      USER_IDENTITY.avatarId,
      'center',
      nowMs,
      SECRET,
      0b101,
    );
    const response = await post('/claim', { centerToken });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'spores_missing', found: 2, total: 3 });
    expect(grantCalls).toEqual([]);
    expect(completionIdentities).toEqual([]);
  });

  it('grants the center reward once and returns idempotent success thereafter', async () => {
    const centerToken = issueKelpBeaconToken(
      USER_IDENTITY.avatarId,
      'center',
      nowMs,
      SECRET,
      KELP_REALM_SPORE_FULL_MASK,
    );
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

  it('concurrent duplicate claims both succeed with one ownership row and one completion', async () => {
    const centerToken = issueKelpBeaconToken(
      USER_IDENTITY.avatarId,
      'center',
      nowMs,
      SECRET,
      KELP_REALM_SPORE_FULL_MASK,
    );
    const avatarSkinRows = new Set<string>();
    let entered = 0;
    let releaseBoth!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const app = routes(async (avatarId) => {
      grantCalls.push(avatarId);
      entered += 1;
      if (entered === 2) releaseBoth();
      await bothEntered;
      const rowKey = `${avatarId}:collectible-sku`;
      const alreadyOwnedByAvatar = avatarSkinRows.has(rowKey);
      avatarSkinRows.add(rowKey);
      return {
        ok: true,
        alreadyOwned: alreadyOwnedByAvatar,
        skuId: 'collectible-sku',
      };
    });
    const claim = () => app.request('/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ centerToken }),
    });

    const responses = await Promise.all([claim(), claim()]);
    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{ ok: boolean; alreadyOwned: boolean }>;
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(
      bodies.sort(
        (left, right) =>
          Number(left.alreadyOwned) - Number(right.alreadyOwned),
      ),
    ).toEqual([
      { ok: true, alreadyOwned: false },
      { ok: true, alreadyOwned: true },
    ]);
    expect(avatarSkinRows.size).toBe(1);
    expect(completionIdentities).toEqual([USER_IDENTITY]);
  });

  it('blocks guests from the reward claim', async () => {
    caller = 'guest';
    const centerToken = issueKelpBeaconToken(
      USER_IDENTITY.avatarId,
      'center',
      nowMs,
      SECRET,
      KELP_REALM_SPORE_FULL_MASK,
    );
    const response = await post('/claim', { centerToken });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'guest_not_allowed' });
    expect(grantCalls).toEqual([]);
  });

  for (const reason of ['missing', 'misconfigured'] as const) {
    it(`returns a logged 500 when the stable collectible SKU is ${reason}`, async () => {
      rewardFailure = reason;
      const centerToken = issueKelpBeaconToken(
        USER_IDENTITY.avatarId,
        'center',
        nowMs,
        SECRET,
        KELP_REALM_SPORE_FULL_MASK,
      );
      const response = await post('/claim', { centerToken });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'collectible_sku_unavailable',
        code: 'collectible_sku_unavailable',
      });
      expect(rewardConfigurationErrors).toEqual([{
        slug: 'kelp-maze-collectible',
        reason,
      }]);
      expect(completionIdentities).toEqual([]);
    });
  }

  it('resolves the named agent-session header to its bound avatar for the identical claim path', async () => {
    caller = 'agent';
    const centerToken = issueKelpBeaconToken(
      AGENT_IDENTITY.avatarId,
      'center',
      nowMs,
      SECRET,
      KELP_REALM_SPORE_FULL_MASK,
    );
    const response = await post('/claim', { centerToken });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, alreadyOwned: false });
    expect(grantCalls).toEqual([AGENT_IDENTITY.avatarId]);
    expect(completionIdentities).toEqual([AGENT_IDENTITY]);
  });

  it('fails closed for an agent session without ledger capability', async () => {
    caller = 'agent';
    simulation.agentBotSessions.get(AGENT_IDENTITY.sessionId)!.config.ledgerCapable = false;
    const centerToken = issueKelpBeaconToken(
      AGENT_IDENTITY.avatarId,
      'center',
      nowMs,
      SECRET,
      KELP_REALM_SPORE_FULL_MASK,
    );
    const response = await post('/claim', { centerToken });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('agent_session_not_ledger_authorized');
    expect(grantCalls).toEqual([]);
  });

  it('looks up the stable slug at claim time without category hard-binding', async () => {
    const values: Array<Record<string, unknown>> = [];
    const conflictTargets: unknown[] = [];
    let insertAttempt = 0;
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{
              id: 'collectible-sku',
              category: 'hat',
              exclusiveCurrency: 'REWARD_ONLY',
              supplyCap: null,
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

    const first = await grantKelpCollectibleInTransaction(tx as never, USER_IDENTITY.avatarId, nowMs);
    const second = await grantKelpCollectibleInTransaction(tx as never, USER_IDENTITY.avatarId, nowMs);
    expect(first).toEqual({ ok: true, alreadyOwned: false, skuId: 'collectible-sku' });
    expect(second).toEqual({ ok: true, alreadyOwned: true, skuId: 'collectible-sku' });
    expect(values).toEqual([
      expect.objectContaining({
        avatarId: USER_IDENTITY.avatarId,
        skuId: 'collectible-sku',
        acquiredVia: 'reward',
        ledgerId: null,
        equipped: true,
      }),
      expect.objectContaining({
        avatarId: USER_IDENTITY.avatarId,
        skuId: 'collectible-sku',
        acquiredVia: 'reward',
        ledgerId: null,
        equipped: true,
      }),
    ]);
    expect(conflictTargets).toHaveLength(2);
  });

  it('fails closed before insert when the stable claim-time slug is missing', async () => {
    let insertCalled = false;
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
      insert: () => {
        insertCalled = true;
        throw new Error('insert must not run without the stable SKU row');
      },
    };

    expect(await grantKelpCollectibleInTransaction(
      tx as never,
      USER_IDENTITY.avatarId,
      nowMs,
    )).toEqual({ ok: false, reason: 'missing' });
    expect(insertCalled).toBe(false);
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
