import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { floorArenaPositions } from '@clawville/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { FloorArenaExits, FloorArenaFilters, FloorArenaParams } from '@clawville/shared';
import {
  advanceExitRun, applyExitFill, chainCheckCandidateMints, classifyExitAttempt, combineFillSource, d4Decision, decideExitTrigger, entrySummary, entryVia, evaluateAgentCandidates,
  ENTRY_STATEMENT_TIMEOUT_MS, ENTRY_TX_TIMEOUT_MS, exitSummary, freshBookingAllowed, insertTimeGate, keepNewerMark, openPosition,
  tryOpenPosition, markNewerThanDecision, markStillFresh, newestKnownMark, parseExitRun,
  quotedTpMultiple, tpConfirmedByQuote, tpSkipRunUpdate, type D4Outcome,
  topFailCodes, tpHitsFromRemaining, type ArenaCandidate, type ExitState,
  breakevenMarkMult, liquidityBelow, liquidityShadowCrossings, LIQ_SHADOW_THRESHOLDS, recordLiquidityShadow,
  type ExitLiquidity, type ExitTrigger, type LiqShadowDeps,
} from './engine';
import { markFallbackProceeds } from './pricing';
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
