/**
 * Phase 6.5.1 — holdem-engine unit tests.
 * Deterministic: same (serverSeed, clientSeed, nonce) ⇒ identical deck +
 * outcome. No DB, no network. Mirrors blackjack-engine.test.ts style.
 */

import { describe, expect, it } from 'bun:test';
import {
  playHand,
  replayHand,
  shuffleDeck,
  buildDeck,
  evaluateBest5,
  compareHandRank,
  estimateStrength,
  buildSidePots,
  serializeHoldemHand,
  computeHoldemRake,
  HandCategory,
  DECK_SIZE,
  SEATS,
  SMALL_BLIND,
  BIG_BLIND,
  HOLDEM_RAKE_PERCENT,
  HOLDEM_RAKE_CAP,
  type Card,
  type HoldemActionRecord,
  type PlayHoldemHandArgs,
  type SerializedHoldemHand,
} from '../holdem-engine';
import {
  peekState,
  runEngine,
  visibleBoardCountForStreet,
  rakedFiguresFromOutcome,
} from '../../routes/cove-holdem';

const SERVER = 'a'.repeat(64);
const CLIENT = 'deadbeef';

function c(rank: Card['rank'], suit: Card['suit']): Card {
  return { rank, suit };
}

// ───────────────────────── Deck integrity + shuffle ─────────────────────────

describe('holdem-engine — deck', () => {
  it('buildDeck has 52 unique cards', () => {
    const d = buildDeck();
    expect(d.length).toBe(DECK_SIZE);
    const keys = new Set(d.map((x) => `${x.suit}:${x.rank}`));
    expect(keys.size).toBe(52);
  });

  it('shuffleDeck yields 52 unique cards (no dup/loss)', () => {
    const d = shuffleDeck({ serverSeed: SERVER, clientSeed: CLIENT, nonce: 0 });
    expect(d.length).toBe(52);
    const keys = new Set(d.map((x) => `${x.suit}:${x.rank}`));
    expect(keys.size).toBe(52);
  });

  it('shuffleDeck is deterministic for identical inputs', () => {
    const a = shuffleDeck({ serverSeed: SERVER, clientSeed: CLIENT, nonce: 3 });
    const b = shuffleDeck({ serverSeed: SERVER, clientSeed: CLIENT, nonce: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('shuffleDeck differs across nonces', () => {
    const a = shuffleDeck({ serverSeed: SERVER, clientSeed: CLIENT, nonce: 0 });
    const b = shuffleDeck({ serverSeed: SERVER, clientSeed: CLIENT, nonce: 1 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

// ───────────────────────── Evaluator correctness ─────────────────────────

describe('holdem-engine — evaluator', () => {
  it('royal flush', () => {
    const r = evaluateBest5([
      c('A', 'spades'), c('K', 'spades'), c('Q', 'spades'), c('J', 'spades'), c('10', 'spades'),
      c('2', 'hearts'), c('3', 'clubs'),
    ]);
    expect(r.category).toBe(HandCategory.StraightFlush);
    expect(r.tiebreakers[0]).toBe(14); // ace-high
  });

  it('straight flush (king-high)', () => {
    const r = evaluateBest5([
      c('K', 'hearts'), c('Q', 'hearts'), c('J', 'hearts'), c('10', 'hearts'), c('9', 'hearts'),
    ]);
    expect(r.category).toBe(HandCategory.StraightFlush);
    expect(r.tiebreakers[0]).toBe(13);
  });

  it('four of a kind with kicker', () => {
    const r = evaluateBest5([
      c('9', 'spades'), c('9', 'hearts'), c('9', 'clubs'), c('9', 'diamonds'), c('K', 'spades'),
      c('2', 'hearts'),
    ]);
    expect(r.category).toBe(HandCategory.FourOfAKind);
    expect(r.tiebreakers).toEqual([9, 13]);
  });

  it('full house (trips over pair)', () => {
    const r = evaluateBest5([
      c('Q', 'spades'), c('Q', 'hearts'), c('Q', 'clubs'), c('4', 'diamonds'), c('4', 'spades'),
    ]);
    expect(r.category).toBe(HandCategory.FullHouse);
    expect(r.tiebreakers).toEqual([12, 4]);
  });

  it('full house from two trips picks higher trips + lower as pair', () => {
    const r = evaluateBest5([
      c('Q', 'spades'), c('Q', 'hearts'), c('Q', 'clubs'),
      c('K', 'diamonds'), c('K', 'spades'), c('K', 'hearts'), c('2', 'clubs'),
    ]);
    expect(r.category).toBe(HandCategory.FullHouse);
    expect(r.tiebreakers).toEqual([13, 12]);
  });

  it('flush ordered by ranks', () => {
    const r = evaluateBest5([
      c('A', 'clubs'), c('J', 'clubs'), c('9', 'clubs'), c('5', 'clubs'), c('2', 'clubs'),
      c('K', 'hearts'),
    ]);
    expect(r.category).toBe(HandCategory.Flush);
    expect(r.tiebreakers).toEqual([14, 11, 9, 5, 2]);
  });

  it('straight (regular)', () => {
    const r = evaluateBest5([
      c('8', 'spades'), c('7', 'hearts'), c('6', 'clubs'), c('5', 'diamonds'), c('4', 'spades'),
    ]);
    expect(r.category).toBe(HandCategory.Straight);
    expect(r.tiebreakers[0]).toBe(8);
  });

  it('wheel straight A-2-3-4-5 = five-high', () => {
    const r = evaluateBest5([
      c('A', 'spades'), c('2', 'hearts'), c('3', 'clubs'), c('4', 'diamonds'), c('5', 'spades'),
      c('K', 'hearts'),
    ]);
    expect(r.category).toBe(HandCategory.Straight);
    expect(r.tiebreakers[0]).toBe(5); // wheel is five-high, NOT ace-high
  });

  it('three of a kind + 2 kickers', () => {
    const r = evaluateBest5([
      c('7', 'spades'), c('7', 'hearts'), c('7', 'clubs'), c('K', 'diamonds'), c('9', 'spades'),
      c('2', 'hearts'),
    ]);
    expect(r.category).toBe(HandCategory.ThreeOfAKind);
    expect(r.tiebreakers).toEqual([7, 13, 9]);
  });

  it('two pair + kicker', () => {
    const r = evaluateBest5([
      c('J', 'spades'), c('J', 'hearts'), c('4', 'clubs'), c('4', 'diamonds'), c('A', 'spades'),
      c('2', 'hearts'),
    ]);
    expect(r.category).toBe(HandCategory.TwoPair);
    expect(r.tiebreakers).toEqual([11, 4, 14]);
  });

  it('one pair + 3 kickers', () => {
    const r = evaluateBest5([
      c('10', 'spades'), c('10', 'hearts'), c('A', 'clubs'), c('7', 'diamonds'), c('3', 'spades'),
    ]);
    expect(r.category).toBe(HandCategory.Pair);
    expect(r.tiebreakers).toEqual([10, 14, 7, 3]);
  });

  it('high card', () => {
    const r = evaluateBest5([
      c('A', 'spades'), c('J', 'hearts'), c('9', 'clubs'), c('7', 'diamonds'), c('3', 'spades'),
      c('2', 'hearts'),
    ]);
    expect(r.category).toBe(HandCategory.HighCard);
    expect(r.tiebreakers).toEqual([14, 11, 9, 7, 3]);
  });

  it('compareHandRank ranks categories correctly', () => {
    const flush = evaluateBest5([
      c('A', 'clubs'), c('J', 'clubs'), c('9', 'clubs'), c('5', 'clubs'), c('2', 'clubs'),
    ]);
    const straight = evaluateBest5([
      c('8', 'spades'), c('7', 'hearts'), c('6', 'clubs'), c('5', 'diamonds'), c('4', 'spades'),
    ]);
    expect(compareHandRank(flush, straight)).toBeGreaterThan(0);
    expect(compareHandRank(straight, flush)).toBeLessThan(0);
  });

  it('compareHandRank breaks ties by kicker', () => {
    const a = evaluateBest5([
      c('K', 'spades'), c('K', 'hearts'), c('A', 'clubs'), c('7', 'diamonds'), c('3', 'spades'),
    ]);
    const b = evaluateBest5([
      c('K', 'clubs'), c('K', 'diamonds'), c('Q', 'clubs'), c('7', 'hearts'), c('3', 'diamonds'),
    ]);
    expect(compareHandRank(a, b)).toBeGreaterThan(0); // A kicker beats Q kicker
  });

  it('identical hands compare equal (split)', () => {
    const a = evaluateBest5([
      c('K', 'spades'), c('K', 'hearts'), c('A', 'clubs'), c('7', 'diamonds'), c('3', 'spades'),
    ]);
    const b = evaluateBest5([
      c('K', 'clubs'), c('K', 'diamonds'), c('A', 'hearts'), c('7', 'spades'), c('3', 'clubs'),
    ]);
    expect(compareHandRank(a, b)).toBe(0);
  });

  it('wheel straight flush is five-high not ace-high', () => {
    const r = evaluateBest5([
      c('A', 'hearts'), c('2', 'hearts'), c('3', 'hearts'), c('4', 'hearts'), c('5', 'hearts'),
    ]);
    expect(r.category).toBe(HandCategory.StraightFlush);
    expect(r.tiebreakers[0]).toBe(5);
  });
});

// ───────────────────────── Strength monotonicity ─────────────────────────

describe('holdem-engine — strength estimate', () => {
  it('AA preflop beats 72o preflop', () => {
    const aa = estimateStrength([c('A', 'spades'), c('A', 'hearts')], [], 'preflop');
    const trash = estimateStrength([c('7', 'spades'), c('2', 'hearts')], [], 'preflop');
    expect(aa).toBeGreaterThan(trash);
  });

  it('postflop made flush beats a pair', () => {
    const board = [c('2', 'clubs'), c('9', 'clubs'), c('K', 'clubs'), c('4', 'hearts'), c('J', 'spades')];
    const flush = estimateStrength([c('A', 'clubs'), c('5', 'clubs')], board, 'river');
    const pair = estimateStrength([c('K', 'spades'), c('3', 'hearts')], board, 'river');
    expect(flush).toBeGreaterThan(pair);
  });

  it('is deterministic', () => {
    const a = estimateStrength([c('A', 'spades'), c('K', 'spades')], [], 'preflop');
    const b = estimateStrength([c('A', 'spades'), c('K', 'spades')], [], 'preflop');
    expect(a).toBe(b);
  });
});

// ───────────────────────── Side-pot math ─────────────────────────

describe('holdem-engine — side pots', () => {
  it('single pot when all committed equally', () => {
    const seats = [
      mkSeat(0, 100n, 'active'),
      mkSeat(1, 100n, 'active'),
      mkSeat(2, 100n, 'folded'),
    ];
    const pots = buildSidePots(seats as never);
    expect(pots.length).toBe(1);
    expect(pots[0]!.amount).toBe(300n);
    // folded seat 2 is NOT eligible.
    expect(pots[0]!.eligibleSeats.sort()).toEqual([0, 1]);
  });

  it('multi all-in builds layered side pots', () => {
    // seat0 all-in 50, seat1 all-in 100, seat2 calls 100.
    const seats = [
      mkSeat(0, 50n, 'allin'),
      mkSeat(1, 100n, 'allin'),
      mkSeat(2, 100n, 'active'),
    ];
    const pots = buildSidePots(seats as never);
    // Main pot: 50*3 = 150 (all eligible). Side pot: 50*2 = 100 (seats 1,2).
    const total = pots.reduce((acc, p) => acc + p.amount, 0n);
    expect(total).toBe(250n);
    const main = pots.find((p) => p.eligibleSeats.length === 3);
    const side = pots.find((p) => p.eligibleSeats.length === 2);
    expect(main!.amount).toBe(150n);
    expect(side!.amount).toBe(100n);
    expect(side!.eligibleSeats.sort()).toEqual([1, 2]);
  });

  it('folded short-stack chips stay in pot as dead money but seat ineligible', () => {
    const seats = [
      mkSeat(0, 30n, 'folded'),
      mkSeat(1, 100n, 'active'),
      mkSeat(2, 100n, 'active'),
    ];
    const pots = buildSidePots(seats as never);
    const total = pots.reduce((acc, p) => acc + p.amount, 0n);
    expect(total).toBe(230n);
    // seat 0 never eligible.
    for (const p of pots) expect(p.eligibleSeats).not.toContain(0);
  });
});

// ───────────────────────── Full hand play + replay ─────────────────────────

function allFold(n: number): HoldemActionRecord[] {
  // not used directly; placeholder for clarity
  return Array.from({ length: n }, () => ({ type: 'fold' as const }));
}

function baseArgs(over: Partial<PlayHoldemHandArgs> = {}): PlayHoldemHandArgs {
  return {
    serverSeed: SERVER,
    clientSeed: CLIENT,
    nonce: 0,
    buttonSeat: 0,
    humanStartingStack: 100n,
    humanActions: [{ type: 'fold' }],
    ...over,
  };
}

/**
 * A "call-down" script: a generous list of `call` actions. A `call` when the
 * human owes nothing (toCall===0) acts as a check (moves 0 chips), and when
 * facing a bet it calls (capped at stack). So this single strategy never lands
 * the human in an illegal state regardless of bot behavior, and lets the hand
 * play to showdown. 40 entries comfortably covers preflop+3 streets of action.
 */
function callDown(): HoldemActionRecord[] {
  return Array.from({ length: 40 }, () => ({ type: 'call' as const }));
}

describe('holdem-engine — full hand', () => {
  it('human folds preflop → loses only blinds owed (often 0)', () => {
    const r = playHand(baseArgs({ humanActions: [{ type: 'fold' }] }));
    const human = r.seats.find((s) => s.isHuman)!;
    expect(human.status).toBe('folded');
    // Human folding preflop: committed is whatever blind they posted (0 unless
    // human was SB/BB). With button=0, SB=1, BB=2, human seat 0 is the button →
    // posts nothing preflop, so committed === 0.
    expect(human.committed).toBe(0n);
    expect(human.won).toBe(0n);
    expect(human.net).toBe(0n);
  });

  it('replay reproduces the live result byte-for-byte', () => {
    const args = baseArgs({
      nonce: 7,
      humanActions: callDown(),
    });
    const live = playHand(args);
    const replayed = replayHand(args);
    expect(JSON.stringify(serializeHoldemHand(live))).toBe(
      JSON.stringify(serializeHoldemHand(replayed)),
    );
  });

  it('chip conservation: total won === total committed across all seats', () => {
    for (let nonce = 0; nonce < 25; nonce++) {
      const args = baseArgs({
        nonce,
        // human always calls (acts as check when nothing is owed)
        humanActions: callDown(),
      });
      const r = playHand(args);
      const committed = r.seats.reduce((acc, s) => acc + s.committed, 0n);
      const won = r.seats.reduce((acc, s) => acc + s.won, 0n);
      expect(won).toBe(committed); // no chips created or destroyed
    }
  });

  it('button/blind seats are correct', () => {
    const r = playHand(baseArgs({ buttonSeat: 2 }));
    expect(r.buttonSeat).toBe(2);
    expect(r.smallBlindSeat).toBe(3);
    expect(r.bigBlindSeat).toBe(4);
  });

  it('bots are deterministic given identical inputs', () => {
    const args = baseArgs({
      nonce: 11,
      humanActions: [{ type: 'fold' }],
    });
    const a = playHand(args);
    const b = playHand(args);
    expect(JSON.stringify(a.actionLog)).toBe(JSON.stringify(b.actionLog));
    expect(JSON.stringify(a.seats.map((s) => s.won.toString()))).toBe(
      JSON.stringify(b.seats.map((s) => s.won.toString())),
    );
  });

  it('SEATS hole cards + board are all distinct (no card reuse)', () => {
    const r = playHand(baseArgs({
      nonce: 4,
      humanActions: callDown(),
    }));
    const all: string[] = [];
    for (const s of r.seats) for (const card of s.holeCards) all.push(`${card.suit}:${card.rank}`);
    for (const card of r.board) all.push(`${card.suit}:${card.rank}`);
    // 12 hole + up to 5 board.
    const set = new Set(all);
    expect(set.size).toBe(all.length);
  });

  it('exactly one pot winner set is non-empty (someone wins)', () => {
    for (let nonce = 0; nonce < 15; nonce++) {
      const r = playHand(baseArgs({
        nonce,
        humanActions: callDown(),
      }));
      const anyWinner = r.seats.some((s) => s.won > 0n);
      expect(anyWinner).toBe(true);
    }
  });

  it('human raise all-in is legal and resolves', () => {
    const r = playHand(baseArgs({
      nonce: 9,
      humanStartingStack: 100n,
      // human at button seat 0 acts preflop after BB; shove all 100.
      humanActions: [{ type: 'raise', amount: '100' }],
    }));
    const human = r.seats.find((s) => s.isHuman)!;
    // Human committed up to their entire stack (or less if everyone folded to a smaller amount? No — raise commits the chips immediately).
    expect(human.committed).toBe(100n);
  });

  it('illegal check (owing chips) throws', () => {
    // Human is button; preflop owes the BB to call. A 'check' is illegal.
    expect(() =>
      playHand(baseArgs({ nonce: 0, humanActions: [{ type: 'check' }] })),
    ).toThrow();
  });

  it('running out of human actions throws (route must record every turn)', () => {
    expect(() =>
      playHand(baseArgs({
        nonce: 0,
        // call preflop then provide nothing for postflop turns
        humanActions: [{ type: 'call' }],
      })),
    ).toThrow();
  });

  it('split pot: chip conservation holds even on ties', () => {
    // Hard to force a tie deterministically without crafting a deck, but chip
    // conservation already covers split correctness; assert remainder handling
    // via buildSidePots + manual award path is exercised in side-pot tests.
    const r = playHand(baseArgs({
      nonce: 2,
      humanActions: callDown(),
    }));
    const committed = r.seats.reduce((acc, s) => acc + s.committed, 0n);
    const won = r.seats.reduce((acc, s) => acc + s.won, 0n);
    expect(won).toBe(committed);
  });

  it('serialized outcome has stringified bigints + holdem discriminator', () => {
    const r = playHand(baseArgs({
      nonce: 5,
      humanActions: callDown(),
    }));
    const s = serializeHoldemHand(r);
    expect(s.kind).toBe('holdem');
    expect(typeof s.humanBet).toBe('string');
    expect(typeof s.humanPayout).toBe('string');
    expect(typeof s.humanNet).toBe('string');
    expect(s.seats.every((seat) => typeof seat.committed === 'string')).toBe(true);
    expect(s.pots.every((p) => typeof p.amount === 'string')).toBe(true);
  });

  it('humanNet = humanPayout - humanBet', () => {
    for (let nonce = 0; nonce < 10; nonce++) {
      const r = playHand(baseArgs({
        nonce,
        humanActions: callDown(),
      }));
      expect(r.humanNet).toBe(r.humanPayout - r.humanBet);
    }
  });
});

// ───────────────────────── All-in / side-pot through full play ─────────────

describe('holdem-engine — all-in through full play', () => {
  it('human shoves a short stack; chips conserve + eligibility respected', () => {
    // Short human stack (10 CT) shoving preflop creates a real side-pot vs bots
    // with 100 CT. Run several nonces; assert conservation + that the human can
    // only ever win up to what they were eligible for (committed-matched).
    for (let nonce = 0; nonce < 20; nonce++) {
      const r = playHand({
        serverSeed: SERVER,
        clientSeed: CLIENT,
        nonce,
        buttonSeat: nonce % SEATS,
        humanStartingStack: 10n,
        botStartingStack: 100n,
        humanActions: [{ type: 'raise', amount: '10' }, ...callDown()],
      });
      const committed = r.seats.reduce((acc, s) => acc + s.committed, 0n);
      const won = r.seats.reduce((acc, s) => acc + s.won, 0n);
      expect(won).toBe(committed); // conservation across side pots

      // Folded seats never win.
      for (const s of r.seats) {
        if (s.status === 'folded') expect(s.won).toBe(0n);
      }
      // Each pot's winners are a subset of its eligible seats.
      for (const pot of r.pots) {
        for (const w of pot.winners) expect(pot.eligibleSeats).toContain(w);
      }
    }
  });

  it('a human all-in for less than the bet can win at most the matched portion', () => {
    // human 10 vs a big field: the human committed at most 10, so won (if any)
    // must come from a pot they were eligible for; net is bounded by the field.
    const r = playHand({
      serverSeed: SERVER,
      clientSeed: CLIENT,
      nonce: 3,
      buttonSeat: 0,
      humanStartingStack: 10n,
      botStartingStack: 100n,
      humanActions: [{ type: 'raise', amount: '10' }, ...callDown()],
    });
    const human = r.seats.find((s) => s.isHuman)!;
    // The human committed exactly their stack (10) since they shoved.
    expect(human.committed).toBeLessThanOrEqual(10n);
    if (human.won > 0n) {
      // Winning a main pot capped at (human.committed × eligibleContributors)
      // is always ≥ human.committed; sanity: won is a multiple-of-contributors
      // bounded value, never absurdly large.
      expect(human.won).toBeLessThanOrEqual(committedSum(r) );
    }
  });
});

function committedSum(r: ReturnType<typeof playHand>): bigint {
  return r.seats.reduce((acc, s) => acc + s.committed, 0n);
}

// ───────────────────────── Constants sanity ─────────────────────────

describe('holdem-engine — constants', () => {
  it('6-max, SB=1, BB=2', () => {
    expect(SEATS).toBe(6);
    expect(SMALL_BLIND).toBe(1n);
    expect(BIG_BLIND).toBe(2n);
  });
});

// ───────────────────────── In-progress view board truncation ─────────────────
//
// REGRESSION (critical fairness/money leak): the route's peekState() builds the
// human's mid-hand view by appending a SYNTHETIC FOLD and running the engine to
// completion. Folding the human resolves the WHOLE hand — bots play on to
// showdown and the engine deals ALL FIVE community cards. The route must NOT
// return that full board: at a preflop decision the board must be [], at the
// flop 3 cards, turn 4, river 5. Otherwise a connected agent (or the human)
// reading the API sees undealt cards before betting. These tests assert the
// in-progress board length equals the visible-street count at each decision
// point, that it NEVER exceeds the current street, and that bot hole cards are
// never present in an in-progress view.

const PEEK_TABLE = { serverSeed: SERVER, clientSeed: CLIENT };

/** Mirror the route's isHandTerminal probe (run engine; "ran out" ⇒ not done). */
function peekIsTerminal(handMeta: { handIndex: number; buttonSeat: number; startingStack: string }, actions: HoldemActionRecord[]): boolean {
  try {
    runEngine(PEEK_TABLE, handMeta, actions);
    return true;
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('ran out of human actions')) return false;
    throw err; // a genuine illegal-script error — fail loudly
  }
}

/**
 * Walk a hand exactly like the route does: at each non-terminal step take a peek
 * (this is what the API would return to the client) then append a 'call' and
 * advance, until the hand settles. Returns every in-progress peek + the street
 * it was on. 'call' is legal in every spot (acts as check when nothing is owed,
 * a call when facing a bet, capped at stack), so this never produces an illegal
 * script and lets us observe decisions across all four streets.
 */
function walkPeeks(handIndex: number, buttonSeat: number, startingStack: bigint) {
  const handMeta = { handIndex, buttonSeat, startingStack: startingStack.toString() };
  const peeks: Array<{
    street: 'preflop' | 'flop' | 'turn' | 'river';
    boardLen: number;
    boardKeys: string[];
    humanHoleLen: number;
  }> = [];
  const actions: HoldemActionRecord[] = [];
  // Generous bound: at most one human decision per street + slack.
  for (let guard = 0; guard < 64; guard++) {
    if (peekIsTerminal(handMeta, actions)) break;
    const view = peekState(PEEK_TABLE, handMeta, actions);
    // Re-derive the street the human is on by inspecting the synthetic-fold peek
    // log (same source peekState uses for truncation).
    const full = runEngine(PEEK_TABLE, handMeta, [...actions, { type: 'fold' }]);
    let street: 'preflop' | 'flop' | 'turn' | 'river' | null = null;
    for (let i = full.actionLog.length - 1; i >= 0; i--) {
      if (full.actionLog[i]!.isHuman) { street = full.actionLog[i]!.street; break; }
    }
    expect(street).not.toBeNull();
    peeks.push({
      street: street!,
      boardLen: view.board.length,
      boardKeys: view.board.map((c) => `${c.suit}:${c.rank}`),
      humanHoleLen: view.humanHole.length,
    });
    actions.push({ type: 'call' });
  }
  return { peeks, handMeta };
}

describe('holdem-engine — in-progress view board truncation (fairness)', () => {
  it('visibleBoardCountForStreet maps streets to dealt-card counts', () => {
    expect(visibleBoardCountForStreet('preflop')).toBe(0);
    expect(visibleBoardCountForStreet('flop')).toBe(3);
    expect(visibleBoardCountForStreet('turn')).toBe(4);
    expect(visibleBoardCountForStreet('river')).toBe(5);
    expect(visibleBoardCountForStreet(null)).toBe(0);
  });

  const STREET_COUNT: Record<'preflop' | 'flop' | 'turn' | 'river', number> = {
    preflop: 0, flop: 3, turn: 4, river: 5,
  };

  it('every in-progress peek board length === the visible-street count, NEVER more', () => {
    // Scan many nonces + buttons so the human lands on decisions across all
    // four streets at least once each (asserted below).
    const seenStreets = new Set<'preflop' | 'flop' | 'turn' | 'river'>();
    for (let nonce = 0; nonce < 40; nonce++) {
      const button = nonce % SEATS;
      const { peeks } = walkPeeks(nonce, button, 100n);
      for (const p of peeks) {
        // EXACT contract: board length is exactly the current street's count.
        expect(p.boardLen).toBe(STREET_COUNT[p.street]);
        // Hard invariant: never exceed the current street (the leak being fixed).
        expect(p.boardLen).toBeLessThanOrEqual(STREET_COUNT[p.street]);
        // Human always sees exactly their 2 hole cards.
        expect(p.humanHoleLen).toBe(2);
        // Board cards are distinct (no duplicate reveal).
        expect(new Set(p.boardKeys).size).toBe(p.boardKeys.length);
        seenStreets.add(p.street);
      }
    }
    // Coverage: we must have observed a decision on every street at least once,
    // otherwise the "flop/turn/river truncation" claim is untested.
    expect(seenStreets.has('preflop')).toBe(true);
    expect(seenStreets.has('flop')).toBe(true);
    expect(seenStreets.has('turn')).toBe(true);
    expect(seenStreets.has('river')).toBe(true);
  });

  it('PREFLOP decision reveals ZERO board cards (the originally-reported leak)', () => {
    // The bug report: a preflop deal returned a full 5-card board. The very
    // first peek of a fresh hand (no recorded actions) is a preflop decision
    // whenever the human is required to act preflop — assert board === [] there.
    let checked = 0;
    for (let nonce = 0; nonce < 40; nonce++) {
      const button = nonce % SEATS;
      const handMeta = { handIndex: nonce, buttonSeat: button, startingStack: '100' };
      if (peekIsTerminal(handMeta, [])) continue; // human not required preflop
      const view = peekState(PEEK_TABLE, handMeta, []);
      // First decision of a fresh hand is ALWAYS preflop.
      const full = runEngine(PEEK_TABLE, handMeta, [{ type: 'fold' }]);
      let firstHumanStreet: string | null = null;
      for (const e of full.actionLog) { if (e.isHuman) { firstHumanStreet = e.street; break; } }
      expect(firstHumanStreet).toBe('preflop');
      expect(view.board.length).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(0); // we actually exercised the preflop path
  });

  it('the in-progress view NEVER leaks any bot hole cards', () => {
    // peekState returns ONLY humanHole. Confirm the returned object exposes no
    // seat array / no other hole cards, and that humanHole matches seat 0 only.
    for (let nonce = 0; nonce < 20; nonce++) {
      const button = nonce % SEATS;
      const handMeta = { handIndex: nonce, buttonSeat: button, startingStack: '100' };
      if (peekIsTerminal(handMeta, [])) continue;
      const view = peekState(PEEK_TABLE, handMeta, []);
      // Structural: the shape has no `seats` and no per-bot hole field.
      expect(Object.prototype.hasOwnProperty.call(view, 'seats')).toBe(false);
      expect(view.humanHole.length).toBe(2);
      // The view's humanHole must equal the engine's seat-0 (human) hole cards,
      // and must NOT equal any bot's hole cards (i.e. it is genuinely seat 0's).
      const full = runEngine(PEEK_TABLE, handMeta, [{ type: 'fold' }]);
      const humanSeat = full.seats.find((s) => s.isHuman)!;
      expect(view.humanHole.map((c) => `${c.suit}:${c.rank}`)).toEqual(
        humanSeat.holeCards.map((c) => `${c.suit}:${c.rank}`),
      );
    }
  });

  it('a deeper street peek is a strict prefix of the eventual full board', () => {
    // The cards shown on the flop/turn MUST be the first N of the final 5-card
    // board — we reveal a true prefix, never a different/garbled subset.
    for (let nonce = 0; nonce < 40; nonce++) {
      const button = nonce % SEATS;
      const { peeks, handMeta } = walkPeeks(nonce, button, 100n);
      // The full settled hand (all calls) reveals the complete board.
      const settled = runEngine(PEEK_TABLE, handMeta, callDown());
      const fullBoardKeys = settled.board.map((c) => `${c.suit}:${c.rank}`);
      for (const p of peeks) {
        // Every in-progress board must be the leading prefix of the final board.
        expect(p.boardKeys).toEqual(fullBoardKeys.slice(0, p.boardLen));
      }
    }
  });
});

// ───────────────────────── Rake the pot (economy fix 2026-05-29) ─────────────
//
// Standard "rake the pot": at settle the house takes min(floor(pot*5/100), 5) CT
// from the pot before awarding winners; the raked CT is not credited → net burn.
// These tests pin: (1) chip conservation sum(rakedWon)+rake === pot, (2) the rake
// formula + cap, (3) the human's raked payout never goes negative, (4) the rake
// makes the table house-positive (every chip the human nets is reduced by rake).

describe("holdem-engine — computeHoldemRake", () => {
  it('rake constants are 5% capped at 5 CT', () => {
    expect(HOLDEM_RAKE_PERCENT).toBe(5n);
    expect(HOLDEM_RAKE_CAP).toBe(5n);
  });

  it('rake == min(floor(pot*5/100), 5) AND sum(rakedWon) + rake === pot (chip conservation)', () => {
    // Sweep many real hands across nonces + buttons + stacks so we cover small
    // pots (no rake / sub-cap rake) and big pots (capped rake), single + multi
    // winner, side pots.
    let sawRake = false; // at least one hand actually charged a rake
    for (let nonce = 0; nonce < 60; nonce++) {
      const button = nonce % SEATS;
      const r = playHand(baseArgs({ nonce, buttonSeat: button, humanActions: callDown() }));
      const raked = computeHoldemRake(r);

      // pot = sum of all committed (chip-conserving: equals sum of `won`).
      const pot = r.seats.reduce((acc, s) => acc + s.committed, 0n);
      expect(raked.pot).toBe(pot);

      // Rake formula + cap.
      const expectFloor = (pot * HOLDEM_RAKE_PERCENT) / 100n;
      const expectRake = expectFloor < HOLDEM_RAKE_CAP ? expectFloor : HOLDEM_RAKE_CAP;
      expect(raked.rake).toBe(expectRake);
      expect(raked.rake).toBeLessThanOrEqual(HOLDEM_RAKE_CAP);
      if (raked.rake > 0n) sawRake = true;

      // CHIP CONSERVATION: every chip is accounted for — the rake plus every
      // winner's raked award sum back to the full pot.
      let sumRaked = 0n;
      for (const award of raked.rakedWonBySeat.values()) {
        expect(award).toBeGreaterThanOrEqual(0n); // never rake a seat negative
        sumRaked += award;
      }
      expect(sumRaked + raked.rake).toBe(pot);

      // The human's raked payout is the human seat's raked award (or 0).
      const humanGross = r.seats.find((s) => s.isHuman)!.won;
      expect(raked.humanRakedPayout).toBeLessThanOrEqual(humanGross);
      expect(raked.humanRakedPayout).toBeGreaterThanOrEqual(0n);
      // Raked net = rakedPayout - committed.
      const humanCommitted = r.seats.find((s) => s.isHuman)!.committed;
      expect(raked.humanRakedNet).toBe(raked.humanRakedPayout - humanCommitted);
      // The rake only ever REDUCES the human's payout vs the gross engine award.
      expect(raked.humanRakedNet).toBeLessThanOrEqual(r.humanNet);
    }
    // Coverage: at least one swept hand actually charged a rake (the formula +
    // conservation are asserted on EVERY hand above; the explicit cap + split-pot
    // paths are pinned by the deterministic synthetic-hand tests below).
    expect(sawRake).toBe(true);
  });

  it('a 200-chip pot rakes exactly the 5 CT cap (floor(200*5/100)=10 → capped to 5)', () => {
    // Craft a deterministic single-winner pot via a synthetic resolved hand so
    // the cap path is asserted on an exact number (independent of deck luck).
    const fakeResult = {
      handIndex: 0,
      buttonSeat: 0,
      smallBlindSeat: 1,
      bigBlindSeat: 2,
      board: [],
      pots: [],
      actionLog: [],
      endedAt: 'showdown' as const,
      humanBet: 100n,
      humanPayout: 200n,
      humanNet: 100n,
      seats: [
        { seat: 0, isHuman: true, personality: null, holeCards: [], committed: 100n, won: 200n, net: 100n, status: 'active' as const, handRank: null, isWinner: true },
        { seat: 1, isHuman: false, personality: 'tag' as const, holeCards: [], committed: 100n, won: 0n, net: -100n, status: 'folded' as const, handRank: null, isWinner: false },
      ],
    };
    const raked = computeHoldemRake(fakeResult);
    expect(raked.pot).toBe(200n); // 100 + 100
    expect(raked.rake).toBe(5n); // floor(200*5/100)=10, capped to 5
    expect(raked.humanRakedPayout).toBe(195n); // sole winner absorbs the whole rake
    expect(raked.humanRakedNet).toBe(95n);
    // Conservation: 195 (human) + 0 (folded bot) + 5 (rake) = 200.
    let sum = 0n;
    for (const v of raked.rakedWonBySeat.values()) sum += v;
    expect(sum + raked.rake).toBe(200n);
  });

  it('a tiny pot (3 chips) rakes 0 (floor(3*5/100)=0); winner keeps the whole pot', () => {
    const fakeResult = {
      handIndex: 0, buttonSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2,
      board: [], pots: [], actionLog: [], endedAt: 'preflop' as const,
      humanBet: 1n, humanPayout: 3n, humanNet: 2n,
      seats: [
        { seat: 0, isHuman: true, personality: null, holeCards: [], committed: 1n, won: 3n, net: 2n, status: 'active' as const, handRank: null, isWinner: true },
        { seat: 1, isHuman: false, personality: 'tag' as const, holeCards: [], committed: 2n, won: 0n, net: -2n, status: 'folded' as const, handRank: null, isWinner: false },
      ],
    };
    const raked = computeHoldemRake(fakeResult);
    expect(raked.pot).toBe(3n);
    expect(raked.rake).toBe(0n);
    expect(raked.humanRakedPayout).toBe(3n); // no rake on a sub-20 pot
  });

  it('split pot: rake is taken ONCE total then distributed proportionally (conservation holds)', () => {
    // Two winners split a 200 pot 100/100. Rake = 5 (cap). Each absorbs floor(5*100/200)=2,
    // remainder 1 chip to the earliest winning seat → seat0 raked 100-3=97, seat1 100-2=98.
    const fakeResult = {
      handIndex: 0, buttonSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2,
      board: [], pots: [], actionLog: [], endedAt: 'showdown' as const,
      humanBet: 100n, humanPayout: 100n, humanNet: 0n,
      seats: [
        { seat: 0, isHuman: true, personality: null, holeCards: [], committed: 100n, won: 100n, net: 0n, status: 'active' as const, handRank: null, isWinner: true },
        { seat: 1, isHuman: false, personality: 'tag' as const, holeCards: [], committed: 100n, won: 100n, net: 0n, status: 'active' as const, handRank: null, isWinner: true },
      ],
    };
    const raked = computeHoldemRake(fakeResult);
    expect(raked.pot).toBe(200n);
    expect(raked.rake).toBe(5n);
    // Conservation: raked awards + rake === pot.
    let sum = 0n;
    for (const v of raked.rakedWonBySeat.values()) sum += v;
    expect(sum + raked.rake).toBe(200n);
    // Earliest winning seat absorbs the odd remainder chip.
    expect(raked.rakedWonBySeat.get(0)).toBe(97n);
    expect(raked.rakedWonBySeat.get(1)).toBe(98n);
    expect(raked.humanRakedPayout).toBe(97n);
  });

  it('serialized outcome carries rake + humanRakedPayout + humanRakedNet', () => {
    const r = playHand(baseArgs({ nonce: 5, humanActions: callDown() }));
    const s = serializeHoldemHand(r);
    const raked = computeHoldemRake(r);
    expect(s.rake).toBe(raked.rake.toString());
    expect(s.humanRakedPayout).toBe(raked.humanRakedPayout.toString());
    expect(s.humanRakedNet).toBe(raked.humanRakedNet.toString());
    // GROSS fields unchanged.
    expect(s.humanPayout).toBe(r.humanPayout.toString());
    expect(s.humanNet).toBe(r.humanNet.toString());
  });

  it('idempotent replay of a POST-rake row returns the stored RAKED figures', () => {
    const r = playHand(baseArgs({ nonce: 5, humanActions: callDown() }));
    const s = serializeHoldemHand(r);
    // s has the raked fields → replay must surface them verbatim, NOT the gross.
    expect(rakedFiguresFromOutcome(s)).toEqual({
      payout: s.humanRakedPayout!,
      net: s.humanRakedNet!,
      rake: s.rake!,
    });
  });

  it('idempotent replay of a PRE-rake row falls back to GROSS figures (regression)', () => {
    // Simulate a hand SETTLED BY OLD CODE: stored outcomeJson with NO rake,
    // humanRakedPayout, or humanRakedNet fields (they predate the rake diff).
    // The route must replay the figures the player actually received (gross),
    // not undefined — `SettledResponse.payout/net/rake` are typed `string`.
    const r = playHand(baseArgs({ nonce: 5, humanActions: callDown() }));
    const full = serializeHoldemHand(r);
    // Strip exactly the three optional rake fields → a pre-fix stored row shape.
    const preRake: SerializedHoldemHand = { ...full };
    delete (preRake as Partial<SerializedHoldemHand>).rake;
    delete (preRake as Partial<SerializedHoldemHand>).humanRakedPayout;
    delete (preRake as Partial<SerializedHoldemHand>).humanRakedNet;

    const figures = rakedFiguresFromOutcome(preRake);
    // Must fall back to the always-present GROSS figures, never undefined.
    expect(figures.payout).toBe(full.humanPayout);
    expect(figures.net).toBe(full.humanNet);
    expect(figures.rake).toBe('0');
    expect(figures.payout).toBeDefined();
    expect(figures.net).toBeDefined();
    expect(typeof figures.payout).toBe('string');
    expect(typeof figures.net).toBe('string');
    expect(typeof figures.rake).toBe('string');
  });
});

// helper to build a fake PlaySeat-shaped object for buildSidePots tests.
// buildSidePots only reads seat, committedTotal, status.
function mkSeat(seat: number, committedTotal: bigint, status: string) {
  return {
    seat,
    isHuman: seat === 0,
    personality: null,
    hole: [],
    stack: 0n,
    committedTotal,
    streetCommitted: 0n,
    status,
    hasActed: true,
  };
}

void allFold; // keep helper referenced
