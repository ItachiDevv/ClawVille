import { beforeEach, describe, expect, test } from 'bun:test';
import { FLOOR_ARENA_HOUSE_AGENTS, FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS } from '@clawville/shared';
import {
  CLAWPUMP_BACKEND_ORIGIN,
  CLAWPUMP_HOUSE_AGENT_IDS,
  CLAWPUMP_LIVE_TRADER_AGENT_IDS,
  CLAWPUMP_VERIFIED_BACKEND_POSTS,
  isLiveTraderClawPumpId,
  readArenaWalletLive,
  arenaAgentNamePrefix,
  arenaAgentNameSuffix,
  isArenaAgentName,
  CLAWPUMP_WRITER_BURST,
  CLAWPUMP_WRITER_CALLS_PER_MINUTE,
  CLAWPUMP_WRITER_REMOVAL_RESERVE,
  ClawPumpWriterError,
  clawPumpWriterBudget,
  _resetClawPumpBackendSessionForTest,
  _resetClawPumpWriterRateForTest,
  agentHasSkill,
  clawPumpArenaWriter,
  readClawPumpArenaAgent,
  readClawPumpArenaListing,
  createClawPumpAgent,
  getClawPumpWalletBalances,
  updateClawPumpAgent,
  x402PayCheck,
  x402PayViaClawPump,
  type ClawPumpWriterOptions,
} from '../clawpump-writer';
import { mayHaveCharged } from '../floor-arena/addons';

const KEY = 'cpk_test_not_a_real_key';
const TOKEN = 'eyJ.test-backend-token.not-real';
const env = { CLAWPUMP_API_KEY: KEY, CLAWVILLE_ENV: 'production' };
const stagingEnv = { CLAWPUMP_API_KEY: KEY, CLAWVILLE_ENV: 'staging' };
/** The arena row that owns the ClawPump agent in these tests (names end with its id suffix). */
const ROW_ID = 'abcd1234-0000-4000-8000-000000000000';
const OWNED = { arenaAgentId: ROW_ID, isOwnedBy: async () => true };
const ARENA_ID = '11111111-2222-4333-8444-555555555555';
const HOUSE_ID = '0f600d73-05a0-4c2e-8215-ab2a770ba192';
const NAME = 'CV Arena · Bob #abcd12340000';
const WALLET = 'So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx';
/** Test seam: the x402 backend routes treated as verified (they are NOT verified in production). */
const X402_VERIFIED: ClawPumpWriterOptions = { _testVerifiedBackendPosts: new Set(['x402']) };

interface Call { method: string; url: string; body: unknown; auth: string | null }

/**
 * Route key for a URL: the v1 path after /api/v1, `be:<path>` on the backend host, `TOKEN` for the key
 * exchange; anything else gets null (so it routes to 404).
 */
function apiPath(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.origin === 'https://clawpump.tech' && parsed.pathname === '/api/mcp/token') return 'TOKEN';
  if (parsed.origin === CLAWPUMP_BACKEND_ORIGIN) return `be:${parsed.pathname}`;
  if (parsed.origin !== 'https://clawpump.tech' || !parsed.pathname.startsWith('/api/v1/')) return null;
  return parsed.pathname.slice('/api/v1'.length);
}

/** `calls` holds every request except the key exchange (answered by default, recorded in `tokenCalls`). */
function fakeFetch(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const tokenCalls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const call: Call = {
      method,
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: headers.get('authorization'),
    };
    const path = apiPath(url);
    if (path === 'TOKEN') {
      tokenCalls.push(call);
      return json({ access_token: TOKEN, api_url: CLAWPUMP_BACKEND_ORIGIN, user_id: 'user-not-real', expires_in: 3600, tier: 'enterprise' });
    }
    calls.push(call);
    const handler = path === null ? undefined : routes[`${method} ${path}`];
    if (!handler) return new Response('{"error":"Not Found"}', { status: 404 });
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls, tokenCalls };
}

beforeEach(() => {
  _resetClawPumpWriterRateForTest();
  _resetClawPumpBackendSessionForTest();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A v1 agent reply (camelCase; GET /api/v1/agents/{id} shape of 2026-11-18). */
const agentBody = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, status: 'stopped', walletAddress: WALLET, tokenAddress: null,
  skills: ['portfolio', 'x402', 'trading', 'action-plans'], model: null, persona: '', avatarUrl: null, isPublic: true,
  createdAt: '2026-11-16T15:17:22.589401+00:00', updatedAt: '2026-11-16T15:17:22.589401+00:00',
  meta: { timestamp: '2026-11-18T03:45:13.322Z', requestId: 'req-not-real' },
  ...extra,
});
const routeKey = (call: Call) => `${call.method} ${apiPath(call.url)}`;

describe('createClawPumpAgent (v1 POST /agents)', () => {
  test('POSTs the flat documented fields once, with the Bearer key, reads the camelCase reply, and never retries', async () => {
    const { fetchImpl, calls, tokenCalls } = fakeFetch({ 'POST /agents': () => json(agentBody(ARENA_ID, NAME), 201) });
    const created = await createClawPumpAgent({ name: NAME, persona: 'persona', system_prompt: 'prompt' }, { env, fetchImpl });
    // The wallet is read from `walletAddress` (it parsed as null before 2026-11-19).
    expect(created).toEqual({
      id: ARENA_ID, name: NAME, status: 'stopped', walletAddress: WALLET,
      skills: ['portfolio', 'x402', 'trading', 'action-plans'], isPublic: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://clawpump.tech/api/v1/agents');
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
    // No `config`, no `enabled_skills`, no `is_public`, no `skills`, no `strategy`.
    expect(calls[0]!.body).toEqual({ name: NAME, persona: 'persona', system_prompt: 'prompt' });
    expect(tokenCalls).toHaveLength(0);
    const withModel = fakeFetch({ 'POST /agents': () => json(agentBody(ARENA_ID, NAME), 201) });
    await createClawPumpAgent({ name: NAME, persona: 'p', system_prompt: 's', model: 'm' }, { env, fetchImpl: withModel.fetchImpl });
    expect(withModel.calls[0]!.body).toEqual({ name: NAME, persona: 'p', system_prompt: 's', model: 'm' });

    const failing = fakeFetch({ 'POST /agents': () => json({ error: 'boom' }, 500) });
    await expect(createClawPumpAgent({ name: NAME, persona: 'p', system_prompt: 's' }, { env, fetchImpl: failing.fetchImpl }))
      .rejects.toMatchObject({ code: 'http_error', status: 500 });
    expect(failing.calls).toHaveLength(1);
  });

  test('a wrapped {agent} reply parses too; a reply without isPublic gives null (never "private")', async () => {
    const { fetchImpl } = fakeFetch({ 'POST /agents': () => json({ agent: agentBody(ARENA_ID, NAME, { isPublic: undefined }) }, 201) });
    expect((await createClawPumpAgent({ name: NAME, persona: 'p', system_prompt: 's' }, { env, fetchImpl })).isPublic).toBeNull();
  });

  test('refuses old body fields and a non-arena name before any request', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    for (const extra of [{ enabled_skills: [] }, { is_public: false }, { skills: ['trading'] }, { strategy: 'monitor-exit' }]) {
      await expect(createClawPumpAgent({ name: NAME, persona: 'p', system_prompt: 's', ...extra } as never, { env, fetchImpl }))
        .rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(createClawPumpAgent({ name: 'Genesis', persona: 'p', system_prompt: 's' }, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls).toHaveLength(0);
  });

  test('reports not_configured without a key, and the error text never holds the key', async () => {
    const { fetchImpl } = fakeFetch({ 'POST /agents': () => json({}, 401) });
    await expect(createClawPumpAgent({ name: 'CV Arena · A', persona: 'p', system_prompt: 's' }, { env: { CLAWVILLE_ENV: 'production' }, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_configured' });
    const error = await createClawPumpAgent({ name: 'CV Arena · A', persona: 'p', system_prompt: 's' }, { env, fetchImpl })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ClawPumpWriterError);
    expect((error as Error).message).toBe('clawpump_unauthorized_401');
    expect((error as Error).message).not.toContain(KEY);
  });
});

describe('updateClawPumpAgent (v1 POST /agents/{id}, privacy only)', () => {
  const routes = (name: string = NAME, extra: Record<string, unknown> = {}) => fakeFetch({
    [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, name, extra)),
    [`POST /agents/${ARENA_ID}`]: () => json({ ok: true }),
  });

  test('POSTs (never PATCH) exactly {is_public:false} or {accepting_bids:false}, after the arena-name guard GET', async () => {
    const { fetchImpl, calls } = routes();
    await updateClawPumpAgent(ARENA_ID, { is_public: false }, OWNED, { env, fetchImpl });
    await updateClawPumpAgent(ARENA_ID, { accepting_bids: false }, OWNED, { env, fetchImpl });
    expect(calls.map(routeKey)).toEqual([
      `GET /agents/${ARENA_ID}`, `POST /agents/${ARENA_ID}`, `GET /agents/${ARENA_ID}`, `POST /agents/${ARENA_ID}`,
    ]);
    expect(calls[1]!.body).toEqual({ is_public: false });
    expect(calls[3]!.body).toEqual({ accepting_bids: false });
    expect(calls[1]!.auth).toBe(`Bearer ${KEY}`);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  test('refuses camelCase, two fields in one body, true, skills or any other field before any request', async () => {
    const { fetchImpl, calls } = routes();
    for (const patch of [
      { isPublic: false }, { is_public: true }, { accepting_bids: true }, { is_public: false, accepting_bids: false },
      { enabled_skills: [] }, { skills: ['x402'] }, { name: 'x' }, {},
    ]) {
      await expect(updateClawPumpAgent(ARENA_ID, patch as never, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(calls).toHaveLength(0);
  });

  test('goes through at any ClawPump status (it only takes visibility away)', async () => {
    for (const status of ['running', 'stopped', null, 'starting']) {
      _resetClawPumpWriterRateForTest();
      const { fetchImpl, calls } = routes(NAME, { status });
      await updateClawPumpAgent(ARENA_ID, { is_public: false }, OWNED, { env, fetchImpl });
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    }
  });

  test('a v1 400 (for example an unknown field) is an http_error, not a silent success', async () => {
    const { fetchImpl } = fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, NAME)),
      [`POST /agents/${ARENA_ID}`]: () => json({ error: 'No allowed fields in request body' }, 400),
    });
    await expect(updateClawPumpAgent(ARENA_ID, { is_public: false }, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'http_error', status: 400 });
  });

  test('never touches a house agent (name without the arena prefix)', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${HOUSE_ID}`]: () => json(agentBody(HOUSE_ID, 'Genesis')),
      [`POST /agents/${HOUSE_ID}`]: () => json({}),
    });
    await expect(updateClawPumpAgent(HOUSE_ID, { is_public: false }, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls).toHaveLength(0);
  });
});

describe('reads', () => {
  test('readClawPumpArenaAgent reads the v1 camelCase agent (wallet, skills, isPublic)', async () => {
    const { fetchImpl } = fakeFetch({ [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, NAME)) });
    expect(await readClawPumpArenaAgent(ARENA_ID, { env, fetchImpl })).toMatchObject({
      walletAddress: WALLET, skills: ['portfolio', 'x402', 'trading', 'action-plans'], isPublic: true,
    });
    await expect(readClawPumpArenaAgent('nope', { env, fetchImpl })).rejects.toMatchObject({ code: 'invalid_agent_id' });
    // The old snake_case reply no longer yields a wallet or skills.
    const old = fakeFetch({ [`GET /agents/${ARENA_ID}`]: () => json({ id: ARENA_ID, name: NAME, wallet_address: WALLET, enabled_skills: ['x402'] }) });
    expect(await readClawPumpArenaAgent(ARENA_ID, { env, fetchImpl: old.fetchImpl })).toMatchObject({ walletAddress: null, skills: null, isPublic: null });
  });

  test('readClawPumpArenaListing reads is_public and accepting_bids from the backend GET with the exchanged token', async () => {
    const { fetchImpl, calls, tokenCalls } = fakeFetch({
      [`GET be:/agents/${ARENA_ID}`]: () => json({
        id: ARENA_ID, name: NAME, status: 'stopped', wallet_address: WALLET, enabled_skills: ['x402', 'defi-trading'],
        is_public: false, accepting_bids: true, created_at: '2026-11-16T15:17:22Z',
      }),
    });
    expect(await readClawPumpArenaListing(ARENA_ID, { env, fetchImpl })).toEqual({ id: ARENA_ID, isPublic: false, acceptingBids: true });
    expect(calls.map(routeKey)).toEqual([`GET be:/agents/${ARENA_ID}`]);
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.url).toBe('https://clawpump.tech/api/mcp/token');
    expect(tokenCalls[0]!.auth).toBe(`Bearer ${KEY}`);
    // A missing field is null; a reply for another id is refused.
    const missing = fakeFetch({ [`GET be:/agents/${ARENA_ID}`]: () => json({ id: ARENA_ID }) });
    expect(await readClawPumpArenaListing(ARENA_ID, { env, fetchImpl: missing.fetchImpl })).toEqual({ id: ARENA_ID, isPublic: null, acceptingBids: null });
    const other = fakeFetch({ [`GET be:/agents/${ARENA_ID}`]: () => json({ id: HOUSE_ID, is_public: false, accepting_bids: false }) });
    await expect(readClawPumpArenaListing(ARENA_ID, { env, fetchImpl: other.fetchImpl })).rejects.toMatchObject({ code: 'schema_invalid' });
  });

  test('the key never goes to the backend host, and the token never goes to clawpump.tech', async () => {
    const { fetchImpl, calls, tokenCalls } = fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, NAME)),
      [`GET be:/agents/${ARENA_ID}`]: () => json({ id: ARENA_ID, is_public: false, accepting_bids: false }),
      'GET be:/wallets/summary': () => json({ wallets: [] }),
    });
    await readClawPumpArenaAgent(ARENA_ID, { env, fetchImpl });
    await readClawPumpArenaListing(ARENA_ID, { env, fetchImpl });
    await getClawPumpWalletBalances({ env, fetchImpl });
    for (const call of calls) {
      const backend = new URL(call.url).origin === CLAWPUMP_BACKEND_ORIGIN;
      expect(call.auth).toBe(backend ? `Bearer ${TOKEN}` : `Bearer ${KEY}`);
    }
    // One exchange for the two backend reads (cached).
    expect(tokenCalls).toHaveLength(1);
  });

  test('wallet summaries (backend, snake_case) map UI-unit numbers and numeric strings', async () => {
    const OTHER_CP_ID = '22222222-3333-4444-8555-666666666666';
    const { fetchImpl } = fakeFetch({
      'GET be:/wallets/summary': () => json({ wallets: [
        { agent_id: ARENA_ID, wallet_address: 'W1', sol_balance: 0.08, usdc_balance: '61.33', ansem_balance: 0, updated_at: '2026-11-19T18:02:18.659Z' },
        { agent_id: OTHER_CP_ID, wallet_address: null, sol_balance: 0, usdc_balance: null },
      ] }),
    });
    expect(await getClawPumpWalletBalances({ env, fetchImpl })).toEqual([
      { agentId: ARENA_ID, walletAddress: 'W1', sol: 0.08, usdc: 61.33, updatedAt: '2026-11-19T18:02:18.659Z' },
      { agentId: OTHER_CP_ID, walletAddress: null, sol: 0, usdc: null, updatedAt: null },
    ]);
  });

  test('Codex r18 #4: the arena writer has no list-by-name (provisioning never adopts)', () => {
    expect(Object.keys(clawPumpArenaWriter).sort()).toEqual(['createAgent', 'getWalletBalances', 'readAgent', 'readListing', 'updateAgent', 'x402Pay']);
  });

  test('agentHasSkill matches trimmed, any case; null skills never match', () => {
    expect(agentHasSkill({ skills: [' X402 ', 'trading'] }, 'x402')).toBe(true);
    expect(agentHasSkill({ skills: ['trading'] }, 'x402')).toBe(false);
    expect(agentHasSkill({ skills: null }, 'x402')).toBe(false);
  });
});

describe('money audit N1: the env-correct prefix and the house-agent ids', () => {
  test('production accepts only "CV Arena · ", staging only "CV Arena (staging) · "', async () => {
    const routes = (name: string) => fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, name)),
      [`POST /agents/${ARENA_ID}`]: () => json({}),
    });
    const prodName = routes(NAME);
    await expect(updateClawPumpAgent(ARENA_ID, { is_public: false }, OWNED, { env: stagingEnv, fetchImpl: prodName.fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    const stagingName = routes('CV Arena (staging) · Bob #abcd12340000');
    await expect(updateClawPumpAgent(ARENA_ID, { is_public: false }, OWNED, { env, fetchImpl: stagingName.fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    await updateClawPumpAgent(ARENA_ID, { is_public: false }, OWNED, { env: stagingEnv, fetchImpl: stagingName.fetchImpl });
    expect(stagingName.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(isArenaAgentName('CV Arena (staging) · X', stagingEnv)).toBe(true);
    expect(isArenaAgentName('CV Arena · X', stagingEnv)).toBe(false);
    expect(arenaAgentNamePrefix({})).toBe('CV Arena (staging) · ');
    const { fetchImpl, calls } = fakeFetch({});
    await expect(createClawPumpAgent({ name: NAME, persona: 'p', system_prompt: 's' }, { env: stagingEnv, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls).toHaveLength(0);
  });

  test('a house trader id is refused even when ClawPump reports an arena name', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${HOUSE_ID}`]: () => json(agentBody(HOUSE_ID, 'CV Arena · Genesis')),
      [`POST /agents/${HOUSE_ID}`]: () => json({}),
    });
    expect(CLAWPUMP_HOUSE_AGENT_IDS.has(HOUSE_ID)).toBe(true);
    await expect(updateClawPumpAgent(HOUSE_ID, { is_public: false }, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
    await expect(x402PayViaClawPump(HOUSE_ID, { url: 'https://api.nansen.ai/x', method: 'GET', maxAmountUsd: 0.1 }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls).toHaveLength(0);
  });

  test('SPEC T3: the deny set IS the 3 live trader ids, never empty, never derived from the (now null) house seed', () => {
    const LIVE = [
      '0f600d73-05a0-4c2e-8215-ab2a770ba192',
      '1a0a153e-cc2c-4b2a-8a38-04e4417ce3c1',
      'a7d7c928-1725-4c1d-8d4c-b6eed7af559b',
    ];
    expect(CLAWPUMP_LIVE_TRADER_AGENT_IDS.size).toBe(3);
    expect([...CLAWPUMP_LIVE_TRADER_AGENT_IDS].sort()).toEqual([...LIVE].sort());
    expect([...FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS as readonly string[]].sort()).toEqual([...LIVE].sort());
    for (const id of LIVE) {
      expect(isLiveTraderClawPumpId(id)).toBe(true);
      expect(isLiveTraderClawPumpId(id.toUpperCase())).toBe(true);
    }
    expect(CLAWPUMP_HOUSE_AGENT_IDS).toBe(CLAWPUMP_LIVE_TRADER_AGENT_IDS);
    expect(isLiveTraderClawPumpId(ARENA_ID)).toBe(false);
    expect(isLiveTraderClawPumpId(null)).toBe(false);
    expect(FLOOR_ARENA_HOUSE_AGENTS.every((house) => house.clawpumpAgentId === null)).toBe(true);
  });

  test('SPEC T3: each live id is refused for update, listing, pay and live wallet read EVEN when a row names it', async () => {
    for (const liveId of FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS) {
      const name = 'CV Arena · Genesis #housegenesis';
      const { fetchImpl, calls, tokenCalls } = fakeFetch({
        [`GET /agents/${liveId}`]: () => json(agentBody(liveId, name)),
        [`POST /agents/${liveId}`]: () => json({}),
        [`GET be:/agents/${liveId}`]: () => json({ id: liveId, is_public: false, accepting_bids: false }),
        [`POST be:/agents/${liveId}/x402/x402_service_pay`]: () => json({ data: {} }),
        [`GET be:/wallets/${liveId}/history`]: () => json({}),
      });
      for (const arenaAgentId of ['house:genesis', ROW_ID]) {
        const asked: string[] = [];
        const rowNamesIt = { arenaAgentId, isOwnedBy: async (id: string) => { asked.push(id); return true; } };
        await expect(updateClawPumpAgent(liveId, { is_public: false }, rowNamesIt, { env, fetchImpl }))
          .rejects.toMatchObject({ code: 'not_arena_agent' });
        await expect(x402PayViaClawPump(liveId, { url: 'https://api.nansen.ai/x', method: 'GET', maxAmountUsd: 0.1 }, rowNamesIt, { env, fetchImpl, ...X402_VERIFIED }))
          .rejects.toMatchObject({ code: 'not_arena_agent' });
        await expect(readArenaWalletLive(liveId, rowNamesIt, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
        await expect(readClawPumpArenaListing(liveId, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
        await expect(clawPumpArenaWriter.updateAgent(liveId, { is_public: false }, arenaAgentId)).rejects.toMatchObject({ code: 'not_arena_agent' });
        expect(asked).toEqual([]);
      }
      expect(calls).toHaveLength(0);
      expect(tokenCalls).toHaveLength(0);
    }
  });

  test('Codex P1: every read path refuses each live id with ZERO HTTP calls (read agent, listing, x402 check, writer surface)', async () => {
    for (const liveId of FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS) {
      for (const id of [liveId, liveId.toUpperCase()]) {
        const { fetchImpl, calls } = fakeFetch({
          [`GET /agents/${id}`]: () => json(agentBody(id, 'CV Arena · Genesis #housegenesis')),
          [`POST be:/agents/${id}/x402/x402_service_details`]: () => json({ data: {} }),
        });
        await expect(readClawPumpArenaAgent(id, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
        await expect(readClawPumpArenaAgent(id, { env, fetchImpl, priority: 'removal' })).rejects.toMatchObject({ code: 'not_arena_agent' });
        await expect(x402PayCheck(id, 'https://api.nansen.ai/x', 'GET', { env, fetchImpl, ...X402_VERIFIED })).rejects.toMatchObject({ code: 'not_arena_agent' });
        expect(calls).toHaveLength(0);
      }
      await expect(clawPumpArenaWriter.readAgent(liveId)).rejects.toMatchObject({ code: 'not_arena_agent' });
      await expect(clawPumpArenaWriter.readListing(liveId, 'removal')).rejects.toMatchObject({ code: 'not_arena_agent' });
      await expect(clawPumpArenaWriter.x402Pay(liveId, { url: 'https://api.nansen.ai/x', method: 'GET', maxAmountUsd: 0.1 }, ROW_ID))
        .rejects.toMatchObject({ code: 'not_arena_agent' });
    }
  });

  test('Codex P1: the wallet summary never returns a live trader row (any case); other rows pass through', async () => {
    const live = FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS as readonly string[];
    const { fetchImpl, calls } = fakeFetch({
      'GET be:/wallets/summary': () => json({
        wallets: [
          ...live.map((id) => ({ agent_id: id, wallet_address: `Live${id.slice(0, 4)}`, sol_balance: 5, usdc_balance: 100 })),
          { agent_id: live[0]!.toUpperCase(), wallet_address: 'LiveUpper', sol_balance: 1, usdc_balance: 1 },
          { agent_id: ARENA_ID, wallet_address: 'ArenaWallet', sol_balance: 0.01, usdc_balance: 2 },
        ],
      }),
    });
    const balances = await getClawPumpWalletBalances({ env, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(balances.map((row) => row.agentId)).toEqual([ARENA_ID]);
    expect(balances.some((row) => (row.walletAddress ?? '').startsWith('Live'))).toBe(false);
  });

  test('Codex P1: a create that hands back a live trader id is refused (never saved by a caller)', async () => {
    const { fetchImpl } = fakeFetch({
      'POST /agents': () => json(agentBody(FLOOR_ARENA_LIVE_TRADER_CLAWPUMP_IDS[0], 'CV Arena · Genesis #housegenesis'), 201),
    });
    await expect(createClawPumpAgent({ name: 'CV Arena · Genesis #housegenesis', persona: 'p', system_prompt: 's' }, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
  });

  test('SPEC T3: a NEW house agent (house row suffix) passes the privacy update guard; the name must still match the row', async () => {
    const houseName = 'CV Arena · Genesis #housegenesis';
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, houseName)),
      [`POST /agents/${ARENA_ID}`]: () => json({}),
    });
    const houseRow = { arenaAgentId: 'house:genesis', isOwnedBy: async () => true };
    await updateClawPumpAgent(ARENA_ID, { accepting_bids: false }, houseRow, { env, fetchImpl });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    await expect(updateClawPumpAgent(ARENA_ID, { is_public: false }, { arenaAgentId: 'house:runner', isOwnedBy: async () => true }, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
  });
});

describe('Codex r17 #4: row-specific ownership proof, no cache', () => {
  const pay = { url: 'https://api.nansen.ai/x', method: 'GET' as const, maxAmountUsd: 0.1 };
  const routes = (name: string) => fakeFetch({
    [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, name)),
    [`POST /agents/${ARENA_ID}`]: () => json({}),
    [`POST be:/agents/${ARENA_ID}/x402/x402_service_pay`]: () => json({ data: {} }),
  });
  const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

  test('a ClawPump id that is not the arena row\'s own agent is refused before any vendor call', async () => {
    const { fetchImpl, calls } = routes(NAME);
    const asked: Array<[string, string]> = [];
    const notOwned = {
      arenaAgentId: ROW_ID,
      isOwnedBy: async (clawpumpAgentId: string, arenaAgentId: string) => { asked.push([clawpumpAgentId, arenaAgentId]); return false; },
    };
    await expect(updateClawPumpAgent(ARENA_ID, { is_public: false }, notOwned, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
    await expect(x402PayViaClawPump(ARENA_ID, pay, notOwned, { env, fetchImpl, ...X402_VERIFIED })).rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(asked).toEqual([[ARENA_ID, ROW_ID], [ARENA_ID, ROW_ID]]);
    expect(calls).toHaveLength(0);
  });

  test('the name must end with THIS row\'s id suffix, even when the DB binds the id', async () => {
    const { fetchImpl, calls } = routes('CV Arena · Bob #ffff00000000');
    await expect(updateClawPumpAgent(ARENA_ID, { is_public: false }, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
    await expect(x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl, ...X402_VERIFIED })).rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(writes(calls)).toHaveLength(0);
    expect(arenaAgentNameSuffix(ROW_ID)).toBe(' #abcd12340000');
  });

  test('no cache: proof and name are checked fresh on every call', async () => {
    let name = NAME;
    let owned = true;
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, name)),
      [`POST be:/agents/${ARENA_ID}/x402/x402_service_pay`]: () => json({ data: {} }),
    });
    const ownership = { arenaAgentId: ROW_ID, isOwnedBy: async () => owned };
    expect((await x402PayViaClawPump(ARENA_ID, pay, ownership, { env, fetchImpl, ...X402_VERIFIED })).ok).toBe(true);
    owned = false;
    await expect(x402PayViaClawPump(ARENA_ID, pay, ownership, { env, fetchImpl, ...X402_VERIFIED })).rejects.toMatchObject({ code: 'not_arena_agent' });
    owned = true;
    name = 'Genesis';
    await expect(x402PayViaClawPump(ARENA_ID, pay, ownership, { env, fetchImpl, ...X402_VERIFIED })).rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls.filter((call) => call.url.endsWith('/x402_service_pay'))).toHaveLength(1);
  });
});

describe('x402 via ClawPump: NOT VERIFIED on the current backend, fails closed', () => {
  const pay = { url: 'https://api.nansen.ai/new', method: 'GET' as const, maxAmountUsd: 0.1 };

  test('without the test seam the pay and the free check throw route_not_verified before any request', async () => {
    const { fetchImpl, calls, tokenCalls } = fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, NAME)),
      [`POST be:/agents/${ARENA_ID}/x402/x402_service_pay`]: () => json({ data: {} }),
      [`POST be:/agents/${ARENA_ID}/x402/x402_service_details`]: () => json({ price: '0.10' }),
    });
    await expect(x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'route_not_verified' });
    await expect(x402PayCheck(ARENA_ID, pay.url, 'GET', { env, fetchImpl })).rejects.toMatchObject({ code: 'route_not_verified' });
    await expect(clawPumpArenaWriter.x402Pay(ARENA_ID, pay, ROW_ID)).rejects.toMatchObject({ code: 'route_not_verified' });
    expect(calls).toHaveLength(0);
    expect(tokenCalls).toHaveLength(0);
    expect(CLAWPUMP_VERIFIED_BACKEND_POSTS.size).toBe(0);
    // The add-on tick books 0 and releases the reservation: nothing was sent.
    expect(mayHaveCharged(new ClawPumpWriterError('route_not_verified'))).toBe(false);
    expect(mayHaveCharged(new ClawPumpWriterError('backend_not_allowed'))).toBe(false);
  });

  test('static checks still come first: http URLs, amounts above the ceiling, a bad id, a host off the allowlist', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    await expect(x402PayViaClawPump(ARENA_ID, { ...pay, url: 'http://feed.example/new' }, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(x402PayViaClawPump(ARENA_ID, { ...pay, maxAmountUsd: 5.01 }, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(x402PayViaClawPump('not-a-uuid', pay, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'invalid_agent_id' });
    await expect(x402PayViaClawPump(ARENA_ID, { ...pay, url: 'https://evil.example/new' }, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'host_not_allowed' });
    await expect(x402PayViaClawPump(ARENA_ID, { ...pay, url: 'https://api.nansen.ai.evil.example/x' }, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'host_not_allowed' });
    await expect(x402PayCheck(ARENA_ID, 'https://evil.example/new', 'GET', { env, fetchImpl })).rejects.toMatchObject({ code: 'host_not_allowed' });
    expect(calls).toHaveLength(0);
  });

  describe('with the test seam (request and reply handling kept for when the route is verified)', () => {
    const routes = (payBody: unknown, agentExtra: Record<string, unknown> = {}, status = 200) => fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, NAME, agentExtra)),
      [`POST be:/agents/${ARENA_ID}/x402/x402_service_pay`]: () => json(payBody, status),
      [`POST be:/agents/${ARENA_ID}/x402/x402_service_details`]: () => json({ price: '0.10' }),
    });

    test('pays on the backend with the exchanged token, maxAmountAtomic = price in USDC micro units, no retry', async () => {
      const { fetchImpl, calls, tokenCalls } = routes({ data: { tokens: [] } });
      const result = await x402PayViaClawPump(ARENA_ID, { ...pay, query: { chain: 'solana' } }, OWNED, { env, fetchImpl, ...X402_VERIFIED });
      expect(result.ok).toBe(true);
      const sent = calls.find((call) => call.url.endsWith('/x402_service_pay'))!;
      expect(new URL(sent.url).origin).toBe(CLAWPUMP_BACKEND_ORIGIN);
      expect(sent.auth).toBe(`Bearer ${TOKEN}`);
      expect(sent.body).toEqual({ url: 'https://api.nansen.ai/new', method: 'GET', query: { chain: 'solana' }, maxAmountAtomic: 100_000 });
      expect(calls.filter((call) => call.url.endsWith('/x402_service_pay'))).toHaveLength(1);
      expect(tokenCalls).toHaveLength(1);
    });

    test('a 200 with a string error is a failed payment, like the MCP treats it', async () => {
      const { fetchImpl } = routes({ error: 'Price 0.5 exceeds max 0.1' });
      expect(await x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl, ...X402_VERIFIED })).toMatchObject({ ok: false, error: 'Price 0.5 exceeds max 0.1' });
    });

    test('Codex r22: only a "stopped" agent that holds x402 (v1 skills) is paid; nothing is sent otherwise', async () => {
      for (const [extra, code] of [
        [{ status: 'running' }, 'agent_running'], [{ status: 'Running' }, 'agent_running'], [{ status: null }, 'agent_not_stopped'],
        [{ status: 'starting' }, 'agent_not_stopped'], [{ skills: ['trading'] }, 'x402_not_enabled'], [{ skills: undefined }, 'x402_not_enabled'],
      ] as const) {
        _resetClawPumpWriterRateForTest();
        const { fetchImpl, calls } = routes({ data: {} }, extra);
        await expect(x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl, ...X402_VERIFIED })).rejects.toMatchObject({ code });
        expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
      }
      _resetClawPumpWriterRateForTest();
      const { fetchImpl } = routes({ data: {} }, { status: ' Stopped ', skills: ['X402'] });
      expect((await x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl, ...X402_VERIFIED })).ok).toBe(true);
    });

    test('the free check posts url + method to x402_service_details on the backend', async () => {
      const { fetchImpl, calls } = routes({});
      expect((await x402PayCheck(ARENA_ID, pay.url, 'GET', { env, fetchImpl, ...X402_VERIFIED })).ok).toBe(true);
      expect(calls[0]!.body).toEqual({ url: 'https://api.nansen.ai/new', method: 'GET' });
      expect(apiPath(calls[0]!.url)).toBe(`be:/agents/${ARENA_ID}/x402/x402_service_details`);
    });
  });
});

describe('Codex r20 (3) / audit-money B: the shared ClawPump call budget', () => {
  test('burst 10: normal calls stop at the removal reserve, removal calls use the reserve, and nothing is sent once refused', async () => {
    const { fetchImpl, calls } = fakeFetch({ [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, NAME)) });
    const normal = CLAWPUMP_WRITER_BURST - CLAWPUMP_WRITER_REMOVAL_RESERVE;
    for (let call = 0; call < normal; call += 1) expect((await readClawPumpArenaAgent(ARENA_ID, { env, fetchImpl })).id).toBe(ARENA_ID);
    await expect(readClawPumpArenaAgent(ARENA_ID, { env, fetchImpl })).rejects.toMatchObject({ code: 'budget_exhausted', status: null });
    expect(clawPumpWriterBudget().normalAllowed).toBe(false);
    for (let call = 0; call < CLAWPUMP_WRITER_REMOVAL_RESERVE; call += 1) {
      expect((await readClawPumpArenaAgent(ARENA_ID, { env, fetchImpl, priority: 'removal' })).id).toBe(ARENA_ID);
    }
    await expect(readClawPumpArenaAgent(ARENA_ID, { env, fetchImpl, priority: 'removal' })).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(calls).toHaveLength(CLAWPUMP_WRITER_BURST);
  });

  test('the backend key exchange takes a token too, at the caller\'s priority', async () => {
    _resetClawPumpWriterRateForTest(CLAWPUMP_WRITER_REMOVAL_RESERVE + 1);
    const { fetchImpl, calls, tokenCalls } = fakeFetch({ [`GET be:/agents/${ARENA_ID}`]: () => json({ id: ARENA_ID, is_public: false, accepting_bids: false }) });
    // One normal token above the reserve: the exchange takes it, the read is refused.
    await expect(readClawPumpArenaListing(ARENA_ID, { env, fetchImpl })).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(tokenCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);
    // The cached token: a removal-priority read needs no second exchange.
    expect(await readClawPumpArenaListing(ARENA_ID, { env, fetchImpl, priority: 'removal' })).toMatchObject({ isPublic: false });
    expect(tokenCalls).toHaveLength(1);
  });

  test('refills at 60 a minute (one per second), never above the burst', async () => {
    _resetClawPumpWriterRateForTest(0);
    const start = Date.now();
    expect(clawPumpWriterBudget(start).normalAllowed).toBe(false);
    expect(clawPumpWriterBudget(start + 5_000).tokens).toBeCloseTo(5, 0);
    expect(clawPumpWriterBudget(start + 10 * 60_000).tokens).toBe(CLAWPUMP_WRITER_BURST);
    expect(CLAWPUMP_WRITER_CALLS_PER_MINUTE).toBe(60);
  });
});
