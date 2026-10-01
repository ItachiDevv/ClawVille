import { describe, expect, test } from 'bun:test';
import type { FloorArenaExits, FloorArenaFilters, FloorArenaParams } from '@clawville/shared';
import {
  advanceExitRun, applyExitFill, classifyExitAttempt, combineFillSource, d4Decision, decideExitTrigger, evaluateAgentCandidates,
  exitSummary, freshBookingAllowed, insertTimeGate, keepNewerMark, markNewerThanDecision, markStillFresh, newestKnownMark, parseExitRun,
  quotedTpMultiple, tpConfirmedByQuote, tpSkipRunUpdate, type D4Outcome,
  topFailCodes, tpHitsFromRemaining, type ArenaCandidate, type ExitState,
} from './engine';
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
      chainCheckedAtMs: T0 - 60_000, isPrivate: false, tradeable: true, tradeableFirstSeenAtMs: T0 - 30_000, ...over,
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
