/**
 * Phase 6.4.0 — Cove blackjack shared type surface.
 *
 * Promoted from `apps/web/src/lib/cove/blackjack-types.ts` to `packages/shared`
 * so the API route + web client + (Phase 6.4.2) connected-agent SKILL.md
 * consume the same shape.
 *
 * Phase 6.4.0 is DISPLAY-ONLY: no engine, no ledger writes. `payout` is a
 * signed delta against the player's bet (positive = win credit, negative =
 * loss debit, zero = push). Real engine in Phase 6.4.1 will introduce richer
 * per-decision event/action schemas; this file stays the canonical home and
 * those will be added alongside.
 */

export const BLACKJACK_SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const BLACKJACK_RANKS = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
] as const;

export type BlackjackSuit = (typeof BLACKJACK_SUITS)[number];
export type BlackjackRank = (typeof BLACKJACK_RANKS)[number];

export interface BlackjackCard {
  suit: BlackjackSuit;
  rank: BlackjackRank;
  /** Phase 6.4.1 — dealer hole card hidden until reveal. Unused in 6.4.0. */
  hidden?: boolean;
}

export type BlackjackOutcome = 'win' | 'loss' | 'push' | 'blackjack';

/**
 * Response from `POST /api/cove/blackjack/play-mock-hand`.
 *
 * `payout` is a SIGNED DELTA against the player's bet:
 *   - `outcome:'blackjack'` → +Math.floor(bet * 1.5) (3:2 payout)
 *   - `outcome:'win'`       → +bet
 *   - `outcome:'push'`      →  0
 *   - `outcome:'loss'`      → -bet
 *
 * The client adds `payout` to its local display balance directly. No real
 * ClawToken ledger transfer happens server-side in Phase 6.4.0.
 */
export interface PlayMockHandResponse {
  outcome: BlackjackOutcome;
  payout: number;
  playerHand: BlackjackCard[];
  dealerHand: BlackjackCard[];
  /** Human-readable label for the OutcomeBanner — e.g. "Blackjack!", "Push". */
  outcomeLabel: string;
}

/** Min / max bet allowed by the 6.4.0 mock route. Bet must be a positive integer. */
export const COVE_BLACKJACK_MIN_BET = 1;
export const COVE_BLACKJACK_MAX_BET = 10_000;
