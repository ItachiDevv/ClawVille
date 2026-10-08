import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resetTradingLoopAlertsForTest,
  shouldAlertTradingLoop,
  TRADING_ALERT_REPEAT_MS,
  tradingConnection,
  tradingMainnetRpcUrl,
  tradingRpcConfigured,
} from '../trading-rpc';
import { __resetMainnetRpcStateForTests, __markFallbackProvenForTests } from '../solana-mainnet-rpc';

const saved = {
  HELIUS_RPC_URL: process.env.HELIUS_RPC_URL,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  SOLANA_MAINNET_FALLBACK_RPC_URL: process.env.SOLANA_MAINNET_FALLBACK_RPC_URL,
};
const realFetch = globalThis.fetch;
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = realFetch;
  __resetMainnetRpcStateForTests(); __markFallbackProvenForTests();
  resetTradingLoopAlertsForTest();
});

/** Helius answers the 2026-10-08 quota 429; the public RPC answers `fallbackStatus`. */
function stubMainnetFetch(fallbackStatus = 200): string[] {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    hosts.push(url.host);
    if (url.host === 'mainnet.helius-rpc.com') {
      return new Response('{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":1}', { status: 429 });
    }
    if (url.host === 'api.mainnet-beta.solana.com') {
      if (fallbackStatus !== 200) return new Response('unavailable', { status: fallbackStatus });
      const body = JSON.parse(String(init?.body)) as { id: unknown };
      return Response.json({ jsonrpc: '2.0', id: body.id, result: 424_242 });
    }
    throw new Error(`unexpected host ${url.host}`);
  }) as unknown as typeof fetch;
  return hosts;
}

describe('trading mainnet RPC resolver (2026-09-16 pager-storm fix)', () => {
  test('derives the Helius mainnet URL from the canonical HELIUS_API_KEY', () => {
    delete process.env.HELIUS_RPC_URL;
    process.env.HELIUS_API_KEY = 'abc def';
    expect(tradingMainnetRpcUrl()).toBe('https://mainnet.helius-rpc.com/?api-key=abc%20def');
    expect(tradingRpcConfigured()).toBe(true);
  });

  test('an explicit HELIUS_RPC_URL override wins but must be https + mainnet', () => {
    process.env.HELIUS_API_KEY = 'ignored';
    process.env.HELIUS_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=x';
    expect(tradingMainnetRpcUrl()).toBe('https://mainnet.helius-rpc.com/?api-key=x');
    process.env.HELIUS_RPC_URL = 'http://mainnet.helius-rpc.com/?api-key=x';
    expect(() => tradingMainnetRpcUrl()).toThrow('not an https mainnet endpoint');
    process.env.HELIUS_RPC_URL = 'https://devnet.helius-rpc.com/?api-key=x';
    expect(() => tradingMainnetRpcUrl()).toThrow('not an https mainnet endpoint');
    expect(tradingRpcConfigured()).toBe(false);
  });

  test('with neither knob the fleet is unconfigured and never falls back to a public RPC', () => {
    delete process.env.HELIUS_RPC_URL;
    delete process.env.HELIUS_API_KEY;
    expect(tradingMainnetRpcUrl()).toBeNull();
    expect(tradingRpcConfigured()).toBe(false);
  });

  test('a quota-exhausted Helius fails over to public mainnet; both down still throws (fail closed)', async () => {
    delete process.env.HELIUS_RPC_URL;
    delete process.env.SOLANA_MAINNET_FALLBACK_RPC_URL;
    process.env.HELIUS_API_KEY = 'k';
    const hosts = stubMainnetFetch();
    expect(await tradingConnection().getSlot('confirmed')).toBe(424_242);
    expect(hosts).toEqual(['mainnet.helius-rpc.com', 'api.mainnet-beta.solana.com']);

    __resetMainnetRpcStateForTests(); __markFallbackProvenForTests();
    stubMainnetFetch(503);
    await expect(tradingConnection().getSlot('confirmed')).rejects.toThrow();
  });

  test('a background-loop failure cause alerts once, then at most hourly', () => {
    expect(shouldAlertTradingLoop('sweeper:x', 1_000)).toBe(true);
    expect(shouldAlertTradingLoop('sweeper:x', 1_000 + 5 * 60_000)).toBe(false);
    expect(shouldAlertTradingLoop('sweeper:y', 1_000 + 5 * 60_000)).toBe(true);
    expect(shouldAlertTradingLoop('sweeper:x', 1_000 + TRADING_ALERT_REPEAT_MS)).toBe(true);
  });

  test('only the resolvers read HELIUS_RPC_URL and the sweeper opens a connection only when it has rows', () => {
    const services = resolve(import.meta.dir, '..');
    const readers = readdirSync(services)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /HELIUS_RPC_URL/.test(readFileSync(resolve(services, name), 'utf8')))
      .sort();
    // solana-mainnet-rpc.ts is the shared mainnet primary resolver (2026-10-08 failover).
    expect(readers).toEqual(['solana-mainnet-rpc.ts', 'trading-rpc.ts']);
    const execution = readFileSync(resolve(services, 'trading-execution.ts'), 'utf8');
    const rowsQuery = execution.indexOf("eq(tradingDecisions.status, 'submitted'), lt(tradingDecisions.createdAt");
    const connOpen = execution.indexOf('const conn = defaultConnection();');
    expect(rowsQuery).toBeGreaterThan(0);
    expect(connOpen).toBeGreaterThan(rowsQuery);
    expect(execution).toMatch(/if \(rows\.length === 0\) return;/);
    expect(execution).toMatch(/shouldAlertTradingLoop\(`sweeper:\$\{message\}`\)/);
  });
});
