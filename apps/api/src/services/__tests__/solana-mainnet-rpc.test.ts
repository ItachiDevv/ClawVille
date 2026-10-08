import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from 'bun:test';
import type { Connection } from '@solana/web3.js';
import * as alertModule from '../alert-error';
import {
  PUBLIC_MAINNET_RPC_URL,
  confirmSignatureByPolling,
  __resetMainnetRpcStateForTests,
  __setMainnetRpcNowForTests,
  createMainnetConnection,
  fallbackMainnetRpcUrl,
  mainnetFailoverFetch,
  mainnetRpcStatus,
  primaryMainnetRpcUrl,
  redactRpcUrl,
} from '../solana-mainnet-rpc';

const SECRET = 'SECRETKEY123';
const PRIMARY = `https://mainnet.helius-rpc.com/?api-key=${SECRET}`;
const ENV_KEYS = ['HELIUS_RPC_URL', 'HELIUS_API_KEY', 'SOLANA_MAINNET_FALLBACK_RPC_URL'] as const;
const BODY = '{"jsonrpc":"2.0","id":"1","method":"getSlot","params":[]}';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
interface Call { url: string; method?: string; body?: unknown; headers?: unknown }

let savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let primaryHandler: Handler = () => new Response('{"ok":true}');
let fallbackHandler: Handler = () => new Response('{"fallback":true}');
let now = 1_000_000;
let alertSpy: Mock<typeof alertModule.alertError>;
let warnSpy: Mock<typeof console.warn>;
let errorSpy: Mock<typeof console.error>;
let logSpy: Mock<typeof console.log>;

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers });
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    if (url.startsWith('https://mainnet.helius-rpc.com')) return primaryHandler(url, init);
    if (url.startsWith(PUBLIC_MAINNET_RPC_URL)) return fallbackHandler(url, init);
    return new Response('{"other":true}');
  }) as typeof fetch;
}

function allOutput(): string {
  const parts: unknown[] = [];
  for (const spy of [warnSpy, errorSpy, logSpy]) for (const c of spy.mock.calls) parts.push(...c);
  for (const c of alertSpy.mock.calls) parts.push(c[0]);
  return parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p) ?? String(p))).join('\n');
}

const post = (): Promise<Response> =>
  mainnetFailoverFetch(PRIMARY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: BODY });
const quota = (): Response => new Response('{"error":"Max usage reached"}', { status: 429 });
const primaryCalls = (): number => calls.filter((c) => c.url.includes('helius')).length;
const fallbackCalls = (): number => calls.filter((c) => c.url.startsWith(PUBLIC_MAINNET_RPC_URL)).length;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HELIUS_API_KEY = SECRET;
  __resetMainnetRpcStateForTests();
  now = 1_000_000;
  __setMainnetRpcNowForTests(() => now);
  calls = [];
  primaryHandler = () => new Response('{"ok":true}');
  fallbackHandler = () => new Response('{"fallback":true}');
  installFetch();
  alertSpy = spyOn(alertModule, 'alertError').mockResolvedValue(undefined);
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  expect(allOutput()).not.toContain(SECRET); // redaction holds in every test
  globalThis.fetch = realFetch;
  alertSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __resetMainnetRpcStateForTests();
});

describe('solana-mainnet-rpc url resolution', () => {
  it('primary: HELIUS_RPC_URL mainnet https > HELIUS_API_KEY > public', () => {
    expect(primaryMainnetRpcUrl()).toBe(PRIMARY);
    process.env.HELIUS_RPC_URL = 'https://devnet.helius-rpc.com/?api-key=x';
    expect(primaryMainnetRpcUrl()).toBe(PRIMARY);
    process.env.HELIUS_RPC_URL = 'https://mainnet.example.com/rpc';
    expect(primaryMainnetRpcUrl()).toBe('https://mainnet.example.com/rpc');
    delete process.env.HELIUS_RPC_URL;
    delete process.env.HELIUS_API_KEY;
    expect(primaryMainnetRpcUrl()).toBe(PUBLIC_MAINNET_RPC_URL);
  });

  it('fallback: rejects devnet/http/localhost with one warn, accepts https mainnet', () => {
    process.env.SOLANA_MAINNET_FALLBACK_RPC_URL = 'https://api.devnet.solana.com';
    expect(fallbackMainnetRpcUrl()).toBe(PUBLIC_MAINNET_RPC_URL);
    expect(fallbackMainnetRpcUrl()).toBe(PUBLIC_MAINNET_RPC_URL);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    process.env.SOLANA_MAINNET_FALLBACK_RPC_URL = 'http://localhost:8899';
    expect(fallbackMainnetRpcUrl()).toBe(PUBLIC_MAINNET_RPC_URL);
    process.env.SOLANA_MAINNET_FALLBACK_RPC_URL = 'https://rpc.example.org/';
    expect(fallbackMainnetRpcUrl()).toBe('https://rpc.example.org/');
  });

  it('redactRpcUrl strips the api key', () => {
    expect(redactRpcUrl(`fetch failed ${PRIMARY}&x=1`)).toBe('fetch failed https://mainnet.helius-rpc.com/?api-key=REDACTED&x=1');
  });
});

describe('mainnetFailoverFetch', () => {
  it('healthy: passes through to primary only', async () => {
    const res = await post();
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(PRIMARY);
    expect(mainnetRpcStatus()).toEqual({ primaryHealthy: true, downSince: null, downUntil: null, reason: null, fallbackCalls: 0 });
  });

  it('quota 429: fails over with identical request, one alert, down 15 min', async () => {
    primaryHandler = quota;
    const res = await post();
    expect(await res.json()).toEqual({ fallback: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(PUBLIC_MAINNET_RPC_URL);
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.body).toBe(BODY);
    expect(calls[1]!.headers).toEqual(calls[0]!.headers);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0]![0]).toMatchObject({ severity: 'critical', source: 'solana-mainnet-rpc' });
    expect(alertSpy.mock.calls[0]![0].message).toContain('quota');
    const st = mainnetRpcStatus();
    expect(st).toMatchObject({ primaryHealthy: false, reason: 'quota', fallbackCalls: 1 });
    expect(Date.parse(st.downUntil!) - now).toBe(15 * 60_000);
  });

  it('during the down window: skips primary; second quota does not re-alert', async () => {
    primaryHandler = quota;
    await post();
    now += 14 * 60_000;
    await post();
    expect(primaryCalls()).toBe(1);
    expect(fallbackCalls()).toBe(2);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mainnetRpcStatus().fallbackCalls).toBe(2);
  });

  it('half-open after the window: success recovers with one recovery alert', async () => {
    primaryHandler = quota;
    await post();
    now += 15 * 60_000;
    primaryHandler = () => new Response('{"ok":true}');
    const res = await post();
    expect(await res.json()).toEqual({ ok: true });
    expect(primaryCalls()).toBe(2);
    expect(alertSpy).toHaveBeenCalledTimes(2);
    expect(alertSpy.mock.calls[1]![0]).toMatchObject({ severity: 'warning', source: 'solana-mainnet-rpc' });
    expect(alertSpy.mock.calls[1]![0].message).toContain('RESOLVED');
    expect(mainnetRpcStatus()).toMatchObject({ primaryHealthy: true, reason: null });
    await post();
    expect(alertSpy).toHaveBeenCalledTimes(2);
  });

  it('half-open failure opens a new down window', async () => {
    primaryHandler = quota;
    await post();
    now += 15 * 60_000 + 1;
    await post();
    expect(primaryCalls()).toBe(2);
    expect(Date.parse(mainnetRpcStatus().downUntil!) - now).toBe(15 * 60_000);
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  for (const status of [401, 403]) {
    it(`${status}: auth episode, 15 min, alerts`, async () => {
      primaryHandler = () => new Response('nope', { status });
      const res = await post();
      expect(await res.json()).toEqual({ fallback: true });
      const st = mainnetRpcStatus();
      expect(st.reason).toBe('auth');
      expect(Date.parse(st.downUntil!) - now).toBe(15 * 60_000);
      expect(alertSpy).toHaveBeenCalledTimes(1);
    });
  }

  it('plain 429: rate, 30 s, no Telegram, recovery has no alert', async () => {
    primaryHandler = () => new Response('Too many requests', { status: 429 });
    await post();
    const st = mainnetRpcStatus();
    expect(st.reason).toBe('rate');
    expect(Date.parse(st.downUntil!) - now).toBe(30_000);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    now += 30_000;
    primaryHandler = () => new Response('{"ok":true}');
    await post();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mainnetRpcStatus().primaryHealthy).toBe(true);
  });

  it('5xx: error, 30 s, fallback response returned as is (its errors included)', async () => {
    primaryHandler = () => new Response('bad gateway', { status: 502 });
    fallbackHandler = () => new Response('also bad', { status: 503 });
    const res = await post();
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(2);
    expect(mainnetRpcStatus().reason).toBe('error');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('network error: fails over, message redacted', async () => {
    primaryHandler = () => {
      throw new TypeError(`fetch failed for ${PRIMARY}`);
    };
    const res = await post();
    expect(await res.json()).toEqual({ fallback: true });
    expect(mainnetRpcStatus().reason).toBe('error');
    expect(allOutput()).toContain('api-key=REDACTED');
  });

  it('caller abort: rethrows, no failover, no state change', async () => {
    const ctrl = new AbortController();
    primaryHandler = () => {
      ctrl.abort(new Error('caller gave up'));
      throw new Error('caller gave up');
    };
    await expect(
      mainnetFailoverFetch(PRIMARY, { method: 'POST', body: BODY, signal: ctrl.signal }),
    ).rejects.toThrow('caller gave up');
    expect(fallbackCalls()).toBe(0);
    expect(mainnetRpcStatus().primaryHealthy).toBe(true);
  });

  it('non-primary URLs pass straight through untouched', async () => {
    primaryHandler = quota;
    const init = { method: 'POST', body: BODY };
    for (const url of ['https://api.devnet.solana.com', 'https://devnet.helius-rpc.com/?api-key=x', PUBLIC_MAINNET_RPC_URL]) {
      calls = [];
      await mainnetFailoverFetch(url, init);
      expect(calls).toEqual([{ url, method: 'POST', body: BODY, headers: undefined }]);
    }
    expect(mainnetRpcStatus()).toMatchObject({ primaryHealthy: true, fallbackCalls: 0 });
  });

  it('Request input: cloned before the first send, body re-sent on failover', async () => {
    primaryHandler = quota;
    const req = new Request(PRIMARY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: BODY });
    await mainnetFailoverFetch(req);
    expect(calls).toHaveLength(2);
    expect(new TextDecoder().decode(calls[1]!.body as ArrayBuffer)).toBe(BODY);
  });

  it('ReadableStream body: primary response returned unchanged', async () => {
    primaryHandler = quota;
    const body = new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode(BODY)); c.close(); } });
    const res = await mainnetFailoverFetch(PRIMARY, { method: 'POST', body });
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(1);
  });
});

describe('createMainnetConnection', () => {
  it('one primary + one fallback request per getSlot when primary returns quota 429', async () => {
    primaryHandler = quota;
    fallbackHandler = (_url, init) => {
      const { id } = JSON.parse(String(init?.body)) as { id: unknown };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: 4242 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const conn = createMainnetConnection('confirmed');
    expect(await conn.getSlot()).toBe(4242);
    expect(primaryCalls()).toBe(1);
    expect(fallbackCalls()).toBe(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it('no web3.js 429 retry loop: fallback 429 surfaces after one call each', async () => {
    primaryHandler = quota;
    fallbackHandler = () => new Response('Too many requests', { status: 429 });
    await expect(createMainnetConnection('confirmed').getSlot()).rejects.toThrow('429');
    expect(primaryCalls()).toBe(1);
    expect(fallbackCalls()).toBe(1);
  });

  it('accepts a ConnectionConfig and keeps its commitment', () => {
    expect(createMainnetConnection({ commitment: 'finalized' }).commitment).toBe('finalized');
    expect(createMainnetConnection().rpcEndpoint).toBe(PRIMARY);
  });
});

describe('confirmSignatureByPolling (HTTP only, no websocket)', () => {
  type St = { err: unknown; confirmationStatus: string | null; slot: number } | null;
  function fakeConn(statuses: St[], heights: number[]) {
    const statusCalls: Array<{ searchTransactionHistory: boolean }> = [];
    let heightCalls = 0;
    const conn = {
      getSignatureStatuses: async (_sigs: string[], cfg: { searchTransactionHistory: boolean }) => {
        statusCalls.push(cfg);
        const v = statuses.length > 1 ? statuses.shift()! : statuses[0];
        return { context: { slot: 1 }, value: [v] };
      },
      getBlockHeight: async () => {
        heightCalls += 1;
        return heights.length > 1 ? heights.shift()! : heights[0];
      },
    };
    return { conn: conn as unknown as Connection, statusCalls, heights: () => heightCalls };
  }
  const noSleep = async () => {};

  it('confirmed: returns once the status reaches confirmed', async () => {
    const f = fakeConn(
      [null, { err: null, confirmationStatus: 'processed', slot: 9 }, { err: null, confirmationStatus: 'confirmed', slot: 10 }],
      [100],
    );
    const r = await confirmSignatureByPolling(f.conn, 'sig', { lastValidBlockHeight: 200, sleep: noSleep });
    expect(r).toEqual({ status: 'confirmed', slot: 10 });
    expect(f.statusCalls.every((c) => c.searchTransactionHistory === false)).toBe(true);
  });

  it('err: final only at the commitment level; a processed err is not final', async () => {
    const f = fakeConn(
      [
        { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed', slot: 5 },
        { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed', slot: 6 },
      ],
      [100],
    );
    const r = await confirmSignatureByPolling(f.conn, 'sig', { lastValidBlockHeight: 200, sleep: noSleep });
    expect(r).toEqual({ status: 'failed', err: { InstructionError: [0, 'Custom'] }, slot: 6 });
    expect(f.statusCalls.length).toBe(2);
  });

  it('expired-then-found: past lastValidBlockHeight, the history check finds it confirmed', async () => {
    const f = fakeConn([null, { err: null, confirmationStatus: 'finalized', slot: 77 }], [201]);
    const r = await confirmSignatureByPolling(f.conn, 'sig', { lastValidBlockHeight: 200, sleep: noSleep });
    expect(r).toEqual({ status: 'confirmed', slot: 77 });
    expect(f.statusCalls.map((c) => c.searchTransactionHistory)).toEqual([false, true]);
  });

  it('expired-not-found: returns expired after ONE history check', async () => {
    const f = fakeConn([null], [150, 201]);
    const r = await confirmSignatureByPolling(f.conn, 'sig', { lastValidBlockHeight: 200, sleep: noSleep });
    expect(r).toEqual({ status: 'expired' });
    expect(f.statusCalls.map((c) => c.searchTransactionHistory)).toEqual([false, false, true]);
  });

  it('finalized commitment: confirmed is not enough', async () => {
    const f = fakeConn(
      [{ err: null, confirmationStatus: 'confirmed', slot: 3 }, { err: null, confirmationStatus: 'finalized', slot: 3 }],
      [100],
    );
    const r = await confirmSignatureByPolling(f.conn, 'sig', { lastValidBlockHeight: 200, commitment: 'finalized', sleep: noSleep });
    expect(r).toEqual({ status: 'confirmed', slot: 3 });
    expect(f.statusCalls.length).toBe(2);
  });

  it('transient RPC errors are retried; N consecutive errors throw (ambiguous) with the key redacted', async () => {
    let n = 0;
    const conn = {
      getSignatureStatuses: async () => {
        n += 1;
        throw new Error(`fetch failed ${PRIMARY}`);
      },
      getBlockHeight: async () => 1,
    } as unknown as Connection;
    const err = await confirmSignatureByPolling(conn, 'sig', {
      lastValidBlockHeight: 200,
      sleep: noSleep,
      maxConsecutiveRpcErrors: 3,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(SECRET);
    expect(n).toBe(3);
  });

  it('through the failover connection: Helius quota-dead, public RPC answers, no websocket used', async () => {
    primaryHandler = quota;
    fallbackHandler = (_url, init) => {
      const req = JSON.parse(String(init?.body)) as { id: string; method: string };
      const result = req.method === 'getSignatureStatuses'
        ? { context: { slot: 50 }, value: [{ slot: 49, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] }
        : 10;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const conn = createMainnetConnection('confirmed', PRIMARY);
    const r = await confirmSignatureByPolling(conn, '1'.repeat(64), { lastValidBlockHeight: 200, sleep: async () => {} });
    expect(r).toEqual({ status: 'confirmed', slot: 49 });
    expect(primaryCalls()).toBe(1);
    expect(fallbackCalls()).toBe(1);
  });
});
