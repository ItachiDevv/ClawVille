import { afterEach, describe, expect, test } from 'bun:test';
import {
  arenaFetchJson, ArenaHttpError, clawpumpQuoteBreakerState, dexscreenerBudgetLeft, evaluateBuyQuote,
  evaluateSellQuote, markFallbackProceeds, noteDexscreenerCall, noteDexscreenerRateLimited, quoteBuy, quoteSell,
  resetPricingStateForTest, tokensToRaw, usdToRawUsdc, USDC_MINT,
} from './pricing';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const COSTS = { buy_haircut_pct: 2.5, sell_haircut_pct: 1.0 };
const ENV = { CLAWPUMP_API_KEY: 'test-key' };

// Shape copied from a live ClawPump backend quote (2026-09-30, USDC -> BONK, $20, 300 bps).
function buyQuote(over: Record<string, unknown> = {}) {
  return {
    status: 'quoted', venue: 'jupiter', swapMode: 'ExactIn',
    input: { token: 'USDC', mint: USDC_MINT, amount: '20', rawAmount: '20000000', decimals: 6 },
    output: { token: 'BONK', mint: MINT, amount: '1000000', rawAmount: '100000000000', decimals: 5 },
    slippageBps: 300, priceImpactPct: '0.001', route: ['Flux'], otherAmountThreshold: '970000', platformFee: null,
    ...over,
  };
}
const BUY_REQ = { mint: MINT, usd: 20, amountRaw: '20000000', slippageBps: 300, dsPriceUsd: 0.00002 };

afterEach(() => resetPricingStateForTest());

describe('evaluateBuyQuote (paper runner quote_refusal + fill model)', () => {
  test('fill: 2.5% haircut on tokens, entry price = usd / booked tokens', () => {
    const r = evaluateBuyQuote(buyQuote(), BUY_REQ, COSTS);
    if (!r.ok) throw new Error(r.reason);
    expect(r.quotedTokens).toBe(1_000_000);
    expect(r.tokens).toBeCloseTo(975_000, 6);
    expect(r.entryPriceUsd).toBeCloseTo(20 / 975_000, 12);
    expect(r.impactPct).toBeCloseTo(0.1, 9);
    expect(r.driftPct).toBeCloseTo(0, 9);
    expect(r.decimals).toBe(5);
  });

  test('priceImpactPct is a FRACTION: 0.03 passes (3%), 0.0301 refuses', () => {
    expect(evaluateBuyQuote(buyQuote({ priceImpactPct: '0.03' }), BUY_REQ, COSTS).ok).toBe(true);
    const r = evaluateBuyQuote(buyQuote({ priceImpactPct: '0.0301' }), BUY_REQ, COSTS);
    expect(r).toEqual({ ok: false, reason: 'impact', detail: '3.01%' });
    expect(evaluateBuyQuote(buyQuote({ priceImpactPct: '-0.05' }), BUY_REQ, COSTS)).toMatchObject({ ok: false, reason: 'impact' });
  });

  test('missing / non-finite impact refuses (NaN must never pass)', () => {
    expect(evaluateBuyQuote(buyQuote({ priceImpactPct: 'NaN' }), BUY_REQ, COSTS)).toMatchObject({ reason: 'impact_unknown' });
    expect(evaluateBuyQuote(buyQuote({ priceImpactPct: null }), BUY_REQ, COSTS)).toMatchObject({ reason: 'impact_unknown' });
  });

  test('drift over 35% either way refuses; no DexScreener price refuses', () => {
    // 1,000,000 tokens x $0.000013 = $13 vs $20 -> drift +35.0% (passes); $0.0000129 -> 35.5% (refuses)
    expect(evaluateBuyQuote(buyQuote(), { ...BUY_REQ, dsPriceUsd: 0.000013 }, COSTS).ok).toBe(true);
    expect(evaluateBuyQuote(buyQuote(), { ...BUY_REQ, dsPriceUsd: 0.0000129 }, COSTS)).toMatchObject({ reason: 'drift' });
    expect(evaluateBuyQuote(buyQuote(), { ...BUY_REQ, dsPriceUsd: 0.0000271 }, COSTS)).toMatchObject({ reason: 'drift' });
    expect(evaluateBuyQuote(buyQuote(), { ...BUY_REQ, dsPriceUsd: null }, COSTS)).toMatchObject({ reason: 'drift_unknown' });
  });

  test('echo checks: amount, slippage, input and output mints', () => {
    expect(evaluateBuyQuote(buyQuote({ slippageBps: 100 }), BUY_REQ, COSTS)).toMatchObject({ reason: 'quote_echo_mismatch' });
    expect(evaluateBuyQuote(buyQuote({ input: { mint: USDC_MINT, amount: '2', rawAmount: '2000000', decimals: 6 } }), BUY_REQ, COSTS))
      .toMatchObject({ reason: 'quote_echo_mismatch' });
    expect(evaluateBuyQuote(buyQuote({ output: { mint: USDC_MINT, amount: '1', rawAmount: '1', decimals: 6 } }), BUY_REQ, COSTS))
      .toMatchObject({ reason: 'quote_echo_mismatch' });
  });

  test('status other than quoted, bad schema and zero output refuse', () => {
    expect(evaluateBuyQuote(buyQuote({ status: 'error' }), BUY_REQ, COSTS)).toMatchObject({ reason: 'quote_failed' });
    expect(evaluateBuyQuote({ nope: true }, BUY_REQ, COSTS)).toMatchObject({ reason: 'quote_failed' });
    expect(evaluateBuyQuote(buyQuote({ output: { mint: MINT, amount: '0', rawAmount: '0', decimals: 5 } }), BUY_REQ, COSTS))
      .toMatchObject({ reason: 'quote_output_bad' });
  });
});

describe('evaluateSellQuote and the mark fallback', () => {
  function sellQuote(usd: string, over: Record<string, unknown> = {}) {
    return {
      status: 'quoted', input: { mint: MINT, amount: '975000', rawAmount: '97500000000', decimals: 5 },
      output: { mint: USDC_MINT, amount: usd, rawAmount: String(Math.round(Number(usd) * 1e6)), decimals: 6 },
      slippageBps: 300, priceImpactPct: '0.2', ...over,
    };
  }
  const REQ = { mint: MINT, tokens: 975_000, amountRaw: '97500000000', markPriceUsd: 0.000022 as number | null, referencePriceUsd: null as number | null };

  test('proceeds = quoted USD minus 1%; no impact gate on exits', () => {
    const r = evaluateSellQuote(sellQuote('22'), REQ, COSTS);
    if (!r.ok) throw new Error(r.reason);
    expect(r.quotedUsd).toBe(22);
    expect(r.proceedsUsd).toBeCloseTo(21.78, 9);
    expect(r.priceUsd).toBeCloseTo(22 / 975_000, 12);
  });

  test('a quote under 0.5x a FRESH mark is a quote failure (Codex r2 #5); exactly 0.5x passes', () => {
    // mark value = 975,000 x 0.000022 = $21.45; half = $10.725
    expect(evaluateSellQuote(sellQuote('0.05'), REQ, COSTS)).toMatchObject({ ok: false, reason: 'quote_far_below_mark' });
    expect(evaluateSellQuote(sellQuote('10.72'), REQ, COSTS)).toMatchObject({ ok: false, reason: 'quote_far_below_mark' });
    expect(evaluateSellQuote(sellQuote('10.725'), REQ, COSTS).ok).toBe(true);
  });

  test('no fresh mark: a quote under 0.5x the reference fails but carries its fill (Codex r3 #5)', () => {
    // reference 0.00002 -> half = 0.00001 per token = $9.75 for 975,000 tokens
    const low = evaluateSellQuote(sellQuote('0.05'), { ...REQ, markPriceUsd: null, referencePriceUsd: 0.00002 }, COSTS);
    expect(low).toMatchObject({ ok: false, reason: 'quote_far_below_reference' });
    if (low.ok || !low.fill) throw new Error('expected a carried fill');
    expect(low.fill.quotedUsd).toBe(0.05);
    expect(low.fill.proceedsUsd).toBeCloseTo(0.0495, 9);
    expect(evaluateSellQuote(sellQuote('9.75'), { ...REQ, markPriceUsd: null, referencePriceUsd: 0.00002 }, COSTS).ok).toBe(true);
    // The above-mark rule needs a fresh mark: with only a reference a high quote stands.
    expect(evaluateSellQuote(sellQuote('90'), { ...REQ, markPriceUsd: null, referencePriceUsd: 0.00002 }, COSTS).ok).toBe(true);
  });

  test('no mark and no reference: the quote stands; a fresh mark ignores the reference', () => {
    expect(evaluateSellQuote(sellQuote('0.05'), { ...REQ, markPriceUsd: null, referencePriceUsd: null }, COSTS))
      .toMatchObject({ ok: true, quotedUsd: 0.05 });
    const withMark = evaluateSellQuote(sellQuote('0.05'), { ...REQ, referencePriceUsd: 1 }, COSTS);
    expect(withMark).toMatchObject({ ok: false, reason: 'quote_far_below_mark' });
    expect((withMark as { fill?: unknown }).fill).toBeUndefined();
  });

  test('a quote more than 35% ABOVE the mark refuses (contest integrity)', () => {
    // mark value = 975,000 x 0.000022 = $21.45; 1.35x = $28.9575
    expect(evaluateSellQuote(sellQuote('28.95'), REQ, COSTS).ok).toBe(true);
    expect(evaluateSellQuote(sellQuote('29'), REQ, COSTS)).toMatchObject({ ok: false, reason: 'drift' });
    expect(evaluateSellQuote(sellQuote('29'), { ...REQ, markPriceUsd: null }, COSTS).ok).toBe(true);
  });

  test('echo and output checks', () => {
    expect(evaluateSellQuote(sellQuote('22', { input: { mint: MINT, amount: '1', rawAmount: '1', decimals: 5 } }), REQ, COSTS))
      .toMatchObject({ reason: 'quote_echo_mismatch' });
    expect(evaluateSellQuote(sellQuote('0'), REQ, COSTS)).toMatchObject({ reason: 'quote_output_bad' });
    expect(evaluateSellQuote(sellQuote('22', { status: 'failed' }), REQ, COSTS)).toMatchObject({ reason: 'quote_failed' });
  });

  test('mark fallback = tokens x mark x (1 - 1%), never negative', () => {
    expect(markFallbackProceeds(975_000, 0.00002, COSTS)).toBeCloseTo(19.305, 9);
    expect(markFallbackProceeds(975_000, 0, COSTS)).toBe(0);
    expect(markFallbackProceeds(Number.NaN, 1, COSTS)).toBe(0);
  });
});

describe('unit conversions', () => {
  test('USD to raw USDC and token UI amount to raw units', () => {
    expect(usdToRawUsdc(20)).toBe('20000000');
    expect(tokensToRaw(975_000, 5)).toBe('97500000000');
    expect(tokensToRaw(0.4, 0)).toBeNull();
    expect(tokensToRaw(1e12, 9)).toBe('1000000000000000000000');
    expect(tokensToRaw(1, 19)).toBeNull();
  });
});

describe('ClawPump calls (fake fetch, never the network)', () => {
  function fakeFetch(bodies: unknown[], seen: Array<{ url: string; init: RequestInit }> = []) {
    return (async (url: URL | string, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      const body = bodies.shift();
      if (body instanceof Error) throw body;
      if (typeof body === 'number') return new Response('{}', { status: body });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  }

  test('quoteBuy posts the documented body with the Bearer key to the allowlisted host', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const r = await quoteBuy(MINT, 20, 0.00002, { fetchImpl: fakeFetch([buyQuote()], seen), env: ENV, nowMs: 1_000 });
    expect(r.ok).toBe(true);
    expect(seen[0]!.url).toBe('https://ai-agents-production-6ca0.up.railway.app/swap/quote');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ input_mint: USDC_MINT, output_mint: MINT, amount: '20000000', slippage_bps: 300 });
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });

  test('the same $20 quote is shared for 10 s', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = fakeFetch([buyQuote(), buyQuote()], seen);
    await quoteBuy(MINT, 20, 0.00002, { fetchImpl: f, env: ENV, nowMs: 1_000 });
    await quoteBuy(MINT, 20, 0.00002, { fetchImpl: f, env: ENV, nowMs: 9_000 });
    expect(seen.length).toBe(1);
    await quoteBuy(MINT, 20, 0.00002, { fetchImpl: f, env: ENV, nowMs: 12_000 });
    expect(seen.length).toBe(2);
  });

  test('no key: not_configured without any call', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const r = await quoteBuy(MINT, 20, 0.00002, { fetchImpl: fakeFetch([], seen), env: {}, nowMs: 1 });
    expect(r).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(seen.length).toBe(0);
  });

  test('breaker: 5 failed calls in a row pause buy quotes for 60 s', async () => {
    const f = fakeFetch([500, 500, 500, 500, 500]);
    const mints = ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => `${c}${MINT.slice(1)}`);
    for (let i = 0; i < 5; i += 1) {
      const r = await quoteBuy(mints[i]!, 20, 0.00002, { fetchImpl: f, env: ENV, nowMs: 100_000 + i });
      expect(r).toMatchObject({ ok: false, reason: 'quote_failed' });
    }
    expect(clawpumpQuoteBreakerState(100_010).open).toBe(true);
    // A mint not in the 10 s cache hits the open breaker without a call.
    expect(await quoteBuy(mints[5]!, 20, 0.00002, { fetchImpl: f, env: ENV, nowMs: 100_010 })).toMatchObject({ reason: 'quote_breaker' });
    expect(clawpumpQuoteBreakerState(170_005).open).toBe(false);
  });

  test('quoteSell sends raw token units and USDC as output', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const body = {
      status: 'quoted', input: { mint: MINT, amount: '975000', rawAmount: '97500000000', decimals: 5 },
      output: { mint: USDC_MINT, amount: '21', rawAmount: '21000000', decimals: 6 }, slippageBps: 300, priceImpactPct: '0.01',
    };
    const r = await quoteSell(MINT, 975_000, 5, { markPriceUsd: 0.00002, referencePriceUsd: null }, { fetchImpl: fakeFetch([body], seen), env: ENV });
    expect(r).toMatchObject({ ok: true, quotedUsd: 21 });
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ input_mint: MINT, output_mint: USDC_MINT, amount: '97500000000', slippage_bps: 300 });
  });
});

describe('outbound allowlist and DexScreener budget', () => {
  test('hosts outside the allowlist are refused before any request', async () => {
    let called = false;
    const f = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
    await expect(arenaFetchJson(new URL('https://evil.example.com/x'), {}, f)).rejects.toBeInstanceOf(ArenaHttpError);
    await expect(arenaFetchJson(new URL('http://api.dexscreener.com/x'), {}, f)).rejects.toBeInstanceOf(ArenaHttpError);
    expect(called).toBe(false);
    await expect(arenaFetchJson(new URL('https://api.geckoterminal.com/api/v2/x'), {}, f)).resolves.toEqual({});
  });

  test('a 429 maps to rate_limited', async () => {
    const f = (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
    await expect(arenaFetchJson(new URL('https://api.dexscreener.com/x'), {}, f)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  test('sliding one-minute budget and 30 s block after a 429', () => {
    for (let i = 0; i < 10; i += 1) noteDexscreenerCall(1_000 + i);
    expect(dexscreenerBudgetLeft(2_000, 12)).toBe(2);
    expect(dexscreenerBudgetLeft(61_500, 12)).toBe(12);
    noteDexscreenerRateLimited(100_000);
    expect(dexscreenerBudgetLeft(129_999, 12)).toBe(0);
    expect(dexscreenerBudgetLeft(130_000, 12)).toBe(12);
  });
});
