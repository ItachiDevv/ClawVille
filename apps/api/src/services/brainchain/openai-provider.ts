import { z } from 'zod';
import { BrainchainComputeError, freezePricePolicy } from './inference-policy';
import type { ReservedProviderAdapter, ReservedProviderRequest } from './inference-proxy';

export const OPENAI_BRAINCHAIN_MODEL = 'gpt-5.6-terra';
export const OPENAI_BRAINCHAIN_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const OPENAI_PROVIDER_DEADLINE_MS = 30_000;
export const OPENAI_PROVIDER_RESPONSE_BYTES = 131_072;
export const OPENAI_BRAINCHAIN_PRICE_POLICY = freezePricePolicy({
  provider: 'openai', model: OPENAI_BRAINCHAIN_MODEL, version: 'openai_terra_20261109_v1',
  inputMicrosPerMillion: 2_500_000n, outputMicrosPerMillion: 12_000_000n, requestMicros: 0n,
  maxInputTokens: 33_792, maxOutputTokens: 2048, inputOverheadTokens: 1024,
  outputIncludesReasoning: true, inputTokenBound: 'utf8-bytes',
});
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.object({
  callId: z.string().uuid(), model: z.literal(OPENAI_BRAINCHAIN_MODEL),
  prompt: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 32768),
  maxInputTokens: z.number().int().positive().max(33_792),
  maxOutputTokens: z.number().int().positive().max(2048),
}).strict().refine(value => Buffer.byteLength(value.prompt, 'utf8') + 1024 <= value.maxInputTokens);
const responseSchema = z.object({
  object: z.literal('chat.completion'), model: z.literal(OPENAI_BRAINCHAIN_MODEL),
  service_tier: z.literal('default').optional(),
  choices: z.array(z.object({ index: z.literal(0), finish_reason: z.literal('stop'),
    message: z.object({ role: z.literal('assistant'),
      content: z.string().refine(value => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 32768),
      refusal: z.null().optional(), tool_calls: z.array(z.never()).optional(), function_call: z.null().optional(), audio: z.null().optional(),
    }).passthrough(),
  }).passthrough()).length(1),
  usage: z.object({ prompt_tokens: integer.positive(), completion_tokens: integer.positive(), total_tokens: integer.positive(),
    prompt_tokens_details: z.object({ cached_tokens: integer.optional(), audio_tokens: z.literal(0).optional() }).passthrough().nullable().optional(),
    completion_tokens_details: z.object({ reasoning_tokens: integer.optional(), audio_tokens: z.literal(0).optional(),
      accepted_prediction_tokens: z.literal(0).optional(), rejected_prediction_tokens: z.literal(0).optional() }).passthrough().nullable().optional(),
  }).passthrough(),
}).passthrough();

async function readBoundedJson(response: Response, aborted: Promise<never>): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > OPENAI_PROVIDER_RESPONSE_BYTES))
    || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new BrainchainComputeError('uncertain');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0, ended = false;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) { ended = true; break; }
      size += chunk.value.byteLength;
      if (size > OPENAI_PROVIDER_RESPONSE_BYTES) throw new BrainchainComputeError('uncertain');
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } finally {
    if (!ended) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* An aborted read can remain pending in a transport. */ }
  }
}

/** Trusted host only: no environment/keyring access, endpoint overrides, SDK fallback, or retries. */
export class OpenAIReservedProviderAdapter implements ReservedProviderAdapter {
  readonly provider = 'openai' as const;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  constructor(apiKey: string, transport: typeof fetch = fetch) {
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(apiKey) || typeof transport !== 'function') {
      throw new BrainchainComputeError('policy_refused');
    }
    this.#apiKey = apiKey; this.#fetch = transport; Object.freeze(this);
  }
  async generate(raw: ReservedProviderRequest, signal: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) throw new BrainchainComputeError('invalid_request');
    if (signal.aborted) throw new BrainchainComputeError('expired');
    const request = parsed.data, controller = new AbortController();
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new BrainchainComputeError('uncertain')); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, OPENAI_PROVIDER_DEADLINE_MS);
    try {
      if (signal.aborted) throw new BrainchainComputeError('uncertain');
      const response = await Promise.race([this.#fetch(OPENAI_BRAINCHAIN_ENDPOINT, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ model: OPENAI_BRAINCHAIN_MODEL, messages: [{ role: 'user', content: request.prompt }],
          reasoning_effort: 'none', n: 1, stream: false, store: false, service_tier: 'default', max_completion_tokens: request.maxOutputTokens }),
      }), aborted]);
      if (response.status !== 200 || response.redirected || (response.url && response.url !== OPENAI_BRAINCHAIN_ENDPOINT)) {
        void response.body?.cancel().catch(() => {}); throw new BrainchainComputeError('uncertain');
      }
      const result = responseSchema.safeParse(await readBoundedJson(response, aborted));
      if (!result.success || controller.signal.aborted) throw new BrainchainComputeError('uncertain');
      const usage = result.data.usage;
      if (usage.prompt_tokens > request.maxInputTokens || usage.completion_tokens > request.maxOutputTokens
        || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens
        || (usage.prompt_tokens_details?.cached_tokens ?? 0) > usage.prompt_tokens
        || (usage.completion_tokens_details?.reasoning_tokens ?? 0) > usage.completion_tokens) throw new BrainchainComputeError('uncertain');
      return { text: result.data.choices[0]!.message.content, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
    } catch { throw new BrainchainComputeError('uncertain'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', rejectAbort); controller.abort(); }
  }
}
