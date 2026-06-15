/**
 * Phase P1.2b — Texas Hold'em WS protocol shapes (namespaced `poker.*`).
 *
 * These are the WIRE shapes for the live multi-human/agent No-Limit Texas
 * Hold'em table, layered ADDITIVELY onto the activity-portal protocol in
 * `./protocol.ts`. They are a NAMESPACED sub-union: every client frame's
 * `type` starts with `poker.`, every server frame's `type` starts with
 * `poker.`. Nothing here touches the existing reef-race / bumper-shells /
 * snapshot frame shapes — those are frozen.
 *
 * ── WHY THESE SHAPES ARE DUPLICATED (not re-exported from apps/api) ──────────
 *
 * The authoritative in-memory sim types live in
 * `apps/api/src/services/poker/poker-table-types.ts`. `@clawville/shared`
 * MUST NOT import from `apps/api` (that would invert the package-dependency
 * arrow — shared is a leaf consumed by both api and web). So the public
 * `PublicTableSnapshot` / `PrivateSeatView` / `HandResult` card + seat shapes
 * are MIRRORED here as the wire contract. A drift between the two is caught by
 * the api `tsc` build: `apps/api` adapts its sim types into these shared types
 * at the broadcast boundary, so a missing/renamed field fails to assign.
 *
 * ── HIDDEN-STATE INVARIANT (preserved by structure) ─────────────────────────
 *
 * `PokerPublicTableSnapshot` — the type carried by the PUBLIC `poker.table_state`
 * broadcast — has NO `holeCards` field and no seat field that transitively
 * carries a hole card. Hole cards live ONLY on `PokerHoleCardsFrame`
 * (`poker.hole_cards`) and `PokerYourTurnFrame` (`poker.your_turn`), both of
 * which are delivered exclusively over the per-seat `sendToAvatar` channel. The
 * showdown frame (`poker.showdown`) reveals ONLY the public post-resolution
 * board + per-seat results (folded seats muck → `holeCards: null`), never
 * mid-hand. The server seed is revealed ONLY in `poker.hand_ended`.
 */

// ─── Card + seat scalar shapes (wire mirror of poker-table-types.ts) ─────────

/** Card suit — mirror of holdem-engine `Suit`. */
export type PokerSuit = 'clubs' | 'diamonds' | 'hearts' | 'spades';

/** Card rank — mirror of holdem-engine `Rank`. */
export type PokerRank =
  | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10'
  | 'J' | 'Q' | 'K' | 'A';

/** One playing card on the wire. */
export interface PokerCard {
  suit: PokerSuit;
  rank: PokerRank;
}

/** Streets, in order. `showdown` is the terminal betting-closed state. */
export type PokerStreet = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

/** Per-seat lifecycle status during a hand. */
export type PokerSeatStatus =
  | 'active'
  | 'folded'
  | 'allin'
  | 'sitting_out'
  | 'busted';

/** Who controls a seat. */
export type PokerSubjectType = 'human' | 'agent';

/** The action-kind literals usable in a `poker.action` frame + `legalActions`. */
export type PokerActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise';

/**
 * A player betting action (client → server, inside `poker.action`). `amount` is
 * the TOTAL street commitment the seat wants in front of it after the action
 * ("bet to X" / "raise to X" semantics — the SAME convention as the sim's
 * `Action.amount`), NOT the increment. `bet` is legal only when no bet is
 * outstanding; `raise` only when one is; `check` only when nothing is owed.
 */
export type PokerAction =
  | { kind: 'fold' }
  | { kind: 'check' }
  | { kind: 'call' }
  | { kind: 'bet'; amount: number }
  | { kind: 'raise'; amount: number };

/**
 * One seat's PUBLIC state — what every client sees about every seat.
 * **No hole cards.** Mirror of `SeatPublicState`.
 */
export interface PokerSeatPublicState {
  seatIndex: number;
  avatarId: string;
  name: string;
  subjectType: PokerSubjectType;
  /** Chips behind (not yet committed). */
  chipStack: number;
  /** Chips committed THIS street. */
  streetBet: number;
  /** Chips committed across ALL streets this hand. */
  totalCommitted: number;
  status: PokerSeatStatus;
  isButton: boolean;
  isSB: boolean;
  isBB: boolean;
  /** True iff it is currently this seat's turn to act. */
  isActing: boolean;
}

/** One side pot in a public snapshot. Mirror of `PublicSidePot`. */
export interface PokerPublicSidePot {
  amount: number;
  eligibleSeatIndices: number[];
}

/**
 * The full table state for the PUBLIC `poker.table_state` broadcast. Carries
 * NO `holeCards` field. `board.length` ALWAYS equals the street's community
 * card count (preflop 0, flop 3, turn 4, river/showdown 5). `serverSeedCommitHash`
 * is the sha256 commit; the seed itself is absent until `poker.hand_ended`.
 * Mirror of `PublicTableSnapshot`.
 */
export interface PokerPublicTableSnapshot {
  tableId: string;
  handNumber: number;
  blinds: { sb: number; bb: number; ante: number; level: number };
  buttonSeatIndex: number;
  /** Community cards revealed so far. length === street card count. */
  board: PokerCard[];
  /** Total chips in the pot (all committed across all streets). */
  pot: number;
  sidePots: PokerPublicSidePot[];
  /** Seat index whose turn it is, or null at a street/hand transition. */
  toActSeatIndex: number | null;
  /** Wall-clock ms deadline for the current actor, or null if no one acts. */
  toActDeadlineMs: number | null;
  /** Chips the to-act seat owes to match the current bet (0 if nothing owed). */
  toCall: number;
  /** Smallest legal TOTAL "raise to" target for the to-act seat. */
  minRaiseTo: number;
  seats: PokerSeatPublicState[];
  street: PokerStreet;
  /** sha256 of the server seed (commit). The seed itself is NOT here. */
  serverSeedCommitHash: string;
}

/**
 * The PRIVATE view for a SINGLE seat — the ONLY wire shape carrying hole cards.
 * Delivered over `poker.hole_cards` (on deal) + `poker.your_turn` (on turn).
 * Mirror of `PrivateSeatView`.
 */
export interface PokerPrivateSeatView {
  seatIndex: number;
  holeCards: [PokerCard, PokerCard];
  /** Legal action kinds for this seat right now. */
  legalActions: PokerActionKind[];
  /** Chips owed to match the current bet. */
  toCall: number;
  /** Smallest legal TOTAL "raise/bet to" target. */
  minRaiseTo: number;
  /** Largest legal TOTAL "raise/bet to" target (all-in ceiling). */
  maxRaiseTo: number;
  /** Chips behind. */
  chipStack: number;
  /** Wall-clock ms deadline by which this seat must act. */
  deadlineMs: number;
}

/** One seat's final accounting in a resolved hand. Mirror of `HandResultSeat`. */
export interface PokerHandResultSeat {
  seatIndex: number;
  avatarId: string;
  /** Revealed at showdown; null if the seat folded (mucked). */
  holeCards: [PokerCard, PokerCard] | null;
  totalCommitted: number;
  /** Gross chips won back from all pots. */
  won: number;
  /** won - totalCommitted. */
  net: number;
  status: PokerSeatStatus;
  /** HandCategory (0..8) at showdown, or null if folded / unevaluated. */
  handRankCategory: number | null;
  isWinner: boolean;
}

/**
 * The resolved-hand payload. Mirror of `HandResult`. `serverSeedRevealed` is
 * present ONLY here (post-hand) — it carries the commit-reveal seed so the deal
 * can be independently verified after the hand closes.
 */
export interface PokerHandResult {
  tableId: string;
  handNumber: number;
  perSeat: PokerHandResultSeat[];
  board: PokerCard[];
  sidePots: PokerPublicSidePot[];
  /** The street the hand ended on. */
  endedAt: PokerStreet;
  endedAtMs: number;
  /** The revealed server seed — present ONLY here (post-hand). */
  serverSeedRevealed: string;
}
