import { describe, it, expect } from 'bun:test';
import {
  InferenceRouter,
  type InferenceEndpoint,
  type RouteTable,
} from '../inference-router';
import {
  buildEndpointsFromEnv,
  buildRouteTableFromEnv,
  resolveInferenceRoute,
} from '../inference-config';

// --- mock fetch: route by a host fragment to a per-endpoint responder --------
type Responder = () => { ok: boolean; status?: number; content?: string };

function makeFetch(
  behaviors: Record<string, Responder>,
  calls: Record<string, number>,
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const key = Object.keys(behaviors).find((k) => u.includes(k));
    if (!key) throw new Error(`no mock behavior for ${u}`);
    calls[key] = (calls[key] ?? 0) + 1;
    const r = behaviors[key]();
    if (!r.ok) {
      return {
        ok: false,
        status: r.status ?? 500,
        statusText: 'ERR',
        text: async () => 'upstream boom',
        json: async () => ({}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: r.content ?? 'hi' } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const OPENAI: InferenceEndpoint = {
  id: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  smallModel: 'gpt-4o-mini',
  largeModel: 'gpt-4o',
  kind: 'cloud',
  timeoutMs: 1000,
};
const PRIMARY: InferenceEndpoint = {
  id: 'local-primary',
  baseUrl: 'http://prim.local:11434/v1',
  smallModel: 'qwen3:14b',
  largeModel: 'qwen3:14b',
  kind: 'local',
  timeoutMs: 1000,
};
const SECONDARY: InferenceEndpoint = {
  id: 'local-secondary',
  baseUrl: 'http://sec.local:11434/v1',
  smallModel: 'qwen3.6:27b',
  largeModel: 'qwen3.6:27b',
  kind: 'local',
  timeoutMs: 1000,
};
const ROUTES: RouteTable = {
  teacher: ['openai'],
  fleet: ['local-primary', 'local-secondary', 'openai'],
  'hosted-user': ['openai'],
  default: ['openai'],
};

const ok = (content = 'ok'): Responder => () => ({ ok: true, content });
const fail = (): Responder => () => ({ ok: false, status: 503 });

function router(
  behaviors: Record<string, Responder>,
  opts?: { clock?: { t: number }; breaker?: { failThreshold?: number; cooldownMs?: number } },
) {
  const calls: Record<string, number> = {};
  const clock = opts?.clock ?? { t: 0 };
  const r = new InferenceRouter({
    endpoints: [OPENAI, PRIMARY, SECONDARY],
    routes: ROUTES,
    breaker: { failThreshold: opts?.breaker?.failThreshold ?? 3, cooldownMs: opts?.breaker?.cooldownMs ?? 1000 },
    fetchImpl: makeFetch(behaviors, calls),
    now: () => clock.t,
  });
  return { r, calls, clock };
}

// A router with ONE local (no second local → no round-robin), so the breaker /
// failover ordering is deterministic: fleet = [local-primary, openai].
function router1(
  behaviors: Record<string, Responder>,
  opts?: { clock?: { t: number }; breaker?: { failThreshold?: number; cooldownMs?: number } },
) {
  const calls: Record<string, number> = {};
  const clock = opts?.clock ?? { t: 0 };
  const r = new InferenceRouter({
    endpoints: [OPENAI, PRIMARY],
    routes: { teacher: ['openai'], fleet: ['local-primary', 'openai'], 'hosted-user': ['openai'], default: ['openai'] },
    breaker: { failThreshold: opts?.breaker?.failThreshold ?? 3, cooldownMs: opts?.breaker?.cooldownMs ?? 1000 },
    fetchImpl: makeFetch(behaviors, calls),
    now: () => clock.t,
  });
  return { r, calls, clock };
}

describe('InferenceRouter routing', () => {
  it('teacher route hits OpenAI and NEVER a local box (even when locals are up)', async () => {
    const { r, calls } = router({
      'api.openai.com': ok('teacher-reply'),
      'prim.local': ok('LOCAL'),
      'sec.local': ok('LOCAL'),
    });
    const res = await r.generateText({ route: 'teacher', size: 'small', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.endpointId).toBe('openai');
    expect(res.text).toBe('teacher-reply');
    expect(calls['prim.local']).toBeUndefined();
    expect(calls['sec.local']).toBeUndefined();
  });

  it('fleet route prefers local-primary when healthy', async () => {
    const { r, calls } = router({
      'api.openai.com': ok('CLOUD'),
      'prim.local': ok('local-reply'),
      'sec.local': ok('SECONDARY'),
    });
    const res = await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.endpointId).toBe('local-primary');
    expect(res.text).toBe('local-reply');
    expect(calls['api.openai.com']).toBeUndefined();
    expect(calls['sec.local']).toBeUndefined();
  });

  it('fleet fails over primary → secondary → openai', async () => {
    // primary + secondary down, openai up
    const { r, calls } = router({
      'api.openai.com': ok('CLOUD-FALLBACK'),
      'prim.local': fail(),
      'sec.local': fail(),
    });
    const res = await r.generateText({ route: 'fleet', size: 'large', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.endpointId).toBe('openai');
    expect(res.text).toBe('CLOUD-FALLBACK');
    expect(calls['prim.local']).toBe(1);
    expect(calls['sec.local']).toBe(1);
    expect(calls['api.openai.com']).toBe(1);
  });

  it('opens the breaker after failThreshold and SKIPS the dead endpoint on the next call', async () => {
    // router1 = single local (no round-robin) so ordering is deterministic.
    const { r, calls } = router1(
      { 'api.openai.com': ok('CLOUD'), 'prim.local': fail() },
      { breaker: { failThreshold: 2, cooldownMs: 1000 } },
    );

    // 2 fleet calls → 2 primary failures → breaker opens (each falls over to openai)
    await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'a' }] });
    await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'b' }] });
    expect(calls['prim.local']).toBe(2);

    // 3rd call while breaker OPEN → primary skipped (no new fetch), served by openai
    const res = await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'c' }] });
    expect(res.endpointId).toBe('openai');
    expect(calls['prim.local']).toBe(2); // unchanged — skipped
  });

  it('half-open probe recovers the endpoint after the cooldown elapses', async () => {
    let primUp = false;
    const clock = { t: 0 };
    const { r, calls } = router1(
      {
        'api.openai.com': ok('CLOUD'),
        'prim.local': () => (primUp ? { ok: true, content: 'LOCAL-BACK' } : { ok: false, status: 503 }),
      },
      { clock, breaker: { failThreshold: 2, cooldownMs: 1000 } },
    );

    await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'a' }] });
    await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'b' }] });
    expect(calls['prim.local']).toBe(2); // breaker now open

    // primary recovers; advance clock past cooldown → half-open probe hits primary and closes it
    primUp = true;
    clock.t = 2000;
    const res = await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'c' }] });
    expect(res.endpointId).toBe('local-primary');
    expect(res.text).toBe('LOCAL-BACK');
    expect(calls['prim.local']).toBe(3); // probed again
  });

  it('always attempts the LAST endpoint even when its breaker is open (no total blackout)', async () => {
    const { r, calls } = router(
      { 'api.openai.com': fail(), 'prim.local': fail(), 'sec.local': fail() },
      { breaker: { failThreshold: 1, cooldownMs: 100_000 } },
    );
    // teacher = ['openai'] only. First call fails → breaker opens (threshold 1).
    await expect(
      r.generateText({ route: 'teacher', size: 'small', messages: [{ role: 'user', content: 'a' }] }),
    ).rejects.toThrow();
    expect(calls['api.openai.com']).toBe(1);
    // Second call while OPEN — last-resort is always attempted, so openai is hit again (not skipped to a hard no-op).
    await expect(
      r.generateText({ route: 'teacher', size: 'small', messages: [{ role: 'user', content: 'b' }] }),
    ).rejects.toThrow();
    expect(calls['api.openai.com']).toBe(2);
  });

  it('strips <think>…</think> from local responses but leaves cloud untouched', async () => {
    const { r } = router({
      'api.openai.com': ok('plain cloud'),
      'prim.local': ok('<think>lots of reasoning</think>Final answer.'),
      'sec.local': ok('x'),
    });
    const local = await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'q' }] });
    expect(local.endpointId).toBe('local-primary');
    expect(local.text).toBe('Final answer.');
    const cloud = await r.generateText({ route: 'teacher', size: 'small', messages: [{ role: 'user', content: 'q' }] });
    expect(cloud.text).toBe('plain cloud');
  });
});

describe('inference-config env parsing', () => {
  it('unset env ⇒ pure OpenAI (safe default, no local endpoint)', () => {
    const eps = buildEndpointsFromEnv({});
    expect(eps.map((e) => e.id)).toEqual(['openai']);
    const table = buildRouteTableFromEnv(eps, {});
    expect(table.fleet).toEqual(['openai']);
    expect(table.teacher).toEqual(['openai']);
  });

  it('local-primary configured ⇒ fleet routes local-first with OpenAI fallback; teacher stays OpenAI-only', () => {
    const env = { INFERENCE_LOCAL_PRIMARY_URL: 'http://box:11434/v1/', OPENAI_API_KEY: 'sk' };
    const eps = buildEndpointsFromEnv(env);
    expect(eps.map((e) => e.id)).toEqual(['openai', 'local-primary']);
    expect(eps.find((e) => e.id === 'local-primary')!.baseUrl).toBe('http://box:11434/v1'); // trailing slash trimmed
    const table = buildRouteTableFromEnv(eps, env);
    expect(table.fleet).toEqual(['local-primary', 'openai']);
    expect(table.teacher).toEqual(['openai']);
    expect(table['hosted-user']).toEqual(['openai']);
  });

  it('route override always keeps OpenAI as the ultimate fallback', () => {
    const env = {
      INFERENCE_LOCAL_PRIMARY_URL: 'http://a:11434/v1',
      INFERENCE_LOCAL_SECONDARY_URL: 'http://b:11434/v1',
      INFERENCE_ROUTE_FLEET: 'local-secondary,local-primary', // no openai listed
    };
    const table = buildRouteTableFromEnv(buildEndpointsFromEnv(env), env);
    expect(table.fleet).toEqual(['local-secondary', 'local-primary', 'openai']);
  });

  it('L1 — teacher route STRIPS a local endpoint even if env tries to add one (not overridable)', () => {
    const env = {
      INFERENCE_LOCAL_PRIMARY_URL: 'http://a:11434/v1',
      INFERENCE_ROUTE_TEACHER: 'local-primary,openai', // malicious/mistaken flip
    };
    const table = buildRouteTableFromEnv(buildEndpointsFromEnv(env), env);
    expect(table.teacher).toEqual(['openai']); // local-primary stripped
  });

  it('L3 — duplicate ids in a route are de-duped (no double-attempt)', () => {
    const env = { INFERENCE_ROUTE_DEFAULT: 'openai,openai' };
    const table = buildRouteTableFromEnv(buildEndpointsFromEnv(env), env);
    expect(table.default).toEqual(['openai']);
  });

  it('resolveInferenceRoute maps agent types correctly (only house → fleet)', () => {
    expect(resolveInferenceRoute('openclaw-bot', true)).toBe('fleet');
    expect(resolveInferenceRoute('location-agent', false)).toBe('teacher');
    expect(resolveInferenceRoute('system-agent', false)).toBe('teacher');
    expect(resolveInferenceRoute('avatar-agent', false)).toBe('hosted-user');
    expect(resolveInferenceRoute('openclaw-bot', false)).toBe('hosted-user');
    expect(resolveInferenceRoute('something-else', false)).toBe('default');
  });

  it('H1 — a teacher flagged isHouse is STILL teacher, never fleet (structural isolation)', () => {
    // The dangerous input the invariant exists to survive: a data bug marks a
    // teacher house. Type is checked first, so it can never resolve to a local box.
    expect(resolveInferenceRoute('location-agent', true)).toBe('teacher');
    expect(resolveInferenceRoute('system-agent', true)).toBe('teacher');
    expect(resolveInferenceRoute('location-agent', true)).not.toBe('fleet');
    expect(resolveInferenceRoute('system-agent', true)).not.toBe('fleet');
  });
});

describe('InferenceRouter breaker timing + concurrency + error paths', () => {
  it('M1 — a failing call whose latency EXCEEDS cooldown still OPENS the breaker (dead box is skipped, not re-probed)', async () => {
    // primary "hangs" ~60s before failing (advances the shared clock during the call);
    // cooldown is 30s. With the stale-timestamp bug, openUntil would land in the past
    // and primary would be re-probed on the next call. With the fix it stays open.
    const clock = { t: 0 };
    const { r, calls } = router1(
      {
        'api.openai.com': ok('CLOUD'),
        'prim.local': () => {
          clock.t += 60_000; // call took 60s (≥ 30s cooldown)
          return { ok: false, status: 503 };
        },
      },
      { clock, breaker: { failThreshold: 1, cooldownMs: 30_000 } },
    );

    // Call 1: primary fails after 60s → breaker opens with a FRESH deadline (now+30s).
    const a = await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'a' }] });
    expect(a.endpointId).toBe('openai');
    expect(calls['prim.local']).toBe(1);

    // Call 2 (clock now 60000, breaker open until 90000): primary MUST be skipped.
    const b = await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'b' }] });
    expect(b.endpointId).toBe('openai');
    expect(calls['prim.local']).toBe(1); // NOT re-probed — the M1 regression guard
  });

  it('half-open allows only ONE concurrent probe — the second concurrent request skips the in-flight probe', async () => {
    const clock = { t: 0 };
    let primCalls = 0;
    let primMode: 'fail' | 'hang' = 'fail';
    let releasePrimary!: () => void;
    const gate = new Promise<void>((res) => {
      releasePrimary = res;
    });

    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('prim.local')) {
        primCalls += 1;
        if (primMode === 'fail') {
          return { ok: false, status: 503, statusText: 'ERR', text: async () => 'x', json: async () => ({}) } as unknown as Response;
        }
        await gate; // hang — models a slow half-open recovery probe still in flight
        return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({ choices: [{ message: { content: 'LOCAL' } }] }) } as unknown as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({ choices: [{ message: { content: 'CLOUD' } }] }) } as unknown as Response;
    }) as unknown as typeof fetch;

    // Single local (fleet = [local-primary, openai]) → no round-robin, so p1
    // deterministically takes the primary probe and p2 falls to openai.
    const r = new InferenceRouter({
      endpoints: [OPENAI, PRIMARY],
      routes: { teacher: ['openai'], fleet: ['local-primary', 'openai'], 'hosted-user': ['openai'], default: ['openai'] },
      breaker: { failThreshold: 1, cooldownMs: 1000 },
      fetchImpl,
      now: () => clock.t,
    });

    // 1) open primary's breaker (failThreshold 1) with one failing fleet call.
    await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'open' }] });
    expect(primCalls).toBe(1); // opened

    // 2) advance into the half-open window and switch primary to "hang" mode.
    clock.t = 2000;
    primMode = 'hang';

    // 3) fire two CONCURRENT fleet calls. p1 takes the single half-open probe (hangs);
    //    p2 must see probeInFlight=true → skip primary → served by openai.
    const p1 = r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: '1' }] });
    const p2 = r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: '2' }] });

    const r2 = await p2;
    expect(r2.endpointId).toBe('openai'); // did NOT touch the in-flight probe
    expect(primCalls).toBe(2); // p1's probe only — p2 did not add a 3rd primary hit

    releasePrimary();
    const r1 = await p1;
    expect(r1.endpointId).toBe('local-primary'); // probe succeeded → closes the breaker
    expect(primCalls).toBe(2);
  });

  it('a REJECTING fetch (timeout/network) counts as a failure and fails over', async () => {
    const calls: Record<string, number> = {};
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls[u.includes('prim.local') ? 'prim' : u.includes('sec.local') ? 'sec' : 'openai'] =
        (calls[u.includes('prim.local') ? 'prim' : u.includes('sec.local') ? 'sec' : 'openai'] ?? 0) + 1;
      if (u.includes('prim.local')) throw new Error('AbortError: timeout'); // reject like AbortSignal.timeout
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: 'RECOVERED' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = new InferenceRouter({ endpoints: [OPENAI, PRIMARY, SECONDARY], routes: ROUTES, fetchImpl, now: () => 0 });
    const res = await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'q' }] });
    expect(res.endpointId).toBe('local-secondary');
    expect(res.text).toBe('RECOVERED');
    expect(calls['prim']).toBe(1);
  });

  it('ollama-provider endpoint uses the native /api/chat wire with think:false and parses .message.content', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    const fetchImpl = (async (url: string | URL | Request, init?: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        // Ollama native shape: { message: { content } }, NOT { choices: [...] }
        json: async () => ({ message: { content: 'ACTION: rest()' }, done_reason: 'stop' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const ollamaEp: InferenceEndpoint = { ...PRIMARY, provider: 'ollama', baseUrl: 'http://box.local:11434/v1' };
    const r = new InferenceRouter({
      endpoints: [OPENAI, ollamaEp, SECONDARY],
      routes: ROUTES,
      fetchImpl,
      now: () => 0,
    });
    const res = await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: 'decide' }], maxTokens: 220 });
    expect(res.endpointId).toBe('local-primary');
    expect(res.text).toBe('ACTION: rest()');
    expect(capturedUrl).toBe('http://box.local:11434/api/chat'); // /v1 stripped, native path
    expect(capturedBody.think).toBe(false); // thinking disabled
    expect(capturedBody.stream).toBe(false);
    expect(capturedBody.keep_alive).toBeDefined(); // keeps the box warm
    expect(capturedBody.options.num_predict).toBe(220);
    expect(capturedBody.choices).toBeUndefined(); // not the openai wire
  });

  // PRIMARY-PREFERRED-OVERFLOW (2026-07-07 founder ruling; replaced the old
  // per-request round-robin): route-list order = preference order; the FIRST
  // local is maxed out, the second takes work only at saturation/breaker-open.
  it('primary-preferred: sequential requests ALL stick to the FIRST local (no round-robin); OpenAI untouched', async () => {
    const hits: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      hits.push(u.includes('prim.local') ? 'primary' : u.includes('sec.local') ? 'secondary' : 'openai');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({ message: { content: 'ok' }, choices: [{ message: { content: 'ok' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = new InferenceRouter({ endpoints: [OPENAI, PRIMARY, SECONDARY], routes: ROUTES, fetchImpl, now: () => 0 });

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: String(i) }] })).endpointId);
    }
    expect(ids).toEqual(['local-primary', 'local-primary', 'local-primary', 'local-primary']);
    expect(hits).not.toContain('secondary'); // idle primary absorbs everything
    expect(hits).not.toContain('openai');
  });

  it('overflows to the second local ONLY while the primary is saturated (inflight ≥ cap), and returns to the primary after drain', async () => {
    const release: Array<() => void> = [];
    const okResp = {
      ok: true, status: 200, statusText: 'OK', text: async () => '',
      json: async () => ({ message: { content: 'ok' }, choices: [{ message: { content: 'ok' } }] }),
    } as unknown as Response;
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes('prim.local')) {
        // primary hangs until released — simulates a busy 27b box
        return await new Promise<Response>((resolve) => release.push(() => resolve(okResp)));
      }
      return okResp;
    }) as unknown as typeof fetch;
    const r = new InferenceRouter({
      endpoints: [OPENAI, PRIMARY, SECONDARY], routes: ROUTES,
      primaryMaxInflight: 2, fetchImpl, now: () => 0,
    });
    const gen = (m: string) => r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: m }] });

    const p1 = gen('1');
    const p2 = gen('2');
    await new Promise((t) => setTimeout(t, 10)); // both reach the primary fetch → inflight = cap
    const c = await gen('3'); // saturated primary → overflow
    expect(c.endpointId).toBe('local-secondary');

    release.splice(0).forEach((f) => f()); // drain the primary
    expect((await p1).endpointId).toBe('local-primary');
    expect((await p2).endpointId).toBe('local-primary');

    const d = gen('4'); // primary idle again → preferred again
    await new Promise((t) => setTimeout(t, 10));
    release.splice(0).forEach((f) => f());
    expect((await d).endpointId).toBe('local-primary');
  });

  it('when EVERY local is saturated, new work queues on the PRIMARY (preference order kept, no backup stampede)', async () => {
    const hits: string[] = [];
    const release: Array<() => void> = [];
    const okResp = {
      ok: true, status: 200, statusText: 'OK', text: async () => '',
      json: async () => ({ message: { content: 'ok' }, choices: [{ message: { content: 'ok' } }] }),
    } as unknown as Response;
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      hits.push(u.includes('prim.local') ? 'primary' : u.includes('sec.local') ? 'secondary' : 'openai');
      // EVERY local hangs until released
      return await new Promise<Response>((resolve) => release.push(() => resolve(okResp)));
    }) as unknown as typeof fetch;
    const r = new InferenceRouter({
      endpoints: [OPENAI, PRIMARY, SECONDARY], routes: ROUTES,
      primaryMaxInflight: 1, fetchImpl, now: () => 0,
    });
    const gen = (m: string) => r.generateText({ route: 'fleet', size: 'small', messages: [{ role: 'user', content: m }] });

    const p1 = gen('1'); // → primary (inflight 1 = cap)
    await new Promise((t) => setTimeout(t, 10));
    const p2 = gen('2'); // primary saturated → secondary (inflight 1 = cap)
    await new Promise((t) => setTimeout(t, 10));
    const p3 = gen('3'); // ALL saturated → keeps preference order → queues on primary
    await new Promise((t) => setTimeout(t, 10));

    expect(hits).toEqual(['primary', 'secondary', 'primary']);
    release.splice(0).forEach((f) => f());
    await Promise.all([p1, p2, p3]);
  });

  it('warmup() pre-loads every local box and tolerates a down box (never throws)', async () => {
    const hit = new Set<string>();
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('sec.local')) throw new Error('secondary down'); // must not break warmup
      hit.add(u.includes('prim.local') ? 'primary' : 'openai');
      return {
        ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({ message: { content: 'w' } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const prim: InferenceEndpoint = { ...PRIMARY, provider: 'ollama' };
    const sec: InferenceEndpoint = { ...SECONDARY, provider: 'ollama' };
    const r = new InferenceRouter({ endpoints: [OPENAI, prim, sec], routes: ROUTES, fetchImpl, now: () => 0 });
    await r.warmup(); // secondary throws internally — warmup must still resolve
    expect(hit.has('primary')).toBe(true); // primary local warmed
    expect(hit.has('openai')).toBe(false); // cloud endpoints are NOT warmed
  });

  it('a cloud endpoint with NO api key throws (fails loudly, not a silent hang)', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const keyless: InferenceEndpoint = { ...OPENAI, apiKey: undefined };
      const r = new InferenceRouter({
        endpoints: [keyless],
        routes: { teacher: ['openai'], fleet: ['openai'], 'hosted-user': ['openai'], default: ['openai'] },
        // fetch must never be reached — the missing-key check throws first
        fetchImpl: (async () => {
          throw new Error('fetch should not be called when key is missing');
        }) as unknown as typeof fetch,
        now: () => 0,
      });
      await expect(
        r.generateText({ route: 'teacher', size: 'small', messages: [{ role: 'user', content: 'x' }] }),
      ).rejects.toThrow('missing OPENAI_API_KEY');
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});
