/**
 * Phase 6.5.0 — Texas Hold'em type definitions.
 *
 * Pure types + constants. No runtime logic here.
 * Iris Xe safe: no Three.js imports, no DOM.
 */

// ---------------------------------------------------------------------------
// Card primitives
// ---------------------------------------------------------------------------
export type HoldemSuit = 'clubs' | 'diamonds' | 'hearts' | 'spades';
export type HoldemRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface HoldemCard {
  suit: HoldemSuit;
  rank: HoldemRank;
  /** Face-down (bot hole cards, undealt community cards) */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Seat
// ---------------------------------------------------------------------------
export type SeatStatus = 'active' | 'folded' | 'allin' | 'out';

export interface SeatState {
  /** 0 = player; 1–5 = bots */
  seatIndex: number;
  /** Display label */
  name: string;
  stack: number;
  /** Chips bet in current street */
  streetBet: number;
  holeCards: [HoldemCard, HoldemCard] | null;
  status: SeatStatus;
  /** True for the small blind seat (seat 1 in 6.5.0) */
  isSmallBlind: boolean;
  /** True for the big blind seat (seat 2 in 6.5.0) */
  isBigBlind: boolean;
  /** True for the dealer button seat (seat 0 in 6.5.0, player) */
  isDealer: boolean;
  /** Seat currently acting */
  isActing: boolean;
}

// ---------------------------------------------------------------------------
// State machine phases
// ---------------------------------------------------------------------------
export type HoldemPhase =
  | 'idle'
  | 'dealing'
  | 'player-turn'
  | 'bot-turn'
  | 'flop-deal'
  | 'turn-deal'
  | 'river-deal'
  | 'showdown'
  | 'resolved';

// ---------------------------------------------------------------------------
// Community card street
// ---------------------------------------------------------------------------
export type Street = 'preflop' | 'flop' | 'turn' | 'river';

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
export interface HoldemGameState {
  phase: HoldemPhase;
  street: Street;
  seats: SeatState[];
  /** 5-card community deck (may be hidden/null for undealt cards) */
  communityCards: (HoldemCard | null)[];
  pot: number;
  /** Current bet amount players must call */
  currentBet: number;
  /** Index of the seat that must act next (only relevant in player-turn / bot-turn) */
  actingSeatIndex: number;
  /** Bot seats still to act this street (queue) */
  botQueue: number[];
  /** Remaining deck for dealing */
  deck: HoldemCard[];
  /** Winner seat index (set at showdown) */
  winnerSeatIndex: number | null;
  /** Amount won from pot */
  potWon: number;
  /** Player's local display balance (no ledger writes in 6.5.0) */
  localBalance: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export type HoldemAction =
  | { type: 'INIT_DEAL'; deck: HoldemCard[]; seats: SeatState[]; localBalance: number }
  | { type: 'DEALING_DONE' }
  | { type: 'PLAYER_FOLD' }
  | { type: 'PLAYER_CHECK' }
  | { type: 'PLAYER_CALL' }
  | { type: 'PLAYER_RAISE'; amount: number }
  | { type: 'PLAYER_ALLIN' }
  | { type: 'BOT_ACT'; seatIndex: number; action: BotActionKind; amount: number }
  | { type: 'BOT_QUEUE_DONE' }
  | { type: 'DEAL_FLOP'; cards: [HoldemCard, HoldemCard, HoldemCard] }
  | { type: 'DEAL_TURN'; card: HoldemCard }
  | { type: 'DEAL_RIVER'; card: HoldemCard }
  | { type: 'BEGIN_SHOWDOWN' }
  | { type: 'RESOLVE'; winnerSeatIndex: number; potWon: number }
  | { type: 'RESET'; localBalance: number };

export type BotActionKind = 'call' | 'allin' | 'fold';

// ---------------------------------------------------------------------------
// Raise slider config
// ---------------------------------------------------------------------------
export interface RaiseConfig {
  min: number;
  max: number;
  value: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const HOLDEM_SEATS = 6;
export const HOLDEM_SMALL_BLIND = 10;
export const HOLDEM_BIG_BLIND = 20;
export const HOLDEM_DEFAULT_BUY_IN = 1000;
export const HOLDEM_BOT_ACTION_DELAY_MS = 400;
export const HOLDEM_DEAL_DELAY_MS = 800;
export const HOLDEM_FLOP_CARD_DELAY_MS = 200;
export const HOLDEM_SHOWDOWN_PAUSE_MS = 2000;

/** Rank → numeric value for mock winner evaluation */
export const RANK_VALUE: Record<HoldemRank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

// ---------------------------------------------------------------------------
// Primitive component prop shapes (consumed by impl-card and HoldemModal)
// ---------------------------------------------------------------------------

/** Props for a single poker card visual */
export interface PokerCardProps {
  card: HoldemCard;
  /** Slide-in animation delay ms */
  delay?: number;
  /** Compact (smaller) variant for bot seats */
  compact?: boolean;
}

/** Props for a single seat position in the oval layout */
export interface SeatPositionProps {
  seat: SeatState;
  /** Whether this is the player's own seat */
  isPlayer: boolean;
  /** Whether to show hole cards face-up (showdown or player's own seat) */
  revealCards: boolean;
}

/** Props for the community card row */
export interface CommunityCardRowProps {
  cards: (HoldemCard | null)[];
}

/** Props for the pot display */
export interface PotDisplayProps {
  pot: number;
}

/** Props for a chip stack indicator */
export interface ChipStackProps {
  amount: number;
  /** If true, renders in compact inline mode */
  inline?: boolean;
}
