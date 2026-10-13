import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// PROTOCOL 85 (2026-10-13): `requireAuthOrAgentSession` slides the agent
// session's 24h TTL on every ACCEPTED header-authed call. Before this, a BYOA
// agent that only used header-authed routes (arena /me/*, activities, land,
// quests, wallet) lost its session exactly 24h after connect.
//
// Rules pinned here:
//   - the slide runs only after the fail-closed liveness gate passed, for a
//     ledger-capable session bound to a user + avatar (guest-owned, restored or
//     unproven sessions never slide; authentication 401/403 never slide);
//   - the write is CONDITIONAL (`slideLiveSessionTtl`): the row must still be
//     live (database write time, row locked first) AND hold this bearer's hash
//     AND have an active avatar AND not be guest-owned at write time, so
//     a request validated just before /disconnect, the sweep or a bearer
//     rotation can never revive the row or extend the replacement session;
//   - it never clears `sessionSweptAt`;
//   - one write per bearer per 60 s; a full throttle map evicts expired, then
//     oldest, entries only.

process.env.FINGERPRINT_SECRET ??= '42'.repeat(32);

const OWNER_ID = '81111111-1111-4111-8111-111111111111';
const AVATAR_ID = '83333333-3333-4333-8333-333333333333';

let botRow: Record<string, unknown> | null = null;
let ownerIsGuest = false;
let ownerHasActiveAvatar = true;
let failUpdate = false;
/** Every slide UPDATE that reached the DB, with its WHERE rendered to SQL. */
const attempts: Array<{ values: Record<string, unknown>; sql: string; params: unknown[] }> = [];
/** The attempts whose WHERE matched the fake row (= rows actually written). */
const matched: Array<Record<string, unknown>> = [];
/** Row-lock statements the slide ran before its UPDATE. */
const locks: string[] = [];

const dialect = new PgDialect();

/** Evaluate the slide's WHERE against the single fake row. */
function rowMatches(params: unknown[]): boolean {
  if (!botRow) return false;
  // The expiry check runs on database write time (`clock_timestamp()`), so the fake row
  // compares against the wall clock at write time.
  const [agentId, hash] = params as [string, string];
  const expires = botRow.sessionExpiresAt as Date | null;
  return (
    botRow.agentId === agentId &&
    botRow.sessionKeyHash != null &&
    botRow.sessionKeyHash === hash &&
    expires !== null &&
    expires.getTime() > Date.now() &&
    !ownerIsGuest &&
    ownerHasActiveAvatar
  );
}

const realDatabase = await import('@clawville/database');
const restoreModules: Array<[string, Record<string, unknown>]> = [['@clawville/database', { ...realDatabase }]];
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') {
      return {
        agentBots: { findFirst: async () => (botRow ? { ...botRow } : undefined) },
        users: { findFirst: async () => ({ isGuest: ownerIsGuest }) },
        avatars: { findFirst: async () => ({ id: AVATAR_ID }) },
      };
    }
    if (property === 'transaction') {
      // The slide locks the row (`select ... for update`) and then runs its
      // conditional UPDATE inside one transaction.
      return async (fn: (tx: unknown) => Promise<unknown>) => {
        if (failUpdate) throw new Error('db down');
        const tx = {
          execute: async (q: SQL) => {
            locks.push(dialect.sqlToQuery(q).sql);
            return [];
          },
          update: makeUpdate(),
        };
        return fn(tx);
      };
    }
    if (property === 'update') {
      if (failUpdate) return () => { throw new Error('db down'); };
      return makeUpdate();
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

function makeUpdate() {
  return () => ({
    set: (values: Record<string, unknown>) => ({
      where: (condition: SQL) => ({
        returning: async () => {
          const q = dialect.sqlToQuery(condition);
          attempts.push({ values, sql: q.sql, params: q.params });
          if (!rowMatches(q.params)) return [];
          matched.push(values);
          return [{ id: botRow!.id }];
        },
      }),
    }),
  });
}

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const { requireAuthOrAgentSession, AGENT_SESSION_HEADER } = await import('../require-auth-or-agent');
const { npcSimulation } = await import('../../services/npc-simulation');
const { AgentSubstrateClient } = await import('../../services/agent-substrate-client');
const { buildAvatarSessionConfig } = await import('../../services/agent-session-config');
const { sha256Hex } = await import('../../services/session-digest');
const {
  slideAgentSessionTtl,
  __resetSessionSlideThrottleForTests,
  SESSION_SLIDE_THROTTLE_MS,
} = await import('../../services/agent-session-sweeper');

type Registration = Parameters<typeof npcSimulation.registerAgentBot>[0];
const registered = new Set<string>();

function config(
  agentId: string,
  sessionId: string,
  opts: { boundUserId: string | null; ledgerCapable?: boolean },
): Registration {
  return buildAvatarSessionConfig({
    mode: 'avatar',
    agentId,
    sessionId,
    identityType: 'custom' as never,
    storedProtocol: 'nanoclaw',
    ledgerCapable: opts.ledgerCapable ?? opts.boundUserId !== null,
    boundUserId: opts.boundUserId,
    avatarId: AVATAR_ID,
    name: 'TTL Slide',
    species: null,
    color: null,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: 'ttl slide test',
  } as Parameters<typeof buildAvatarSessionConfig>[0]);
}

const owned = (agentId: string) => config(agentId, `ag-${agentId}`, { boundUserId: OWNER_ID });

function goLive(
  cfg: Registration,
  row: { userId?: string | null; expiresAt?: Date; keyHash?: string | null } = {},
) {
  npcSimulation.registerAgentBot(cfg, new AgentSubstrateClient(cfg));
  registered.add(cfg.sessionId);
  botRow = {
    id: '84444444-4444-4444-8444-444444444444',
    agentId: cfg.agentId,
    userId: row.userId === undefined ? OWNER_ID : row.userId,
    sessionKeyHash: row.keyHash === undefined ? sha256Hex(cfg.sessionId) : row.keyHash,
    sessionExpiresAt: row.expiresAt ?? new Date(Date.now() + 60 * 60_000),
  };
}

function app() {
  const a = new Hono();
  a.get('/probe', requireAuthOrAgentSession, (c) => c.json({ ok: true }));
  return a;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function call(sessionId: string | null) {
  const headers: Record<string, string> = sessionId ? { [AGENT_SESSION_HEADER]: sessionId } : {};
  const res = await app().request('/probe', { headers });
  await flush();
  return res.status;
}

beforeEach(() => {
  botRow = null;
  ownerIsGuest = false;
  ownerHasActiveAvatar = true;
  failUpdate = false;
  attempts.length = 0;
  matched.length = 0;
  locks.length = 0;
  __resetSessionSlideThrottleForTests();
});

afterEach(() => {
  for (const sessionId of registered) npcSimulation.unregisterAgentBot(sessionId);
  registered.clear();
});

afterAll(() => {
  __resetSessionSlideThrottleForTests();
  for (const [path, real] of restoreModules) mock.module(path, () => real);
});

describe('requireAuthOrAgentSession slides the agent session TTL', () => {
  test('an accepted ledger-capable bound session slides once with a conditional write', async () => {
    const cfg = owned('slide-ok');
    goLive(cfg);
    expect(await call(cfg.sessionId)).toBe(200);
    expect(attempts).toHaveLength(1);
    expect(matched).toHaveLength(1);
    const { values, sql, params } = attempts[0]!;
    // The new deadline and the liveness check both use database time.
    const setExpiry = dialect.sqlToQuery(values.sessionExpiresAt as SQL);
    expect(setExpiry.sql).toContain('clock_timestamp() + (');
    expect(setExpiry.sql).toContain("interval '1 millisecond'");
    expect(setExpiry.params[0]).toBe(24 * 60 * 60 * 1000);
    // Never clears the sweep stamp (that is extendSessionTtl's job, not the slide's).
    expect('sessionSweptAt' in values).toBe(false);
    expect(sql).toContain('"openclaw_bots"."session_key_hash" = $2');
    expect(sql).toContain('"openclaw_bots"."session_expires_at" > clock_timestamp()');
    expect(sql).toContain('"avatars"."is_active" = true');
    expect(sql).toContain('"users"."is_guest" = true');
    expect(params[0]).toBe('slide-ok');
    // The row lock runs before the liveness check.
    expect(locks).toHaveLength(1);
    expect(locks[0]).toContain('for update');
    expect(params[1]).toBe(sha256Hex(cfg.sessionId));
  });

  test('a second call inside the throttle window does not write again', async () => {
    const cfg = owned('slide-throttle');
    goLive(cfg);
    expect(await call(cfg.sessionId)).toBe(200);
    expect(await call(cfg.sessionId)).toBe(200);
    expect(await call(cfg.sessionId)).toBe(200);
    expect(attempts).toHaveLength(1);
  });

  test('after the throttle window the next slide writes again', async () => {
    const cfg = owned('slide-expiry');
    goLive(cfg);
    expect(await call(cfg.sessionId)).toBe(200);
    slideAgentSessionTtl(cfg.agentId, cfg.sessionId, Date.now() + SESSION_SLIDE_THROTTLE_MS - 1_000);
    await flush();
    expect(attempts).toHaveLength(1);
    slideAgentSessionTtl(cfg.agentId, cfg.sessionId, Date.now() + SESSION_SLIDE_THROTTLE_MS + 1_000);
    await flush();
    expect(attempts).toHaveLength(2);
    expect(matched).toHaveLength(2);
  });

  test('401 without a header does not slide', async () => {
    expect(await call(null)).toBe(401);
    expect(attempts).toHaveLength(0);
  });

  test('401 for an unknown session does not slide', async () => {
    expect(await call('ag-not-registered')).toBe(401);
    expect(attempts).toHaveLength(0);
  });

  test('401 for an expired session does not slide (no revival)', async () => {
    const cfg = owned('slide-expired');
    goLive(cfg, { expiresAt: new Date(Date.now() - 1_000) });
    expect(await call(cfg.sessionId)).toBe(401);
    expect(attempts).toHaveLength(0);
  });

  test('401 for a replaced bearer (row holds a newer hash) does not slide', async () => {
    const cfg = owned('slide-replaced');
    goLive(cfg, { keyHash: sha256Hex('ag-slide-replaced-NEWER-BEARER') });
    expect(await call(cfg.sessionId)).toBe(401);
    expect(attempts).toHaveLength(0);
  });

  test('403 for an unbound session does not slide', async () => {
    const cfg = config('slide-unbound', 'ag-slide-unbound', { boundUserId: null });
    goLive(cfg, { userId: null });
    expect(await call(cfg.sessionId)).toBe(403);
    expect(attempts).toHaveLength(0);
  });

  test('a guest-owned session is accepted as non-ledger but never slides', async () => {
    ownerIsGuest = true;
    const cfg = owned('slide-guest');
    goLive(cfg);
    expect(await call(cfg.sessionId)).toBe(200);
    expect(attempts).toHaveLength(0);
  });

  test('a non-ledger (restored / unproven) owner session never slides', async () => {
    const cfg = config('slide-nonledger', 'ag-slide-nonledger', { boundUserId: OWNER_ID, ledgerCapable: false });
    goLive(cfg);
    expect(await call(cfg.sessionId)).toBe(200);
    expect(attempts).toHaveLength(0);
  });

  test('a failed TTL write never fails the request', async () => {
    const cfg = owned('slide-fail');
    goLive(cfg);
    failUpdate = true;
    expect(await call(cfg.sessionId)).toBe(200);
    expect(attempts).toHaveLength(0);
    // The failure frees the throttle stamp: the next call retries at once.
    await flush();
    failUpdate = false;
    expect(await call(cfg.sessionId)).toBe(200);
    await flush();
    expect(matched).toHaveLength(1);
  });
});

describe('slideLiveSessionTtl: the conditional write cannot revive or extend the wrong session', () => {
  test('disconnect / sweep after validation: an expired row is not written', async () => {
    const cfg = owned('race-disconnect');
    goLive(cfg);
    botRow!.sessionExpiresAt = new Date(Date.now() - 1); // expireSession ran in between
    slideAgentSessionTtl(cfg.agentId, cfg.sessionId);
    await flush();
    expect(attempts).toHaveLength(1);
    expect(matched).toHaveLength(0);
  });

  test('bearer rotation after validation: the replacement session is not extended', async () => {
    const cfg = owned('race-rotate');
    goLive(cfg);
    botRow!.sessionKeyHash = sha256Hex('ag-race-rotate-REPLACEMENT'); // /connect rotated
    slideAgentSessionTtl(cfg.agentId, cfg.sessionId);
    await flush();
    expect(matched).toHaveLength(0);
  });

  test('a row with a NULL hash is never written by the slide', async () => {
    const cfg = owned('race-nullhash');
    goLive(cfg, { keyHash: null });
    slideAgentSessionTtl(cfg.agentId, cfg.sessionId);
    await flush();
    expect(matched).toHaveLength(0);
  });

  test('a guest owner at write time blocks the write (backstop for inline callers)', async () => {
    const cfg = owned('race-guest');
    goLive(cfg);
    ownerIsGuest = true;
    slideAgentSessionTtl(cfg.agentId, cfg.sessionId);
    await flush();
    expect(matched).toHaveLength(0);
  });
});

describe('slide requires an active avatar at write time', () => {
  test('an owner with no active avatar blocks the write (skills / world-presence callers)', async () => {
    const cfg = owned('no-avatar');
    goLive(cfg);
    ownerHasActiveAvatar = false;
    slideAgentSessionTtl(cfg.agentId, cfg.sessionId);
    await flush();
    expect(attempts).toHaveLength(1);
    expect(matched).toHaveLength(0);
  });
});

describe('slide throttle map eviction', () => {
  test('a full map evicts the oldest entry only; recent bearers stay throttled', async () => {
    const t = Date.now();
    for (let i = 0; i < 10_000; i += 1) slideAgentSessionTtl(`evict-${i}`, `s-${i}`, t);
    await flush();
    expect(attempts).toHaveLength(10_000);
    slideAgentSessionTtl('evict-new', 's-new', t); // full: evicts evict-0 only
    await flush();
    expect(attempts).toHaveLength(10_001);
    slideAgentSessionTtl('evict-1', 's-1', t); // still throttled
    await flush();
    expect(attempts).toHaveLength(10_001);
    slideAgentSessionTtl('evict-0', 's-0', t); // evicted, so it writes again
    await flush();
    expect(attempts).toHaveLength(10_002);
  });
});
