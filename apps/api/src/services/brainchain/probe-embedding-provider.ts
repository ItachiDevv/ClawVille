import { z } from 'zod';
import { BrainchainComputeError } from './inference-policy';

export const PROBE_EMBEDDING_ENDPOINT = 'https://api.openai.com/v1/embeddings';
export const PROBE_EMBEDDING_MODEL = 'text-embedding-3-small';
export const PROBE_EMBEDDING_DIMENSIONS = 1536;
export const PROBE_EMBEDDING_MAX_BYTES = 32768;
export const PROBE_EMBEDDING_RESPONSE_BYTES = 131072;
export const PROBE_EMBEDDING_MAX_TOKENS = 8192;
export const PROBE_EMBEDDING_RESERVED_MICROS = 200n;
export const PROBE_EMBEDDING_RATE = 20000n;
export function probeEmbeddingCharge(tokens: number): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > PROBE_EMBEDDING_MAX_TOKENS) throw new BrainchainComputeError('invalid_request');
  return (BigInt(tokens) * PROBE_EMBEDDING_RATE + 999999n) / 1000000n;
}
export interface ProbeEmbeddingDispatchTicket {
  /** Trusted ledger closure. Never supplied by an HTTP caller or model. */
  assertCurrent(signal: AbortSignal): Promise<void>;
}
const requestSchema = z.object({ callId: z.string().uuid(), input: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= PROBE_EMBEDDING_MAX_BYTES),
  deadlineMs: z.number().int().positive().safe() }).strict();
export type ProbeEmbeddingRequest = z.infer<typeof requestSchema>;
const tokens = z.number().int().positive().max(PROBE_EMBEDDING_MAX_TOKENS);
const responseSchema = z.object({ object: z.literal('list'), model: z.literal(PROBE_EMBEDDING_MODEL),
  data: z.array(z.object({ object: z.literal('embedding'), index: z.literal(0), embedding: z.array(z.number().finite()).length(PROBE_EMBEDDING_DIMENSIONS) }).strict()).length(1),
  usage: z.object({ prompt_tokens: tokens, total_tokens: tokens }).strict(),
}).strict();

/** One fixed embedding request. Durable duplicate and cost admission belong to the probe ledger. */
export class ProbeEmbeddingProvider {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #used = new WeakSet<ProbeEmbeddingDispatchTicket>();
  constructor(apiKey: string, transport: typeof fetch = fetch) {
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(apiKey) || typeof transport !== 'function') throw new BrainchainComputeError('policy_refused');
    this.#key = apiKey; this.#fetch = transport;
  }
  async embed(raw: ProbeEmbeddingRequest, ticket: ProbeEmbeddingDispatchTicket, signal: AbortSignal) {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success || !ticket || typeof ticket.assertCurrent !== 'function') throw new BrainchainComputeError('invalid_request');
    if (this.#used.has(ticket)) throw new BrainchainComputeError('execution_refused');
    const request = parsed.data, deadline = Math.min(request.deadlineMs, Date.now() + 30000);
    if (signal.aborted || Date.now() >= deadline) throw new BrainchainComputeError('expired');
    this.#used.add(ticket);
    const controller = new AbortController(); let transmitted = false;
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error('canceled')); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
    const current = () => { if (signal.aborted || controller.signal.aborted || Date.now() >= deadline) throw new Error('expired'); };
    let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } | undefined;
    try {
      current();
      // Install cancellation before invoking the trusted callback. Never await another operation between fence and fetch.
      await Promise.race([Promise.resolve().then(() => ticket.assertCurrent(controller.signal)), aborted]);
      current();
      const body = JSON.stringify({ model: PROBE_EMBEDDING_MODEL, input: request.input, dimensions: PROBE_EMBEDDING_DIMENSIONS, encoding_format: 'float' });
      current(); transmitted = true;
      const response = await Promise.race([this.#fetch(PROBE_EMBEDDING_ENDPOINT, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json', accept: 'application/json' }, body }), aborted]);
      current();
      const length = response.headers.get('content-length');
      if (response.status !== 200 || response.redirected || (response.url && response.url !== PROBE_EMBEDDING_ENDPOINT)
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body
        || (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > PROBE_EMBEDDING_RESPONSE_BYTES))) {
        void response.body?.cancel().catch(() => {}); throw new Error('response');
      }
      const bodyReader = response.body.getReader(); reader = bodyReader; const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const chunk = await Promise.race([bodyReader.read(), aborted]); current();
        if (chunk.done) break;
        size += chunk.value.byteLength; if (size > PROBE_EMBEDDING_RESPONSE_BYTES) throw new Error('size'); chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const result = responseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (result.usage.prompt_tokens !== result.usage.total_tokens) throw new Error('usage');
      current();
      return { callId: request.callId, vector: Object.freeze(result.data[0]!.embedding), inputTokens: result.usage.prompt_tokens,
        chargedMicros: probeEmbeddingCharge(result.usage.prompt_tokens) };
    } catch { throw new BrainchainComputeError(transmitted ? 'uncertain' : 'expired'); }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', rejectAbort); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Transport may ignore cancellation. */ } }
    }
  }
}
