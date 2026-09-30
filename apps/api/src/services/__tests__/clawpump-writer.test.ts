import { beforeEach, describe, expect, test } from 'bun:test';
import {
  CLAWPUMP_ARENA_DENIED_SKILLS,
  ClawPumpWriterError,
  readClawPumpArenaAgent,
  _resetClawPumpWriterCacheForTest,
  createClawPumpAgent,
  getClawPumpWalletBalances,
  listClawPumpAgentsByName,
  updateClawPumpAgent,
  x402PayCheck,
  x402PayViaClawPump,
} from '../clawpump-writer';

const KEY = 'cpk_test_not_a_real_key';
const env = { CLAWPUMP_API_KEY: KEY };
const ARENA_ID = '11111111-2222-4333-8444-555555555555';
const HOUSE_ID = '0f600d73-05a0-4c2e-8215-ab2a770ba192';

interface Call { method: string; url: string; body: unknown; auth: string | null }

function fakeFetch(routes: Record<string, (call: Call) => Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
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
    calls.push(call);
    const path = new URL(url).pathname;
    const handler = routes[`${method} ${path}`];
    if (!handler) return new Response('{"error":"Not Found"}', { status: 404 });
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const agentBody = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, status: 'running', wallet_address: 'So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx', ...extra,
});

beforeEach(() => _resetClawPumpWriterCacheForTest());

describe('createClawPumpAgent', () => {
  test('POSTs the MCP body shape once, with the Bearer key, and never retries a failure', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'POST /agents': () => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd1234', { enabled_skills: [], is_public: false })),
    });
    const created = await createClawPumpAgent({
      name: 'CV Arena · Bob #abcd1234',
      persona: 'persona',
      system_prompt: 'prompt',
      enabled_skills: [],
      is_public: false,
    }, { env, fetchImpl });
    expect(created).toMatchObject({ id: ARENA_ID, walletAddress: 'So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx', isPublic: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ai-agents-production-6ca0.up.railway.app/agents');
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toEqual({
      name: 'CV Arena · Bob #abcd1234',
      config: { persona: 'persona', system_prompt: 'prompt' },
      enabled_skills: [],
      is_public: false,
    });

    const failing = fakeFetch({ 'POST /agents': () => json({ error: 'boom' }, 500) });
    await expect(createClawPumpAgent({
      name: 'CV Arena · Bob #abcd1234', persona: 'p', system_prompt: 's', enabled_skills: [], is_public: false,
    }, { env, fetchImpl: failing.fetchImpl })).rejects.toMatchObject({ code: 'http_error', status: 500 });
    expect(failing.calls).toHaveLength(1);
  });

  test('refuses a trading skill and a non-arena name before any request', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    await expect(createClawPumpAgent({
      name: 'CV Arena · Bob', persona: 'p', system_prompt: 's', enabled_skills: ['token-sniper'], is_public: false,
    }, { env, fetchImpl })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(createClawPumpAgent({
      name: 'Genesis', persona: 'p', system_prompt: 's', enabled_skills: [], is_public: false,
    }, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls).toHaveLength(0);
  });

  test('reports not_configured without a key, and the error text never holds the key', async () => {
    const { fetchImpl } = fakeFetch({ 'POST /agents': () => json({}, 401) });
    await expect(createClawPumpAgent({
      name: 'CV Arena · A', persona: 'p', system_prompt: 's', enabled_skills: [], is_public: false,
    }, { env: {}, fetchImpl })).rejects.toMatchObject({ code: 'not_configured' });
    const error = await createClawPumpAgent({
      name: 'CV Arena · A', persona: 'p', system_prompt: 's', enabled_skills: [], is_public: false,
    }, { env, fetchImpl }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ClawPumpWriterError);
    expect((error as Error).message).toBe('clawpump_unauthorized_401');
    expect((error as Error).message).not.toContain(KEY);
  });
});

describe('updateClawPumpAgent', () => {
  test('PATCHes only the three allowed fields after the arena-name guard', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd1234')),
      [`PATCH /agents/${ARENA_ID}`]: (call) => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd1234', call.body as Record<string, unknown>)),
    });
    const updated = await updateClawPumpAgent(ARENA_ID, { accepting_bids: false, is_public: false, enabled_skills: ['x402'] }, { env, fetchImpl });
    expect(updated.acceptingBids).toBe(false);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      `GET /agents/${ARENA_ID}`, `PATCH /agents/${ARENA_ID}`,
    ]);
    expect(calls[1]!.body).toEqual({ accepting_bids: false, is_public: false, enabled_skills: ['x402'] });
    await expect(updateClawPumpAgent(ARENA_ID, { name: 'x' } as never, { env, fetchImpl })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('never touches a house agent (name without the arena prefix)', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${HOUSE_ID}`]: () => json(agentBody(HOUSE_ID, 'Genesis')),
      [`PATCH /agents/${HOUSE_ID}`]: () => json(agentBody(HOUSE_ID, 'Genesis')),
    });
    await expect(updateClawPumpAgent(HOUSE_ID, { accepting_bids: false }, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    await expect(x402PayViaClawPump(HOUSE_ID, { url: 'https://api.nansen.ai/x', method: 'GET', maxAmountUsd: 0.1 }, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });
});

describe('skills', () => {
  test('a PATCH may keep harmless defaults but never a denied skill (x402 aside)', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000', { enabled_skills: ['web-browsing'] })),
      [`PATCH /agents/${ARENA_ID}`]: (call) => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000', call.body as Record<string, unknown>)),
    });
    await updateClawPumpAgent(ARENA_ID, { enabled_skills: ['action-plans', 'web-browsing', 'x402'] }, { env, fetchImpl });
    expect(calls.at(-1)!.body).toEqual({ enabled_skills: ['action-plans', 'web-browsing', 'x402'] });
    const before = calls.length;
    for (const denied of ['defi-trading', 'private-transfers', 'wallet-ops', 'perps-trading', 'token-launch', 'agenc-worker']) {
      await expect(updateClawPumpAgent(ARENA_ID, { enabled_skills: ['web-browsing', denied] }, { env, fetchImpl }))
        .rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(calls.length).toBe(before);
    expect(CLAWPUMP_ARENA_DENIED_SKILLS.has('x402')).toBe(true);
  });

  test('readClawPumpArenaAgent returns the enabled skills from GET /agents/{id}', async () => {
    const { fetchImpl } = fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json({ agent: agentBody(ARENA_ID, 'CV Arena · Bob', { enabled_skills: ['self-learning', 'x402'] }) }),
    });
    expect((await readClawPumpArenaAgent(ARENA_ID, { env, fetchImpl })).enabledSkills).toEqual(['self-learning', 'x402']);
    await expect(readClawPumpArenaAgent('nope', { env, fetchImpl })).rejects.toMatchObject({ code: 'invalid_agent_id' });
  });
});

describe('x402 via ClawPump', () => {
  const routes = (payBody: unknown, status = 200) => fakeFetch({
    [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd1234')),
    [`POST /agents/${ARENA_ID}/x402/x402_service_pay`]: () => json(payBody, status),
    [`POST /agents/${ARENA_ID}/x402/x402_service_details`]: () => json({ price: '0.10' }),
  });

  test('pays with maxAmountAtomic = price in USDC micro units and no retry', async () => {
    const { fetchImpl, calls } = routes({ data: { tokens: [] } });
    const result = await x402PayViaClawPump(ARENA_ID, {
      url: 'https://api.nansen.ai/new', method: 'GET', query: { chain: 'solana' }, maxAmountUsd: 0.1,
    }, { env, fetchImpl });
    expect(result.ok).toBe(true);
    const pay = calls.find((call) => call.url.endsWith('/x402_service_pay'))!;
    expect(pay.body).toEqual({ url: 'https://api.nansen.ai/new', method: 'GET', query: { chain: 'solana' }, maxAmountAtomic: 100_000 });
    expect(calls.filter((call) => call.url.endsWith('/x402_service_pay'))).toHaveLength(1);
  });

  test('a 200 with a string error is a failed payment, like the MCP treats it', async () => {
    const { fetchImpl } = routes({ error: 'Price 0.5 exceeds max 0.1' });
    const result = await x402PayViaClawPump(ARENA_ID, { url: 'https://api.nansen.ai/new', method: 'GET', maxAmountUsd: 0.1 }, { env, fetchImpl });
    expect(result).toMatchObject({ ok: false, error: 'Price 0.5 exceeds max 0.1' });
  });

  test('refuses http URLs and amounts above the per-call ceiling before any request', async () => {
    const { fetchImpl, calls } = routes({});
    await expect(x402PayViaClawPump(ARENA_ID, { url: 'http://feed.example/new', method: 'GET', maxAmountUsd: 0.1 }, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(x402PayViaClawPump(ARENA_ID, { url: 'https://api.nansen.ai/new', method: 'GET', maxAmountUsd: 5.01 }, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(x402PayViaClawPump('not-a-uuid', { url: 'https://api.nansen.ai/new', method: 'GET', maxAmountUsd: 0.1 }, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_agent_id' });
    // Host allowlist: only vetted vendors, whatever the caller (or the catalog) asks.
    await expect(x402PayViaClawPump(ARENA_ID, { url: 'https://evil.example/new', method: 'GET', maxAmountUsd: 0.1 }, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'host_not_allowed' });
    await expect(x402PayViaClawPump(ARENA_ID, { url: 'https://api.nansen.ai.evil.example/x', method: 'GET', maxAmountUsd: 0.1 }, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'host_not_allowed' });
    await expect(x402PayCheck(ARENA_ID, 'https://evil.example/new', 'GET', { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'host_not_allowed' });
    expect(calls).toHaveLength(0);
  });

  test('the free check posts url + method to x402_service_details', async () => {
    const { fetchImpl, calls } = routes({});
    const result = await x402PayCheck(ARENA_ID, 'https://api.nansen.ai/new', 'GET', { env, fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls[0]!.body).toEqual({ url: 'https://api.nansen.ai/new', method: 'GET' });
  });
});

describe('reads', () => {
  test('wallet summaries map UI-unit numbers and numeric strings', async () => {
    const { fetchImpl } = fakeFetch({
      'GET /wallets/summary': () => json({ wallets: [
        { agent_id: ARENA_ID, wallet_address: 'W1', sol_balance: 0.08, usdc_balance: '61.33', updated_at: '2026-09-30T10:21:41.483Z' },
        { agent_id: HOUSE_ID, wallet_address: null, sol_balance: 0, usdc_balance: null },
      ] }),
    });
    expect(await getClawPumpWalletBalances({ env, fetchImpl })).toEqual([
      { agentId: ARENA_ID, walletAddress: 'W1', sol: 0.08, usdc: 61.33, updatedAt: '2026-09-30T10:21:41.483Z' },
      { agentId: HOUSE_ID, walletAddress: null, sol: 0, usdc: null, updatedAt: null },
    ]);
  });

  test('list by name matches the exact name only', async () => {
    const { fetchImpl } = fakeFetch({
      'GET /agents': () => json({ agents: [
        agentBody(ARENA_ID, 'CV Arena · Bob #abcd1234'),
        agentBody(HOUSE_ID, 'CV Arena · Bob #abcd12345'),
      ] }),
    });
    const found = await listClawPumpAgentsByName('CV Arena · Bob #abcd1234', { env, fetchImpl });
    expect(found.map((agent) => agent.id)).toEqual([ARENA_ID]);
  });
});
