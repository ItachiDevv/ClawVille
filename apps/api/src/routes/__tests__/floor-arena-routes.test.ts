import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Hono, type MiddlewareHandler } from 'hono';
import {
  FLOOR_ARENA_CONTEST,
  FLOOR_ARENA_TEMPLATES,
  cloneFloorArenaParams,
  type FloorArenaAddon,
  type FloorArenaParams,
} from '@clawville/shared';
import {
  FLOOR_ARENA_AUTH_CHAIN,
  createFloorArenaRoutes,
  describeChanges,
  normaliseAddons,
  type FloorArenaRouteDeps,
} from '../floor-arena';
import { sessionMiddleware } from '../../middleware/auth';
import { requireAuthOrAgentSession, requireLedgerCapableIdentity } from '../../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../../middleware/require-non-guest';
import { createRateLimiter } from '../../middleware/rate-limit';
import type { ArenaAgentRecord, ArenaEvent, ArenaReport, InsertUserAgentInput, ParamUpdateInput } from '../../services/floor-arena/queries';

const NOW = new Date('2026-10-01T12:00:00Z');
const USER = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const AVATAR = '00000000-0000-4000-8000-0000000000aa';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const REPORT_ID = '22222222-2222-4222-8222-222222222222';
const GENESIS = FLOOR_ARENA_TEMPLATES.find((template) => template.id === 'genesis')!;
const FEED: FloorArenaAddon = {
  id: 'feed-a', vendor: 'v', name: 'Feed A', url: 'https://feed.example/x', method: 'GET', query: {}, body: null,
  dedupeVary: null, priceUsd: 0.1, minIntervalS: 600, mintPath: 'data[].mint', symbolPath: null, note: 'n',
};

const EVENTS: ArenaEvent[] = [
  { id: 2, at: NOW.toISOString(), type: 'skip', mint: 'PrivMint', summary: 'Skipped PrivMint: cooldown', data: { reason: 'cooldown' } },
  { id: 3, at: NOW.toISOString(), type: 'scan', mint: null, summary: 'Scanned 40 coins', data: null },
  { id: 4, at: NOW.toISOString(), type: 'pass', mint: 'PrivMint', summary: 'PrivMint passed via private:nansen-token-screener-sol', data: { source: 'private:nansen-token-screener-sol' } },
  { id: 5, at: NOW.toISOString(), type: 'addon', mint: null, summary: 'Execution wallet ready', data: { paymentAddress: 'WalletX' } },
  { id: 6, at: NOW.toISOString(), type: 'entry', mint: 'MintA', summary: 'Bought $20 of WIF via private:nansen-token-screener-sol', data: { source: 'private:nansen-token-screener-sol', sizeUsd: 20, addonId: 'nansen-token-screener-sol' } },
  { id: 7, at: NOW.toISOString(), type: 'status', mint: null, summary: 'Sat down at desk 3', data: { seated: true, paymentAddress: 'WalletX' } },
];
const PARAM_EVENT: ArenaEvent = {
  id: 8, at: NOW.toISOString(), type: 'param_change', mint: null,
  summary: 'Changed 1 setting because my secret feed private:nansen-token-screener-sol said so',
  data: { source: 'user', paramsVersion: 2, reason: 'my secret feed', changes: [{ path: 'exits.max_hold_s', from: 900, to: 600 }] },
};

function params(): FloorArenaParams {
  return cloneFloorArenaParams(GENESIS.params);
}

/** Identity from test headers, standing in for session + requireAuthOrAgentSession. */
const fakeIdentity: MiddlewareHandler = async (c, next) => {
  const user = c.req.header('x-test-user');
  if (!user) return c.json({ error: 'auth' }, 401);
  const kind = c.req.header('x-test-kind') === 'agent' ? 'agent' : 'user';
  c.set('identity' as never, (kind === 'agent'
    ? { kind, userId: user, avatarId: AVATAR, agentId: 'bot-1', sessionId: 's', ledgerCapable: c.req.header('x-test-ledger') !== 'false' }
    : { kind, userId: user, avatarId: AVATAR, agentId: null }) as never);
  // What the global fingerprintMiddleware stamps on every request.
  c.set('fpHash' as never, `fp-${user}` as never);
  c.set('ipPrefixHash' as never, 'ip-203.0.113' as never);
  return next();
};

function makeDeps() {
  const agents = new Map<string, ArenaAgentRecord>();
  const reports = new Map<string, ArenaReport>();
  const log: string[] = [];
  const updates: ParamUpdateInput[] = [];
  const tapeLimits: number[] = [];
  const eventReads: Array<readonly string[] | null> = [];
  const eventAgents: string[] = [];
  const logged: Array<{ input: Record<string, unknown>; fpHash: unknown; ipPrefixHash: unknown }> = [];
  let clock = NOW.getTime();
  let conflictNext = false;
  const deps: FloorArenaRouteDeps = {
    now: () => new Date(clock),
    newId: () => AGENT_ID,
    readAgent: async (id) => agents.get(id) ?? null,
    readAgentByOwner: async (userId) => [...agents.values()].find((agent) => agent.ownerUserId === userId) ?? null,
    readHouseAgents: async () => [],
    readAvatarName: async () => 'Satoshi 🚀',
    insertUserAgent: async (input: InsertUserAgentInput) => {
      if ([...agents.values()].some((agent) => agent.ownerUserId === input.ownerUserId)) return null;
      const row: ArenaAgentRecord = {
        id: input.id, kind: 'user', ownerUserId: input.ownerUserId, avatarId: input.avatarId, name: input.name,
        templateId: input.templateId, params: input.params, paramsVersion: 1, mode: 'paper', status: 'active',
        seated: false, seatIndex: null, seatedAt: null, clawpumpAgentId: null, clawpumpWallet: null,
        provisionState: 'pending', provisionError: null, provisionAttempts: 0, provisionNextAt: null,
        addons: input.addons, autoApplySuggestions: false, contestId: input.contestId, createdAt: NOW, updatedAt: NOW,
      };
      agents.set(row.id, row);
      return row;
    },
    updateParams: async (input) => {
      updates.push(input);
      if (conflictNext) { conflictNext = false; return { ok: false, reason: 'version_conflict' }; }
      const agent = agents.get(input.agentId)!;
      if (input.report) {
        const report = reports.get(input.report.id);
        if (!report || report.suggestionState !== 'pending') return { ok: false, reason: 'report_not_pending' };
        reports.set(report.id, { ...report, suggestionState: input.report.state });
      }
      agents.set(agent.id, { ...agent, params: input.params, paramsVersion: agent.paramsVersion + 1 });
      return { ok: true, paramsVersion: agent.paramsVersion + 1 };
    },
    setSeat: async (id, seated, seatIndex, summary) => {
      log.push(summary);
      const next = { ...agents.get(id)!, seated, seatIndex, seatedAt: seated ? NOW : null };
      agents.set(id, next);
      return next;
    },
    setStatus: async (id, status, summary) => {
      log.push(summary);
      const next = { ...agents.get(id)!, status };
      agents.set(id, next);
      return next;
    },
    setAddons: async (id, addons, summary) => {
      log.push(summary);
      const next = { ...agents.get(id)!, addons };
      agents.set(id, next);
      return next;
    },
    setAutoApply: async (id, autoApply) => {
      const next = { ...agents.get(id)!, autoApplySuggestions: autoApply };
      agents.set(id, next);
      return next;
    },
    readReport: async (id) => reports.get(id) ?? null,
    readLatestReport: async (agentId) => ({
      id: REPORT_ID, agentId, periodStart: NOW.toISOString(), periodEnd: NOW.toISOString(), stats: {}, summary: 'private report',
      suggestion: null, suggestionState: 'none', createdAt: NOW.toISOString(),
    }),
    setReportState: async (id, _agentId, state) => {
      const report = reports.get(id);
      if (!report || (state !== 'applied' && report.suggestionState !== 'pending')) return false;
      reports.set(id, { ...report, suggestionState: state });
      return true;
    },
    readPositions: async (_agentId, status) => (status === 'closed' ? [{
      id: 'p1', mint: 'MintA', symbol: 'WIF', source: 'private:nansen-token-screener-sol', openedAt: NOW.toISOString(), sizeUsd: 20,
      tokens: 100, entryPriceUsd: 0.2, entryFillSource: 'quote', entryFeatures: { source: 'private:x', exits: {} }, paramsVersion: 1,
      peakMult: 1.2, lastMarkMult: 1.1, lastMarkAt: NOW.toISOString(), remainingFraction: 0, realisedUsd: 22, status: 'closed' as const,
      closedAt: NOW.toISOString(), exitReason: 'tp', exitFillSource: 'quote', pnlUsd: 2, pnlMult: 1.1,
    }, {
      id: 'p2', mint: 'MintB', symbol: 'RUG', source: 'dexscreener', openedAt: NOW.toISOString(), sizeUsd: 20,
      tokens: 100, entryPriceUsd: 0.2, entryFillSource: 'quote', entryFeatures: null, paramsVersion: 1,
      peakMult: 1, lastMarkMult: null, lastMarkAt: null, remainingFraction: 1, realisedUsd: 0, status: 'closed' as const,
      closedAt: NOW.toISOString(), exitReason: 'unresolved', exitFillSource: null, pnlUsd: null, pnlMult: null,
    }] : []),
    readParamChanges: async () => [{
      id: 1, at: NOW.toISOString(), source: 'suggestion' as const, changes: [{ path: 'exits.max_hold_s', from: 900, to: 600 }],
      paramsVersion: 2, reason: 'Tuner: private:nansen-token-screener-sol trades died early.',
    }],
    readEvents: async (agentId, after, limit, types) => {
      eventReads.push(types ?? null);
      eventAgents.push(agentId);
      return EVENTS.filter((event) => (after === null || event.id > after) && (!types || types.includes(event.type))).slice(-limit);
    },
    readDiscovery: async () => [],
    readTape: async (limit) => { tapeLimits.push(limit); return Array.from({ length: Math.min(limit, 2) }, (_, index) => ({
      id: `exit:${100 - index}`, at: NOW.toISOString(), agentId: 'house:genesis', agentName: 'Genesis', kind: 'house' as const,
      type: 'exit' as const, mint: 'M', symbol: 'WIF', side: 'sell' as const, usd: 22, pnlUsd: 2, pnlMult: 1.1, reason: 'tp' as const,
    })); },
    readStats: async () => new Map(),
    readLeaderboard: async (window) => [{
      rank: 1, agentId: AGENT_ID, name: 'x', kind: 'user', templateId: 'genesis', realisedUsd: 1, trades: 1, wins: 1,
      losses: 0, deaths: 0, openPositions: 0, lastTradeAt: null, eligible: window === 'contest',
    }],
    readContest: async () => ({
      contest: FLOOR_ARENA_CONTEST, status: 'live', secondsLeft: 1, standings: null, openWindowPositions: null, top: [], house: [],
      generatedAt: NOW.toISOString(),
    }),
    readAddonStats: async () => [],
    readWalletBalance: async () => null,
    addonCatalog: () => [FEED],
    addonPaymentsEnabled: () => true,
    logArenaEvent: async (c, input) => {
      logged.push({ input: input as unknown as Record<string, unknown>, fpHash: c.get('fpHash'), ipPrefixHash: c.get('ipPrefixHash') });
    },
  };
  return {
    deps, agents, reports, log, updates, tapeLimits, eventReads, eventAgents, logged,
    advance: (ms: number) => { clock += ms; },
    conflictOnce: () => { conflictNext = true; },
  };
}

function app(options: { auth?: MiddlewareHandler[]; writeMax?: number } = {}) {
  const state = makeDeps();
  const routes = createFloorArenaRoutes(state.deps, {
    auth: options.auth ?? [fakeIdentity],
    limiters: {
      public: () => createRateLimiter({ maxPerWindow: 1_000 }),
      write: () => createRateLimiter({ maxPerWindow: options.writeMax ?? 1_000 }),
      launch: () => createRateLimiter({ maxPerWindow: options.writeMax ?? 1_000 }),
    },
  });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-test-user': USER }) =>
    await routes.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ...state, routes, call };
}

const launchBody = (overrides: Record<string, unknown> = {}) => ({ templateId: 'genesis', params: params(), mode: 'paper', ...overrides });

describe('public arena GETs', () => {
  test('templates: public cache, no auth, no Set-Cookie even with a cookie present', async () => {
    const { routes } = app();
    const response = await routes.request('/templates', { headers: { Cookie: 'auth_session=not-a-real-session' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=15');
    expect(response.headers.get('set-cookie')).toBeNull();
    const body = await response.json() as { templates: unknown[]; houseAgents: Array<{ id: string; seated: boolean }> };
    expect(body.templates).toHaveLength(FLOOR_ARENA_TEMPLATES.length);
    expect(body.houseAgents.map((house) => house.id)).toContain('house:genesis');
    expect(body.houseAgents.every((house) => house.seated)).toBe(true);
  });

  test('leaderboard validates the window and defaults to contest', async () => {
    const { routes } = app();
    expect((await routes.request('/leaderboard?window=7d')).status).toBe(400);
    const body = await (await routes.request('/leaderboard')).json() as { window: string; rows: Array<{ eligible: boolean }> };
    expect(body.window).toBe('contest');
    expect(body.rows[0]!.eligible).toBe(true);
  });

  test('agent profile: 404 for a bad or unknown id, and never the owner or avatar id', async () => {
    const { routes, call, agents } = app();
    expect((await routes.request('/agents/../../etc')).status).toBe(404);
    expect((await routes.request(`/agents/${AGENT_ID}`)).status).toBe(404);
    await call('POST', '/me/launch', launchBody());
    const response = await routes.request(`/agents/${AGENT_ID}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(USER);
    expect(text).not.toContain(AVATAR);
    expect(text).not.toContain('ownerUserId');
    expect(JSON.parse(text).agent.id).toBe(AGENT_ID);
    expect(agents.size).toBe(1);
  });

  test('events validate after/limit and return lastId for polling', async () => {
    const { routes, call } = app();
    await call('POST', '/me/launch', launchBody());
    expect((await routes.request(`/agents/${AGENT_ID}/events?limit=101`)).status).toBe(400);
    expect((await routes.request(`/agents/${AGENT_ID}/events?after=-1`)).status).toBe(400);
    const first = await (await routes.request(`/agents/${AGENT_ID}/events`)).json() as { lastId: number | null };
    expect(first.lastId).toBe(7);
    const next = await (await routes.request(`/agents/${AGENT_ID}/events?after=7`)).json() as { events: unknown[]; lastId: number | null };
    expect(next).toMatchObject({ events: [], lastId: 7 });
  });

  test('Codex r2 #2: a USER agent public stream is entry/exit/param_change/status only, add-on names and wallet removed', async () => {
    const { routes, call, eventReads } = app();
    await call('POST', '/me/launch', launchBody());
    const response = await routes.request(`/agents/${AGENT_ID}/events`);
    const body = await response.json() as { events: ArenaEvent[] };
    expect(eventReads.at(-1)).toEqual(['entry', 'exit', 'param_change', 'status']);
    expect(body.events.map((event) => event.type)).toEqual(['entry', 'status']);
    const text = JSON.stringify(body);
    expect(text).not.toContain('nansen');
    expect(text).not.toContain('private:');
    expect(text).not.toContain('WalletX');
    expect(text).not.toContain('PrivMint');
    expect(body.events[0]).toMatchObject({ summary: 'Bought $20 of WIF via addon', data: { source: 'addon', sizeUsd: 20 } });
  });

  test('lead pre-freeze: a USER param_change event has no reason and a summary rebuilt from the diff', async () => {
    const { routes, call, deps } = app();
    await call('POST', '/me/launch', launchBody());
    const readEvents = deps.readEvents;
    deps.readEvents = async (agentId, after, limit, types) => [...(await readEvents(agentId, after, limit, types)), PARAM_EVENT];
    const body = await (await routes.request(`/agents/${AGENT_ID}/events`)).json() as { events: ArenaEvent[] };
    const change = body.events.find((event) => event.type === 'param_change')!;
    expect(change.summary).toBe('Changed 1 setting: exits.max_hold_s 900 -> 600');
    expect(change.data).toEqual({ source: 'user', paramsVersion: 2, changes: [{ path: 'exits.max_hold_s', from: 900, to: 600 }] });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  test('Codex r2 #2: the OWNER reads every type unredacted via GET /me/events (private, no-store)', async () => {
    const { call, eventReads, eventAgents } = app();
    expect((await call('GET', '/me/events')).status).toBe(404);
    await call('POST', '/me/launch', launchBody());
    const response = await call('GET', '/me/events');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json() as { agentId: string; events: ArenaEvent[]; lastId: number };
    expect(eventReads.at(-1)).toBeNull();
    expect(eventAgents.at(-1)).toBe(AGENT_ID);
    expect(body.agentId).toBe(AGENT_ID);
    expect(body.events.map((event) => event.type)).toEqual(['skip', 'scan', 'pass', 'addon', 'entry', 'status']);
    // Unredacted for the owner: the private source and the wallet stay.
    expect(JSON.stringify(body)).toContain('private:nansen-token-screener-sol');
    expect(JSON.stringify(body)).toContain('WalletX');
    expect(body.lastId).toBe(7);
    const next = await (await call('GET', '/me/events?after=6')).json() as { events: ArenaEvent[]; lastId: number };
    expect(next.events.map((event) => event.id)).toEqual([7]);
    expect((await call('GET', '/me/events?limit=0')).status).toBe(400);
    expect((await call('GET', '/me/events?limit=101')).status).toBe(400);
  });

  test('/me/events: another account never reads this stream (no id in the path; it resolves its own agent)', async () => {
    const { call, eventAgents } = app();
    await call('POST', '/me/launch', launchBody());
    const before = eventAgents.length;
    const other = await call('GET', '/me/events', undefined, { 'x-test-user': OTHER });
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ code: 'no_agent' });
    // The other account's agent session resolves to the other account, too.
    const otherAgent = await call('GET', '/me/events', undefined, { 'x-test-user': OTHER, 'x-test-kind': 'agent' });
    expect(otherAgent.status).toBe(404);
    expect(eventAgents.length).toBe(before);
    // The owner's own agent session reads the owner's stream.
    const ownAgent = await call('GET', '/me/events', undefined, { 'x-test-user': USER, 'x-test-kind': 'agent' });
    expect(ownAgent.status).toBe(200);
    expect(eventAgents.at(-1)).toBe(AGENT_ID);
  });

  test('/me/events with the real auth chain: 401 without a cookie or agent header', async () => {
    const state = makeDeps();
    const routes = createFloorArenaRoutes(state.deps);
    expect((await routes.request('/me/events')).status).toBe(401);
  });

  test('Codex r2 #1/#2: a USER profile shows strategy, state and results only; a HOUSE profile keeps everything', async () => {
    const { routes, call, agents } = app();
    await call('POST', '/me/launch', launchBody({ addons: [{ id: 'feed-a', dailyCapUsd: 2 }] }));
    agents.set(AGENT_ID, { ...agents.get(AGENT_ID)!, provisionState: 'ready', clawpumpAgentId: 'cp', clawpumpWallet: 'WalletX' });
    const user = await (await routes.request(`/agents/${AGENT_ID}`)).json() as Record<string, any>;
    expect(Object.keys(user.agent).sort()).toEqual([
      'createdAt', 'id', 'kind', 'mode', 'name', 'params', 'paramsVersion', 'seatIndex', 'seated', 'status', 'templateId',
    ]);
    expect(user.latestReport).toBeNull();
    expect(user.closedPositions[0]).toMatchObject({ source: 'addon', entryFeatures: null, pnlUsd: 2 });
    expect(user.closedPositions[1]).toMatchObject({ status: 'closed', exitReason: 'unresolved', pnlUsd: null, pnlMult: null });
    expect(user.paramChanges[0]).toMatchObject({ source: 'suggestion', reason: null, changes: [{ path: 'exits.max_hold_s', from: 900, to: 600 }] });
    const text = JSON.stringify(user);
    for (const secret of ['WalletX', 'feed-a', 'nansen', 'private:', 'provisionState', 'paymentAddress', 'private report']) {
      expect(text).not.toContain(secret);
    }
    agents.set('house:genesis', { ...agents.get(AGENT_ID)!, id: 'house:genesis', kind: 'house', ownerUserId: null, addons: [] });
    const house = await (await routes.request('/agents/house:genesis')).json() as Record<string, any>;
    expect(house.agent).toHaveProperty('provisionState');
    expect(house.latestReport).toMatchObject({ summary: 'private report' });
    expect(house.closedPositions[0].source).toBe('private:nansen-token-screener-sol');
    expect(house.paramChanges[0].reason).toContain('private:nansen-token-screener-sol');
  });

  test('tape: limit 1..24 (default 12), newest first, public 5 s cache, numbers as numbers, no owner ids', async () => {
    const { routes, tapeLimits } = app();
    expect((await routes.request('/tape?limit=25')).status).toBe(400);
    expect((await routes.request('/tape?limit=0')).status).toBe(400);
    const response = await routes.request('/tape');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=5');
    const body = await response.json() as { items: Array<Record<string, unknown>>; generatedAt: string };
    expect(body.items[0]).toEqual({
      id: 'exit:100', at: NOW.toISOString(), agentId: 'house:genesis', agentName: 'Genesis', kind: 'house', type: 'exit',
      mint: 'M', symbol: 'WIF', side: 'sell', usd: 22, pnlUsd: 2, pnlMult: 1.1, reason: 'tp',
    });
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(Object.keys(body.items[0]!).sort()).toEqual([
      'agentId', 'agentName', 'at', 'id', 'kind', 'mint', 'pnlMult', 'pnlUsd', 'reason', 'side', 'symbol', 'type', 'usd',
    ]);
    expect(tapeLimits).toEqual([12]);
    await routes.request('/tape?limit=24');
    expect(tapeLimits).toEqual([12, 24]);
  });

  test('discovery and addons validate and answer', async () => {
    const { routes } = app();
    expect((await routes.request('/discovery?limit=0')).status).toBe(400);
    expect((await routes.request('/discovery?limit=100')).status).toBe(200);
    const addons = await (await routes.request('/addons')).json() as { addons: Array<Record<string, unknown>>; minIntervalS: number };
    expect(addons.addons[0]).toEqual({ id: 'feed-a', vendor: 'v', name: 'Feed A', priceUsd: 0.1, minIntervalS: 600, note: 'n' });
    expect(addons.minIntervalS).toBe(600);
  });

  test('mounted before a router with a session-style `use(*)`, the public GET never picks up its cookie', async () => {
    // Mirrors index.ts: '/api/floor/arena' is mounted BEFORE '/api/floor', whose
    // router registers use('*', sessionMiddleware) at '/api/floor/*'.
    const parent = new Hono();
    const floor = new Hono();
    floor.use('*', async (c, next) => { c.header('Set-Cookie', 'auth_session=refreshed', { append: true }); await next(); });
    floor.get('/state', (c) => c.json({}));
    parent.route('/api/floor/arena', app().routes);
    parent.route('/api/floor', floor);
    const response = await parent.request('/api/floor/arena/templates');
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await parent.request('/api/floor/state')).headers.get('set-cookie')).toBe('auth_session=refreshed');
  });
});

describe('authed arena routes', () => {
  test('the default chain is session -> human or agent -> non-guest -> ledger-capable', () => {
    expect(FLOOR_ARENA_AUTH_CHAIN).toEqual([
      sessionMiddleware, requireAuthOrAgentSession, requireNonGuestIdentity, requireLedgerCapableIdentity,
    ] as unknown as MiddlewareHandler[]);
  });

  test('with the real chain, a request with no cookie and no agent header is 401', async () => {
    const state = makeDeps();
    const routes = createFloorArenaRoutes(state.deps);
    const response = await routes.request('/me');
    expect(response.status).toBe(401);
    const launch = await routes.request('/me/launch', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(launch.status).toBe(401);
  });

  test('an agent session that has not proved avatar ownership is refused (real ledger gate)', async () => {
    const { call } = app({ auth: [fakeIdentity, requireLedgerCapableIdentity as unknown as MiddlewareHandler] });
    const refused = await call('POST', '/me/launch', launchBody(), { 'x-test-user': USER, 'x-test-kind': 'agent', 'x-test-ledger': 'false' });
    expect(refused.status).toBe(403);
    const allowed = await call('POST', '/me/launch', launchBody(), { 'x-test-user': USER, 'x-test-kind': 'agent' });
    expect(allowed.status).toBe(201);
  });

  test('GET /me is private and empty before launch', async () => {
    const { call } = app();
    const response = await call('GET', '/me');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      agent: null, paymentAddress: null, provision: null, wallet: null, addons: [], stats: null, latestReport: null,
    });
  });

  test('launch validates the body in order: shape, mode, template, params, add-ons', async () => {
    const { call } = app();
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [launchBody({ extra: 1 }), 400, 'invalid_body'],
      [launchBody({ mode: 'live' }), 400, 'live_not_available'],
      [launchBody({ mode: 'demo' }), 400, 'invalid_body'],
      [launchBody({ templateId: 'nope' }), 400, 'unknown_template'],
      [launchBody({ params: { ...params(), limits: { ...params().limits, position_usd: 50 } } }), 400, 'invalid_params'],
      [launchBody({ addons: [{ id: 'nope' }] }), 400, 'unknown_addon'],
      [launchBody({ addons: [{ id: 'feed-a' }, { id: 'feed-a' }] }), 400, 'duplicate_addon'],
      [launchBody({ addons: [{ id: 'feed-a', dailyCapUsd: 6 }] }), 400, 'invalid_body'],
      [launchBody({ name: '<script>' }), 400, 'invalid_body'],
    ];
    for (const [body, status, code] of cases) {
      const response = await call('POST', '/me/launch', body);
      expect(response.status).toBe(status);
      const json = await response.json() as { code: string; errors?: string[] };
      expect(json.code).toBe(code);
      if (code === 'invalid_params') expect(json.errors!.some((error) => error.includes('position_usd'))).toBe(true);
    }
  });

  test('launch: 201 paper agent named after the avatar, provisioning left to the engine leader, one per account for human AND agent', async () => {
    const { call, log, agents } = app();
    const created = await call('POST', '/me/launch', launchBody({ addons: [{ id: 'feed-a', dailyCapUsd: 2 }] }));
    expect(created.status).toBe(201);
    const body = await created.json() as { agent: Record<string, unknown>; paymentAddress: unknown };
    expect(body.paymentAddress).toBeNull();
    expect(body.agent).toMatchObject({
      id: AGENT_ID, kind: 'user', name: 'Satoshi', templateId: 'genesis', mode: 'paper', status: 'active',
      seated: false, provisionState: 'pending', paymentAddress: null, contestId: 'arena-week-1',
      addons: [{ id: 'feed-a', enabled: true, dailyCapUsd: 2 }],
    });
    expect(body.agent).not.toHaveProperty('ownerUserId');
    // Codex r19 single writer: the request makes no ClawPump call; the row waits as 'pending'.
    expect(agents.get(AGENT_ID)!.provisionState).toBe('pending');
    expect(log.some((line) => line.startsWith('provision'))).toBe(false);
    const again = await call('POST', '/me/launch', launchBody());
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'already_have_agent', agentId: AGENT_ID });
    const viaAgent = await call('POST', '/me/launch', launchBody(), { 'x-test-user': USER, 'x-test-kind': 'agent' });
    expect(viaAgent.status).toBe(409);
    expect(agents.size).toBe(1);
  });

  test('Codex r3 #6: launch enrols in the contest only strictly before endsAt', async () => {
    const atEnd = app();
    atEnd.deps.now = () => new Date(FLOOR_ARENA_CONTEST.endsAt);
    const late = await (await atEnd.call('POST', '/me/launch', launchBody())).json() as { agent: { contestId: string | null } };
    expect(late.agent.contestId).toBeNull();
    const justBefore = app();
    justBefore.deps.now = () => new Date(new Date(FLOOR_ARENA_CONTEST.endsAt).getTime() - 1);
    const onTime = await (await justBefore.call('POST', '/me/launch', launchBody())).json() as { agent: { contestId: string | null } };
    expect(onTime.agent.contestId).toBe(FLOOR_ARENA_CONTEST.id);
  });

  test('reserved names: a house agent name or look-alike gets 400 name_reserved and creates nothing', async () => {
    for (const name of ['Genesis', 'runner', 'Dip-Hunter', 'Mid Cap Climber', 'Late Bl00mer', 'G\u0435nesis', 'Ge\u039desis']) {
      const { call, agents, log } = app();
      const response = await call('POST', '/me/launch', launchBody({ name }));
      expect({ name, status: response.status }).toEqual({ name, status: 400 });
      expect(await response.json()).toEqual({ error: 'That name belongs to a house agent. Choose another name.', code: 'name_reserved' });
      expect(agents.size).toBe(0);
      expect(log.some((line) => line.startsWith('provision'))).toBe(false);
    }
    // Same rule for a connected agent, and the name check runs after the add-on check.
    const { call } = app();
    const viaAgent = await call('POST', '/me/launch', launchBody({ name: 'Runner' }), { 'x-test-user': USER, 'x-test-kind': 'agent' });
    expect(viaAgent.status).toBe(400);
    expect((await viaAgent.json() as { code: string }).code).toBe('name_reserved');
    const addonFirst = await call('POST', '/me/launch', launchBody({ name: 'Runner', addons: [{ id: 'nope' }] }));
    expect((await addonFirst.json() as { code: string }).code).toBe('unknown_addon');
    // A name that only contains a house name is free.
    const free = await call('POST', '/me/launch', launchBody({ name: 'Genesis Fan' }));
    expect(free.status).toBe(201);
  });

  test('reserved names: with no name sent, an avatar named like a house agent gets 400 name_reserved', async () => {
    const reserved = app();
    reserved.deps.readAvatarName = async () => 'Runner';
    const response = await reserved.call('POST', '/me/launch', launchBody());
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe('name_reserved');
    expect(reserved.agents.size).toBe(0);
    // An explicit free name still launches for that account.
    const named = await reserved.call('POST', '/me/launch', launchBody({ name: 'Runner Fan' }));
    expect(named.status).toBe(201);
    // The existing agent wins over the fallback check: a second launch is 409, not 400.
    const again = await reserved.call('POST', '/me/launch', launchBody());
    expect(again.status).toBe(409);
  });

  test('two concurrent launches for one account create one agent', async () => {
    const { call, agents } = app();
    const [a, b] = await Promise.all([call('POST', '/me/launch', launchBody()), call('POST', '/me/launch', launchBody())]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(agents.size).toBe(1);
  });

  test('PATCH /me/params: validates, diffs, bumps the version, and reports a conflict', async () => {
    const { call, updates, conflictOnce } = app();
    expect((await call('PATCH', '/me/params', { params: params() })).status).toBe(404);
    await call('POST', '/me/launch', launchBody());
    const bad = await call('PATCH', '/me/params', { params: { ...params(), extra: 1 } });
    expect(bad.status).toBe(400);
    const same = await call('PATCH', '/me/params', { params: params() });
    expect(await same.json()).toMatchObject({ changes: [], paramsVersion: 1 });
    expect(updates).toHaveLength(0);
    const next = params();
    next.exits.max_hold_s = 1_200;
    const changed = await call('PATCH', '/me/params', { params: next, reason: 'longer hold' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ paramsVersion: 2, changes: [{ path: 'exits.max_hold_s', to: 1_200 }] });
    expect(updates[0]).toMatchObject({ source: 'user', expectedVersion: 1, reason: 'longer hold' });
    expect(updates[0]!.summary).toContain('exits.max_hold_s');
    conflictOnce();
    next.exits.max_hold_s = 1_300;
    expect((await call('PATCH', '/me/params', { params: next })).status).toBe(409);
  });

  test('seat, status and settings write one event each and skip no-ops', async () => {
    const { call, log } = app();
    await call('POST', '/me/launch', launchBody());
    expect((await call('POST', '/me/seat', { seated: true, seatIndex: 6 })).status).toBe(400);
    const sat = await call('POST', '/me/seat', { seated: true, seatIndex: 2 });
    expect(await sat.json()).toMatchObject({ agent: { seated: true, seatIndex: 2 } });
    expect(log.at(-1)).toContain('Sat down at desk 3');
    await call('POST', '/me/seat', { seated: true, seatIndex: 2 });
    expect(log.filter((line) => line.startsWith('Sat down'))).toHaveLength(1);
    const stood = await call('POST', '/me/seat', { seated: false, seatIndex: 4 });
    expect(await stood.json()).toMatchObject({ agent: { seated: false, seatIndex: null } });
    expect((await call('POST', '/me/status', { status: 'stopped' })).status).toBe(400);
    expect(await (await call('POST', '/me/status', { status: 'paused' })).json()).toMatchObject({ agent: { status: 'paused' } });
    expect(await (await call('PATCH', '/me/settings', { autoApplySuggestions: true })).json()).toMatchObject({ agent: { autoApplySuggestions: true } });
  });

  test('PATCH /me/addons caps the enabled sum at $5 and writes only the DB row', async () => {
    const { call, agents } = app();
    await call('POST', '/me/launch', launchBody());
    const over = normaliseAddons([{ id: 'feed-a', dailyCapUsd: 5 }, { id: 'feed-b', dailyCapUsd: 1 }], [FEED, { ...FEED, id: 'feed-b' }]);
    expect(over).toMatchObject({ ok: false, code: 'addon_cap_exceeded' });
    const ok = await call('PATCH', '/me/addons', { addons: [{ id: 'feed-a', enabled: true, dailyCapUsd: 3 }] });
    expect(ok.status).toBe(200);
    agents.set(AGENT_ID, { ...agents.get(AGENT_ID)!, provisionState: 'ready', clawpumpAgentId: 'cp', clawpumpWallet: 'W' });
    const me = await call('PATCH', '/me/addons', { addons: [{ id: 'feed-a', enabled: false }] });
    expect(await me.json()).toMatchObject({ paymentAddress: 'W', addons: [{ id: 'feed-a', enabled: false, dailyCapUsd: 1 }] });
    expect(agents.get(AGENT_ID)!.addons).toEqual([{ id: 'feed-a', enabled: false, dailyCapUsd: 1 }]);
  });

  test('suggestions: apply through the same params path, dismiss, and refuse foreign or stale reports', async () => {
    const { call, reports, updates } = app();
    await call('POST', '/me/launch', launchBody());
    const report = (overrides: Partial<ArenaReport> = {}): ArenaReport => ({
      id: REPORT_ID, agentId: AGENT_ID, periodStart: NOW.toISOString(), periodEnd: NOW.toISOString(), stats: {},
      summary: 's', suggestion: { path: 'exits.max_hold_s', from: 900, to: 600, reason: 'faster exits' },
      suggestionState: 'pending', createdAt: NOW.toISOString(), ...overrides,
    });
    expect((await call('POST', '/me/suggestions/not-a-uuid', { action: 'apply' })).status).toBe(404);
    reports.set(REPORT_ID, report({ agentId: 'someone-else' }));
    expect((await call('POST', `/me/suggestions/${REPORT_ID}`, { action: 'apply' })).status).toBe(404);

    reports.set(REPORT_ID, report());
    const applied = await call('POST', `/me/suggestions/${REPORT_ID}`, { action: 'apply' });
    expect(applied.status).toBe(200);
    expect(updates.at(-1)).toMatchObject({ source: 'suggestion', reason: 'faster exits', report: { id: REPORT_ID, state: 'applied' } });
    expect(reports.get(REPORT_ID)!.suggestionState).toBe('applied');
    expect((await call('POST', `/me/suggestions/${REPORT_ID}`, { action: 'dismiss' })).status).toBe(409);

    reports.set(REPORT_ID, report());
    const dismissed = await call('POST', `/me/suggestions/${REPORT_ID}`, { action: 'dismiss' });
    expect(await dismissed.json()).toMatchObject({ report: { suggestionState: 'dismissed' } });

    reports.set(REPORT_ID, report({ suggestion: { path: 'exits.max_hold_s', from: 900, to: 5, reason: 'x' } }));
    const invalid = await call('POST', `/me/suggestions/${REPORT_ID}`, { action: 'apply' });
    expect(invalid.status).toBe(400);
    expect(reports.get(REPORT_ID)!.suggestionState).toBe('rejected');

    reports.set(REPORT_ID, report({ suggestion: { path: 'limits.nope', from: 1, to: 2, reason: 'x' } }));
    expect((await call('POST', `/me/suggestions/${REPORT_ID}`, { action: 'apply' })).status).toBe(400);
    expect(reports.get(REPORT_ID)!.suggestionState).toBe('rejected');

    reports.set(REPORT_ID, report({ suggestion: { path: 'limits.position_usd', from: 20, to: 30, reason: 'x' } }));
    expect((await call('POST', `/me/suggestions/${REPORT_ID}`, { action: 'apply' })).status).toBe(400);

    // Stale: the owner changed max_hold_s (900 -> 600 above) after this report was written.
    const before = updates.length;
    reports.set(REPORT_ID, report({ suggestion: { path: 'exits.max_hold_s', from: 900, to: 1_200, reason: 'x' } }));
    const stale = await call('POST', `/me/suggestions/${REPORT_ID}`, { action: 'apply' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'suggestion_stale' });
    expect(reports.get(REPORT_ID)!.suggestionState).toBe('rejected');
    expect(updates.length).toBe(before);

    // Already at the target value: the suggestion counts as applied, no write.
    reports.set(REPORT_ID, report({ suggestion: { path: 'exits.max_hold_s', from: 900, to: 600, reason: 'x' } }));
    const satisfied = await call('POST', `/me/suggestions/${REPORT_ID}`, { action: 'apply' });
    expect(satisfied.status).toBe(200);
    expect(await satisfied.json()).toMatchObject({ changes: [] });
    expect(reports.get(REPORT_ID)!.suggestionState).toBe('applied');
    expect(updates.length).toBe(before);
  });

  test('audit-contest B1: launch and seat write an anti-sybil event with fp/ip from the request context', async () => {
    const { call, logged } = app();
    await call('POST', '/me/launch', launchBody());
    expect(logged).toEqual([{
      input: {
        eventType: 'floor_arena.launch', userId: USER, avatarId: AVATAR, agentId: null,
        payload: { arenaAgentId: AGENT_ID, templateId: 'genesis', identityKind: 'user', contestId: 'arena-week-1' },
      },
      fpHash: `fp-${USER}`,
      ipPrefixHash: 'ip-203.0.113',
    }]);
    // A refused launch (409) writes nothing.
    await call('POST', '/me/launch', launchBody());
    expect(logged).toHaveLength(1);
    // Seating writes one; standing up and a no-op re-seat write none.
    await call('POST', '/me/seat', { seated: true, seatIndex: 1 }, { 'x-test-user': USER, 'x-test-kind': 'agent' });
    expect(logged[1]).toMatchObject({
      input: { eventType: 'floor_arena.seat', userId: USER, agentId: 'bot-1', payload: { arenaAgentId: AGENT_ID, seatIndex: 1, identityKind: 'agent' } },
      fpHash: `fp-${USER}`,
    });
    await call('POST', '/me/seat', { seated: true, seatIndex: 1 });
    await call('POST', '/me/seat', { seated: false });
    expect(logged).toHaveLength(2);
  });

  test('Codex r19 single writer: no request route can reach a ClawPump write (no provisioning import, writer types only)', () => {
    for (const file of ['../floor-arena.ts', '../admin-floor-arena.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/floor-arena\/provisioning/);
      expect(source).not.toMatch(/\b(ensureAddonSkill|removeArenaX402|reconcileArenaX402|provisionArenaAgent|clawPumpArenaWriter|updateClawPumpAgent|x402PayViaClawPump|createClawPumpAgent)\b/);
      for (const line of source.split('\n').filter((text) => text.includes("from '../services/clawpump-writer'"))) {
        expect(line.startsWith('import type ')).toBe(true);
      }
    }
  });

  test('writes are rate limited per account, shared by the human and the agent', async () => {
    const { call } = app({ writeMax: 2 });
    await call('POST', '/me/launch', launchBody());
    expect((await call('POST', '/me/seat', { seated: true })).status).toBe(200);
    expect((await call('POST', '/me/seat', { seated: false }, { 'x-test-user': USER, 'x-test-kind': 'agent' })).status).toBe(200);
    const limited = await call('POST', '/me/seat', { seated: true }, { 'x-test-user': USER, 'x-test-kind': 'agent' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'rate_limited' });
    const other = await call('POST', '/me/seat', { seated: true }, { 'x-test-user': OTHER });
    expect(other.status).toBe(404);
  });
});

describe('admin arena routes', () => {
  test('every operator route is 401 without a session (session + moneyOperatorOnly guard)', async () => {
    const { adminFloorArenaRoutes } = await import('../admin-floor-arena');
    const json = { 'content-type': 'application/json', origin: 'http://localhost' };
    expect((await adminFloorArenaRoutes.request('/engine/state')).status).toBe(401);
    expect((await adminFloorArenaRoutes.request('/engine/pause', { method: 'POST', headers: json, body: '{}' })).status).toBe(401);
    expect((await adminFloorArenaRoutes.request('/engine/resume', { method: 'POST', headers: json, body: '{}' })).status).toBe(401);
    expect((await adminFloorArenaRoutes.request('/house/house:genesis/params', {
      method: 'POST', headers: json, body: JSON.stringify({ params: params(), reason: 'x' }),
    })).status).toBe(401);
    // Money audit N4: the operator re-provision route sits behind the same guard.
    expect((await adminFloorArenaRoutes.request(`/agents/${AGENT_ID}/reprovision`, { method: 'POST', headers: json, body: '{}' })).status).toBe(401);
  });
});

describe('helpers', () => {
  test('describeChanges renders null as off and arrays as JSON', () => {
    expect(describeChanges([
      { path: 'exits.stop_mult', from: null, to: 0.7 },
      { path: 'exits.tp', from: [[1.1, 1]], to: [[1.2, 1]] },
    ])).toBe('Changed 2 settings: exits.stop_mult off -> 0.7; exits.tp [[1.1,1]] -> [[1.2,1]]');
  });
});
