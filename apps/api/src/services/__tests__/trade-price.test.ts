import { beforeEach, describe, expect, test } from 'bun:test';
import { TRADE_MINTS } from '@clawville/shared';
import { _resetJupiterPriceCacheForTest, fetchJupiterPrices, resolveJupiterPriceBaseUrl, resolveTradeNotionalUsd } from '../trade-price';

beforeEach(() => _resetJupiterPriceCacheForTest());

describe('trade price', () => {
  test('uses the transaction USDC leg without a fetch', async () => {
    const fetchImpl = (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    const result = await resolveTradeNotionalUsd({ inputMint: TRADE_MINTS.USDC, inputAmount: '1250000', inputDecimals: 6,
      outputMint: TRADE_MINTS.ANSEM, outputAmount: '10', outputDecimals: 6, blockTime: 1, fetchImpl });
    expect(result).toEqual({ notionalUsd: 1.25, source: 'usdc_leg', reason: null });
  });

  test('uses a transaction USDC output without a fetch', async () => {
    const fetchImpl = (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    const result = await resolveTradeNotionalUsd({ inputMint: TRADE_MINTS.ANSEM, inputAmount: '10', inputDecimals: 6,
      outputMint: TRADE_MINTS.USDC, outputAmount: '2500000', outputDecimals: 6, blockTime: 1, fetchImpl });
    expect(result).toEqual({ notionalUsd: 2.5, source: 'usdc_leg', reason: null });
  });

  test('takes the lower live-price leg and uses transaction decimals', async () => {
    const nowMs = 1_750_000_000_000;
    const fetchImpl = (async () => new Response(JSON.stringify({
      [TRADE_MINTS.ANSEM]: { usdPrice: 2, blockId: 1, decimals: 2 },
      [TRADE_MINTS.CLAWVILLE]: { usdPrice: 4, blockId: 1, decimals: 2 },
    }), { status: 200 })) as unknown as typeof fetch;
    const result = await resolveTradeNotionalUsd({ inputMint: TRADE_MINTS.ANSEM, inputAmount: '1000000', inputDecimals: 6,
      outputMint: TRADE_MINTS.CLAWVILLE, outputAmount: '1000000', outputDecimals: 6,
      blockTime: nowMs / 1000, nowMs, fetchImpl });
    expect(result.notionalUsd).toBe(2);
  });

  test('refuses an old non-USDC trade', async () => {
    const result = await resolveTradeNotionalUsd({ inputMint: TRADE_MINTS.ANSEM, inputAmount: '1', inputDecimals: 6,
      outputMint: TRADE_MINTS.CLAWVILLE, outputAmount: '1', outputDecimals: 6, blockTime: 1, nowMs: 2_000_000_000_000 });
    expect(result.reason).toBe('price_stale_window');
  });

  test('fails closed on HTTP and schema errors', async () => {
    const nowMs = 1_750_000_000_000;
    const base = { inputMint: TRADE_MINTS.ANSEM, inputAmount: '1000000', inputDecimals: 6,
      outputMint: TRADE_MINTS.CLAWVILLE, outputAmount: '1000000', outputDecimals: 6,
      blockTime: nowMs / 1000, nowMs };
    const httpError = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    expect(await resolveTradeNotionalUsd({ ...base, fetchImpl: httpError })).toEqual({ notionalUsd: null, source: null, reason: 'price_unavailable' });
    const invalidBody = (async () => new Response(JSON.stringify({
      [TRADE_MINTS.ANSEM]: { blockId: 1, decimals: 6 },
    }), { status: 200 })) as unknown as typeof fetch;
    expect(await resolveTradeNotionalUsd({ ...base, fetchImpl: invalidBody })).toEqual({ notionalUsd: null, source: null, reason: 'price_unavailable' });
  });

  test('treats a missing chain time as stale without a fetch', async () => {
    const fetchImpl = (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    const result = await resolveTradeNotionalUsd({ inputMint: TRADE_MINTS.ANSEM, inputAmount: '1', inputDecimals: 6,
      outputMint: TRADE_MINTS.CLAWVILLE, outputAmount: '1', outputDecimals: 6, blockTime: null, fetchImpl });
    expect(result.reason).toBe('price_stale_window');
  });

  test('allows only the two credential-free HTTPS Jupiter hosts', () => {
    const original = process.env.TRADE_JUPITER_PRICE_BASE_URL;
    const originalKey = process.env.JUPITER_API_KEY;
    try {
      delete process.env.JUPITER_API_KEY;
      for (const value of ['http://evil.test', 'https://evil.test', 'https://user:pw@lite-api.jup.ag']) {
        process.env.TRADE_JUPITER_PRICE_BASE_URL = value;
        expect(resolveJupiterPriceBaseUrl()).toBe('https://lite-api.jup.ag');
      }
      process.env.TRADE_JUPITER_PRICE_BASE_URL = 'https://api.jup.ag';
      expect(resolveJupiterPriceBaseUrl()).toBe('https://api.jup.ag');
    } finally {
      if (original === undefined) delete process.env.TRADE_JUPITER_PRICE_BASE_URL;
      else process.env.TRADE_JUPITER_PRICE_BASE_URL = original;
      if (originalKey === undefined) delete process.env.JUPITER_API_KEY;
      else process.env.JUPITER_API_KEY = originalKey;
    }
  });

  test('chunks price requests at fifty mints', async () => {
    let calls = 0;
    const mints = Array.from({ length: 120 }, (_, i) => `${String(i).padStart(3, '0')}${'1'.repeat(29)}`);
    const fetchImpl = (async () => { calls++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    await fetchJupiterPrices(mints, { fetchImpl, maxAgeMs: 0 });
    expect(calls).toBe(3);
  });

  test('omits absent rows and supports explicit cache bypass', async () => {
    let calls = 0;
    const mint = TRADE_MINTS.ANSEM;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ [mint]: { usdPrice: 1, blockId: 1, decimals: 6 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const first = await fetchJupiterPrices([mint, TRADE_MINTS.CLAWVILLE], { fetchImpl, nowMs: 100 });
    expect(first.has(TRADE_MINTS.CLAWVILLE)).toBe(false);
    await fetchJupiterPrices([mint], { fetchImpl, nowMs: 101 });
    expect(calls).toBe(1);
    await fetchJupiterPrices([mint], { fetchImpl, nowMs: 102, maxAgeMs: 0 });
    expect(calls).toBe(2);
  });
});
