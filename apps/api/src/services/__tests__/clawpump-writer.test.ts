import { beforeEach, describe, expect, test } from 'bun:test';
import {
  CLAWPUMP_HOUSE_AGENT_IDS,
  arenaAgentNamePrefix,
  arenaAgentNameSuffix,
  isArenaAgentName,
  CLAWPUMP_ARENA_DENIED_SKILLS,
  CLAWPUMP_STICKY_DEFAULT_SKILLS,
  CLAWPUMP_WRITER_BURST,
  CLAWPUMP_WRITER_CALLS_PER_MINUTE,
  CLAWPUMP_WRITER_REMOVAL_RESERVE,
  ClawPumpWriterError,
  clawPumpWriterBudget,
  _resetClawPumpWriterRateForTest,
  isRemovalOnlyPatch,
  clawPumpArenaWriter,
  readClawPumpArenaAgent,
  createClawPumpAgent,
  getClawPumpWalletBalances,
  updateClawPumpAgent,
  x402PayCheck,
  x402PayViaClawPump,
} from '../clawpump-writer';
import { mayHaveCharged } from '../floor-arena/addons';

const KEY = 'cpk_test_not_a_real_key';
const env = { CLAWPUMP_API_KEY: KEY, CLAWVILLE_ENV: 'production' };
const stagingEnv = { CLAWPUMP_API_KEY: KEY, CLAWVILLE_ENV: 'staging' };
/** The arena row that owns the ClawPump agent in these tests (names end with its id suffix). */
const ROW_ID = 'abcd1234-0000-4000-8000-000000000000';
const OWNED = { arenaAgentId: ROW_ID, isOwnedBy: async () => true };
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

beforeEach(() => _resetClawPumpWriterRateForTest());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const agentBody = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, status: 'stopped', wallet_address: 'So1anaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx', enabled_skills: ['x402'], ...extra,
});


describe('createClawPumpAgent', () => {
  test('POSTs the MCP body shape once, with the Bearer key, and never retries a failure', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'POST /agents': () => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000', { enabled_skills: [], is_public: false })),
    });
    const created = await createClawPumpAgent({
      name: 'CV Arena · Bob #abcd12340000',
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
      name: 'CV Arena · Bob #abcd12340000',
      config: { persona: 'persona', system_prompt: 'prompt' },
      enabled_skills: [],
      is_public: false,
    });

    const failing = fakeFetch({ 'POST /agents': () => json({ error: 'boom' }, 500) });
    await expect(createClawPumpAgent({
      name: 'CV Arena · Bob #abcd12340000', persona: 'p', system_prompt: 's', enabled_skills: [], is_public: false,
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
    }, { env: { CLAWVILLE_ENV: 'production' }, fetchImpl })).rejects.toMatchObject({ code: 'not_configured' });
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
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000')),
      [`PATCH /agents/${ARENA_ID}`]: (call) => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000', call.body as Record<string, unknown>)),
    });
    const updated = await updateClawPumpAgent(ARENA_ID, { accepting_bids: false, is_public: false, enabled_skills: ['x402'] }, OWNED, { env, fetchImpl });
    expect(updated.acceptingBids).toBe(false);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      `GET /agents/${ARENA_ID}`, `PATCH /agents/${ARENA_ID}`,
    ]);
    expect(calls[1]!.body).toEqual({ accepting_bids: false, is_public: false, enabled_skills: ['x402'] });
    await expect(updateClawPumpAgent(ARENA_ID, { name: 'x' } as never, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('never touches a house agent (name without the arena prefix)', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${HOUSE_ID}`]: () => json(agentBody(HOUSE_ID, 'Genesis')),
      [`PATCH /agents/${HOUSE_ID}`]: () => json(agentBody(HOUSE_ID, 'Genesis')),
    });
    await expect(updateClawPumpAgent(HOUSE_ID, { accepting_bids: false }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    await expect(x402PayViaClawPump(HOUSE_ID, { url: 'https://api.nansen.ai/x', method: 'GET', maxAmountUsd: 0.1 }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });
});

describe('money audit N1: the env-correct prefix and the house-agent ids', () => {
  test('production accepts only "CV Arena · ", staging only "CV Arena (staging) · "', async () => {
    const routes = (name: string) => fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, name)),
      [`PATCH /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, name, { accepting_bids: false })),
    });
    const prodName = routes('CV Arena · Bob #abcd12340000');
    await expect(updateClawPumpAgent(ARENA_ID, { accepting_bids: false }, OWNED, { env: stagingEnv, fetchImpl: prodName.fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    const stagingName = routes('CV Arena (staging) · Bob #abcd12340000');
    await expect(updateClawPumpAgent(ARENA_ID, { accepting_bids: false }, OWNED, { env, fetchImpl: stagingName.fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect((await updateClawPumpAgent(ARENA_ID, { accepting_bids: false }, OWNED, { env: stagingEnv, fetchImpl: stagingName.fetchImpl })).id).toBe(ARENA_ID);
    expect(isArenaAgentName('CV Arena (staging) · X', stagingEnv)).toBe(true);
    expect(isArenaAgentName('CV Arena · X', stagingEnv)).toBe(false);
    expect(arenaAgentNamePrefix({})).toBe('CV Arena (staging) · ');
    // Create refuses a wrong-env name before any request.
    const { fetchImpl, calls } = fakeFetch({});
    await expect(createClawPumpAgent({
      name: 'CV Arena · Bob #abcd12340000', persona: 'p', system_prompt: 's', enabled_skills: [], is_public: false,
    }, { env: stagingEnv, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls).toHaveLength(0);
  });

  test('a house trader id is refused even when ClawPump reports an arena name', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${HOUSE_ID}`]: () => json(agentBody(HOUSE_ID, 'CV Arena · Genesis')),
      [`PATCH /agents/${HOUSE_ID}`]: () => json(agentBody(HOUSE_ID, 'CV Arena · Genesis')),
    });
    expect(CLAWPUMP_HOUSE_AGENT_IDS.has(HOUSE_ID)).toBe(true);
    await expect(updateClawPumpAgent(HOUSE_ID, { accepting_bids: false }, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
    await expect(x402PayViaClawPump(HOUSE_ID, { url: 'https://api.nansen.ai/x', method: 'GET', maxAmountUsd: 0.1 }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls).toHaveLength(0);
  });
});

describe('Codex r17 #4: row-specific ownership proof, no cache', () => {
  const pay = { url: 'https://api.nansen.ai/x', method: 'GET' as const, maxAmountUsd: 0.1 };
  const routes = (name: string) => fakeFetch({
    [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, name)),
    [`PATCH /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, name, { accepting_bids: false })),
    [`POST /agents/${ARENA_ID}/x402/x402_service_pay`]: () => json({ data: {} }),
  });
  const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

  test('a ClawPump id that is not the arena row\'s own agent is refused before any vendor call', async () => {
    const { fetchImpl, calls } = routes('CV Arena · Bob #abcd12340000');
    const asked: Array<[string, string]> = [];
    const notOwned = {
      arenaAgentId: ROW_ID,
      isOwnedBy: async (clawpumpAgentId: string, arenaAgentId: string) => { asked.push([clawpumpAgentId, arenaAgentId]); return false; },
    };
    await expect(updateClawPumpAgent(ARENA_ID, { accepting_bids: false }, notOwned, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    await expect(x402PayViaClawPump(ARENA_ID, pay, notOwned, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(asked).toEqual([[ARENA_ID, ROW_ID], [ARENA_ID, ROW_ID]]);
    expect(calls).toHaveLength(0);
  });

  test('a renamed foreign agent with the arena prefix + some row suffix is refused when the DB does not bind it', async () => {
    // Someone renamed a non-arena agent to look exactly like this row's agent.
    const { fetchImpl, calls } = routes('CV Arena · Bob #abcd12340000');
    const otherRow = { arenaAgentId: 'ffff0000-0000-4000-8000-000000000000', isOwnedBy: async () => false };
    await expect(x402PayViaClawPump(ARENA_ID, pay, otherRow, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(writes(calls)).toHaveLength(0);
  });

  test('the name must end with THIS row\'s id suffix, even when the DB binds the id', async () => {
    const { fetchImpl, calls } = routes('CV Arena · Bob #ffff00000000');
    await expect(updateClawPumpAgent(ARENA_ID, { accepting_bids: false }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    await expect(x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(writes(calls)).toHaveLength(0);
    expect(arenaAgentNameSuffix(ROW_ID)).toBe(' #abcd12340000');
  });

  test('no cache: proof and name are checked fresh on every call', async () => {
    let name = 'CV Arena · Bob #abcd12340000';
    let owned = true;
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, name)),
      [`POST /agents/${ARENA_ID}/x402/x402_service_pay`]: () => json({ data: {} }),
    });
    const ownership = { arenaAgentId: ROW_ID, isOwnedBy: async () => owned };
    expect((await x402PayViaClawPump(ARENA_ID, pay, ownership, { env, fetchImpl })).ok).toBe(true);
    // The DB binding goes away (row deleted / agent re-pointed): the next call is refused.
    owned = false;
    await expect(x402PayViaClawPump(ARENA_ID, pay, ownership, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
    // The binding is back but the agent was renamed on ClawPump: refused too.
    owned = true;
    name = 'Genesis';
    await expect(x402PayViaClawPump(ARENA_ID, pay, ownership, { env, fetchImpl })).rejects.toMatchObject({ code: 'not_arena_agent' });
    expect(calls.filter((call) => call.url.endsWith('/x402_service_pay'))).toHaveLength(1);
  });
});

describe('Codex r19 #3: the last read inside the writer refuses a running agent', () => {
  const pay = { url: 'https://api.nansen.ai/x', method: 'GET' as const, maxAmountUsd: 0.1 };
  const routes = (extra: Record<string, unknown>) => fakeFetch({
    [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000', extra)),
    [`PATCH /agents/${ARENA_ID}`]: (call) => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000', call.body as Record<string, unknown>)),
    [`POST /agents/${ARENA_ID}/x402/x402_service_pay`]: () => json({ data: {} }),
  });
  const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

  test('a running agent at the final GET gets NO x402 add (or any non-removal PATCH), and no payment', async () => {
    const { fetchImpl, calls } = routes({ status: 'running', enabled_skills: [...CLAWPUMP_STICKY_DEFAULT_SKILLS] });
    await expect(updateClawPumpAgent(ARENA_ID, { enabled_skills: ['x402'] }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'agent_running' });
    await expect(updateClawPumpAgent(ARENA_ID, { accepting_bids: false, is_public: false, enabled_skills: [] }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'agent_running' });
    await expect(x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'agent_running' });
    expect(writes(calls)).toHaveLength(0);
  });

  test('a removal-only PATCH (a subset, no x402) still goes through on a running agent', async () => {
    const { fetchImpl, calls } = routes({ status: 'Running', enabled_skills: ['self-learning', 'twitter', 'x402'] });
    await updateClawPumpAgent(ARENA_ID, { enabled_skills: ['twitter'] }, OWNED, { env, fetchImpl });
    expect(writes(calls).map((call) => call.body)).toEqual([{ enabled_skills: ['twitter'] }]);
  });

  test('a payment needs x402 on the agent at that read; both refusals send no POST', async () => {
    const { fetchImpl, calls } = routes({ enabled_skills: ['self-learning'] });
    await expect(x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'x402_not_enabled' });
    const unreadable = routes({ enabled_skills: undefined });
    await expect(x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl: unreadable.fetchImpl })).rejects.toMatchObject({ code: 'x402_not_enabled' });
    expect(writes(calls)).toHaveLength(0);
    expect(writes(unreadable.calls)).toHaveLength(0);
  });

  test('isRemovalOnlyPatch: only enabled_skills, no x402, every skill already on the agent', () => {
    const current = { id: ARENA_ID, name: null, status: 'running', walletAddress: null, isPublic: false, acceptingBids: false, enabledSkills: ['Twitter', 'x402'] };
    expect(isRemovalOnlyPatch({ enabled_skills: [] }, current)).toBe(true);
    expect(isRemovalOnlyPatch({ enabled_skills: ['twitter'] }, current)).toBe(true);
    expect(isRemovalOnlyPatch({ enabled_skills: ['twitter', 'x402'] }, current)).toBe(false);
    expect(isRemovalOnlyPatch({ enabled_skills: ['web-browsing'] }, current)).toBe(false);
    expect(isRemovalOnlyPatch({ enabled_skills: [], is_public: false }, current)).toBe(false);
    expect(isRemovalOnlyPatch({ accepting_bids: false }, current)).toBe(false);
    expect(isRemovalOnlyPatch({ enabled_skills: [] }, { ...current, enabledSkills: null })).toBe(false);
  });
});

describe('Codex r22: the last read inside the writer must report status "stopped"', () => {
  const pay = { url: 'https://api.nansen.ai/x', method: 'GET' as const, maxAmountUsd: 0.1 };
  const name = 'CV Arena · Bob #abcd12340000';
  // `status: undefined` drops the key from the JSON body: ClawPump sent no status at all.
  const routes = (status: string | null | undefined) => fakeFetch({
    [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, name, { status, enabled_skills: ['self-learning', 'twitter', 'x402'] })),
    [`PATCH /agents/${ARENA_ID}`]: (call) => json(agentBody(ARENA_ID, name, call.body as Record<string, unknown>)),
    [`POST /agents/${ARENA_ID}/x402/x402_service_pay`]: () => json({ data: {} }),
  });
  const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');
  const addPatch = { accepting_bids: false, is_public: false, enabled_skills: ['x402'] };
  const visibilityPatch = { is_public: false };
  const removalPatch = { enabled_skills: ['twitter'] };
  const notStopped = [null, undefined, 'starting', 'paused', '', 'stopping'];

  test('"stopped" (trimmed, any case): the payment and an add-PATCH go through', async () => {
    for (const status of ['stopped', ' Stopped ']) {
      const { fetchImpl, calls } = routes(status);
      _resetClawPumpWriterRateForTest();
      expect((await x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl })).ok).toBe(true);
      _resetClawPumpWriterRateForTest();
      expect((await updateClawPumpAgent(ARENA_ID, addPatch, OWNED, { env, fetchImpl })).id).toBe(ARENA_ID);
      expect(writes(calls).map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        `POST /agents/${ARENA_ID}/x402/x402_service_pay`, `PATCH /agents/${ARENA_ID}`,
      ]);
    }
  });

  test('"running" refuses the payment and an add-PATCH with agent_running; nothing is sent', async () => {
    const { fetchImpl, calls } = routes('running');
    await expect(x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'agent_running' });
    await expect(updateClawPumpAgent(ARENA_ID, addPatch, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'agent_running' });
    await expect(updateClawPumpAgent(ARENA_ID, visibilityPatch, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'agent_running' });
    expect(writes(calls)).toHaveLength(0);
  });

  test('null, missing or any other status refuses the payment and an add-PATCH with agent_not_stopped; nothing is sent or charged', async () => {
    for (const status of notStopped) {
      const { fetchImpl, calls } = routes(status);
      _resetClawPumpWriterRateForTest();
      await expect(x402PayViaClawPump(ARENA_ID, pay, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'agent_not_stopped' });
      await expect(updateClawPumpAgent(ARENA_ID, addPatch, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'agent_not_stopped' });
      await expect(updateClawPumpAgent(ARENA_ID, visibilityPatch, OWNED, { env, fetchImpl })).rejects.toMatchObject({ code: 'agent_not_stopped' });
      expect(writes(calls)).toHaveLength(0);
    }
    // The add-on tick books 0 and releases the reservation for both refusals.
    expect(mayHaveCharged(new ClawPumpWriterError('agent_not_stopped'))).toBe(false);
    expect(mayHaveCharged(new ClawPumpWriterError('agent_running'))).toBe(false);
  });

  test('a removal-only PATCH goes through at every status', async () => {
    for (const status of ['stopped', 'running', ...notStopped]) {
      const { fetchImpl, calls } = routes(status);
      _resetClawPumpWriterRateForTest();
      await updateClawPumpAgent(ARENA_ID, removalPatch, OWNED, { env, fetchImpl });
      expect(writes(calls).map((call) => call.body)).toEqual([removalPatch]);
    }
  });
});

describe('Codex r20 (3) / audit-money B: the shared ClawPump call budget', () => {
  const check = (fetchImpl: typeof fetch) => x402PayCheck(ARENA_ID, 'https://api.nansen.ai/new', 'GET', { env, fetchImpl });

  test('burst 10: normal calls stop at the removal reserve, removal calls use the reserve, and nothing is sent once refused', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`POST /agents/${ARENA_ID}/x402/x402_service_details`]: () => json({ price: '0.10' }),
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000')),
    });
    const normal = CLAWPUMP_WRITER_BURST - CLAWPUMP_WRITER_REMOVAL_RESERVE;
    for (let call = 0; call < normal; call += 1) expect((await check(fetchImpl)).ok).toBe(true);
    await expect(check(fetchImpl)).rejects.toMatchObject({ code: 'budget_exhausted', status: null });
    expect(clawPumpWriterBudget().normalAllowed).toBe(false);
    // A payment is refused the same way, before the guard GET and the POST (it can never have charged).
    await expect(x402PayViaClawPump(ARENA_ID, { url: 'https://api.nansen.ai/x', method: 'GET', maxAmountUsd: 0.1 }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'budget_exhausted' });
    // Removal-priority calls still get the reserved tokens, then they stop too.
    for (let call = 0; call < CLAWPUMP_WRITER_REMOVAL_RESERVE; call += 1) {
      expect((await readClawPumpArenaAgent(ARENA_ID, { env, fetchImpl, priority: 'removal' })).id).toBe(ARENA_ID);
    }
    await expect(readClawPumpArenaAgent(ARENA_ID, { env, fetchImpl, priority: 'removal' })).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(calls).toHaveLength(CLAWPUMP_WRITER_BURST);
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

describe('skills', () => {
  test('a PATCH may keep harmless defaults but never a denied skill (x402 aside)', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000', { enabled_skills: ['web-browsing'] })),
      [`PATCH /agents/${ARENA_ID}`]: (call) => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000', call.body as Record<string, unknown>)),
    });
    await updateClawPumpAgent(ARENA_ID, { enabled_skills: ['action-plans', 'web-browsing', 'x402'] }, OWNED, { env, fetchImpl });
    expect(calls.at(-1)!.body).toEqual({ enabled_skills: ['action-plans', 'web-browsing', 'x402'] });
    const before = calls.length;
    for (const denied of ['defi-trading', 'wallet-ops', 'perps-trading', 'token-launch', 'agenc-worker']) {
      await expect(updateClawPumpAgent(ARENA_ID, { enabled_skills: ['web-browsing', denied] }, OWNED, { env, fetchImpl }))
        .rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(calls.length).toBe(before);
    expect(CLAWPUMP_ARENA_DENIED_SKILLS.has('x402')).toBe(true);
    // A sticky platform default is never denied (it cannot be disabled).
    for (const sticky of CLAWPUMP_STICKY_DEFAULT_SKILLS) expect(CLAWPUMP_ARENA_DENIED_SKILLS.has(sticky)).toBe(false);
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
    [`GET /agents/${ARENA_ID}`]: () => json(agentBody(ARENA_ID, 'CV Arena · Bob #abcd12340000')),
    [`POST /agents/${ARENA_ID}/x402/x402_service_pay`]: () => json(payBody, status),
    [`POST /agents/${ARENA_ID}/x402/x402_service_details`]: () => json({ price: '0.10' }),
  });

  test('pays with maxAmountAtomic = price in USDC micro units and no retry', async () => {
    const { fetchImpl, calls } = routes({ data: { tokens: [] } });
    const result = await x402PayViaClawPump(ARENA_ID, {
      url: 'https://api.nansen.ai/new', method: 'GET', query: { chain: 'solana' }, maxAmountUsd: 0.1,
    }, OWNED, { env, fetchImpl });
    expect(result.ok).toBe(true);
    const pay = calls.find((call) => call.url.endsWith('/x402_service_pay'))!;
    expect(pay.body).toEqual({ url: 'https://api.nansen.ai/new', method: 'GET', query: { chain: 'solana' }, maxAmountAtomic: 100_000 });
    expect(calls.filter((call) => call.url.endsWith('/x402_service_pay'))).toHaveLength(1);
  });

  test('a 200 with a string error is a failed payment, like the MCP treats it', async () => {
    const { fetchImpl } = routes({ error: 'Price 0.5 exceeds max 0.1' });
    const result = await x402PayViaClawPump(ARENA_ID, { url: 'https://api.nansen.ai/new', method: 'GET', maxAmountUsd: 0.1 }, OWNED, { env, fetchImpl });
    expect(result).toMatchObject({ ok: false, error: 'Price 0.5 exceeds max 0.1' });
  });

  test('refuses http URLs and amounts above the per-call ceiling before any request', async () => {
    const { fetchImpl, calls } = routes({});
    await expect(x402PayViaClawPump(ARENA_ID, { url: 'http://feed.example/new', method: 'GET', maxAmountUsd: 0.1 }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(x402PayViaClawPump(ARENA_ID, { url: 'https://api.nansen.ai/new', method: 'GET', maxAmountUsd: 5.01 }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(x402PayViaClawPump('not-a-uuid', { url: 'https://api.nansen.ai/new', method: 'GET', maxAmountUsd: 0.1 }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_agent_id' });
    // Host allowlist: only vetted vendors, whatever the caller (or the catalog) asks.
    await expect(x402PayViaClawPump(ARENA_ID, { url: 'https://evil.example/new', method: 'GET', maxAmountUsd: 0.1 }, OWNED, { env, fetchImpl }))
      .rejects.toMatchObject({ code: 'host_not_allowed' });
    await expect(x402PayViaClawPump(ARENA_ID, { url: 'https://api.nansen.ai.evil.example/x', method: 'GET', maxAmountUsd: 0.1 }, OWNED, { env, fetchImpl }))
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
  test('Codex r18 #4: the arena writer has no list-by-name (provisioning never adopts)', () => {
    expect(Object.keys(clawPumpArenaWriter).sort()).toEqual(['createAgent', 'getWalletBalances', 'readAgent', 'updateAgent', 'x402Pay']);
  });

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
});
