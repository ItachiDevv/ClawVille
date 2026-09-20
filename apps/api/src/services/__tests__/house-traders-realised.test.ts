import { describe, expect, test } from 'bun:test';
import { TRADE_MINTS } from '@clawville/shared';

import {
  applyTruncationCheck,
  emptyRealised,
  summariseRealised,
  REALISED_NO_EXIT_HOURS,
  type RealisedTradeLeg,
} from '../house-traders';

// PUBLIC live realised P&L (founder order, 2026-09-20), with the clawPump
// corrections of the same day: FIFO lots matched by TOKEN UNITS, a per-lot
// no-exit write-off, and non-USDC quote legs excluded.
//
// The loader only shapes SQL rows, so every rule that can be wrong lives in
// `summariseRealised` and is exercised here with no database. Fixtures F1..F8
// are the audit's list; F2 is the one that separates a correct implementation
// from per-mint netting.

const USDC = TRADE_MINTS.USDC;
const WSOL = TRADE_MINTS.WSOL;
const COIN = 'CoiNMiNT1111111111111111111111111111111111';
const OTHER = 'OthERMiNT111111111111111111111111111111111';

const NOW = 1_800_000_000;
const HOUR = 3600;
const usd = (n: number) => n.toFixed(6);

let seq = 0;
/** A USDC-quoted BUY: spend `costUsd` to receive `units` of `mint`. */
function buy(units: number, costUsd: number, agoHours = 0, mint = COIN, quote: string = USDC): RealisedTradeLeg {
  return {
    signature: `sig-buy-${(seq += 1)}`,
    inputMint: quote,
    outputMint: mint,
    inputAmount: String(Math.round(costUsd * 1e6)),
    outputAmount: String(units),
    notionalUsd: usd(costUsd),
    atSec: NOW - agoHours * HOUR,
    preBind: false,
  };
}
/** A USDC-quoted SELL: give up `units` of `mint` for `proceedsUsd`. */
function sell(units: number, proceedsUsd: number, agoHours = 0, mint = COIN, quote: string = USDC): RealisedTradeLeg {
  return {
    signature: `sig-sell-${(seq += 1)}`,
    inputMint: mint,
    outputMint: quote,
    inputAmount: String(units),
    outputAmount: String(Math.round(proceedsUsd * 1e6)),
    notionalUsd: usd(proceedsUsd),
    atSec: NOW - agoHours * HOUR,
    preBind: false,
  };
}
function run(legs: RealisedTradeLeg[]) {
  return summariseRealised({
    legs,
    usdcMint: USDC,
    quoteMints: [USDC, WSOL],
    nowSec: NOW,
    computedAt: '2026-09-20T05:00:00.000Z',
  });
}
/** Cents, so an exact-integer expectation is not hostage to float display. */
const cents = (n: number) => Math.round(n * 100);

describe('realised P&L, published method', () => {
  test('an empty trader reads as zeros and declares its method', () => {
    const empty = emptyRealised('2026-09-20T05:00:00.000Z');
    expect(empty.closedPositions).toBe(0);
    expect(empty.realisedUsd).toBe(0);
    // null, NOT 0: "nothing closed" and "closed at break-even" differ.
    expect(empty.bestUsd).toBeNull();
    expect(empty.worstUsd).toBeNull();
    expect(empty.basis).toBe('gross_usdc_leg');
    expect(empty.costBasis).toBe('round_trip_fifo');
    expect(empty.noExitHours).toBe(REALISED_NO_EXIT_HOURS);
    // The method is PUBLISHED, not folklore: both halves in the note.
    expect(empty.note).toContain('excludes network fees');
    expect(empty.note).toContain(`no exit after ${REALISED_NO_EXIT_HOURS} hours`);
  });

  test('F1 closed profit: one buy fully exited is one closed trip', () => {
    const out = run([buy(1000, 10, 50), sell(1000, 14, 40)]);
    expect(out.closedPositions).toBe(1);
    expect(out.wins).toBe(1);
    expect(out.losses).toBe(0);
    expect(cents(out.realisedUsd)).toBe(cents(4));
    expect(out.openPositions).toBe(0);
    expect(out.noExitClosures).toBe(0);
  });

  // ── THE DISCRIMINATING CASE ────────────────────────────────────────────────
  test('F2 two buys at different prices + partial sell, open lot YOUNG: +4, open cost excluded', () => {
    // Per-MINT netting would give 14 - (10 + 24) = -20 and call it realised.
    // FIFO by units realises only the matched lot: +4, with lot 2 still open.
    const out = run([
      buy(1000, 10, 50),      // lot 1: 1000 units cost $10
      buy(1000, 24, 5),       // lot 2: 1000 units cost $24, YOUNGER than 24h
      sell(1000, 14, 4),      // sells exactly lot 1
    ]);
    expect(cents(out.realisedUsd)).toBe(cents(4));
    expect(cents(out.realisedUsd)).not.toBe(cents(-20));
    expect(out.closedPositions).toBe(1);
    expect(out.wins).toBe(1);
    // Lot 2 is open, young, and its cost is reported rather than realised.
    expect(out.openPositions).toBe(1);
    expect(cents(out.openCostUsd)).toBe(cents(24));
    expect(out.noExitClosures).toBe(0);
  });

  test('F3 same book with the open lot OLD: the stale lot is written off, -20', () => {
    const out = run([
      buy(1000, 10, 50),
      buy(1000, 24, REALISED_NO_EXIT_HOURS + 6),  // now older than the window
      sell(1000, 14, 4),
    ]);
    expect(cents(out.realisedUsd)).toBe(cents(-20));
    expect(out.closedPositions).toBe(2);
    expect(out.noExitClosures).toBe(1);
    expect(out.openPositions).toBe(0);
    expect(cents(out.openCostUsd)).toBe(0);
    expect(cents(out.worstUsd ?? 0)).toBe(cents(-24));
  });

  test('F4 buy only, OLD: a rug closes at minus the spend', () => {
    // Without this rule Genesis reads profitable: its worst trade never sold.
    const out = run([buy(1000, 10.2, REALISED_NO_EXIT_HOURS + 1)]);
    expect(cents(out.realisedUsd)).toBe(cents(-10.2));
    expect(out.closedPositions).toBe(1);
    expect(out.losses).toBe(1);
    expect(out.noExitClosures).toBe(1);
    expect(out.openPositions).toBe(0);
  });

  test('F5 buy only, YOUNG: excluded from realised, and NOT break-even', () => {
    const out = run([buy(1000, 10, 1)]);
    expect(out.closedPositions).toBe(0);
    expect(out.realisedUsd).toBe(0);
    // The caller must be able to tell this from a real 0.00 result.
    expect(out.openPositions).toBe(1);
    expect(cents(out.openCostUsd)).toBe(cents(10));
    expect(out.bestUsd).toBeNull();
    expect(out.worstUsd).toBeNull();
  });

  test('F6 a later buy on the same mint opens a NEW trip and does not reset the old lot clock', () => {
    // Genesis bought TIGRINO twice and exited over several sells: two trips.
    const out = run([
      buy(1000, 10, 60), sell(1000, 11.92, 55),   // trip 1: +1.92
      buy(1000, 10, 40), sell(1000, 10.18, 35),   // trip 2: +0.18
    ]);
    expect(out.closedPositions).toBe(2);
    expect(cents(out.realisedUsd)).toBe(cents(2.1));
    expect(cents(out.bestUsd ?? 0)).toBe(cents(1.92));
    expect(cents(out.worstUsd ?? 0)).toBe(cents(0.18));

    // And the clock is PER LOT: a fresh buy must not rescue a stale older lot.
    const stale = run([
      buy(1000, 10, REALISED_NO_EXIT_HOURS + 10),  // stale, never sold
      buy(1000, 10, 1),                            // young re-entry
    ]);
    expect(stale.noExitClosures).toBe(1);
    expect(stale.openPositions).toBe(1);
    expect(cents(stale.realisedUsd)).toBe(cents(-10));
  });

  test('F7 a SOL-quoted leg excludes that mint whole and is disclosed', () => {
    const out = run([
      buy(1000, 10, 50, COIN, WSOL),   // entry funded in SOL
      sell(1000, 14, 40, COIN, USDC),  // exit in USDC
      buy(500, 5, 50, OTHER), sell(500, 6, 40, OTHER),  // a clean USDC position
    ]);
    // Only the clean position counts.
    expect(out.closedPositions).toBe(1);
    expect(cents(out.realisedUsd)).toBe(cents(1));
    expect(out.excludedNonUsdc).toBe(1);
  });

  test('F8 a sell with no prior buy books NO phantom profit', () => {
    // Proceeds with no cost basis are exactly what a truncated window invents.
    const out = run([sell(1000, 80, 10)]);
    expect(out.closedPositions).toBe(0);
    expect(out.realisedUsd).toBe(0);
    expect(out.unmatchedSells).toBe(1);
    expect(out.bestUsd).toBeNull();
  });

  test('an unpriced leg excludes its mint and is counted, never valued at zero', () => {
    const noPrice = { ...buy(1000, 10, 50), notionalUsd: null };
    const out = run([noPrice, sell(1000, 14, 40)]);
    expect(out.unpricedLegs).toBe(1);
    expect(out.closedPositions).toBe(0);
    expect(out.realisedUsd).toBe(0);
  });

  test('pre-bind history is INCLUDED and declared', () => {
    const legs = [buy(1000, 10, 50), sell(1000, 14, 40)];
    legs[0] = { ...legs[0]!, preBind: true };
    expect(run(legs).preBindIncluded).toBe(true);
    expect(run([buy(1000, 10, 50), sell(1000, 14, 40)]).preBindIncluded).toBe(false);
  });

  test('token amounts beyond 2^53 survive: BigInt units, never Number()', () => {
    // A 9-decimal memecoin in base units blows past Number.MAX_SAFE_INTEGER.
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const out = run([
      { ...buy(1, 10, 50), outputAmount: huge.toString() },
      { ...sell(1, 12, 40), inputAmount: huge.toString() },
    ]);
    expect(out.closedPositions).toBe(1);
    expect(cents(out.realisedUsd)).toBe(cents(2));
  });

  test('publishes the trade count it was computed over, so truncation is detectable', () => {
    // tf3d-interior2's lie-detector: compare with `counts.verified` downstream.
    const legs = [buy(1000, 10, 50), sell(1000, 14, 40), buy(1000, 10, 1)];
    expect(run(legs).computedOverTrades).toBe(3);
  });
});

describe('per-sell realised micro-USD', () => {
  test('F1 attributes the closed lot result only to its sell signature', () => {
    const entry = buy(1000, 10, 50);
    const exit = sell(1000, 14, 40);
    const out = run([entry, exit]);
    expect(out.sellRealisedMicros.get(exit.signature)).toBe(4_000_000n);
    expect(out.sellRealisedMicros.has(entry.signature)).toBe(false);
    expect(out.sellRealisedMicros.size).toBe(1);
  });

  test('a partial exit realises only its share of the lot cost', () => {
    const exit = sell(400, 6, 4);
    const out = run([buy(1000, 10, 5), exit]);
    expect(out.sellRealisedMicros.get(exit.signature)).toBe(2_000_000n);
    expect(out.realisedUsd).toBe(2);
    expect(out.openCostUsd).toBe(6);
    expect(out.closedPositions).toBe(0);
  });

  test('an oversell attributes only matched proceeds and omits an orphan sell', () => {
    const exit = sell(1500, 18, 4);
    const orphan = sell(1000, 80, 3);
    const out = run([buy(1000, 10, 5), exit, orphan]);
    expect(out.sellRealisedMicros.get(exit.signature)).toBe(2_000_000n);
    expect(out.sellRealisedMicros.has(orphan.signature)).toBe(false);
    expect(out.realisedUsd).toBe(2);
    expect(out.unmatchedSells).toBe(2);
  });

  test('multi-lot allocations retain the final micro-dollar remainder', () => {
    const exit = sell(1000001, 0.000003, 40);
    const out = run([buy(500000, 0.000001, 50), buy(500001, 0.000001, 50), exit]);
    expect(out.sellRealisedMicros.get(exit.signature)).toBe(1n);
    expect(out.realisedUsd).toBe(0.000001);
  });

  test('per-sell totals equal the headline less signed no-exit write-offs', () => {
    const first = sell(400, 6, 40);
    const second = sell(200, 1, 35);
    const out = run([buy(1000, 10, 50), first, second]);
    expect(out.sellRealisedMicros.get(first.signature)).toBe(2_000_000n);
    expect(out.sellRealisedMicros.get(second.signature)).toBe(-1_000_000n);
    const sum = [...out.sellRealisedMicros.values()].reduce((total, micros) => total + micros, 0n);
    const signedWriteOffMicros = -4_000_000n;
    expect(sum).toBe(BigInt(Math.round(out.realisedUsd * 1e6)) - signedWriteOffMicros);
    expect(out.realisedUsd).toBe(-3);
    expect(out.noExitClosures).toBe(1);
    expect(out.sellRealisedMicros.size).toBe(2);
    expect(run([buy(1000, 10.2, 50)]).sellRealisedMicros.size).toBe(0);
  });

  test('a genuine break-even sell has an explicit zero entry', () => {
    const exit = sell(1000, 10, 4);
    const out = run([buy(1000, 10, 5), exit]);
    expect(out.sellRealisedMicros.has(exit.signature)).toBe(true);
    expect(out.sellRealisedMicros.get(exit.signature)).toBe(0n);
  });

  test('excluded mints have no sell entries, including otherwise valid exits', () => {
    for (const entry of [
      buy(1000, 10, 50, COIN, WSOL),
      { ...buy(1000, 10, 50), notionalUsd: null },
      { ...buy(1000, 10, 50), notionalUsd: '-10.000000' },
      { ...buy(1000, 10, 50), atSec: Number.NaN },
    ]) {
      const exit = sell(1000, 14, 40);
      const out = run([entry, exit]);
      expect(out.sellRealisedMicros.has(exit.signature)).toBe(false);
      expect(out.sellRealisedMicros.size).toBe(0);
    }
  });
});

describe('failure direction: an unknown date must never become a loss', () => {
  // The bug this pins: `Number(row.atSec) || 0` dated an unparseable timestamp
  // to epoch 1970, which is older than the no-exit window, so a perfectly live
  // position was written off as a TOTAL LOSS it never took. A fabricated loss
  // is a worse failure than an admitted gap, so an undated leg is excluded and
  // counted instead.
  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY] as const) {
    test(`atSec ${String(bad)} excludes the position instead of writing it off`, () => {
      const out = run([{ ...buy(1000, 10, 0), atSec: bad }]);
      expect(out.undatedLegs).toBe(1);
      // The decisive assertion: no invented loss.
      expect(out.realisedUsd).toBe(0);
      expect(out.closedPositions).toBe(0);
      expect(out.noExitClosures).toBe(0);
      // And the gap is disclosed rather than hidden.
      expect(out.partial).toBe(true);
    });
  }

  test('a dated position on the same book is unaffected by an undated one', () => {
    const out = run([
      { ...buy(1000, 10, 0, OTHER), atSec: Number.NaN },
      buy(1000, 10, 50), sell(1000, 14, 40),
    ]);
    expect(out.undatedLegs).toBe(1);
    expect(cents(out.realisedUsd)).toBe(cents(4));
    expect(out.closedPositions).toBe(1);
    expect(out.partial).toBe(true);
  });

  test('a clean book is NOT flagged partial', () => {
    const out = run([buy(1000, 10, 50), sell(1000, 14, 40)]);
    expect(out.partial).toBe(false);
    expect(out.undatedLegs).toBe(0);
  });
});

describe('an impossible notional must never mint profit', () => {
  // Codex R4: a NEGATIVE notional on a buy gives the lot a negative `costLeft`,
  // so the no-exit write-off (`realised -= costLeft`) SUBTRACTS a negative and
  // books a GAIN on a position that never sold. A bad row must never create
  // money, so the whole mint is excluded and counted.
  test('a negative-notional buy with no sell reports nothing, not a win', () => {
    const out = run([{ ...buy(1000, 10, REALISED_NO_EXIT_HOURS + 1), notionalUsd: '-10.000000' }]);
    expect(out.realisedUsd).toBe(0);
    expect(out.wins).toBe(0);
    expect(out.closedPositions).toBe(0);
    expect(out.noExitClosures).toBe(0);
    expect(out.invalidLegs).toBe(1);
    expect(out.partial).toBe(true);
  });

  test('a zero notional is excluded too: a free buy makes any sale pure profit', () => {
    const out = run([
      { ...buy(1000, 10, 50), notionalUsd: '0.000000' },
      sell(1000, 14, 40),
    ]);
    expect(out.realisedUsd).toBe(0);
    expect(out.closedPositions).toBe(0);
    expect(out.invalidLegs).toBe(1);
    expect(out.partial).toBe(true);
  });

  test('a negative notional on a SELL is excluded as well', () => {
    const out = run([buy(1000, 10, 50), { ...sell(1000, 14, 40), notionalUsd: '-14.000000' }]);
    expect(out.invalidLegs).toBe(1);
    expect(out.realisedUsd).toBe(0);
    expect(out.closedPositions).toBe(0);
  });

  test('a clean book beside a poisoned one is unaffected', () => {
    const out = run([
      { ...buy(1000, 10, 50, OTHER), notionalUsd: '-10.000000' },
      buy(1000, 10, 50), sell(1000, 14, 40),
    ]);
    expect(out.invalidLegs).toBe(1);
    expect(cents(out.realisedUsd)).toBe(cents(4));
    expect(out.closedPositions).toBe(1);
  });
});

describe('a sell split across lots must conserve its proceeds exactly', () => {
  // Codex R4: allocating `proceeds * matched / sold` independently per lot
  // TRUNCATES each allocation, so the integer remainder is dropped and the
  // sell appears to return less than it did, inventing a loss.
  const micros = (n: number) => Math.round(n * 1e6);

  test('two lots: the allocations sum to the proceeds, with no invented loss', () => {
    // 500000 + 500001 units against 3 micro-dollars: naive truncation gives
    // 1 + 1 and loses the third micro-dollar.
    const out = run([
      { ...buy(500000, 0.000001, 50) },
      { ...buy(500001, 0.000001, 50) },
      { ...sell(1000001, 0.000003, 40) },
    ]);
    expect(out.closedPositions).toBe(2);
    // Proceeds 3 micros minus cost 2 micros = +1 micro, exactly.
    expect(micros(out.realisedUsd)).toBe(1);
    expect(out.losses).toBe(0);
  });

  test('three lots: still exact, and the remainder lands on the final allocation', () => {
    const out = run([
      { ...buy(333333, 0.000001, 50) },
      { ...buy(333333, 0.000001, 50) },
      { ...buy(333334, 0.000001, 50) },
      { ...sell(1000000, 0.000005, 40) },
    ]);
    expect(out.closedPositions).toBe(3);
    // 5 micros proceeds minus 3 micros cost = +2 micros, no rounding leak.
    expect(micros(out.realisedUsd)).toBe(2);
  });

  test('a partial sell across two lots still conserves what it realised', () => {
    // Both lots YOUNG on purpose: the remainder must stay open rather than be
    // written off, or this stops testing proceeds conservation and starts
    // testing the rug rule instead.
    const out = run([
      { ...buy(1000, 10, 5) },
      { ...buy(1000, 10, 5) },
      { ...sell(1500, 18, 4) },   // closes lot 1, half-closes lot 2
    ]);
    // Realised = 18 proceeds - (10 for lot1 + 5 for half of lot2) = +3.
    expect(cents(out.realisedUsd)).toBe(cents(3));
    expect(out.closedPositions).toBe(1);
    expect(out.openPositions).toBe(1);
    // The untouched half of lot 2 keeps its own cost basis.
    expect(cents(out.openCostUsd)).toBe(cents(5));
  });
});

describe('truncation alarm is read by code, not by a human', () => {
  const clean = () => run([buy(1000, 10, 50), sell(1000, 14, 40)]);

  test('agreement leaves the figure alone', () => {
    const out = clean();
    expect(out.computedOverTrades).toBe(2);
    const checked = applyTruncationCheck(out, 2, 'Genesis');
    expect(checked.partial).toBe(false);
    expect(checked).toEqual(out);
  });

  test('a SHORT read marks the figure PARTIAL rather than publishing it as final', () => {
    // The slot knows about 40 verified trades; the figure covered 2. That is
    // the Genesis -5.20 -> +8.87 shape, and it must never present as final.
    const checked = applyTruncationCheck(clean(), 40, 'Genesis');
    expect(checked.partial).toBe(true);
    // The figure itself is not silently altered; it is labelled.
    expect(checked.realisedUsd).toBe(clean().realisedUsd);
  });

  test('a mismatch in EITHER direction is caught', () => {
    expect(applyTruncationCheck(clean(), 1, 'Genesis').partial).toBe(true);
    expect(applyTruncationCheck(clean(), 0, 'Genesis').partial).toBe(true);
  });

  test('an already-partial figure stays partial when counts agree', () => {
    const partialFigure = run([
      { ...buy(1000, 10, 50), notionalUsd: null },
      buy(1000, 10, 50, OTHER), sell(1000, 14, 40, OTHER),
    ]);
    expect(partialFigure.partial).toBe(true);
    expect(applyTruncationCheck(partialFigure, partialFigure.computedOverTrades, 'Genesis').partial).toBe(true);
  });
});

describe('realised P&L truncation guard', () => {
  // THE bug the whole aggregation exists to prevent. A 50-row window read
  // Genesis as +8.87 when the true figure was -5.20, because the window kept
  // sell legs whose buy legs had scrolled off: cost basis vanished and turned
  // into apparent profit.
  const full: RealisedTradeLeg[] = [
    buy(1000, 40, 90), sell(600, 11, 80), sell(400, 7, 70),
    buy(1000, 35, 60), sell(1000, 21, 50),
    buy(1000, 12, 40), sell(1000, 30, 30),
  ];
  // What a recent window sees: the first two buys have scrolled off.
  const windowed = full.slice(3);

  test('the full-history figure is the honest one and the window disagrees, flatteringly', () => {
    const whole = run(full);
    const slice = run(windowed);

    expect(whole.closedPositions).toBe(3);
    expect(cents(whole.realisedUsd)).toBe(cents(-18));

    // The window books the orphan sell as nothing but keeps the winners.
    expect(slice.realisedUsd).toBeGreaterThan(whole.realisedUsd);
    expect(slice.closedPositions).toBeLessThan(whole.closedPositions);
    expect(cents(slice.realisedUsd)).not.toBe(cents(whole.realisedUsd));
  });

  test('a truncated read is visible downstream through computedOverTrades', () => {
    expect(run(full).computedOverTrades).toBe(full.length);
    expect(run(windowed).computedOverTrades).toBeLessThan(full.length);
  });
});
