/**
 * Helius budget (2026-10-31): the CLV oracle asks DexScreener first and calls the
 * Helius DAS `getAsset` (10 credits) ONLY when DexScreener has no usable price.
 * Depth always comes from DexScreener. Global fetch is stubbed; calls are counted
 * per host.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __resetMainnetRpcStateForTests } from '../solana-mainnet-rpc';
import { fetchSpot } from '../clv-price-oracle';

const ENV_KEYS = ['HELIUS_API_KEY', 'HELIUS_RPC_URL', 'SOLANA_MAINNET_FALLBACK_RPC_URL'] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

type DexAnswer = { status: number; body?: unknown } | 'throw';

function stubFeeds(dex: DexAnswer, heliusPrice: number | null): string[] {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    hosts.push(url.host);
    if (url.host === 'api.dexscreener.com') {
      if (dex === 'throw') throw new Error('dexscreener down');
      return Response.json(dex.body ?? {}, { status: dex.status });
    }
    if (url.host === 'mainnet.helius-rpc.com') {
      return Response.json({
        jsonrpc: '2.0',
        id: 'clv-price-oracle',
        result: heliusPrice === null ? {} : { token_info: { price_info: { price_per_token: heliusPrice } } },
      });
    }
    throw new Error(`unexpected host ${url.host}`);
  }) as unknown as typeof fetch;
  return hosts;
}

const DEX_OK = {
  status: 200,
  body: {
    pairs: [
      { priceUsd: '0.00007', liquidity: { usd: 1_000 } },
      { priceUsd: '0.000071234567', liquidity: { usd: 22_000 } },
    ],
  },
};

beforeEach(() => {
  process.env.HELIUS_API_KEY = 'test-key';
  delete process.env.HELIUS_RPC_URL;
  delete process.env.SOLANA_MAINNET_FALLBACK_RPC_URL;
  __resetMainnetRpcStateForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetMainnetRpcStateForTests();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('CLV oracle precedence: DexScreener primary, Helius fallback', () => {
  test('DexScreener answers: its price and depth are used, Helius is NOT called', async () => {
    const hosts = stubFeeds(DEX_OK, 0.5);
    const spot = await fetchSpot();
    expect(spot).toEqual({
      priceNum: 0.000071234567,
      priceStr: '0.000071234567',
      source: 'dexscreener',
      liquidityUsd: 22_000,
    });
    expect(hosts).toEqual(['api.dexscreener.com']);
  });

  test('DexScreener fails (HTTP error, throw, or no priced pair): Helius IS called and the source says helius', async () => {
    for (const dex of [
      { status: 500 },
      'throw' as const,
      { status: 200, body: { pairs: [{ priceUsd: '0', liquidity: { usd: 5 } }] } },
      { status: 200, body: { pairs: [] } },
    ]) {
      __resetMainnetRpcStateForTests();
      const hosts = stubFeeds(dex, 0.00008);
      const spot = await fetchSpot();
      expect(spot).toEqual({ priceNum: 0.00008, priceStr: '0.000080000000', source: 'helius', liquidityUsd: null });
      expect(hosts).toEqual(['api.dexscreener.com', 'mainnet.helius-rpc.com']);
    }
  });

  test('both feeds fail: null (the poll serves last-known)', async () => {
    const hosts = stubFeeds({ status: 503 }, null);
    expect(await fetchSpot()).toBeNull();
    expect(hosts).toEqual(['api.dexscreener.com', 'mainnet.helius-rpc.com']);
  });

  test('no Helius key and DexScreener down: null, and no Helius request', async () => {
    delete process.env.HELIUS_API_KEY;
    const hosts = stubFeeds({ status: 500 }, 0.5);
    expect(await fetchSpot()).toBeNull();
    expect(hosts).toEqual(['api.dexscreener.com']);
  });
});
