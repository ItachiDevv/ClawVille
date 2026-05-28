/**
 * Phase 6.5.0 — Cove Texas Hold'em shared type surface.
 *
 * Canonical home for all Hold'em types consumed by web components,
 * API routes, and (Phase 6.5.2) connected-agent SKILL.md protocol.
 *
 * Phase 6.5.0 is VISUAL SHELL ONLY: mock data, fun-money display,
 * no engine, no ledger writes. Real engine lands in Phase 6.5.1.
 */

export const HOLDEM_SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const HOLDEM_RANKS = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
] as const;

export type HoldemSuit = (typeof HOLDEM_SUITS)[number];
export type HoldemRank = (typeof HOLDEM_RANKS)[number];

export interface HoldemCard {
  suit: HoldemSuit;
  rank: HoldemRank;
}

/** 0–5 inclusive. Seat 0 = human player (bottom-center of oval). */
export type SeatIdx = 0 | 1 | 2 | 3 | 4 | 5;

/** Phase 6.5.0 seat state — sufficient for the visual shell. */
export interface HoldemSeatState {
  seatIdx: SeatIdx;
  avatarLabel: string;
  stack: number;
  betOut: number;
  /** Own hole cards face-up, opponent hole cards 'hidden', empty seat undefined. */
  holeCards?: [HoldemCard, HoldemCard] | 'hidden';
  isActive: boolean;
  isFolded: boolean;
  isAllIn: boolean;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
}

export interface HoldemSidePot {
  amount: number;
  /** Seat indices eligible for this pot. */
  eligibleSeats: SeatIdx[];
}

// ---------------------------------------------------------------------------
// Phase 6.5.0 mock route surface — `POST /api/cove/holdem/play-mock-hand`.
//
// Display-only mock for the visual shell. No engine, no ledger writes. Real
// hand evaluator + side-pot math land in Phase 6.5.1 along with the
// pokerpocket vendoring.
// ---------------------------------------------------------------------------

/** Winner identifier on the 6.5.0 mock route. */
export type HoldemWinner =
  | 'player'
  | 'bot-1'
  | 'bot-2'
  | 'bot-3'
  | 'bot-4'
  | 'bot-5';

/**
 * Response from `POST /api/cove/holdem/play-mock-hand`.
 *
 *   - `playerHand` — 2 hole cards dealt to the player (seat 0).
 *   - `botHands`   — 5 arrays of 2 hole cards each, parallel-indexed to
 *                    `bot-1` … `bot-5` (i.e. `botHands[0]` is `bot-1`).
 *   - `community`  — 5 community cards (flop + turn + river concatenated).
 *   - `winner`     — deterministic from `(buyIn, time)` per the route comment.
 *   - `potWon`     — signed delta against the local display bankroll.
 *                    6.5.0 sets it to `+buyIn` when the player wins and
 *                    `-buyIn` otherwise, mirroring blackjack's bet-sized
 *                    payout for the visual shell. Real per-side-pot
 *                    settlement arrives in Phase 6.5.1.
 */
export interface PlayMockHoldemHandResponse {
  winner: HoldemWinner;
  potWon: number;
  playerHand: HoldemCard[];
  botHands: HoldemCard[][];
  community: HoldemCard[];
}

/** Buy-in bounds enforced by the 6.5.0 mock route. Positive integer. */
export const COVE_HOLDEM_MIN_BUYIN = 1;
export const COVE_HOLDEM_MAX_BUYIN = 10_000;

/**
 * Default buy-in suggested when the modal opens. The store caps this at the
 * caller-supplied bankroll via `min(balance, COVE_HOLDEM_DEFAULT_BUYIN)` so
 * a low-balance player isn't auto-bet over their stack. Mirrors
 * `HOLDEM_DEFAULT_BUY_IN` in `apps/web/src/lib/cove/holdem-types.ts`; the
 * web-local copy will be deleted once impl-modal swaps to `@clawville/shared`.
 */
export const COVE_HOLDEM_DEFAULT_BUYIN = 1_000;
