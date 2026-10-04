/**
 * Bounty list endpoints carry bonus rewards (2026-10-02).
 *
 * A bounty posted with a bonus row (e.g. a knowledge book) stores it in
 * bounty_rewards. GET /api/bounties/:id already returned it, but the LIST
 * endpoints (GET /, /featured, /my-bounties) did not, so the Bounty Board
 * Browse card never showed the bonus. Each list item now carries
 * `bonusRewards`, loaded with ONE batched query per request
 * (WHERE bounty_id IN the page's ids), never one query per bounty.
 *
 * PARITY: agents read the same endpoints with X-Clawville-Agent-Session. Every
 * request below carries one, and my-bounties resolves it through the REAL
 * requireAuthOrAgentSession middleware (live npcSimulation session, faked rows).
 * No middleware is mocked: bounties.ts binds its middleware at route
 * registration, so a module mock cannot reach it when another test file loaded
 * bounties.ts first.
 */

const HEX32 = '0'.repeat(64);
if (!process.env.FINGERPRINT_SECRET) process.env.FINGERPRINT_SECRET = HEX32;
const databaseUrlWasSet = !!process.env.DATABASE_URL;
if (!databaseUrlWasSet) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import * as realDatabase from '@clawville/database';
import { KNOWLEDGE_BOOKS } from '@clawville/shared';
import { AGENT_SESSION_HEADER } from '../../middleware/require-auth-or-agent';
import { npcSimulation } from '../../services/npc-simulation';

let intercept = true;
afterAll(() => {
  intercept = false;
  simulation.agentBotSessions.delete(agentIdentity.sessionId);
});

const { bounties, bountyRewards, bountyAttempts } = realDatabase;
const BOOK_ID = KNOWLEDGE_BOOKS[0]!.id;
const CREATOR = 'avatar-agent';
const BOUNTY_WITH_BOOK = '11111111-1111-4111-8111-111111111111';
const BOUNTY_PLAIN = '22222222-2222-4222-8222-222222222222';
const BOUNTY_TWO_BONUSES = '33333333-3333-4333-8333-333333333333';
const BOUNTY_OFF_PAGE = '44444444-4444-4444-8444-444444444444';
const PAGE_IDS = [BOUNTY_WITH_BOOK, BOUNTY_PLAIN, BOUNTY_TWO_BONUSES];

const agentIdentity = {
  userId: 'user-agent-owner',
  avatarId: CREATOR,
  agentId: 'agent-bounty-list-1',
  sessionId: 'session-bounty-list-1',
};

interface SimulationInternals {
  agentBotSessions: Map<string, {
    config: { agentId: string; mode: 'avatar'; avatarId: string; boundUserId: string; ledgerCapable: boolean };
    client: { getProtocol: () => string };
  }>;
}
const simulation = npcSimulation as unknown as SimulationInternals;

const created = new Date('2026-10-02T12:00:00.000Z');
function listRow(id: string) {
  return {
    id,
    creatorId: CREATOR,
    title: `Bounty ${id.slice(0, 4)}`,
    description: 'A bounty used by the list bonus test.',
    difficulty: 'beginner',
    status: 'open',
    tokenReward: 10,
    paymentRail: 'vclaw',
    maxAttempts: 5,
    currentAttempts: 0,
    isFeatured: true,
    tags: [],
    expiresAt: null,
    createdAt: created,
    creatorAvatarName: 'Agent Avatar',
    creatorSpecies: 'lobster',
  };
}
function fullRow(id: string) {
  return {
    id,
    creatorId: CREATOR,
    title: `Bounty ${id.slice(0, 4)}`,
    description: 'A bounty used by the list bonus test.',
    requirements: null,
    difficulty: 'beginner',
    status: 'open',
    tokenReward: 10,
    paymentRail: 'vclaw',
    acceptanceCriteria: null,
    maxAttempts: 5,
    currentAttempts: 0,
    isFeatured: false,
    tags: [],
    expiresAt: null,
    completedAt: null,
    createdAt: created,
    updatedAt: created,
  };
}

const rewardRows = [
  { bountyId: BOUNTY_WITH_BOOK, rewardType: 'knowledge_book', bookId: BOOK_ID, agentConfigId: null, customDescription: null },
  { bountyId: BOUNTY_TWO_BONUSES, rewardType: 'knowledge_book', bookId: BOOK_ID, agentConfigId: null, customDescription: null },
  { bountyId: BOUNTY_TWO_BONUSES, rewardType: 'custom', bookId: null, agentConfigId: null, customDescription: 'Shout-out: on the town board' },
  { bountyId: BOUNTY_OFF_PAGE, rewardType: 'custom', bookId: null, agentConfigId: null, customDescription: 'Not on this page' },
];

const dialect = new PgDialect();
let pageIds: string[] = PAGE_IDS;
let rewardQueries: Array<{ sql: string; params: unknown[] }> = [];

function resultFor(state: { selection: Record<string, unknown> | undefined; table: unknown; where: unknown }) {
  if (state.table === bountyRewards) {
    const rendered = dialect.sqlToQuery(state.where as SQL);
    rewardQueries.push({ sql: rendered.sql, params: rendered.params });
    const ids = new Set(rendered.params as string[]);
    return rewardRows.filter((r) => ids.has(r.bountyId));
  }
  if (state.table === bounties) {
    const keys = Object.keys(state.selection ?? {});
    if (keys.includes('total')) return [{ total: pageIds.length }];
    if (keys.includes('creatorAvatarName')) return pageIds.map(listRow);
    if (keys.length === 0) return pageIds.map(fullRow);
    return []; // statusCounts / nextBefore cursor
  }
  if (state.table === bountyAttempts) return [];
  throw new Error('unexpected table in bounty list test');
}

function selectChain(selection?: Record<string, unknown>) {
  const state = { selection, table: undefined as unknown, where: undefined as unknown };
  const builder: Record<string, unknown> = {
    from: (table: unknown) => ((state.table = table), builder),
    innerJoin: () => builder,
    where: (where: unknown) => ((state.where = where), builder),
    orderBy: () => builder,
    limit: () => builder,
    offset: () => builder,
    groupBy: () => builder,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(resultFor(state)).then(resolve, reject);
      } catch (err) {
        return Promise.reject(err).then(resolve, reject);
      }
    },
  };
  return builder;
}

const DELEGATE_DB = (realDatabase as unknown as { db: Record<string, unknown> }).db;
const fakeDb = {
  ...DELEGATE_DB,
  select: (selection?: Record<string, unknown>) => selectChain(selection),
  query: {
    ...(DELEGATE_DB.query as Record<string, unknown>),
    agentBots: {
      findFirst: async () => ({
        agentId: agentIdentity.agentId,
        userId: agentIdentity.userId,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        sessionKeyHash: null,
      }),
    },
    users: { findFirst: async () => ({ isGuest: false }) },
    avatars: { findFirst: async () => ({ id: CREATOR, userId: agentIdentity.userId, isActive: true, clawTokens: 0 }) },
  },
};
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: new Proxy(fakeDb, {
    get: (t, p, r) => (intercept ? Reflect.get(t, p, r) : Reflect.get(DELEGATE_DB, p, DELEGATE_DB)),
  }),
}));

const { bountyRoutes } = await import('../bounties');
if (!databaseUrlWasSet) delete process.env.DATABASE_URL;

const routes = new Hono().route('/api/bounties', bountyRoutes);
const app = {
  request: (path: string) =>
    routes.request(path, { headers: { [AGENT_SESSION_HEADER]: agentIdentity.sessionId } }),
};

type BonusItem = { rewardType: string; bookId: string | null; agentConfigId: string | null; customDescription: string | null };
type ListBody = { bounties: Array<{ id: string; bonusRewards: BonusItem[] }> };

const EXPECTED: Record<string, BonusItem[]> = {
  [BOUNTY_WITH_BOOK]: [
    { rewardType: 'knowledge_book', bookId: BOOK_ID, agentConfigId: null, customDescription: null },
  ],
  [BOUNTY_PLAIN]: [],
  [BOUNTY_TWO_BONUSES]: [
    { rewardType: 'knowledge_book', bookId: BOOK_ID, agentConfigId: null, customDescription: null },
    { rewardType: 'custom', bookId: null, agentConfigId: null, customDescription: 'Shout-out: on the town board' },
  ],
};

function expectBonuses(body: ListBody) {
  expect(body.bounties.map((b) => b.id)).toEqual(PAGE_IDS);
  for (const b of body.bounties) {
    expect(b.bonusRewards).toEqual(EXPECTED[b.id]!);
  }
}

function expectOneBatchedRewardQuery() {
  expect(rewardQueries).toHaveLength(1);
  expect(rewardQueries[0]!.sql).toContain('"bounty_rewards"."bounty_id" in (');
  expect(rewardQueries[0]!.params).toEqual(PAGE_IDS);
}

beforeEach(() => {
  pageIds = PAGE_IDS;
  rewardQueries = [];
  simulation.agentBotSessions.set(agentIdentity.sessionId, {
    config: {
      agentId: agentIdentity.agentId,
      mode: 'avatar',
      avatarId: agentIdentity.avatarId,
      boundUserId: agentIdentity.userId,
      ledgerCapable: true,
    },
    client: { getProtocol: () => 'hatcher-proxy' },
  });
});

describe('bounty list endpoints return bonusRewards (one batched query)', () => {
  it('GET /api/bounties: book bonus on its card, [] without a bonus', async () => {
    const res = await app.request('/api/bounties');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody & { total: number; page: number; pageSize: number };
    expectBonuses(body);
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 20 });
    expectOneBatchedRewardQuery();
  });

  it('GET /api/bounties/featured', async () => {
    const res = await app.request('/api/bounties/featured');
    expect(res.status).toBe(200);
    expectBonuses((await res.json()) as ListBody);
    expectOneBatchedRewardQuery();
  });

  it('GET /api/bounties/my-bounties as an agent session', async () => {
    const res = await app.request('/api/bounties/my-bounties');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody & { statusCounts: Record<string, number>; nextBefore: string | null };
    expectBonuses(body);
    expect(body.statusCounts).toEqual({});
    expect(body.nextBefore).toBeNull();
    expectOneBatchedRewardQuery();
  });

  it('an empty page runs no bonus query', async () => {
    pageIds = [];
    for (const path of ['/api/bounties', '/api/bounties/featured', '/api/bounties/my-bounties']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(((await res.json()) as ListBody).bounties).toEqual([]);
    }
    expect(rewardQueries).toHaveLength(0);
  });
});
