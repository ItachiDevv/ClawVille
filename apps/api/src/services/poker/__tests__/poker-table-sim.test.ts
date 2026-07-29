/**
 * Phase P1 — deterministic tests for the live multi-human poker table sim.
 *
 * Strategy: every test drives FULL hands through `applyAction`, capturing the
 * broadcast public snapshots + per-seat private views via injected callbacks.
 * We REPLICATE the engine's deterministic deal (`shuffleDeck` + the sim's deal
 * order) so the test knows every seat's hole cards + the full board up front,
 * then compute the EXPECTED showdown winner with the engine's `evaluateBest5` /
 * `compareHandRank` and assert the sim awarded the same — making correctness
 * independent of any hand-crafted seed.
 *
 * A fake clock makes turn-timeout deterministic with NO real time.
 */

import { describe, expect, it } from 'bun:test';
import {
  shuffleDeck,
  evaluateBest5,
  compareHandRank,
  buildSidePots,
  awardPots,
  type Card,
  type PlaySeat,
} from '../../holdem-engine';
import { PokerTableSim, serializeSettledPots } from '../poker-table-sim';
import type {
  HandResult,
  PrivateSeatView,
  PublicTableSnapshot,
  SeatAssignment,
  SimClock,
  Street,
} from '../poker-table-types';

const SERVER = 'a'.repeat(64);
const CLIENT = 'deadbeef';

// ── A controllable fake clock ───────────────────────────────────────────────

interface FakeTimer {
  cb: () => void;
  fireAt: number;
  cancelled: boolean;
}

class FakeClock implements SimClock {
  private t = 1_000_000;
  private timers: FakeTimer[] = [];
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  setTimer(cb: () => void, ms: number): unknown {
    const timer: FakeTimer = { cb, fireAt: this.t + ms, cancelled: false };
    this.timers.push(timer);
    return timer;
  }
  clearTimer(handle: unknown): void {
    (handle as FakeTimer).cancelled = true;
  }
  /** Fire the single live (non-cancelled) timer by jumping to its deadline. */
  fireDue(): void {
    const live = this.timers.filter((x) => !x.cancelled && x.fireAt <= this.t);
    for (const x of live) {
      x.cancelled = true;
      x.cb();
    }
  }
  /** Advance to the next pending timer's deadline and fire it. */
  fireNext(): void {
    const pending = this.timers.filter((x) => !x.cancelled);
    if (pending.length === 0) throw new Error('no pending timer');
    const next = pending.reduce((m, x) => (x.fireAt < m.fireAt ? x : m));
    this.t = Math.max(this.t, next.fireAt);
    next.cancelled = true;
    next.cb();
  }
}

// ── A harness that captures all broadcast + per-seat frames ──────────────────

interface Harness {
  sim: PokerTableSim;
  clock: FakeClock;
  snapshots: PublicTableSnapshot[];
  /** Latest private view per avatarId. */
  privateByAvatar: Map<string, PrivateSeatView>;
  /** ALL private views ever sent (avatarId → list). */
  allPrivate: Map<string, PrivateSeatView[]>;
  completed: HandResult[];
}

function makeHarness(): Harness {
  const clock = new FakeClock();
  const sim = new PokerTableSim(clock);
  const h: Harness = {
    sim,
    clock,
    snapshots: [],
    privateByAvatar: new Map(),
    allPrivate: new Map(),
    completed: [],
  };
  sim.setBroadcastFn((_id, snap) => {
    h.snapshots.push(snap);
  });
  sim.setSendToSeatFn((_id, avatarId, frame) => {
    h.privateByAvatar.set(avatarId, frame);
    const list = h.allPrivate.get(avatarId) ?? [];
    list.push(frame);
    h.allPrivate.set(avatarId, list);
  });
  sim.setHandCompleteFn((_id, result) => {
    h.completed.push(result);
  });
  return h;
}

// ── Replicate the sim's deterministic deal so tests know all cards up front ──

interface DealtCards {
  /** hole cards keyed by seatIndex (occupied seats only, ascending). */
  holeBySeat: Map<number, [Card, Card]>;
  board5: Card[];
}

function replicateDeal(
  handNumber: number,
  occupiedSeatIndicesAscending: number[],
): DealtCards {
  const deck = shuffleDeck({ serverSeed: SERVER, clientSeed: CLIENT, nonce: handNumber });
  const n = occupiedSeatIndicesAscending.length;
  const hole: [Card, Card][] = occupiedSeatIndicesAscending.map(() => [deck[0]!, deck[0]!]);
  let top = 0;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < n; i++) {
      hole[i]![round] = deck[top++]!;
    }
  }
  const board5 = [deck[top++]!, deck[top++]!, deck[top++]!, deck[top++]!, deck[top++]!];
  const holeBySeat = new Map<number, [Card, Card]>();
  occupiedSeatIndicesAscending.forEach((seatIdx, i) => {
    holeBySeat.set(seatIdx, hole[i]!);
  });
  return { holeBySeat, board5 };
}

/** Expected showdown winner seat indices among `contenders`, full 5-card board. */
function expectedWinners(
  deal: DealtCards,
  contenders: number[],
): number[] {
  let best = null as ReturnType<typeof evaluateBest5> | null;
  let winners: number[] = [];
  for (const seat of contenders) {
    const r = evaluateBest5([...deal.holeBySeat.get(seat)!, ...deal.board5]);
    if (!best || compareHandRank(r, best) > 0) {
      best = r;
      winners = [seat];
    } else if (compareHandRank(r, best) === 0) {
      winners.push(seat);
    }
  }
  return winners.sort((a, b) => a - b);
}

function seatAssign(seatIndex: number, chip: number, subjectType: 'human' | 'agent' = 'human'): SeatAssignment {
  return {
    seatIndex,
    avatarId: `av-${seatIndex}`,
    name: `Seat ${seatIndex}`,
    subjectType,
    chipStack: chip,
  };
}

function av(seatIndex: number): string {
  return `av-${seatIndex}`;
}

/** Sum of nets across all seats in a result (must be 0 — chip conservation). */
function netSum(r: HandResult): number {
  return r.perSeat.reduce((acc, s) => acc + s.net, 0);
}

/** Total committed across all seats (== total pot). */
function totalCommitted(r: HandResult): number {
  return r.perSeat.reduce((acc, s) => acc + s.totalCommitted, 0);
}

let idemCounter = 0;
function nextKey(): string {
  return `k-${idemCounter++}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Heads-up full hand
// ─────────────────────────────────────────────────────────────────────────────

describe('poker-table-sim — heads-up full hand', () => {
  it('button posts SB heads-up, deals, plays to showdown, awards right winner, conserves chips', () => {
    const h = makeHarness();
    const handNumber = 7;
    // 2 seats → heads-up. Button = seat 0 → seat 0 posts SB, seat 1 posts BB.
    h.sim.startHand({
      tableId: 'hu',
      handNumber,
      seatAssignments: [seatAssign(0, 100), seatAssign(1, 100)],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });

    const first = h.snapshots[0]!;
    // Heads-up: button (seat 0) is SB, seat 1 is BB.
    expect(first.seats.find((s) => s.seatIndex === 0)!.isSB).toBe(true);
    expect(first.seats.find((s) => s.seatIndex === 1)!.isBB).toBe(true);
    expect(first.seats.find((s) => s.seatIndex === 0)!.isButton).toBe(true);
    // SB posted 1, BB posted 2.
    expect(first.seats.find((s) => s.seatIndex === 0)!.streetBet).toBe(1);
    expect(first.seats.find((s) => s.seatIndex === 1)!.streetBet).toBe(2);
    expect(first.pot).toBe(3);
    expect(first.board.length).toBe(0); // preflop
    // First to act preflop heads-up = button/SB = seat 0.
    expect(first.toActSeatIndex).toBe(0);
    expect(first.toCall).toBe(1); // SB owes 1 to match BB

    // Preflop: SB(0) calls, BB(1) checks the option → flop.
    h.sim.applyAction('hu', av(0), { kind: 'call' }, { idempotencyKey: nextKey() });
    let snap = h.sim.getPublicSnapshot('hu')!;
    expect(snap.toActSeatIndex).toBe(1); // BB to act (option)
    expect(snap.board.length).toBe(0); // still preflop until BB acts
    h.sim.applyAction('hu', av(1), { kind: 'check' }, { idempotencyKey: nextKey() });
    snap = h.sim.getPublicSnapshot('hu')!;
    expect(snap.street).toBe('flop');
    expect(snap.board.length).toBe(3);

    // Postflop heads-up: first to act = non-button = seat 1 (BB).
    expect(snap.toActSeatIndex).toBe(1);
    // Flop: both check → turn.
    h.sim.applyAction('hu', av(1), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('hu', av(0), { kind: 'check' }, { idempotencyKey: nextKey() });
    snap = h.sim.getPublicSnapshot('hu')!;
    expect(snap.street).toBe('turn');
    expect(snap.board.length).toBe(4);

    // Turn: both check → river.
    h.sim.applyAction('hu', av(1), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('hu', av(0), { kind: 'check' }, { idempotencyKey: nextKey() });
    snap = h.sim.getPublicSnapshot('hu')!;
    expect(snap.street).toBe('river');
    expect(snap.board.length).toBe(5);

    // River: both check → showdown.
    h.sim.applyAction('hu', av(1), { kind: 'check' }, { idempotencyKey: nextKey() });
    const r = h.sim.applyAction('hu', av(0), { kind: 'check' }, { idempotencyKey: nextKey() });
    expect(r.handComplete).toBe(true);

    // Hand resolved.
    expect(h.completed.length).toBe(1);
    const result = h.completed[0]!;
    expect(result.endedAt).toBe('showdown');
    expect(result.board.length).toBe(5);

    // Chip conservation: nets sum to 0. Both seats put in exactly the BB (2):
    // SB posted 1 then completed to 2, BB posted 2; everyone checked down. So
    // total committed == 4 (2 + 2), no chips created/destroyed.
    expect(netSum(result)).toBe(0);
    expect(totalCommitted(result)).toBe(4);
    expect(result.perSeat.find((s) => s.seatIndex === 0)!.totalCommitted).toBe(2);
    expect(result.perSeat.find((s) => s.seatIndex === 1)!.totalCommitted).toBe(2);

    // Correct winner: compute expected from the actual deal.
    const deal = replicateDeal(handNumber, [0, 1]);
    // Confirm the sim dealt the cards we replicated (sanity on private views).
    const p0 = h.allPrivate.get(av(0))![0]!;
    expect(p0.holeCards).toEqual(deal.holeBySeat.get(0)!);
    const winners = expectedWinners(deal, [0, 1]);
    const simWinners = result.perSeat.filter((s) => s.isWinner).map((s) => s.seatIndex).sort();
    expect(simWinners).toEqual(winners);
    // Server seed revealed only at showdown.
    expect(result.serverSeedRevealed).toBe(SERVER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Fold-win: NO showdown, winner's hole cards stay HIDDEN (fairness)
// ─────────────────────────────────────────────────────────────────────────────

describe('poker-table-sim — fold-around does not reveal the winner', () => {
  it('uncontested fold-win conceals every seat\'s hole cards (no showdown)', () => {
    const h = makeHarness();
    const handNumber = 11;
    // Heads-up: seat 0 = button/SB, seat 1 = BB.
    h.sim.startHand({
      tableId: 'fw',
      handNumber,
      seatAssignments: [seatAssign(0, 100), seatAssign(1, 100)],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });

    // SB (seat 0) folds preflop → BB (seat 1) wins uncontested.
    const r = h.sim.applyAction('fw', av(0), { kind: 'fold' }, { idempotencyKey: nextKey() });
    expect(r.handComplete).toBe(true);

    const result = h.completed[0]!;
    // No showdown happened — the hand ended preflop on the fold.
    expect(result.endedAt).not.toBe('showdown');
    // CRITICAL: NO seat reveals hole cards on a fold-win — not the folder, and
    // crucially NOT the winner (real poker: you never show on a fold-around).
    for (const s of result.perSeat) {
      expect(s.holeCards).toBeNull();
    }
    // The winner (seat 1, BB) still takes the pot; chips conserve.
    const seat1 = result.perSeat.find((s) => s.seatIndex === 1)!;
    expect(seat1.isWinner).toBe(true);
    expect(seat1.net).toBe(1); // won the SB's dead 1 chip
    expect(netSum(result)).toBe(0);
    expect(totalCommitted(result)).toBe(3); // SB 1 + BB 2
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 6-seat multi-way all-in side pots
// ─────────────────────────────────────────────────────────────────────────────

describe('poker-table-sim — 6-seat multi-way all-in side pots', () => {
  it('forms correct side pots with dead money + eligibility', () => {
    const h = makeHarness();
    const handNumber = 3;
    // Stacks chosen so all-ins create DISTINCT commit levels → layered side pots.
    // Seats 0..5. Button = 0 → SB = 1, BB = 2, UTG (first to act) = 3.
    h.sim.startHand({
      tableId: 't6',
      handNumber,
      seatAssignments: [
        seatAssign(0, 100),
        seatAssign(1, 100),
        seatAssign(2, 100),
        seatAssign(3, 10), // short — will be all-in for 10
        seatAssign(4, 25), // medium — all-in for 25
        seatAssign(5, 100),
      ],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });

    // Preflop order from UTG=3: 3,4,5,0,1,2.
    // 3 shoves all-in to 10 (a "bet to 10" = raise to 10 since currentBet=2).
    h.sim.applyAction('t6', av(3), { kind: 'raise', amount: 10 }, { idempotencyKey: nextKey() });
    // 4 shoves all-in to 25 (full raise over 10).
    h.sim.applyAction('t6', av(4), { kind: 'raise', amount: 25 }, { idempotencyKey: nextKey() });
    // 5 calls 25.
    h.sim.applyAction('t6', av(5), { kind: 'call' }, { idempotencyKey: nextKey() });
    // 0 (button) folds.
    h.sim.applyAction('t6', av(0), { kind: 'fold' }, { idempotencyKey: nextKey() });
    // 1 (SB) folds — its 1 chip is DEAD MONEY in the main pot.
    h.sim.applyAction('t6', av(1), { kind: 'fold' }, { idempotencyKey: nextKey() });
    // 2 (BB) calls 25. Preflop round completes (3 & 4 all-in; 2 & 5 square at 25).
    h.sim.applyAction('t6', av(2), { kind: 'call' }, { idempotencyKey: nextKey() });

    // Seats 2 & 5 still have chips behind (75 each) so betting CONTINUES on the
    // remaining streets between them (seats 3 & 4 are all-in and sit out). They
    // check down flop, turn, river → showdown. Postflop first-to-act = first
    // active left of the button (0): seat 2.
    let snap = h.sim.getPublicSnapshot('t6')!;
    expect(snap.street).toBe('flop');
    expect(snap.toActSeatIndex).toBe(2);
    h.sim.applyAction('t6', av(2), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('t6', av(5), { kind: 'check' }, { idempotencyKey: nextKey() });
    snap = h.sim.getPublicSnapshot('t6')!;
    expect(snap.street).toBe('turn');
    h.sim.applyAction('t6', av(2), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('t6', av(5), { kind: 'check' }, { idempotencyKey: nextKey() });
    snap = h.sim.getPublicSnapshot('t6')!;
    expect(snap.street).toBe('river');
    h.sim.applyAction('t6', av(2), { kind: 'check' }, { idempotencyKey: nextKey() });
    const r = h.sim.applyAction('t6', av(5), { kind: 'check' }, { idempotencyKey: nextKey() });

    expect(r.handComplete).toBe(true);
    expect(h.completed.length).toBe(1);
    const result = h.completed[0]!;

    // Commit levels: seat3=10, seat4=25, seat5=25, seat2=25, seat1=1 (dead), seat0=0.
    // Build expected side pots from the SAME engine math over those commits.
    const commits: Record<number, number> = { 0: 0, 1: 1, 2: 25, 3: 10, 4: 25, 5: 25 };
    const folded = new Set([0, 1]);
    const playSeats: PlaySeat[] = [0, 1, 2, 3, 4, 5].map((seat) => ({
      seat,
      isHuman: true,
      personality: null,
      hole: [{ suit: 'clubs', rank: '2' }, { suit: 'clubs', rank: '3' }],
      stack: 0n,
      committedTotal: BigInt(commits[seat]!),
      streetCommitted: BigInt(commits[seat]!),
      status: folded.has(seat) ? 'folded' : 'active',
      hasActed: true,
    }));
    const expectedPots = buildSidePots(playSeats);

    // The sim's reported side pots must match the engine's pot layering.
    const simPots = result.sidePots.map((p) => ({
      amount: p.amount,
      eligible: [...p.eligibleSeatIndices].sort((a, b) => a - b),
    }));
    const enginePots = expectedPots.map((p) => ({
      amount: Number(p.amount),
      eligible: [...p.eligibleSeats].sort((a, b) => a - b),
    }));
    expect(simPots).toEqual(enginePots);

    // Total pot == sum of commits (incl. dead money 1 from the folded SB).
    const expectedTotal = Object.values(commits).reduce((a, b) => a + b, 0);
    expect(totalCommitted(result)).toBe(expectedTotal);
    // Main pot eligibility must NOT include folded seats 0 or 1.
    for (const p of result.sidePots) {
      expect(p.eligibleSeatIndices).not.toContain(0);
      expect(p.eligibleSeatIndices).not.toContain(1);
    }
    // Chip conservation.
    expect(netSum(result)).toBe(0);

    // Award correctness: winners among contenders {2,3,4,5} by the real deal.
    const deal = replicateDeal(handNumber, [0, 1, 2, 3, 4, 5]);
    // Cross-check: the sim's awarded chips equal a fresh awardPots over the same
    // commits + the real hole cards + the full board.
    const realPlaySeats: PlaySeat[] = [0, 1, 2, 3, 4, 5].map((seat) => ({
      seat,
      isHuman: true,
      personality: null,
      hole: deal.holeBySeat.get(seat)!,
      stack: 0n,
      committedTotal: BigInt(commits[seat]!),
      streetCommitted: 0n,
      status: folded.has(seat) ? 'folded' : 'active',
      hasActed: true,
    }));
    const expectedSettledPots = buildSidePots(realPlaySeats);
    const expectedAward = awardPots(
      realPlaySeats,
      expectedSettledPots,
      deal.board5,
      'showdown',
    );
    expect(result.settledPots).toEqual(
      serializeSettledPots(expectedSettledPots, expectedAward, 'showdown'),
    );
    for (const er of expectedAward) {
      const simSeat = result.perSeat.find((s) => s.seatIndex === er.seat)!;
      expect(simSeat.won).toBe(Number(er.won));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. canReopen rule in the NEW driver
// ─────────────────────────────────────────────────────────────────────────────

describe('poker-table-sim — canReopen / short all-in', () => {
  it('short all-in does NOT reopen an already-acted seat and does NOT shrink min-raise', () => {
    const h = makeHarness();
    const handNumber = 11;
    // 3 seats: 0 (button/—), 1 (SB), 2 (BB). Big stacks for the raiser/caller,
    // a SHORT stack to create the sub-min all-in.
    // Button=0 → SB=1, BB=2, first to act preflop = seat 0 (UTG in 3-handed,
    // seat after BB wraps to 0).
    h.sim.startHand({
      tableId: 'cr',
      handNumber,
      seatAssignments: [
        seatAssign(0, 200), // UTG: will raise to 20
        seatAssign(1, 26), // SB: short — will shove all-in to 26 (a short raise over 20)
        seatAssign(2, 200), // BB: acts after the short all-in — must NOT be allowed to re-raise
      ],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });

    // Seat 0 (UTG) raises to 20. min-raise increment becomes 18 (20 - 2).
    let res = h.sim.applyAction('cr', av(0), { kind: 'raise', amount: 20 }, { idempotencyKey: nextKey() });
    expect(res.ok).toBe(true);
    let snap = h.sim.getPublicSnapshot('cr')!;
    expect(snap.toActSeatIndex).toBe(1); // SB to act
    // currentBet=20, min-raise increment=18 → minRaiseTo for next full raise = 38.

    // Seat 1 (SB) shoves all-in to 26. That's a raise OVER 20 by only 6 < 18 →
    // a SHORT all-in. It lifts currentBet to 26 but does NOT reopen action and
    // does NOT shrink the min-raise.
    res = h.sim.applyAction('cr', av(1), { kind: 'raise', amount: 26 }, { idempotencyKey: nextKey() });
    expect(res.ok).toBe(true);
    snap = h.sim.getPublicSnapshot('cr')!;
    expect(snap.toActSeatIndex).toBe(2); // BB to act facing the short all-in
    expect(snap.toCall).toBe(26 - 2); // BB has 2 in, owes 24 to reach 26

    // BB (seat 2) was YET TO ACT this round → it KEEPS full raise rights.
    // A full re-raise must clear currentBet(26) + min-raise(18) = 44.
    // First assert BB CAN raise (it's in the legal set).
    const bbPrivate = h.privateByAvatar.get(av(2))!;
    expect(bbPrivate.legalActions).toContain('raise');
    // minRaiseTo for BB = 26 + 18 = 44 (min-raise NOT shrunk by the short all-in).
    expect(bbPrivate.minRaiseTo).toBe(44);

    // BB makes a FULL legal raise to 44 → this reopens action to seat 0.
    res = h.sim.applyAction('cr', av(2), { kind: 'raise', amount: 44 }, { idempotencyKey: nextKey() });
    expect(res.ok).toBe(true);
    snap = h.sim.getPublicSnapshot('cr')!;
    // Seat 1 is all-in (can't act). Action goes back to seat 0 (reopened).
    expect(snap.toActSeatIndex).toBe(0);

    // Seat 0 already acted, faces a FULL raise (BB's 44 over 26 = 18 ≥ min-raise)
    // → action WAS reopened, so seat 0 CAN raise again. (Sanity: reopened path.)
    const s0Private = h.privateByAvatar.get(av(0))!;
    expect(s0Private.legalActions).toContain('raise');

    // Now the KEY assertion: simulate the SHORT-all-in NON-reopen on an
    // already-acted seat. Make seat 0 just CALL to 44.
    res = h.sim.applyAction('cr', av(0), { kind: 'call' }, { idempotencyKey: nextKey() });
    expect(res.ok).toBe(true);
    // Seat 1 was all-in at 26 < 44; main/side pots resolve. Hand should complete
    // (seat 1 all-in, seats 0 & 2 matched at 44 with no further action).
    // It may complete or there may be a final street run-out; either way the
    // illegal-reraise behavior was the point — assert it separately below.
  });

  it('a non-all-in sub-min raise is rejected (must be ≥ min-raise)', () => {
    const h = makeHarness();
    const handNumber = 12;
    // Button=0 → SB=1, BB=2, first to act = seat 3 (UTG). All deep stacks.
    h.sim.startHand({
      tableId: 'cr2',
      handNumber,
      seatAssignments: [
        seatAssign(0, 200),
        seatAssign(1, 200),
        seatAssign(2, 200),
        seatAssign(3, 200),
      ],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });
    // 3 (UTG) raises to 20. min-raise increment = 18 → next min-raise to = 38.
    h.sim.applyAction('cr2', av(3), { kind: 'raise', amount: 20 }, { idempotencyKey: nextKey() });
    // 0 (deep) tries a NON-all-in raise to 30 (over 20 by only 10 < 18). Illegal.
    const bad = h.sim.applyAction('cr2', av(0), { kind: 'raise', amount: 30 }, { idempotencyKey: nextKey() });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('raise_below_min');
    // A legal full raise to 38 is accepted.
    const good = h.sim.applyAction('cr2', av(0), { kind: 'raise', amount: 38 }, { idempotencyKey: nextKey() });
    expect(good.ok).toBe(true);
  });

  it('already-acted caller may only call/fold over a genuine short all-in', () => {
    const h = makeHarness();
    const handNumber = 21;
    // Button=0 → SB=1, BB=2, UTG first-to-act = seat 3.
    // Seat 1 (SB) is SHORT (29 chips) so its all-in shove is a sub-min raise.
    h.sim.startHand({
      tableId: 'cr3',
      handNumber,
      seatAssignments: [
        seatAssign(0, 200),
        seatAssign(1, 29), // SB short: all-in shove to 29 is a short raise over 20
        seatAssign(2, 200),
        seatAssign(3, 200),
      ],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });

    // 3 (UTG) raises to 20. min-raise increment = 18.
    h.sim.applyAction('cr3', av(3), { kind: 'raise', amount: 20 }, { idempotencyKey: nextKey() });
    // 0 calls 20 → ACTED + square.
    h.sim.applyAction('cr3', av(0), { kind: 'call' }, { idempotencyKey: nextKey() });
    // 1 (SB, short) shoves all-in to 29. 29-20 = 9 < 18 → SHORT all-in. Legal
    // because it's all-in. Lifts currentBet to 29, does NOT reopen, does NOT
    // shrink min-raise (still 18).
    let res = h.sim.applyAction('cr3', av(1), { kind: 'raise', amount: 29 }, { idempotencyKey: nextKey() });
    expect(res.ok).toBe(true);
    let snap = h.sim.getPublicSnapshot('cr3')!;

    // 2 (BB) has NOT acted → keeps full rights; can raise. minRaiseTo = 29+18=47.
    const bbPriv = h.privateByAvatar.get(av(2))!;
    expect(bbPriv.legalActions).toContain('raise');
    expect(bbPriv.minRaiseTo).toBe(47);
    // 2 just calls to 29.
    h.sim.applyAction('cr3', av(2), { kind: 'call' }, { idempotencyKey: nextKey() });
    // Action returns to seat 3 (raised to 20 originally; now owes 9 more to 29).
    // Seat 3 ALREADY ACTED and is re-acting ONLY because the short all-in lifted
    // the bet → it may ONLY call or fold (NO raise).
    snap = h.sim.getPublicSnapshot('cr3')!;
    expect(snap.toActSeatIndex).toBe(3);
    const s3Priv = h.privateByAvatar.get(av(3))!;
    expect(s3Priv.legalActions).not.toContain('raise');
    expect(s3Priv.legalActions).toContain('call');
    expect(s3Priv.legalActions).toContain('fold');

    // And an actual raise attempt is rejected.
    res = h.sim.applyAction('cr3', av(3), { kind: 'raise', amount: 60 }, { idempotencyKey: nextKey() });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('action_not_reopened');

    // Seat 0 (the OTHER already-acted seat) likewise has no raise rights once it
    // is its turn. But first let seat 3 CALL to keep the hand moving.
    res = h.sim.applyAction('cr3', av(3), { kind: 'call' }, { idempotencyKey: nextKey() });
    expect(res.ok).toBe(true);
    // Now seat 0 to act (owes 9 to reach 29); also already acted → call/fold only.
    snap = h.sim.getPublicSnapshot('cr3')!;
    expect(snap.toActSeatIndex).toBe(0);
    const s0Priv = h.privateByAvatar.get(av(0))!;
    expect(s0Priv.legalActions).not.toContain('raise');
    const bad = h.sim.applyAction('cr3', av(0), { kind: 'raise', amount: 80 }, { idempotencyKey: nextKey() });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('action_not_reopened');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Turn timeout
// ─────────────────────────────────────────────────────────────────────────────

describe('poker-table-sim — turn timeout', () => {
  it('auto-folds a seat facing a bet that never acts; hand advances', () => {
    const h = makeHarness();
    const handNumber = 31;
    h.sim.startHand({
      tableId: 'to',
      handNumber,
      seatAssignments: [seatAssign(0, 100), seatAssign(1, 100), seatAssign(2, 100)],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });
    // UTG = seat 0 (3-handed, after BB=2 wraps to 0). It owes 2 (toCall=2).
    let snap = h.sim.getPublicSnapshot('to')!;
    expect(snap.toActSeatIndex).toBe(0);
    expect(snap.toCall).toBe(2);

    // Seat 0 never acts → fire its turn timer → auto-fold.
    h.clock.fireNext();
    snap = h.sim.getPublicSnapshot('to')!;
    expect(snap.seats.find((s) => s.seatIndex === 0)!.status).toBe('folded');
    // Action moved to seat 1 (SB), who owes 1.
    expect(snap.toActSeatIndex).toBe(1);

    // Seat 1 also times out → auto-fold → seat 2 (BB) wins uncontested.
    h.clock.fireNext();
    expect(h.completed.length).toBe(1);
    const result = h.completed[0]!;
    expect(result.endedAt).toBe('preflop'); // folded before any community card
    expect(result.board.length).toBe(0);
    // BB (seat 2) wins the blinds. Chip conservation.
    expect(netSum(result)).toBe(0);
    const winner = result.perSeat.find((s) => s.isWinner)!;
    expect(winner.seatIndex).toBe(2);
  });

  it('auto-checks a seat with nothing owed (toCall===0)', () => {
    const h = makeHarness();
    const handNumber = 32;
    h.sim.startHand({
      tableId: 'to2',
      handNumber,
      seatAssignments: [seatAssign(0, 100), seatAssign(1, 100)],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });
    // Heads-up. SB(0) calls to 2.
    h.sim.applyAction('to2', av(0), { kind: 'call' }, { idempotencyKey: nextKey() });
    // BB(1) to act with toCall===0 (option). Times out → auto-CHECK → flop.
    let snap = h.sim.getPublicSnapshot('to2')!;
    expect(snap.toActSeatIndex).toBe(1);
    expect(snap.toCall).toBe(0);
    h.clock.fireNext();
    snap = h.sim.getPublicSnapshot('to2')!;
    // Auto-check closed the round → advanced to flop, nobody folded.
    expect(snap.street).toBe('flop');
    expect(snap.board.length).toBe(3);
    expect(snap.seats.find((s) => s.seatIndex === 1)!.status).toBe('active');
  });

  it('agent seats get the grace window added to the deadline', () => {
    const h = makeHarness();
    const handNumber = 33;
    h.sim.startHand({
      tableId: 'to3',
      handNumber,
      seatAssignments: [seatAssign(0, 100, 'agent'), seatAssign(1, 100, 'human')],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 10_000,
      agentTurnGraceMs: 5_000,
    });
    // Seat 0 is an agent + first to act → deadline = now + 10_000 + 5_000.
    const snap = h.sim.getPublicSnapshot('to3')!;
    expect(snap.toActSeatIndex).toBe(0);
    expect(snap.toActDeadlineMs).toBe(h.clock.now() + 15_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Hidden-state invariant
// ─────────────────────────────────────────────────────────────────────────────

describe('poker-table-sim — hidden state', () => {
  it('no broadcast snapshot ever carries another seat hole cards; board never exceeds street count; seed hidden until showdown', () => {
    const h = makeHarness();
    const handNumber = 41;
    h.sim.startHand({
      tableId: 'hs',
      handNumber,
      seatAssignments: [seatAssign(0, 100), seatAssign(1, 100), seatAssign(2, 100)],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });

    const deal = replicateDeal(handNumber, [0, 1, 2]);
    const allHoleStrings = new Set<string>();
    for (const [, cards] of deal.holeBySeat) {
      for (const card of cards) allHoleStrings.add(`${card.suit}:${card.rank}`);
    }

    // Drive a hand to showdown: everyone calls/checks down.
    // Preflop UTG=0 calls, SB=1 calls, BB=2 checks.
    const streetExpectedBoard: Record<Street, number> = {
      preflop: 0,
      flop: 3,
      turn: 4,
      river: 5,
      showdown: 5,
    };

    // Helper to assert EVERY broadcast snapshot so far is leak-free + board-bounded.
    function assertSnapshotsClean(): void {
      for (const snap of h.snapshots) {
        // (a) board never exceeds the street's card count.
        expect(snap.board.length).toBe(streetExpectedBoard[snap.street]);
        // (b) the serialized public snapshot string contains NO field literally
        //     named holeCards (type guarantees it, but assert at runtime too).
        const json = JSON.stringify(snap);
        expect(json).not.toContain('holeCards');
        // (c) board cards on the snapshot are community cards; they may coincide
        //     with hole cards ONLY if a hole card is also on the board, which the
        //     deal forbids (52 unique). So any board card that equals a hole card
        //     would be a leak of a duplicate — assert board ⊆ the 5 community.
        const communitySet = new Set(deal.board5.slice(0, snap.board.length).map((cc) => `${cc.suit}:${cc.rank}`));
        for (const bc of snap.board) {
          expect(communitySet.has(`${bc.suit}:${bc.rank}`)).toBe(true);
        }
      }
    }

    h.sim.applyAction('hs', av(0), { kind: 'call' }, { idempotencyKey: nextKey() });
    assertSnapshotsClean();
    h.sim.applyAction('hs', av(1), { kind: 'call' }, { idempotencyKey: nextKey() });
    assertSnapshotsClean();
    h.sim.applyAction('hs', av(2), { kind: 'check' }, { idempotencyKey: nextKey() });
    assertSnapshotsClean();

    // Flop: SB(1) first to act postflop. Everyone checks down each street.
    h.sim.applyAction('hs', av(1), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('hs', av(2), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('hs', av(0), { kind: 'check' }, { idempotencyKey: nextKey() });
    assertSnapshotsClean();
    // Turn.
    h.sim.applyAction('hs', av(1), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('hs', av(2), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('hs', av(0), { kind: 'check' }, { idempotencyKey: nextKey() });
    assertSnapshotsClean();
    // River.
    h.sim.applyAction('hs', av(1), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('hs', av(2), { kind: 'check' }, { idempotencyKey: nextKey() });
    const fin = h.sim.applyAction('hs', av(0), { kind: 'check' }, { idempotencyKey: nextKey() });
    expect(fin.handComplete).toBe(true);

    // Pre-showdown snapshots: assert NONE contained the seed. We look at every
    // snapshot EXCEPT the final showdown one for the revealed seed.
    const preShowdownSnaps = h.snapshots.filter((s) => s.street !== 'showdown');
    for (const snap of preShowdownSnaps) {
      const json = JSON.stringify(snap);
      expect(json).not.toContain(SERVER); // seed never in a public frame
    }
    // Hole cards ONLY ever arrived via the per-seat channel.
    for (const seatIdx of [0, 1, 2]) {
      const priv = h.allPrivate.get(av(seatIdx));
      expect(priv).toBeDefined();
      expect(priv!.length).toBeGreaterThan(0);
      // Each seat's private view carried EXACTLY its own hole cards.
      for (const view of priv!) {
        expect(view.seatIndex).toBe(seatIdx);
        expect(view.holeCards).toEqual(deal.holeBySeat.get(seatIdx)!);
      }
    }
    // The completed result reveals the seed (showdown only).
    expect(h.completed[0]!.serverSeedRevealed).toBe(SERVER);

    // Final leak-free pass over ALL snapshots (incl. showdown — which still has
    // NO holeCards field; hole cards surface only in HandResult.perSeat).
    for (const snap of h.snapshots) {
      expect(JSON.stringify(snap)).not.toContain('holeCards');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('poker-table-sim — idempotency', () => {
  it('a duplicate applyAction with the same idempotencyKey is a no-op', () => {
    const h = makeHarness();
    const handNumber = 51;
    h.sim.startHand({
      tableId: 'idem',
      handNumber,
      seatAssignments: [seatAssign(0, 100), seatAssign(1, 100)],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });
    // Heads-up: SB(0) raises to 6 with key "dup".
    const r1 = h.sim.applyAction('idem', av(0), { kind: 'raise', amount: 6 }, { idempotencyKey: 'dup' });
    expect(r1.ok).toBe(true);
    const seat0After = h.sim.getPublicSnapshot('idem')!.seats.find((s) => s.seatIndex === 0)!;
    const committedAfterFirst = seat0After.totalCommitted;
    const stackAfterFirst = seat0After.chipStack;

    // Replaying the SAME key must NOT move chips again, and must return the same
    // result object content.
    const r2 = h.sim.applyAction('idem', av(0), { kind: 'raise', amount: 6 }, { idempotencyKey: 'dup' });
    expect(r2).toEqual(r1);
    const seat0Again = h.sim.getPublicSnapshot('idem')!.seats.find((s) => s.seatIndex === 0)!;
    expect(seat0Again.totalCommitted).toBe(committedAfterFirst);
    expect(seat0Again.chipStack).toBe(stackAfterFirst);
    // It's still seat 1's turn (the dup did not double-advance).
    expect(h.sim.getPublicSnapshot('idem')!.toActSeatIndex).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6b. All-in-on-blind/ante seat is NEVER set as the actor (regression)
//
// REGRESSION for the critical adversarial finding: the preflop first-to-act seat
// was set as the actor WITHOUT skipping all-in/folded seats. A seat that went
// all-in on a blind/ante post got the action and was then auto-FOLDED by the
// turn clock — stripping its showdown eligibility / built pot share (money loss
// + chip non-conservation), which is impossible in NLHE: an all-in seat has live
// cards and MUST reach showdown.
// ─────────────────────────────────────────────────────────────────────────────

describe('poker-table-sim — all-in-on-post seat reaches showdown (regression)', () => {
  it('heads-up: button/SB all-in for 1 on the SB post is NOT auto-folded; hand runs to showdown', () => {
    const h = makeHarness();
    const handNumber = 71;
    // Heads-up. Button = seat 0 → posts SB. Stack = 1, so SB=1 puts seat 0 ALL-IN
    // on the post (stack→0, status→allin). Seat 1 (BB) has a real stack. NO ANTE.
    h.sim.startHand({
      tableId: 'aib',
      handNumber,
      seatAssignments: [seatAssign(0, 1), seatAssign(1, 100)],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });

    // Seat 0 is all-in from the SB post. It MUST NOT be the actor (it cannot act).
    const first = h.snapshots[0]!;
    expect(first.seats.find((s) => s.seatIndex === 0)!.status).toBe('allin');
    expect(first.seats.find((s) => s.seatIndex === 0)!.chipStack).toBe(0);
    expect(first.toActSeatIndex).not.toBe(0);

    // Only one seat could voluntarily act (BB) facing an all-in for less than the
    // blind → no betting is possible → the board runs straight out to showdown.
    // The hand must complete WITHOUT any applyAction and WITHOUT a fold.
    expect(h.completed.length).toBe(1);
    const result = h.completed[0]!;
    expect(result.endedAt).toBe('showdown');
    expect(result.board.length).toBe(5);

    // Seat 0 (all-in) reached showdown — it is NOT folded.
    const seat0 = result.perSeat.find((s) => s.seatIndex === 0)!;
    expect(seat0.status).toBe('allin');

    // Chip conservation. Seat 0 committed exactly 1; the BB's uncalled excess (it
    // posted 2 but seat 0 is in for only 1) is returned, so the contested pot is
    // 2 and seat 0 can net at most +1 (win) or -1 (lose).
    expect(netSum(result)).toBe(0);
    expect(seat0.totalCommitted).toBe(1);

    // The winner(s) are determined by the real 5-card board, NOT an auto-fold
    // giveaway. Cross-check the sim's awards against an INDEPENDENT engine award
    // over the SAME deal + the SAME commit profile (seat0 all-in for 1, seat1
    // in for 2 with its 1 excess uncalled). This is the divergence guard and
    // proves the all-in seat was settled at showdown, not folded.
    const deal = replicateDeal(handNumber, [0, 1]);
    const engineSeats: PlaySeat[] = [
      {
        seat: 0,
        isHuman: true,
        personality: null,
        hole: deal.holeBySeat.get(0)!,
        stack: 0n,
        committedTotal: 1n,
        streetCommitted: 0n,
        status: 'allin',
        hasActed: true,
      },
      {
        seat: 1,
        isHuman: true,
        personality: null,
        hole: deal.holeBySeat.get(1)!,
        stack: 98n,
        committedTotal: 2n,
        streetCommitted: 0n,
        status: 'active',
        hasActed: true,
      },
    ];
    const engineAward = awardPots(engineSeats, buildSidePots(engineSeats), deal.board5, 'showdown');
    for (const er of engineAward) {
      const simSeat = result.perSeat.find((s) => s.seatIndex === er.seat)!;
      expect(simSeat.won).toBe(Number(er.won));
    }
    // Seat 0 contributed exactly 1, so its net is bounded by ±1 (never the −1
    // forced loss an auto-fold of a winning/tying live hand would have produced).
    expect(seat0.net).toBeGreaterThanOrEqual(-1);
    expect(seat0.net).toBeLessThanOrEqual(1);
    // And BB's uncalled 1-chip excess was returned, never destroyed.
    expect(result.perSeat.find((s) => s.seatIndex === 1)!.totalCommitted).toBe(2);
  });

  it('firing the turn timer never folds the all-in-on-post seat (it is already resolved)', () => {
    const h = makeHarness();
    const handNumber = 72;
    h.sim.startHand({
      tableId: 'aib2',
      handNumber,
      seatAssignments: [seatAssign(0, 1), seatAssign(1, 100)],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });
    // Hand already resolved at start (no actionable betting). No live timer should
    // remain that could fire and fold the all-in seat.
    expect(h.completed.length).toBe(1);
    expect(h.completed[0]!.perSeat.find((s) => s.seatIndex === 0)!.status).toBe('allin');
    // Defensive: even if a stray timer fired, the table is gone / hand ended so
    // onTurnTimeout is a no-op and cannot mutate the result.
    h.sim.onTurnTimeout('aib2');
    expect(h.completed.length).toBe(1);
    expect(h.completed[0]!.perSeat.find((s) => s.seatIndex === 0)!.status).toBe('allin');
  });

  it('3-handed: a seat all-in on the ante does NOT get the action / get auto-folded', () => {
    const h = makeHarness();
    const handNumber = 73;
    // 3-handed with an ante of 5. Button = 0 → SB = 1, BB = 2, UTG (first to act)
    // = seat 0 (wraps after BB). Seat 0 (UTG) has stack 5 → the ante puts it
    // ALL-IN before any blind. The OLD code set seat 0 (UTG) as the preflop actor
    // and the turn clock auto-folded it. With the fix, seat 0 is skipped.
    h.sim.startHand({
      tableId: 'ante3',
      handNumber,
      seatAssignments: [seatAssign(0, 5), seatAssign(1, 200), seatAssign(2, 200)],
      blinds: { sb: 1, bb: 2, ante: 5 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });

    const first = h.snapshots[0]!;
    // Seat 0 went all-in on the ante (5 ante == 5 stack).
    expect(first.seats.find((s) => s.seatIndex === 0)!.status).toBe('allin');
    expect(first.seats.find((s) => s.seatIndex === 0)!.chipStack).toBe(0);
    // The actor is NOT the all-in seat 0; it is the first ACTIONABLE seat. UTG=0
    // is all-in, so the first actor scanning from seat-after-BB (=0) skips 0 and
    // lands on seat 1 (SB), the first active+chips seat in wrap order.
    expect(first.toActSeatIndex).toBe(1);
    expect(first.seats.find((s) => s.seatIndex === first.toActSeatIndex!)!.status).toBe('active');

    // Drive the timer on the real actor a few times — the all-in seat 0 must NEVER
    // become the actor and must NEVER be folded by a timeout.
    // SB(1) and BB(2) fold to a timeout in turn → seat 0 (all-in) wins uncontested
    // among live seats? No — seat 0 is all-in, seats 1 & 2 can still fold. If both
    // fold, only seat 0 remains live → it wins WITHOUT being folded.
    h.clock.fireNext(); // seat 1 (SB) times out facing the ante/blind → auto-fold
    let snap = h.sim.getPublicSnapshot('ante3');
    if (snap) {
      // Seat 0 still all-in (never folded), action never handed to it.
      expect(snap.seats.find((s) => s.seatIndex === 0)!.status).toBe('allin');
      expect(snap.toActSeatIndex).not.toBe(0);
    }
    // Fire the remaining actor's timer to drive the hand to completion.
    while (h.completed.length === 0) {
      h.clock.fireNext();
    }
    const result = h.completed[0]!;
    // Seat 0 was all-in from the ante and NEVER folded — it is live at the end.
    const seat0 = result.perSeat.find((s) => s.seatIndex === 0)!;
    expect(seat0.status).toBe('allin');
    expect(netSum(result)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PARITY: sim showdown math == engine showdown math
// ─────────────────────────────────────────────────────────────────────────────

describe('poker-table-sim — parity with engine showdown math', () => {
  it('an identical commit profile + deal awards identically through sim and engine', () => {
    // Drive a sim hand where the LIVE betting produces a known commit profile,
    // then independently run the SAME commits + the SAME deal through the engine
    // primitives (buildSidePots + awardPots) and assert identical awards. This is
    // the divergence guard: the sim reuses the engine's pure showdown functions,
    // so the only thing that could differ is the BETTING driver's commit math.
    const h = makeHarness();
    const handNumber = 61;
    h.sim.startHand({
      tableId: 'par',
      handNumber,
      seatAssignments: [seatAssign(0, 50), seatAssign(1, 50), seatAssign(2, 50)],
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: SERVER,
      clientSeed: CLIENT,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });
    // UTG=0 raises to 6, SB=1 calls, BB=2 calls → each at 6 preflop.
    h.sim.applyAction('par', av(0), { kind: 'raise', amount: 6 }, { idempotencyKey: nextKey() });
    h.sim.applyAction('par', av(1), { kind: 'call' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('par', av(2), { kind: 'call' }, { idempotencyKey: nextKey() });
    // Flop: check, check, check.
    h.sim.applyAction('par', av(1), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('par', av(2), { kind: 'check' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('par', av(0), { kind: 'check' }, { idempotencyKey: nextKey() });
    // Turn: SB(1) bets 10, BB(2) calls, UTG(0) folds.
    h.sim.applyAction('par', av(1), { kind: 'bet', amount: 10 }, { idempotencyKey: nextKey() });
    h.sim.applyAction('par', av(2), { kind: 'call' }, { idempotencyKey: nextKey() });
    h.sim.applyAction('par', av(0), { kind: 'fold' }, { idempotencyKey: nextKey() });
    // River: SB(1) checks, BB(2) checks → showdown between 1 and 2.
    h.sim.applyAction('par', av(1), { kind: 'check' }, { idempotencyKey: nextKey() });
    const fin = h.sim.applyAction('par', av(2), { kind: 'check' }, { idempotencyKey: nextKey() });
    expect(fin.handComplete).toBe(true);

    const result = h.completed[0]!;
    // Final commits: seat0 = 6 (folded on turn, dead money), seat1 = 16, seat2 = 16.
    const commits: Record<number, number> = { 0: 6, 1: 16, 2: 16 };
    expect(result.perSeat.find((s) => s.seatIndex === 0)!.totalCommitted).toBe(6);
    expect(result.perSeat.find((s) => s.seatIndex === 1)!.totalCommitted).toBe(16);
    expect(result.perSeat.find((s) => s.seatIndex === 2)!.totalCommitted).toBe(16);

    // Independent engine award over the SAME deal + commits.
    const deal = replicateDeal(handNumber, [0, 1, 2]);
    const engineSeats: PlaySeat[] = [0, 1, 2].map((seat) => ({
      seat,
      isHuman: true,
      personality: null,
      hole: deal.holeBySeat.get(seat)!,
      stack: 0n,
      committedTotal: BigInt(commits[seat]!),
      streetCommitted: 0n,
      status: seat === 0 ? 'folded' : 'active',
      hasActed: true,
    }));
    const enginePots = buildSidePots(engineSeats);
    const engineAward = awardPots(engineSeats, enginePots, deal.board5, 'showdown');
    expect(result.settledPots).toEqual(
      serializeSettledPots(enginePots, engineAward, 'showdown'),
    );
    for (const er of engineAward) {
      const simSeat = result.perSeat.find((s) => s.seatIndex === er.seat)!;
      expect(simSeat.won).toBe(Number(er.won));
      expect(simSeat.net).toBe(Number(er.won) - commits[er.seat]!);
    }
    // Conservation.
    expect(netSum(result)).toBe(0);
    expect(totalCommitted(result)).toBe(6 + 16 + 16);
  });
});
