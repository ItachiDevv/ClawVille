/**
 * Shared-table baccarat: HTTP surface contract (spec 2026-10-22 sections 3.1-3.3).
 *
 * DB-free. Every collaborator the route reaches is mocked with `mock.module`
 * (process-global, so CI runs this file isolated; see gates.yml "Run route tests
 * with automatic mock isolation"):
 *   - `@clawville/database` `db.query.users|avatars.findFirst` (the real
 *     `requireNonGuestUser` / `isGuestUser` and the route's avatar lookup run
 *     against this fake);
 *   - `middleware/auth` `sessionMiddleware` (the test header `x-test-user` sets
 *     the Lucia user; no Lucia DB lookup);
 *   - `middleware/require-auth-or-agent` `resolveAgentSession`;
 *   - `services/agent-session-ttl` `slideAgentSessionTtl` (records the slide);
 *   - the manager singleton (records calls, returns or throws per test).
 *
 * The test app mirrors index.ts: the table router before the solo router, and
 * the same `onError` body shape (`{ error: <code>, code: <status> }`).
 */

import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createMiddleware } from 'hono/factory';
import * as realDatabase from '@clawville/database';
import * as realAuth from '../../middleware/auth';
import * as realAuthOrAgent from '../../middleware/require-auth-or-agent';
import * as realTtl from '../../services/agent-session-ttl';
import type { AppContext } from '../../types';

process.env.FINGERPRINT_SECRET = process.env.FINGERPRINT_SECRET ?? 'a'.repeat(64);

// ── Identities ───────────────────────────────────────────────────────────────

const TABLE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TABLE_ID = '22222222-2222-4222-8222-222222222222';

const HUMAN_USER = 'user-human';
const HUMAN_AVATAR = 'avatar-human';
const GUEST_USER = 'user-guest';
const NO_AVATAR_USER = 'user-no-avatar';

const AGENT_SESSION_OK = 'agent-session-ok';
const AGENT_SESSION_NO_LEDGER = 'agent-session-no-ledger';
const AGENT_SESSION_NO_AVATAR = 'agent-session-no-avatar';
const AGENT_USER = 'user-agent-owner';
const AGENT_AVATAR = 'avatar-agent';
const AGENT_ID = 'agent-1';

const AVATAR_BY_USER: Record<string, string> = {
  [HUMAN_USER]: HUMAN_AVATAR,
  [GUEST_USER]: 'avatar-guest',
};
const GUEST_USERS = new Set([GUEST_USER]);

const AGENT_SESSIONS: Record<
  string,
  { userId: string | null; avatarId: string | null; agentId: string; ledgerCapable: boolean }
> = {
  [AGENT_SESSION_OK]: { userId: AGENT_USER, avatarId: AGENT_AVATAR, agentId: AGENT_ID, ledgerCapable: true },
  [AGENT_SESSION_NO_LEDGER]: { userId: AGENT_USER, avatarId: AGENT_AVATAR, agentId: 'agent-2', ledgerCapable: false },
  [AGENT_SESSION_NO_AVATAR]: { userId: null, avatarId: null, agentId: 'agent-3', ledgerCapable: true },
};

// The mocked session middleware records the request's Lucia user here, so the
// fake db answers `users` / `avatars` lookups for that user (requests run one
// at a time).
let currentUserId: string | null = null;
let sessionMiddlewareCalls = 0;
const ttlSlides: Array<[string, string]> = [];

// ── Fake manager ─────────────────────────────────────────────────────────────

type Call = { method: string; args: unknown[] };
const managerCalls: Call[] = [];
let managerThrow: unknown = null;

function record(method: string, args: unknown[]): void {
  managerCalls.push({ method, args });
  if (managerThrow) throw managerThrow;
}

const fakeManager = {
  async listPublicTables(...args: unknown[]) {
    record('listPublicTables', args);
    return [{ tableId: TABLE_ID, tierKey: 'low', minBet: 5, maxBet: 50 }];
  },
  async getTableState(...args: unknown[]) {
    record('getTableState', args);
    if (args[0] === OTHER_TABLE_ID) return null;
    return { tableId: args[0], me: args[1] ? { seated: false } : null };
  },
  async sitDown(...args: unknown[]) {
    record('sitDown', args);
    return { seatIndex: 2, alreadySeated: false, roundSeq: 7, bettingClosesAt: 1_000 };
  },
  async leaveTable(...args: unknown[]) {
    record('leaveTable', args);
    return { left: true, lockedBet: null };
  },
  async placeBet(...args: unknown[]) {
    record('placeBet', args);
    const body = args[2] as { roundSeq: number; bet: string; stake: number };
    return { roundSeq: body.roundSeq, seatIndex: 2, bet: body.bet, stake: body.stake, bettingClosesAt: 1_000 };
  },
  async cancelBet(...args: unknown[]) {
    record('cancelBet', args);
    return { cancelled: true };
  },
};

// ── Module mocks (before the routers load) ───────────────────────────────────

const fakeDb = {
  query: {
    users: {
      findFirst: async () => (currentUserId ? { isGuest: GUEST_USERS.has(currentUserId) } : undefined),
    },
    avatars: {
      findFirst: async () => {
        const id = currentUserId ? AVATAR_BY_USER[currentUserId] : undefined;
        return id ? { id } : undefined;
      },
    },
  },
};

mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));
mock.module('../../middleware/auth', () => ({
  ...realAuth,
  sessionMiddleware: createMiddleware<AppContext>(async (c, next) => {
    sessionMiddlewareCalls++;
    const id = c.req.header('x-test-user') ?? null;
    currentUserId = id;
    c.set('user', (id ? { id } : null) as never);
    c.set('session', null);
    await next();
  }),
}));
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAuthOrAgent,
  resolveAgentSession: async (sessionId: string) => AGENT_SESSIONS[sessionId] ?? null,
}));
mock.module('../../services/agent-session-ttl', () => ({
  ...realTtl,
  slideAgentSessionTtl: (agentId: string, sessionId: string) => {
    ttlSlides.push([agentId, sessionId]);
  },
}));
mock.module('../../services/baccarat/baccarat-table-manager-singleton', () => ({
  baccaratTableManager: fakeManager,
}));

// ── Test app (mirrors index.ts) ──────────────────────────────────────────────

let tablesFirst: Hono<AppContext>;
let soloFirst: Hono<AppContext>;
let BaccaratTableError: typeof import('../../services/baccarat/baccarat-table-types').BaccaratTableError;
let InsufficientTokensError: typeof import('../../services/claw-token-ledger').InsufficientTokensError;

function withErrorHandler(app: Hono<AppContext>): Hono<AppContext> {
  // Same body shape as index.ts onError for the two expected kinds.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, code: err.status }, err.status);
    }
    return c.json({ error: 'internal', code: 500 }, 500);
  });
  return app;
}

beforeAll(async () => {
  const { coveBaccaratTableRouter } = await import('../cove-baccarat-tables');
  const { coveBaccaratRouter } = await import('../cove-baccarat');
  ({ BaccaratTableError } = await import('../../services/baccarat/baccarat-table-types'));
  ({ InsufficientTokensError } = await import('../../services/claw-token-ledger'));

  // The solo router has no fingerprint middleware of its own (index.ts runs one
  // globally), so stub fpHash at the app level as index.ts does.
  const fp = createMiddleware<AppContext>(async (c, next) => {
    c.set('fpHash', 'test-fp-hash');
    c.set('ipPrefixHash', '');
    await next();
  });

  tablesFirst = new Hono<AppContext>();
  tablesFirst.use('*', fp);
  tablesFirst.route('/api/cove/baccarat/tables', coveBaccaratTableRouter);
  tablesFirst.route('/api/cove/baccarat', coveBaccaratRouter);
  withErrorHandler(tablesFirst);

  soloFirst = new Hono<AppContext>();
  soloFirst.use('*', fp);
  soloFirst.route('/api/cove/baccarat', coveBaccaratRouter);
  soloFirst.route('/api/cove/baccarat/tables', coveBaccaratTableRouter);
  withErrorHandler(soloFirst);
});

beforeEach(async () => {
  managerCalls.length = 0;
  managerThrow = null;
  ttlSlides.length = 0;
  sessionMiddlewareCalls = 0;
  currentUserId = null;
  const { __resetBaccaratTableRateLimits } = await import('../cove-baccarat-tables');
  __resetBaccaratTableRateLimits();
});

const BASE = `/api/cove/baccarat/tables/${TABLE_ID}`;

function req(
  path: string,
  init: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.rawBody !== undefined) body = init.rawBody;
  else if (init.body !== undefined) body = JSON.stringify(init.body);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return tablesFirst.request(path, { method: init.method ?? 'GET', headers, body });
}

const asHuman = { 'x-test-user': HUMAN_USER };
const asAgent = { 'X-Clawville-Agent-Session': AGENT_SESSION_OK };
const goodBet = { roundSeq: 7, bet: 'banker', stake: 20 };

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: unknown };
  return String(body.error);
}

// ── Mount order ──────────────────────────────────────────────────────────────

describe('mount order', () => {
  it('the table lobby resolves and the solo session/current still resolves', async () => {
    const lobby = await req('/api/cove/baccarat/tables');
    expect(lobby.status).toBe(200);
    const body = (await lobby.json()) as { ok: boolean; serverNow: number; tables: unknown[] };
    expect(body.ok).toBe(true);
    expect(typeof body.serverNow).toBe('number');
    expect(body.tables).toHaveLength(1);
    expect(managerCalls[0]).toEqual({ method: 'listPublicTables', args: [50] });

    // The SOLO handler ran: a logged-out caller is the solo guest subject, which
    // has no persistent shoe (403 from cove-baccarat.ts, not a 404).
    const solo = await req('/api/cove/baccarat/session/current');
    expect(solo.status).toBe(403);
    expect(await errorOf(solo)).toStartWith('guest_has_no_persistent_shoe');
  });

  it('table-first order runs ONE session middleware pass per table request', async () => {
    await tablesFirst.request('/api/cove/baccarat/tables');
    expect(sessionMiddlewareCalls).toBe(1);

    // Negative control: solo-first also routes (Hono 4.12 composes both), but
    // the solo router's use('*') session middleware runs on the table path too.
    sessionMiddlewareCalls = 0;
    const res = await soloFirst.request('/api/cove/baccarat/tables');
    expect(res.status).toBe(200);
    expect(sessionMiddlewareCalls).toBe(2);
  });

  it('the table state resolves under the tables prefix, not the solo /session/:id', async () => {
    const res = await req(BASE);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(managerCalls[0]?.method).toBe('getTableState');
  });
});

// ── Subject resolution ───────────────────────────────────────────────────────

describe('subject resolution', () => {
  it('a guest account gets 403 guest_not_allowed on every write and the manager is never called', async () => {
    const headers = { 'x-test-user': GUEST_USER };
    for (const [method, path, body] of [
      ['POST', `${BASE}/sit`, {}],
      ['POST', `${BASE}/leave`, {}],
      ['POST', `${BASE}/bet`, goodBet],
      ['DELETE', `${BASE}/bet`, undefined],
    ] as const) {
      const res = await req(path, { method, body, headers });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { code: string };
      expect(json.code).toBe('guest_not_allowed');
    }
    // Even with a valid agent header, the guest Lucia user wins and is refused.
    const both = await req(`${BASE}/bet`, {
      method: 'POST',
      body: goodBet,
      headers: { ...headers, ...asAgent },
    });
    expect(both.status).toBe(403);
    expect(managerCalls).toHaveLength(0);
  });

  it('a guest account reads the table with me = null (soft resolver)', async () => {
    const res = await req(BASE, { headers: { 'x-test-user': GUEST_USER } });
    expect(res.status).toBe(200);
    expect(managerCalls[0]?.args[1]).toBeNull();
  });

  it('an agent session without ledger capability gets 403 agent_session_not_ledger_authorized', async () => {
    const res = await req(`${BASE}/bet`, {
      method: 'POST',
      body: goodBet,
      headers: { 'X-Clawville-Agent-Session': AGENT_SESSION_NO_LEDGER },
    });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('agent_session_not_ledger_authorized');
    expect(managerCalls).toHaveLength(0);
    expect(ttlSlides).toHaveLength(0);
  });

  it('an agent session with no bound avatar gets 403; an unknown one gets 401', async () => {
    const noAvatar = await req(`${BASE}/sit`, {
      method: 'POST',
      headers: { 'X-Clawville-Agent-Session': AGENT_SESSION_NO_AVATAR },
    });
    expect(noAvatar.status).toBe(403);
    expect(await errorOf(noAvatar)).toBe('agent_session_has_no_active_avatar');

    const unknown = await req(`${BASE}/sit`, {
      method: 'POST',
      headers: { 'X-Clawville-Agent-Session': 'nope' },
    });
    expect(unknown.status).toBe(401);
    expect(await errorOf(unknown)).toBe('invalid_or_expired_agent_session');
    expect(managerCalls).toHaveLength(0);
  });

  it('no credential is 401 auth_required; a user with no active avatar is 403', async () => {
    const anon = await req(`${BASE}/sit`, { method: 'POST' });
    expect(anon.status).toBe(401);
    expect(await errorOf(anon)).toBe('auth_required');

    const noAvatar = await req(`${BASE}/sit`, {
      method: 'POST',
      headers: { 'x-test-user': NO_AVATAR_USER },
    });
    expect(noAvatar.status).toBe(403);
    expect(await errorOf(noAvatar)).toBe('active_avatar_required');
  });

  it('a ledger-capable agent binds to its avatar, slides its TTL, and shares the human rate key', async () => {
    const res = await req(`${BASE}/bet`, { method: 'POST', body: goodBet, headers: asAgent });
    expect(res.status).toBe(200);
    expect(managerCalls[0]?.method).toBe('placeBet');
    expect(managerCalls[0]?.args[1]).toEqual({
      kind: 'agent',
      userId: AGENT_USER,
      avatarId: AGENT_AVATAR,
      agentId: AGENT_ID,
    });
    expect(managerCalls[0]?.args[2]).toEqual({ roundSeq: 7, bet: 'banker', stake: 20 });
    expect(ttlSlides).toEqual([[AGENT_ID, AGENT_SESSION_OK]]);
  });

  it('a human resolves to the active avatar; the Lucia user wins over an agent header', async () => {
    const res = await req(`${BASE}/sit`, {
      method: 'POST',
      body: { seatIndex: 3 },
      headers: { ...asHuman, ...asAgent },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      seatIndex: 2,
      alreadySeated: false,
      roundSeq: 7,
      bettingClosesAt: 1_000,
    });
    expect(managerCalls[0]?.args).toEqual([
      TABLE_ID,
      { kind: 'user', userId: HUMAN_USER, avatarId: HUMAN_AVATAR, agentId: null },
      { seatIndex: 3 },
    ]);
    expect(ttlSlides).toHaveLength(0);
  });
});

// ── Fixture refusal ──────────────────────────────────────────────────────────

describe('test-fixture header', () => {
  it('returns 409 fixture_not_supported_on_shared_tables on writes and reads', async () => {
    for (const [method, path] of [
      ['POST', `${BASE}/bet`],
      ['POST', `${BASE}/sit`],
      ['GET', BASE],
      ['GET', '/api/cove/baccarat/tables'],
    ] as const) {
      const res = await req(path, {
        method,
        body: method === 'POST' ? goodBet : undefined,
        headers: { ...asHuman, 'X-CV-Test-Fixture': 'run-1' },
      });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe('fixture_not_supported_on_shared_tables');
    }
    expect(managerCalls).toHaveLength(0);
  });
});

// ── Zod 400s ─────────────────────────────────────────────────────────────────

describe('input validation', () => {
  it('rejects a non-uuid table id with 400 invalid_table_id', async () => {
    for (const [method, path] of [
      ['GET', '/api/cove/baccarat/tables/not-a-uuid'],
      ['POST', '/api/cove/baccarat/tables/not-a-uuid/sit'],
      ['POST', '/api/cove/baccarat/tables/not-a-uuid/bet'],
    ] as const) {
      const res = await req(path, { method, body: method === 'POST' ? goodBet : undefined, headers: asHuman });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('invalid_table_id');
    }
  });

  it('rejects bad bet bodies with 400 invalid_bet_body', async () => {
    const bad: unknown[] = [
      { roundSeq: 7, bet: 'dragon', stake: 20 },
      { roundSeq: 7, bet: 'player', stake: 4 },
      { roundSeq: 7, bet: 'player', stake: 501 },
      { roundSeq: 7, bet: 'player', stake: 20.5 },
      { roundSeq: -1, bet: 'player', stake: 20 },
      { coupIndex: 7, bet: 'player', stake: 20 },
      { ...goodBet, extra: true },
    ];
    for (const body of bad) {
      const res = await req(`${BASE}/bet`, { method: 'POST', body, headers: asHuman });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toStartWith('invalid_bet_body');
    }
    const notJson = await req(`${BASE}/bet`, { method: 'POST', rawBody: '{nope', headers: asHuman });
    expect(notJson.status).toBe(400);
    expect(await errorOf(notJson)).toStartWith('invalid_bet_body');
    expect(managerCalls).toHaveLength(0);
  });

  it('sit accepts an empty body and rejects a bad seatIndex or extra key', async () => {
    const empty = await req(`${BASE}/sit`, { method: 'POST', headers: asHuman });
    expect(empty.status).toBe(201);
    expect(managerCalls[0]?.args[2]).toEqual({ seatIndex: undefined });

    for (const body of [{ seatIndex: 8 }, { seatIndex: -1 }, { seatIndex: 'a' }, { buyInCt: 10 }]) {
      const res = await req(`${BASE}/sit`, { method: 'POST', body, headers: asHuman });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('invalid_sit_body');
    }
  });

  it('leave accepts an empty body or {} and rejects extra keys', async () => {
    const empty = await req(`${BASE}/leave`, { method: 'POST', headers: asHuman });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ ok: true, left: true, lockedBet: null });
    const obj = await req(`${BASE}/leave`, { method: 'POST', body: {}, headers: asHuman });
    expect(obj.status).toBe(200);
    const extra = await req(`${BASE}/leave`, { method: 'POST', body: { force: true }, headers: asHuman });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toEqual({ error: 'invalid_leave_body', code: 400 });
    const notJson = await req(`${BASE}/leave`, { method: 'POST', rawBody: '{nope', headers: asHuman });
    expect(notJson.status).toBe(400);
    expect(await errorOf(notJson)).toBe('invalid_leave_body');
  });

  it('the two 400 codes come from the ONE status map', async () => {
    const { BACCARAT_TABLE_ERROR_STATUS } = await import('../../services/baccarat/baccarat-table-types');
    const map = BACCARAT_TABLE_ERROR_STATUS as Record<string, number>;
    expect(map.invalid_leave_body).toBe(400);
    expect(map.invalid_lobby_query).toBe(400);
    expect(map.bet_conflict).toBe(409);
  });

  it('checks the Idempotency-Key length (1..64)', async () => {
    const long = await req(`${BASE}/bet`, {
      method: 'POST',
      body: goodBet,
      headers: { ...asHuman, 'Idempotency-Key': 'k'.repeat(65) },
    });
    expect(long.status).toBe(400);
    expect(await errorOf(long)).toBe('idempotency_key_must_be_1_to_64_chars');

    const ok = await req(`${BASE}/bet`, {
      method: 'POST',
      body: goodBet,
      headers: { ...asHuman, 'Idempotency-Key': 'k'.repeat(64) },
    });
    expect(ok.status).toBe(200);
  });

  it('rejects a lobby limit outside 1..50', async () => {
    for (const q of ['0', '51', 'abc']) {
      const res = await req(`/api/cove/baccarat/tables?limit=${q}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: number };
      expect(body.error).toStartWith('invalid_lobby_query');
      expect(body.code).toBe(400);
    }
    const unknownKey = await req('/api/cove/baccarat/tables?tier=low');
    expect(unknownKey.status).toBe(400);
    expect(await errorOf(unknownKey)).toStartWith('invalid_lobby_query');
    const ok = await req('/api/cove/baccarat/tables?limit=3');
    expect(ok.status).toBe(200);
    expect(managerCalls[0]?.args).toEqual([3]);
  });
});

// ── Error-code mapping ───────────────────────────────────────────────────────

describe('manager error mapping', () => {
  it('maps a coded manager error to its status with message = code', async () => {
    const cases: Array<[string, number]> = [
      ['stake_out_of_bounds', 400],
      ['seeded_seat_cannot_bet', 403],
      ['table_not_found', 404],
      ['table_closed', 409],
      ['table_full', 409],
      ['seat_taken', 409],
      ['not_seated', 409],
      ['bet_conflict', 409],
    ];
    for (const [code, status] of cases) {
      managerThrow = new BaccaratTableError(code);
      const res = await req(`${BASE}/bet`, { method: 'POST', body: goodBet, headers: asHuman });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: code, code: status });
    }
  });

  it('carries the section 3.3 detail fields on the 409 body', async () => {
    managerThrow = new BaccaratTableError('already_seated_elsewhere', undefined, undefined, {
      tableId: OTHER_TABLE_ID,
      secret: 'never-on-the-wire',
    });
    const elsewhere = await req(`${BASE}/sit`, { method: 'POST', headers: asHuman });
    expect(elsewhere.status).toBe(409);
    expect(await elsewhere.json()).toEqual({
      error: 'already_seated_elsewhere',
      code: 409,
      tableId: OTHER_TABLE_ID,
    });

    managerThrow = new BaccaratTableError('betting_closed', undefined, undefined, {
      nextBettingOpensAt: 123_456,
    });
    const closed = await req(`${BASE}/bet`, { method: 'POST', body: goodBet, headers: asHuman });
    expect(await closed.json()).toEqual({ error: 'betting_closed', code: 409, nextBettingOpensAt: 123_456 });

    managerThrow = new BaccaratTableError('stale_round', undefined, undefined, { roundSeq: 8 });
    const stale = await req(`${BASE}/bet`, { method: 'POST', body: goodBet, headers: asHuman });
    expect(await stale.json()).toEqual({ error: 'stale_round', code: 409, roundSeq: 8 });

    // A null detail is dropped, not sent as null.
    managerThrow = new BaccaratTableError('betting_closed', undefined, undefined, {
      nextBettingOpensAt: null,
    });
    const noNext = await req(`${BASE}/bet`, { method: 'POST', body: goodBet, headers: asHuman });
    expect(await noNext.json()).toEqual({ error: 'betting_closed', code: 409 });
  });

  it('passes the manager bet_conflict (409, as placeBet/cancelBet throw it) through on place and cancel', async () => {
    for (const [method, message] of [
      ['POST', 'bet changed under the lock, retry'],
      ['POST', 'concurrent bet on this seat, retry'],
      ['DELETE', 'bet changed under the lock, retry'],
    ] as const) {
      managerThrow = new BaccaratTableError('bet_conflict', message, 409);
      const res = await req(`${BASE}/bet`, {
        method,
        body: method === 'POST' ? goodBet : undefined,
        headers: asAgent,
      });
      expect(res.status).toBe(409);
      // The wire carries the code, never the manager's internal message.
      expect(await res.json()).toEqual({ error: 'bet_conflict', code: 409 });
    }
  });

  it('maps InsufficientTokensError to 402 insufficient_clawtokens', async () => {
    managerThrow = new InsufficientTokensError(HUMAN_AVATAR, 3, 20);
    const res = await req(`${BASE}/bet`, { method: 'POST', body: goodBet, headers: asHuman });
    expect(res.status).toBe(402);
    expect(await errorOf(res)).toBe('insufficient_clawtokens');
  });

  it('rethrows an internal 5xx invariant code to onError (never a 4xx)', async () => {
    managerThrow = new BaccaratTableError('shoe_counter_drift');
    const res = await req(`${BASE}/bet`, { method: 'POST', body: goodBet, headers: asHuman });
    expect(res.status).toBe(500);
  });

  it('a missing table is 404 table_not_found on the read', async () => {
    const res = await req(`/api/cove/baccarat/tables/${OTHER_TABLE_ID}`);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('table_not_found');
  });

  it('cancel returns { ok, cancelled }', async () => {
    const res = await req(`${BASE}/bet`, { method: 'DELETE', headers: asHuman });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
    expect(managerCalls[0]?.method).toBe('cancelBet');
  });
});

// ── Boot wiring (index.ts) ───────────────────────────────────────────────────
// index.ts cannot boot in isolation (it starts the whole API), so this pins the
// source: the round tick starts FIRST and in its own try block, so a seeder
// failure (bot insert error) can never stop rounds closing on the process.

describe('index.ts baccarat boot order', () => {
  it('starts the tick before the seeder and the scaler, each in its own try block', async () => {
    const { join } = await import('path');
    const src = await Bun.file(join(import.meta.dir, '..', '..', 'index.ts')).text();
    const tick = src.indexOf('startBaccaratTableTick();');
    const ensure = src.indexOf('await baccaratHouseSeeder.ensure();');
    const scaler = src.indexOf('startBaccaratHouseScaler();');
    expect(tick).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(tick);
    expect(scaler).toBeGreaterThan(ensure);
    // A catch closes the tick's try before the seeder runs, and the seeder's try
    // before the scaler starts.
    expect(src.slice(tick, ensure)).toContain('} catch (err) {');
    expect(src.slice(ensure, scaler)).toContain('} catch (err) {');
    // Each step appears once (no second, combined boot block).
    expect(src.split('startBaccaratTableTick();').length - 1).toBe(1);
    expect(src.split('await baccaratHouseSeeder.ensure();').length - 1).toBe(1);
    expect(src.split('startBaccaratHouseScaler();').length - 1).toBe(1);
  });
});

// ── Rate limit ───────────────────────────────────────────────────────────────

describe('bet rate limit', () => {
  it('allows 120 bet writes per minute per owner user, then 429; agent shares the bucket', async () => {
    // The agent's owner is AGENT_USER; 120 agent bets fill that bucket.
    for (let i = 0; i < 120; i++) {
      const res = await req(`${BASE}/bet`, { method: 'POST', body: goodBet, headers: asAgent });
      expect(res.status).toBe(200);
    }
    const over = await req(`${BASE}/bet`, { method: 'DELETE', headers: asAgent });
    expect(over.status).toBe(429);
    expect(await errorOf(over)).toBe('cove_baccarat_table_rate_limit');

    // A different owner has its own bucket.
    const human = await req(`${BASE}/bet`, { method: 'POST', body: goodBet, headers: asHuman });
    expect(human.status).toBe(200);
  });
});
