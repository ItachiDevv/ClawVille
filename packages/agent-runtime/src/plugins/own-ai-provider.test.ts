import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ModelType, type GenerateTextParams, type IAgentRuntime } from '@elizaos/core';
import {
  createOwnAiProviderPlugin,
  type OwnAiCallEstimate,
  type OwnAiPluginFallbackReason,
  type OwnAiProviderConfig,
  type OwnAiReservation,
} from './own-ai-provider';

// Fake secrets: shaped like real ones so a leak would be visible in output.
const KEY = 'sk-ant-TESTSECRETKEY0123456789abcdef';
const OAI_KEY = 'sk-TESTSECRETOPENAI0123456789abcd';
const POD_TOKEN = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let calls: Captured[] = [];
let responder: (c: Captured, n: number) => Response | Promise<Response> = () => new Response('{}');

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const c: Captured = {
      url: String(url),
      init: init ?? {},
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    calls.push(c);
    return responder(c, calls.length);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const runtime = {} as IAgentRuntime;

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(over: Partial<OwnAiProviderConfig> = {}) {
  const usage: Array<{ model: string; inputTokens: number; outputTokens: number }> = [];
  const fallbacks: OwnAiPluginFallbackReason[] = [];
  const fbCalls: Array<{ size: string; params: GenerateTextParams }> = [];
  const logs: string[] = [];
  const estimates: OwnAiCallEstimate[] = [];
  const settled: OwnAiReservation[] = [];
  const released: OwnAiReservation[] = [];
  const cfg: OwnAiProviderConfig = {
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: KEY,
    model: 'claude-sonnet-4-5',
    maxTokensFloor: 0,
    timeoutMs: 2000,
    mayCall: async (e) => {
      estimates.push(e);
      return { microUsd: 1, day: '2026-11-09' };
    },
    onUsage: (u, r) => {
      usage.push(u);
      settled.push(r);
    },
    onRelease: (r) => released.push(r),
    onFallback: (r) => fallbacks.push(r),
    ...over,
  };
  const plugin = createOwnAiProviderPlugin(
    cfg,
    async (_rt, params) => {
      fbCalls.push({ size: 'small', params });
      return 'ROUTER_SMALL';
    },
    async (_rt, params) => {
      fbCalls.push({ size: 'large', params });
      return 'ROUTER_LARGE';
    },
  );
  const small = plugin.models![ModelType.TEXT_SMALL] as (r: IAgentRuntime, p: GenerateTextParams) => Promise<string>;
  const large = plugin.models![ModelType.TEXT_LARGE] as (r: IAgentRuntime, p: GenerateTextParams) => Promise<string>;
  return { plugin, small, large, usage, fallbacks, fbCalls, logs, estimates, settled, released };
}

function params(over: Partial<GenerateTextParams> = {}): GenerateTextParams {
  return { prompt: 'decide now', maxTokens: 200, stopSequences: [], ...over } as GenerateTextParams;
}

/** Capture console output during fn so the key-leak check covers logs too. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  try {
    const result = await fn();
    return { result, out: lines.join('\n') };
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

describe('own-ai provider plugin: shape', () => {
  it('registers TEXT_SMALL + TEXT_LARGE at priority 98 and never puts the key or base URL in the description', () => {
    const { plugin } = setup({ protocol: 'openai-compat', baseUrl: `https://api.usepod.ai/proxy/${POD_TOKEN}/v1` });
    expect(plugin.priority).toBe(98);
    expect(Object.keys(plugin.models ?? {})).toEqual([ModelType.TEXT_SMALL, ModelType.TEXT_LARGE]);
    expect(plugin.description).not.toContain(POD_TOKEN);
    expect(plugin.description).not.toContain(KEY);
  });
});

describe('own-ai provider plugin: anthropic', () => {
  it('posts /v1/messages with x-api-key + version, joins text blocks, reports usage', async () => {
    responder = () =>
      json(200, {
        content: [
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'text', text: '[ACTION:walk ' },
          { type: 'text', text: 'to=bank]' },
        ],
        usage: { input_tokens: 1234, output_tokens: 56 },
      });
    const t = setup();
    const out = await t.small(runtime, params({ stopSequences: ['\n\n'], temperature: 0.5 }));
    expect(out).toBe('[ACTION:walk to=bank]');
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    const h = c.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe(KEY);
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h.Authorization).toBeUndefined();
    expect(c.init.redirect).toBe('manual');
    expect(c.body.model).toBe('claude-sonnet-4-5');
    expect(c.body.max_tokens).toBe(200);
    expect(c.body.stop_sequences).toEqual(['\n\n']);
    expect(c.body.temperature).toBe(0.5);
    expect(c.body.messages).toEqual([{ role: 'user', content: 'decide now' }]);
    expect(t.usage).toEqual([{ model: 'claude-sonnet-4-5', inputTokens: 1234, outputTokens: 56 }]);
    expect(t.fallbacks).toEqual([]);
    expect(t.fbCalls).toEqual([]);
  });

  it('applies the max_tokens floor (max of requested and floor)', async () => {
    responder = () => json(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const t = setup({ maxTokensFloor: 2000 });
    await t.small(runtime, params({ maxTokens: 200 }));
    expect(calls[0]!.body.max_tokens).toBe(2000);
    const t2 = setup({ maxTokensFloor: 100 });
    await t2.small(runtime, params({ maxTokens: 300 }));
    expect(calls[1]!.body.max_tokens).toBe(300);
    const t3 = setup({ maxTokensFloor: 50 });
    await t3.small(runtime, { prompt: 'x' } as GenerateTextParams);
    expect(calls[2]!.body.max_tokens).toBe(1000); // default when the caller gives none
  });

  it('estimates usage at chars/4 when the response has no usage', async () => {
    responder = () => json(200, { content: [{ type: 'text', text: '12345678' }] });
    const t = setup();
    await t.small(runtime, params({ prompt: 'x'.repeat(40) }));
    expect(t.usage).toEqual([{ model: 'claude-sonnet-4-5', inputTokens: 10, outputTokens: 2 }]);
  });
});

describe('own-ai provider plugin: openai-compat', () => {
  it('posts /chat/completions with Bearer + extra headers, uses final content only, reports usage', async () => {
    responder = () =>
      json(200, {
        choices: [{ message: { content: '<think>hidden</think>[ACTION:idle]', reasoning: 'should not appear' } }],
        usage: { prompt_tokens: 900, completion_tokens: 40 },
      });
    const t = setup({
      protocol: 'openai-compat',
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: OAI_KEY,
      model: 'deepseek/deepseek-chat-v3.1',
      extraHeaders: { 'HTTP-Referer': 'https://clawville.world', 'X-Title': 'ClawVille' },
    });
    const out = await t.large(runtime, params({ stopSequences: ['END'], temperature: 0.7 }));
    expect(out).toBe('[ACTION:idle]');
    const c = calls[0]!;
    expect(c.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const h = c.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${OAI_KEY}`);
    expect(h['HTTP-Referer']).toBe('https://clawville.world');
    expect(h['X-Title']).toBe('ClawVille');
    expect(c.body.max_tokens).toBe(200);
    expect(c.body.stop).toEqual(['END']);
    expect(c.body.temperature).toBe(0.7);
    expect(t.usage).toEqual([{ model: 'deepseek/deepseek-chat-v3.1', inputTokens: 900, outputTokens: 40 }]);
    expect(t.fbCalls).toEqual([]);
  });

  it('uses max_completion_tokens on api.openai.com and omits temperature/stop for a reasoning model', async () => {
    responder = () => json(200, { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const t = setup({
      protocol: 'openai-compat',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: OAI_KEY,
      model: 'gpt-5.1',
      maxTokensFloor: 2000,
    });
    await t.small(runtime, params({ stopSequences: ['X'], temperature: 0.4 }));
    const b = calls[0]!.body;
    expect(b.max_completion_tokens).toBe(2000);
    expect(b.max_tokens).toBeUndefined();
    expect(b.temperature).toBeUndefined();
    expect(b.stop).toBeUndefined();
  });

  it('uses max_completion_tokens on api.openai.com for a non-reasoning model too', async () => {
    responder = () => json(200, { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const t = setup({ protocol: 'openai-compat', baseUrl: 'https://api.openai.com/v1', apiKey: OAI_KEY, model: 'gpt-4.1', maxTokensFloor: 200 });
    await t.small(runtime, params({ temperature: 0.4 }));
    const b = calls[0]!.body;
    expect(b.max_completion_tokens).toBe(200);
    expect(b.max_tokens).toBeUndefined();
    expect(b.temperature).toBe(0.4);
  });

  it('strips a param the model rejects (400 Unsupported value) and retries once', async () => {
    responder = (_c, n) =>
      n === 1
        ? json(400, { error: { message: "Unsupported value: 'temperature' does not support 0.4", param: 'temperature' } })
        : json(200, { choices: [{ message: { content: 'ok' } }] });
    const t = setup({ protocol: 'openai-compat', baseUrl: 'https://api.openai.com/v1', apiKey: OAI_KEY, model: 'gpt-4.1' });
    const out = await t.small(runtime, params({ temperature: 0.4 }));
    expect(out).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.temperature).toBeUndefined();
    expect(t.fallbacks).toEqual([]);
  });
});

describe('own-ai provider plugin: fallback classes', () => {
  const cases: Array<[string, () => Response, OwnAiPluginFallbackReason]> = [
    ['401', () => json(401, { error: { message: `invalid x-api-key ${KEY}` } }), 'key_rejected'],
    ['403', () => json(403, { error: 'forbidden' }), 'key_rejected'],
    ['402', () => json(402, { error: 'insufficient balance' }), 'balance_empty'],
    ['404', () => json(404, { error: 'not found' }), 'model_unavailable'],
    ['400 model', () => json(400, { error: { message: 'The model `gpt-9` does not exist' } }), 'model_unavailable'],
    ['400 other', () => json(400, { error: { message: 'prompt is too long' } }), 'provider_error'],
    ['429', () => json(429, { error: 'rate limited' }), 'provider_error'],
    ['500', () => json(500, { error: 'boom' }), 'provider_error'],
    ['529', () => json(529, { error: 'overloaded' }), 'provider_error'],
    ['302 redirect', () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }), 'provider_error'],
    ['bad json', () => new Response('not json', { status: 200 }), 'provider_error'],
  ];

  for (const [name, res, reason] of cases) {
    it(`${name} -> onFallback('${reason}') and the router answers this call`, async () => {
      responder = res;
      const t = setup();
      const { result, out } = await captureConsole(() => t.small(runtime, params()));
      expect(result).toBe('ROUTER_SMALL');
      expect(t.fallbacks).toEqual([reason]);
      expect(t.fbCalls).toHaveLength(1);
      expect(t.fbCalls[0]!.params.prompt).toBe('decide now');
      expect(t.usage).toEqual([]);
      expect(out).not.toContain(KEY);
    });
  }

  it('network error -> provider_error; the log never holds the key or the UsePod token in the URL', async () => {
    responder = (c) => {
      throw new TypeError(`fetch failed for ${c.url} with ${KEY}`);
    };
    const t = setup({
      protocol: 'openai-compat',
      baseUrl: `https://api.usepod.ai/proxy/${POD_TOKEN}/v1`,
      apiKey: POD_TOKEN,
      model: 'gpt-oss-120b',
    });
    const { result, out } = await captureConsole(() => t.large(runtime, params()));
    expect(result).toBe('ROUTER_LARGE');
    expect(t.fallbacks).toEqual(['provider_error']);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(POD_TOKEN);
    expect(out).toContain('reason=provider_error');
  });

  it('timeout -> provider_error and the router answers', async () => {
    responder = (c) =>
      new Promise<Response>((_resolve, reject) => {
        c.init.signal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const t = setup({ timeoutMs: 30 });
    const { result, out } = await captureConsole(() => t.small(runtime, params()));
    expect(result).toBe('ROUTER_SMALL');
    expect(t.fallbacks).toEqual(['provider_error']);
    expect(out).toContain('detail=timeout');
  });

  it('empty final text -> usage recorded, then provider_error fallback', async () => {
    responder = () => json(200, { choices: [{ message: { content: '', reasoning: 'all budget here' } }], usage: { prompt_tokens: 5, completion_tokens: 2000 } });
    const t = setup({ protocol: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', apiKey: OAI_KEY, model: 'google/gemini-2.5-pro' });
    const { result } = await captureConsole(() => t.small(runtime, params()));
    expect(result).toBe('ROUTER_SMALL');
    expect(t.usage).toEqual([{ model: 'google/gemini-2.5-pro', inputTokens: 5, outputTokens: 2000 }]);
    expect(t.fallbacks).toEqual(['provider_error']);
  });

  it('mayCall null (no room to reserve) -> daily_limit fallback with NO fetch', async () => {
    const t = setup({ mayCall: async () => null });
    const out = await t.small(runtime, params());
    expect(out).toBe('ROUTER_SMALL');
    expect(calls).toHaveLength(0);
    expect(t.fallbacks).toEqual(['daily_limit']);
  });

  it('mayCall throws -> fallback with NO fetch (fails closed)', async () => {
    const t = setup({
      mayCall: async () => {
        throw new Error('db down');
      },
    });
    const out = await t.large(runtime, params());
    expect(out).toBe('ROUTER_LARGE');
    expect(calls).toHaveLength(0);
    expect(t.fallbacks).toEqual(['provider_error']);
  });

  it('a throwing onUsage/onFallback callback never breaks the call', async () => {
    responder = () => json(200, { content: [{ type: 'text', text: 'ok' }] });
    const t = setup({
      onUsage: () => {
        throw new Error('meter down');
      },
    });
    expect(await t.small(runtime, params())).toBe('ok');
    responder = () => json(500, {});
    const t2 = setup({
      onFallback: () => {
        throw new Error('status down');
      },
    });
    expect(await captureConsole(() => t2.small(runtime, params())).then((r) => r.result)).toBe('ROUTER_SMALL');
  });

  it('reserves prompt chars/4 in + max_tokens out, then settles THAT reservation on success', async () => {
    responder = () => json(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 7, output_tokens: 3 } });
    const reservation = { microUsd: 4242, day: '2026-11-09' };
    const t = setup({
      maxTokensFloor: 300,
      mayCall: async (e) => {
        t.estimates.push(e);
        return reservation;
      },
    });
    expect(await t.small(runtime, params({ prompt: 'x'.repeat(40), maxTokens: 120 }))).toBe('ok');
    expect(t.estimates).toEqual([{ inputTokens: 10, outputTokens: 300 }]);
    expect(t.settled).toEqual([reservation]);
    expect(t.settled[0]).toBe(reservation);
    expect(t.released).toEqual([]);
  });

  it('a failed call releases its reservation (never settles it)', async () => {
    responder = () => json(401, { error: 'bad key' });
    const t = setup();
    const { result } = await captureConsole(() => t.small(runtime, params()));
    expect(result).toBe('ROUTER_SMALL');
    expect(t.released).toEqual([{ microUsd: 1, day: '2026-11-09' }]);
    expect(t.settled).toEqual([]);
    expect(t.fallbacks).toEqual(['key_rejected']);
  });

  it('a refused gate neither settles nor releases', async () => {
    const t = setup({ mayCall: async () => null });
    await t.small(runtime, params());
    expect(t.settled).toEqual([]);
    expect(t.released).toEqual([]);
  });

  it('a throwing onRelease never breaks the call', async () => {
    responder = () => json(500, {});
    const t = setup({
      onRelease: () => {
        throw new Error('db down');
      },
    });
    expect(await captureConsole(() => t.small(runtime, params())).then((r) => r.result)).toBe('ROUTER_SMALL');
  });

  it('without a large fallback, the small fallback serves TEXT_LARGE', async () => {
    const seen: string[] = [];
    const plugin = createOwnAiProviderPlugin(
      {
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: KEY,
        model: 'm',
        maxTokensFloor: 0,
        timeoutMs: 1000,
        mayCall: async () => null,
        onUsage: () => {},
        onRelease: () => {},
        onFallback: () => {},
      },
      async () => {
        seen.push('small');
        return 'S';
      },
    );
    const large = plugin.models![ModelType.TEXT_LARGE] as (r: IAgentRuntime, p: GenerateTextParams) => Promise<string>;
    expect(await large(runtime, params())).toBe('S');
    expect(seen).toEqual(['small']);
  });
});
