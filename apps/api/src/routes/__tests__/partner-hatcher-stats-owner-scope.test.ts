/**
 * Hatcher stats `recentInteractions` owner-period scope (security pass
 * 2026-10-04, founder rule protocol 83: agent event history shows only events
 * recorded for the CURRENT owner during its ownership period).
 *
 * Drives the REAL partner-signed `GET /api/partner/hatcher/agents/:agentId/stats`
 * handler via `app.request` with a genuine ed25519 GET signature. Mocks ONLY
 * `@clawville/database` `db` (no Postgres). The events read is the shared
 * `buildOwnerScopedRecentAgentEventsQuery` (services/agent-event-query.ts); the
 * stub renders its WHERE clause with the real PgDialect, asserts it is the owner
 * scope, and answers it from an in-memory events table with the same semantics
 * (agent_id, openclaw_bots.user_id = proven owner, ts >= owner_since,
 * events.user_id = owner). The same SQL runs on real PostgreSQL in
 * `services/__tests__/agent-owner-since.db.test.ts`.
 *
 * Pinned here:
 *   - prior-owner events are hidden and current-owner events are shown;
 *   - a row with NO owner returns `recentInteractions: []` and issues no read;
 *   - the 60s stats cache never serves a body built for another ownership period;
 *   - the response shape is unchanged (top-level keys + item keys + payload scrub).
 *
 * Run in its own process (`mock.module` is process-global).
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Env (crash-loud module-load requirements) + partner keypair, BEFORE imports.
// ---------------------------------------------------------------------------
const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
ensureEnv('FINGERPRINT_SECRET', HEX32);
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);

const partnerKp = nacl.sign.keyPair();
const partnerPubB58 = bs58.encode(partnerKp.publicKey);
const PRIOR_PARTNER_PUBKEYS = process.env.PARTNER_PUBKEYS;
process.env.PARTNER_PUBKEYS = JSON.stringify({ hatcher: partnerPubB58 });
const issuerKp = nacl.sign.keyPair();
ensureEnv('CLAWVILLE_SERVICE_ISSUER_SK', bs58.encode(issuerKp.secretKey));
ensureEnv('CLAWVILLE_SERVICE_ISSUER_PUBKEY', bs58.encode(issuerKp.publicKey));

// ---------------------------------------------------------------------------
// In-memory state: openclaw_bots rows + events rows.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

interface BotRow {
  id: string;
  agentId: string;
  identityType: string;
  mode: string;
  name: string | null;
  species: string | null;
  cognitionBackend: string | null;
  knowledge: string[];
  userId: string | null;
  ownerSince: Date;
  totalSessions: number;
  lastSeenAt: Date | null;
  sessionExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface EventRow {
  agentId: string;
  userId: string | null;
  eventType: string;
  ts: Date;
  buildingId: string | null;
  payload: Record<string, unknown> | null;
}

const bots = new Map<string, BotRow>();
const eventRows: EventRow[] = [];
/** Every scoped events read: rendered WHERE sql + params + limit. */
const eventReads: Array<{ sql: string; params: unknown[]; limit: number }> = [];

const realDb = await import('@clawville/database');
const dialect = new PgDialect();

const EXPECTED_SCOPE_WHERE =
  '("events"."agent_id" = $1 and "openclaw_bots"."user_id" = $2 and "events"."ts" >= "openclaw_bots"."owner_since" and "events"."user_id" = "openclaw_bots"."user_id")';

/** Answers the owner-scoped read with the semantics its WHERE clause states. */
function answerScopedRead(params: unknown[], limit: number): Row[] {
  const [agentId, ownerUserId] = params as [string, string];
  const bot = bots.get(agentId);
  if (!bot || bot.userId !== ownerUserId) return [];
  return eventRows
    .filter((e) => e.agentId === agentId && e.ts.getTime() >= bot.ownerSince.getTime() && e.userId === bot.userId)
    .sort((a, b) => b.ts.getTime() - a.ts.getTime())
    .slice(0, limit)
    .map((e) => ({ eventType: e.eventType, ts: e.ts, buildingId: e.buildingId, payload: e.payload }));
}

function selectBuilder() {
  let fromTable: unknown = null;
  let joinedBots = false;
  let whereCond: unknown = null;
  const b = {
    from(table: unknown) { fromTable = table; return b; },
    innerJoin(table: unknown) { joinedBots = table === realDb.agentBots; return b; },
    where(cond: unknown) { whereCond = cond; return b; },
    orderBy() { return b; },
    limit: async (n: number) => {
      if (fromTable === realDb.events && joinedBots) {
        const q = dialect.sqlToQuery(whereCond as Parameters<PgDialect['sqlToQuery']>[0]);
        eventReads.push({ sql: q.sql, params: q.params, limit: n });
        return answerScopedRead(q.params, n);
      }
      if (fromTable === realDb.events) {
        throw new Error('unscoped events read reached the stub');
      }
      return [{ n: 0 }];
    },
    // Quest counts: `await select().from().where()` (no .limit()).
    then: (resolve: (v: unknown) => void) => resolve([{ n: 0 }]),
  };
  return b;
}

const dbStub = {
  select: () => selectBuilder(),
  // Leaderboard snapshot aggregate: an empty board (score 0, rank null).
  execute: async () => [],
  query: {
    agentBots: {
      findFirst: async () => {
        // The handler reads exactly one row per request: the current target.
        const bot = currentTarget ? bots.get(currentTarget) : undefined;
        return bot ? { ...bot } : undefined;
      },
    },
    avatars: { findFirst: async () => null },
  },
};
let currentTarget: string | null = null;

let suiteActive = true;
const DELEGATE_DB = (realDb as unknown as { db: Record<string, unknown> }).db;
mock.module('@clawville/database', () => ({
  ...realDb,
  db: new Proxy(dbStub, {
    get: (t, p, r) => (suiteActive ? Reflect.get(t, p, r) : Reflect.get(DELEGATE_DB, p, DELEGATE_DB)),
  }),
}));
if (!DB_URL_WAS_SET) delete process.env.DATABASE_URL;

afterAll(() => {
  suiteActive = false;
  if (PRIOR_PARTNER_PUBKEYS === undefined) delete process.env.PARTNER_PUBKEYS;
  else process.env.PARTNER_PUBKEYS = PRIOR_PARTNER_PUBKEYS;
});

// --- signed GET helper ------------------------------------------------------
function signedGetHeaders(path: string): Record<string, string> {
  const ts = String(Date.now());
  const challenge = `clawville-partner-get\nGET\n${path}\n${ts}`;
  const digest = createHash('sha256').update(challenge).digest();
  return {
    'X-Hatcher-Issuer-Pubkey': partnerPubB58,
    'X-Hatcher-Signature': bs58.encode(nacl.sign.detached(new Uint8Array(digest), partnerKp.secretKey)),
    'X-Hatcher-Timestamp': ts,
  };
}

const PRIOR = '91111111-1111-4111-8111-111111111111';
const NEXT = '92222222-2222-4222-8222-222222222222';

function seedBot(rawId: string, userId: string | null, ownerSince: Date): string {
  const agentId = `hatcher:${rawId}`;
  bots.set(agentId, {
    id: `uuid-${rawId}`,
    agentId,
    identityType: 'hatcher',
    mode: 'avatar',
    name: rawId,
    species: 'hatcher_1',
    cognitionBackend: 'hatcher-proxy',
    knowledge: [],
    userId,
    ownerSince,
    totalSessions: 1,
    lastSeenAt: null,
    sessionExpiresAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  });
  return agentId;
}

function seedEvent(agentId: string, userId: string | null, eventType: string, iso: string, payload: Record<string, unknown>) {
  eventRows.push({ agentId, userId, eventType, ts: new Date(iso), buildingId: null, payload });
}

describe('Hatcher stats recentInteractions: current owner period only', () => {
  let app: Hono;

  beforeAll(async () => {
    const ph = await import('../partner-hatcher');
    app = new Hono();
    app.route('/api/partner/hatcher', ph.partnerHatcherRoutes);
  });

  async function getStats(rawId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    currentTarget = `hatcher:${rawId}`;
    const path = `/api/partner/hatcher/agents/${rawId}/stats`;
    const res = await app.request(path, { method: 'GET', headers: signedGetHeaders(path) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('hides the prior owner events and shows the current owner events, through the shared owner scope', async () => {
    const agentId = seedBot('owner-move', NEXT, new Date('2026-10-04T10:00:00Z'));
    // Prior owner's period.
    seedEvent(agentId, PRIOR, 'agent.directive.set', '2026-10-04T09:00:00Z', { directive: 'prior owner directive' });
    seedEvent(agentId, PRIOR, 'agent.connected', '2026-10-04T09:10:00Z', { via: 'prior-register' });
    // Late prior-owner row and a NULL-attributed row inside the new period.
    seedEvent(agentId, PRIOR, 'agent.directive.set', '2026-10-04T10:05:00Z', { directive: 'late prior directive' });
    seedEvent(agentId, null, 'agent.connected', '2026-10-04T10:06:00Z', { via: 'null-attributed' });
    // Current owner's period.
    seedEvent(agentId, NEXT, 'agent.connected', '2026-10-04T10:10:00Z', { via: 'partner-register' });
    seedEvent(agentId, NEXT, 'agent.directive.set', '2026-10-04T10:20:00Z', { directive: 'current owner directive' });

    const before = eventReads.length;
    const { status, body } = await getStats('owner-move');
    expect(status).toBe(200);
    expect(eventReads.length).toBe(before + 1);
    const read = eventReads[eventReads.length - 1]!;
    expect(read.sql).toBe(EXPECTED_SCOPE_WHERE);
    expect(read.params).toEqual([agentId, NEXT]);
    expect(read.limit).toBe(20);

    const recent = body.recentInteractions as Array<Record<string, unknown>>;
    expect(recent).toEqual([
      { type: 'agent.directive.set', ts: '2026-10-04T10:20:00.000Z', buildingId: null, payload: { directive: 'current owner directive' } },
      { type: 'agent.connected', ts: '2026-10-04T10:10:00.000Z', buildingId: null, payload: { via: 'partner-register' } },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('prior owner directive');
    expect(text).not.toContain('late prior directive');
    expect(text).not.toContain('null-attributed');
    expect(text).not.toContain('prior-register');
  });

  it('a row with NO owner returns recentInteractions [] and issues no events read', async () => {
    const agentId = seedBot('unowned', null, new Date('2026-10-04T10:00:00Z'));
    seedEvent(agentId, PRIOR, 'agent.directive.set', '2026-10-04T10:30:00Z', { directive: 'former owner directive' });
    seedEvent(agentId, null, 'agent.connected', '2026-10-04T10:31:00Z', { via: 'unattributed' });

    const before = eventReads.length;
    const { status, body } = await getStats('unowned');
    expect(status).toBe(200);
    expect(body.recentInteractions).toEqual([]);
    expect(eventReads.length).toBe(before);
  });

  it('the 60s cache never serves a body built for another ownership period', async () => {
    const agentId = seedBot('cache-move', PRIOR, new Date('2026-10-04T08:00:00Z'));
    seedEvent(agentId, PRIOR, 'agent.directive.set', '2026-10-04T08:30:00Z', { directive: 'cached prior directive' });

    const first = await getStats('cache-move');
    expect((first.body.recentInteractions as unknown[]).length).toBe(1);
    expect(JSON.stringify(first.body)).toContain('cached prior directive');

    // Same owner + same owner_since within the TTL: the cache still serves.
    const reads = eventReads.length;
    const hit = await getStats('cache-move');
    expect(eventReads.length).toBe(reads);
    expect(hit.body.recentInteractions).toEqual(first.body.recentInteractions);

    // Owner change (the trigger advances owner_since) within the TTL: rebuilt.
    const bot = bots.get(agentId)!;
    bot.userId = NEXT;
    bot.ownerSince = new Date('2026-10-04T11:00:00Z');
    seedEvent(agentId, NEXT, 'agent.connected', '2026-10-04T11:05:00Z', { via: 'next-register' });
    const moved = await getStats('cache-move');
    expect(eventReads.length).toBe(reads + 1);
    expect(JSON.stringify(moved.body)).not.toContain('cached prior directive');
    expect(moved.body.recentInteractions).toEqual([
      { type: 'agent.connected', ts: '2026-10-04T11:05:00.000Z', buildingId: null, payload: { via: 'next-register' } },
    ]);

    // Owner -> NULL within the TTL: rebuilt, and empty.
    bot.userId = null;
    bot.ownerSince = new Date('2026-10-04T12:00:00Z');
    const unowned = await getStats('cache-move');
    expect(unowned.body.recentInteractions).toEqual([]);

    // A -> B -> A round trip: same owner id, new owner_since: rebuilt, new period only.
    bot.userId = NEXT;
    bot.ownerSince = new Date('2026-10-04T13:00:00Z');
    const returned = await getStats('cache-move');
    expect(returned.body.recentInteractions).toEqual([]);
  });

  it('response shape is unchanged: top-level blocks, item keys, payload scrub', async () => {
    const agentId = seedBot('shape', NEXT, new Date('2026-10-04T10:00:00Z'));
    seedEvent(agentId, NEXT, 'agent.connected', '2026-10-04T10:40:00Z', {
      via: 'partner-register',
      scopedToken: 'must-not-leak',
      nested: { secret: 'x' },
    });
    const { status, body } = await getStats('shape');
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['leaderboard', 'learning', 'recentInteractions', 'registration']);
    expect(Object.keys(body.learning as Row).sort()).toEqual(['booksLearned', 'knowledgeCount', 'questsCompleted']);
    expect((body.registration as Row).agentId).toBe('shape');
    const recent = body.recentInteractions as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(1);
    expect(Object.keys(recent[0]!).sort()).toEqual(['buildingId', 'payload', 'ts', 'type']);
    expect(recent[0]!.payload).toEqual({ via: 'partner-register' });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
  });
});
