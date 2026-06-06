/**
 * Phase 6.5.1 — Hold'em web VIEW-MODEL types.
 *
 * Pure types + display constants for the polished felt sub-components
 * (`PokerCard`, `SeatPosition`, `CommunityCardRow`, `PotDisplay`, `ChipStack`)
 * and the server-authoritative `HoldemModal`. These describe how the modal
 * RENDERS a hand — they are NOT the wire shape. The authoritative wire types
 * (`SerializedHoldemHand`, `HoldemTableWire`, deal/action/settle responses)
 * live in `@clawville/shared` (cove-holdem.ts) and mirror the engine.
 *
 * The 6.5.0 client-side mock state machine (`HoldemGameState`, `HoldemAction`,
 * `HoldemPhase`, `BotActionKind`, `RaiseConfig`, `Street`) is RETIRED — the
 * modal no longer runs a local reducer/engine; it builds these view rows
 * purely from the server's responses. `holdem-mock-engine.ts` was deleted.
 *
 * Iris Xe safe: no Three.js imports, no DOM.
 */

// ---------------------------------------------------------------------------
// Card primitive (view-model superset of the wire card — adds `hidden`)
// ---------------------------------------------------------------------------
export type HoldemSuit = 'clubs' | 'diamonds' | 'hearts' | 'spades';
export type HoldemRank =
  | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface HoldemCard {
  suit: HoldemSuit;
  rank: HoldemRank;
  /** Face-down (opponent hole cards while the hand is live, undealt board slots). */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Seat view-model (rendered by SeatPosition; built from server responses)
// ---------------------------------------------------------------------------
export type SeatStatus = 'active' | 'folded' | 'allin' | 'out';

export interface SeatState {
  /** 0 = the human player; 1–5 = house bots. */
  seatIndex: number;
  /** Display label (e.g. "You", "Vex (LAG)"). */
  name: string;
  /** Chips behind (remaining stack) — for bots this is the per-hand house stack. */
  stack: number;
  /** Chips committed on the CURRENT street (drives the "bet N" pill). */
  streetBet: number;
  holeCards: [HoldemCard, HoldemCard] | null;
  status: SeatStatus;
  /** True for the small blind seat this hand. */
  isSmallBlind: boolean;
  /** True for the big blind seat this hand. */
  isBigBlind: boolean;
  /** True for the dealer button seat this hand. */
  isDealer: boolean;
  /** Seat currently to act (highlight ring). */
  isActing: boolean;
}

// ---------------------------------------------------------------------------
// Raise slider config (the only local UI state the modal still owns)
// ---------------------------------------------------------------------------
export interface RaiseConfig {
  /** Minimum legal TOTAL street commitment for a bet/raise. */
  min: number;
  /** Maximum (all-in shove) TOTAL street commitment. */
  max: number;
  value: number;
  /** 'bet' when currentBet === 0 (opening), 'raise' otherwise. */
  verb: 'bet' | 'raise';
}

// ---------------------------------------------------------------------------
// Display constants
// ---------------------------------------------------------------------------
export const HOLDEM_SEATS = 6;
/** LOCKED blinds (mirror the engine SMALL_BLIND/BIG_BLIND). */
export const HOLDEM_SMALL_BLIND = 1;
export const HOLDEM_BIG_BLIND = 2;

/** Rank → numeric value (display sorting only; the server evaluates hands). */
export const RANK_VALUE: Record<HoldemRank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

// ---------------------------------------------------------------------------
// Primitive component prop shapes (consumed by the polished felt sub-components)
// ---------------------------------------------------------------------------

/** Props for a single poker card visual. */
export interface PokerCardProps {
  card: HoldemCard;
  /** Slide-in animation delay ms. */
  delay?: number;
  /** Compact (smaller) variant for bot seats. */
  compact?: boolean;
}

/** Props for a single seat position in the oval layout. */
export interface SeatPositionProps {
  seat: SeatState;
  /** Whether this is the player's own seat. */
  isPlayer: boolean;
  /** Whether to show hole cards face-up (showdown or player's own seat). */
  revealCards: boolean;
}

/** Props for the community card row. */
export interface CommunityCardRowProps {
  cards: (HoldemCard | null)[];
}

/** Props for the pot display. */
export interface PotDisplayProps {
  pot: number;
}

/** Props for a chip stack indicator. */
export interface ChipStackProps {
  amount: number;
  /** If true, renders in compact inline mode. */
  inline?: boolean;
}
