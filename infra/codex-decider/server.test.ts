import { describe, expect, test } from 'bun:test';
import { authorized, buildPrompt, createHandler, createQueue, loadConfig, loginMode, parseDecision, type Config, type RunOutcome } from './server';

const TOKEN = 'decider-test-token-0123456789abcdef';
const cfg: Config = { token: TOKEN, model: 'm1', effort: 'low', host: '127.0.0.1', port: 0, timeoutMs: 90_000, concurrency: 2, queueMax: 1, bin: 'codex' };
const okRun = async (): Promise<RunOutcome> => ({ ok: true, decision: { decision: 'enter', confidence: 0.7, exit_room: 'yes', rug_risk: 'low', reasons: ['r'] } });

function req(body: unknown, token = TOKEN) {
  return new Request('http://x/decide', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

describe('codex-decider', () => {
  test('config refuses a short token and a wildcard bind', () => {
    expect(() => loadConfig({ CODEX_DECIDER_TOKEN: 'short' })).toThrow();
    expect(() => loadConfig({ CODEX_DECIDER_TOKEN: TOKEN, CODEX_DECIDER_BIND: '0.0.0.0:8790' })).toThrow();
    expect(loadConfig({ CODEX_DECIDER_TOKEN: TOKEN, CODEX_DECIDER_BIND: '10.0.1.1:8790' })).toMatchObject({ host: '10.0.1.1', port: 8790, timeoutMs: 90_000, concurrency: 2 });
  });

  test('auth, login mode, prompt, parse', () => {
    expect(authorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(authorized('Bearer nope', TOKEN)).toBe(false);
    expect(authorized(null, TOKEN)).toBe(false);
    expect(loginMode('Logged in using ChatGPT')).toBe('chatgpt');
    expect(loginMode('Logged in using an API key - sk-***')).toBe('api_key');
    expect(buildPrompt({ a: 1 })).toContain('Facts (JSON): {"a":1}');
    expect(parseDecision({ decision: 'skip', confidence: 0.4, exit_room: 'no', rug_risk: 'high', reasons: ['1', '2', '3', '4'] })!.reasons).toHaveLength(3);
    expect(parseDecision({ decision: 'skip', confidence: 2, exit_room: 'no', rug_risk: 'high', reasons: [] })).toBeNull();
  });

  test('queue drops the oldest waiting job when full', async () => {
    const q = createQueue<number>(1, 1);
    let release!: () => void;
    const first = q.submit(Date.now() + 60_000, () => new Promise<number>((r) => { release = () => r(1); }));
    const second = q.submit(Date.now() + 60_000, async () => 2);
    const third = q.submit(Date.now() + 60_000, async () => 3);
    expect(await second).toEqual({ kind: 'dropped' });
    release();
    expect(await first).toEqual({ kind: 'ran', value: 1 });
    expect(await third).toEqual({ kind: 'ran', value: 3 });
  });

  test('handler: 401, 400, 200 with model + ms', async () => {
    const h = createHandler(cfg, { run: okRun });
    expect((await h(req({}, 'wrong-token-wrong-token-wrong'))).status).toBe(401);
    expect((await h(req({ agentId: 'a', mint: 'bad mint!', packet: {} }))).status).toBe(400);
    const res = await h(req({ agentId: 'house:genesis', mint: 'MINT1', packet: { coin: { mcap: 1 } } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ decision: 'enter', confidence: 0.7, model: 'm1' });
  });

  test('handler maps a runner timeout to 504', async () => {
    const h = createHandler(cfg, { run: async () => ({ ok: false, error: 'timeout' }) });
    const res = await h(req({ agentId: 'a', mint: 'M', packet: {} }));
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: 'timeout' });
  });
});
