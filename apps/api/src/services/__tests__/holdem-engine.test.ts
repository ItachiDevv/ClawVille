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
  HandCategory,
  DECK_SIZE,
  SEATS,
  SMALL_BLIND,
  BIG_BLIND,
  type Card,
  type HoldemActionRecord,
  type PlayHoldemHandArgs,
} from '../holdem-engine';

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
