/**
 * 2026-10-08 Helius quota outage: every mainnet READ site must fail over to the
 * public mainnet RPC when Helius answers HTTP 429 "max usage reached".
 * Each test drives the site's REAL default RPC path with a stubbed global fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Keypair } from '@solana/web3.js';
import { __resetMainnetRpcStateForTests, __markFallbackProvenForTests } from '../solana-mainnet-rpc';
import { getWalletClvBalance } from '../linked-wallet-clv-balance';
import { CLV_MINT, fetchHeliusPrice } from '../clv-price-oracle';
import { createDefaultTradeObserverDeps } from '../trade-observer';

const ENV_KEYS = ['HELIUS_API_KEY', 'HELIUS_RPC_URL', 'SOLANA_MAINNET_FALLBACK_RPC_URL'] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

interface RpcCall { host: string; method: string }

/** Helius returns the quota 429; the public RPC answers with `answer(method)`. */
function stubMainnet(answer: (method: string) => unknown): RpcCall[] {
  const calls: RpcCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string };
    calls.push({ host: url.host, method: body.method });
    if (url.host === 'mainnet.helius-rpc.com') {
      return new Response('{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":1}', { status: 429 });
    }
    if (url.host === 'api.mainnet-beta.solana.com') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: answer(body.method) });
    }
    throw new Error(`unexpected host ${url.host}`);
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.HELIUS_API_KEY = 'test-key';
  delete process.env.HELIUS_RPC_URL;
  delete process.env.SOLANA_MAINNET_FALLBACK_RPC_URL;
  __resetMainnetRpcStateForTests(); __markFallbackProvenForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetMainnetRpcStateForTests(); __markFallbackProvenForTests();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('mainnet read sites fail over from a quota-exhausted Helius', () => {
  test('linked-wallet CLV balance reads through the public RPC', async () => {
    const calls = stubMainnet((method) => {
      expect(method).toBe('getTokenAccountsByOwner');
      return { context: { slot: 77 }, value: [] };
    });
    const result = await getWalletClvBalance(Keypair.generate().publicKey.toBase58(), { maxAgeMs: 0 });
    expect(result).toMatchObject({ available: true, amountAtomic: '0', cached: false });
    expect(calls.map((c) => c.host)).toEqual(['mainnet.helius-rpc.com', 'api.mainnet-beta.solana.com']);
  });

  test('CLV price oracle Helius getAsset uses the failover fetch', async () => {
    const calls = stubMainnet((method) => {
      expect(method).toBe('getAsset');
      return { id: CLV_MINT, token_info: { price_info: { price_per_token: 0.00007 } } };
    });
    expect(await fetchHeliusPrice()).toBe(0.00007);
    expect(calls.map((c) => c.host)).toEqual(['mainnet.helius-rpc.com', 'api.mainnet-beta.solana.com']);
  });

  test('CLV price oracle stays null (DexScreener path) when the fallback has no DAS method', async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as { id: unknown };
      if (url.host === 'mainnet.helius-rpc.com') return new Response('max usage reached', { status: 429 });
      return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
    }) as unknown as typeof fetch;
    expect(await fetchHeliusPrice()).toBeNull();
  });

  test('trade observer signature list and raw transaction fetch both fail over', async () => {
    const calls = stubMainnet((method) => {
      if (method === 'getSignaturesForAddress') return [];
      if (method === 'getTransaction') return null;
      throw new Error(`unexpected method ${method}`);
    });
    const deps = createDefaultTradeObserverDeps();
    const wallet = Keypair.generate().publicKey.toBase58();
    expect(await deps.getSignaturesForAddress(wallet, { limit: 10 })).toEqual([]);
    expect(await deps.getParsedTransaction('1'.repeat(64))).toBeNull();
    // First read trips the breaker; the second goes straight to the fallback.
    expect(calls).toEqual([
      { host: 'mainnet.helius-rpc.com', method: 'getSignaturesForAddress' },
      { host: 'api.mainnet-beta.solana.com', method: 'getSignaturesForAddress' },
      { host: 'api.mainnet-beta.solana.com', method: 'getTransaction' },
    ]);
  });
});
