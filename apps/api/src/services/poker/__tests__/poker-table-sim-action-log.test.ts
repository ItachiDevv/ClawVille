/**
 * Public per-hand action log on `PokerTableSim` (founder order 2026-10-21:
 * "everything needs to be seen on the front end during a cards game").
 *
 * Proves: posted blinds come first; every applied action and every turn-clock
 * auto-action is logged with the right chips / streetBetAfter / allIn /
 * timeout / street / atMs; the log resets per hand; snapshots and HandResult
 * carry COPIES (mutation-safe); a log entry carries only the contract fields
 * (no hole cards, no seeds).
 */

import { describe, expect, it } from 'bun:test';
import type { HoldemTableActionLogEntry } from '@clawville/shared';
import { PokerTableSim } from '../poker-table-sim';
import type { HandResult, SeatAssignment, SimClock } from '../poker-table-types';

const SERVER = 'b'.repeat(64);
const CLIENT = 'deadbeef';
const TID = 'log-table';

interface Timer {
  cb: () => void;
  fireAt: number;
  cancelled: boolean;
}

class Clock implements SimClock {
  t = 5_000_000;
  timers: Timer[] = [];
  now(): number {
    return this.t;
  }
  setTimer(cb: () => void, ms: number): unknown {
    const timer: Timer = { cb, fireAt: this.t + ms, cancelled: false };
    this.timers.push(timer);
    return timer;
  }
  clearTimer(handle: unknown): void {
    (handle as Timer).cancelled = true;
  }
  /** Jump to the next live timer's deadline and fire it. */
  fireNext(): void {
    const live = this.timers.filter((x) => !x.cancelled);
    if (live.length === 0) throw new Error('no pending timer');
    const next = live.reduce((m, x) => (x.fireAt < m.fireAt ? x : m));
    this.t = Math.max(this.t, next.fireAt);
    next.cancelled = true;
    next.cb();
  }
}

const CONTRACT_KEYS = [
  'allIn',
  'atMs',
  'chips',
  'kind',
  'seatIndex',
  'seq',
  'street',
  'streetBetAfter',
  'timeout',
].sort();

function seat(seatIndex: number, chipStack: number): SeatAssignment {
  return {
    seatIndex,
    avatarId: `av-${seatIndex}`,
    name: `Name ${seatIndex}`,
    subjectType: 'human',
    chipStack,
  };
}

function start(
  sim: PokerTableSim,
  handNumber: number,
  seats: SeatAssignment[],
  buttonSeatIndex: number,
): void {
  sim.startHand({
    tableId: TID,
    handNumber,
    seatAssignments: seats,
    blinds: { sb: 1, bb: 2, ante: 0 },
    buttonSeatIndex,
    serverSeed: SERVER,
    clientSeed: CLIENT,
    turnClockMs: 20_000,
    agentTurnGraceMs: 0,
  });
}

/** Compare the meaningful fields; atMs is asserted separately. */
function shape(entries: HoldemTableActionLogEntry[]) {
  return entries.map(({ atMs: _atMs, ...rest }) => rest);
}

describe('PokerTableSim — public action log', () => {
  it('logs blinds, call, raise, fold, bet and a timeout auto-fold for a scripted hand', () => {
    const clock = new Clock();
    const sim = new PokerTableSim(clock);
    const results: HandResult[] = [];
    sim.setHandCompleteFn((_tid, r) => results.push(r));
    const t0 = clock.t;

    // 3-handed, button 0 -> SB seat 1, BB seat 2, seat 0 first to act preflop.
    start(sim, 1, [seat(0, 100), seat(1, 100), seat(2, 100)], 0);
    let snap = sim.getPublicSnapshot(TID)!;
    expect(shape(snap.actions)).toEqual([
      { seq: 0, seatIndex: 1, street: 'preflop', kind: 'post-sb', chips: 1, streetBetAfter: 1, allIn: false, timeout: false },
      { seq: 1, seatIndex: 2, street: 'preflop', kind: 'post-bb', chips: 2, streetBetAfter: 2, allIn: false, timeout: false },
    ]);
    expect(snap.actions.every((a) => a.atMs === t0)).toBe(true);

    clock.t += 1_000;
    expect(sim.applyAction(TID, 'av-0', { kind: 'raise', amount: 6 }, { idempotencyKey: 'k1' }).ok).toBe(true);
    clock.t += 1_000;
    expect(sim.applyAction(TID, 'av-1', { kind: 'call' }, { idempotencyKey: 'k2' }).ok).toBe(true);
    clock.t += 1_000;
    // The BB folds: preflop closes, the flop is dealt.
    expect(sim.applyAction(TID, 'av-2', { kind: 'fold' }, { idempotencyKey: 'k3' }).ok).toBe(true);
    snap = sim.getPublicSnapshot(TID)!;
    expect(snap.street).toBe('flop');
    expect(snap.actions.length).toBe(5);

    // A duplicate key and an illegal action must NOT log.
    expect(sim.applyAction(TID, 'av-2', { kind: 'fold' }, { idempotencyKey: 'k3' }).ok).toBe(true);
    expect(sim.applyAction(TID, 'av-0', { kind: 'check' }, { idempotencyKey: 'bad' }).ok).toBe(false);
    expect(sim.getPublicSnapshot(TID)!.actions.length).toBe(5);

    clock.t += 1_000;
    expect(sim.applyAction(TID, 'av-1', { kind: 'check' }, { idempotencyKey: 'k4' }).ok).toBe(true);
    clock.t += 1_000;
    expect(sim.applyAction(TID, 'av-0', { kind: 'bet', amount: 4 }, { idempotencyKey: 'k5' }).ok).toBe(true);
    // Seat 1 owes 4 and lets the clock run out -> auto-fold, hand over.
    clock.fireNext();

    expect(results.length).toBe(1);
    const result = results[0]!;
    expect(shape(result.actions)).toEqual([
      { seq: 0, seatIndex: 1, street: 'preflop', kind: 'post-sb', chips: 1, streetBetAfter: 1, allIn: false, timeout: false },
      { seq: 1, seatIndex: 2, street: 'preflop', kind: 'post-bb', chips: 2, streetBetAfter: 2, allIn: false, timeout: false },
      { seq: 2, seatIndex: 0, street: 'preflop', kind: 'raise', chips: 6, streetBetAfter: 6, allIn: false, timeout: false },
      { seq: 3, seatIndex: 1, street: 'preflop', kind: 'call', chips: 5, streetBetAfter: 6, allIn: false, timeout: false },
      { seq: 4, seatIndex: 2, street: 'preflop', kind: 'fold', chips: 0, streetBetAfter: 2, allIn: false, timeout: false },
      { seq: 5, seatIndex: 1, street: 'flop', kind: 'check', chips: 0, streetBetAfter: 0, allIn: false, timeout: false },
      { seq: 6, seatIndex: 0, street: 'flop', kind: 'bet', chips: 4, streetBetAfter: 4, allIn: false, timeout: false },
      { seq: 7, seatIndex: 1, street: 'flop', kind: 'fold', chips: 0, streetBetAfter: 0, allIn: false, timeout: true },
    ]);
    expect(result.actions.map((a) => a.atMs)).toEqual([
      t0, t0, t0 + 1_000, t0 + 2_000, t0 + 3_000, t0 + 4_000, t0 + 5_000, t0 + 5_000 + 20_000,
    ]);
    // The final public snapshot carries the same log.
    expect(sim.getPublicSnapshot(TID)!.actions).toEqual(result.actions);
    // Chips moved in the log equal the chips committed (display data agrees with the pot).
    const logged = result.actions.reduce((sum, a) => sum + a.chips, 0);
    const committed = result.perSeat.reduce((sum, s) => sum + s.totalCommitted, 0);
    expect(logged).toBe(committed);
    // HandResultSeat carries the seat display name.
    expect(result.perSeat.map((s) => s.name)).toEqual(['Name 0', 'Name 1', 'Name 2']);
  });

  it('resets per hand, flags an all-in call, and logs a timeout auto-check', () => {
    const clock = new Clock();
    const sim = new PokerTableSim(clock);
    const results: HandResult[] = [];
    sim.setHandCompleteFn((_tid, r) => results.push(r));

    // Hand 1: one action then stop.
    start(sim, 1, [seat(0, 100), seat(1, 100)], 0);
    expect(sim.applyAction(TID, 'av-0', { kind: 'fold' }, { idempotencyKey: 'h1' }).ok).toBe(true);
    expect(results[0]!.actions.length).toBe(3);
    sim.stopTable(TID);

    // Hand 2 heads-up, seat 1 short: button 0 posts SB, BB seat 1 posts 2 (3 behind).
    start(sim, 2, [seat(0, 100), seat(1, 5)], 0);
    const fresh = sim.getPublicSnapshot(TID)!;
    expect(fresh.handNumber).toBe(2);
    expect(fresh.actions.map((a) => [a.seq, a.kind])).toEqual([
      [0, 'post-sb'],
      [1, 'post-bb'],
    ]);
    expect(sim.applyAction(TID, 'av-0', { kind: 'raise', amount: 10 }, { idempotencyKey: 'h2a' }).ok).toBe(true);
    expect(sim.applyAction(TID, 'av-1', { kind: 'call' }, { idempotencyKey: 'h2b' }).ok).toBe(true);
    const allInCall = results[1]!.actions[3]!;
    expect(allInCall).toMatchObject({
      seatIndex: 1,
      kind: 'call',
      chips: 3,
      streetBetAfter: 5,
      allIn: true,
      timeout: false,
      street: 'preflop',
    });
    // The run-out to showdown adds NO entries (nobody acted).
    expect(results[1]!.actions.length).toBe(4);
    expect(results[1]!.endedAt).toBe('showdown');
    sim.stopTable(TID);

    // Hand 3: SB completes, BB owes nothing and times out -> auto-check.
    start(sim, 3, [seat(0, 100), seat(1, 100)], 0);
    expect(sim.applyAction(TID, 'av-0', { kind: 'call' }, { idempotencyKey: 'h3a' }).ok).toBe(true);
    clock.fireNext();
    const snap = sim.getPublicSnapshot(TID)!;
    expect(snap.street).toBe('flop');
    expect(snap.actions.at(-1)).toMatchObject({
      seq: 3,
      seatIndex: 1,
      kind: 'check',
      chips: 0,
      streetBetAfter: 2,
      street: 'preflop',
      timeout: true,
      allIn: false,
    });
  });

  it('hands out copies: mutating a snapshot or HandResult log never changes the sim log', () => {
    const sim = new PokerTableSim(new Clock());
    const results: HandResult[] = [];
    sim.setHandCompleteFn((_tid, r) => results.push(r));
    start(sim, 1, [seat(0, 100), seat(1, 100)], 0);

    const first = sim.getPublicSnapshot(TID)!;
    first.actions[0]!.chips = 999;
    first.actions.push({ ...first.actions[0]!, seq: 99 });
    const view = sim.getSeatViewForAgent(TID, 'av-1')!;
    view.table.actions.length = 0;

    const second = sim.getPublicSnapshot(TID)!;
    expect(second.actions.length).toBe(2);
    expect(second.actions[0]!.chips).toBe(1);
    expect(second.actions).not.toBe(first.actions);

    expect(sim.applyAction(TID, 'av-0', { kind: 'fold' }, { idempotencyKey: 'c1' }).ok).toBe(true);
    results[0]!.actions[0]!.kind = 'raise';
    results[0]!.actions.length = 1;
    const after = sim.getPublicSnapshot(TID)!;
    expect(after.actions.length).toBe(3);
    expect(after.actions[0]!.kind).toBe('post-sb');
  });

  it('carries only the contract fields: no hole cards, no seed', () => {
    const sim = new PokerTableSim(new Clock());
    start(sim, 1, [seat(0, 100), seat(1, 100), seat(2, 100)], 0);
    expect(sim.applyAction(TID, 'av-0', { kind: 'call' }, { idempotencyKey: 'n1' }).ok).toBe(true);
    const snap = sim.getPublicSnapshot(TID)!;
    for (const entry of snap.actions) {
      expect(Object.keys(entry).sort()).toEqual(CONTRACT_KEYS);
    }
    const wire = JSON.stringify(snap.actions);
    expect(wire).not.toContain(SERVER);
    for (const avatarId of ['av-0', 'av-1', 'av-2']) {
      const hole = sim.getSeatViewForAgent(TID, avatarId)!.holeCards;
      for (const card of hole) {
        expect(wire).not.toContain(JSON.stringify(card));
      }
    }
  });
});
