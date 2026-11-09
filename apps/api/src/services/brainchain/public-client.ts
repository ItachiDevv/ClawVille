import { z } from 'zod';
import { validateOutboundUrlResolved } from '../hatcher-config';

/** Closed endpoint inventory. Neither caller input nor vendor responses can add URLs. */
export const BRAINCHAIN_PUBLIC_ENDPOINTS = {
  mainnetExit: 'https://brain.usebrainchain.com/exits',
  testnetExit: 'https://brain.testnet.usebrainchain.com/exits',
} as const;
export type BrainChainPublicEndpoint = keyof typeof BRAINCHAIN_PUBLIC_ENDPOINTS;

const atomicAmount = z.string().regex(/^\d{1,78}$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const exitSchema = z.object({
  desk: evmAddress,
  token: evmAddress,
  payoutChainId: z.number().int().positive().safe(),
  payoutToken: evmAddress,
  feeBps: z.number().int().min(0).max(10_000),
  minFeeUnits: atomicAmount,
  minUnits: atomicAmount,
  maxUnits: atomicAmount,
  dailyUnits: atomicAmount,
}).refine((value) => BigInt(value.minUnits) <= BigInt(value.maxUnits));

export type BrainChainExitTerms = z.infer<typeof exitSchema>;
const paymentOffer = z.object({
  scheme: z.literal('exact'),
  network: z.string().regex(/^(eip155:\d{1,20}|solana:[A-Za-z0-9]{1,64})$/),
  amount: atomicAmount,
  asset: z.string().min(1).max(128),
  payTo: z.string().min(1).max(128),
  maxTimeoutSeconds: z.number().int().positive().max(86_400),
});
const paymentChallenge = z.object({
  x402Version: z.literal(2),
  accepts: z.array(paymentOffer).min(1).max(16),
});
export type BrainChainPaymentObservation = {
  checkedAt: string;
} & (
  | { state: 'observed'; httpStatus: 402; offers: z.infer<typeof paymentOffer>[] }
  | { state: 'unavailable'; reason: 'http_error' | 'invalid_response' | 'request_failed'; httpStatus?: number }
);
export type BrainChainExitObservation = {
  endpoint: BrainChainPublicEndpoint;
  checkedAt: string;
} & (
  | { state: 'observed'; httpStatus: 200; terms: BrainChainExitTerms }
  | { state: 'unavailable'; reason: 'not_found' | 'http_error' | 'invalid_response' | 'request_failed'; httpStatus?: number }
);

type Dependencies = {
  fetch: typeof globalThis.fetch;
  validateUrl: typeof validateOutboundUrlResolved;
  now: () => number;
  timeoutMs: number;
  maxBytes: number;
};

/** The timeout covers DNS, headers, and streamed body reads. Never forwards credentials. */
export function createBrainChainPublicClient(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    fetch: globalThis.fetch, validateUrl: validateOutboundUrlResolved,
    now: Date.now, timeoutMs: 5_000, maxBytes: 32_768, ...overrides,
  };

  async function observeExit(endpoint: BrainChainPublicEndpoint): Promise<BrainChainExitObservation> {
    const base = { endpoint, checkedAt: new Date(deps.now()).toISOString() };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, deps.timeoutMs);
    });
    const request = async (): Promise<BrainChainExitObservation> => {
      const url = BRAINCHAIN_PUBLIC_ENDPOINTS[endpoint];
      const checked = await deps.validateUrl(url);
      if (!checked.ok || controller.signal.aborted) throw new Error('request_failed');
      const response = await deps.fetch(url, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/json' }, credentials: 'omit',
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return { ...base, state: 'unavailable', reason: response.status === 404 ? 'not_found' : 'http_error', httpStatus: response.status };
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      const length = response.headers.get('content-length');
      if (contentType !== 'application/json' || (length !== null && (!/^\d+$/.test(length) || Number(length) > deps.maxBytes))) {
        await response.body?.cancel();
        return { ...base, state: 'unavailable', reason: 'invalid_response' };
      }
      if (!response.body) return { ...base, state: 'unavailable', reason: 'invalid_response' };
      const reader = response.body.getReader();
      const cancelRead = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancelRead, { once: true });
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > deps.maxBytes) {
            await reader.cancel();
            return { ...base, state: 'unavailable', reason: 'invalid_response' };
          }
          chunks.push(value);
        }
      } finally {
        controller.signal.removeEventListener('abort', cancelRead);
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try {
        const parsed = exitSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        return parsed.success
          ? { ...base, state: 'observed', httpStatus: 200, terms: parsed.data }
          : { ...base, state: 'unavailable', reason: 'invalid_response' };
      } catch {
        return { ...base, state: 'unavailable', reason: 'invalid_response' };
      }
    };
    try {
      return await Promise.race([request(), timeout]);
    } catch {
      return { ...base, state: 'unavailable', reason: 'request_failed' };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  /** Empty, unsigned probe. No payer input and no payment authorization leave ClawVille. */
  async function observePayment(): Promise<BrainChainPaymentObservation> {
    const base = { checkedAt: new Date(deps.now()).toISOString() };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, deps.timeoutMs);
    });
    const request = async (): Promise<BrainChainPaymentObservation> => {
      const url = 'https://brain.usebrainchain.com/x402/tasks';
      const checked = await deps.validateUrl(url);
      if (!checked.ok || controller.signal.aborted) throw new Error('request_failed');
      const response = await deps.fetch(url, {
        method: 'POST', body: '{}', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, credentials: 'omit',
      });
      // Only the challenge header is needed. Never parse or relay task results.
      await response.body?.cancel();
      if (response.status !== 402) return { ...base, state: 'unavailable', reason: 'http_error', httpStatus: response.status };
      const header = response.headers.get('payment-required');
      if (!header || header.length > deps.maxBytes || !/^[A-Za-z0-9+/]*={0,2}$/.test(header)) {
        return { ...base, state: 'unavailable', reason: 'invalid_response' };
      }
      try {
        const parsed = paymentChallenge.safeParse(JSON.parse(Buffer.from(header, 'base64').toString('utf8')));
        return parsed.success
          ? { ...base, state: 'observed', httpStatus: 402, offers: parsed.data.accepts }
          : { ...base, state: 'unavailable', reason: 'invalid_response' };
      } catch {
        return { ...base, state: 'unavailable', reason: 'invalid_response' };
      }
    };
    try {
      return await Promise.race([request(), timeout]);
    } catch {
      return { ...base, state: 'unavailable', reason: 'request_failed' };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return { observeExit, observePayment };
}
