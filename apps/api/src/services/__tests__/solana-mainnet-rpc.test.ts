import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from 'bun:test';
import type { Connection } from '@solana/web3.js';
import * as alertModule from '../alert-error';
import {
  PUBLIC_MAINNET_RPC_URL,
  acquireFallbackTokens,
  confirmSignatureByPolling,
  __markFallbackProvenForTests,
  __resetMainnetRpcStateForTests,
  __setFallbackLimiterSleepForTests,
  __setMainnetRpcNowForTests,
  __setMainnetRpcTimeoutMsForTests,
  createMainnetConnection,
  provenFallbackMainnetRpcUrl,
  fallbackMainnetRpcUrl,
  fallbackMaxRps,
  mainnetFailoverFetch,
  mainnetRpcStatus,
  primaryMainnetRpcUrl,
  redactRpcUrl,
} from '../solana-mainnet-rpc';

const SECRET = 'SECRETKEY123';
const PRIMARY = `https://mainnet.helius-rpc.com/?api-key=${SECRET}`;
const ENV_KEYS = ['HELIUS_RPC_URL', 'HELIUS_API_KEY', 'SOLANA_MAINNET_FALLBACK_RPC_URL', 'SOLANA_MAINNET_FALLBACK_MAX_RPS'] as const;
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

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const genesisOk = (): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: MAINNET_GENESIS }));
let genesisHandler: Handler = genesisOk;
let probes: string[] = [];

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (typeof init?.body === 'string' && init.body.includes('"getGenesisHash"')) {
      probes.push(url); // the fallback's mainnet proof, kept out of `calls`
      if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
      return genesisHandler(url, init);
    }
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
  probes = [];
  genesisHandler = genesisOk;
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
    expect(mainnetRpcStatus()).toEqual({
      primaryHealthy: true,
      downSince: null,
      downUntil: null,
      reason: null,
      fallbackCalls: 0,
      fallbackRateLimited: 0,
      fallbackLocalLimited: 0,
    });
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
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes(' down ('))).toHaveLength(1);
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

describe('fallback mainnet proof (B1) and fallback timeout (F2)', () => {
  const hang: Handler = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(init.signal.reason);
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });

  it('genesis probe passes: fails over, one probe to the fallback', async () => {
    primaryHandler = quota;
    const res = await post();
    expect(await res.json()).toEqual({ fallback: true });
    expect(probes).toEqual([PUBLIC_MAINNET_RPC_URL]);
    expect(fallbackCalls()).toBe(1);
  });

  it('wrong genesis: no failover, the primary response returns, one alert per process', async () => {
    primaryHandler = quota;
    genesisHandler = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }));
    const res = await post();
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('Max usage');
    expect(fallbackCalls()).toBe(0);
    expect(mainnetRpcStatus()).toMatchObject({ primaryHealthy: true, fallbackCalls: 0 });
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0]![0]).toMatchObject({ severity: 'critical', source: 'solana-mainnet-rpc' });
    expect(alertSpy.mock.calls[0]![0].message).toContain('no failover');
    now += 61_000;
    await post();
    expect(probes).toHaveLength(2);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(fallbackCalls()).toBe(0);
  });

  it('network error with an unproven fallback: the primary error is thrown', async () => {
    primaryHandler = () => {
      throw new TypeError('connect ECONNREFUSED');
    };
    genesisHandler = () => new Response('nope', { status: 500 });
    await expect(post()).rejects.toThrow('ECONNREFUSED');
    expect(fallbackCalls()).toBe(0);
  });

  it('a good proof is cached: one probe for N failovers', async () => {
    primaryHandler = () => new Response('bad gateway', { status: 502 });
    for (let i = 0; i < 5; i += 1) {
      await post();
      now += 31_000; // past the 30 s window, so the next call probes the primary again
    }
    expect(primaryCalls()).toBe(5);
    expect(fallbackCalls()).toBe(5);
    expect(probes).toHaveLength(1);
  });

  it('a failed probe is cached for 60 s, then re-probed', async () => {
    primaryHandler = quota;
    genesisHandler = () => {
      throw new TypeError('fallback unreachable');
    };
    expect((await post()).status).toBe(429);
    now += 59_999;
    expect((await post()).status).toBe(429);
    expect(probes).toHaveLength(1);
    now += 2;
    genesisHandler = genesisOk;
    const res = await post();
    expect(await res.json()).toEqual({ fallback: true });
    expect(probes).toHaveLength(2);
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('verdict'))).toHaveLength(2);
  });

  it('IP-literal, internal and single-label fallback hosts are rejected (no DNS)', () => {
    for (const bad of [
      'https://127.0.0.2',
      'https://10.0.0.5/rpc',
      'https://0x7f.1',
      'https://[::1]',
      'https://clawville-db',
      'https://rpc.internal',
      'https://node.local',
    ]) {
      process.env.SOLANA_MAINNET_FALLBACK_RPC_URL = bad;
      expect(fallbackMainnetRpcUrl()).toBe(PUBLIC_MAINNET_RPC_URL);
    }
  });

  it('fallback timeout: throws to the caller after one fallback send, no retry', async () => {
    __setMainnetRpcTimeoutMsForTests(20);
    primaryHandler = quota;
    fallbackHandler = hang;
    await expect(post()).rejects.toThrow('fallback timeout after 20 ms');
    expect(primaryCalls()).toBe(1);
    expect(fallbackCalls()).toBe(1);
  });

  it('primary timeout fails over', async () => {
    __setMainnetRpcTimeoutMsForTests(20);
    primaryHandler = hang;
    const res = await post();
    expect(await res.json()).toEqual({ fallback: true });
    expect(mainnetRpcStatus().reason).toBe('error');
  });

  const stalledBody = (): Response => new Response(new ReadableStream({ start() {} }), { status: 200 });

  it('stalled primary BODY: times out as an error trigger and fails over', async () => {
    __setMainnetRpcTimeoutMsForTests(20);
    primaryHandler = stalledBody;
    const res = await post();
    expect(await res.json()).toEqual({ fallback: true });
    expect(mainnetRpcStatus().reason).toBe('error');
  });

  it('stalled fallback BODY: error to the caller within the timeout, no retry', async () => {
    __setMainnetRpcTimeoutMsForTests(20);
    primaryHandler = quota;
    fallbackHandler = stalledBody;
    const t0 = Date.now();
    await expect(post()).rejects.toThrow('fallback timeout after 20 ms');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(fallbackCalls()).toBe(1);
  });

  it('buffered responses keep status, statusText and headers; the 429 peek still works', async () => {
    primaryHandler = () => new Response('{"ok":1}', { status: 200, statusText: 'OK', headers: { 'x-test': 'yes' } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
    expect(res.headers.get('x-test')).toBe('yes');
    expect(await res.text()).toBe('{"ok":1}');
  });

  it('provenFallbackMainnetRpcUrl: the URL when proven, null when not (one cached probe each)', async () => {
    expect(await provenFallbackMainnetRpcUrl()).toBe(PUBLIC_MAINNET_RPC_URL);
    expect(await provenFallbackMainnetRpcUrl()).toBe(PUBLIC_MAINNET_RPC_URL);
    expect(probes).toHaveLength(1);
    process.env.SOLANA_MAINNET_FALLBACK_RPC_URL = 'https://rpc.example.org/';
    genesisHandler = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }));
    expect(await provenFallbackMainnetRpcUrl()).toBeNull();
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it('caller abort during the fallback send rethrows', async () => {
    primaryHandler = quota;
    const ctrl = new AbortController();
    fallbackHandler = (url, init) => {
      ctrl.abort(new Error('caller gave up'));
      return hang(url, init);
    };
    await expect(
      mainnetFailoverFetch(PRIMARY, { method: 'POST', body: BODY, signal: ctrl.signal }),
    ).rejects.toThrow('caller gave up');
    expect(fallbackCalls()).toBe(1);
  });

  it('no leaked timers: every timer the module starts is cleared', async () => {
    const started: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const setSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const t = realSet(fn, ms);
      started.push(t);
      return t;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((t?: Parameters<typeof clearTimeout>[0]) => {
      cleared.add(t);
      realClear(t);
    }) as typeof clearTimeout);
    try {
      __setMainnetRpcTimeoutMsForTests(20);
      await post(); // healthy
      primaryHandler = quota;
      await post(); // probe + failover
      now += 16 * 60_000;
      primaryHandler = () => {
        throw new TypeError('reset');
      };
      await post(); // network error + failover
      now += 31_000;
      fallbackHandler = hang;
      await expect(post()).rejects.toThrow('fallback timeout'); // fallback timeout
      now += 31_000;
      fallbackHandler = stalledBody;
      await expect(post()).rejects.toThrow('fallback timeout'); // stalled fallback body
      now += 31_000;
      primaryHandler = stalledBody;
      fallbackHandler = () => new Response('{"fallback":true}');
      await post(); // stalled primary body + failover
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
    expect(started.length).toBeGreaterThanOrEqual(7);
    expect(started.filter((t) => !cleared.has(t))).toEqual([]);
  });
});

describe('fallback rate limiter (public RPC budget, 2026-10-08)', () => {
  const LOCAL_429 = '{"jsonrpc":"2.0","error":{"code":429,"message":"fallback rate limited (local)"}}';
  const RATE = 1000 / 6;

  /** Primary quota-dead, fallback pre-proven (no probe token), breaker already open after one failover send. */
  async function openBreaker(): Promise<void> {
    __markFallbackProvenForTests();
    primaryHandler = quota;
    await post(); // 1 fallback token used
    expect(primaryCalls()).toBe(1);
  }

  it('burst of 10, then spaced to 6/s on the fake clock', async () => {
    const waits: number[] = [];
    __setFallbackLimiterSleepForTests(async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await openBreaker();
    const t0 = now;
    for (let i = 0; i < 19; i += 1) expect((await post()).status).toBe(200);
    expect(fallbackCalls()).toBe(20);
    expect(primaryCalls()).toBe(1);
    // Tokens 2..10 are free; each of the next 10 waits one refill interval (1/6 s).
    expect(waits).toHaveLength(10);
    for (const w of waits) expect(w).toBeCloseTo(RATE, 6);
    expect(now - t0).toBeCloseTo(10 * RATE, 3);
    expect(mainnetRpcStatus()).toMatchObject({ fallbackCalls: 20, fallbackLocalLimited: 0 });
  });

  it('waits up to 3 s, then returns the local 429 without calling the fallback', async () => {
    const waits: number[] = [];
    __setFallbackLimiterSleepForTests(async (ms) => {
      waits.push(ms); // the clock stays frozen: no refill
    });
    await openBreaker();
    const results = await Promise.all(Array.from({ length: 30 }, () => post()));
    const statuses = results.map((r) => r.status);
    // 9 tokens left + 18 reservations within 3 s (1/6 s .. 3 s) = 27 sends; the last 3 are refused locally.
    expect(statuses.filter((st) => st === 200)).toHaveLength(27);
    expect(statuses.filter((st) => st === 429)).toHaveLength(3);
    expect(fallbackCalls()).toBe(28);
    expect(waits).toHaveLength(18);
    expect(Math.max(...waits)).toBeCloseTo(3_000, 6);
    expect(await results[29]!.text()).toBe(LOCAL_429);
    expect(mainnetRpcStatus()).toMatchObject({ fallbackCalls: 28, fallbackLocalLimited: 3, fallbackRateLimited: 0 });
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('fallback budget exhausted'))).toHaveLength(1);
  });

  it('web3.js sees the local 429 as a rate-limit error (callers fail closed)', async () => {
    __setFallbackLimiterSleepForTests(async () => {});
    await openBreaker();
    for (let i = 0; i < 27; i += 1) await post(); // bucket and 3 s of reservations used up
    const before = fallbackCalls();
    await expect(createMainnetConnection('confirmed').getSlot()).rejects.toThrow('429');
    expect(fallbackCalls()).toBe(before);
  });

  it('never limits the primary: 60 healthy requests on a frozen clock, no waits', async () => {
    const waits: number[] = [];
    __setFallbackLimiterSleepForTests(async (ms) => {
      waits.push(ms);
    });
    for (let i = 0; i < 60; i += 1) expect((await post()).status).toBe(200);
    expect(primaryCalls()).toBe(60);
    expect(waits).toEqual([]);
    expect(mainnetRpcStatus()).toMatchObject({ fallbackCalls: 0, fallbackLocalLimited: 0 });
  });

  it('caller abort while waiting rejects, sends nothing, returns the reservation, clears its timer', async () => {
    await openBreaker();
    for (let i = 0; i < 9; i += 1) await post(); // bucket empty, clock frozen: the next send waits 1/6 s
    const sent = fallbackCalls();
    const started: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const setSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const t = realSet(fn, ms);
      started.push(t);
      return t;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((t?: Parameters<typeof clearTimeout>[0]) => {
      cleared.add(t);
      realClear(t);
    }) as typeof clearTimeout);
    try {
      const ctrl = new AbortController();
      const pending = mainnetFailoverFetch(PRIMARY, { method: 'POST', body: BODY, signal: ctrl.signal });
      await new Promise<void>((r) => realSet(r, 10));
      ctrl.abort(new Error('caller gave up'));
      await expect(pending).rejects.toThrow('caller gave up');
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
    expect(fallbackCalls()).toBe(sent);
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(started.filter((t) => !cleared.has(t))).toEqual([]);
    // The reservation came back: the next request waits one interval again, not two.
    const waits: number[] = [];
    __setFallbackLimiterSleepForTests(async (ms) => {
      waits.push(ms);
    });
    await post();
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeCloseTo(RATE, 6);
  });

  it('the genesis probe takes a token too', async () => {
    primaryHandler = quota;
    await post(); // probe + one fallback send = 2 tokens
    expect(probes).toHaveLength(1);
    __setFallbackLimiterSleepForTests(async () => {});
    const results = await Promise.all(Array.from({ length: 30 }, () => post()));
    // 8 tokens left + 18 reservations = 26 sends.
    expect(results.filter((r) => r.status === 200)).toHaveLength(26);
    expect(probes).toHaveLength(1);
  });

  it('a fallback HTTP 429 is counted, warned at most once per minute', async () => {
    await openBreaker();
    fallbackHandler = () => new Response('Too many requests', { status: 429 });
    for (let i = 0; i < 3; i += 1) expect((await post()).status).toBe(429);
    const warns = (): number => warnSpy.mock.calls.filter((c) => String(c[0]).includes('answered HTTP 429')).length;
    expect(mainnetRpcStatus().fallbackRateLimited).toBe(3);
    expect(warns()).toBe(1);
    now += 60_000;
    await post();
    expect(mainnetRpcStatus().fallbackRateLimited).toBe(4);
    expect(warns()).toBe(2);
  });

  /** Frozen clock, instant sleep: take tokens until the limiter refuses (3 s of reservations used up). */
  async function drainBudget(waits: number[]): Promise<void> {
    __setFallbackLimiterSleepForTests(async (ms) => {
      waits.push(ms);
    });
    while (await acquireFallbackTokens(1)) {
      /* keep taking */
    }
    waits.length = 0;
  }

  it('Codex B1: a sendTransaction (single or in a batch) is never limited; a read in the same state is', async () => {
    const waits: number[] = [];
    await openBreaker();
    await drainBudget(waits);
    const sendBody = '{"jsonrpc":"2.0","id":"7","method":"sendTransaction","params":["AQID",{"encoding":"base64"}]}';
    const before = fallbackCalls();
    const sent = await mainnetFailoverFetch(PRIMARY, { method: 'POST', body: sendBody });
    expect(sent.status).toBe(200);
    const batch = await mainnetFailoverFetch(PRIMARY, {
      method: 'POST',
      body: new TextEncoder().encode(`[{"jsonrpc":"2.0","id":1,"method":"getSlot"},${sendBody}]`),
    });
    expect(batch.status).toBe(200);
    expect(fallbackCalls()).toBe(before + 2);
    expect(calls.slice(-2).map((c) => c.url)).toEqual([PUBLIC_MAINNET_RPC_URL, PUBLIC_MAINNET_RPC_URL]);
    expect(waits).toEqual([]);
    expect(mainnetRpcStatus().fallbackCalls).toBe(before + 2);
    const local = mainnetRpcStatus().fallbackLocalLimited;
    // A read (incl. a getSignatureStatuses poll) in the same state is refused locally, no fallback call.
    const read = await mainnetFailoverFetch(PRIMARY, {
      method: 'POST',
      body: '{"jsonrpc":"2.0","id":"8","method":"getSignatureStatuses","params":[["sig"]]}',
    });
    expect(read.status).toBe(429);
    expect(await read.text()).toBe(LOCAL_429);
    expect(fallbackCalls()).toBe(before + 2);
    expect(mainnetRpcStatus().fallbackLocalLimited).toBe(local + 1);
  });

  it('acquireFallbackTokens(n): takes n from the same bucket, waits up to 3 s, refuses beyond, rejects bad n', async () => {
    const waits: number[] = [];
    __setFallbackLimiterSleepForTests(async (ms) => {
      waits.push(ms);
    });
    expect(await acquireFallbackTokens(10)).toBe(true); // full burst, no wait
    expect(waits).toEqual([]);
    expect(await acquireFallbackTokens(3)).toBe(true); // 3 tokens due in 0.5 s
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeCloseTo(500, 6);
    expect(await acquireFallbackTokens(10)).toBe(true); // balance -3: due in (10 + 3) / 6 s = 2.17 s
    expect(await acquireFallbackTokens(3)).toBe(true); // balance -13: due in 16 / 6 s = 2.67 s
    expect(await acquireFallbackTokens(2)).toBe(true); // balance -16: due in 18 / 6 s = 3.0 s, the limit
    expect(waits[waits.length - 1]).toBeCloseTo(3_000, 6);
    expect(await acquireFallbackTokens(1)).toBe(false); // balance -18: 19 / 6 s = 3.17 s, refused, nothing reserved
    expect(await acquireFallbackTokens(1)).toBe(false);
    expect(mainnetRpcStatus().fallbackLocalLimited).toBe(2);
    for (const bad of [0, 11, 1.5, Number.NaN]) {
      await expect(acquireFallbackTokens(bad)).rejects.toThrow('n must be an integer');
    }
  });

  it('acquireFallbackTokens(n): a caller abort while waiting rejects and returns all n reserved tokens', async () => {
    expect(await acquireFallbackTokens(10)).toBe(true);
    const ctrl = new AbortController();
    const pending = acquireFallbackTokens(5, ctrl.signal); // real sleep: 5 / 6 s
    ctrl.abort(new Error('caller gave up'));
    await expect(pending).rejects.toThrow('caller gave up');
    const waits: number[] = [];
    __setFallbackLimiterSleepForTests(async (ms) => {
      waits.push(ms);
    });
    expect(await acquireFallbackTokens(5)).toBe(true);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeCloseTo(5_000 / 6, 6); // not 10 / 6 s: the aborted 5 came back
  });

  it('SOLANA_MAINNET_FALLBACK_MAX_RPS: 1..50 accepted, anything else is the default 6 with one warn', () => {
    expect(fallbackMaxRps()).toBe(6);
    process.env.SOLANA_MAINNET_FALLBACK_MAX_RPS = '12';
    expect(fallbackMaxRps()).toBe(12);
    for (const bad of ['0', '51', 'abc', '-3']) {
      process.env.SOLANA_MAINNET_FALLBACK_MAX_RPS = bad;
      expect(fallbackMaxRps()).toBe(6);
      expect(fallbackMaxRps()).toBe(6);
    }
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('MAX_RPS ignored'))).toHaveLength(4);
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
