import { describe, expect, test } from 'bun:test';
import type { FloorArenaFilters } from '@clawville/shared';
import {
  firstTradeableSource, hasTradeableSource, pairAgeSeconds, passesFilters, rankCandidates, tradeableFirstSeenMs, volOverMcap, withinDiscoveryWindow,
  type FloorArenaFeatures,
} from './filters';

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

const OFF: FloorArenaFilters = {
  mcap_min: null, mcap_max: null, liq_min: null, liq_max: null, age_min_s: null, age_max_s: null,
  vol1h_over_mcap_min: null, vol1h_over_mcap_max: null, chg5m_min: null, chg5m_max: null, chg1h_min: null,
  chg1h_max: null, chg6h_min: null, chg6h_max: null, chg24h_min: null, chg24h_max: null, txns1h_min: null,
  txns1h_max: null, top10_max_pct: null,
};

function coin(over: Partial<FloorArenaFeatures> = {}): FloorArenaFeatures {
  return {
    priceUsd: 0.001, mcap: 100_000, liqUsd: 20_000, liqBase: 1e6, liqQuote: 100, pairAddress: 'pair', dexId: 'pumpswap',
    quoteMint: null, labels: [], pairCreatedAt: NOW - 3_600_000, ageS: 3_600, chg5m: 1, chg1h: 10, chg6h: 50, chg24h: 100,
    txns1h: 500, vol1h: 50_000, volOverMcap: 0.5, symbol: 'TEST', name: 'Test', top10Pct: 20, ...over,
  };
}

describe('passesFilters', () => {
  test('all filters off: only a positive price is required', () => {
    expect(passesFilters(coin(), OFF, NOW)).toEqual([]);
    expect(passesFilters(coin({ priceUsd: 0 }), OFF, NOW)).toEqual(['price']);
    expect(passesFilters(coin({ priceUsd: null }), OFF, NOW)).toEqual(['price']);
  });

  test('bounds are inclusive on both sides', () => {
    const f = { ...OFF, mcap_min: 100_000, mcap_max: 100_000, liq_min: 20_000, chg5m_max: 1, txns1h_min: 500 };
    expect(passesFilters(coin(), f, NOW)).toEqual([]);
    expect(passesFilters(coin({ mcap: 99_999 }), f, NOW)).toEqual(['mcap']);
    expect(passesFilters(coin({ mcap: 100_001 }), f, NOW)).toEqual(['mcap']);
    expect(passesFilters(coin({ liqUsd: 19_999 }), f, NOW)).toEqual(['liq']);
    expect(passesFilters(coin({ chg5m: 1.01 }), f, NOW)).toEqual(['chg5m_max']);
    expect(passesFilters(coin({ txns1h: 499 }), f, NOW)).toEqual(['txns']);
  });

  test('a set bound with a missing or non-finite value fails closed; an off bound ignores it', () => {
    const f = { ...OFF, chg6h_min: 680.4, chg5m_max: 41.48 };
    expect(passesFilters(coin({ chg6h: 700, chg5m: 41.48 }), f, NOW)).toEqual([]);
    expect(passesFilters(coin({ chg6h: null, chg5m: 10 }), f, NOW)).toEqual(['chg6h']);
    expect(passesFilters(coin({ chg6h: 700, chg5m: Number.NaN }), f, NOW)).toEqual(['chg5m_max']);
    expect(passesFilters(coin({ chg24h: null, txns1h: null }), f, NOW)).toEqual(['chg6h']);
  });

  test('pair age comes from pairCreatedAt at evaluation time (age / age_stale)', () => {
    const f = { ...OFF, age_min_s: 1_800, age_max_s: 21_600 };
    expect(passesFilters(coin({ pairCreatedAt: NOW - 1_800_000 }), f, NOW)).toEqual([]);
    expect(passesFilters(coin({ pairCreatedAt: NOW - 1_799_000 }), f, NOW)).toEqual(['age']);
    expect(passesFilters(coin({ pairCreatedAt: NOW - 21_601_000 }), f, NOW)).toEqual(['age_stale']);
    expect(passesFilters(coin({ pairCreatedAt: null }), f, NOW)).toEqual(['age', 'age_stale']);
    expect(pairAgeSeconds({ pairCreatedAt: NOW - 90_000, ageS: 1 }, NOW)).toBe(90);
  });

  test('vol1h / mcap uses both sides and fails closed without a positive mcap', () => {
    const f = { ...OFF, vol1h_over_mcap_min: 0.2, vol1h_over_mcap_max: 2 };
    expect(passesFilters(coin({ vol1h: 20_000 }), f, NOW)).toEqual([]);
    expect(passesFilters(coin({ vol1h: 19_000 }), f, NOW)).toEqual(['vol_ratio']);
    expect(passesFilters(coin({ vol1h: 200_001 }), f, NOW)).toEqual(['vol_ratio_max']);
    expect(passesFilters(coin({ mcap: 0 }), f, NOW)).toEqual(['vol_ratio', 'vol_ratio_max']);
    expect(volOverMcap({ vol1h: 10, mcap: null })).toBeNull();
  });

  test('every change window and txns cap has its own code', () => {
    const f = {
      ...OFF, chg5m_min: 0, chg1h_min: 5, chg1h_max: 60, chg6h_max: 40, chg24h_min: 0, chg24h_max: 90, txns1h_max: 400,
    };
    expect(passesFilters(coin({ chg5m: -1, chg1h: 61, chg6h: 41, chg24h: 91, txns1h: 401 }), f, NOW))
      .toEqual(['chg5m', 'chg1h_max', 'chg6h_max', 'chg24h_max', 'txns_max']);
    expect(passesFilters(coin({ chg1h: 4, chg24h: -1, chg6h: 10, txns1h: 10 }), f, NOW)).toEqual(['chg1h', 'chg24h']);
  });

  test('top10: a cap < 100 judges the chain-check measure; unmeasured fails as top10_unknown', () => {
    const f = { ...OFF, top10_max_pct: 30 };
    expect(passesFilters(coin({ top10Pct: 30 }), f, NOW)).toEqual([]);
    expect(passesFilters(coin({ top10Pct: 30.1 }), f, NOW)).toEqual(['top10']);
    expect(passesFilters(coin({ top10Pct: null }), f, NOW)).toEqual(['top10_unknown']);
  });

  test('top10: null or a cap >= 100 is off, even when unmeasured', () => {
    expect(passesFilters(coin({ top10Pct: null }), OFF, NOW)).toEqual([]);
    expect(passesFilters(coin({ top10Pct: null }), { ...OFF, top10_max_pct: 100 }, NOW)).toEqual([]);
    expect(passesFilters(coin({ top10Pct: 100 }), { ...OFF, top10_max_pct: 100 }, NOW)).toEqual([]);
  });

  test('Genesis wide-4 filters, as in the template', () => {
    const genesis = { ...OFF, mcap_min: 10_000, mcap_max: 250_000, liq_min: 15_000, age_min_s: 1_800, age_max_s: 21_600 };
    expect(passesFilters(coin(), genesis, NOW)).toEqual([]);
    expect(passesFilters(coin({ mcap: 300_000, liqUsd: 1_000 }), genesis, NOW)).toEqual(['mcap', 'liq']);
  });
});

describe('D25 tradeable sources', () => {
  test('a coin is tradeable only with a DexScreener or ClawPump source', () => {
    expect(hasTradeableSource(['gecko:new-pools'])).toBe(false);
    expect(hasTradeableSource(['gecko:trending_5m', 'gecko:new-pools'])).toBe(false);
    expect(hasTradeableSource(['gecko:new-pools', 'ds:token-boosts-top'])).toBe(true);
    expect(hasTradeableSource(['clawpump:anomalies'])).toBe(true);
    expect(hasTradeableSource([])).toBe(false);
  });

  test('the tradeable first sighting is the earliest recorded tradeable time; a missing time falls back to first_seen_at', () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const seen = { 'gecko:new-pools': iso(NOW - 600_000), 'ds:token-profiles': iso(NOW - 60_000), 'clawpump:signals': iso(NOW - 90_000) };
    expect(tradeableFirstSeenMs(['gecko:new-pools', 'ds:token-profiles', 'clawpump:signals'], seen, NOW - 600_000)).toBe(NOW - 90_000);
    expect(tradeableFirstSeenMs(['gecko:new-pools'], seen, NOW - 600_000)).toBeNull();
    expect(tradeableFirstSeenMs(['ds:token-boosts-top'], {}, NOW - 600_000)).toBe(NOW - 600_000);
    expect(tradeableFirstSeenMs(['ds:token-boosts-top'], null, NOW - 5)).toBe(NOW - 5);
  });

  test('the admitting tradeable source is the one with the earliest first sighting (never a gecko source)', () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const seen = { 'gecko:new-pools': iso(NOW - 600_000), 'ds:token-profiles': iso(NOW - 60_000), 'clawpump:signals': iso(NOW - 90_000) };
    expect(firstTradeableSource(['gecko:new-pools', 'ds:token-profiles', 'clawpump:signals'], seen, NOW - 600_000))
      .toEqual({ source: 'clawpump:signals', atMs: NOW - 90_000 });
    expect(firstTradeableSource(['gecko:new-pools', 'gecko:trending_5m'], seen, NOW - 600_000)).toBeNull();
    // Equal times (no recorded times: both fall back to first_seen_at): the earlier entry of sources wins.
    expect(firstTradeableSource(['ds:token-boosts-top', 'clawpump:signals'], {}, NOW - 5)).toEqual({ source: 'ds:token-boosts-top', atMs: NOW - 5 });
  });
});

describe('curve coins and the discovery window', () => {
  test('D26: a pump.fun curve coin (DexScreener liquidity 0 or absent) passes when the template sets no liq_min', () => {
    const curve = coin({ dexId: 'pumpfun', liqUsd: 0, liqBase: null, liqQuote: null, mcap: 35_000 });
    expect(passesFilters(curve, OFF, NOW)).toEqual([]);
    expect(passesFilters(coin({ dexId: 'pumpfun', liqUsd: null }), OFF, NOW)).toEqual([]);
    // A template that sets liq_min still judges it (fail closed on a missing value).
    expect(passesFilters(curve, { ...OFF, liq_min: 5_000 }, NOW)).toEqual(['liq']);
    expect(passesFilters(coin({ liqUsd: null }), { ...OFF, liq_min: 1 }, NOW)).toEqual(['liq']);
  });

  test('discovered_within_s: null = no limit; else first sight at most that old (inclusive)', () => {
    expect(withinDiscoveryWindow(NOW - 10 * 86_400_000, null, NOW)).toBe(true);
    expect(withinDiscoveryWindow(NOW - 120_000, 120, NOW)).toBe(true);
    expect(withinDiscoveryWindow(NOW - 120_001, 120, NOW)).toBe(false);
    expect(withinDiscoveryWindow(new Date(NOW - 5_000), 120, new Date(NOW))).toBe(true);
    expect(withinDiscoveryWindow(Number.NaN, 120, NOW)).toBe(false);
  });
});

describe('rankCandidates (port of paper_vars_rank)', () => {
  const item = (id: string, over: Partial<FloorArenaFeatures>) => ({ id, features: coin(over) });
  const ids = (list: Array<{ id: string }>) => list.map((x) => x.id);
  const list = [
    item('a', { vol1h: 10_000, mcap: 100_000, pairCreatedAt: NOW - 600_000, txns1h: 100 }),
    item('b', { vol1h: 90_000, mcap: 100_000, pairCreatedAt: NOW - 60_000, txns1h: 900 }),
    item('c', { vol1h: 40_000, mcap: 100_000, pairCreatedAt: NOW - 7_200_000, txns1h: null }),
    item('d', { vol1h: 40_000, mcap: 100_000, pairCreatedAt: null, txns1h: 300 }),
  ];

  test('vol_over_mcap: highest first, ties keep input order', () => {
    expect(ids(rankCandidates(list, 'vol_over_mcap', NOW))).toEqual(['b', 'c', 'd', 'a']);
  });

  test('newest / oldest by pair age, unknown age last', () => {
    expect(ids(rankCandidates(list, 'newest', NOW))).toEqual(['b', 'a', 'c', 'd']);
    expect(ids(rankCandidates(list, 'oldest', NOW))).toEqual(['c', 'a', 'b', 'd']);
  });

  test('txns1h: highest first, missing last', () => {
    expect(ids(rankCandidates(list, 'txns1h', NOW))).toEqual(['b', 'd', 'a', 'c']);
  });

  test('lowest_vol_over_mcap: lowest usable ratio first; zero ratio counts as missing', () => {
    const withZero = [...list, item('e', { vol1h: 0, mcap: 100_000 })];
    expect(ids(rankCandidates(withZero, 'lowest_vol_over_mcap', NOW))).toEqual(['a', 'c', 'd', 'b', 'e']);
  });

  test('mid_vol_over_mcap: closest to the geometric middle; 1 and 4 equally far from 2 keep base order', () => {
    const geo = [
      item('x1', { vol1h: 1, mcap: 1 }), item('x4', { vol1h: 4, mcap: 1 }), item('x2', { vol1h: 2, mcap: 1 }),
      item('none', { vol1h: 5, mcap: 0 }),
    ];
    // ratios 1, 4, 2: mean of logs = ln 2; |ln1-ln2| = |ln4-ln2|, so x4 (higher base key) precedes x1.
    expect(ids(rankCandidates(geo, 'mid_vol_over_mcap', NOW))).toEqual(['x2', 'x4', 'x1', 'none']);
    const noneUsable = [item('p', { mcap: null }), item('q', { vol1h: null })];
    expect(ids(rankCandidates(noneUsable, 'mid_vol_over_mcap', NOW))).toEqual(['p', 'q']);
  });

  test('does not mutate the input list', () => {
    const copy = ids(list);
    rankCandidates(list, 'newest', NOW);
    expect(ids(list)).toEqual(copy);
  });
});
