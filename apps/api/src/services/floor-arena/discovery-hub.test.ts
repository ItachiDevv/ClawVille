import { describe, expect, test } from 'bun:test';
import {
  buildSnapshot, cleanVendorText, enrichTier, isTradableMint, mergeDiscoveryRow, mergeSightings, orderEnrichment,
  parseClawpumpRows, parseDexscreenerList, parseGeckoPools, pickBestPairs, type Sighting,
} from './discovery-hub';
import { tradeableFirstSeenMs } from './filters';

const A = '3b5fTE5NyvCtMgKcDkvt4vUW2KDc7mgUSW8a8XYVpump';
const B = '84D3VopU3g5qo7jUwzQK4P4BnVPQWr2MzeaRCFkHpump';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const NOW = new Date(Date.UTC(2026, 8, 30, 12, 0, 0));

describe('source parsers', () => {
  test('DexScreener lists keep Solana token addresses only', () => {
    const body = [
      { chainId: 'solana', tokenAddress: A, description: 'x' },
      { chainId: 'bsc', tokenAddress: '0xabc' },
      { chainId: 'solana', tokenAddress: USDC },
      { chainId: 'solana', tokenAddress: 'not a mint' },
    ];
    expect(parseDexscreenerList(body, 'ds:token-profiles')).toEqual([{ mint: A, source: 'ds:token-profiles', symbol: null, name: null }]);
    expect(() => parseDexscreenerList({ pairs: [] }, 'ds:token-boosts-top')).toThrow();
  });

  test('ClawPump signals and anomalies keep chain sol only', () => {
    const signals = { chain: 'sol', count: 2, signals: [
      { chain: 'sol', contract: A, symbol: 'SENDOR', name: 'sendor' },
      { chain: 'bnb', contract: '0x7731Bf9eE2F367A5a563A34E5B610C14F75b7777', symbol: 'Z' },
    ] };
    expect(parseClawpumpRows(signals, 'signals', 'clawpump:signals')).toEqual([{ mint: A, source: 'clawpump:signals', symbol: 'SENDOR', name: 'sendor' }]);
    expect(parseClawpumpRows({ count: 1, gems: [{ chain: 'sol', contract: B, symbol: 'POND', name: null }] }, 'gems', 'clawpump:anomalies'))
      .toEqual([{ mint: B, source: 'clawpump:anomalies', symbol: 'POND', name: null }]);
    expect(() => parseClawpumpRows({ gems: 'x' }, 'gems', 'clawpump:anomalies')).toThrow();
  });

  test('GeckoTerminal new pools: the base token, or the quote token when the base is SOL/USDC', () => {
    const body = { data: [
      { attributes: { name: 'SENDOR / SOL' }, relationships: { base_token: { data: { id: `solana_${A}` } }, quote_token: { data: { id: `solana_${WSOL}` } } } },
      { attributes: { name: 'SOL / POND' }, relationships: { base_token: { data: { id: `solana_${WSOL}` } }, quote_token: { data: { id: `solana_${B}` } } } },
      { attributes: { name: 'SOL / USDC' }, relationships: { base_token: { data: { id: `solana_${WSOL}` } }, quote_token: { data: { id: `solana_${USDC}` } } } },
    ] };
    expect(parseGeckoPools(body, 'gecko:new-pools')).toEqual([
      { mint: A, source: 'gecko:new-pools', symbol: 'SENDOR', name: null },
      { mint: B, source: 'gecko:new-pools', symbol: null, name: null },
    ]);
    expect(parseGeckoPools(body, 'gecko:trending_5m').map((s) => s.source)).toEqual(['gecko:trending_5m', 'gecko:trending_5m']);
    expect(() => parseGeckoPools({ errors: [] }, 'gecko:trending_5m')).toThrow();
  });

  test('quote mints are never tradable candidates', () => {
    expect(isTradableMint(A)).toBe(true);
    expect(isTradableMint(USDC)).toBe(false);
    expect(isTradableMint(WSOL)).toBe(false);
  });
});

describe('discovery upsert merge', () => {
  const s = (mint: string, source: Sighting['source'], symbol: string | null = null): Sighting => ({ mint, source, symbol, name: null });

  test('one row per mint; sources in order of appearance; first sighting names first_source', () => {
    const merged = mergeSightings([s(A, 'gecko:new-pools'), s(B, 'clawpump:signals', 'POND'), s(A, 'ds:token-profiles', 'SEN'), s(A, 'gecko:new-pools')]);
    expect(merged).toEqual([
      { mint: A, firstSource: 'gecko:new-pools', sources: ['gecko:new-pools', 'ds:token-profiles'], symbol: 'SEN', name: null },
      { mint: B, firstSource: 'clawpump:signals', sources: ['clawpump:signals'], symbol: 'POND', name: null },
    ]);
  });

  test('insert: first_seen = last_seen = now, expires = first_seen + 24 h', () => {
    const row = mergeDiscoveryRow(null, mergeSightings([s(A, 'ds:token-boosts-top', 'X')])[0]!, NOW);
    expect(row.firstSeenAt).toEqual(NOW);
    expect(row.lastSeenAt).toEqual(NOW);
    expect(row.firstSource).toBe('ds:token-boosts-top');
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + 24 * 3_600_000);
  });

  test('merge: first_seen/first_source/symbol kept, sources appended, expiry extended to last_seen + 6 h', () => {
    const first = new Date(NOW.getTime() - 23 * 3_600_000);
    const existing = {
      mint: A, firstSeenAt: first, firstSource: 'gecko:new-pools', sources: ['gecko:new-pools'], lastSeenAt: first,
      symbol: 'OLD', name: null, expiresAt: new Date(first.getTime() + 24 * 3_600_000),
      sourceFirstSeen: { 'gecko:new-pools': first.toISOString() },
    };
    const row = mergeDiscoveryRow(existing, mergeSightings([s(A, 'clawpump:signals', 'NEW'), s(A, 'gecko:new-pools')])[0]!, NOW);
    expect(row.firstSeenAt).toEqual(first);
    expect(row.firstSource).toBe('gecko:new-pools');
    expect(row.sources).toEqual(['gecko:new-pools', 'clawpump:signals']);
    expect(row.symbol).toBe('OLD');
    expect(row.lastSeenAt).toEqual(NOW);
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + 6 * 3_600_000);
  });

  test('D25: source_first_seen sets each source ONCE; a later sighting never overwrites it', () => {
    const t1 = new Date(NOW.getTime() + 60_000);
    const t2 = new Date(NOW.getTime() + 120_000);
    const inserted = mergeDiscoveryRow(null, mergeSightings([s(A, 'gecko:new-pools')])[0]!, NOW);
    expect(inserted.sourceFirstSeen).toEqual({ 'gecko:new-pools': NOW.toISOString() });
    const withDs = mergeDiscoveryRow(inserted, mergeSightings([s(A, 'ds:token-profiles'), s(A, 'gecko:new-pools')])[0]!, t1);
    expect(withDs.sourceFirstSeen).toEqual({ 'gecko:new-pools': NOW.toISOString(), 'ds:token-profiles': t1.toISOString() });
    const again = mergeDiscoveryRow(withDs, mergeSightings([s(A, 'ds:token-profiles')])[0]!, t2);
    expect(again.sourceFirstSeen['ds:token-profiles']).toBe(t1.toISOString());
  });

  test('r12: a source the row already lists WITHOUT a key gets the row first_seen_at, never now', () => {
    const t0 = new Date(NOW.getTime() - 3 * 3_600_000);
    const t1 = NOW;
    // (a) legacy row (before D25): sources [gecko, ds], map only {gecko: t0}; DexScreener is sighted again at t1.
    const legacy = {
      mint: A, firstSeenAt: t0, firstSource: 'gecko:trending_5m', sources: ['gecko:trending_5m', 'ds:token-profiles'],
      lastSeenAt: t0, symbol: null, name: null, expiresAt: new Date(t0.getTime() + 24 * 3_600_000),
      sourceFirstSeen: { 'gecko:trending_5m': t0.toISOString() },
    };
    const row = mergeDiscoveryRow(legacy, mergeSightings([s(A, 'ds:token-profiles'), s(A, 'clawpump:signals')])[0]!, t1);
    expect(row.sourceFirstSeen).toEqual({
      'gecko:trending_5m': t0.toISOString(),
      'ds:token-profiles': t0.toISOString(),   // (a) already listed -> first_seen_at, not t1
      'clawpump:signals': t1.toISOString(),    // (b) new to the row -> now
    });
    // (c) an existing key is never overwritten.
    const later = mergeDiscoveryRow(row, mergeSightings([s(A, 'ds:token-profiles')])[0]!, new Date(t1.getTime() + 60_000));
    expect(later.sourceFirstSeen['ds:token-profiles']).toBe(t0.toISOString());
    expect(later.sourceFirstSeen['clawpump:signals']).toBe(t1.toISOString());
    // The reader agrees: the tradeable clock starts at t0, not t1.
    expect(tradeableFirstSeenMs(later.sources, later.sourceFirstSeen, t0.getTime())).toBe(t0.getTime());
  });

  test('r12: a row the OLD code wrote during a deploy flip (empty map, grown sources) behaves the same', () => {
    const t0 = new Date(NOW.getTime() - 3_600_000);
    const oldCode = {
      mint: A, firstSeenAt: t0, firstSource: 'gecko:new-pools', sources: ['gecko:new-pools', 'ds:token-boosts-top'],
      lastSeenAt: t0, symbol: null, name: null, expiresAt: new Date(t0.getTime() + 24 * 3_600_000), sourceFirstSeen: {},
    };
    const row = mergeDiscoveryRow(oldCode, mergeSightings([s(A, 'ds:token-boosts-top'), s(A, 'ds:token-profiles')])[0]!, NOW);
    expect(row.sourceFirstSeen).toEqual({ 'ds:token-boosts-top': t0.toISOString(), 'ds:token-profiles': NOW.toISOString() });
    expect(tradeableFirstSeenMs(row.sources, row.sourceFirstSeen, t0.getTime())).toBe(t0.getTime());
  });

  test('expiry never moves backwards', () => {
    const existing = {
      mint: A, firstSeenAt: NOW, firstSource: 'gecko:new-pools', sources: ['gecko:new-pools'], lastSeenAt: NOW,
      symbol: null, name: null, expiresAt: new Date(NOW.getTime() + 24 * 3_600_000),
      sourceFirstSeen: { 'gecko:new-pools': NOW.toISOString() },
    };
    const later = new Date(NOW.getTime() + 60_000);
    const row = mergeDiscoveryRow(existing, mergeSightings([s(A, 'gecko:new-pools')])[0]!, later);
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + 24 * 3_600_000);
  });
});

describe('vendor text sanitizing (Codex r2 #7)', () => {
  test('strips control, bidi, zero-width and emoji characters, collapses spaces, caps by code points', () => {
    expect(cleanVendorText('  PEPE\u0000​  🚀🐸  ', 16)).toBe('PEPE');
    expect(cleanVendorText('evil‮gnp.exe', 48)).toBe('evilgnp.exe');
    expect(cleanVendorText('a\tb\n\nc', 48)).toBe('a b c');
    expect(cleanVendorText('🇺🇸👍🏽❤️', 16)).toBeNull();
    expect(cleanVendorText('ＰＥＰＥ', 16)).toBe('PEPE');
    expect(cleanVendorText('x'.repeat(40), 16)).toBe('x'.repeat(16));
    expect(cleanVendorText('Café 金', 48)).toBe('Café 金');
    expect(cleanVendorText(42, 16)).toBeNull();
  });

  test('parsers and snapshots store only sanitized symbol / name and validated ids', () => {
    const rows = parseClawpumpRows({ signals: [{ chain: 'sol', contract: A, symbol: '💎DIAMOND HANDS FOREVER', name: 'Name\u0007 with bell' }] }, 'signals', 'clawpump:signals');
    expect(rows[0]).toMatchObject({ symbol: 'DIAMOND HANDS FO', name: 'Name with bell' });
    const snap = buildSnapshot({
      chainId: 'solana', dexId: 'Pump Swap<script>', pairAddress: 'javascript:alert(1)', labels: ['DYN2', '<b>x</b>', 7],
      baseToken: { address: A, symbol: '‮KNOB', name: 'n'.repeat(100) }, quoteToken: { address: 'not-an-address' },
      priceUsd: '1', marketCap: 1, liquidity: { usd: 1 },
    }, NOW.getTime());
    expect(snap.dexId).toBeNull();
    expect(snap.pairAddress).toBeNull();
    expect(snap.quoteMint).toBeNull();
    expect(snap.labels).toEqual(['DYN2']);
    expect(snap.symbol).toBe('KNOB');
    expect(snap.name).toBe('n'.repeat(48));
  });
});

describe('DexScreener snapshots', () => {
  const pair = (over: Record<string, unknown>) => ({
    chainId: 'solana', dexId: 'pumpswap', pairAddress: 'P1', labels: [],
    baseToken: { address: A, symbol: 'SENDOR', name: 'sendor' }, quoteToken: { address: WSOL },
    priceUsd: '0.0000628', marketCap: 62_800, fdv: 62_800, liquidity: { usd: 23_700, base: 1e8, quote: 60 },
    pairCreatedAt: NOW.getTime() - 20_040_000, priceChange: { m5: 1.5, h1: -3, h6: 40, h24: 120 },
    txns: { h1: { buys: 120, sells: 80 } }, volume: { h1: 31_400 }, ...over,
  });

  test('D26: a pump.fun curve pair (no liquidity field) is picked and marked with its price', () => {
    const curvePair = pair({ dexId: 'pumpfun', pairAddress: B, liquidity: undefined, marketCap: 35_000, priceUsd: '0.000002575' });
    const best = pickBestPairs([pair({ dexId: 'orca', pairAddress: 'ORCA', liquidity: { usd: 1_000 } }), curvePair], new Set([A]));
    expect(best.get(A)?.dexId).toBe('pumpfun');
    const snapshot = buildSnapshot(best.get(A)!, NOW.getTime());
    expect(snapshot).toMatchObject({ dexId: 'pumpfun', priceUsd: 0.000002575, liqUsd: null, mcap: 35_000, pairAddress: B });
  });

  test('a verifiable pool type wins over a deeper unverifiable one; then the deepest', () => {
    const best = pickBestPairs([
      pair({ dexId: 'orca', pairAddress: 'ORCA', liquidity: { usd: 90_000 } }),
      pair({ dexId: 'pumpswap', pairAddress: 'PS1', liquidity: { usd: 20_000 } }),
      pair({ dexId: 'raydium', pairAddress: 'RAY', liquidity: { usd: 25_000 } }),
      pair({ dexId: 'meteora', labels: ['DLMM'], pairAddress: 'DLMM', liquidity: { usd: 500_000 } }),
      pair({ chainId: 'bsc', pairAddress: 'BSC', liquidity: { usd: 1e9 } }),
      pair({ baseToken: { address: USDC }, quoteToken: { address: A }, pairAddress: 'REV', liquidity: { usd: 1e9 } }),
    ], new Set([A]));
    expect(best.get(A)?.pairAddress).toBe('RAY');
    const dyn = pickBestPairs([pair({ dexId: 'meteora', labels: ['DYN2'], pairAddress: 'DYN', liquidity: { usd: 40_000 } }), pair({})], new Set([A]));
    expect(dyn.get(A)?.pairAddress).toBe('DYN');
  });

  test('snapshot fields (spec §4) with fdv fallback and null for missing values', () => {
    const snap = buildSnapshot(pair({ pairAddress: B }), NOW.getTime());
    expect(snap).toMatchObject({
      priceUsd: 0.0000628, mcap: 62_800, liqUsd: 23_700, liqBase: 1e8, pairAddress: B, dexId: 'pumpswap',
      ageS: 20_040, chg5m: 1.5, chg1h: -3, chg6h: 40, chg24h: 120, txns1h: 200, vol1h: 31_400, symbol: 'SENDOR', quoteMint: WSOL,
    });
    expect(snap.volOverMcap).toBeCloseTo(0.5, 9);
    const sparse = buildSnapshot(pair({ marketCap: undefined, fdv: 50_000, priceChange: { m5: 2 }, txns: { h1: { buys: 5 } }, pairCreatedAt: undefined }), NOW.getTime());
    expect(sparse.mcap).toBe(50_000);
    expect(sparse.chg6h).toBeNull();
    expect(sparse.txns1h).toBeNull();
    expect(sparse.ageS).toBeNull();
  });
});

describe('enrichment order', () => {
  test('D28: a GeckoTerminal-only row always gets the last tier; tradeable rows keep tiers 2 and 3', () => {
    const now = NOW.getTime();
    const young = now - 60_000;
    const old = now - 5 * 3_600_000;
    expect(enrichTier({ lastMs: 0, tradeable: false, inUniverse: true, firstSeenMs: young }, now)).toBe(4);
    expect(enrichTier({ lastMs: 5, tradeable: false, inUniverse: true, firstSeenMs: young }, now)).toBe(4);
    expect(enrichTier({ lastMs: 0, tradeable: true, inUniverse: false, firstSeenMs: old }, now)).toBe(2);
    expect(enrichTier({ lastMs: 5, tradeable: true, inUniverse: true, firstSeenMs: old }, now)).toBe(3);
    expect(enrichTier({ lastMs: 5, tradeable: true, inUniverse: false, firstSeenMs: young }, now)).toBe(3);
    expect(enrichTier({ lastMs: 5, tradeable: true, inUniverse: false, firstSeenMs: old }, now)).toBe(4);
  });

  test('open positions, private mints, never priced (newest first), universe, rest; least recent first', () => {
    const order = orderEnrichment([
      { mint: 'rest-old', tier: 4, firstSeenMs: 1, lastMs: 100 },
      { mint: 'uni-recent', tier: 3, firstSeenMs: 5, lastMs: 900 },
      { mint: 'uni-stale', tier: 3, firstSeenMs: 4, lastMs: 200 },
      { mint: 'new-older', tier: 2, firstSeenMs: 10, lastMs: 0 },
      { mint: 'new-newest', tier: 2, firstSeenMs: 20, lastMs: 0 },
      { mint: 'priv', tier: 1, firstSeenMs: 1, lastMs: 500 },
      { mint: 'open', tier: 0, firstSeenMs: 0, lastMs: 950 },
      { mint: 'priv', tier: 3, firstSeenMs: 1, lastMs: 500 },
    ], 10);
    expect(order).toEqual(['open', 'priv', 'new-newest', 'new-older', 'uni-stale', 'uni-recent', 'rest-old']);
    expect(orderEnrichment([{ mint: 'a', tier: 0, firstSeenMs: 0, lastMs: 0 }, { mint: 'b', tier: 1, firstSeenMs: 0, lastMs: 0 }], 1)).toEqual(['a']);
  });
});
