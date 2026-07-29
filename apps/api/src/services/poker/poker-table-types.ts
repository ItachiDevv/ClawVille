/**
 * Phase P1 — pure type surface for the NET-NEW live multi-human No-Limit
 * Texas Hold'em table simulator (`poker-table-sim.ts`).
 *
 * This is the in-memory, deterministic, callback-injected core for LIVE poker
 * (real humans + agents taking turns one action at a time over a WS hub). It is
 * the counterpart to `holdem-engine.ts` — which is a single-human-seat
 * WHOLE-HAND replay model (seat 0 human + 5 bots resolved in ONE `playHand`
 * call) and is NOT reusable for live turn-by-turn play. The sim REUSES the
 * engine's PURE math (`evaluateBest5`, `buildSidePots`, `awardPots`,
 * `shuffleDeck`, …) and only re-implements the live betting DRIVER.
 *
 * ── HIDDEN-STATE INVARIANT (enforced BY TYPE) ───────────────────────────────
 *
 * The single most important property of this file: `PublicTableSnapshot` — the
 * frame broadcast to EVERY connected client — has NO `holeCards` field, and no
 * field that transitively carries another seat's hole cards. `SeatPublicState`
 * likewise omits hole cards. Hole cards live ONLY on `PrivateSeatView`, which is
 * delivered exclusively over the per-seat `sendToSeat(tableId, avatarId, frame)`
 * channel to the ONE seat that owns them. A future change that tries to put a
 * hole card into a broadcast frame is therefore a COMPILE error, not a runtime
 * leak. `serverSeedRevealed` is likewise absent from the public snapshot until
 * showdown (it only appears in `HandResult`), so the commit-reveal seed cannot
 * leak mid-hand.
 *
 * All chip amounts here are plain `number` (atomic CT). The sim converts to/from
 * the engine's `bigint` math at the showdown boundary only. Chip counts in a
 * live CT poker table are small integers well within Number.MAX_SAFE_INTEGER.
 */

import type { Card } from '../holdem-engine';
import type { SettledPotResult } from '@clawville/shared';

export type { Card };
export type {
  CashSettledHandSnapshot,
  CashSettledSeat,
  SettledPotResult,
  TypedHandRank,
} from '@clawville/shared';

/** Streets, in order. Showdown is the terminal "betting is closed" state. */
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

/** Per-seat lifecycle status during a hand. */
export type SeatStatus = 'active' | 'folded' | 'allin' | 'sitting_out' | 'busted';

/** Who controls a seat. */
export type SubjectType = 'human' | 'agent';

/**
 * A player betting action. `amount` is the TOTAL street commitment the seat
 * wants in front of it after the action (a "bet to X" / "raise to X" semantics
 * — the SAME convention as `holdem-engine`'s `HoldemActionRecord.amount`), NOT
 * the increment over the current bet. `bet` is legal only when there is no
 * outstanding bet on the street (`currentBet === 0`); `raise` only when a bet
 * already exists (`currentBet > 0`). `check` only when nothing is owed.
 */
export type Action =
  | { kind: 'fold' }
  | { kind: 'check' }
  | { kind: 'call' }
  | { kind: 'bet'; amount: number }
  | { kind: 'raise'; amount: number };

/** The kinds of action, for `legalActions` lists. */
export type ActionKind = Action['kind'];

/**
 * One seat's PUBLIC state — what every client sees about every seat. **No hole
 * cards.** The only card-bearing surface is `PrivateSeatView`.
 */
export interface SeatPublicState {
  seatIndex: number;
  avatarId: string;
  name: string;
  subjectType: SubjectType;
  /** Chips behind (not yet committed). */
  chipStack: number;
  /** Chips committed THIS street. */
  streetBet: number;
  /** Chips committed across ALL streets this hand. */
  totalCommitted: number;
  status: SeatStatus;
  isButton: boolean;
  isSB: boolean;
  isBB: boolean;
  /** True iff it is currently this seat's turn to act. */
  isActing: boolean;
}

/** One side pot in a public snapshot. */
export interface PublicSidePot {
  amount: number;
  eligibleSeatIndices: number[];
}

/**
 * The full table state broadcast to ALL clients. CRITICALLY carries NO
 * `holeCards` field — a leak of any seat's hole cards into this type is a
 * COMPILE error. `board.length` ALWAYS equals the number of community cards the
 * current street exposes (preflop 0, flop 3, turn 4, river/showdown 5) — never
 * more. `serverSeedRevealed` is absent here (it only appears post-hand in
 * `HandResult`), so the commit-reveal seed never leaks mid-hand.
 */
export interface PublicTableSnapshot {
  tableId: string;
  handNumber: number;
  blinds: { sb: number; bb: number; ante: number; level: number };
  buttonSeatIndex: number;
  /** Community cards revealed so far. length === street card count. */
  board: Card[];
  /** Total chips in the pot (all committed across all streets). */
  pot: number;
  sidePots: PublicSidePot[];
  /** Seat index whose turn it is, or null if no seat is to act (street/hand transition). */
  toActSeatIndex: number | null;
  /** Wall-clock ms deadline for the current actor, or null if no one is acting. */
  toActDeadlineMs: number | null;
  /** Chips the to-act seat owes to match the current bet (0 if nothing owed). */
  toCall: number;
  /** The smallest legal TOTAL "raise to" target for the to-act seat. */
  minRaiseTo: number;
  seats: SeatPublicState[];
  street: Street;
  /** sha256 of the server seed (commit). The seed itself is NOT here. */
  serverSeedCommitHash: string;
}

/**
 * The PRIVATE view delivered to a SINGLE seat over the per-seat channel — the
 * ONLY type that carries hole cards. Never broadcast.
 */
export interface PrivateSeatView {
  seatIndex: number;
  /**
   * The hand this private view belongs to. Lets the per-seat frame builder stamp
   * the correct `handNumber` on `poker.hole_cards` / `poker.your_turn` for a
   * LONG-LIVED table that plays many hands (MTT). The single-hand demo path used
   * a hardcoded `1`; carrying it on the view makes the frame self-describing so a
   * client can discard a stale-hand private frame.
   */
  handNumber: number;
  holeCards: [Card, Card];
  /** Legal action kinds for this seat right now. */
  legalActions: ActionKind[];
  /** Chips owed to match the current bet. */
  toCall: number;
  /** Smallest legal TOTAL "raise/bet to" target (===chipStack+streetBet if only an all-in is possible). */
  minRaiseTo: number;
  /** Largest legal TOTAL "raise/bet to" target (the all-in ceiling = streetBet + chipStack). */
  maxRaiseTo: number;
  /** Chips behind. */
  chipStack: number;
  /** Wall-clock ms deadline by which this seat must act. */
  deadlineMs: number;
}

/**
 * The poll-friendly view a SOCKET-LESS agent fetches on demand (REST
 * `state-for-agent`). It bundles the FULL public table snapshot (no hole cards —
 * same redaction guarantees as a broadcast frame) with the requesting seat's OWN
 * private view (hole cards + legal actions + raise bounds) and a derived
 * `isYourTurn` flag + `deadlineMs`. The `private` block is present ONLY for the
 * one seat the request resolves to (the agent's bound avatar) — there is no path
 * here that returns another seat's hole cards, because the only card-bearing
 * source is the requesting seat's own `SimSeat.hole`.
 *
 * `isYourTurn === false` ⇒ `legalActions` is `[]` and `toCall`/`minRaiseTo`/
 * `maxRaiseTo` reflect the seat's static stack (no action is legal off-turn, so
 * a polling agent must wait for `isYourTurn === true` before calling `poker_act`).
 */
export interface AgentSeatView {
  /** The full public table state (broadcast-equivalent; NEVER any hole cards). */
  table: PublicTableSnapshot;
  /** The requesting seat's index at this table. */
  seatIndex: number;
  /** True iff it is currently THIS seat's turn to act. */
  isYourTurn: boolean;
  /** The seat's own two hole cards (the ONLY card-bearing field; one seat only). */
  holeCards: [Card, Card];
  /** Legal action kinds right now — `[]` when it is not the seat's turn. */
  legalActions: ActionKind[];
  /** Chips owed to match the current bet (0 when nothing owed / off-turn). */
  toCall: number;
  /** Smallest legal TOTAL "bet/raise to" target (only meaningful on-turn). */
  minRaiseTo: number;
  /** Largest legal TOTAL "bet/raise to" target = streetBet + chipStack. */
  maxRaiseTo: number;
  /** Chips behind. */
  chipStack: number;
  /** Wall-clock ms deadline by which the seat must act, or null when off-turn. */
  deadlineMs: number | null;
  /** The hand this view describes (so a stale poll can be discarded). */
  handNumber: number;
}

/**
 * The advisor recommendation returned by `getActionAdvice` — a NON-STAKING hint
 * (advisor mode). It estimates the seat's hand strength with the engine's pure
 * `estimateStrength` heuristic and maps that + the legal-action set + pot odds to
 * a single recommended action. It NEVER mutates table state, NEVER moves chips,
 * and NEVER reveals any other seat's cards (it reasons only from the requesting
 * seat's own hole cards + the public board). When it is not the seat's turn the
 * recommendation is `null` (nothing to advise on).
 */
export interface AgentActionAdvice {
  /** Hand-strength estimate in [0,1] (engine heuristic; deterministic). */
  strength: number;
  /** The legal action kinds for the seat right now (mirrors the view). */
  legalActions: ActionKind[];
  /**
   * The recommended action, or null when it is not the seat's turn (no decision
   * to make). `amount` is a TOTAL "bet/raise to" target (same convention as
   * `Action`), clamped into [minRaiseTo, maxRaiseTo].
   */
  recommended:
    | { kind: 'fold' }
    | { kind: 'check' }
    | { kind: 'call' }
    | { kind: 'bet'; amount: number }
    | { kind: 'raise'; amount: number }
    | null;
  /** One-line human-readable rationale (e.g. "strong hand, value-raise"). */
  rationale: string;
}

/** One seat's final accounting in a resolved hand. */
export interface HandResultSeat {
  seatIndex: number;
  avatarId: string;
  /** Hole cards revealed at showdown; null if the seat folded (mucked). */
  holeCards: [Card, Card] | null;
  totalCommitted: number;
  /** Gross chips won back from all pots. */
  won: number;
  /** won - totalCommitted. */
  net: number;
  status: SeatStatus;
  /** HandCategory (0..8) at showdown, or null if folded / unevaluated. */
  handRankCategory: number | null;
  isWinner: boolean;
}

/** The resolved-hand payload handed to `onHandComplete`. */
export interface HandResult {
  tableId: string;
  handNumber: number;
  perSeat: HandResultSeat[];
  board: Card[];
  sidePots: PublicSidePot[];
  /**
   * Full-fidelity terminal pot truth captured before the public `sidePots`
   * projection discards winners, award amounts, and winning ranks.
   */
  settledPots: SettledPotResult[];
  /** The street the hand ended on. */
  endedAt: Street;
  endedAtMs: number;
  /** The revealed server seed — present ONLY here (post-hand), never mid-hand. */
  serverSeedRevealed: string;
}

/** A seat assignment passed into `startHand`. */
export interface SeatAssignment {
  seatIndex: number;
  avatarId: string;
  name: string;
  subjectType: SubjectType;
  /** Optional agent id for agent-controlled seats (affects turn-clock grace). */
  agentId?: string;
  /** Chips this seat brings to the hand. */
  chipStack: number;
}

/** Arguments to start a fresh hand. */
export interface StartHandArgs {
  tableId: string;
  handNumber: number;
  seatAssignments: SeatAssignment[];
  blinds: { sb: number; bb: number; ante: number };
  /** Dealer button seat index. SB/BB derived from this (heads-up: button posts SB). */
  buttonSeatIndex: number;
  /** Commit-reveal server seed (revealed in HandResult at showdown). */
  serverSeed: string;
  /** Client seed (entropy contribution). */
  clientSeed: string;
  /** Per-turn clock in ms for human seats. */
  turnClockMs: number;
  /** Extra grace ms added on top of `turnClockMs` for agent seats. */
  agentTurnGraceMs: number;
  /** Optional blind level label for the snapshot (default 0). */
  blindLevel?: number;
}

/** The return shape of `applyAction`. */
export interface ApplyActionResult {
  ok: boolean;
  reason?: string;
  /** True iff this action closed the betting round and a new street was dealt. */
  advancedStreet?: boolean;
  /** True iff this action ended the hand (showdown / last seat standing). */
  handComplete?: boolean;
  /** avatarId of the next seat to act, or null if the hand is over / nobody acts. */
  nextToActAvatarId?: string | null;
}

/** Broadcast callback: full public snapshot to every client at the table. */
export type BroadcastFn = (tableId: string, snapshot: PublicTableSnapshot) => void;
/** Per-seat callback: private view to exactly ONE seat's avatar. */
export type SendToSeatFn = (tableId: string, avatarId: string, frame: PrivateSeatView) => void;
/** Hand-complete callback: the resolved result for persistence/settlement. */
export type HandCompleteFn = (tableId: string, result: HandResult) => void;
/**
 * Showdown/hand-end BROADCAST callback — fired at the SAME resolveHand boundary
 * as `HandCompleteFn`, but a SEPARATE single-field slot so a table owner that
 * already claimed `setHandCompleteFn` (the MTT TournamentManager's multi-hand
 * loop) can ALSO fan out public `poker.showdown` / `poker.hand_ended` frames
 * WITHOUT the two single-field setters clobbering each other. The hand-complete
 * fn ADVANCES state (settle/next-hand); this one only BROADCASTS.
 */
export type ShowdownBroadcastFn = (tableId: string, result: HandResult) => void;

/**
 * Injectable clock so tests drive timeouts deterministically WITHOUT real time.
 * Default is real `Date.now()` + `setTimeout`/`clearTimeout`. A test clock can
 * provide a synthetic `now()` and capture/fire timers manually.
 */
export interface SimClock {
  now(): number;
  /** Schedule `cb` after `ms`. Returns an opaque handle for `clearTimer`. */
  setTimer(cb: () => void, ms: number): unknown;
  /** Cancel a previously scheduled timer. */
  clearTimer(handle: unknown): void;
}

/** The default real-time clock. */
export const REAL_CLOCK: SimClock = {
  now: () => Date.now(),
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
