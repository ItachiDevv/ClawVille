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
  type HoldemActionRecord,
} from '../../services/holdem-engine';
import {
  buildInProgressHandView,
  runEngine,
  type InProgressHandRow,
} from '../cove-holdem';

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
});
