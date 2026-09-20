import { describe, expect, mock, spyOn, test } from 'bun:test';
import genesis from './__fixtures__/clawpump/get-agent-genesis.json';
import {
  CLAWPUMP_DEFAULT_API_BASE_URL,
  ClawPumpAgentMismatchError,
  ClawPumpClientError,
  getClawPumpAgent,
  listClawPumpAgents,
  resolveClawPumpConfig,
  type ClawPumpClientErrorCode,
} from '../clawpump-client';

const KEY = 'cpk_TESTSECRET_x';
const env = { CLAWPUMP_API_KEY: KEY };
const AGENT_ID = '0f600d73-05a0-4c2e-8215-ab2a770ba192';

function fetchStub(reply: () => Response | Promise<Response>) {
  const calls = mock(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => reply());
  return { calls, fetchImpl: calls as unknown as typeof fetch };
}

async function expectClientError(promise: Promise<unknown>, code: ClawPumpClientErrorCode, status: number | null = null) {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ClawPumpClientError);
  const error = caught as ClawPumpClientError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
  expect(String(error)).not.toContain(KEY);
  expect(error.message).not.toContain(KEY);
  expect(JSON.stringify(error)).not.toContain(KEY);
}

describe('ClawPump read-only client', () => {
  test.each([undefined, '', '  '])('refuses missing key %p before fetch', async (key) => {
    const stub = fetchStub(() => Response.json([]));
    await expectClientError(listClawPumpAgents({ env: { CLAWPUMP_API_KEY: key }, fetchImpl: stub.fetchImpl }), 'not_configured');
    expect(stub.calls).not.toHaveBeenCalled();
  });

  test.each([
    'http://ai-agents-production-6ca0.up.railway.app',
    'https://example.com',
    'https://user:pw@ai-agents-production-6ca0.up.railway.app',
    `${CLAWPUMP_DEFAULT_API_BASE_URL}:8443`,
    `${CLAWPUMP_DEFAULT_API_BASE_URL}?key=${KEY}`,
    `${CLAWPUMP_DEFAULT_API_BASE_URL}/api`,
    `${CLAWPUMP_DEFAULT_API_BASE_URL}#fragment`,
    'not a URL',
  ])('refuses unsafe origin case %# before fetch', async (baseUrl) => {
    const stub = fetchStub(() => Response.json([]));
    await expectClientError(listClawPumpAgents({
      env: { ...env, CLAWPUMP_API_BASE_URL: baseUrl }, fetchImpl: stub.fetchImpl,
    }), 'invalid_base_url');
    expect(stub.calls).not.toHaveBeenCalled();
  });

  test('uses only GET with bearer auth, redirect refusal, and timeout on exact read URLs', async () => {
    let requestCount = 0;
    const stub = fetchStub(() => Response.json(++requestCount === 1 ? [genesis] : genesis));
    await listClawPumpAgents({ env, fetchImpl: stub.fetchImpl });
    await getClawPumpAgent(AGENT_ID, { env, fetchImpl: stub.fetchImpl });
    expect(stub.calls).toHaveBeenCalledTimes(2);
    for (const [index, [url, init]] of stub.calls.mock.calls.entries()) {
      expect(String(url)).toBe(`${CLAWPUMP_DEFAULT_API_BASE_URL}/agents${index === 0 ? '' : `/${AGENT_ID}`}`);
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ Authorization: `Bearer ${KEY}`, Accept: 'application/json' });
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.body).toBeUndefined();
    }
  });

  test.each(['genesis', '../x'])('refuses non-UUID id %s before fetch', async (id) => {
    const stub = fetchStub(() => Response.json(genesis));
    await expectClientError(getClawPumpAgent(id, { env, fetchImpl: stub.fetchImpl }), 'invalid_agent_id');
    expect(stub.calls).not.toHaveBeenCalled();
  });

  const errors: Array<{
    label: string; reply: () => Response | Promise<Response>; code: ClawPumpClientErrorCode; status?: number;
  }> = [
    { label: '401', reply: () => new Response(KEY, { status: 401 }), code: 'unauthorized', status: 401 },
    { label: '403', reply: () => new Response(KEY, { status: 403 }), code: 'unauthorized', status: 403 },
    { label: '404', reply: () => new Response(KEY, { status: 404 }), code: 'not_found', status: 404 },
    { label: '500', reply: () => new Response(KEY, { status: 500 }), code: 'http_error', status: 500 },
    { label: 'timeout', reply: () => { throw new DOMException(KEY, 'TimeoutError'); }, code: 'timeout' },
    { label: 'abort', reply: () => { throw new DOMException(KEY, 'AbortError'); }, code: 'timeout' },
    { label: 'network', reply: () => { throw new TypeError(KEY); }, code: 'network_error' },
    { label: 'content length', reply: () => new Response(KEY, { headers: { 'content-length': '2000000' } }), code: 'response_too_large', status: 200 },
    { label: 'body length', reply: () => new Response('x'.repeat(1_000_001)), code: 'response_too_large', status: 200 },
    { label: 'invalid JSON', reply: () => new Response(`not json ${KEY}`), code: 'schema_invalid', status: 200 },
    {
      label: 'body read failure',
      reply: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { controller.error(new Error(KEY)); },
        });
        return new Response(stream);
      },
      code: 'timeout', status: 200,
    },
  ];

  test.each(errors)('maps $label without logging or exposing secrets', async ({ reply, code, status }) => {
    const spies = [spyOn(console, 'log'), spyOn(console, 'warn'), spyOn(console, 'error')];
    try {
      const stub = fetchStub(reply);
      await expectClientError(listClawPumpAgents({ env, fetchImpl: stub.fetchImpl }), code, status ?? null);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test.each(['array', 'wrapped'])('accepts %s list and omits unknown vendor fields from DTO', async (format) => {
    const wire = { ...genesis, config: { private: 'vendor-only' }, runtime_tier: 'enterprise' };
    const stub = fetchStub(() => Response.json(format === 'array' ? [wire] : { agents: [wire], total: 1 }));
    expect(await listClawPumpAgents({ env, fetchImpl: stub.fetchImpl })).toEqual([{
      id: AGENT_ID, userId: genesis.user_id, name: genesis.name,
      status: genesis.status, walletAddress: genesis.wallet_address,
    }]);
  });

  test.each(['bare', 'wrapped'])('accepts %s fixture agent', async (format) => {
    const stub = fetchStub(() => Response.json(format === 'bare' ? genesis : { agent: genesis }));
    expect(await getClawPumpAgent(AGENT_ID, { env, fetchImpl: stub.fetchImpl })).toEqual({
      id: AGENT_ID, userId: genesis.user_id, name: genesis.name,
      status: genesis.status, walletAddress: genesis.wallet_address,
    });
  });

  test('refuses an agent id that differs from the request', async () => {
    const stub = fetchStub(() => Response.json({ ...genesis, id: '11111111-1111-4111-8111-111111111111' }));
    const result = getClawPumpAgent(AGENT_ID, { env, fetchImpl: stub.fetchImpl });
    await expectClientError(result, 'schema_invalid');
    await result.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ClawPumpAgentMismatchError);
      expect(error).toBeInstanceOf(ClawPumpClientError);
      expect(String(error)).toBe('ClawPumpClientError: clawpump_schema_invalid');
      expect(JSON.stringify(error)).toBe(JSON.stringify(new ClawPumpClientError('schema_invalid')));
      expect(JSON.stringify(error)).not.toContain(AGENT_ID);
      expect(JSON.stringify(error)).not.toContain('11111111-1111-4111-8111-111111111111');
    });
  });

  test.each([null, '', '   ', undefined])('normalizes wallet %p to null', async (wallet) => {
    const stub = fetchStub(() => Response.json({ ...genesis, wallet_address: wallet }));
    expect((await getClawPumpAgent(AGENT_ID, { env, fetchImpl: stub.fetchImpl })).walletAddress).toBeNull();
  });

  test('trims wallet whitespace and normalizes absent optional fields', async () => {
    const stub = fetchStub(() => Response.json({ id: AGENT_ID, wallet_address: ` ${genesis.wallet_address} ` }));
    expect(await getClawPumpAgent(AGENT_ID, { env, fetchImpl: stub.fetchImpl })).toEqual({
      id: AGENT_ID, userId: null, name: null, status: null, walletAddress: genesis.wallet_address,
    });
  });

  test.each([
    {}, { agents: {} }, [null], [{ ...genesis, id: '' }], [{ ...genesis, id: 'x'.repeat(129) }],
    [{ ...genesis, user_id: '' }], [{ ...genesis, name: 'x'.repeat(201) }],
    [{ ...genesis, status: 'x'.repeat(41) }], [{ ...genesis, wallet_address: 'x'.repeat(65) }],
    [{ ...genesis, wallet_address: 1 }], Array.from({ length: 201 }, () => genesis),
    { agents: Array.from({ length: 201 }, () => genesis) },
  ])('refuses invalid schema or excessive agent count case %#', async (body) => {
    const stub = fetchStub(() => Response.json(body));
    await expectClientError(listClawPumpAgents({ env, fetchImpl: stub.fetchImpl }), 'schema_invalid');
  });

  test('accepts the maximum list length', async () => {
    const stub = fetchStub(() => Response.json(Array.from({ length: 200 }, () => genesis)));
    expect(await listClawPumpAgents({ env, fetchImpl: stub.fetchImpl })).toHaveLength(200);
  });

  test.each([
    ['10', 1_000], ['99999', 30_000], ['abc', 15_000], ['1234.9', 1_234], [undefined, 15_000],
  ] as const)('clamps timeout %p to %d', (value, expected) => {
    expect(resolveClawPumpConfig({ ...env, CLAWPUMP_HTTP_TIMEOUT_MS: value }).timeoutMs).toBe(expected);
  });
});
