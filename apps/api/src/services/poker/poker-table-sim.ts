/**
 * Phase P1 — `PokerTableSim`: the pure, deterministic, in-memory core for LIVE
 * multi-human No-Limit Texas Hold'em.
 *
 * ── WHY THIS EXISTS (vs holdem-engine.ts) ───────────────────────────────────
 *
 * `holdem-engine.ts` `playHand` is a single-human-seat WHOLE-HAND replay model:
 * it runs the entire hand (seat 0 human + 5 deterministic bots) in ONE call
 * from a recorded human-action script. That is great for vs-bots replay/verify
 * but USELESS for live play, where each of N humans/agents submits ONE action at
 * a time and the server must broadcast state between every turn.
 *
 * This sim is the live betting DRIVER: a whose-turn pointer, a per-seat
 * legal-action set, an apply-one-action mutation, street progression, and the
 * round-completion + reopening rules — all incremental, persisted in memory. It
 * is NET-NEW. But it does NOT re-implement the showdown MATH: at hand end it
 * builds `PlaySeat[]` and calls the engine's exported `buildSidePots` +
 * `awardPots`, so side pots, eligibility, tie-splits and odd-chip remainders are
 * BYTE-IDENTICAL to `playHand`. A parity test asserts this.
 *
 * ── BETTING RULES (mirrored EXACTLY from the fixed holdem-engine P1.1) ───────
 *
 *  - `canReopen = !hasActed`: a seat may RAISE only if it has not yet acted
 *    since the last FULL bet/raise. An already-acted seat that re-enters the
 *    action solely because a SHORT all-in lifted the bet may only CALL or FOLD.
 *  - A FULL raise (increment ≥ current min-raise) sets the new min-raise size
 *    AND reopens action (resets every other active seat's `hasActed`). A SHORT
 *    all-in (increment < min-raise) raises `currentBet` (others now owe the
 *    difference) but does NOT reopen action and does NOT shrink the min-raise.
 *  - `check` only when `toCall === 0`; `bet` only when `currentBet === 0`;
 *    `raise` only when `currentBet > 0`; an all-in-for-less is always legal.
 *
 * ── HIDDEN STATE ────────────────────────────────────────────────────────────
 *
 * Hole cards NEVER appear in a broadcast frame — the public snapshot type
 * (`PublicTableSnapshot`) has no field for them, so a leak is a compile error.
 * They are delivered ONLY over the per-seat `sendToSeat` channel as a
 * `PrivateSeatView`. The server seed is revealed ONLY in the post-hand
 * `HandResult`.
 *
 * Pure: no DB, no HTTP, no WS imports. Time + randomness are injected
 * (`SimClock`, `serverSeed`/`clientSeed`) so tests are fully deterministic.
 */

import {
  shuffleDeck,
  buildSidePots,
  awardPots,
  sha256Hex,
  type Card,
  type PlaySeat,
  type SeatResult,
} from '../holdem-engine';
import type {
  Action,
  ActionKind,
  ApplyActionResult,
  BroadcastFn,
  HandCompleteFn,
  HandResult,
  HandResultSeat,
  PrivateSeatView,
  PublicSidePot,
  PublicTableSnapshot,
  SeatPublicState,
  SendToSeatFn,
  ShowdownBroadcastFn,
  SimClock,
  StartHandArgs,
  Street,
} from './poker-table-types';
import { REAL_CLOCK } from './poker-table-types';

/** Internal mutable per-seat state (number chips). */
interface SimSeat {
  seatIndex: number;
  avatarId: string;
  name: string;
  subjectType: 'human' | 'agent';
  agentId?: string;
  hole: [Card, Card];
  /** Chips behind. */
  stack: number;
  /** Chips committed THIS street. */
  streetCommitted: number;
  /** Chips committed across ALL streets this hand. */
  committedTotal: number;
  status: 'active' | 'folded' | 'allin' | 'sitting_out' | 'busted';
  /** True once the seat has acted since the last full bet/raise. */
  hasActed: boolean;
}

/** Internal mutable table state for one live hand. */
interface SimTable {
  tableId: string;
  handNumber: number;
  blinds: { sb: number; bb: number; ante: number; level: number };
  serverSeed: string;
  clientSeed: string;
  serverSeedCommitHash: string;
  turnClockMs: number;
  agentTurnGraceMs: number;

  /** All seats indexed by seatIndex (dense over the occupied indices only). */
  seats: SimSeat[];
  /** seatIndex → SimSeat for O(1) lookups. */
  bySeatIndex: Map<number, SimSeat>;
  /** avatarId → seatIndex. */
  byAvatarId: Map<string, number>;

  buttonSeatIndex: number;
  sbSeatIndex: number;
  bbSeatIndex: number;

  /** Full 5-card board dealt up front from the shuffled deck; revealed by street. */
  flop: [Card, Card, Card];
  turn: Card;
  river: Card;

  street: Street;
  /** Highest streetCommitted any seat must match this street. */
  currentBet: number;
  /** Size of the last full bet/raise increment = current min-raise increment. */
  lastRaiseSize: number;

  toActSeatIndex: number | null;
  /** Wall-clock deadline (ms) for the current actor. */
  deadlineMs: number | null;
  /** Active turn-clock handle (from SimClock.setTimer). */
  turnTimerHandle: unknown;

  /** Idempotency: key → the result we returned for it. */
  appliedKeys: Map<string, ApplyActionResult>;

  ended: boolean;
}

export class PokerTableSim {
  private tables = new Map<string, SimTable>();
  private clock: SimClock;

  private broadcastFn: BroadcastFn | null = null;
  private sendToSeatFn: SendToSeatFn | null = null;
  private handCompleteFn: HandCompleteFn | null = null;
  private showdownBroadcastFn: ShowdownBroadcastFn | null = null;

  constructor(clock: SimClock = REAL_CLOCK) {
    this.clock = clock;
  }

  // ── Callback setters ──────────────────────────────────────────────────────

  setBroadcastFn(fn: BroadcastFn): void {
    this.broadcastFn = fn;
  }
  setSendToSeatFn(fn: SendToSeatFn): void {
    this.sendToSeatFn = fn;
  }
  setHandCompleteFn(fn: HandCompleteFn): void {
    this.handCompleteFn = fn;
  }
  /**
   * Register the public showdown/hand-end BROADCAST callback. Distinct slot from
   * `setHandCompleteFn` so a state-advancing owner (the MTT TournamentManager's
   * multi-hand loop) and a frame-fan-out owner (the WS bridge) can BOTH observe
   * the same resolveHand boundary without clobbering each other. Fires AFTER
   * `handCompleteFn`.
   */
  setShowdownBroadcastFn(fn: ShowdownBroadcastFn): void {
    this.showdownBroadcastFn = fn;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Shuffle a fresh deck, deal, post blinds + antes, set the first actor, send
   * each seat its private view, broadcast the first public snapshot, and arm the
   * turn clock for the first actor.
   */
  startHand(args: StartHandArgs): void {
    if (this.tables.has(args.tableId)) {
      throw new Error(`poker-table-sim: table ${args.tableId} already has a live hand; stopTable first`);
    }
    const occupied = args.seatAssignments
      .filter((s) => s.chipStack > 0)
      .slice()
      .sort((a, b) => a.seatIndex - b.seatIndex);
    if (occupied.length < 2) {
      throw new Error(`poker-table-sim: need ≥2 funded seats, got ${occupied.length}`);
    }
    const seatIndices = new Set<number>();
    for (const s of occupied) {
      if (!Number.isInteger(s.seatIndex) || s.seatIndex < 0) {
        throw new Error(`poker-table-sim: bad seatIndex ${s.seatIndex}`);
      }
      if (seatIndices.has(s.seatIndex)) {
        throw new Error(`poker-table-sim: duplicate seatIndex ${s.seatIndex}`);
      }
      seatIndices.add(s.seatIndex);
    }
    if (!seatIndices.has(args.buttonSeatIndex)) {
      throw new Error(`poker-table-sim: buttonSeatIndex ${args.buttonSeatIndex} is not an occupied seat`);
    }
    const { sb, bb, ante } = args.blinds;
    if (!(sb > 0) || !(bb > 0) || bb < sb || ante < 0) {
      throw new Error(`poker-table-sim: invalid blinds sb=${sb} bb=${bb} ante=${ante}`);
    }

    // Deterministic shuffle from the engine (nonce = handNumber isolates hands).
    const deck = shuffleDeck({
      serverSeed: args.serverSeed,
      clientSeed: args.clientSeed,
      nonce: args.handNumber,
    });

    // Deal 2 hole cards per OCCUPIED seat, in seat order, "around the table
    // twice": card[i] then card[n+i]. (Same deal pattern as the engine.)
    const n = occupied.length;
    const seats: SimSeat[] = [];
    const bySeatIndex = new Map<number, SimSeat>();
    const byAvatarId = new Map<string, number>();
    let top = 0;
    const holeCards: [Card, Card][] = occupied.map(() => [deck[0]!, deck[0]!]);
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < n; i++) {
        holeCards[i]![round] = deck[top++]!;
      }
    }
    for (let i = 0; i < n; i++) {
      const a = occupied[i]!;
      if (byAvatarId.has(a.avatarId)) {
        throw new Error(`poker-table-sim: duplicate avatarId ${a.avatarId}`);
      }
      const seat: SimSeat = {
        seatIndex: a.seatIndex,
        avatarId: a.avatarId,
        name: a.name,
        subjectType: a.subjectType,
        agentId: a.agentId,
        hole: holeCards[i]!,
        stack: a.chipStack,
        streetCommitted: 0,
        committedTotal: 0,
        status: 'active',
        hasActed: false,
      };
      seats.push(seat);
      bySeatIndex.set(seat.seatIndex, seat);
      byAvatarId.set(seat.avatarId, seat.seatIndex);
    }

    // Board straight off the top (no burns — same as engine).
    const flop: [Card, Card, Card] = [deck[top++]!, deck[top++]!, deck[top++]!];
    const turn = deck[top++]!;
    const river = deck[top++]!;

    // Blind seat resolution. Heads-up special case: with EXACTLY 2 players the
    // BUTTON posts the small blind (and acts first preflop, last postflop).
    const order = seats.map((s) => s.seatIndex).sort((x, y) => x - y);
    const sbSeatIndex =
      n === 2 ? args.buttonSeatIndex : this.nextOccupiedIndex(order, args.buttonSeatIndex);
    const bbSeatIndex =
      n === 2
        ? this.nextOccupiedIndex(order, args.buttonSeatIndex)
        : this.nextOccupiedIndex(order, sbSeatIndex);

    const table: SimTable = {
      tableId: args.tableId,
      handNumber: args.handNumber,
      blinds: { sb, bb, ante, level: args.blindLevel ?? 0 },
      serverSeed: args.serverSeed,
      clientSeed: args.clientSeed,
      serverSeedCommitHash: sha256Hex(args.serverSeed),
      turnClockMs: args.turnClockMs,
      agentTurnGraceMs: args.agentTurnGraceMs,
      seats,
      bySeatIndex,
      byAvatarId,
      buttonSeatIndex: args.buttonSeatIndex,
      sbSeatIndex,
      bbSeatIndex,
      flop,
      turn,
      river,
      street: 'preflop',
      currentBet: 0,
      lastRaiseSize: bb, // preflop min-raise increment is one big blind
      toActSeatIndex: null,
      deadlineMs: null,
      turnTimerHandle: undefined,
      appliedKeys: new Map(),
      ended: false,
    };

    // ── Post antes (every occupied seat) then blinds ────────────────────────
    if (ante > 0) {
      for (const s of seats) {
        const pay = Math.min(ante, s.stack);
        this.commit(s, pay);
        if (s.stack === 0) s.status = 'allin';
      }
      // Antes are dead money — they do NOT set a streetCommitment level to call.
      // Reset streetCommitted so the blind level (not the ante) drives `toCall`.
      for (const s of seats) s.streetCommitted = 0;
    }

    const sbSeat = bySeatIndex.get(sbSeatIndex)!;
    const bbSeat = bySeatIndex.get(bbSeatIndex)!;
    const sbPay = Math.min(sb, sbSeat.stack);
    this.commit(sbSeat, sbPay);
    if (sbSeat.stack === 0) sbSeat.status = 'allin';
    const bbPay = Math.min(bb, bbSeat.stack);
    this.commit(bbSeat, bbPay);
    if (bbSeat.stack === 0) bbSeat.status = 'allin';

    table.currentBet = Math.max(sbSeat.streetCommitted, bbSeat.streetCommitted, bb);
    // First to act preflop = seat after the BB (heads-up: after BB wraps to SB =
    // the button, which is correct — button/SB acts first preflop heads-up).
    const firstToAct = this.nextOccupiedIndex(order, bbSeatIndex);

    this.tables.set(args.tableId, table);

    // Begin preflop action. This SKIPS all-in/folded seats (a short stack that
    // went all-in on a blind/ante post must NOT be set as the actor — the turn
    // clock would auto-fold it, stripping its showdown eligibility / built pot
    // share, which is impossible in NLHE). If fewer than 2 seats can still act
    // (e.g. both blinds all-in), we run the board out to showdown so every
    // all-in seat keeps its eligibility. Mirrors the engine's runBettingRound,
    // which skips folded/all-in/zero-stack seats before any seat decides.
    this.beginPreflopAction(table, order, firstToAct);
  }

  /**
   * Select the preflop first actor by scanning from `firstToAct` (seat after the
   * BB, inclusive) for the first `active && stack>0` seat — exactly the guard
   * `nextToAct` / `firstActivePostflop` apply, and exactly what the engine's
   * `runBettingRound` does (it `continue`s over folded/all-in/zero-stack seats
   * before anyone acts). If ≥2 seats can act, arm the clock on the first one and
   * broadcast. Otherwise no betting is possible this hand (e.g. all-but-one are
   * all-in from blinds/antes) — fast-forward the board to showdown via
   * `dealStreetsUntilActionOrShowdown` so all-in seats reach the river with
   * their eligibility intact.
   */
  private beginPreflopAction(t: SimTable, order: number[], firstToAct: number): void {
    // ≤1 live seat (everyone but one folded on a blind post is impossible here,
    // but be defensive): resolve immediately.
    if (this.countLive(t) <= 1) {
      this.resolveHand(t);
      return;
    }

    // Fewer than 2 seats can voluntarily act → no preflop betting is possible
    // (e.g. one or both blinds went all-in on the post). Run the board out to
    // showdown directly. We do NOT route through advance(): its run-out branch
    // is gated on roundComplete(t), which is false here because the lone
    // actionable seat (if any) has not formally "acted" — yet there is no one
    // for it to bet against, so the round is effectively done. Going via the
    // shared run-out path keeps every all-in seat eligible and never sets an
    // all-in seat as the actor (the original bug).
    if (this.countActionable(t) < 2) {
      this.dealStreetsUntilActionOrShowdown(t);
      return;
    }

    // ≥2 actionable seats: find the first one from firstToAct (inclusive),
    // skipping all-in/folded/zero-stack seats.
    const first = this.firstActorFrom(t, order, firstToAct);
    if (first === null) {
      // Unreachable given countActionable ≥ 2, but stay safe: run it out.
      this.dealStreetsUntilActionOrShowdown(t);
      return;
    }
    this.setToAct(t, first);
    this.broadcast(t);
    this.sendPrivateToActor(t);
    this.armClock(t);
  }

  /**
   * First seat that can voluntarily act (active, chips behind), scanning from
   * `from` INCLUSIVE in ascending wrap order. Unlike `nextToAct`/`nextOccupied`
   * (which start strictly AFTER the cursor), this includes `from` itself so the
   * preflop seat-after-BB can be the actor when it is itself actionable.
   */
  private firstActorFrom(t: SimTable, order: number[], from: number): number | null {
    let idx = from;
    for (let i = 0; i < order.length; i++) {
      const s = t.bySeatIndex.get(idx);
      if (s && s.status === 'active' && s.stack > 0) return idx;
      idx = this.nextOccupiedIndex(order, idx);
    }
    return null;
  }

  /** Tear down a table (cancels any pending clock). */
  stopTable(tableId: string): void {
    const t = this.tables.get(tableId);
    if (!t) return;
    if (t.turnTimerHandle !== undefined) {
      this.clock.clearTimer(t.turnTimerHandle);
      t.turnTimerHandle = undefined;
    }
    this.tables.delete(tableId);
  }

  // ── Public read ───────────────────────────────────────────────────────────

  /** Public snapshot only — never carries hole cards (by type). */
  getPublicSnapshot(tableId: string): PublicTableSnapshot | null {
    const t = this.tables.get(tableId);
    if (!t) return null;
    return this.buildPublicSnapshot(t);
  }

  // ── Apply one action ──────────────────────────────────────────────────────

  /**
   * Validate + apply ONE action for `avatarId`. Incremental: mutates the
   * persisted in-memory hand state (NOT a whole-hand re-sim). Idempotent on
   * `opts.idempotencyKey` — a duplicate returns the prior result with no chip
   * movement.
   */
  applyAction(
    tableId: string,
    avatarId: string,
    action: Action,
    opts: { idempotencyKey: string },
  ): ApplyActionResult {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, reason: 'no_such_table' };

    // Idempotency: a duplicate key is a no-op returning the prior result.
    const prior = t.appliedKeys.get(opts.idempotencyKey);
    if (prior) return prior;

    if (t.ended) return this.fail(t, opts, 'hand_over');

    const seatIndex = t.byAvatarId.get(avatarId);
    if (seatIndex === undefined) return this.fail(t, opts, 'not_seated');
    if (t.toActSeatIndex !== seatIndex) return this.fail(t, opts, 'not_your_turn');

    const seat = t.bySeatIndex.get(seatIndex)!;
    const toCall = t.currentBet - seat.streetCommitted;
    const canReopen = !seat.hasActed;

    // Validate + apply legality (mirrors holdem-engine applyDecision exactly).
    const legal = this.validateAndApply(t, seat, action, toCall, canReopen);
    if (!legal.ok) return this.fail(t, opts, legal.reason ?? 'illegal_action');

    // Clear the current clock (the seat acted).
    this.disarmClock(t);
    seat.hasActed = true;

    // If this seat raised, update the betting level + reopening.
    if (seat.streetCommitted > t.currentBet) {
      const increment = seat.streetCommitted - t.currentBet;
      const isFullRaise = increment >= t.lastRaiseSize;
      t.currentBet = seat.streetCommitted;
      if (isFullRaise) {
        t.lastRaiseSize = increment;
        for (const s of t.seats) {
          if (s.seatIndex !== seat.seatIndex && s.status === 'active' && s.stack > 0) {
            s.hasActed = false;
          }
        }
      }
      // SHORT all-in: leave lastRaiseSize + others' hasActed unchanged.
    }

    // Advance: end hand if ≤1 live, else next actor or next street.
    const outcome = this.advance(t);

    const result: ApplyActionResult = {
      ok: true,
      advancedStreet: outcome.advancedStreet,
      handComplete: outcome.handComplete,
      nextToActAvatarId: outcome.nextToActAvatarId,
    };
    t.appliedKeys.set(opts.idempotencyKey, result);
    return result;
  }

  // ── Turn timeout (test/clock hook + real-timer target) ────────────────────

  /**
   * The turn clock fired (or a test drives it): auto-check if nothing is owed,
   * else auto-fold the to-act seat, then advance exactly like a real action.
   * No-op if the table is gone / hand ended / nobody is to act.
   */
  onTurnTimeout(tableId: string): void {
    const t = this.tables.get(tableId);
    if (!t || t.ended || t.toActSeatIndex === null) return;
    const seat = t.bySeatIndex.get(t.toActSeatIndex)!;
    const toCall = t.currentBet - seat.streetCommitted;
    this.disarmClock(t);
    if (toCall === 0) {
      // Auto-check.
      seat.hasActed = true;
    } else {
      // Auto-fold.
      seat.status = 'folded';
      seat.hasActed = true;
    }
    this.advance(t);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  /** Move `amount` chips from behind into the pot for this seat. */
  private commit(seat: SimSeat, amount: number): void {
    if (amount < 0) throw new Error('poker-table-sim: negative commit');
    if (amount > seat.stack) throw new Error('poker-table-sim: commit exceeds stack');
    seat.stack -= amount;
    seat.streetCommitted += amount;
    seat.committedTotal += amount;
  }

  /**
   * Validate one action against NLHE rules (mirrors holdem-engine applyDecision)
   * and, if legal, mutate the seat. Returns {ok:false, reason} on an illegal
   * action WITHOUT mutating the seat.
   */
  private validateAndApply(
    t: SimTable,
    seat: SimSeat,
    action: Action,
    toCall: number,
    canReopen: boolean,
  ): { ok: true } | { ok: false; reason: string } {
    switch (action.kind) {
      case 'fold': {
        seat.status = 'folded';
        return { ok: true };
      }
      case 'check': {
        if (toCall !== 0) return { ok: false, reason: 'cannot_check_owes_chips' };
        return { ok: true };
      }
      case 'call': {
        const pay = Math.min(toCall, seat.stack);
        this.commit(seat, pay);
        if (seat.stack === 0) seat.status = 'allin';
        return { ok: true };
      }
      case 'bet':
      case 'raise': {
        // canReopen gate FIRST — an already-acted seat re-acting only because a
        // short all-in lifted the bet may only call/fold (BUG 1 parity).
        if (!canReopen) return { ok: false, reason: 'action_not_reopened' };
        const amount = action.amount;
        if (!Number.isInteger(amount) || amount < 0) {
          return { ok: false, reason: 'bad_amount' };
        }
        const target = amount; // TOTAL street commitment after the action
        const maxTarget = seat.streetCommitted + seat.stack;
        if (target > maxTarget) return { ok: false, reason: 'amount_exceeds_stack' };
        const increment = target - seat.streetCommitted;
        const raiseOver = target - t.currentBet;
        const isAllIn = target === maxTarget;

        if (action.kind === 'bet') {
          if (t.currentBet !== 0) return { ok: false, reason: 'bet_illegal_use_raise' };
          if (increment <= 0) return { ok: false, reason: 'bet_must_be_positive' };
          if (!isAllIn && raiseOver < t.lastRaiseSize) {
            return { ok: false, reason: 'bet_below_min' };
          }
        } else {
          if (t.currentBet === 0) return { ok: false, reason: 'raise_illegal_use_bet' };
          if (target <= t.currentBet) return { ok: false, reason: 'raise_not_above_current' };
          if (!isAllIn && raiseOver < t.lastRaiseSize) {
            return { ok: false, reason: 'raise_below_min' };
          }
        }
        this.commit(seat, increment);
        if (seat.stack === 0) seat.status = 'allin';
        return { ok: true };
      }
      default: {
        const _exhaustive: never = action;
        return { ok: false, reason: `unknown_action_${String(_exhaustive)}` };
      }
    }
  }

  /**
   * Advance the hand after a seat acted: if ≤1 seat is still live, resolve the
   * hand; if the betting round is complete, deal the next street (or showdown);
   * otherwise hand the action to the next eligible seat. Re-arms clock + frames.
   */
  private advance(t: SimTable): {
    advancedStreet?: boolean;
    handComplete?: boolean;
    nextToActAvatarId: string | null;
  } {
    // Last seat standing ends the hand immediately (no further streets).
    if (this.countLive(t) <= 1) {
      this.resolveHand(t);
      return { handComplete: true, nextToActAvatarId: null };
    }

    if (this.roundComplete(t)) {
      // Betting round done. Deal the next street; if a street opens real betting
      // (≥2 actionable seats) hand off to its first actor, else fast-forward
      // through remaining streets to showdown (all-in seats keep eligibility).
      return this.dealStreetsUntilActionOrShowdown(t);
    }

    // Round not complete — find the next seat that still must act.
    const next = this.nextToAct(t);
    if (next === null) {
      // Defensive: nobody to act but round not "complete" — treat as complete.
      if (t.street === 'river') {
        this.resolveHand(t);
        return { handComplete: true, nextToActAvatarId: null };
      }
      // Fall through via a recursive advance after forcing round completion.
      // (Shouldn't happen given roundComplete covers the cases; keep it safe.)
      this.resolveHand(t);
      return { handComplete: true, nextToActAvatarId: null };
    }
    this.setToAct(t, next);
    this.broadcast(t);
    this.sendPrivateToActor(t);
    this.armClock(t);
    return {
      nextToActAvatarId: t.bySeatIndex.get(next)!.avatarId,
    };
  }

  /**
   * Deal community streets forward until one opens real betting (≥2 seats can
   * voluntarily act) or the board is complete and the hand resolves at showdown.
   * Shared by `advance()` (post-round) and `beginPreflopAction()` (when the
   * preflop round is dead on arrival because <2 seats can act — e.g. all blinds
   * all-in). Resets per-street betting state on each new street. Every all-in
   * seat keeps its showdown eligibility because no one is ever auto-folded here.
   *
   * PRECONDITION: countLive(t) ≥ 2 (the caller resolves the ≤1-live case first).
   */
  private dealStreetsUntilActionOrShowdown(t: SimTable): {
    advancedStreet?: boolean;
    handComplete?: boolean;
    nextToActAvatarId: string | null;
  } {
    let advancedStreet = false;
    while (true) {
      if (t.street === 'river') {
        this.resolveHand(t);
        return { advancedStreet, handComplete: true, nextToActAvatarId: null };
      }
      this.dealNextStreet(t);
      advancedStreet = true;
      // Reset per-street betting state.
      for (const s of t.seats) {
        s.streetCommitted = 0;
        if (s.status === 'active') s.hasActed = false;
      }
      t.currentBet = 0;
      t.lastRaiseSize = t.blinds.bb; // min bet postflop = one big blind

      const order = t.seats.map((s) => s.seatIndex).sort((x, y) => x - y);
      const first = this.firstActivePostflop(t, order);
      if (first !== null && this.countActionable(t) >= 2) {
        // Real betting on this street.
        this.setToAct(t, first);
        this.broadcast(t);
        this.sendPrivateToActor(t);
        this.armClock(t);
        return {
          advancedStreet,
          nextToActAvatarId: t.toActSeatIndex !== null ? t.bySeatIndex.get(t.toActSeatIndex)!.avatarId : null,
        };
      }
      // No one can act this street — deal again (loop) toward showdown.
    }
  }

  /**
   * A betting round is complete when every still-`active` seat with chips behind
   * has acted at least once this street AND matched the current bet. Mirrors the
   * engine's `bettingRoundComplete`.
   */
  private roundComplete(t: SimTable): boolean {
    const live = t.seats.filter((s) => s.status === 'active');
    if (live.length === 0) return true;
    for (const s of live) {
      if (s.stack === 0) continue; // auto all-in, can't act
      if (!s.hasActed) return false;
      if (s.streetCommitted !== t.currentBet) return false;
    }
    return true;
  }

  /** Count seats not folded (still in the hand). */
  private countLive(t: SimTable): number {
    return t.seats.filter((s) => s.status !== 'folded' && s.status !== 'sitting_out' && s.status !== 'busted').length;
  }

  /** Count seats that can still voluntarily act (active with chips behind). */
  private countActionable(t: SimTable): number {
    return t.seats.filter((s) => s.status === 'active' && s.stack > 0).length;
  }

  /** Deal the next community street (preflop→flop→turn→river). */
  private dealNextStreet(t: SimTable): void {
    switch (t.street) {
      case 'preflop':
        t.street = 'flop';
        break;
      case 'flop':
        t.street = 'turn';
        break;
      case 'turn':
        t.street = 'river';
        break;
      default:
        throw new Error(`poker-table-sim: cannot deal past ${t.street}`);
    }
  }

  /** The board cards exposed at the current street (length === street count). */
  private boardForStreet(t: SimTable): Card[] {
    switch (t.street) {
      case 'preflop':
        return [];
      case 'flop':
        return [...t.flop];
      case 'turn':
        return [...t.flop, t.turn];
      case 'river':
      case 'showdown':
        return [...t.flop, t.turn, t.river];
      default:
        return [];
    }
  }

  /** First active seat left of the button (postflop first-to-act). */
  private firstActivePostflop(t: SimTable, order: number[]): number | null {
    let idx = t.buttonSeatIndex;
    for (let i = 0; i < order.length; i++) {
      idx = this.nextOccupiedIndex(order, idx);
      const s = t.bySeatIndex.get(idx)!;
      if (s.status === 'active' && s.stack > 0) return idx;
    }
    return null;
  }

  /**
   * The next seat (after the current to-act) that still must act this street:
   * active, with chips, and either not yet acted or not square with currentBet.
   */
  private nextToAct(t: SimTable): number | null {
    const order = t.seats.map((s) => s.seatIndex).sort((x, y) => x - y);
    let idx = t.toActSeatIndex ?? t.buttonSeatIndex;
    for (let i = 0; i < order.length; i++) {
      idx = this.nextOccupiedIndex(order, idx);
      const s = t.bySeatIndex.get(idx)!;
      if (s.status !== 'active') continue;
      if (s.stack === 0) continue;
      if (s.hasActed && s.streetCommitted === t.currentBet) continue;
      return idx;
    }
    return null;
  }

  /** Next occupied seat index strictly after `from`, wrapping. */
  private nextOccupiedIndex(order: number[], from: number): number {
    if (order.length === 0) throw new Error('poker-table-sim: no occupied seats');
    // order is ascending occupied seat indices.
    for (const idx of order) {
      if (idx > from) return idx;
    }
    return order[0]!; // wrap to the lowest
  }

  /**
   * Mark a seat as the actor + set the deadline. Does NO eligibility filtering —
   * the CALLER must pass an `active && stack>0` seat (via `firstActorFrom`,
   * `nextToAct`, or `firstActivePostflop`). Passing an all-in/folded seat here
   * would let the turn clock auto-fold a live all-in hand — never do it.
   */
  private setToAct(t: SimTable, seatIndex: number): void {
    t.toActSeatIndex = seatIndex;
    const seat = t.bySeatIndex.get(seatIndex)!;
    const grace = seat.subjectType === 'agent' ? t.agentTurnGraceMs : 0;
    t.deadlineMs = this.clock.now() + t.turnClockMs + grace;
  }

  /** Resolve the hand via the engine's pure showdown math + fire onHandComplete. */
  private resolveHand(t: SimTable): void {
    this.disarmClock(t);
    t.ended = true;
    t.toActSeatIndex = null;
    t.deadlineMs = null;

    // Pick the showdown street: if ≤1 live, the hand ended without showdown — the
    // board shown reflects how far it progressed (current street). Otherwise it
    // ran to showdown on the full board.
    const liveCount = this.countLive(t);
    const endedAt: Street = liveCount <= 1 ? t.street : 'showdown';
    if (liveCount > 1) t.street = 'showdown';
    const board = liveCount <= 1 ? this.boardForStreet(t) : [...t.flop, t.turn, t.river];

    // Build engine PlaySeat[] (bigint) for the SHARED showdown math.
    const playSeats: PlaySeat[] = t.seats.map((s) => ({
      seat: s.seatIndex,
      isHuman: s.subjectType === 'human',
      personality: null,
      hole: s.hole,
      stack: BigInt(s.stack),
      committedTotal: BigInt(s.committedTotal),
      streetCommitted: BigInt(s.streetCommitted),
      status: s.status === 'allin' ? 'allin' : s.status === 'folded' ? 'folded' : 'active',
      hasActed: s.hasActed,
    }));
    const pots = buildSidePots(playSeats);
    const enginEndedAt = liveCount <= 1 ? mapStreetToEngine(endedAt) : 'showdown';
    const seatResults: SeatResult[] = awardPots(playSeats, pots, board, enginEndedAt);

    const resultBySeat = new Map<number, SeatResult>();
    for (const r of seatResults) resultBySeat.set(r.seat, r);

    const perSeat: HandResultSeat[] = t.seats.map((s) => {
      const r = resultBySeat.get(s.seatIndex)!;
      const won = Number(r.won);
      return {
        seatIndex: s.seatIndex,
        avatarId: s.avatarId,
        // Reveal hole cards ONLY at a genuine showdown, and only for seats that
        // did not fold. On a fold-around (endedAt !== 'showdown', exactly one live
        // seat) NOBODY shows — the lone winner takes the pot without revealing.
        // Revealing the winner's cards on a fold-win is a real-poker fairness leak.
        holeCards: endedAt === 'showdown' && s.status !== 'folded' ? s.hole : null,
        totalCommitted: s.committedTotal,
        won,
        net: won - s.committedTotal,
        status: s.status,
        handRankCategory: r.handRank ? r.handRank.category : null,
        isWinner: won > 0,
      };
    });

    const sidePots: PublicSidePot[] = pots.map((p) => ({
      amount: Number(p.amount),
      eligibleSeatIndices: [...p.eligibleSeats],
    }));

    const result: HandResult = {
      tableId: t.tableId,
      handNumber: t.handNumber,
      perSeat,
      board,
      sidePots,
      endedAt,
      endedAtMs: this.clock.now(),
      serverSeedRevealed: t.serverSeed,
    };

    // Broadcast the final (showdown) public snapshot, then fire completion.
    // Order: (1) public snapshot, (2) hand-complete (the OWNER — e.g. the MTT TM's
    // multi-hand loop advances/settles; or the demo's RESULTS transition), then
    // (3) the SEPARATE showdown/hand-end BROADCAST hook (frame fan-out only). The
    // two callbacks are distinct slots so neither clobbers the other.
    this.broadcast(t);
    if (this.handCompleteFn) this.handCompleteFn(t.tableId, result);
    if (this.showdownBroadcastFn) this.showdownBroadcastFn(t.tableId, result);
  }

  // ── Frame builders ────────────────────────────────────────────────────────

  private buildPublicSnapshot(t: SimTable): PublicTableSnapshot {
    const board = this.boardForStreet(t);
    let pot = 0;
    for (const s of t.seats) pot += s.committedTotal;

    // Live side-pot view (best-effort during play; exact at showdown).
    const playSeats: PlaySeat[] = t.seats.map((s) => ({
      seat: s.seatIndex,
      isHuman: s.subjectType === 'human',
      personality: null,
      hole: s.hole,
      stack: BigInt(s.stack),
      committedTotal: BigInt(s.committedTotal),
      streetCommitted: BigInt(s.streetCommitted),
      status: s.status === 'allin' ? 'allin' : s.status === 'folded' ? 'folded' : 'active',
      hasActed: s.hasActed,
    }));
    const sidePots: PublicSidePot[] = buildSidePots(playSeats).map((p) => ({
      amount: Number(p.amount),
      eligibleSeatIndices: [...p.eligibleSeats],
    }));

    const toActSeat = t.toActSeatIndex !== null ? t.bySeatIndex.get(t.toActSeatIndex)! : null;
    const toCall = toActSeat ? t.currentBet - toActSeat.streetCommitted : 0;
    const minRaiseTo = toActSeat ? this.minRaiseTo(t, toActSeat) : t.currentBet;

    const seats: SeatPublicState[] = t.seats.map((s) => ({
      seatIndex: s.seatIndex,
      avatarId: s.avatarId,
      name: s.name,
      subjectType: s.subjectType,
      chipStack: s.stack,
      streetBet: s.streetCommitted,
      totalCommitted: s.committedTotal,
      status: s.status,
      isButton: s.seatIndex === t.buttonSeatIndex,
      isSB: s.seatIndex === t.sbSeatIndex,
      isBB: s.seatIndex === t.bbSeatIndex,
      isActing: t.toActSeatIndex === s.seatIndex,
    }));

    return {
      tableId: t.tableId,
      handNumber: t.handNumber,
      blinds: { ...t.blinds },
      buttonSeatIndex: t.buttonSeatIndex,
      board,
      pot,
      sidePots,
      toActSeatIndex: t.toActSeatIndex,
      toActDeadlineMs: t.deadlineMs,
      toCall,
      minRaiseTo,
      seats,
      street: t.street,
      serverSeedCommitHash: t.serverSeedCommitHash,
    };
  }

  /** The smallest legal TOTAL "bet/raise to" target for a seat. */
  private minRaiseTo(t: SimTable, seat: SimSeat): number {
    const maxTarget = seat.streetCommitted + seat.stack;
    if (t.currentBet === 0) {
      // Opening bet: min bet = lastRaiseSize (one BB), capped by all-in.
      const min = seat.streetCommitted + t.lastRaiseSize;
      return Math.min(min, maxTarget);
    }
    const min = t.currentBet + t.lastRaiseSize;
    return Math.min(min, maxTarget);
  }

  /** The legal action kinds for the to-act seat. */
  private legalActionsFor(t: SimTable, seat: SimSeat): ActionKind[] {
    const toCall = t.currentBet - seat.streetCommitted;
    const canReopen = !seat.hasActed;
    const out: ActionKind[] = ['fold'];
    if (toCall === 0) {
      out.push('check');
    } else if (seat.stack > 0) {
      out.push('call');
    }
    // Can the seat put MORE chips in (bet/raise)?
    if (seat.stack > 0 && canReopen) {
      const maxTarget = seat.streetCommitted + seat.stack;
      if (t.currentBet === 0) {
        // An opening bet is possible if the seat has any chips to bet.
        if (maxTarget > seat.streetCommitted) out.push('bet');
      } else {
        // A raise is possible only if the seat can exceed the current bet.
        if (maxTarget > t.currentBet) out.push('raise');
      }
    }
    return out;
  }

  private sendPrivateToActor(t: SimTable): void {
    if (t.toActSeatIndex === null || !this.sendToSeatFn) return;
    const seat = t.bySeatIndex.get(t.toActSeatIndex)!;
    const toCall = t.currentBet - seat.streetCommitted;
    const view: PrivateSeatView = {
      seatIndex: seat.seatIndex,
      handNumber: t.handNumber,
      holeCards: seat.hole,
      legalActions: this.legalActionsFor(t, seat),
      toCall,
      minRaiseTo: this.minRaiseTo(t, seat),
      maxRaiseTo: seat.streetCommitted + seat.stack,
      chipStack: seat.stack,
      deadlineMs: t.deadlineMs ?? this.clock.now(),
    };
    this.sendToSeatFn(t.tableId, seat.avatarId, view);
  }

  private broadcast(t: SimTable): void {
    if (this.broadcastFn) this.broadcastFn(t.tableId, this.buildPublicSnapshot(t));
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  private armClock(t: SimTable): void {
    if (t.toActSeatIndex === null || t.deadlineMs === null) return;
    const seat = t.bySeatIndex.get(t.toActSeatIndex)!;
    const grace = seat.subjectType === 'agent' ? t.agentTurnGraceMs : 0;
    const ms = t.turnClockMs + grace;
    t.turnTimerHandle = this.clock.setTimer(() => {
      this.onTurnTimeout(t.tableId);
    }, ms);
  }

  private disarmClock(t: SimTable): void {
    if (t.turnTimerHandle !== undefined) {
      this.clock.clearTimer(t.turnTimerHandle);
      t.turnTimerHandle = undefined;
    }
    t.deadlineMs = null;
  }

  // ── Idempotent failure helper ─────────────────────────────────────────────

  private fail(t: SimTable, opts: { idempotencyKey: string }, reason: string): ApplyActionResult {
    const r: ApplyActionResult = { ok: false, reason };
    // Cache failures too so a duplicate of the SAME failing key is a stable no-op.
    t.appliedKeys.set(opts.idempotencyKey, r);
    return r;
  }
}

/** Map sim street → engine endedAt enum (only used for the ≤1-live path). */
function mapStreetToEngine(s: Street): 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' {
  switch (s) {
    case 'preflop':
      return 'preflop';
    case 'flop':
      return 'flop';
    case 'turn':
      return 'turn';
    case 'river':
      return 'river';
    case 'showdown':
      return 'showdown';
    default:
      return 'showdown';
  }
}
