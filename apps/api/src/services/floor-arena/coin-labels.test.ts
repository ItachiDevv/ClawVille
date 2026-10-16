import { describe, expect, test } from 'bun:test';
import { ARENA_QUOTE_SLIPPAGE_BPS, evaluateBuyQuote, markFallbackProceeds, USDC_MINT, usdToRawUsdc } from './pricing';
import {
  classifyFate, COMMON_EXIT, commonEntryTokens, deriveLabel, LABEL_ANCHOR_MAX_LAG_MS, LABEL_H24_S, LABEL_H6_S, markoutAt, ownCallSlots,
  planAnchor, sampleNeed, shouldRecord, simulateCommonExit, type DiscoveryRowLite, type PathPoint,
} from './coin-labels';

const COSTS = { buy_haircut_pct: 1.0, sell_haircut_pct: 0.5, mark_fallback_pool_fee_pct: 1.25 };
/** Pool fee (1.25 %) then buy haircut (1.0 %): what a real quote entry keeps. */
const KEEP = (1 - 1.25 / 100) * (1 - 1.0 / 100);
const SELL = 1 - 1.75 / 100;

describe('classifyFate', () => {
  test('rug wins even without a 24 h point', () => {
    expect(classifyFate({ min24h: 0.2, max24h: 3, mult24h: null })).toBe('rug');
    expect(classifyFate({ min24h: 0.05, max24h: 5, mult24h: 4 })).toBe('rug');
  });
  test('runner needs >= 2x, no rug, and a 24 h point', () => {
    expect(classifyFate({ min24h: 0.5, max24h: 2, mult24h: 0.6 })).toBe('runner');
    expect(classifyFate({ min24h: 0.5, max24h: 2.5, mult24h: null })).toBe('unknown');
  });
  test('bleed and flat', () => {
    expect(classifyFate({ min24h: 0.4, max24h: 1.5, mult24h: 0.7 })).toBe('bleed');
    expect(classifyFate({ min24h: 0.4, max24h: 1.5, mult24h: 0.71 })).toBe('flat');
    expect(classifyFate({ min24h: null, max24h: null, mult24h: null })).toBe('unknown');
  });
});

describe('simulateCommonExit', () => {
  test('take profit at the first point whose engine multiple reaches 1.2 (fill at the sampled price)', () => {
    // engine multiple = mult * KEEP; 1.25 * 0.977625 = 1.2220 >= 1.2
    const path: PathPoint[] = [[0, 1], [60, 1.1], [120, 1.25], [180, 0.5]];
    const r = simulateCommonExit(path, COSTS)!;
    expect(r.reason).toBe('tp');
    expect(r.atS).toBe(120);
    expect(r.pnlUsd).toBeCloseTo(20 * KEEP * 1.25 * SELL - 20, 9);
  });
  test('1.22x is not a take profit after the entry costs (1.22 * 0.977625 < 1.2)', () => {
    const r = simulateCommonExit([[0, 1], [60, 1.22], [3_600, 1.0]], COSTS)!;
    expect(r.reason).toBe('time');
    expect(r.pnlUsd).toBeCloseTo(20 * KEEP * 1.0 * SELL - 20, 9);
  });
  test('a gap through the stop books the gap price', () => {
    const r = simulateCommonExit([[0, 1], [60, 0.9], [120, 0.3]], COSTS)!;
    expect(r.reason).toBe('stop');
    expect(r.mult).toBe(0.3);
    expect(r.pnlUsd).toBeCloseTo(20 * KEEP * 0.3 * SELL - 20, 9);
  });
  test('time exit at the first point at or after 60 min, within the tolerance', () => {
    expect(simulateCommonExit([[0, 1], [3_590, 1.05], [3_650, 1.1]], COSTS)!.atS).toBe(3_650);
    expect(simulateCommonExit([[0, 1], [600, 1.0], [3_600 + COMMON_EXIT.timeTolS + 1, 1.0]], COSTS)).toBeNull();
  });
  test('a flat path costs exactly an engine round trip (quote entry with the pool fee, D4 mark exit)', () => {
    const mint = 'So1aNaMintAddre55So1aNaMintAddre55abcdEFGH';
    for (const price of [1, 0.00002137, 3.5]) {
      // What a venue quote returns for $20 at a DexScreener mid price: the pool fee is inside its token output.
      const quotedTokens = (20 / price) * (1 - COSTS.mark_fallback_pool_fee_pct / 100);
      const amountRaw = usdToRawUsdc(20);
      const fill = evaluateBuyQuote({
        status: 'quoted', slippageBps: ARENA_QUOTE_SLIPPAGE_BPS, priceImpactPct: '0',
        input: { mint: USDC_MINT, amount: '20', rawAmount: amountRaw, decimals: 6 },
        output: { mint, amount: String(quotedTokens), rawAmount: '1', decimals: 6 },
      }, { mint, usd: 20, amountRaw, slippageBps: ARENA_QUOTE_SLIPPAGE_BPS, dsPriceUsd: price }, COSTS);
      if (!fill.ok) throw new Error(`quote refused: ${fill.reason}`);
      expect(commonEntryTokens(20, price, COSTS)).toBeCloseTo(fill.tokens, 6);
      const engineRoundTrip = markFallbackProceeds(fill.tokens, price, COSTS) - 20;
      const r = simulateCommonExit([[0, 1], [3_600, 1]], COSTS)!;
      expect(r.reason).toBe('time');
      expect(r.pnlUsd).toBeCloseTo(engineRoundTrip, 9);
    }
    // About -$0.78 on $20: 1.25 % + 1.0 % in, 0.5 % + 1.25 % out.
    expect(simulateCommonExit([[0, 1], [3_600, 1]], COSTS)!.pnlUsd).toBeCloseTo(20 * KEEP * SELL - 20, 9);
  });
  test('no exit point -> null', () => {
    expect(simulateCommonExit([[0, 1]], COSTS)).toBeNull();
    expect(simulateCommonExit([[0, 1], [60, 1.05]], COSTS)).toBeNull();
  });
});

describe('sampling schedule', () => {
  test('one point per minute for the first hour', () => {
    expect(sampleNeed([[0, 1]], 30)).toBeNull();
    expect(sampleNeed([[0, 1]], 56)).toBe('minute');
    expect(sampleNeed([[0, 1], [60, 1]], 100)).toBeNull();
    expect(sampleNeed([[0, 1], [3_550, 1]], 3_610)).toBe('minute');
  });
  test('nothing between 61 min and 6 h, then the 6 h and 24 h checkpoints', () => {
    const path: PathPoint[] = [[0, 1], [3_600, 1]];
    expect(sampleNeed(path, 2 * 3_600)).toBeNull();
    expect(sampleNeed(path, LABEL_H6_S + 10)).toBe('h6');
    expect(sampleNeed([...path, [LABEL_H6_S + 5, 1]], LABEL_H6_S + 70)).toBeNull();
    expect(sampleNeed([...path, [LABEL_H6_S + 5, 1]], LABEL_H24_S + 1)).toBe('h24');
    expect(sampleNeed([...path, [LABEL_H24_S + 1, 1]], LABEL_H24_S + 70)).toBeNull();
  });
  test('free observations: every due point, else one per 15-min bucket after the first hour', () => {
    const path: PathPoint[] = [[0, 1], [3_600, 1]];
    expect(shouldRecord(path, 3_700, 3_700)).toBe(false); // same bucket (3600/900 = 4 = 3700/900 floor)
    expect(shouldRecord(path, 4_500, 4_510)).toBe(true);
    expect(shouldRecord(path, 3_500, 4_510)).toBe(false); // not after the last point
    expect(shouldRecord([[0, 1]], 58, 60)).toBe(true);
    expect(shouldRecord([[0, 1]], 30, 30)).toBe(false);
  });
  test('own calls never take the pollers reserve', () => {
    expect(ownCallSlots(8, 8, 2)).toBe(0);
    expect(ownCallSlots(9, 8, 2)).toBe(1);
    expect(ownCallSlots(100, 8, 2)).toBe(2);
    expect(ownCallSlots(0, 8, 2)).toBe(0);
  });
});

describe('markouts and derived columns', () => {
  test('markoutAt takes the nearest point within the tolerance', () => {
    const path: PathPoint[] = [[0, 1], [280, 1.1], [330, 1.2]];
    expect(markoutAt(path, 300, 120)).toBe(1.1);
    expect(markoutAt(path, 900, 120)).toBeNull();
  });
  test('deriveLabel: 60-min extremes, 24 h done and fate', () => {
    const path: PathPoint[] = [[0, 1], [60, 1.5], [120, 0.6], [300, 1.0], [3_600, 0.9], [LABEL_H6_S, 2.4], [LABEL_H24_S + 30, 0.5]];
    const d = deriveLabel(path, LABEL_H24_S + 60);
    expect(d.maxMult60m).toBe(1.5);
    expect(d.maxMult60mAtS).toBe(60);
    expect(d.minMult60m).toBe(0.6);
    expect(d.minMult60mAtS).toBe(120);
    expect(d.mult5m).toBe(1.0);
    expect(d.mult60m).toBe(0.9);
    expect(d.mult6h).toBe(2.4);
    expect(d.mult24h).toBe(0.5);
    expect(d.done).toBe(true);
    expect(d.fate24h).toBe('runner');
    expect(d.commonExit?.reason).toBe('tp');
  });
  test('an open label keeps fate unknown; a label past 26 h without a 24 h point is done and unknown', () => {
    expect(deriveLabel([[0, 1], [60, 3]], 120).fate24h).toBe('unknown');
    const late = deriveLabel([[0, 1], [60, 1.1]], LABEL_H24_S + 2 * 3_600);
    expect(late.done).toBe(true);
    expect(late.fate24h).toBe('unknown');
  });
});

describe('planAnchor', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const snap = (price: number) => ({ priceUsd: price, mcap: 1e5, liqUsd: 2e4, pairAddress: 'P', chg5m: 1 }) as never;
  const base = (over: Partial<DiscoveryRowLite>): DiscoveryRowLite => ({
    mint: 'So1aNaMintAddre55So1aNaMintAddre55abcdEFGH', firstSeenAtMs: now - 600_000, firstSource: 'ds:token-profiles',
    sources: ['ds:token-profiles'], sourceFirstSeen: { 'ds:token-profiles': new Date(now - 600_000).toISOString() },
    snapshot: snap(2), snapshotAtMs: now - 10_000, firstSnapshot: snap(1), firstSnapshotAtMs: now - 580_000,
    chainVerdict: null, chainCheckedAtMs: null, ...over,
  });
  test('uses the first snapshot when it was taken after the tradeable sighting', () => {
    const p = planAnchor(base({}), now)!;
    expect(p.priceUsd).toBe(1);
    expect(p.anchorAtMs).toBe(now - 580_000);
    expect(p.episodeAtMs).toBe(now - 600_000);
    expect(p.features.chainVerdict).toBe('pending');
    expect(p.features.tradeableSource).toBe('ds:token-profiles');
  });
  test('a GeckoTerminal-first coin anchors at the current snapshot', () => {
    const p = planAnchor(base({
      firstSeenAtMs: now - 3_600_000, firstSource: 'gecko:new-pools', sources: ['gecko:new-pools', 'ds:token-profiles'],
      sourceFirstSeen: { 'gecko:new-pools': new Date(now - 3_600_000).toISOString(), 'ds:token-profiles': new Date(now - 60_000).toISOString() },
      firstSnapshotAtMs: now - 3_500_000,
    }), now)!;
    expect(p.priceUsd).toBe(2);
    expect(p.episodeAtMs).toBe(now - 60_000);
  });
  test('no label for a non-tradeable coin or one first seen tradeable too long ago', () => {
    expect(planAnchor(base({ sources: ['gecko:new-pools'], sourceFirstSeen: {} }), now)).toBeNull();
    const old = now - LABEL_ANCHOR_MAX_LAG_MS - 1;
    expect(planAnchor(base({ sourceFirstSeen: { 'ds:token-profiles': new Date(old).toISOString() } }), now)).toBeNull();
  });
});

describe('pruneCoinLabels', () => {
  test('deletes in bounded batches until a short batch', async () => {
    const sizes = [2, 2, 1, 2];
    let statements = 0;
    const database = { execute: async () => { statements += 1; return Array.from({ length: sizes.shift() ?? 0 }, () => ({ '?column?': 1 })); } };
    const { pruneCoinLabels } = await import('./coin-labels');
    expect(await pruneCoinLabels(new Date(), database as never, { batch: 2, maxBatches: 10 })).toBe(5);
    expect(statements).toBe(3);
  });
});
