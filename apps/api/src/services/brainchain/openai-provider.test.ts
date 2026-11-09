import { describe, expect, test } from 'bun:test';
import { OpenAIReservedProviderAdapter, OPENAI_BRAINCHAIN_ENDPOINT, OPENAI_BRAINCHAIN_MODEL, OPENAI_BRAINCHAIN_PRICE_POLICY, OPENAI_PROVIDER_DEADLINE_MS, OPENAI_PROVIDER_RESPONSE_BYTES } from './openai-provider';
import { tokenCost } from './inference-policy';
import type { ReservedProviderRequest } from './inference-proxy';

const key = 'fixture-secret-never-log';
const request: ReservedProviderRequest = { callId: '00000000-0000-4000-8000-000000000001', model: OPENAI_BRAINCHAIN_MODEL, prompt: 'hello', maxInputTokens: 1029, maxOutputTokens: 32 };
const fixture = () => ({ object: 'chat.completion', model: OPENAI_BRAINCHAIN_MODEL, service_tier: 'default', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'answer', refusal: null } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } });
const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });
const transport = (fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) => fn as typeof fetch;
const signal = () => new AbortController().signal;

async function expectSafeRefusal(adapter: OpenAIReservedProviderAdapter, input = request, abort = signal()) {
  try { await adapter.generate(input, abort); throw new Error('expected refusal'); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('BrainChain compute refused: uncertain');
    expect(String(error)).not.toContain(key);
    expect((error as Error).cause).toBeUndefined();
  }
}

describe('reserved OpenAI provider wire policy', () => {
  test('sends exactly one fixed text-only request and reports checked usage', async () => {
    let calls = 0;
    const adapter = new OpenAIReservedProviderAdapter(key, transport(async (url, init) => {
      calls++;
      expect(url).toBe(OPENAI_BRAINCHAIN_ENDPOINT);
      expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toEqual({ authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' });
      expect(JSON.parse(init!.body as string)).toEqual({ model: OPENAI_BRAINCHAIN_MODEL, messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'none', n: 1, stream: false, store: false, service_tier: 'default', max_completion_tokens: 32 });
      return json(fixture());
    }));
    expect(await adapter.generate(request, signal())).toEqual({ text: 'answer', inputTokens: 4, outputTokens: 2 });
    expect(calls).toBe(1);
    expect(JSON.stringify(adapter)).toBe('{"provider":"openai"}');
  });

  test('pins the cache-write-buffered policy and maximum trial reservation', () => {
    expect(Object.isFrozen(OPENAI_BRAINCHAIN_PRICE_POLICY)).toBe(true);
    expect(OPENAI_BRAINCHAIN_PRICE_POLICY.inputMicrosPerMillion).toBe(2500000n);
    expect(OPENAI_BRAINCHAIN_PRICE_POLICY.outputMicrosPerMillion).toBe(12000000n);
    expect(tokenCost(OPENAI_BRAINCHAIN_PRICE_POLICY, 33792, 2048)).toBe(109056n);
    expect(OPENAI_PROVIDER_DEADLINE_MS).toBe(30000);
  });

  test('rejects overrides and invalid bounds before fetch', async () => {
    let calls = 0; const adapter = new OpenAIReservedProviderAdapter(key, transport(async () => { calls++; return json(fixture()); }));
    for (const input of [
      { ...request, model: 'another-model' }, { ...request, endpoint: 'https://example.com' }, { ...request, tools: [] },
      { ...request, prompt: '\u00e9'.repeat(16385), maxInputTokens: 33792 }, { ...request, maxInputTokens: 1028 },
      { ...request, maxInputTokens: 33793 }, { ...request, maxOutputTokens: 2049 }, { ...request, callId: 'not-a-call' },
    ]) await expect(adapter.generate(input as ReservedProviderRequest, signal())).rejects.toThrow('invalid_request');
    const controller = new AbortController(); controller.abort();
    await expect(adapter.generate(request, controller.signal)).rejects.toThrow('expired');
    expect(calls).toBe(0);
    expect(() => new OpenAIReservedProviderAdapter('secret\r\nheader')).toThrow('policy_refused');
  });

  test('never retries HTTP failures, redirects, transport errors or malformed bodies', async () => {
    for (const make of [
      () => new Response('secret provider error', { status: 429 }),
      () => new Response(null, { status: 307, headers: { location: 'https://example.com' } }),
      () => new Response('not-json', { headers: { 'content-type': 'application/json' } }),
      () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
      () => { throw new Error(key); },
    ]) {
      let calls = 0;
      await expectSafeRefusal(new OpenAIReservedProviderAdapter(key, transport(async () => { calls++; return make(); })));
      expect(calls).toBe(1);
    }
  });

  test('refuses ambiguous choices, model drift, incomplete output, tools, refusal and inconsistent usage', async () => {
    const bad: unknown[] = [];
    for (const change of [ { model: `${OPENAI_BRAINCHAIN_MODEL}-undocumented-snapshot` }, { usage: undefined }, { service_tier: 'priority' } ]) bad.push({ ...fixture(), ...change });
    const baseChoice = fixture().choices[0]!;
    bad.push({ ...fixture(), choices: [baseChoice, baseChoice] });
    for (const change of [{ finish_reason: 'length' }, { index: 1 }, { message: { role: 'assistant', content: '' } }, { message: { role: 'assistant', content: 'answer', tool_calls: [{ id: 'tool' }] } }, { message: { role: 'assistant', content: 'answer', refusal: 'refused' } }, { message: { role: 'assistant', content: ['not text'] } }]) bad.push({ ...fixture(), choices: [{ ...baseChoice, ...change }] });
    for (const usage of [
      { prompt_tokens: 1030, completion_tokens: 2, total_tokens: 1032 },
      { prompt_tokens: 4, completion_tokens: 33, total_tokens: 37 },
      { prompt_tokens: 4, completion_tokens: 2, total_tokens: 7 },
      { prompt_tokens: 4.5, completion_tokens: 2, total_tokens: 6.5 },
      { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 },
      { ...fixture().usage, prompt_tokens_details: { cached_tokens: 5 } },
      { ...fixture().usage, completion_tokens_details: { reasoning_tokens: 3 } },
      { ...fixture().usage, completion_tokens_details: { audio_tokens: 1 } },
    ]) bad.push({ ...fixture(), usage });
    for (const body of bad) await expectSafeRefusal(new OpenAIReservedProviderAdapter(key, transport(async () => json(body))));
  });

  test('bounds streamed bytes even without content-length and cancels rejected bodies', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(OPENAI_PROVIDER_RESPONSE_BYTES + 1)); }, cancel() { canceled = true; } });
    await expectSafeRefusal(new OpenAIReservedProviderAdapter(key, transport(async () => new Response(body, { headers: { 'content-type': 'application/json' } }))));
    expect(canceled).toBe(true);
    await expectSafeRefusal(new OpenAIReservedProviderAdapter(key, transport(async () => json(fixture(), { 'content-length': String(OPENAI_PROVIDER_RESPONSE_BYTES + 1) }))));
    await expectSafeRefusal(new OpenAIReservedProviderAdapter(key, transport(async () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }))));
  });

  test('parent cancellation bounds transports and stream reads that ignore abort', async () => {
    for (const pendingBody of [false, true]) {
      const controller = new AbortController(); let sentSignal: AbortSignal | null = null, calls = 0;
      const adapter = new OpenAIReservedProviderAdapter(key, transport(async (_url, init) => {
        calls++; sentSignal = init!.signal as AbortSignal;
        if (pendingBody) return new Response(new ReadableStream<Uint8Array>({}), { headers: { 'content-type': 'application/json' } });
        return new Promise<Response>(() => {});
      }));
      const result = expectSafeRefusal(adapter, request, controller.signal);
      setTimeout(() => controller.abort(), 5); await result;
      expect(calls).toBe(1); expect((sentSignal as unknown as AbortSignal).aborted).toBe(true);
    }
  });

  test('hard deadline bounds a transport that ignores its signal', async () => {
    let calls = 0;
    const adapter = new OpenAIReservedProviderAdapter(key, transport(async () => { calls++; return new Promise<Response>(() => {}); }));
    const started = performance.now(); await expectSafeRefusal(adapter);
    expect(performance.now() - started).toBeLessThan(OPENAI_PROVIDER_DEADLINE_MS + 3000);
    expect(calls).toBe(1);
  }, 35000);
});
