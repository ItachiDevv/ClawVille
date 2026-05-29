/**
 * Phase 6.6.1 — Cove Baccarat (Punto Banco) shared wire surface.
 *
 * Canonical home for the baccarat types that cross the API ↔ web boundary
 * (and, in a later phase, the connection SKILL.md protocol). These MUST stay
 * one-shape with `apps/api/src/services/baccarat-engine.ts` +
 * `apps/api/src/routes/cove-baccarat.ts` — the engine is the source of truth.
 *
 * Money convention (matches blackjack + holdem + slots): every monetary field
 * the server emits as a stringified bigint stays a STRING on the wire. The
 * client promotes to `Number()` only at display boundaries where the value
 * provably fits a JS number (stakes/payouts ≤ 500 × 9 = 4500 CT today).
 */

// ---------------------------------------------------------------------------
// Card primitives (mirror baccarat-engine.ts SUITS/RANKS — suit-major order)
// ---------------------------------------------------------------------------

export const BACCARAT_SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const BACCARAT_RANKS = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
] as const;

export type BaccaratSuit = (typeof BACCARAT_SUITS)[number];
export type BaccaratRank = (typeof BACCARAT_RANKS)[number];

/** A single playing card. Matches the engine's `Card` shape exactly. */
export interface BaccaratCard {
  suit: BaccaratSuit;
  rank: BaccaratRank;
}

/** The three legal bets in Punto Banco (engine `BaccaratBet`). */
export type BaccaratBet = 'player' | 'banker' | 'tie';

/** Coup outcome — who won the coup, independent of the player's bet. */
export type BaccaratWinner = 'player' | 'banker' | 'tie';

// ---------------------------------------------------------------------------
// LOCKED table rules (mirror baccarat-engine.ts + cove-baccarat.ts).
// ---------------------------------------------------------------------------

/** Decks in a baccarat shoe (engine SHOE_DECKS). */
export const COVE_BACCARAT_SHOE_DECKS = 8;
/** Cards in an 8-deck shoe (engine CARDS_PER_SHOE). */
export const COVE_BACCARAT_CARDS_PER_SHOE = 416;
/** Reshuffle threshold — 75% of 416 = 312 (engine RESHUFFLE_CARD_THRESHOLD). */
export const COVE_BACCARAT_RESHUFFLE_THRESHOLD = 312;
/** Stake bounds (LOCKED): min 5 / max 500 CT (route BACCARAT_MIN_BET/MAX_BET). */
export const COVE_BACCARAT_MIN_BET = 5;
export const COVE_BACCARAT_MAX_BET = 500;
/** Banker commission percent (5%, floored at settle). */
export const COVE_BACCARAT_BANKER_COMMISSION_PERCENT = 5;
/** Tie payout (8:1). */
export const COVE_BACCARAT_TIE_PAYOUT = 8;
/** Guest demo wallet (fun-money, no ledger). */
export const COVE_BACCARAT_GUEST_STACK = 100;

// ---------------------------------------------------------------------------
// Serialized coup outcome — cove_game_events.outcomeJson for gameType='baccarat'
// (mirrors baccarat-engine.ts `SerializedCoupResult` verbatim).
// ---------------------------------------------------------------------------

export interface SerializedBaccaratHand {
  cards: BaccaratCard[];
  /** Final total (sum of card values mod 10). */
  total: number;
  /** True iff this hand was a two-card natural (8 or 9). */
  isNatural: boolean;
}

/** The full serialized coup outcome (cove_game_events.outcomeJson). */
export interface SerializedBaccaratCoup {
  kind: 'baccarat';
  bet: BaccaratBet;
  /** Stake risked, stringified bigint. */
  stake: string;
  player: SerializedBaccaratHand;
  banker: SerializedBaccaratHand;
  winner: BaccaratWinner;
  /** Gross returned to the player, stringified bigint. */
  payout: string;
  /** payout - stake (signed, stringified bigint). */
  net: string;
  /** Banker commission deducted (stringified bigint). 0 unless a BANKER bet won. */
  commission: string;
  /** Byte cursor at coup start (persisted-only metadata; verifier ignores it). */
  cursorBefore: number;
  cursorAfter: number;
  /** Cards dealt before this coup (persisted-only metadata; verifier ignores it). */
  dealtBefore: number;
  dealtAfter: number;
  nonce: number;
  engineVersion: string;
}

// ---------------------------------------------------------------------------
// Route wire types — mirror apps/api/src/routes/cove-baccarat.ts responses.
// ---------------------------------------------------------------------------

/** Currency seam — ClawTokens live; SOL/USDC return 501 (later tier). */
export type BaccaratCurrency = 'clawtoken' | 'sol' | 'usdc';

/**
 * Public shoe shape (serverSeed redacted while status='open'). Mirrors the
 * route's `publicShoe(row)` output exactly.
 */
export interface BaccaratShoeWire {
  id: string;
  userId: string | null;
  currency: string;
  serverSeedHash: string;
  clientSeed: string;
  coupCounter: number;
  cursorCounter: number;
  dealtCount: number;
  startingBalance: string;
  currentBalance: string;
  totalBet: string;
  totalPayout: string;
  status: 'open' | 'closed';
  coupsPlayed: number;
  createdAt: string;
  lastCoupAt: string | null;
  closedAt: string | null;
  /** null while status='open' (revealing it would leak future cards). */
  serverSeed: string | null;
}

export interface OpenBaccaratShoeResponse {
  shoe: BaccaratShoeWire;
  walletBalance: number;
}

export type CurrentBaccaratShoeResponse = OpenBaccaratShoeResponse;

export interface BaccaratShoeDetailResponse {
  shoe: BaccaratShoeWire;
}

/** Settled coup response from POST /coup (always settled — no in-progress window). */
export interface BaccaratCoupResponse {
  coupId: string;
  shoeId: string;
  coupIndex: number;
  status: 'settled';
  outcome: SerializedBaccaratCoup;
  balance: number;
  totalBet: string;
  totalPayout: string;
  net: string;
  dealtCount: number;
  reshuffleSuggested: boolean;
  idempotencyReplay: boolean;
}

/** 409 body returned by POST /coup when penetration >= 75% (open a new shoe). */
export interface BaccaratReshuffledBody {
  reshuffled: true;
  message: string;
  dealtCount: number;
  threshold: number;
}

export interface CloseBaccaratShoeResponse {
  shoeId: string;
  status: 'closed';
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  coupsPlayed: number;
  totalBet: string;
  totalPayout: string;
  closedAt: string;
}
