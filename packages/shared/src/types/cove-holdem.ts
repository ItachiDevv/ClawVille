/**
 * Phase 6.5.1 — Cove No-Limit Texas Hold'em shared wire surface.
 *
 * Canonical home for the Hold'em types that cross the API ↔ web boundary
 * (and, in a later phase, the connection SKILL.md protocol). These MUST stay
 * one-shape with `apps/api/src/services/holdem-engine.ts` +
 * `apps/api/src/routes/cove-holdem.ts` — the engine is the source of truth.
 *
 * The 6.5.0 DISPLAY-ONLY mock surface (`PlayMockHoldemHandResponse`,
 * `HoldemWinner`, `HoldemSeatState`, `HoldemSidePot`) is RETIRED — the route's
 * `POST /play-mock-hand` endpoint no longer exists. The real engine ships a
 * server-authoritative commit-reveal table session (open → deal → action →
 * close) with deterministic bots + real ClawToken stack custody.
 *
 * Money convention (matches blackjack + slots): every monetary field the
 * server emits as a stringified bigint stays a STRING on the wire. The client
 * promotes to `bigint`/`Number()` only at display boundaries where the value
 * provably fits a JS number (stacks ≤ 500 CT today).
 */

// ---------------------------------------------------------------------------
// Card primitives (mirror holdem-engine.ts SUITS/RANKS — suit-major order)
// ---------------------------------------------------------------------------

export const HOLDEM_SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const HOLDEM_RANKS = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
] as const;

export type HoldemSuit = (typeof HOLDEM_SUITS)[number];
export type HoldemRank = (typeof HOLDEM_RANKS)[number];

/** A single playing card. Matches the engine's `Card` shape exactly. */
export interface HoldemCard {
  suit: HoldemSuit;
  rank: HoldemRank;
}

// ---------------------------------------------------------------------------
// Cash-table settled-hand wire truth (BA-1)
// ---------------------------------------------------------------------------

/** Serializable projection of the engine's best-five hand rank. */
export interface TypedHandRank {
  /** HandCategory, low-to-high (0..8). */
  category: number;
  /** Stable display key, e.g. "flush" or "two_pair". */
  categoryName: string;
  /** Category-specific rank values used to break ties, high-to-low. */
  tiebreakers: number[];
}

/** One fully-attributed main/side-pot settlement. All amounts are bigint strings. */
export interface SettledPotResult {
  amount: string;
  eligibleSeatIndices: number[];
  awards: Array<{ seatIndex: number; amount: string }>;
  /** Null when the pot was won without a showdown evaluation. */
  winningRank: TypedHandRank | null;
}

/** One historical participant's immutable accounting for a settled cash hand. */
export interface CashSettledSeat {
  seatIndex: number;
  avatarId: string;
  startStack: string;
  endStack: string;
  totalCommitted: string;
  grossWon: string;
  rakeAttributed: string;
  net: string;
  stackDelta: string;
  status: 'active' | 'folded' | 'allin' | 'busted' | 'sitting_out';
  /** Folded seats are null for every requester, including the folded seat owner. */
  shown: [HoldemCard, HoldemCard] | null;
  /** True exactly when status is "folded"; no discretionary muck state exists. */
  mucked: boolean;
}

/** Authoritative terminal snapshot retained while the next cash hand proceeds. */
export interface CashSettledHandSnapshot {
  /** Cash correlation key: `${tableId}:${handNumber}`. */
  handId: string;
  handNumber: number;
  tableId: string;
  board: HoldemCard[];
  endedAt: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  pots: SettledPotResult[];
  seats: CashSettledSeat[];
  settledAtMs: number;
  displayExpiresAtMs: number;
}

/** 0–5 inclusive. Seat 0 = the human/agent player; 1..5 = house bots. */
export type SeatIdx = 0 | 1 | 2 | 3 | 4 | 5;

// ---------------------------------------------------------------------------
// Engine-mirrored enums + constants
// ---------------------------------------------------------------------------

/** Bot personality archetypes (engine `BotPersonality`). seat 0 = null (human). */
export type HoldemBotPersonality =
  | 'tag'
  | 'lag'
  | 'tight-passive'
  | 'calling-station'
  | 'nit';

/** The five house seats' personalities, parallel to seats 1..5 (engine BOT_PERSONALITIES). */
export const HOLDEM_BOT_PERSONALITIES: Record<number, HoldemBotPersonality> = {
  1: 'tag',
  2: 'lag',
  3: 'tight-passive',
  4: 'calling-station',
  5: 'nit',
};

/** Human-readable label for a bot personality (display only). */
export const HOLDEM_PERSONALITY_LABEL: Record<HoldemBotPersonality, string> = {
  tag: 'Tight-Aggressive',
  lag: 'Loose-Aggressive',
  'tight-passive': 'Tight-Passive',
  'calling-station': 'Calling Station',
  nit: 'Nit',
};

/** Poker hand category, low→high (engine `HandCategory`). */
export type HoldemHandCategory = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Engine action verbs (the client only ever sends the human's decision). */
export type HoldemActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise';

/** Action-log entry verb (includes the engine's posted-blind pseudo-actions). */
export type HoldemLogType = HoldemActionType | 'post-sb' | 'post-bb';

/** Street the hand ended at / a log entry belongs to. */
export type HoldemStreet = 'preflop' | 'flop' | 'turn' | 'river';
export type HoldemEndedAt = HoldemStreet | 'showdown';

export type HoldemSeatStatus = 'active' | 'folded' | 'allin';

// LOCKED table rules (mirror holdem-engine.ts + cove-holdem.ts).
export const HOLDEM_SEATS = 6;
export const HOLDEM_HUMAN_SEAT = 0;
export const HOLDEM_SMALL_BLIND = 1;
export const HOLDEM_BIG_BLIND = 2;
/** Buy-in bounds (LOCKED): min 20 / max 500 CT. Default 100. */
export const COVE_HOLDEM_MIN_BUYIN = 20;
export const COVE_HOLDEM_MAX_BUYIN = 500;
export const COVE_HOLDEM_DEFAULT_BUYIN = 100;
/** Guest demo stack (fun-money, no ledger). */
export const COVE_HOLDEM_GUEST_STACK = 100;

// ---------------------------------------------------------------------------
// Serialized hand outcome — cove_game_events.outcomeJson for gameType='holdem'
// (mirrors holdem-engine.ts `SerializedHoldemHand` verbatim).
// ---------------------------------------------------------------------------

export interface SerializedHoldemSeat {
  seat: number;
  isHuman: boolean;
  personality: HoldemBotPersonality | null;
  holeCards: HoldemCard[];
  /** Chips this seat put in the pot across all streets (stringified bigint). */
  committed: string;
  /** Chips returned to this seat (stringified bigint). */
  won: string;
  /** won - committed (signed, stringified bigint). */
  net: string;
  status: HoldemSeatStatus;
  /** Best-5 hand category at showdown, or null if folded / unevaluated. */
  handCategory: HoldemHandCategory | null;
  handCategoryName: string | null;
  isWinner: boolean;
}

export interface SerializedHoldemPot {
  /** Total chips in this (side) pot (stringified bigint). */
  amount: string;
  eligibleSeats: number[];
  winners: number[];
  /** Chips each winner received from this pot (stringified bigint). */
  perWinner: string;
}

export interface SerializedHoldemLogEntry {
  seat: number;
  street: HoldemStreet;
  type: HoldemLogType;
  /** Cumulative street commitment after the action (stringified bigint). */
  amount: string;
  isHuman: boolean;
}

/** The full serialized hand outcome (cove_game_events.outcomeJson). */
export interface SerializedHoldemHand {
  kind: 'holdem';
  handIndex: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  board: HoldemCard[];
  endedAt: HoldemEndedAt;
  seats: SerializedHoldemSeat[];
  pots: SerializedHoldemPot[];
  actionLog: SerializedHoldemLogEntry[];
  /** Total chips the human put in the pot this hand (stringified bigint). */
  humanBet: string;
  /** GROSS chips the human won back before the rake, 0 if none (stringified bigint). */
  humanPayout: string;
  /** GROSS humanPayout - humanBet (signed, stringified bigint). */
  humanNet: string;
  /**
   * House rake taken from the pot this hand = min(floor(pot*5/100), 5)
   * (economy fix 2026-05-29). Stringified bigint. Optional for back-compat with
   * pre-fix rows whose outcomeJson predates the rake field.
   */
  rake?: string;
  /** Human payout AFTER the rake — what the stack was actually credited. */
  humanRakedPayout?: string;
  /** Human net AFTER the rake = humanRakedPayout - humanBet. */
  humanRakedNet?: string;
  nonce: number;
  engineVersion: string;
}

// ---------------------------------------------------------------------------
// Route wire types — mirror apps/api/src/routes/cove-holdem.ts responses.
// ---------------------------------------------------------------------------

/** Currency seam — ClawTokens live; SOL/USDC return 501 (later tier). */
export type HoldemCurrency = 'clawtoken' | 'sol' | 'usdc';

/** Public table shape (serverSeed redacted while status='open'). */
export interface HoldemTableWire {
  id: string;
  userId: string | null;
  currency: string;
  serverSeedHash: string;
  clientSeed: string;
  handCounter: number;
  /** Stringified bigints. */
  buyInStack: string;
  playerStack: string;
  startingBalance: string;
  totalBet: string;
  totalPayout: string;
  status: 'open' | 'closed';
  handsPlayed: number;
  createdAt: string;
  lastHandAt: string | null;
  closedAt: string | null;
  /** null while status='open' (revealing it would leak future hands' decks). */
  serverSeed: string | null;
  smallBlind: string;
  bigBlind: string;
  seats: number;
}

/**
 * Owner-only in-progress hand view for resync (Increment 1b). NO BOARD-LEAK:
 * `board` is street-truncated via `peekState` (preflop 0 / flop 3 / turn 4 /
 * river 5), only the requesting subject's own `humanHole`, and NEVER the
 * table's `serverSeed` — identical redaction posture to `/hand/deal` and
 * `/action`'s in-progress responses (see `commit-reveal-no-board-leak`).
 */
export interface HoldemResyncHandView {
  handId: string;
  handIndex: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  /** Stringified bigints unless noted. */
  humanHole: HoldemCard[];
  board: HoldemCard[];
  toCall: string;
  currentBet: string;
  humanStack: string;
  humanCommitted: string;
  smallBlind: string;
  bigBlind: string;
  /**
   * Fairness-safe public history through the current human decision point.
   * This is a strict prefix of the settled `actionLog`: it includes posted
   * blinds, recorded human decisions, and bot responses already revealed by
   * play, but never the peek engine's synthetic fold or bot continuation
   * after that fold.
   */
  publicActionLog: SerializedHoldemLogEntry[];
  status: 'in_progress';
}

export interface OpenHoldemTableResponse {
  table: HoldemTableWire;
  walletBalance: number;
}

/**
 * Increment 1b: adds the optional live in-progress hand (resync surface) so a
 * client/agent that lost a mid-hand response can rebuild its view WITHOUT
 * blind reuse-and-resend (see memory `holdem-nonterminal-action-not-idempotent`).
 * Deliberately its OWN interface (not `= OpenHoldemTableResponse`) so the
 * pre-1b open-table shape stays untouched.
 */
export interface CurrentHoldemTableResponse {
  table: HoldemTableWire;
  walletBalance: number;
  /** The table's live in_progress hand, or null/absent if none. */
  hand?: HoldemResyncHandView | null;
}

export interface HoldemTableDetailResponse {
  table: HoldemTableWire;
  /** Increment 1b — same resync view as `CurrentHoldemTableResponse`. */
  hand?: HoldemResyncHandView | null;
}

/** In-progress hand response from POST /hand/deal (human still has a turn). */
export interface HoldemDealInProgressResponse extends HoldemResyncHandView {
  tableId: string;
  startingStack: string;
}

/** In-progress hand response from POST /action (human still has a turn). */
export interface HoldemActionInProgressResponse extends HoldemResyncHandView {}

/** Settled hand response (terminal action, terminal-at-deal, or idempotent replay). */
export interface HoldemSettledResponse {
  handId: string;
  tableId: string;
  handIndex: number;
  status: 'settled';
  outcome: SerializedHoldemHand;
  /** Stringified bigints. */
  playerStack: string;
  walletBalance: number;
  betAmount: string;
  payout: string;
  net: string;
  idempotencyReplay: boolean;
  /** Present (true) only when a hand resolved inline on the deal round-trip. */
  dealtImmediately?: boolean;
}

/** /hand/deal returns either an in-progress hand OR a settled hand. */
export type HoldemDealResponse = HoldemDealInProgressResponse | HoldemSettledResponse;
/** /action returns either an in-progress hand OR a settled hand. */
export type HoldemActionResponse = HoldemActionInProgressResponse | HoldemSettledResponse;

export interface CloseHoldemTableResponse {
  tableId: string;
  status: 'closed';
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  handsPlayed: number;
  totalBet: string;
  totalPayout: string;
  cashOut: string;
  walletBalance: number;
  closedAt: string;
}

// ---------------------------------------------------------------------------
// Public live-state derivation
// ---------------------------------------------------------------------------

export interface HoldemPublicSeatState {
  folded: boolean;
  /** Last cumulative commitment on the latest street present in the log. */
  streetCommitted: string;
  /** Sum of each street's last cumulative commitment (never action amounts). */
  totalCommitted: string;
  lastAction?: Pick<SerializedHoldemLogEntry, 'type' | 'amount'>;
}

/**
 * Derive public per-seat state from a fairness-truncated (or settled) action
 * log. `amount` is cumulative PER STREET, so repeated actions on one street
 * replace that street's prior value; only the last value from each street is
 * included in `totalCommitted`. All arithmetic stays bigint-string safe.
 */
export function deriveHoldemPublicSeats(
  log: readonly SerializedHoldemLogEntry[],
): Record<number, HoldemPublicSeatState> {
  const streetOrder: Record<HoldemStreet, number> = {
    preflop: 0,
    flop: 1,
    turn: 2,
    river: 3,
  };
  const bySeat = new Map<number, {
    folded: boolean;
    byStreet: Map<HoldemStreet, string>;
    lastAction?: Pick<SerializedHoldemLogEntry, 'type' | 'amount'>;
  }>();
  let latestStreet: HoldemStreet | null = null;

  for (const entry of log) {
    if (latestStreet === null || streetOrder[entry.street] > streetOrder[latestStreet]) {
      latestStreet = entry.street;
    }
    const current = bySeat.get(entry.seat) ?? {
      folded: false,
      byStreet: new Map<HoldemStreet, string>(),
    };
    // Validate while preserving the canonical decimal string on output. A wire
    // violation should fail loudly rather than silently corrupt a displayed pot.
    BigInt(entry.amount);
    current.byStreet.set(entry.street, entry.amount);
    current.folded ||= entry.type === 'fold';
    current.lastAction = { type: entry.type, amount: entry.amount };
    bySeat.set(entry.seat, current);
  }

  const result: Record<number, HoldemPublicSeatState> = {};
  for (const [seat, state] of bySeat) {
    let totalCommitted = 0n;
    for (const amount of state.byStreet.values()) totalCommitted += BigInt(amount);
    result[seat] = {
      folded: state.folded,
      streetCommitted: latestStreet === null
        ? '0'
        : (state.byStreet.get(latestStreet) ?? '0'),
      totalCommitted: totalCommitted.toString(),
      ...(state.lastAction ? { lastAction: state.lastAction } : {}),
    };
  }
  return result;
}
