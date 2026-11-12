import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { floorArenaPositions } from '@clawville/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { FLOOR_ARENA_DEEP_LOW_OF_MARK, type FloorArenaExits, type FloorArenaFilters, type FloorArenaParams } from '@clawville/shared';
import {
  advanceExitRun, applyExitFill, chainCheckCandidateMints, runToKeepAfterRejectedBooking, resetExitTrigger, classifyExitAttempt, combineFillSource, d4AfterFailedQuote, d4Decision,decideExitTrigger, entrySummary, entryVia, evaluateAgentCandidates,
  ENTRY_STATEMENT_TIMEOUT_MS, ENTRY_TX_TIMEOUT_MS, exitSummary, freshBookingAllowed, insertTimeGate, keepNewerMark, openPosition,
  tryOpenPosition, markNewerThanDecision, markStillFresh, newestKnownMark, parseExitRun,
  quoteDisputesMark, quotedTpMultiple, tpConfirmedByQuote, tpSkipRunUpdate, type D4Outcome,
  topFailCodes, tpHitsFromRemaining, type ArenaCandidate, type ExitState,
  breakevenMarkMult, liquidityBelow, liquidityShadowCrossings, LIQ_SHADOW_THRESHOLDS, recordLiquidityShadow,
  type ExitLiquidity, type ExitTrigger, type LiqShadowDeps,
} from './engine';
import { DEFAULT_PAPER_COSTS, evaluateSellQuote, markFallbackProceeds, tokensToRaw, USDC_MINT, type SellQuoteResult } from './pricing';
import type { ArenaEventInput } from './events';
import { ARENA_CONTEST_FINAL_GRACE_MS } from './contest';
import type { FloorArenaFeatures } from './filters';

const T0 = Date.UTC(2026, 8, 30, 22, 0, 0);

function state(over: Partial<ExitState> = {}): ExitState {
  return { entryPriceUsd: 0.001, tokens: 20_000, sizeUsd: 20, openedAtMs: T0, peakMult: 1, remainingFraction: 1, realisedUsd: 0, ...over };
}

function exits(over: Partial<FloorArenaExits> = {}): FloorArenaExits {
  return { tp: [], stop_mult: null, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 900, ...over };
}

describe('exit trigger state machine', () => {
  test('two TP legs fire one per tick as partial fractions of the ORIGINAL position', () => {
    const ex = exits({ tp: [[1.2, 0.5], [1.5, 0.5]] });
    let s = state();
    expect(decideExitTrigger(s, ex, 1.19, T0 + 1_000)).toBeNull();
    const leg1 = decideExitTrigger(s, ex, 1.6, T0 + 1_000);
    expect(leg1).toEqual({ reason: 'tp', fraction: 0.5, leg: 1 });
    const fill1 = applyExitFill(s, leg1!, 11.88);
    expect(fill1).toEqual({ remainingFraction: 0.5, realisedUsd: 11.88, closed: false, pnlUsd: null, pnlMult: null });
    s = { ...s, remainingFraction: fill1.remainingFraction, realisedUsd: fill1.realisedUsd, peakMult: 1.6 };
    expect(tpHitsFromRemaining(s.remainingFraction, ex.tp)).toBe(1);
    const leg2 = decideExitTrigger(s, ex, 1.55, T0 + 11_000);
    expect(leg2).toEqual({ reason: 'tp', fraction: 0.5, leg: 2 });
    const fill2 = applyExitFill(s, leg2!, 15.3);
    expect(fill2.closed).toBe(true);
    expect(fill2.remainingFraction).toBe(0);
    expect(fill2.pnlUsd).toBeCloseTo(7.18, 9);
    expect(fill2.pnlMult).toBeCloseTo(27.18 / 20, 9);
  });

  test('legs that leave a remainder: after the last leg only stop / trail / time can close', () => {
    const ex = exits({ tp: [[1.1, 0.3], [1.3, 0.3]], stop_mult: 0.9 });
    const s = state({ remainingFraction: 0.4, realisedUsd: 14 });
    expect(tpHitsFromRemaining(0.4, ex.tp)).toBe(2);
    expect(tpHitsFromRemaining(0.39999999999999997, ex.tp)).toBe(2);
    expect(decideExitTrigger(s, ex, 2, T0 + 1_000)).toBeNull();
    expect(decideExitTrigger(s, ex, 0.9, T0 + 1_000)).toEqual({ reason: 'stop', fraction: 0.4, leg: null });
  });

  test('stop fires at or below stop_mult on the mark', () => {
    const ex = exits({ tp: [[1.08, 1]], stop_mult: 0.9 });
    expect(decideExitTrigger(state(), ex, 0.91, T0 + 1_000)).toBeNull();
    expect(decideExitTrigger(state(), ex, 0.9, T0 + 1_000)).toEqual({ reason: 'stop', fraction: 1, leg: null });
  });

  test('trail arms once the peak reaches trail_arm_mult, then exits at peak x (1 - trail)', () => {
    const ex = exits({ trail_from_peak: 0.12, trail_arm_mult: 1.1 });
    // Not armed: peak 1.05 < 1.10, a drop to 0.9 does nothing.
    expect(decideExitTrigger(state({ peakMult: 1.05 }), ex, 0.9, T0 + 1_000)).toBeNull();
    // Armed by this very mark (peak = max(peak, mark)); no exit at the peak itself.
    expect(decideExitTrigger(state({ peakMult: 1 }), ex, 1.1, T0 + 1_000)).toBeNull();
    // Armed at 1.5: exit level 1.32.
    expect(decideExitTrigger(state({ peakMult: 1.5 }), ex, 1.33, T0 + 1_000)).toBeNull();
    expect(decideExitTrigger(state({ peakMult: 1.5 }), ex, 1.32, T0 + 1_000)).toEqual({ reason: 'trail', fraction: 1, leg: null });
  });

  test('a trail with no arm multiple is armed from entry', () => {
    const ex = exits({ trail_from_peak: 0.2 });
    expect(decideExitTrigger(state(), ex, 0.81, T0 + 1_000)).toBeNull();
    expect(decideExitTrigger(state(), ex, 0.8, T0 + 1_000)).toEqual({ reason: 'trail', fraction: 1, leg: null });
  });

  test('time cap closes the remainder, with or without a mark', () => {
    const ex = exits({ tp: [[1.1, 1]], max_hold_s: 900 });
    expect(decideExitTrigger(state(), ex, 1.0, T0 + 899_999)).toBeNull();
    expect(decideExitTrigger(state(), ex, 1.0, T0 + 900_000)).toEqual({ reason: 'time', fraction: 1, leg: null });
    expect(decideExitTrigger(state(), ex, null, T0 + 900_000)).toEqual({ reason: 'time', fraction: 1, leg: null });
    expect(decideExitTrigger(state(), ex, null, T0 + 10_000)).toBeNull();
  });

  test('TP wins over the time cap in the same tick (lead order: tp, stop, trail, time)', () => {
    const ex = exits({ tp: [[1.1, 1]], max_hold_s: 60 });
    expect(decideExitTrigger(state(), ex, 1.2, T0 + 120_000)).toEqual({ reason: 'tp', fraction: 1, leg: 1 });
  });
});

describe('phase 3b exits: breakeven stop and liquidity drop', () => {
  const BE = 1 / (1 - 0.0175);
  const liq = (entryUsd: number | null, nowUsd: number | null): ExitLiquidity => ({ entryUsd, nowUsd });

  test('breakeven level = 1 / (1 - (sell haircut + pool fee)), and a full sell there nets ~$0', () => {
    expect(breakevenMarkMult()).toBeCloseTo(BE, 12);
    expect(breakevenMarkMult({ buy_haircut_pct: 1, sell_haircut_pct: 0.5, mark_fallback_pool_fee_pct: 0 })).toBeCloseTo(1 / 0.995, 12);
    // entry price already holds the buy haircut: tokens x entry = size; a mark-fallback sell at the level returns size.
    const s = state();
    const proceeds = markFallbackProceeds(s.tokens, s.entryPriceUsd * breakevenMarkMult());
    expect(proceeds).toBeCloseTo(s.sizeUsd, 9);
  });

  test('breakeven is not armed below the arm; armed by the peak, it exits at or below the level', () => {
    const ex = exits({ tp: [[2, 1]], breakeven_arm_mult: 1.2 });
    // Peak 1.19 < 1.2: a drop to 1.0 does nothing.
    expect(decideExitTrigger(state({ peakMult: 1.19 }), ex, 1.0, T0 + 1_000)).toBeNull();
    // Armed (peak 1.3): above the level holds, at the level exits.
    expect(decideExitTrigger(state({ peakMult: 1.3 }), ex, BE + 0.001, T0 + 1_000)).toBeNull();
    expect(decideExitTrigger(state({ peakMult: 1.3 }), ex, BE, T0 + 1_000))
      .toEqual({ reason: 'stop', fraction: 1, leg: null, stopKind: 'breakeven' });
    // The current mark arms it too (peak = max(peak, mark)), but a mark at the arm is far above the level.
    expect(decideExitTrigger(state({ peakMult: 1 }), ex, 1.2, T0 + 1_000)).toBeNull();
  });

  test('breakeven level is max(stop_mult, breakeven); a hit stop_mult stays a plain stop', () => {
    const ex = exits({ stop_mult: 0.9, breakeven_arm_mult: 1.1 });
    expect(decideExitTrigger(state({ peakMult: 1.5 }), ex, 0.85, T0 + 1_000)).toEqual({ reason: 'stop', fraction: 1, leg: null });
    expect(decideExitTrigger(state({ peakMult: 1.5 }), ex, 1.0, T0 + 1_000))
      .toEqual({ reason: 'stop', fraction: 1, leg: null, stopKind: 'breakeven' });
  });

  test('order: TP before breakeven; breakeven before liquidity drop; liquidity drop before trail and time', () => {
    const all = exits({ tp: [[1.5, 1]], breakeven_arm_mult: 1.1, liq_drop_exit_pct: 0.5, trail_from_peak: 0.1, max_hold_s: 60 });
    const late = T0 + 120_000;
    const crashed = liq(10_000, 1_000);
    expect(decideExitTrigger(state({ peakMult: 2 }), all, 1.6, late, crashed)).toEqual({ reason: 'tp', fraction: 1, leg: 1 });
    expect(decideExitTrigger(state({ peakMult: 2 }), all, 1.0, late, crashed))
      .toEqual({ reason: 'stop', fraction: 1, leg: null, stopKind: 'breakeven' });
    expect(decideExitTrigger(state({ peakMult: 1.05 }), all, 1.0, late, crashed))
      .toEqual({ reason: 'stop', fraction: 1, leg: null, stopKind: 'liq_drop' });
    // No liquidity drop: the trail (armed from entry, peak 1.05 -> level 0.945) then fires.
    expect(decideExitTrigger(state({ peakMult: 1.05 }), all, 0.9, late, liq(10_000, 9_000))).toEqual({ reason: 'trail', fraction: 1, leg: null });
  });

  test('liquidity drop fires strictly below entry x (1 - pct), only with both liquidities known', () => {
    const ex = exits({ tp: [[2, 1]], liq_drop_exit_pct: 0.5 });
    const hit: ExitTrigger = { reason: 'stop', fraction: 1, leg: null, stopKind: 'liq_drop' };
    expect(decideExitTrigger(state(), ex, 1.0, T0 + 1_000, liq(10_000, 5_000))).toBeNull();
    expect(decideExitTrigger(state(), ex, 1.0, T0 + 1_000, liq(10_000, 4_999))).toEqual(hit);
    expect(decideExitTrigger(state(), ex, 1.0, T0 + 1_000, liq(null, 0))).toBeNull();
    expect(decideExitTrigger(state(), ex, 1.0, T0 + 1_000, liq(0, 0))).toBeNull();
    expect(decideExitTrigger(state(), ex, 1.0, T0 + 1_000, liq(10_000, null))).toBeNull();
    expect(decideExitTrigger(state(), ex, 1.0, T0 + 1_000, null)).toBeNull();
    // No fresh mark: only the time cap can fire, as before.
    expect(decideExitTrigger(state(), ex, null, T0 + 1_000, liq(10_000, 0))).toBeNull();
    expect(liquidityBelow(liq(10_000, 2_999), 0.7)).toBe(true);
  });

  test('null or missing fields = the pre-3b decisions exactly', () => {
    const legacy = exits({ tp: [[1.2, 0.5], [1.5, 0.5]], stop_mult: 0.9, trail_from_peak: 0.12, trail_arm_mult: 1.1 });
    const nulls = { ...legacy, breakeven_arm_mult: null, liq_drop_exit_pct: null };
    const crashed = liq(10_000, 1);
    for (const peak of [1, 1.05, 1.3, 2]) {
      for (const mark of [null, 0.5, 0.9, 0.95, 1, BE, 1.15, 1.2, 1.6]) {
        for (const at of [T0 + 1_000, T0 + 900_000]) {
          const s = state({ peakMult: peak });
          const before = decideExitTrigger(s, legacy, mark, at);
          expect(decideExitTrigger(s, legacy, mark, at, crashed)).toEqual(before);
          expect(decideExitTrigger(s, nulls, mark, at, crashed)).toEqual(before);
        }
      }
    }
  });

  test('exit summary names the stop kind', () => {
    const fill = { remainingFraction: 0, realisedUsd: 19, closed: true, pnlUsd: -1, pnlMult: 0.95 };
    const base = { label: 'X', legs: 0, mult: 1.0, proceedsUsd: 19, fillSource: 'quote' as const, fill, sizeUsd: 20 };
    expect(exitSummary({ ...base, trigger: { reason: 'stop', fraction: 1, leg: null, stopKind: 'breakeven' } })).toContain('(breakeven stop)');
    expect(exitSummary({ ...base, trigger: { reason: 'stop', fraction: 1, leg: null, stopKind: 'liq_drop' } })).toContain('(liquidity drop)');
    expect(exitSummary({ ...base, trigger: { reason: 'stop', fraction: 1, leg: null } })).toContain('(stop)');
  });
});

describe('phase 3b liquidity shadow events', () => {
  const position = { id: 'pos-1', agentId: 'agent-1', mint: 'MINT', symbol: 'TKN' };

  function harness(stored: number[] = []) {
    const written: ArenaEventInput[] = [];
    let reads = 0;
    const deps: LiqShadowDeps = {
      seen: new Map(),
      readRecorded: async () => { reads += 1; return stored; },
      write: async (events) => { written.push(...events); },
    };
    return { deps, written, reads: () => reads };
  }

  test('crossings are the thresholds past now and not yet recorded', () => {
    expect(LIQ_SHADOW_THRESHOLDS).toEqual([0.3, 0.5, 0.7]);
    expect(liquidityShadowCrossings({ entryUsd: 10_000, nowUsd: 7_000 }, new Set())).toEqual([]);
    expect(liquidityShadowCrossings({ entryUsd: 10_000, nowUsd: 6_999 }, new Set())).toEqual([0.3]);
    expect(liquidityShadowCrossings({ entryUsd: 10_000, nowUsd: 1_000 }, new Set([0.3]))).toEqual([0.5, 0.7]);
    expect(liquidityShadowCrossings({ entryUsd: null, nowUsd: 0 }, new Set())).toEqual([]);
  });

  test('records each threshold once per position, even with the exit field off', async () => {
    const h = harness();
    // Healthy pool: no DB read, no event.
    expect(await recordLiquidityShadow(position, { entryUsd: 10_000, nowUsd: 9_000 }, 1, null, h.deps)).toEqual([]);
    expect(h.reads()).toBe(0);
    expect(await recordLiquidityShadow(position, { entryUsd: 10_000, nowUsd: 6_000 }, 0.9, null, h.deps)).toEqual([0.3]);
    expect(await recordLiquidityShadow(position, { entryUsd: 10_000, nowUsd: 6_000 }, 0.9, null, h.deps)).toEqual([]);
    expect(await recordLiquidityShadow(position, { entryUsd: 10_000, nowUsd: 2_000 }, 0.5, null, h.deps)).toEqual([0.5, 0.7]);
    expect(await recordLiquidityShadow(position, { entryUsd: 10_000, nowUsd: 100 }, 0.1, null, h.deps)).toEqual([]);
    expect(h.reads()).toBe(1);
    expect(h.written.map((e) => [e.type, e.data?.reason, e.data?.threshold])).toEqual([
      ['skip', 'exit_shadow_liq_drop', 0.3], ['skip', 'exit_shadow_liq_drop', 0.5], ['skip', 'exit_shadow_liq_drop', 0.7],
    ]);
    expect(h.written[0]!.data).toMatchObject({ positionId: 'pos-1', entryLiqUsd: 10_000, liqUsd: 6_000, liqDropExitPct: null });
    expect(h.written[0]!.summary).toContain('Shadow only (no trade)');
  });

  test('after a restart the stored thresholds are not written again', async () => {
    const h = harness([0.3, 0.5]);
    expect(await recordLiquidityShadow(position, { entryUsd: 10_000, nowUsd: 2_000 }, 0.5, 0.5, h.deps)).toEqual([0.7]);
    expect(h.written).toHaveLength(1);
  });

  test('a failed write is retried on the next tick (memory updates only after the write)', async () => {
    const h = harness();
    let fail = true;
    const deps: LiqShadowDeps = { ...h.deps, write: async (events) => { if (fail) throw new Error('db down'); h.written.push(...events); } };
    await expect(recordLiquidityShadow(position, { entryUsd: 10_000, nowUsd: 6_000 }, 1, null, deps)).rejects.toThrow('db down');
    fail = false;
    expect(await recordLiquidityShadow(position, { entryUsd: 10_000, nowUsd: 6_000 }, 1, null, deps)).toEqual([0.3]);
  });
});

describe('exit trigger state machine (continued)', () => {

  test('a closed position never triggers', () => {
    expect(decideExitTrigger(state({ remainingFraction: 0 }), exits(), 0.1, T0 + 10_000_000)).toBeNull();
  });
});

describe('D4 sell-quote failures (persisted exit_run, Codex r4 #1 + r5)', () => {
  type Step = { t: number; attempt: 'low' | 'no_quote' | 'other_refusal'; price?: number; mark?: number };
  /**
   * Runs attempts (t = seconds after T0). Every step re-reads the run from its JSON copy, like the jsonb column,
   * so the ONLY state between attempts is what is stored: each step behaves as if the process had restarted.
   */
  function run(steps: Step[], opts: { mark?: number | null; stale?: number | null } = {}) {
    let stored: unknown = null;
    return steps.map((step) => {
      const nowMs = T0 + step.t * 1000;
      const next = advanceExitRun(parseExitRun(stored), step.attempt, nowMs);
      stored = JSON.parse(JSON.stringify(next));
      return d4Decision({
        freshMarkPrice: step.mark ?? opts.mark ?? null,
        currentLowQuotePrice: step.attempt === 'low' ? step.price ?? 0.00001 : null,
        run: next, nowMs,
        staleFallbackPrice: opts.stale === undefined ? 0.001 : opts.stale,
      });
    });
  }
  const confirmed = (priceUsd: number): D4Outcome => ({ kind: 'book', priceUsd, source: 'quote_confirmed' });

  test('fresh mark: 3 failures AND >= 45 s since the first failure fill at the mark', () => {
    expect(run([{ t: 0, attempt: 'no_quote' }, { t: 10, attempt: 'no_quote' }, { t: 20, attempt: 'no_quote' }, { t: 45, attempt: 'no_quote' }], { mark: 0.002 }))
      .toEqual([null, null, null, { kind: 'book', priceUsd: 0.002, source: 'mark_fallback' }]);
  });

  test('(a) low, no quote, no quote over >= 45 s: never books (no cached quote, no stale mark)', () => {
    expect(run([{ t: 0, attempt: 'low' }, { t: 30, attempt: 'no_quote' }, { t: 60, attempt: 'no_quote' }, { t: 90, attempt: 'no_quote' }]))
      .toEqual([null, null, null, null]);
  });

  test('(b) low, low spanning >= 45 s: quote_confirmed at the LATEST quote', () => {
    expect(run([{ t: 0, attempt: 'low', price: 0.00003 }, { t: 44, attempt: 'low', price: 0.00002 }])).toEqual([null, null]);
    expect(run([{ t: 0, attempt: 'low', price: 0.00003 }, { t: 45, attempt: 'low', price: 0.00002 }])).toEqual([null, confirmed(0.00002)]);
  });

  test('(c) low, no quote, low: the no-quote attempt neither counts nor resets; books at the latest', () => {
    expect(run([{ t: 0, attempt: 'low', price: 0.00003 }, { t: 20, attempt: 'no_quote' }, { t: 50, attempt: 'low', price: 0.00001 }]))
      .toEqual([null, null, confirmed(0.00001)]);
  });

  test('another refused quote resets the low streak', () => {
    expect(run([{ t: 0, attempt: 'low' }, { t: 20, attempt: 'other_refusal' }, { t: 50, attempt: 'low' }])).toEqual([null, null, null]);
  });

  test('pure outage (no low quote in the run): 3 failures over >= 45 s book the stale price', () => {
    expect(run([{ t: 0, attempt: 'no_quote' }, { t: 20, attempt: 'no_quote' }, { t: 45, attempt: 'no_quote' }]))
      .toEqual([null, null, { kind: 'book', priceUsd: 0.001, source: 'mark_fallback' }]);
  });

  test('r5 #3: a low quote more than 5 min after the previous low restarts the streak (and its 45 s window)', () => {
    // lows at 0 s and 301 s (> 5 min apart): the second restarts at 1; a third at 346 s (45 s later) confirms.
    const out = run([
      { t: 0, attempt: 'low' }, { t: 60, attempt: 'no_quote' }, { t: 120, attempt: 'no_quote' }, { t: 180, attempt: 'no_quote' },
      { t: 240, attempt: 'no_quote' }, { t: 301, attempt: 'low', price: 0.00002 }, { t: 345, attempt: 'low', price: 0.00002 },
      { t: 346, attempt: 'low', price: 0.000015 },
    ]);
    expect(out.slice(0, 7)).toEqual([null, null, null, null, null, null, null]);
    expect(out[7]).toEqual(confirmed(0.000015));
    // exactly 5 min apart still continues the streak
    expect(run([{ t: 0, attempt: 'low' }, { t: 100, attempt: 'no_quote' }, { t: 200, attempt: 'no_quote' }, { t: 300, attempt: 'low', price: 0.00002 }]).at(-1))
      .toEqual(confirmed(0.00002));
  });

  test('r5 #1: nothing bookable for 30 min of the run closes as unresolved; not before', () => {
    const outage: Step[] = Array.from({ length: 31 }, (_, i): Step => ({ t: 60 * i, attempt: i === 0 ? 'low' : 'no_quote' }));
    const out = run(outage);
    expect(out.slice(0, 30).every((d) => d === null)).toBe(true);
    expect(out[30]).toEqual({ kind: 'unresolved' });
    // no stale price and no low quote: the same hard stop applies
    const blind = run(Array.from({ length: 31 }, (_, i) => ({ t: 60 * i, attempt: 'no_quote' as const })), { stale: null });
    expect(blind[29]).toBeNull();
    expect(blind[30]).toEqual({ kind: 'unresolved' });
  });

  test('r5 #1: the 30-min clock runs from the run start, not from a restarted low streak', () => {
    const steps: Step[] = [];
    for (let t = 0; t <= 1800; t += 60) steps.push({ t, attempt: t % 360 === 0 ? 'low' : 'no_quote' });
    const out = run(steps); // lows every 6 min never confirm (each > 5 min after the previous)
    expect(out.at(-1)).toEqual({ kind: 'unresolved' });
  });

  test('r5 #2: the run survives a restart through the stored jsonb (sawLow blocks the stale price)', () => {
    // low, then no quotes over 60 s: without the stored sawLow the stale price would book at 45 s.
    expect(run([{ t: 0, attempt: 'low' }, { t: 20, attempt: 'no_quote' }, { t: 45, attempt: 'no_quote' }, { t: 60, attempt: 'no_quote' }]))
      .toEqual([null, null, null, null]);
    const persisted = advanceExitRun(null, 'low', T0);
    const reloaded = parseExitRun(JSON.parse(JSON.stringify(persisted)));
    expect(reloaded).toEqual(persisted);
    expect(reloaded?.sawLow).toBe(true);
  });

  test('r6 #1: a pause of > 5 min restarts the run (failures, streak) but keeps sawLow, lastLowAt and the history clock', () => {
    const first = advanceExitRun(null, 'low', T0);
    const later = advanceExitRun(first, 'no_quote', T0 + 5 * 60_000 + 1);
    expect(later).toMatchObject({
      failures: 1, sawLow: true, lowCount: 0, streakStartedAt: null, lastLowAt: new Date(T0).toISOString(),
      firstFailureAt: new Date(T0).toISOString(), runStartedAt: new Date(T0 + 5 * 60_000 + 1).toISOString(),
    });
    const close = advanceExitRun(first, 'no_quote', T0 + 5 * 60_000);
    expect(close).toMatchObject({ failures: 2, sawLow: true, lowCount: 1, runStartedAt: new Date(T0).toISOString() });
  });

  test('r6 #1: without a low quote a pause starts a whole new history', () => {
    const first = advanceExitRun(null, 'no_quote', T0);
    const later = advanceExitRun(first, 'no_quote', T0 + 400_000);
    expect(later).toMatchObject({ failures: 1, sawLow: false, firstFailureAt: new Date(T0 + 400_000).toISOString() });
    // and the stale price may book again after 3 failures over 45 s of that new run
    expect(run([{ t: 0, attempt: 'no_quote' }, { t: 400, attempt: 'no_quote' }, { t: 420, attempt: 'no_quote' }, { t: 445, attempt: 'no_quote' }]).at(-1))
      .toEqual({ kind: 'book', priceUsd: 0.001, source: 'mark_fallback' });
  });

  test('r6 #1: a pause after a low quote never lets the stale price book; unresolved at 30 min from the FIRST failure', () => {
    const steps: Step[] = [{ t: 0, attempt: 'low' }];
    for (let t = 360; t <= 1800; t += 60) steps.push({ t, attempt: 'no_quote' }); // pause 0 -> 360 s, then an outage
    const out = run(steps);
    expect(out.slice(0, -1).every((d) => d === null)).toBe(true);   // incl. 3 failures over >= 45 s after the pause
    expect(out.at(-1)).toEqual({ kind: 'unresolved' });              // t = 1800 s after the first failure
    // repeated pauses cannot extend the clock: failures only every 6 min still end unresolved at 30 min
    const sparse: Step[] = [{ t: 0, attempt: 'low' }];
    for (let t = 360; t <= 1800; t += 360) sparse.push({ t, attempt: 'no_quote' });
    expect(run(sparse).at(-1)).toEqual({ kind: 'unresolved' });
  });

  test('r6 #1: with a fresh mark a low-guarded history books the mark, never unresolved', () => {
    const out = run([
      { t: 0, attempt: 'low' },
      { t: 2000, attempt: 'no_quote', mark: 0.002 }, { t: 2010, attempt: 'no_quote', mark: 0.002 },
      { t: 2045, attempt: 'no_quote', mark: 0.002 },
    ]);
    expect(out).toEqual([null, null, null, { kind: 'book', priceUsd: 0.002, source: 'mark_fallback' }]);
  });

  test('a malformed stored run is ignored (a new run starts)', () => {
    expect(parseExitRun(null)).toBeNull();
    expect(parseExitRun({ firstFailureAt: 'x', failures: 1 })).toBeNull();
    expect(parseExitRun({ firstFailureAt: new Date(T0).toISOString(), streakStartedAt: null, failures: -1, lowCount: 0, sawLow: false, lastLowAt: null, lastAttemptAt: new Date(T0).toISOString() })).toBeNull();
  });

  test('attempt classification', () => {
    expect(classifyExitAttempt('quote_far_below_reference')).toBe('low');
    expect(classifyExitAttempt('quote_far_below_mark')).toBe('low');
    expect(classifyExitAttempt('quote_failed')).toBe('no_quote');
    expect(classifyExitAttempt('not_configured')).toBe('no_quote');
    expect(classifyExitAttempt('quote_echo_mismatch')).toBe('other_refusal');
    expect(classifyExitAttempt('drift')).toBe('other_refusal');
  });

  test('r7: a stored mark is replaced only by a mark at least as new (older ticks never win)', () => {
    expect(keepNewerMark({ mult: null, atMs: null }, { mult: 1.1, atMs: T0 })).toEqual({ mult: 1.1, atMs: T0 });
    expect(keepNewerMark({ mult: 1.1, atMs: T0 }, { mult: 0.9, atMs: T0 + 1 })).toEqual({ mult: 0.9, atMs: T0 + 1 });
    expect(keepNewerMark({ mult: 1.1, atMs: T0 }, { mult: 0.9, atMs: T0 })).toEqual({ mult: 0.9, atMs: T0 });
    expect(keepNewerMark({ mult: 1.1, atMs: T0 }, { mult: 0.2, atMs: T0 - 1 })).toEqual({ mult: 1.1, atMs: T0 });
  });

  test('r9: the decision mark is the NEWEST DB mark (snapshot row vs stored position mark); a tie goes to the snapshot', () => {
    const snapM = (atMs: number) => ({ priceUsd: 1, atMs, source: 'snapshot' as const });
    const rowM = (atMs: number) => ({ priceUsd: 2, atMs, source: 'position' as const });
    expect(newestKnownMark(snapM(T0 + 1), rowM(T0))).toEqual(snapM(T0 + 1));
    expect(newestKnownMark(snapM(T0), rowM(T0 + 1))).toEqual(rowM(T0 + 1));
    expect(newestKnownMark(snapM(T0), rowM(T0))).toEqual(snapM(T0));
    expect(newestKnownMark(null, rowM(T0))).toEqual(rowM(T0));
    expect(newestKnownMark(snapM(T0), null)).toEqual(snapM(T0));
    expect(newestKnownMark(null, null)).toBeNull();
  });

  test('r9: a booking is blocked when the DB holds a mark newer than the decision mark', () => {
    expect(markNewerThanDecision(null, T0)).toBe(false);          // no mark at all
    expect(markNewerThanDecision(null, null)).toBe(false);
    expect(markNewerThanDecision(T0, T0)).toBe(false);            // same mark
    expect(markNewerThanDecision(T0 - 1, T0)).toBe(false);        // only older marks
    expect(markNewerThanDecision(T0 + 1, T0)).toBe(true);         // a newer snapshot arrived during the quote
    expect(markNewerThanDecision(T0, null)).toBe(true);           // decided with no mark, a mark exists now
  });

  test('r10: a fresh decision mark must still be fresh after the sell quote (<= 60 s at tick time + quote time)', () => {
    expect(markStillFresh(T0, T0 + 60_000)).toBe(true);
    expect(markStillFresh(T0, T0 + 60_001)).toBe(false);
    expect(markStillFresh(T0 - 59_000, T0 + 5_000)).toBe(false); // 59 s old at tick start, 64 s after a 5-s quote
    expect(markStillFresh(T0 - 59_000, T0 + 500)).toBe(true);    // 59.5 s after a 0.5-s quote
    expect(markStillFresh(null, T0)).toBe(false);
  });

  test('r11: a booking decided on a fresh mark needs it fresh on the WALL clock under the lock', () => {
    expect(freshBookingAllowed(true, T0, T0 + 60_000)).toBe(true);
    expect(freshBookingAllowed(true, T0, T0 + 60_001)).toBe(false);   // any delay (before, during or after the quote)
    expect(freshBookingAllowed(true, null, T0)).toBe(false);
    expect(freshBookingAllowed(false, T0, T0 + 3_600_000)).toBe(true); // decided without a fresh mark: no check
  });

  test('r11: an unconfirmed TP records a LOW quote in the run; a quote merely below TP (or none) changes nothing', () => {
    const low = tpSkipRunUpdate(null, 'quote_far_below_mark', T0);
    expect(low).toMatchObject({ failures: 1, lowCount: 1, sawLow: true, lastLowAt: new Date(T0).toISOString() });
    expect(tpSkipRunUpdate(null, 'quote_far_below_reference', T0)).toMatchObject({ sawLow: true });
    expect(tpSkipRunUpdate(low, 'quote_far_below_mark', T0 + 10_000)).toMatchObject({ failures: 2, lowCount: 2 });
    expect(tpSkipRunUpdate(low, null, T0 + 10_000)).toBeNull();            // ok quote below the TP multiple
    expect(tpSkipRunUpdate(low, 'quote_failed', T0 + 10_000)).toBeNull();  // no quote
    expect(tpSkipRunUpdate(low, 'drift', T0 + 10_000)).toBeNull();         // other refusal
  });

  test('TP is confirmed only by the quote: quoted price / entry price (before the sell haircut) >= the leg multiple', () => {
    const entry = 0.001;
    expect(quotedTpMultiple(0.00102, entry)).toBeCloseTo(1.02, 12);
    expect(tpConfirmedByQuote(quotedTpMultiple(0.00102, entry), 1.1)).toBe(false); // mark 1.12x, quote 1.02x: hold
    expect(tpConfirmedByQuote(quotedTpMultiple(0.00111, entry), 1.1)).toBe(true);  // quote 1.11x: sell
    expect(tpConfirmedByQuote(quotedTpMultiple(0.0011, entry), 1.1)).toBe(true);   // exactly the TP multiple
    expect(tpConfirmedByQuote(quotedTpMultiple(null, entry), 1.1)).toBe(false);    // no usable quote
    expect(quotedTpMultiple(0, entry)).toBeNull();
  });

  test('exit_fill_source is sticky: mark_fallback > quote_confirmed > quote', () => {
    expect(combineFillSource(null, 'quote')).toBe('quote');
    expect(combineFillSource('quote', 'quote_confirmed')).toBe('quote_confirmed');
    expect(combineFillSource('quote_confirmed', 'quote')).toBe('quote_confirmed');
    expect(combineFillSource('quote_confirmed', 'mark_fallback')).toBe('mark_fallback');
    expect(combineFillSource('mark_fallback', 'quote_confirmed')).toBe('mark_fallback');
    expect(combineFillSource('junk', 'quote')).toBe('quote');
  });

  test('negative proceeds are never booked', () => {
    const fill = applyExitFill(state(), { reason: 'stop', fraction: 1, leg: null }, -5);
    expect(fill.realisedUsd).toBe(0);
    expect(fill.pnlUsd).toBe(-20);
    expect(fill.pnlMult).toBe(0);
  });
});

describe('D4 with a disputed fresh mark (FEAR + frozen marks, prod; real evaluateSellQuote -> d4AfterFailedQuote)', () => {
  // house:late-bloomer, position 2c4259d7: entry 0.0000529, the mark said 204x, every sell quote said ~0.92x of entry.
  // 2026-11-12 depth rule: a quote at or under FLOOR_ARENA_DEEP_LOW_OF_MARK (0.2x) of the FRESH mark disputes it.
  const QMINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const ENTRY = 0.0000529;
  const TOKENS = 20 / ENTRY;
  const AMOUNT_RAW = tokensToRaw(TOKENS, 6)!;
  const SPIKE = 204 * ENTRY;
  const SANE = 0.92 * ENTRY;
  const HAIRCUT = DEFAULT_PAPER_COSTS.sell_haircut_pct;
  function sellAt(priceUsd: number, markPriceUsd: number | null, referencePriceUsd: number | null = null): SellQuoteResult {
    return evaluateSellQuote({
      status: 'quoted', input: { mint: QMINT, amount: String(TOKENS), rawAmount: AMOUNT_RAW, decimals: 6 },
      output: { mint: USDC_MINT, amount: String(TOKENS * priceUsd), rawAmount: '1', decimals: 6 }, slippageBps: 300, priceImpactPct: '0.01',
    }, { mint: QMINT, tokens: TOKENS, amountRaw: AMOUNT_RAW, markPriceUsd, referencePriceUsd });
  }
  const NO_QUOTE: SellQuoteResult = { ok: false, reason: 'quote_failed', detail: 'timeout' };
  /** reject: D4 decided a booking (or an unresolved close) but the write was rejected (a newer mark, an aged mark or a
   *  lost CAS), as executeExit sees it. */
  type QStep = { t: number; quote: SellQuoteResult; mark: number | null; tp?: boolean; reject?: boolean };
  type QOut = 'tp_hold' | 'quote' | { d4: D4Outcome; proceedsUsd: number | null };
  /** The executeExit wiring, pure: a TP step goes through tpSkipRunUpdate, an exit step through d4AfterFailedQuote.
   *  The only state between steps is the stored jsonb copy. The run is stored as executeExit writes it: on a retry
   *  (d4 null) always; on a REJECTED booking only what runToKeepAfterRejectedBooking returns (Codex, 94c489354).
   *  After an accepted booking `stored` keeps that attempt's run (the real booking clears exit_run; the tests read
   *  the run the decision used). */
  function drive(steps: QStep[], stale: number | null = null): { out: QOut[]; stored: unknown } {
    let stored: unknown = null;
    const out = steps.map((s): QOut => {
      const nowMs = T0 + s.t * 1000;
      if (s.tp) {
        const lowRun = tpSkipRunUpdate(parseExitRun(stored), s.quote.ok ? null : s.quote.reason, nowMs, quoteDisputesMark(s.quote, s.mark));
        if (lowRun) stored = JSON.parse(JSON.stringify(lowRun));
        return 'tp_hold';
      }
      if (s.quote.ok) return 'quote';
      const prevRun = parseExitRun(stored);
      const r = d4AfterFailedQuote({
        prevRun, quote: s.quote, freshMarkPrice: s.mark, staleFallbackPrice: stale, nowMs,
      });
      if (r.d4 !== null && s.reject) {
        const keep = runToKeepAfterRejectedBooking(prevRun, r.run);
        if (keep) stored = JSON.parse(JSON.stringify(keep));
        return { d4: null, proceedsUsd: null };
      }
      stored = JSON.parse(JSON.stringify(r.run));
      const proceedsUsd = r.d4?.kind === 'book'
        ? (r.d4.source === 'quote_confirmed' && r.currentLow ? r.currentLow.proceedsUsd : markFallbackProceeds(TOKENS, r.d4.priceUsd))
        : null;
      return { d4: r.d4, proceedsUsd };
    });
    return { out, stored };
  }
  const exitAt = (t: number, quote: SellQuoteResult, mark: number | null = SPIKE): QStep => ({ t, quote, mark });
  const confirmedAt = (priceUsd: number): D4Outcome => ({ kind: 'book', source: 'quote_confirmed', priceUsd: expect.closeTo(priceUsd, 12) });
  const d4Of = (o: QOut) => (o as { d4: D4Outcome }).d4;

  test('the wire: a FEAR quote is refused quote_far_below_mark, carries its fill and disputes the mark', () => {
    const q = sellAt(SANE, SPIKE);
    expect(q).toMatchObject({ ok: false, reason: 'quote_far_below_mark' });
    if (q.ok || !q.fill) throw new Error('expected a carried fill');
    expect(q.fill.priceUsd).toBeCloseTo(SANE, 12);
    expect(quoteDisputesMark(q, SPIKE)).toBe(true);
  });

  test('(a) FEAR replay: TP held on the quote for 10 min, the time exit books the 0.92x quote (quote_confirmed), never the 204x mark', () => {
    const steps: QStep[] = [];
    for (let t = 20; t < 600; t += 10) steps.push({ t, quote: sellAt(SANE, SPIKE), mark: SPIKE, tp: true });
    steps.push(exitAt(600, sellAt(SANE, SPIKE)));
    const { out } = drive(steps);
    expect(out.slice(0, -1).every((o) => o === 'tp_hold')).toBe(true);
    const last = out.at(-1) as { d4: D4Outcome; proceedsUsd: number };
    expect(last.d4).toEqual(confirmedAt(SANE));
    // the booked quote pays the sell haircut like any quote fill (D3): ~ $20 x 0.92 x 0.995, a loss, not +$4,005
    expect(last.proceedsUsd).toBeCloseTo(TOKENS * SANE * (1 - HAIRCUT / 100), 6);
    expect(last.proceedsUsd).toBeLessThan(20);
  });

  test('(a) FEAR replay, time exit quote fails once: a TP-primed history never books the 204x mark', () => {
    const steps: QStep[] = [];
    for (let t = 20; t < 600; t += 10) steps.push({ t, quote: sellAt(SANE, SPIKE), mark: SPIKE, tp: true });
    steps.push(exitAt(600, NO_QUOTE), exitAt(610, sellAt(SANE, SPIKE)));
    const { out } = drive(steps);
    expect(d4Of(out.at(-2)!)).toBeNull();
    expect(d4Of(out.at(-1)!)).toEqual(confirmedAt(SANE));
  });

  test('(a) without TP primes: sane lows confirm after >= 2 lows over >= 45 s; the spiked mark never books', () => {
    const { out } = drive([0, 10, 20, 44, 45].map((t) => exitAt(t, sellAt(SANE, SPIKE))));
    expect(out.slice(0, 4).map(d4Of)).toEqual([null, null, null, null]);
    expect(d4Of(out[4]!)).toEqual(confirmedAt(SANE));
  });

  test('(a) a sane low disputes the mark for the rest of the history: a later no-quote or drift attempt never books the mark', () => {
    const { out, stored } = drive([
      exitAt(0, sellAt(SANE, SPIKE)), exitAt(10, sellAt(SANE, SPIKE)),
      exitAt(45, NO_QUOTE), exitAt(60, NO_QUOTE),                       // 4 failures over 60 s: the old code booked 204x here
      exitAt(70, sellAt(SPIKE * 1.5, SPIKE)), exitAt(80, NO_QUOTE),       // drift resets the low streak; still no mark
      exitAt(90, sellAt(SANE, SPIKE)), exitAt(134, sellAt(SANE, SPIKE)),   // new streak 90 -> 134 s: 44 s, not yet
      exitAt(135, sellAt(SANE, SPIKE)),
    ]);
    const d4s = out.map(d4Of);
    expect(d4s.slice(0, 8)).toEqual([null, null, null, null, null, null, null, null]);
    expect(d4s[8]).toEqual(confirmedAt(SANE));
    expect(parseExitRun(stored)?.markDisputed).toBe(true);
  });

  test('(a) disputed mark and no usable quote after it (no quote, drift): never books; unresolved 30 min after the first failure', () => {
    const steps: QStep[] = [exitAt(0, sellAt(SANE, SPIKE))];
    for (let t = 60; t <= 1800; t += 60) steps.push(exitAt(t, t % 120 === 0 ? sellAt(SPIKE * 1.5, SPIKE) : NO_QUOTE));
    const d4s = drive(steps).out.map(d4Of);
    expect(d4s.slice(0, -1).every((d) => d === null)).toBe(true);
    expect(d4s.at(-1)).toEqual({ kind: 'unresolved' });
  });

  test('(a) disputed mark, then near-zero lows: each deep low disputes too; the confirmed near-zero quote books, never the mark', () => {
    const steps: QStep[] = [exitAt(0, sellAt(SANE, SPIKE))];
    for (let t = 60; t <= 300; t += 60) steps.push(exitAt(t, t % 120 === 0 ? sellAt(0.001 * ENTRY, SPIKE) : NO_QUOTE));
    const d4s = drive(steps).out.map(d4Of);
    expect(d4s.slice(0, 2)).toEqual([null, null]);
    expect(d4s[2]).toEqual(confirmedAt(0.001 * ENTRY)); // 120 s: 2 lows, streak 120 s
  });

  test('(b) frozen-mark collapse (Runner): mark 1.2x, quotes 0.047x of entry for >= 45 s -> quote_confirmed at the low, never the mark', () => {
    const MARK = 1.2 * ENTRY;
    const LOW = 0.047 * ENTRY; // ~0.039x of the mark: the PumpSwap floor of a dumped migrated coin
    const { out, stored } = drive([0, 10, 20, 45].map((t) => exitAt(t, sellAt(LOW, MARK), MARK)));
    expect(out.slice(0, 3).map(d4Of)).toEqual([null, null, null]);
    const last = out[3] as { d4: D4Outcome; proceedsUsd: number };
    expect(last.d4).toEqual(confirmedAt(LOW));
    expect(last.proceedsUsd).toBeCloseTo(TOKENS * LOW * (1 - HAIRCUT / 100), 9);
    expect(parseExitRun(stored)?.markDisputed).toBe(true);
    // a TP-primed history (the lows came on TP skips) is disputed the same way
    const tp = drive([
      { t: 0, quote: sellAt(LOW, MARK), mark: MARK, tp: true }, { t: 10, quote: sellAt(LOW, MARK), mark: MARK, tp: true },
      exitAt(20, NO_QUOTE, MARK), exitAt(45, NO_QUOTE, MARK), exitAt(60, sellAt(LOW, MARK), MARK),
    ]).out.map(d4Of);
    expect(tp.slice(2)).toEqual([null, null, confirmedAt(LOW)]);
  });

  test('(c) one-sample glitch: mark 1.0x, one low at 0.05x of the mark, a sane quote 11 s later books (quote), never the glitch', () => {
    const MARK = 1.0 * ENTRY;
    const { out, stored } = drive([exitAt(0, sellAt(0.05 * MARK, MARK), MARK), exitAt(11, sellAt(0.98 * MARK, MARK), MARK)]);
    expect(d4Of(out[0]!)).toBeNull();
    expect(out[1]).toBe('quote');
    expect(parseExitRun(stored)?.markDisputed).toBe(true); // the glitch disputed the mark; the sane quote books anyway
  });

  test('(d) shallow lows (0.2x < quote/mark < 0.5x) never dispute: mark_fallback after 3 failures over 45 s (XRP; unchanged)', () => {
    const MARK = 1.0 * ENTRY;
    const { out, stored } = drive([0, 10, 20, 45].map((t) => exitAt(t, sellAt(0.3 * MARK, MARK), MARK)));
    expect(out.slice(0, 3).map(d4Of)).toEqual([null, null, null]);
    const last = out[3] as { d4: D4Outcome; proceedsUsd: number };
    expect(last.d4).toEqual({ kind: 'book', priceUsd: MARK, source: 'mark_fallback' });
    expect(last.proceedsUsd).toBeCloseTo(markFallbackProceeds(TOKENS, MARK), 9);
    expect(parseExitRun(stored)?.sawLow).toBe(true);
    expect(parseExitRun(stored)?.markDisputed).toBeUndefined();
    // mark 3.0x: the shallow quote is 0.9x of entry, which the removed entry-floor rule treated as a dispute
    const HIGH = 3.0 * ENTRY;
    const high = drive([0, 10, 20, 45].map((t) => exitAt(t, sellAt(0.3 * HIGH, HIGH), HIGH)));
    expect(high.out.slice(0, 3).map(d4Of)).toEqual([null, null, null]);
    expect(d4Of(high.out[3]!)).toEqual({ kind: 'book', priceUsd: HIGH, source: 'mark_fallback' });
    expect(parseExitRun(high.stored)?.markDisputed).toBeUndefined();
  });

  test('(e) boundary: a quote at exactly 0.2x of the fresh mark disputes, 0.2001x does not; no fresh mark never disputes', () => {
    expect(FLOOR_ARENA_DEEP_LOW_OF_MARK).toBe(0.2);
    const MARK = 1.0 * ENTRY;
    const refusal = (priceUsd: number): SellQuoteResult => ({
      ok: false, reason: 'quote_far_below_mark', quotedPriceUsd: priceUsd,
      fill: { ok: true, tokens: TOKENS, quotedUsd: TOKENS * priceUsd, proceedsUsd: TOKENS * priceUsd * 0.995, priceUsd, venue: null },
    });
    expect(quoteDisputesMark(refusal(MARK * 0.2), MARK)).toBe(true);
    expect(quoteDisputesMark(refusal(MARK * 0.2001), MARK)).toBe(false);
    expect(quoteDisputesMark({ ok: false, reason: 'quote_far_below_mark', quotedPriceUsd: MARK * 0.2 }, MARK)).toBe(true); // no fill
    expect(quoteDisputesMark(sellAt(0.1999 * MARK, MARK), MARK)).toBe(true);          // through the wire
    expect(quoteDisputesMark(sellAt(0.2001 * MARK, MARK), MARK)).toBe(false);
    expect(quoteDisputesMark(sellAt(SANE, MARK), MARK)).toBe(false);                   // passes the mark: no refusal
    expect(quoteDisputesMark(sellAt(0.001 * ENTRY, null, ENTRY), null)).toBe(false);   // far below reference, no fresh mark
    expect(quoteDisputesMark(refusal(MARK * 0.1), null)).toBe(false);
    expect(quoteDisputesMark(NO_QUOTE, MARK)).toBe(false);
    const { stored } = drive([exitAt(0, sellAt(0.001 * ENTRY, null, ENTRY), null)]);
    expect(parseExitRun(stored)?.markDisputed).toBeUndefined();
  });

  test('(f) a rejected booking keeps a NEWLY set sawLow: the next stale-branch no-quote attempt never books the stale price', () => {
    const MARK = 1.0 * ENTRY;
    const steps: QStep[] = [
      exitAt(0, NO_QUOTE, MARK), exitAt(10, NO_QUOTE, MARK), exitAt(20, NO_QUOTE, MARK),
      // first low (shallow, undisputed) under the fresh mark: D4 decides mark_fallback, the mark aged, booking rejected
      { ...exitAt(45, sellAt(0.3 * MARK, MARK), MARK), reject: true },
      exitAt(55, NO_QUOTE, null), exitAt(65, NO_QUOTE, null),
    ];
    const before = drive(steps.slice(0, 3)).stored;
    const low45 = sellAt(0.3 * MARK, MARK);
    if (low45.ok) throw new Error('expected a refused quote');
    const at45 = d4AfterFailedQuote({ prevRun: parseExitRun(before), quote: low45, freshMarkPrice: MARK, staleFallbackPrice: MARK, nowMs: T0 + 45_000 });
    expect(at45.d4).toEqual({ kind: 'book', priceUsd: MARK, source: 'mark_fallback' });
    expect(parseExitRun(before)?.sawLow).toBe(false);
    const { out, stored } = drive(steps, MARK);
    expect(out.map(d4Of)).toEqual([null, null, null, null, null, null]);
    expect(parseExitRun(stored)?.sawLow).toBe(true);
    // without the fix (nothing written on the rejection) the 55 s stale-branch attempt books the stale price
    const bug = d4AfterFailedQuote({ prevRun: parseExitRun(before), quote: NO_QUOTE, freshMarkPrice: null, staleFallbackPrice: MARK, nowMs: T0 + 55_000 });
    expect(bug.d4).toEqual({ kind: 'book', priceUsd: MARK, source: 'mark_fallback' });
  });

  test('(c) drift refusals and no-quote attempts with a fresh mark -> mark_fallback (unchanged)', () => {
    const MARK = 2 * ENTRY;
    const drift = drive([0, 10, 20, 45].map((t) => exitAt(t, sellAt(MARK * 1.5, MARK), MARK))).out;
    expect(d4Of(drift[0]!)).toBeNull();
    expect(d4Of(drift[3]!)).toEqual({ kind: 'book', priceUsd: MARK, source: 'mark_fallback' });
    const failed = drive([0, 10, 20, 45].map((t) => exitAt(t, NO_QUOTE, MARK))).out;
    expect(d4Of(failed[3]!)).toEqual({ kind: 'book', priceUsd: MARK, source: 'mark_fallback' });
  });

  test('(d) stale branch through the same wiring: a far-below-reference low books quote_confirmed (unchanged)', () => {
    const LOW = 0.2 * ENTRY;
    const d4s = drive([0, 45].map((t) => exitAt(t, sellAt(LOW, null, ENTRY), null)), ENTRY).out.map(d4Of);
    expect(d4s[0]).toBeNull();
    expect(d4s[1]).toEqual(confirmedAt(LOW));
  });

  test('(e) a TP is still judged on the quote: the FEAR quote never confirms a TP, a quote at the TP multiple does', () => {
    expect(tpConfirmedByQuote(quotedTpMultiple(SANE, ENTRY), 2)).toBe(false);
    expect(tpConfirmedByQuote(quotedTpMultiple(2 * ENTRY, ENTRY), 2)).toBe(true);
  });

  test('Codex 94c489354: a REJECTED quote_confirmed booking that first disputed the mark keeps the dispute; the 204x mark never books', () => {
    const SHALLOW = 0.3 * SPIKE;
    // shallow lows (0.3x of the mark) at 0 s and 10 s (undisputed); at 45 s a 0.92x-of-entry quote (0.0045x of the mark)
    // disputes the mark and qualifies quote_confirmed, but a newer snapshot lands during the quote and the booking is rejected.
    const steps: QStep[] = [
      exitAt(0, sellAt(SHALLOW, SPIKE)), exitAt(10, sellAt(SHALLOW, SPIKE)),
      { ...exitAt(45, sellAt(SANE, SPIKE)), reject: true },
      exitAt(55, NO_QUOTE), exitAt(65, NO_QUOTE), exitAt(120, NO_QUOTE),
    ];
    // the 45 s attempt did decide a quote_confirmed booking before the rejection
    const before = drive(steps.slice(0, 2)).stored;
    const sane45 = sellAt(SANE, SPIKE);
    if (sane45.ok) throw new Error('expected a refused quote');
    const at45 = d4AfterFailedQuote({
      prevRun: parseExitRun(before), quote: sane45, freshMarkPrice: SPIKE, staleFallbackPrice: null,
      nowMs: T0 + 45_000,
    });
    expect(at45.d4).toEqual(confirmedAt(SANE));
    expect(parseExitRun(before)?.markDisputed).toBeUndefined();
    const { out, stored } = drive(steps);
    expect(out.map(d4Of)).toEqual([null, null, null, null, null, null]);
    expect(parseExitRun(stored)?.markDisputed).toBe(true);
    // the next sane low books the quote, never the mark
    const { out: after } = drive([...steps, exitAt(130, sellAt(SANE, SPIKE))]);
    expect(d4Of(after.at(-1)!)).toEqual(confirmedAt(SANE));
    // without the fix (nothing written on the rejection) the 55 s attempt books the 204x mark: the bug Codex replayed
    const bug = d4AfterFailedQuote({
      prevRun: parseExitRun(before), quote: NO_QUOTE, freshMarkPrice: SPIKE, staleFallbackPrice: null, nowMs: T0 + 55_000,
    });
    expect(bug.d4).toEqual({ kind: 'book', priceUsd: SPIKE, source: 'mark_fallback' });
  });

  test('Codex 94c489354: a rejected unresolved close that first disputed the mark keeps the dispute too', () => {
    const steps: QStep[] = [exitAt(0, NO_QUOTE, null)];
    for (let t = 60; t < 1800; t += 60) steps.push(exitAt(t, NO_QUOTE, null));
    // 30 min in, a fresh 204x mark and a sane quote: disputed, not yet confirmed (one low) -> unresolved, rejected
    steps.push({ ...exitAt(1800, sellAt(SANE, SPIKE)), reject: true }, exitAt(1810, NO_QUOTE));
    const { out, stored } = drive(steps);
    expect(out.slice(0, -2).map(d4Of).every((d) => d === null)).toBe(true);
    expect(parseExitRun(stored)?.markDisputed).toBe(true);
    // the next attempt (no quote under the fresh 204x mark) closes unresolved, it never books the mark
    expect(d4Of(out.at(-1)!)).toEqual({ kind: 'unresolved' });
    // without the fix the undisputed run books the mark at 1810 s
    const bug = d4AfterFailedQuote({
      prevRun: parseExitRun(drive(steps.slice(0, -2)).stored), quote: NO_QUOTE, freshMarkPrice: SPIKE,
      staleFallbackPrice: null, nowMs: T0 + 1_810_000,
    });
    expect(bug.d4).toEqual({ kind: 'book', priceUsd: SPIKE, source: 'mark_fallback' });
  });

  test('runToKeepAfterRejectedBooking: only a run that NEWLY sets markDisputed or sawLow is kept', () => {
    const noQuote = advanceExitRun(null, 'no_quote', T0);
    const plain = advanceExitRun(null, 'low', T0);
    const disputed = advanceExitRun(plain, 'low', T0 + 10_000, true);
    expect(runToKeepAfterRejectedBooking(plain, disputed)).toBe(disputed);                          // newly disputed
    expect(runToKeepAfterRejectedBooking(null, advanceExitRun(null, 'low', T0, true))?.markDisputed).toBe(true);
    const firstLow = advanceExitRun(noQuote, 'low', T0 + 10_000);
    expect(runToKeepAfterRejectedBooking(noQuote, firstLow)).toBe(firstLow);                        // newly sawLow
    expect(runToKeepAfterRejectedBooking(null, plain)).toBe(plain);
    expect(runToKeepAfterRejectedBooking(disputed, advanceExitRun(disputed, 'low', T0 + 20_000))).toBeNull();     // already stored
    expect(runToKeepAfterRejectedBooking(plain, advanceExitRun(plain, 'low', T0 + 20_000))).toBeNull();           // sawLow stored
    expect(runToKeepAfterRejectedBooking(noQuote, advanceExitRun(noQuote, 'no_quote', T0 + 20_000))).toBeNull(); // nothing new
    // the engine writes it after a rejected booking and after a rejected unresolved close, with the d4-null CAS
    const source = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8');
    expect(source).toContain("if (closed.kind === 'lost_race' && keptRun) await persistKeptRun(position, keptRun);");
    expect(source).toContain('if (keptRun) await persistKeptRun(position, keptRun);');
    expect(source).toMatch(/async function persistKeptRun[\s\S]*?eq\(floorArenaPositions\.status, 'open'\), exitRunUnchanged\(position\)\)\);/);
  });

  test('stored rows: markDisputed survives the jsonb round trip and a pause; an old row without it parses as not disputed', () => {
    const disputed = advanceExitRun(null, 'low', T0, true);
    expect(disputed.markDisputed).toBe(true);
    expect(parseExitRun(JSON.parse(JSON.stringify(disputed)))).toEqual(disputed);
    expect(advanceExitRun(disputed, 'no_quote', T0 + 6 * 60_000).markDisputed).toBe(true);
    expect(advanceExitRun(disputed, 'low', T0 + 10_000, false).markDisputed).toBe(true);
    // a no-quote attempt cannot dispute the mark, whatever the caller passes
    expect(advanceExitRun(null, 'no_quote', T0, true).markDisputed).toBeUndefined();
    const old = { ...advanceExitRun(null, 'low', T0) };
    expect('markDisputed' in old).toBe(false);
    expect(parseExitRun(JSON.parse(JSON.stringify(old)))).toEqual(old);
    expect(parseExitRun({ ...old, markDisputed: 'yes' })).toBeNull();
  });
});

describe('exit summaries', () => {
  test('partial TP and closing summaries are human readable', () => {
    const partial = exitSummary({
      label: 'BONK', trigger: { reason: 'tp', fraction: 0.5, leg: 1 }, legs: 2, mult: 1.21, proceedsUsd: 11.9,
      fillSource: 'quote', fill: { remainingFraction: 0.5, realisedUsd: 11.9, closed: false, pnlUsd: null, pnlMult: null }, sizeUsd: 20,
    });
    expect(partial).toBe('Sold 50% of BONK at 1.21x (TP 1 of 2) for $11.90 via quote.');
    const closed = exitSummary({
      label: 'BONK', trigger: { reason: 'stop', fraction: 1, leg: null }, legs: 1, mult: 0.62, proceedsUsd: 12.28,
      fillSource: 'mark_fallback', fill: { remainingFraction: 0, realisedUsd: 12.28, closed: true, pnlUsd: -7.72, pnlMult: 0.614 }, sizeUsd: 20,
    });
    expect(closed).toBe('Sold 100% of BONK at 0.62x (stop) for $12.28 via mark fallback (no usable sell quote). Closed: P&L -$7.72 (-38.6%).');
    const crash = exitSummary({
      label: 'RUG', trigger: { reason: 'time', fraction: 1, leg: null }, legs: 1, mult: 0.01, proceedsUsd: 0.19,
      fillSource: 'quote_confirmed', fill: { remainingFraction: 0, realisedUsd: 0.19, closed: true, pnlUsd: -19.81, pnlMult: 0.0095 }, sizeUsd: 20,
    });
    expect(crash).toBe('Sold 100% of RUG at 0.01x (time cap) for $0.19 via confirmed low quote (2+ low quotes over 45 s). Closed: P&L -$19.81 (-99.0%).');
  });
});

describe('D35 period reset exit', () => {
  const START = T0 + 3_600_000;
  const ex = exits({ tp: [[1.2, 0.5], [1.5, 0.5]], stop_mult: 0.8, trail_from_peak: 0.1, max_hold_s: 900 });

  test('fires only for a position opened BEFORE the period start; at or after the start it is untouched', () => {
    expect(resetExitTrigger(state({ openedAtMs: START - 1 }), START)).toEqual({ reason: 'reset', fraction: 1, leg: null });
    expect(resetExitTrigger(state({ openedAtMs: START }), START)).toBeNull();
    expect(resetExitTrigger(state({ openedAtMs: START + 1 }), START)).toBeNull();
    expect(resetExitTrigger(state(), null)).toBeNull(); // no active period
  });

  test('closes the whole REMAINING fraction; a closed position never triggers', () => {
    expect(resetExitTrigger(state({ remainingFraction: 0.5, realisedUsd: 12 }), START))
      .toEqual({ reason: 'reset', fraction: 0.5, leg: null });
    expect(resetExitTrigger(state({ remainingFraction: 0 }), START)).toBeNull();
  });

  test('outranks TP, stop, trail and time (runExitTick asks it first; the TP re-decide never sees a reset)', () => {
    const s = state({ openedAtMs: T0 });
    for (const [mark, at] of [[1.6, T0 + 1_000], [0.5, T0 + 1_000], [1.0, T0 + 900_000]] as const) {
      expect(decideExitTrigger(s, ex, mark, at)).not.toBeNull();
      expect(resetExitTrigger(s, START) ?? decideExitTrigger(s, ex, mark, at)).toEqual({ reason: 'reset', fraction: 1, leg: null });
    }
    const source = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8');
    expect(source).toContain('const trigger = resetExitTrigger(state, periodStartMs) ?? decideExitTrigger(state, exits, markMult, nowMs, liq);');
    expect(source.match(/readActiveArenaPeriod\)\(now\)/g)).toHaveLength(1); // one period read per tick
  });

  test('books like a time exit: same fill math for the same quote proceeds, same mark-fallback costs', () => {
    const s = state({ remainingFraction: 0.5, realisedUsd: 12 });
    const reset: ExitTrigger = { reason: 'reset', fraction: 0.5, leg: null };
    const time: ExitTrigger = { reason: 'time', fraction: 0.5, leg: null };
    expect(applyExitFill(s, reset, 9.5)).toEqual(applyExitFill(s, time, 9.5));
    expect(applyExitFill(s, reset, 9.5)).toMatchObject({ closed: true, remainingFraction: 0 });
    expect(markFallbackProceeds(10_000, 0.001)).toBeCloseTo(10_000 * 0.001 * (1 - (DEFAULT_PAPER_COSTS.sell_haircut_pct + DEFAULT_PAPER_COSTS.mark_fallback_pool_fee_pct) / 100), 12);
    // executeExit asks the TP-quote confirmation only of a 'tp' trigger
    const source = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8');
    expect(source.match(/if \(trigger\.reason === 'tp'\) \{\s+const legMult[^\n]*\n\s+const quoteMult[^\n]*\n\s+if \(!tpConfirmedByQuote\(/g)).toHaveLength(1);
    expect(source.match(/if \(!tpConfirmedByQuote\(/g)).toHaveLength(1);
  });

  test('no usable quote: D4 is the same for a reset (it takes no trigger); a disputed mark never books; unresolved at 30 min', () => {
    const ENTRY = 0.001;
    type Refused = Exclude<SellQuoteResult, { ok: true }>;
    const spike: Refused = {
      ok: false, reason: 'quote_far_below_mark', quotedPriceUsd: 0.9 * ENTRY,
      fill: { ok: true, tokens: 20_000, quotedUsd: 18, proceedsUsd: 17.91, priceUsd: 0.9 * ENTRY, venue: null },
    };
    const noQuote: Refused = { ok: false, reason: 'quote_failed' };
    let stored: unknown = null;
    const step = (t: number, quote: Refused, mark: number | null) => {
      const r = d4AfterFailedQuote({
        prevRun: parseExitRun(stored), quote,
        freshMarkPrice: mark, staleFallbackPrice: null, nowMs: T0 + t * 1000,
      });
      stored = JSON.parse(JSON.stringify(r.run));
      return r.d4;
    };
    expect(step(0, spike, 200 * ENTRY)).toBeNull();                   // disputes the 200x mark
    for (let t = 60; t < 1800; t += 60) expect(step(t, noQuote, 200 * ENTRY)).toBeNull(); // never the mark
    expect(step(1800, noQuote, 200 * ENTRY)).toEqual({ kind: 'unresolved' });
    expect(d4AfterFailedQuote.length).toBe(1); // one input object, no trigger in it
  });

  test('exit summary says "period reset"', () => {
    const closed = exitSummary({
      label: 'BONK', trigger: { reason: 'reset', fraction: 1, leg: null }, legs: 2, mult: 1.1, proceedsUsd: 21.9,
      fillSource: 'quote', fill: { remainingFraction: 0, realisedUsd: 21.9, closed: true, pnlUsd: 1.9, pnlMult: 1.095 }, sizeUsd: 20,
    });
    expect(closed).toBe('Sold 100% of BONK at 1.10x (period reset) for $21.90 via quote. Closed: P&L +$1.90 (+9.5%).');
  });
});

describe('evaluateAgentCandidates', () => {
  const OFF: FloorArenaFilters = {
    mcap_min: null, mcap_max: null, liq_min: 5_000, liq_max: null, age_min_s: null, age_max_s: null,
    vol1h_over_mcap_min: null, vol1h_over_mcap_max: null, chg5m_min: null, chg5m_max: null, chg1h_min: null,
    chg1h_max: null, chg6h_min: null, chg6h_max: null, chg24h_min: null, chg24h_max: null, txns1h_min: null,
    txns1h_max: null, top10_max_pct: null,
  };
  const params: FloorArenaParams = {
    filters: { ...OFF, mcap_max: 250_000 },
    entry: { discovered_within_s: 120, first_sight_sources: 'any', rank_by: 'vol_over_mcap', entries_per_tick: 1 },
    exits: exits({ tp: [[1.1, 1]] }),
    limits: { position_usd: 20, max_open: 5, reentry_cooldown_s: 21_600 },
  };
  function features(over: Partial<FloorArenaFeatures> = {}): FloorArenaFeatures {
    return {
      priceUsd: 0.001, mcap: 100_000, liqUsd: 20_000, liqBase: null, liqQuote: null, pairAddress: 'p', dexId: 'pumpswap',
      quoteMint: null, labels: [], pairCreatedAt: T0 - 3_600_000, ageS: 3_600, chg5m: 0, chg1h: 0, chg6h: 0, chg24h: 0,
      txns1h: 100, vol1h: 10_000, volOverMcap: 0.1, symbol: 'X', name: 'X', top10Pct: 10, ...over,
    };
  }
  function cand(mint: string, over: Partial<ArenaCandidate> = {}, f: Partial<FloorArenaFeatures> = {}): ArenaCandidate {
    return {
      mint, source: 'ds:token-profiles', symbol: mint, firstSeenAtMs: T0 - 30_000, features: features(f), verdict: 'pass',
      chainCheckedAtMs: T0 - 60_000, isPrivate: false, tradeable: true, tradeableFirstSeenAtMs: T0 - 30_000,
      tradeableSource: 'ds:token-profiles', ...over,
    };
  }

  test('window, hard rules, pending verdict, liquidity floor, filters, held and cooldown', () => {
    const list = [
      cand('good1', {}, { vol1h: 50_000 }),
      cand('good2', {}, { vol1h: 20_000 }),
      cand('late', { firstSeenAtMs: T0 - 121_000 }),
      cand('rug', { verdict: 'fail' }),
      cand('new', { verdict: 'pending' }),
      cand('thin', {}, { liqUsd: 4_000 }),
      cand('curve', {}, { dexId: 'pumpfun', liqUsd: 0 }),
      cand('big', {}, { mcap: 300_000 }),
      cand('mine'),
      cand('recent'),
    ];
    const out = evaluateAgentCandidates(params, list, new Set(['mine']), new Map([['recent', T0 - 60_000]]), T0);
    expect(out.passed.map((c) => c.mint)).toEqual(['good1', 'good2']);
    expect(out.cooling.map((c) => c.mint)).toEqual(['recent']);
    expect(out.evaluated).toBe(9);
    // D26: no platform floor; 'thin' and 'curve' fail only this template's own liq_min (5,000).
    expect(out.failCounts).toEqual({ window: 1, hard_rules: 1, chain_pending: 1, liq: 2, mcap: 1, cooldown: 1 });
    expect(topFailCodes(out.failCounts, 2)).toEqual([['liq', 2], ['chain_pending', 1]]);
  });

  test('D25: a shared coin without a tradeable source fails source_not_tradeable; a private add-on mint is exempt', () => {
    const out = evaluateAgentCandidates(params, [
      cand('gecko-only', { tradeable: false, tradeableFirstSeenAtMs: null }),
      cand('addon', { isPrivate: true, tradeable: true, tradeableFirstSeenAtMs: null, source: 'private:feed' }),
    ], new Set(), new Map(), T0);
    expect(out.passed.map((c) => c.mint)).toEqual(['addon']);
    expect(out.failCounts).toEqual({ source_not_tradeable: 1 });
  });

  test('D25: first_sight_sources tradeable starts the window at the first TRADEABLE sighting; any = first_seen_at', () => {
    // First seen by gecko 10 min ago, by DexScreener 60 s ago: a 120-s window.
    const coin = cand('late-ds', { firstSeenAtMs: T0 - 600_000, tradeableFirstSeenAtMs: T0 - 60_000 });
    const tradeable = { ...params, entry: { ...params.entry, first_sight_sources: 'tradeable' as const } };
    expect(evaluateAgentCandidates(tradeable, [coin], new Set(), new Map(), T0).passed.map((c) => c.mint)).toEqual(['late-ds']);
    expect(evaluateAgentCandidates(params, [coin], new Set(), new Map(), T0).failCounts).toEqual({ window: 1 });
    // A private mint uses its own first sighting in either mode.
    const addon = cand('addon', { isPrivate: true, firstSeenAtMs: T0 - 60_000, tradeableFirstSeenAtMs: null });
    expect(evaluateAgentCandidates(tradeable, [addon], new Set(), new Map(), T0).passed.map((c) => c.mint)).toEqual(['addon']);
  });

  test('D28: a stale verdict is not passed, for shared AND private mints (chain_verdict_stale)', () => {
    const out = evaluateAgentCandidates(params, [
      cand('stale-shared', { verdict: 'stale', chainCheckedAtMs: T0 - 31 * 60_000 }),
      cand('stale-private', { verdict: 'stale', isPrivate: true, tradeableFirstSeenAtMs: null, source: 'private:feed' }),
      cand('fresh', { verdict: 'pass', chainCheckedAtMs: T0 - 29 * 60_000 }),
    ], new Set(), new Map(), T0);
    expect(out.passed.map((c) => c.mint)).toEqual(['fresh']);
    expect(out.failCounts).toEqual({ chain_verdict_stale: 2 });
  });

  test('Codex r14 insert gate: the verdict is judged again at insertion with the wall clock', () => {
    const tick = T0;
    const insertAt = T0 + 2_000;
    const verdict = (agoAtTickMs: number, over: Record<string, unknown> = {}) => ({
      chainVerdict: { pass: true, fails: [], codes: [], checkedAt: new Date(tick - agoAtTickMs).toISOString(), pairAddress: 'p', top10Pct: 10, ...over },
      chainCheckedAtMs: tick - agoAtTickMs,
      pairAddress: 'p',
    });
    const edge = 30 * 60_000 - 1_000;   // 29m59s at load, 30m01s at insert
    const loaded = cand('edge', { chainCheckedAtMs: tick - edge });
    expect(insertTimeGate(loaded, params.filters, verdict(edge), insertAt, tick)).toEqual({ ok: false, code: 'chain_verdict_stale' });
    // Fresh: passes and records the re-read verdict time.
    expect(insertTimeGate(cand('fresh'), params.filters, verdict(60_000), insertAt, tick))
      .toEqual({ ok: true, features: cand('fresh').features, chainCheckedAtMs: tick - 60_000 });
    // The priced pair changed after the load: the candidate's features are for another pair.
    expect(insertTimeGate(cand('moved'), params.filters, { ...verdict(60_000), pairAddress: 'q' }, insertAt, tick))
      .toEqual({ ok: false, code: 'chain_pending' });
    // The row is gone (an expired add-on mint), or a verdict for another pair: pending.
    expect(insertTimeGate(cand('gone'), params.filters, null, insertAt, tick)).toEqual({ ok: false, code: 'chain_pending' });
    expect(insertTimeGate(cand('other'), params.filters, verdict(60_000, { pairAddress: 'q' }), insertAt, tick))
      .toEqual({ ok: false, code: 'chain_pending' });
    // A fresh FAIL written after the load.
    expect(insertTimeGate(cand('rug'), params.filters, verdict(1_000, { pass: false, fails: ['lp_locked'] }), insertAt, tick))
      .toEqual({ ok: false, code: 'hard_rules' });
    // A newer pass verdict with another top-10 share re-runs the filters and is recorded.
    const capped = { ...params.filters, top10_max_pct: 30 };
    expect(insertTimeGate(cand('whale'), capped, verdict(1_000, { top10Pct: 45 }), insertAt, tick)).toEqual({ ok: false, code: 'top10' });
    expect(insertTimeGate(cand('newer'), capped, verdict(1_000, { top10Pct: 20 }), insertAt, tick))
      .toEqual({ ok: true, features: { ...cand('newer').features, top10Pct: 20 }, chainCheckedAtMs: tick - 1_000 });
  });

  test('audit-contest NIT: a gecko-first entry names the tradeable source that admitted it', () => {
    const geckoFirst = cand('gk', { source: 'gecko:new-pools', tradeableSource: 'ds:token-profiles' });
    expect(entryVia(geckoFirst)).toBe('ds:token-profiles (first seen by gecko:new-pools)');
    const line = entrySummary('GK', 0.001, geckoFirst.features, entryVia(geckoFirst), T0);
    expect(line.endsWith(' via ds:token-profiles (first seen by gecko:new-pools)')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(280);
    // First source already tradeable: unchanged. Private add-on mint: its own source, unchanged.
    expect(entryVia(cand('ds'))).toBe('ds:token-profiles');
    expect(entryVia(cand('pv', { isPrivate: true, source: 'private:feed', tradeableSource: null }))).toBe('private:feed');
  });

  describe('openPosition with a fake transaction: insert-time opened_at (lead decision on audit-contest)', () => {
    /**
     * A transaction that logs every step. openPosition runs: execute #1 the transaction bound (Codex r20), #2 advisory
     * lock, #3 open count, #4 the verdict re-read (FOR SHARE), then the clock, the position insert and the entry-event
     * insert. `failAt` makes that execute throw (a timeout ends the session: the transaction rolls back).
     */
    function fakeDatabase(gateRow: Record<string, unknown> | null, failAt: number | null = null) {
      const log: string[] = [];
      const statements: SQL[] = [];
      const inserted: { position: Record<string, unknown> | null; events: Array<Record<string, unknown>> } = { position: null, events: [] };
      let executes = 0;
      const tx = {
        execute: async (statement: SQL) => {
          executes += 1;
          log.push(`execute${executes}`);
          statements.push(statement);
          if (executes === failAt) {
            throw Object.assign(new Error('terminating connection due to transaction timeout'), { code: '25P04' });
          }
          if (executes === 1) return [{ statement_bound: '30000ms', tx_bound: '60000ms' }];
          if (executes === 3) return [{ n: 0 }];
          if (executes === 4) return gateRow ? [gateRow] : [];
          return [];
        },
        insert: (table: unknown) => ({
          values: (value: unknown) => {
            if (table === floorArenaPositions) {
              log.push('insert:position');
              inserted.position = value as Record<string, unknown>;
              return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'pos-1' }] }) };
            }
            log.push('insert:event');
            inserted.events.push(...(value as Array<Record<string, unknown>>));
            return Promise.resolve();
          },
        }),
      };
      const database = { transaction: async (run: (t: typeof tx) => Promise<unknown>) => run(tx) };
      return { database: database as never, log, inserted, statements };
    }
    const agent = { id: 'house:test', paramsVersion: 3 } as never;
    const quote = {
      ok: true as const, usd: 20, tokens: 19_500, entryPriceUsd: 0.001 / 0.975, decimals: 6, quotedTokens: 20_000,
      impactPct: 1, driftPct: 1, venue: 'jupiter', route: ['x'],
    };
    const gateRow = (checkedAgoMs: number) => ({
      chain_verdict: { pass: true, fails: [], codes: [], checkedAt: new Date(T0 - checkedAgoMs).toISOString(), pairAddress: 'p', top10Pct: 10 },
      chain_checked_at: new Date(T0 - checkedAgoMs),
      pair_address: 'p',
    });

    test('opened_at and the entry event at = max(tick start, clock()), read AFTER the verdict re-read and BEFORE the insert', async () => {
      const { database, log, inserted } = fakeDatabase(gateRow(60_000));
      const clock = () => { log.push('clock'); return T0 + 40_000; };   // a slow tick: the insert runs 40 s after the start
      expect(await openPosition(agent, params, cand('slow'), quote, new Date(T0), clock, database)).toBe('opened');
      expect(log).toEqual(['execute1', 'execute2', 'execute3', 'execute4', 'clock', 'insert:position', 'insert:event']);
      expect(inserted.position!.openedAt).toEqual(new Date(T0 + 40_000));
      expect(inserted.events).toHaveLength(1);
      expect(inserted.events[0]!.type).toBe('entry');
      expect(inserted.events[0]!.at).toEqual(new Date(T0 + 40_000));
      // The rules judged the coin at the tick start; that time stays in the record.
      expect((inserted.position!.entryFeatures as { judgedAt: string }).judgedAt).toBe(new Date(T0).toISOString());
      expect((inserted.events[0]!.data as { chainCheckedAt: string }).chainCheckedAt).toBe(new Date(T0 - 60_000).toISOString());
    });

    test('a clock behind the tick start never stamps an earlier opened_at', async () => {
      const { database, inserted } = fakeDatabase(gateRow(60_000));
      expect(await openPosition(agent, params, cand('skew'), quote, new Date(T0), () => T0 - 5_000, database)).toBe('opened');
      expect(inserted.position!.openedAt).toEqual(new Date(T0));
      expect(inserted.events[0]!.at).toEqual(new Date(T0));
    });

    test('Codex r14 wiring: a verdict 29m59s old at the tick start and 30m01s at the insert clock is refused, nothing inserted', async () => {
      const edge = 30 * 60_000 - 1_000;
      const slow = fakeDatabase(gateRow(edge));
      const slowClock = () => { slow.log.push('clock'); return T0 + 2_000; };
      expect(await openPosition(agent, params, cand('edge', { chainCheckedAtMs: T0 - edge }), quote, new Date(T0), slowClock, slow.database))
        .toEqual({ gate: 'chain_verdict_stale' });
      expect(slow.log).toEqual(['execute1', 'execute2', 'execute3', 'execute4', 'clock']);
      expect(slow.inserted).toEqual({ position: null, events: [] });
      // The same verdict with no delay is still valid: the refusal above came from the insert-time clock.
      const fast = fakeDatabase(gateRow(edge));
      expect(await openPosition(agent, params, cand('edge'), quote, new Date(T0), () => T0, fast.database)).toBe('opened');
    });

    test('Codex r20: the FIRST statement bounds the transaction (transaction_timeout 60 s + statement_timeout 30 s, local)', async () => {
      const { database, statements } = fakeDatabase(gateRow(60_000));
      expect(await openPosition(agent, params, cand('bound'), quote, new Date(T0), () => T0, database)).toBe('opened');
      const first = new PgDialect().sqlToQuery(statements[0]!);
      const text = first.sql.replace(/\s+/g, ' ').trim();
      // Codex r21: reset to 0 FIRST, then arm 60 s. PostgreSQL 17 does not restart an ACTIVE transaction timer when
      // the value changes, so on a connection with a longer session/role transaction_timeout a plain 60 s value would
      // keep the longer timer; 0 disables the active timer and the next value arms a fresh one. The CASE runs its
      // conditions in order: the PG < 17 guard (no such setting: skip, no error), the reset, then the arm.
      expect(text).toBe(
        "SELECT set_config('statement_timeout', $1, true) AS statement_bound, "
        + "CASE WHEN current_setting('transaction_timeout', true) IS NULL THEN NULL "
        + "WHEN set_config('transaction_timeout', '0', true) IS NOT NULL "
        + "THEN set_config('transaction_timeout', $2, true) END AS tx_bound",
      );
      expect(first.params).toEqual(['30000ms', '60000ms']);
      expect([ENTRY_STATEMENT_TIMEOUT_MS, ENTRY_TX_TIMEOUT_MS]).toEqual([30_000, 60_000]);
      // The lock is the SECOND statement: the bound covers the lock wait too.
      expect(new PgDialect().sqlToQuery(statements[1]!).sql).toContain('pg_advisory_xact_lock');
    });

    test('Codex r20 wiring (source pin): the entry loop opens through tryOpenPosition, the only caller of openPosition', () => {
      const source = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8');
      expect(source.match(/await openPosition\(/g)).toHaveLength(1);
      expect(source).toContain('return await openPosition(...args);');
      expect(source).toContain('const opened = await tryOpenPosition(agent, params, c, quote, now, deps.clock ?? Date.now);');
    });

    test('Codex r20: the transaction bound stays below the contest final margin', () => {
      expect(ENTRY_STATEMENT_TIMEOUT_MS).toBeLessThan(ENTRY_TX_TIMEOUT_MS);
      expect(ENTRY_TX_TIMEOUT_MS).toBeLessThan(ARENA_CONTEST_FINAL_GRACE_MS);
    });

    test('Codex r20: a timed-out entry transaction rolls back (nothing inserted) and is reported, not thrown', async () => {
      for (const failAt of [2, 4]) {   // during the lock wait; during the verdict re-read
        const { database, log, inserted } = fakeDatabase(gateRow(60_000), failAt);
        await expect(openPosition(agent, params, cand('slowdb'), quote, new Date(T0), () => T0, database)).rejects.toThrow('transaction timeout');
        const again = fakeDatabase(gateRow(60_000), failAt);
        expect(await tryOpenPosition(agent, params, cand('slowdb'), quote, new Date(T0), () => T0, again.database)).toEqual({ failed: '25P04' });
        expect(again.inserted).toEqual({ position: null, events: [] });
        expect(inserted).toEqual({ position: null, events: [] });
        expect(log.at(-1)).toBe(`execute${failAt}`);
      }
      // An error without a SQLSTATE is reported as 'error'.
      const broken = { transaction: async () => { throw new Error('connection closed'); } } as never;
      expect(await tryOpenPosition(agent, params, cand('down'), quote, new Date(T0), () => T0, broken)).toEqual({ failed: 'error' });
    });
  });

  test('D26: with liq_min off, a pump.fun curve coin (DexScreener liquidity 0) passes', () => {
    const offLiq = { ...params, filters: { ...params.filters, liq_min: null } };
    const out = evaluateAgentCandidates(offLiq, [cand('curve', {}, { dexId: 'pumpfun', liqUsd: 0, mcap: 35_000 })], new Set(), new Map(), T0);
    expect(out.passed.map((c) => c.mint)).toEqual(['curve']);
    expect(out.failCounts).toEqual({});
  });

  test('a cooldown that has run out lets the coin back in', () => {
    const out = evaluateAgentCandidates(params, [cand('recent')], new Set(), new Map([['recent', T0 - 21_600_000]]), T0);
    expect(out.passed.map((c) => c.mint)).toEqual(['recent']);
  });
});

/**
 * Helius budget (founder rule 2026-10-31): a coin is chain-checked only while it is a candidate (passes the NON-chain
 * entry rules of at least one active agent) or held.
 */
describe('chainCheckCandidateMints', () => {
  const OFF: FloorArenaFilters = {
    mcap_min: null, mcap_max: null, liq_min: 5_000, liq_max: null, age_min_s: null, age_max_s: null,
    vol1h_over_mcap_min: null, vol1h_over_mcap_max: null, chg5m_min: null, chg5m_max: null, chg1h_min: null,
    chg1h_max: null, chg6h_min: null, chg6h_max: null, chg24h_min: null, chg24h_max: null, txns1h_min: null,
    txns1h_max: null, top10_max_pct: null,
  };
  function params(filters: Partial<FloorArenaFilters> = {}): FloorArenaParams {
    return {
      filters: { ...OFF, mcap_max: 250_000, ...filters },
      entry: { discovered_within_s: 120, first_sight_sources: 'any', rank_by: 'vol_over_mcap', entries_per_tick: 1 },
      exits: exits({ tp: [[1.1, 1]] }),
      limits: { position_usd: 20, max_open: 5, reentry_cooldown_s: 21_600 },
    };
  }
  function cand(mint: string, over: Partial<ArenaCandidate> = {}, f: Partial<FloorArenaFeatures> = {}): ArenaCandidate {
    return {
      mint, source: 'ds:token-profiles', symbol: mint, firstSeenAtMs: T0 - 30_000,
      features: {
        priceUsd: 0.001, mcap: 100_000, liqUsd: 20_000, liqBase: null, liqQuote: null, pairAddress: 'p', dexId: 'pumpswap',
        quoteMint: null, labels: [], pairCreatedAt: T0 - 3_600_000, ageS: 3_600, chg5m: 0, chg1h: 0, chg6h: 0, chg24h: 0,
        txns1h: 100, vol1h: 10_000, volOverMcap: 0.1, symbol: 'X', name: 'X', top10Pct: null, ...f,
      },
      verdict: 'pending', chainCheckedAtMs: null, isPrivate: false, tradeable: true, tradeableFirstSeenAtMs: T0 - 30_000,
      tradeableSource: 'ds:token-profiles', ...over,
    };
  }
  const sorted = (s: Set<string>) => [...s].sort();

  test('a candidate is eligible; a coin failing a non-chain rule (filter, window, source) is not', () => {
    const shared = [
      cand('cand'), cand('big', {}, { mcap: 300_000 }), cand('late', { firstSeenAtMs: T0 - 121_000 }),
      cand('gecko', { tradeable: false, tradeableFirstSeenAtMs: null }),
    ];
    expect(sorted(chainCheckCandidateMints([{ params: params(), privateCandidates: [] }], shared, [], T0))).toEqual(['cand']);
  });

  test('the verdict counts as pass: pending, stale and fail verdicts stay eligible', () => {
    const shared = [cand('pending'), cand('stale', { verdict: 'stale' }), cand('fail', { verdict: 'fail' }), cand('pass', { verdict: 'pass' })];
    expect(sorted(chainCheckCandidateMints([{ params: params(), privateCandidates: [] }], shared, [], T0)))
      .toEqual(['fail', 'pass', 'pending', 'stale']);
  });

  test('top10_max_pct does not exclude an unchecked coin (and is not judged on a stored share either)', () => {
    const p = params({ top10_max_pct: 20 });
    // The entry gate would fail both (top10_unknown / top10).
    expect(evaluateAgentCandidates(p, [cand('unknown', { verdict: 'pass' })], new Set(), new Map(), T0).failCounts).toEqual({ top10_unknown: 1 });
    const shared = [cand('unknown'), cand('high', { verdict: 'pass' }, { top10Pct: 90 })];
    expect(sorted(chainCheckCandidateMints([{ params: p, privateCandidates: [] }], shared, [], T0))).toEqual(['high', 'unknown']);
  });

  test('a held coin is eligible even when it fails every filter; a cooling coin is still a candidate', () => {
    const shared = [cand('held', {}, { mcap: 999_999_999 }), cand('cooling')];
    // The entry tick would cool 'cooling' (closed 1 min ago, 6 h cooldown); the selector ignores cooldowns.
    expect(evaluateAgentCandidates(params(), [cand('cooling', { verdict: 'pass' })], new Set(), new Map([['cooling', T0 - 60_000]]), T0).passed)
      .toEqual([]);
    expect(sorted(chainCheckCandidateMints([{ params: params(), privateCandidates: [] }], shared, ['held'], T0)))
      .toEqual(['cooling', 'held']);
  });

  test('no active agent: only held mints', () => {
    expect(sorted(chainCheckCandidateMints([], [cand('cand')], ['held'], T0))).toEqual(['held']);
  });

  test('a coin is eligible when ANY agent accepts it', () => {
    const shared = [cand('small', {}, { mcap: 50_000 }), cand('mid', {}, { mcap: 200_000 })];
    const agents = [
      { params: params({ mcap_max: 60_000 }), privateCandidates: [] },
      { params: params({ mcap_min: 150_000 }), privateCandidates: [] },
    ];
    expect(sorted(chainCheckCandidateMints(agents, shared, [], T0))).toEqual(['mid', 'small']);
  });

  test('Codex: a failing private snapshot does not hide a passing shared snapshot of the same mint', () => {
    // The owner's private row is 2 min old and fails liq_min; the fresh shared row passes. runEntryTick drops the
    // private row after 60 s and evaluates the shared one, so the mint must stay eligible.
    const privateRow = cand('both', { isPrivate: true, source: 'private:feed', tradeableFirstSeenAtMs: null, tradeableSource: null }, { liqUsd: 1_000 });
    const sharedRow = cand('both', {}, { liqUsd: 20_000 });
    expect(sorted(chainCheckCandidateMints([{ params: params(), privateCandidates: [privateRow] }], [sharedRow], [], T0))).toEqual(['both']);
    // The other way round: a passing private row and a failing shared row.
    const privatePass = { ...privateRow, features: { ...privateRow.features, liqUsd: 20_000 } };
    const sharedFail = { ...sharedRow, features: { ...sharedRow.features, liqUsd: 1_000 } };
    expect(sorted(chainCheckCandidateMints([{ params: params(), privateCandidates: [privatePass] }], [sharedFail], [], T0))).toEqual(['both']);
  });

  test('a private add-on mint is judged only by its owning agent', () => {
    const addon = (mint: string, f: Partial<FloorArenaFeatures> = {}) =>
      cand(mint, { isPrivate: true, source: 'private:feed', tradeableFirstSeenAtMs: null, tradeableSource: null }, f);
    const agents = [
      // Owner A accepts its add-on; owner B's add-on fails B's own cap (A's rules would accept it).
      { params: params({ mcap_max: 1_000_000 }), privateCandidates: [addon('a-addon', { mcap: 500_000 })] },
      { params: params({ mcap_max: 100_000 }), privateCandidates: [addon('b-addon', { mcap: 500_000 })] },
    ];
    expect(sorted(chainCheckCandidateMints(agents, [], [], T0))).toEqual(['a-addon']);
  });
});
