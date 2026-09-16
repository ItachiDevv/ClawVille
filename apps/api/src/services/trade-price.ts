import { z } from 'zod';
import { TRADE_MINTS } from '@clawville/shared';

export type NotionalSource = 'usdc_leg' | 'live_price';
export interface NotionalResult {
  notionalUsd: number | null;
  source: NotionalSource | null;
  reason: 'price_unavailable' | 'price_stale_window' | null;
}

export interface JupiterPriceRow {
  mint: string;
  usdPrice: number;
  blockId: number;
  decimals: number;
  liquidity: number | null;
  priceChange24h: number | null;
  createdAt: string | null;
  launchpad: string | null;
  fetchedAt: number;
}

export interface JupiterPriceCacheEntry { mint: string; usdPrice: number; fetchedAtMs: number }
export const JUPITER_PRICE_CACHE_TTL_MS = 30_000;
const ALLOWED_PRICE_HOSTS = new Set(['lite-api.jup.ag', 'api.jup.ag']);
const cache = new Map<string, JupiterPriceRow>();

const jupiterPriceSchema = z.record(z.string(), z.object({
  usdPrice: z.number().finite().positive(),
  blockId: z.number().finite().nonnegative(),
  decimals: z.number().int().min(0).max(18),
  liquidity: z.number().finite().nullable().optional(),
  priceChange24h: z.number().finite().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  launchpad: z.string().nullable().optional(),
}).passthrough());

export function resolveJupiterPriceBaseUrl(): string {
  const fallback = process.env.JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
  const configured = process.env.TRADE_JUPITER_PRICE_BASE_URL?.trim();
  if (!configured) return fallback;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || !ALLOWED_PRICE_HOSTS.has(url.hostname)) throw new Error('not allowed');
    return url.origin;
  } catch {
    console.warn('[trade-price] Invalid TRADE_JUPITER_PRICE_BASE_URL; using the pinned host.');
    return fallback;
  }
}

export function jupiterPriceHeaders(): Record<string, string> {
  return process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {};
}

export async function fetchJupiterPrices(
  mints: readonly string[],
  deps: { fetchImpl?: typeof fetch; nowMs?: number; maxAgeMs?: number } = {},
): Promise<Map<string, JupiterPriceRow>> {
  z.object({
    mints: z.array(z.string().min(32).max(44)),
    deps: z.object({ fetchImpl: z.function().optional(), nowMs: z.number().optional(), maxAgeMs: z.number().min(0).optional() }).strict(),
  }).strict().parse({ mints: [...mints], deps });
  const nowMs = deps.nowMs ?? Date.now();
  const maxAgeMs = deps.maxAgeMs ?? 10_000;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const requested = [...new Set(mints)];
  const result = new Map<string, JupiterPriceRow>();
  const missing: string[] = [];
  for (const mint of requested) {
    const row = cache.get(mint);
    if (row && maxAgeMs > 0 && nowMs - row.fetchedAt <= Math.min(maxAgeMs, JUPITER_PRICE_CACHE_TTL_MS)) result.set(mint, row);
    else missing.push(mint);
  }
  for (let offset = 0; offset < missing.length; offset += 50) {
    const chunk = missing.slice(offset, offset + 50);
    try {
      const url = new URL('/price/v3', resolveJupiterPriceBaseUrl());
      url.searchParams.set('ids', chunk.join(','));
      const response = await fetchImpl(url, { headers: jupiterPriceHeaders(), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const body = jupiterPriceSchema.safeParse(await response.json());
      if (!body.success) continue;
      for (const [mint, wire] of Object.entries(body.data)) {
        if (!chunk.includes(mint)) continue;
        const row: JupiterPriceRow = {
          mint, usdPrice: wire.usdPrice, blockId: wire.blockId, decimals: wire.decimals,
          liquidity: wire.liquidity ?? null, priceChange24h: wire.priceChange24h ?? null,
          createdAt: wire.createdAt ?? null, launchpad: wire.launchpad ?? null, fetchedAt: nowMs,
        };
        cache.set(mint, row);
        result.set(mint, row);
      }
    } catch {
      // Missing rows represent unavailable prices. Do not throw or log credentials.
    }
  }
  return result;
}

function atomicToNumber(amount: string, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

function freshnessSeconds(): number {
  const configured = Number(process.env.TRADE_PRICE_FRESHNESS_S ?? 900);
  return Number.isFinite(configured) ? Math.max(60, Math.floor(configured)) : 900;
}

export async function resolveTradeNotionalUsd(input: {
  inputMint: string; inputAmount: string; inputDecimals: number;
  outputMint: string; outputAmount: string; outputDecimals: number;
  blockTime: number | null; nowMs?: number; fetchImpl?: typeof fetch;
}): Promise<NotionalResult> {
  z.object({
    inputMint: z.string().min(1), inputAmount: z.string().regex(/^\d+$/), inputDecimals: z.number().int().min(0).max(18),
    outputMint: z.string().min(1), outputAmount: z.string().regex(/^\d+$/), outputDecimals: z.number().int().min(0).max(18),
    blockTime: z.number().int().nullable(), nowMs: z.number().optional(), fetchImpl: z.function().optional(),
  }).strict().parse(input);
  if (input.inputMint === TRADE_MINTS.USDC) {
    return { notionalUsd: atomicToNumber(input.inputAmount, input.inputDecimals), source: 'usdc_leg', reason: null };
  }
  if (input.outputMint === TRADE_MINTS.USDC) {
    return { notionalUsd: atomicToNumber(input.outputAmount, input.outputDecimals), source: 'usdc_leg', reason: null };
  }
  if (input.blockTime === null) return { notionalUsd: null, source: null, reason: 'price_stale_window' };
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - input.blockTime * 1_000) > freshnessSeconds() * 1_000) {
    return { notionalUsd: null, source: null, reason: 'price_stale_window' };
  }
  const prices = await fetchJupiterPrices([input.inputMint, input.outputMint], { fetchImpl: input.fetchImpl, nowMs });
  const candidates: number[] = [];
  const inputPrice = prices.get(input.inputMint);
  const outputPrice = prices.get(input.outputMint);
  if (inputPrice) candidates.push(atomicToNumber(input.inputAmount, input.inputDecimals) * inputPrice.usdPrice);
  if (outputPrice) candidates.push(atomicToNumber(input.outputAmount, input.outputDecimals) * outputPrice.usdPrice);
  if (candidates.length === 0) return { notionalUsd: null, source: null, reason: 'price_unavailable' };
  return { notionalUsd: Math.min(...candidates), source: 'live_price', reason: null };
}

export function _resetJupiterPriceCacheForTest(): void { cache.clear(); }
