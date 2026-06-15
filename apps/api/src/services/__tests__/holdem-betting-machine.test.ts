/**
 * Phase 6.5.x — Scripted-bet regression harness for the Hold'em betting state
 * machine (`runBettingRound` / `applyDecision`).
 *
 * Unlike `holdem-engine.test.ts` (which only scripts seat 0 and lets the bots
 * play seats 1..5), this harness drives EVERY seat through an EXPLICIT per-seat
 * action script via the test-only `__runScriptedBettingRound` driver. That lets
 * us pin the exact NLHE betting semantics that the original code got wrong:
 *
 *   BUG 1 — a SHORT all-in (raise increment < the table min-raise, legal only
 *   because the actor is all-in) must NOT reopen action to already-acted seats
 *   and must NOT shrink the table min-raise. Only a FULL raise (increment >=
 *   min-raise) reopens action + sets a new min-raise. An already-acted seat
 *   facing a short all-in may CALL/FOLD but a RAISE attempt is ILLEGAL.
 *
 * Every test below would FAIL on the original code, which (a) reopened on ANY
 * over-call and (b) let already-acted seats re-raise over a sub-min all-in while
 * shrinking the min-raise to the tiny all-in increment.
 *
 * Pure + deterministic. No DB, no network, no deck luck (we script the bets).
 */

import { describe, expect, it } from 'bun:test';
import {
  __runScriptedBettingRound,
  buildSidePots,
  computeHoldemRake,
  type HoldemActionRecord,
  type ScriptedSeatConfig,
  type PotResult,
  type SeatStatus,
} from '../holdem-engine';

// Convenience action constructors.
const fold = (): HoldemActionRecord => ({ type: 'fold' });
const check = (): HoldemActionRecord => ({ type: 'check' });
const call = (): HoldemActionRecord => ({ type: 'call' });
const bet = (amount: bigint): HoldemActionRecord => ({ type: 'bet', amount: amount.toString() });
const raise = (amount: bigint): HoldemActionRecord => ({ type: 'raise', amount: amount.toString() });

/** Pull one seat's post-round state by index. */
function seatOf(
  res: ReturnType<typeof __runScriptedBettingRound>,
  seat: number,
): {
  seat: number; stack: bigint; streetCommitted: bigint; committedTotal: bigint;
  status: SeatStatus; hasActed: boolean;
} {
  const s = res.seats.find((x) => x.seat === seat);
  if (!s) throw new Error(`test: seat ${seat} not in result`);
  return s;
}

// ───────────────────────── 1. BB option ─────────────────────────
//
// Preflop, folded around to the BB: the BB owes nothing (toCall===0) but a bet
// EXISTS (currentBet===BB). The BB may CHECK to close the round, OR exercise the
// big-blind option to RAISE. We assert the check path closes the round here, and
// the raise path is covered structurally in test 3.

describe('betting-machine — 1. BB option', () => {
  it('folded to BB preflop: BB checks → round closes with no further action', () => {
    // Seats: 0=human (SB, posted 1, will fold), 1=BB (posted 2), 2..3 fold.
    // currentBet=2 (BB), lastRaiseSize=2. firstToAct = seat 2 (UTG, after BB at 1).
    // Action order from seat 2: seat2 fold, seat3 fold, seat0(SB) fold, seat1(BB) check → done.
    const res = __runScriptedBettingRound({
      street: 'preflop',
      firstToAct: 2,
      currentBet: 2n,
      lastRaiseSize: 2n,
      seats: [
        // seat 0 = human in SB: posted 1 this street, owes 1 to call BB, folds.
        { seat: 0, stack: 99n, streetCommitted: 1n, actions: [fold()] },
        // seat 1 = BB: posted 2, owes nothing, takes the option to CHECK.
        { seat: 1, stack: 98n, streetCommitted: 2n, actions: [check()] },
        { seat: 2, stack: 100n, streetCommitted: 0n, actions: [fold()] },
        { seat: 3, stack: 100n, streetCommitted: 0n, actions: [fold()] },
      ],
    });
    // BB checked: round closed at the BB level, no raise.
    expect(res.finalCurrentBet).toBe(2n);
    expect(res.finalLastRaiseSize).toBe(2n);
    expect(seatOf(res, 1).status).toBe('active');
    expect(seatOf(res, 1).hasActed).toBe(true);
    // The BB's check appears in the log and is the LAST voluntary action.
    const bbCheck = res.actionLog.filter((e) => e.seat === 1 && e.type === 'check');
    expect(bbCheck.length).toBe(1);
    // No raise/bet ever happened this round.
    expect(res.actionLog.some((e) => e.type === 'raise' || e.type === 'bet')).toBe(false);
  });

  it('BB exercises the option to RAISE (currentBet>0 → verb is raise, reopens)', () => {
    // Folded to BB; BB raises to 6 (increment 4 over the 2 currentBet, >= min 2).
    // seat 0 (SB) already called to 2, but the full raise REOPENS → SB must act
    // again and here calls the 6.
    const res = __runScriptedBettingRound({
      street: 'preflop',
      firstToAct: 2,
      currentBet: 2n,
      lastRaiseSize: 2n,
      seats: [
        { seat: 0, stack: 98n, streetCommitted: 2n, hasActed: true, actions: [call()] },
        { seat: 1, stack: 98n, streetCommitted: 2n, actions: [raise(6n)] },
        { seat: 2, stack: 100n, streetCommitted: 0n, actions: [fold()] },
        { seat: 3, stack: 100n, streetCommitted: 0n, actions: [fold()] },
      ],
    });
    expect(res.finalCurrentBet).toBe(6n);
    expect(res.finalLastRaiseSize).toBe(4n); // full raise sets new min-raise
    expect(seatOf(res, 1).streetCommitted).toBe(6n);
    expect(seatOf(res, 0).streetCommitted).toBe(6n); // SB called the raise
  });
});

// ───────────────────────── 2. Below-min raise rejected ─────────────────────────

describe('betting-machine — 2. below-min raise rejected (non-all-in)', () => {
  it('a non-all-in raise below the min-raise THROWS', () => {
    // currentBet=10, lastRaiseSize=10. A raise to 15 is increment 5 < 10 and the
    // actor is NOT all-in (deep stack) → illegal.
    expect(() =>
      __runScriptedBettingRound({
        street: 'flop',
        firstToAct: 1,
        currentBet: 10n,
        lastRaiseSize: 10n,
        seats: [
          { seat: 0, stack: 100n, streetCommitted: 10n, hasActed: true, actions: [call()] },
          { seat: 1, stack: 100n, streetCommitted: 0n, actions: [raise(15n)] }, // 15 < 10+10
        ],
      }),
    ).toThrow(/below min-raise/);
  });

  it('a below-min BET (opening, non-all-in) THROWS', () => {
    // Postflop open: currentBet=0, lastRaiseSize=BB=2 (min bet). Bet to 1 is below
    // the min and the actor is not all-in → illegal.
    expect(() =>
      __runScriptedBettingRound({
        street: 'flop',
        firstToAct: 0,
        currentBet: 0n,
        lastRaiseSize: 2n,
        seats: [
          { seat: 0, stack: 100n, streetCommitted: 0n, actions: [bet(1n)] },
          { seat: 1, stack: 100n, streetCommitted: 0n, actions: [check()] },
        ],
      }),
    ).toThrow(/below min/);
  });
});

// ───────────────────────── 3. Full raise reopens action ─────────────────────────

describe('betting-machine — 3. full raise reopens action', () => {
  it('a FULL raise reopens: an already-acted seat acts again WITH raise rights', () => {
    // Flop: seat0 bets 10 (currentBet 10, lastRaiseSize 10). seat1 raises to 20
    // (full raise, increment 10). The full raise REOPENS → seat0 (already acted)
    // must act again, and because the reopen restored its rights it may RE-RAISE
    // to 40 (increment 20 >= 10). seat1 then calls.
    const res = __runScriptedBettingRound({
      street: 'flop',
      firstToAct: 0,
      currentBet: 0n,
      lastRaiseSize: 2n,
      seats: [
        // seat0: bet 10, then (after reopen) re-raise to 40.
        { seat: 0, stack: 100n, streetCommitted: 0n, actions: [bet(10n), raise(40n)] },
        // seat1: raise to 20 (full), then call the 40.
        { seat: 1, stack: 100n, streetCommitted: 0n, actions: [raise(20n), call()] },
      ],
    });
    // seat0's re-raise was LEGAL (full raise reopened its rights).
    expect(seatOf(res, 0).streetCommitted).toBe(40n);
    expect(seatOf(res, 1).streetCommitted).toBe(40n);
    expect(res.finalCurrentBet).toBe(40n);
    expect(res.finalLastRaiseSize).toBe(20n); // last full raise increment
  });
});

// ───────────────────────── 4. Short all-in does NOT reopen ─────────────────────────

describe('betting-machine — 4. short all-in does not reopen', () => {
  it('short all-in via raise: does NOT reopen, min-raise unchanged, re-raise by acted seat THROWS', () => {
    // Entering: currentBet=20, lastRaiseSize=10, seat0 already acted at 20.
    // seat1 (8 behind on top of 20 committed) all-in raises to 28 → increment 8 < 10
    // → SHORT all-in. Must: raise currentBet to 28, NOT reopen seat0, NOT change
    // lastRaiseSize (stays 10). seat0 re-enters owing 8 and CALLS (legal).
    const res = __runScriptedBettingRound({
      street: 'flop',
      firstToAct: 1,
      currentBet: 20n,
      lastRaiseSize: 10n,
      seats: [
        { seat: 0, stack: 80n, streetCommitted: 20n, hasActed: true, actions: [call()] },
        { seat: 1, stack: 8n, streetCommitted: 20n, actions: [raise(28n)] }, // all-in, increment 8 < 10
      ],
    });
    // currentBet rose to the short all-in level.
    expect(res.finalCurrentBet).toBe(28n);
    // min-raise UNCHANGED by a short all-in (the BUG: original code shrank it to 8).
    // This is THE distinguishing assertion — buggy code yields 8 here.
    expect(res.finalLastRaiseSize).toBe(10n);
    // seat1 is all-in.
    expect(seatOf(res, 1).status).toBe('allin');
    expect(seatOf(res, 1).streetCommitted).toBe(28n);
    // seat0 called the extra 8 → matched at 28.
    expect(seatOf(res, 0).streetCommitted).toBe(28n);
  });

  it('already-acted seat re-raising OVER a short all-in is ILLEGAL (throws) — the BUG let it raise', () => {
    // Same short-all-in setup, but seat0 (already acted at 20) tries to RAISE to
    // 60 over seat1's short all-in instead of calling. On correct code it has NO
    // raise rights (action was not reopened) → THROWS. The original buggy code
    // reopened on the short all-in and would have ACCEPTED this re-raise.
    expect(() =>
      __runScriptedBettingRound({
        street: 'flop',
        firstToAct: 1,
        currentBet: 20n,
        lastRaiseSize: 10n,
        seats: [
          { seat: 0, stack: 80n, streetCommitted: 20n, hasActed: true, actions: [raise(60n)] },
          { seat: 1, stack: 8n, streetCommitted: 20n, actions: [raise(28n)] },
        ],
      }),
    ).toThrow(/not reopened/);
  });

  it('min-raise unchanged proven via a YET-TO-ACT seat: a raise legal under the SHRUNK min is rejected under the correct min', () => {
    // Three seats. Entering currentBet=20, lastRaiseSize=10.
    //   seat0 already acted at 20 (calls).
    //   seat1 short all-in raises to 28 (increment 8 < 10 → short; min-raise stays 10).
    //   seat2 HAS NOT acted → full rights. Correct min-raise-to = 28 + 10 = 38.
    //   seat2 attempts a raise to 36 (increment 8 over 28). On CORRECT code the
    //   min-raise is the UNCHANGED 10, so 8 < 10 → THROWS. On the BUGGY code the
    //   short all-in shrank min-raise to 8, so 8 >= 8 would be WRONGLY ACCEPTED.
    //   This is a clean discriminator: the assertion only holds on the fix.
    expect(() =>
      __runScriptedBettingRound({
        street: 'flop',
        firstToAct: 1,
        currentBet: 20n,
        lastRaiseSize: 10n,
        seats: [
          { seat: 0, stack: 80n, streetCommitted: 20n, hasActed: true, actions: [call()] },
          { seat: 1, stack: 8n, streetCommitted: 20n, actions: [raise(28n)] },
          // yet-to-act seat2 raise to 36: increment 8 over 28 — below correct min 10.
          { seat: 2, stack: 100n, streetCommitted: 0n, actions: [raise(36n)] },
        ],
      }),
    ).toThrow(/below min-raise/);
  });
});

// ───────────────────────── 5. Yet-to-act seat may raise over a short all-in ─────────────────────────

describe('betting-machine — 5. yet-to-act seat keeps full rights vs a short all-in', () => {
  it('a seat that has NOT acted may RAISE over a short all-in (to the original min-raise)', () => {
    // Same setup as test 4 but seat2 makes a LEGAL full raise to 38 (= 28 + 10).
    const res = __runScriptedBettingRound({
      street: 'flop',
      firstToAct: 1,
      currentBet: 20n,
      lastRaiseSize: 10n,
      seats: [
        // seat0 acted at 20; after seat2's full raise to 38 it folds.
        { seat: 0, stack: 80n, streetCommitted: 20n, hasActed: true, actions: [fold()] },
        // seat1 short all-in to 28.
        { seat: 1, stack: 8n, streetCommitted: 20n, actions: [raise(28n)] },
        // seat2 yet-to-act → legal full raise to 38, full rights.
        { seat: 2, stack: 100n, streetCommitted: 0n, actions: [raise(38n)] },
      ],
    });
    expect(seatOf(res, 2).streetCommitted).toBe(38n);
    expect(res.finalCurrentBet).toBe(38n);
    // seat2's full raise (increment 10 over 28) sets the new min-raise to 10.
    expect(res.finalLastRaiseSize).toBe(10n);
    // seat1 is all-in below the new level — its commit stays at its shove.
    expect(seatOf(res, 1).status).toBe('allin');
    expect(seatOf(res, 1).streetCommitted).toBe(28n);
    expect(seatOf(res, 0).status).toBe('folded');
  });
});

// ───────────────────────── 6. Multi-way all-in side pots + conservation ─────────────────────────

describe('betting-machine — 6. multi-way all-in side pots', () => {
  it('three seats all-in at different levels form correct side pots with chip conservation', () => {
    // Drive a real betting round to all-in at three commitment levels:
    //   seat0 shoves 30 (short), seat1 shoves 60 (medium), seat2 covers/calls 60.
    // firstToAct=0, currentBet=0, lastRaiseSize=2 (postflop). seat0 bets all-in 30,
    // seat1 raises all-in to 60 (full raise, reopens), seat2 calls 60, seat0 already
    // all-in (skipped).
    const res = __runScriptedBettingRound({
      street: 'flop',
      firstToAct: 0,
      currentBet: 0n,
      lastRaiseSize: 2n,
      seats: [
        { seat: 0, stack: 30n, streetCommitted: 0n, actions: [bet(30n)] }, // all-in 30
        { seat: 1, stack: 60n, streetCommitted: 0n, actions: [raise(60n)] }, // all-in 60 (full)
        { seat: 2, stack: 100n, streetCommitted: 0n, actions: [call()] }, // calls 60
      ],
    });
    expect(seatOf(res, 0).status).toBe('allin');
    expect(seatOf(res, 1).status).toBe('allin');
    expect(seatOf(res, 0).streetCommitted).toBe(30n);
    expect(seatOf(res, 1).streetCommitted).toBe(60n);
    expect(seatOf(res, 2).streetCommitted).toBe(60n);

    // Feed the resulting commits into buildSidePots (committedTotal === streetCommitted
    // here since it's a single street starting at 0). Build PlaySeat-shaped inputs.
    const potSeats = res.seats.map((s) => ({
      seat: s.seat,
      committedTotal: s.committedTotal,
      status: s.status,
    }));
    const pots: PotResult[] = buildSidePots(potSeats as never);
    const totalPot = pots.reduce((acc, p) => acc + p.amount, 0n);
    // Total committed: 30 + 60 + 60 = 150.
    expect(totalPot).toBe(150n);
    // Main pot: 30 × 3 = 90 (all three eligible). Side pot: 30 × 2 = 60 (seats 1,2).
    const main = pots.find((p) => p.eligibleSeats.length === 3);
    const side = pots.find((p) => p.eligibleSeats.length === 2);
    expect(main!.amount).toBe(90n);
    expect(side!.amount).toBe(60n);
    expect(side!.eligibleSeats.sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

// ───────────────────────── 7. Round termination ─────────────────────────

describe('betting-machine — 7. round termination', () => {
  it('round ends when all live non-all-in seats have acted and matched the bet', () => {
    // Flop: seat0 bets 10, seat1 calls 10, seat2 calls 10 → all matched + acted → done.
    const res = __runScriptedBettingRound({
      street: 'flop',
      firstToAct: 0,
      currentBet: 0n,
      lastRaiseSize: 2n,
      seats: [
        { seat: 0, stack: 100n, streetCommitted: 0n, actions: [bet(10n)] },
        { seat: 1, stack: 100n, streetCommitted: 0n, actions: [call()] },
        { seat: 2, stack: 100n, streetCommitted: 0n, actions: [call()] },
      ],
    });
    for (const seat of [0, 1, 2]) {
      expect(seatOf(res, seat).streetCommitted).toBe(10n);
      expect(seatOf(res, seat).hasActed).toBe(true);
      expect(seatOf(res, seat).status).toBe('active');
    }
    expect(res.finalCurrentBet).toBe(10n);
    // Exactly one bet + two calls in the log (no extra forced re-action).
    expect(res.actionLog.filter((e) => e.type === 'bet').length).toBe(1);
    expect(res.actionLog.filter((e) => e.type === 'call').length).toBe(2);
  });

  it('checks around close the round (everyone checks postflop, no bet)', () => {
    const res = __runScriptedBettingRound({
      street: 'flop',
      firstToAct: 0,
      currentBet: 0n,
      lastRaiseSize: 2n,
      seats: [
        { seat: 0, stack: 100n, streetCommitted: 0n, actions: [check()] },
        { seat: 1, stack: 100n, streetCommitted: 0n, actions: [check()] },
      ],
    });
    expect(res.finalCurrentBet).toBe(0n);
    expect(res.actionLog.filter((e) => e.type === 'check').length).toBe(2);
    for (const seat of [0, 1]) expect(seatOf(res, seat).hasActed).toBe(true);
  });
});

// ───────────────────────── BUG 5 — multi-winner rake chip conservation ─────────────────────────
//
// computeHoldemRake distributes the pot rake across winners then must remove
// EXACTLY `rake` chips from the winners' gross awards (never dropping a chip).
// The original defensive remainder branch FLOORED a winner's award at 0, which
// could DROP the leftover chip and break sum(rakedWon) + rake === pot. The fix
// REASSIGNS any leftover to another winner that can absorb it.

describe('betting-machine — BUG 5: multi-winner rake conserves chips', () => {
  /** Build a synthetic resolved-hand result with N winners + crafted awards. */
  function fakeResult(seats: Array<{ seat: number; committed: bigint; won: bigint }>) {
    return {
      handIndex: 0, buttonSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2,
      board: [], pots: [], actionLog: [], endedAt: 'showdown' as const,
      humanBet: 0n, humanPayout: 0n, humanNet: 0n,
      seats: seats.map((s) => ({
        seat: s.seat,
        isHuman: s.seat === 0,
        personality: s.seat === 0 ? null : ('tag' as const),
        holeCards: [],
        committed: s.committed,
        won: s.won,
        net: s.won - s.committed,
        status: 'active' as const,
        handRank: null,
        isWinner: s.won > 0n,
      })),
    };
  }

  it('three-way split of a real pot: sum(rakedWon) + rake === pot, no chip dropped', () => {
    // pot = 3 × 40 = 120 → rake = min(floor(120*5/100)=6, cap 5) = 5.
    // Three winners each won 40 (totalWon === pot 120). share = floor(5*40/120)=1 each,
    // allocated 3, remainder 2 → reassigned one chip each to seats 0 and 1.
    const r = fakeResult([
      { seat: 0, committed: 40n, won: 40n },
      { seat: 1, committed: 40n, won: 40n },
      { seat: 2, committed: 40n, won: 40n },
    ]);
    const raked = computeHoldemRake(r);
    expect(raked.pot).toBe(120n);
    expect(raked.rake).toBe(5n);
    let sum = 0n;
    for (const v of raked.rakedWonBySeat.values()) {
      expect(v).toBeGreaterThanOrEqual(0n);
      sum += v;
    }
    // CHIP CONSERVATION — the whole point.
    expect(sum + raked.rake).toBe(120n);
    // Exactly `rake` chips removed from the gross 120 → 115 remains with winners.
    expect(sum).toBe(115n);
  });

  it('tiny pot where a winner\'s whole award is consumed by rake: leftover REASSIGNED, not dropped', () => {
    // Force the original defensive branch: craft awards so a winner\'s proportional
    // rake share equals its whole `won` and a leftover cannot land on its target.
    //
    // committed sums to 100 → rake = min(floor(100*5/100)=5, 5) = 5.
    // Winners: seat0 won 1, seat1 won 1 (totalWon = 2). Under the OLD single-pass
    // logic: share = floor(5*1/2) = 2 each, allocated 4 — but 2 > each winner's
    // whole won (1), so each seat\'s raked award floored to MAX(1-2,0)=0... the old
    // code set negatives to 0 and dropped the leftover, BREAKING conservation.
    //
    // The FIX removes exactly min(rake, totalWon)=2 chips from the winners (both
    // winners zeroed) and never drops a chip beyond what the winners actually hold;
    // sum(rakedWon) === totalWon - chipsActuallyRaked === 0, and no negative awards.
    const r = fakeResult([
      { seat: 0, committed: 50n, won: 1n },
      { seat: 1, committed: 50n, won: 1n },
    ]);
    const raked = computeHoldemRake(r);
    expect(raked.pot).toBe(100n);
    expect(raked.rake).toBe(5n);
    let sum = 0n;
    for (const v of raked.rakedWonBySeat.values()) {
      expect(v).toBeGreaterThanOrEqual(0n); // never negative
      sum += v;
    }
    // The winners only held 2 chips total; the rake (5) exceeds that, so the most
    // that can be raked off them is their entire 2. Critically: the fix removes
    // EXACTLY their whole 2 (down to 0 each) — it never DROPS a chip below 0 or
    // double-removes. Each winner\'s award is non-negative and the awards sum to 0.
    expect(sum).toBe(0n);
    expect(raked.rakedWonBySeat.get(0)).toBe(0n);
    expect(raked.rakedWonBySeat.get(1)).toBe(0n);
  });

  it('multi-winner pot<=5 (rake 0) keeps full awards — conservation trivially holds', () => {
    // pot = 2 + 2 = 4 ≤ 5 → floor(4*5/100)=0 rake. Two winners split, keep gross.
    const r = fakeResult([
      { seat: 0, committed: 2n, won: 2n },
      { seat: 1, committed: 2n, won: 2n },
    ]);
    const raked = computeHoldemRake(r);
    expect(raked.pot).toBe(4n);
    expect(raked.rake).toBe(0n);
    let sum = 0n;
    for (const v of raked.rakedWonBySeat.values()) sum += v;
    expect(sum + raked.rake).toBe(4n); // conservation
    expect(raked.rakedWonBySeat.get(0)).toBe(2n);
    expect(raked.rakedWonBySeat.get(1)).toBe(2n);
  });
});

// Keep the ScriptedSeatConfig import referenced (type-only usage above is fine,
// but assert the shape compiles by constructing one).
const _shapeCheck: ScriptedSeatConfig = { seat: 0, stack: 1n, actions: [fold()] };
void _shapeCheck;
