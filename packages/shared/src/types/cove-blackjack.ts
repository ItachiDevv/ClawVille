/**
 * Phase 6.4.1 — Cove blackjack shared type surface (AUTHORITATIVE engine).
 *
 * Promoted from `apps/web/src/lib/cove/blackjack-types.ts` to `packages/shared`
 * so the API route + web client + (Phase 6.4.2) connected-agent SKILL.md
 * consume the same card/outcome shape.
 *
 * Phase 6.4.1 replaces the 6.4.0 DISPLAY-ONLY mock: the server is fully
 * authoritative (every card derived from a commit-reveal HMAC stream), bets
 * settle through the real ClawToken ledger, and the wire types here mirror the
 * engine's `SerializedHandResult` exactly. The 6.4.0 `PlayMockHandResponse`
 * (signed-delta, mock) is GONE — the live response shapes (session/deal/
 * action/settle) live next to the fetch hooks in
 * `apps/web/src/lib/cove/blackjack-api-client.ts` (mirroring how
 * `slot-api-client.ts` owns the slots wire types). This file owns the small,
 * cross-package primitives those response shapes are built from.
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
  /** Dealer hole card hidden until reveal (client-rendered placeholder). */
  hidden?: boolean;
}

/**
 * Terminal outcome of one player hand vs. the dealer. Mirrors the engine's
 * `HandOutcome` (`blackjack-engine.ts`). `surrender` returns half the stake.
 */
export type BlackjackOutcome =
  | 'blackjack'
  | 'win'
  | 'push'
  | 'loss'
  | 'surrender';

/** Player decision types the engine accepts (insurance is a distinct call). */
export type BlackjackActionType =
  | 'hit'
  | 'stand'
  | 'double'
  | 'split'
  | 'surrender';

/**
 * One resolved player hand inside the settled outcome. All bigint money
 * fields are decimal STRINGS on the wire (atomic ClawTokens), matching the
 * slots convention — the client keeps them as strings and only `Number()`s
 * for display where the value provably fits in a JS number.
 */
export interface SerializedPlayerHand {
  cards: BlackjackCard[];
  total: number;
  isSoft: boolean;
  isBust: boolean;
  isBlackjack: boolean;
  isDoubled: boolean;
  bet: string;
  outcome: BlackjackOutcome;
  payout: string;
}

export interface SerializedDealerHand {
  cards: BlackjackCard[];
  total: number;
  isSoft: boolean;
  isBust: boolean;
  isBlackjack: boolean;
}

export interface SerializedInsurance {
  bet: string;
  payout: string;
  dealerHadBlackjack: boolean;
}

/**
 * The settled outcome payload stored in `cove_game_events.outcomeJson` and
 * returned in the `outcome` field of a settled deal/action response. The
 * `kind` discriminator routes the cross-game verifier.
 */
export interface SerializedBlackjackHandResult {
  kind: 'blackjack';
  playerHands: SerializedPlayerHand[];
  dealer: SerializedDealerHand;
  insurance: SerializedInsurance | null;
  totalBet: string;
  totalPayout: string;
  net: string;
  cursorBefore: number;
  cursorAfter: number;
  dealtBefore: number;
  dealtAfter: number;
  nonce: number;
  engineVersion: string;
}

/** Bet bounds (LOCKED rule, Phase 6.4.1): 5–500 ClawTokens per hand. */
export const COVE_BLACKJACK_MIN_BET = 5;
export const COVE_BLACKJACK_MAX_BET = 500;

/** Engine card-draw constants (mirrors `blackjack-engine.ts`). */
export const COVE_BLACKJACK_SHOE_DECKS = 6;
export const COVE_BLACKJACK_CARDS_PER_SHOE = 312;
/** 75% penetration — at this dealt-count the client opens a fresh shoe. */
export const COVE_BLACKJACK_RESHUFFLE_THRESHOLD = 234;
