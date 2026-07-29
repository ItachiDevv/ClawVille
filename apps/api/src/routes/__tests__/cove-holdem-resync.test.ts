/**
 * Cove Hold'em Increment 1b — `buildInProgressHandView` regression tests.
 *
 * PURE / DETERMINISTIC / NO DB — same style as `holdem-engine.test.ts`'s
 * "in-progress view board truncation" suite, but exercised THROUGH the new
 * resync view-builder (`buildInProgressHandView`) rather than `peekState`
 * directly, so the wiring the route now shares across fresh-deal, deal-replay,
 * and both resync reads (GET /session/current, GET /session/:id) is what gets
 * asserted — not just the underlying engine math (already covered elsewhere).
 *
 * NO-BOARD-LEAK is the load-bearing invariant here (memory
 * `commit-reveal-no-board-leak`): `buildInProgressHandView` must NEVER return
 * more community cards than the human's current street has dealt, and must
 * NEVER expose a bot's hole cards or the table's `serverSeed`.
 */

import { describe, expect, it } from 'bun:test';
import {
  SEATS,
  SMALL_BLIND,
  BIG_BLIND,
  serializeHoldemHand,
  type HoldemActionRecord,
} from '../../services/holdem-engine';
import {
  buildInProgressHandView,
  publicActionLogFromPeek,
  runEngine,
  type InProgressHandRow,
} from '../cove-holdem';
import {
  deriveHoldemPublicSeats,
  type SerializedHoldemLogEntry,
} from '@clawville/shared';

const SERVER = 'b'.repeat(64);
const CLIENT = 'cafebabe';
const TABLE = { serverSeed: SERVER, clientSeed: CLIENT };

const STREET_COUNT: Record<'preflop' | 'flop' | 'turn' | 'river', number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

/** Mirror the route's isHandTerminal probe (run engine; "ran out" ⇒ not done). */
function isTerminal(
  handMeta: { handIndex: number; buttonSeat: number; startingStack: string },
  actions: HoldemActionRecord[],
): boolean {
  try {
    runEngine(TABLE, handMeta, actions);
    return true;
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('ran out of human actions')) return false;
    throw err; // genuine illegal-script error — fail loudly
  }
}

/** Build the row `buildInProgressHandView` expects (structural — no DB). */
function row(
  handId: string,
  handIndex: number,
  buttonSeat: number,
  startingStack: string,
  actions: HoldemActionRecord[],
): InProgressHandRow {
  return { id: handId, handIndex, buttonSeat, startingStack, actions };
}

/**
 * Walk a hand exactly like the route does: at each non-terminal decision
 * point, build the view (what the API would now return via resync/deal/
 * deal-replay) then append a 'call' (legal in every spot) and advance until
 * the hand settles. Returns every view + the street it was taken on.
 */
function walkViews(handIndex: number, buttonSeat: number, startingStack: bigint) {
  const handMeta = { handIndex, buttonSeat, startingStack: startingStack.toString() };
  const views: Array<{
    street: 'preflop' | 'flop' | 'turn' | 'river';
    view: ReturnType<typeof buildInProgressHandView>;
  }> = [];
  const actions: HoldemActionRecord[] = [];
  for (let guard = 0; guard < 64; guard++) {
    if (isTerminal(handMeta, actions)) break;
    const view = buildInProgressHandView(
      TABLE,
      row('hand-under-test', handIndex, buttonSeat, startingStack.toString(), actions),
    );
    // Re-derive the street the human is on the same way the engine test does
    // (a synthetic-fold peek's last human log entry).
    const full = runEngine(TABLE, handMeta, [...actions, { type: 'fold' }]);
    let street: 'preflop' | 'flop' | 'turn' | 'river' | null = null;
    for (let i = full.actionLog.length - 1; i >= 0; i--) {
      if (full.actionLog[i]!.isHuman) {
        street = full.actionLog[i]!.street;
        break;
      }
    }
    expect(street).not.toBeNull();
    views.push({ street: street!, view });
    actions.push({ type: 'call' });
  }
  return views;
}

describe('cove-holdem — buildInProgressHandView (resync view builder)', () => {
  it('every view board length === the visible-street count, NEVER more', () => {
    const seenStreets = new Set<'preflop' | 'flop' | 'turn' | 'river'>();
    for (let nonce = 0; nonce < 40; nonce++) {
      const button = nonce % SEATS;
      for (const { street, view } of walkViews(nonce, button, 100n)) {
        expect(view.board.length).toBe(STREET_COUNT[street]);
        expect(view.board.length).toBeLessThanOrEqual(STREET_COUNT[street]);
        seenStreets.add(street);
      }
    }
    expect(seenStreets.has('preflop')).toBe(true);
    expect(seenStreets.has('flop')).toBe(true);
    expect(seenStreets.has('turn')).toBe(true);
    expect(seenStreets.has('river')).toBe(true);
  });

  it('a fresh hand (actions=[]) at a preflop decision reveals ZERO board cards', () => {
    let checked = 0;
    for (let nonce = 0; nonce < 40; nonce++) {
      const button = nonce % SEATS;
      const handMeta = { handIndex: nonce, buttonSeat: button, startingStack: '100' };
      if (isTerminal(handMeta, [])) continue; // human not required preflop
      const view = buildInProgressHandView(TABLE, row('h', nonce, button, '100', []));
      expect(view.board.length).toBe(0);
      expect(view.status).toBe('in_progress');
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('NEVER exposes a `seats` array or any bot hole cards — humanHole is exactly seat 0', () => {
    for (let nonce = 0; nonce < 20; nonce++) {
      const button = nonce % SEATS;
      const handMeta = { handIndex: nonce, buttonSeat: button, startingStack: '100' };
      if (isTerminal(handMeta, [])) continue;
      const view = buildInProgressHandView(TABLE, row('h', nonce, button, '100', []));
      expect(Object.prototype.hasOwnProperty.call(view, 'seats')).toBe(false);
      expect(view.humanHole.length).toBe(2);

      const full = runEngine(TABLE, handMeta, [{ type: 'fold' }]);
      const humanSeat = full.seats.find((s) => s.isHuman)!;
      expect(view.humanHole.map((c) => `${c.suit}:${c.rank}`)).toEqual(
        humanSeat.holeCards.map((c) => `${c.suit}:${c.rank}`),
      );
    }
  });

  it('NEVER exposes the table serverSeed on the wire view', () => {
    const view = buildInProgressHandView(TABLE, row('h', 0, 0, '100', []));
    expect(Object.prototype.hasOwnProperty.call(view, 'serverSeed')).toBe(false);
  });

  it('smallBlindSeat / bigBlindSeat derive from buttonSeat mod SEATS for every button', () => {
    for (let button = 0; button < SEATS; button++) {
      const handMeta = { handIndex: button, buttonSeat: button, startingStack: '100' };
      if (isTerminal(handMeta, [])) continue;
      const view = buildInProgressHandView(TABLE, row('h', button, button, '100', []));
      expect(view.buttonSeat).toBe(button);
      expect(view.smallBlindSeat).toBe((button + 1) % SEATS);
      expect(view.bigBlindSeat).toBe((button + 2) % SEATS);
      expect(view.smallBlind).toBe(SMALL_BLIND.toString());
      expect(view.bigBlind).toBe(BIG_BLIND.toString());
    }
  });

  it('handId round-trips from the row unchanged', () => {
    const view = buildInProgressHandView(TABLE, row('a-specific-hand-id', 0, 0, '100', []));
    expect(view.handId).toBe('a-specific-hand-id');
  });

  it('a deeper street view is a strict prefix of the eventual full board', () => {
    for (let nonce = 0; nonce < 40; nonce++) {
      const button = nonce % SEATS;
      const views = walkViews(nonce, button, 100n);
      if (views.length === 0) continue;
      // Settle by calling everything down (mirrors holdem-engine.test.ts callDown()).
      const handMeta = { handIndex: nonce, buttonSeat: button, startingStack: '100' };
      const script: HoldemActionRecord[] = [];
      for (let i = 0; i < views.length; i++) script.push({ type: 'call' });
      const settled = runEngine(TABLE, handMeta, script);
      const fullBoardKeys = settled.board.map((c) => `${c.suit}:${c.rank}`);
      for (const { view } of views) {
        const boardKeys = view.board.map((c) => `${c.suit}:${c.rank}`);
        expect(boardKeys).toEqual(fullBoardKeys.slice(0, boardKeys.length));
      }
    }
  });

  it('actions field accepts a non-array value defensively (treated as empty)', () => {
    // A defensive guard mirroring the route's `loadActions` — a malformed/legacy
    // row must never throw, just behave as a fresh (no-actions) hand.
    const view = buildInProgressHandView(TABLE, {
      id: 'h',
      handIndex: 0,
      buttonSeat: 0,
      startingStack: '100',
      actions: null,
    });
    expect(view.humanHole.length).toBe(2);
  });

  it('public logs grow as strict prefixes and the settled log extends every view', () => {
    let checked = 0;
    for (let nonce = 0; nonce < 40; nonce += 1) {
      const buttonSeat = nonce % SEATS;
      const views = walkViews(nonce, buttonSeat, 100n);
      if (views.length < 2) continue;
      const logs = views.map(({ view }) => view.publicActionLog);
      for (let index = 0; index + 1 < logs.length; index += 1) {
        const before = logs[index]!;
        const after = logs[index + 1]!;
        expect(after.length).toBeGreaterThan(before.length);
        expect(after.slice(0, before.length)).toEqual(before);
      }

      const settled = serializeHoldemHand(runEngine(
        TABLE,
        { handIndex: nonce, buttonSeat, startingStack: '100' },
        Array.from({ length: views.length }, () => ({ type: 'call' as const })),
      ));
      for (const publicLog of logs) {
        expect(settled.actionLog.length).toBeGreaterThan(publicLog.length);
        expect(settled.actionLog.slice(0, publicLog.length)).toEqual(publicLog);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('never includes the synthetic fold or any post-fold continuation', () => {
    const log: SerializedHoldemLogEntry[] = [
      { seat: 1, street: 'preflop', type: 'post-sb', amount: '1', isHuman: false },
      { seat: 2, street: 'preflop', type: 'post-bb', amount: '2', isHuman: false },
      { seat: 3, street: 'preflop', type: 'call', amount: '2', isHuman: false },
      { seat: 0, street: 'preflop', type: 'fold', amount: '0', isHuman: true },
      { seat: 4, street: 'flop', type: 'bet', amount: '8', isHuman: false },
      { seat: 5, street: 'flop', type: 'fold', amount: '0', isHuman: false },
    ];
    expect(publicActionLogFromPeek(log)).toEqual(log.slice(0, 3));
  });

  it('includes both blind posts in the first preflop public view', () => {
    let checked = false;
    for (let nonce = 0; nonce < 40 && !checked; nonce += 1) {
      const buttonSeat = nonce % SEATS;
      const handMeta = { handIndex: nonce, buttonSeat, startingStack: '100' };
      if (isTerminal(handMeta, [])) continue;
      const view = buildInProgressHandView(TABLE, row('h', nonce, buttonSeat, '100', []));
      expect(view.publicActionLog.some((entry) => entry.type === 'post-sb')).toBe(true);
      expect(view.publicActionLog.some((entry) => entry.type === 'post-bb')).toBe(true);
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it('does not build an in-progress peek after the human goes all-in', () => {
    // Once seat 0 reaches stack=0, every later betting round skips it. The
    // engine completes from the recorded shove alone, so the route settles
    // instead of calling buildInProgressHandView. Thus every reachable peek's
    // last human log entry remains the synthetic fold.
    expect(isTerminal(
      { handIndex: 0, buttonSeat: 0, startingStack: '10' },
      [{ type: 'raise', amount: '10' }],
    )).toBe(true);
  });
});

describe('deriveHoldemPublicSeats', () => {
  it('uses last-per-street commitments across a raise re-commit and a fold', () => {
    const log: SerializedHoldemLogEntry[] = [
      { seat: 1, street: 'preflop', type: 'post-sb', amount: '1', isHuman: false },
      { seat: 0, street: 'preflop', type: 'call', amount: '2', isHuman: true },
      { seat: 1, street: 'preflop', type: 'raise', amount: '6', isHuman: false },
      { seat: 0, street: 'preflop', type: 'call', amount: '6', isHuman: true },
      { seat: 1, street: 'flop', type: 'bet', amount: '4', isHuman: false },
      { seat: 0, street: 'flop', type: 'fold', amount: '0', isHuman: true },
    ];
    expect(deriveHoldemPublicSeats(log)).toEqual({
      0: {
        folded: true,
        streetCommitted: '0',
        totalCommitted: '6',
        lastAction: { type: 'fold', amount: '0' },
      },
      1: {
        folded: false,
        streetCommitted: '4',
        totalCommitted: '10',
        lastAction: { type: 'bet', amount: '4' },
      },
    });
  });

  it('keeps decimal bigint strings exact beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = '900719925474099312345';
    const derived = deriveHoldemPublicSeats([
      { seat: 2, street: 'preflop', type: 'raise', amount: huge, isHuman: false },
      { seat: 2, street: 'turn', type: 'bet', amount: '7', isHuman: false },
    ]);
    expect(derived[2]!.streetCommitted).toBe('7');
    expect(derived[2]!.totalCommitted).toBe('900719925474099312352');
  });
});
