/**
 * Phase 6.5.1 — No-Limit Texas Hold'em engine (pure, deterministic,
 * provably-fair). 6-max: 1 human/agent seat (seat 0) + 5 house BOTS.
 *
 * Built on `provable-rng.ts` (the same commit-reveal HMAC-SHA256 byte stream
 * that drives slot-engine.ts and blackjack-engine.ts). Every card dealt is a
 * deterministic function of (serverSeed, clientSeed, nonce=handIndex, cursor)
 * so the disputes verifier + the browser verifier can replay any hand from the
 * revealed seed via the exported pure `replayHand(args)`.
 *
 * ── Per-HAND fresh deck (unlike blackjack's shared shoe) ─────────────────────
 *
 * Each hand shuffles its OWN fresh 52-card deck. The deck is the canonical
 * ordered list `buildDeck()` (suit-major, rank-major) shuffled by a full
 * Fisher–Yates whose swaps come from the HMAC stream:
 *
 *     for i in [n-1 .. 1]:
 *         j = sampleIntFromBytes(min=0, max=i+1)   // unbiased rejection sample
 *         swap(deck[i], deck[j])                   // advance cursor by bytesConsumed
 *
 * The cursor starts at 0 for every hand (nonce = handIndex isolates hands), so
 * there is NO cross-hand cursor bookkeeping — replaying a single hand needs
 * only (serverSeed, clientSeed, handIndex). Identical inputs ⇒ identical deck,
 * byte-for-byte, across machines.
 *
 * Deal order from the shuffled deck top (index 0 = first dealt):
 *   - SEATS × 2 hole cards, dealt one card per active seat in seat order
 *     (real-table "around the table twice"): deck[0..SEATS-1] = each seat's
 *     1st card, deck[SEATS..2*SEATS-1] = each seat's 2nd card.
 *   - then a "burn" is SKIPPED (no burn cards — they add no fairness and waste
 *     determinism budget); board comes straight off the top:
 *       flop = deck[2*SEATS .. 2*SEATS+2], turn = deck[2*SEATS+3],
 *       river = deck[2*SEATS+4].
 *
 * ── Server fully authoritative ───────────────────────────────────────────────
 *
 * The route records ONLY the human's actions (fold|check|call|bet|raise +
 * amount). The engine runs ALL bot turns, deals every street, and resolves
 * showdown + side pots. Bot decisions are DETERMINISTIC given (hole cards,
 * board, pot, position, action history) with distinct personalities; any mixed
 * strategy roll is derived from the SAME HMAC stream (a dedicated bot-decision
 * cursor region), never a nondeterministic RNG call. So the whole hand is
 * replayable.
 *
 * Pure. No I/O, no time, no global state. Same inputs ⇒ byte-identical
 * HoldemHandResult. Throws on invalid inputs / illegal scripts.
 */

import { sampleIntFromBytes, sha256Hex } from './provable-rng';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Seats at the table: seat 0 = human, seats 1..5 = house bots. */
export const SEATS = 6;
export const HUMAN_SEAT = 0;

/** Small / big blind in atomic CT. */
export const SMALL_BLIND = 1n;
export const BIG_BLIND = 2n;

/**
 * Rake parameters (economy fix 2026-05-29; `.claude/plans/cove-casino-economy.md`
 * §1 Hold'em + §2). Standard "rake the pot": at settle the house takes a small %
 * of the TOTAL pot, capped, removed BEFORE awarding winners. The raked CT is
 * simply NOT credited back → a net CT burn that guarantees the table is
 * house-positive (no faucet). Applied EXACTLY ONCE per hand at settle under the
 * table FOR UPDATE lock; a settled-replay must never re-rake.
 */
export const HOLDEM_RAKE_PERCENT = 5n; // 5% of the pot
export const HOLDEM_RAKE_CAP = 5n; // capped at 5 CT (≈ 2.5 BB at SB/BB 1/2)

/** Cards in a fresh single deck. */
export const DECK_SIZE = 52;

/** Engine version pin for the cove_game_events row. */
export const HOLDEM_ENGINE_VERSION = 'th-v1';

/**
 * Cursor base for bot-decision random rolls. Card dealing consumes the LOW
 * region of the stream (Fisher–Yates over 52 cards ⇒ well under 4 KB even with
 * rejections). Bot mixed-strategy rolls are sampled starting at this offset so
 * they never collide with card-deal bytes regardless of how many rejection
 * retries the shuffle took. 1 MiB is astronomically above any card-deal usage.
 */
const BOT_DECISION_CURSOR_BASE = 1_048_576; // 2^20

/** Canonical suit + rank order — the verifier reconstructs the deck in THIS order. */
export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const RANKS = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];

// ---------------------------------------------------------------------------
// Card types
// ---------------------------------------------------------------------------

export interface Card {
  suit: Suit;
  rank: Rank;
}

/** Numeric rank value for ordering. 2..14 (Ace high). */
function rankValue(rank: Rank): number {
  switch (rank) {
    case '2': return 2;
    case '3': return 3;
    case '4': return 4;
    case '5': return 5;
    case '6': return 6;
    case '7': return 7;
    case '8': return 8;
    case '9': return 9;
    case '10': return 10;
    case 'J': return 11;
    case 'Q': return 12;
    case 'K': return 13;
    case 'A': return 14;
    default: {
      const _exhaustive: never = rank;
      throw new Error(`holdem-engine: unknown rank ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Action model
// ---------------------------------------------------------------------------

/** A player betting action. */
export type HoldemActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise';

/**
 * One recorded human decision. `amount` is the TOTAL chips the player wants in
 * front of them on this street after the action (a "raise to X" / "bet X"
 * semantics — NOT the increment). Required for bet/raise, ignored otherwise.
 * The engine validates legality (amount ≥ min-raise, ≤ stack, etc.) and throws
 * on an illegal script (the route is the upstream validator; engine is the
 * authoritative re-validator at settle).
 */
export interface HoldemActionRecord {
  type: HoldemActionType;
  /** Total street commitment after a bet/raise, atomic CT. Required for bet/raise. */
  amount?: string;
}

// ---------------------------------------------------------------------------
// Hand evaluation
// ---------------------------------------------------------------------------

/** Poker hand category, low→high. */
export enum HandCategory {
  HighCard = 0,
  Pair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
}

/**
 * The evaluated strength of a 5-card best hand. `category` is the primary
 * comparison key; `tiebreakers` is a descending list of rank values used to
 * break ties WITHIN a category (kickers / pair ranks / etc.). Two hands are
 * compared by category first, then tiebreakers lexicographically.
 */
export interface HandRank {
  category: HandCategory;
  /** Descending rank values, category-specific. Longest list compared lexicographically. */
  tiebreakers: number[];
  /** The exact 5 cards forming the best hand (for display / verification). */
  bestFive: Card[];
}

const CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: 'High Card',
  [HandCategory.Pair]: 'Pair',
  [HandCategory.TwoPair]: 'Two Pair',
  [HandCategory.ThreeOfAKind]: 'Three of a Kind',
  [HandCategory.Straight]: 'Straight',
  [HandCategory.Flush]: 'Flush',
  [HandCategory.FullHouse]: 'Full House',
  [HandCategory.FourOfAKind]: 'Four of a Kind',
  [HandCategory.StraightFlush]: 'Straight Flush',
};

export function handCategoryName(cat: HandCategory): string {
  return CATEGORY_NAMES[cat];
}

/** Compare two HandRanks. >0 if a beats b, <0 if b beats a, 0 if exactly equal. */
export function compareHandRank(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreakers[i] ?? 0;
    const bv = b.tiebreakers[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Build the canonical ordered 52-card deck. Order is suit-major → rank-major
 * (clubs 2..A, diamonds 2..A, …). The verifier MUST use this exact order so
 * the shuffle reproduces.
 */
export function buildDeck(): Card[] {
  const deck: Card[] = new Array<Card>(DECK_SIZE);
  let i = 0;
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck[i++] = { suit, rank };
    }
  }
  return deck;
}

/**
 * Evaluate the best 5-card poker hand out of 5, 6, or 7 cards.
 * Pure, deterministic. Handles the wheel straight (A-2-3-4-5).
 */
export function evaluateBest5(cards: readonly Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`holdem-engine: evaluateBest5 needs 5..7 cards, got ${cards.length}`);
  }

  // Count by rank value + group by suit for flush detection.
  const byRankValue = new Map<number, Card[]>();
  const bySuit = new Map<Suit, Card[]>();
  for (const c of cards) {
    const rv = rankValue(c.rank);
    const rl = byRankValue.get(rv);
    if (rl) rl.push(c); else byRankValue.set(rv, [c]);
    const sl = bySuit.get(c.suit);
    if (sl) sl.push(c); else bySuit.set(c.suit, [c]);
  }

  // ── Flush / straight-flush detection ──────────────────────────────────────
  let flushSuit: Suit | null = null;
  for (const [suit, list] of bySuit) {
    if (list.length >= 5) { flushSuit = suit; break; }
  }

  if (flushSuit) {
    const flushCards = bySuit.get(flushSuit)!;
    const sf = bestStraightFromCards(flushCards);
    if (sf) {
      return {
        category: HandCategory.StraightFlush,
        tiebreakers: [sf.highValue],
        bestFive: sf.cards,
      };
    }
  }

  // ── Rank-multiplicity buckets (descending count, then descending rank) ─────
  const groups = [...byRankValue.entries()]
    .map(([value, list]) => ({ value, count: list.length, cards: list }))
    .sort((a, b) => (b.count - a.count) || (b.value - a.value));

  const quad = groups.find((g) => g.count === 4);
  const trips = groups.filter((g) => g.count === 3).sort((a, b) => b.value - a.value);
  const pairs = groups.filter((g) => g.count === 2).sort((a, b) => b.value - a.value);

  // Four of a kind.
  if (quad) {
    const kicker = highestExcluding(cards, [quad.value]);
    return {
      category: HandCategory.FourOfAKind,
      tiebreakers: [quad.value, kicker.value],
      bestFive: [...quad.cards.slice(0, 4), kicker.card],
    };
  }

  // Full house (trips + a pair, or trips + trips → second trips acts as pair).
  if (trips.length >= 1 && (pairs.length >= 1 || trips.length >= 2)) {
    const topTrips = trips[0]!;
    const pairValue = trips.length >= 2 ? trips[1]!.value : pairs[0]!.value;
    const pairCards = trips.length >= 2 ? trips[1]!.cards : pairs[0]!.cards;
    return {
      category: HandCategory.FullHouse,
      tiebreakers: [topTrips.value, pairValue],
      bestFive: [...topTrips.cards.slice(0, 3), ...pairCards.slice(0, 2)],
    };
  }

  // Flush (non-straight).
  if (flushSuit) {
    const flushCards = bySuit
      .get(flushSuit)!
      .slice()
      .sort((a, b) => rankValue(b.rank) - rankValue(a.rank));
    const five = flushCards.slice(0, 5);
    return {
      category: HandCategory.Flush,
      tiebreakers: five.map((c) => rankValue(c.rank)),
      bestFive: five,
    };
  }

  // Straight (any suits).
  const straight = bestStraightFromCards(cards);
  if (straight) {
    return {
      category: HandCategory.Straight,
      tiebreakers: [straight.highValue],
      bestFive: straight.cards,
    };
  }

  // Three of a kind.
  if (trips.length >= 1) {
    const t = trips[0]!;
    const kickers = highestNExcluding(cards, [t.value], 2);
    return {
      category: HandCategory.ThreeOfAKind,
      tiebreakers: [t.value, ...kickers.map((k) => k.value)],
      bestFive: [...t.cards.slice(0, 3), ...kickers.map((k) => k.card)],
    };
  }

  // Two pair.
  if (pairs.length >= 2) {
    const [p1, p2] = [pairs[0]!, pairs[1]!];
    const kicker = highestExcluding(cards, [p1.value, p2.value]);
    return {
      category: HandCategory.TwoPair,
      tiebreakers: [p1.value, p2.value, kicker.value],
      bestFive: [...p1.cards.slice(0, 2), ...p2.cards.slice(0, 2), kicker.card],
    };
  }

  // One pair.
  if (pairs.length === 1) {
    const p = pairs[0]!;
    const kickers = highestNExcluding(cards, [p.value], 3);
    return {
      category: HandCategory.Pair,
      tiebreakers: [p.value, ...kickers.map((k) => k.value)],
      bestFive: [...p.cards.slice(0, 2), ...kickers.map((k) => k.card)],
    };
  }

  // High card.
  const top5 = [...cards].sort((a, b) => rankValue(b.rank) - rankValue(a.rank)).slice(0, 5);
  return {
    category: HandCategory.HighCard,
    tiebreakers: top5.map((c) => rankValue(c.rank)),
    bestFive: top5,
  };
}

/**
 * Find the best straight inside a set of cards. Handles the wheel (A-2-3-4-5,
 * high value 5). Returns the 5 cards + the straight's high rank value, or null.
 * When multiple suits hold the same straight rank we pick deterministically
 * (the canonical suit order via the first match per rank).
 */
function bestStraightFromCards(
  cards: readonly Card[],
): { cards: Card[]; highValue: number } | null {
  // Map rank value → a representative card (deterministic: keep the FIRST seen
  // in canonical deck order so straight composition is stable for the verifier).
  const repByValue = new Map<number, Card>();
  const ordered = [...cards].sort((a, b) => {
    // canonical order: suit-major then rank-major (matches buildDeck index).
    const sa = SUITS.indexOf(a.suit), sb = SUITS.indexOf(b.suit);
    if (sa !== sb) return sa - sb;
    return rankValue(a.rank) - rankValue(b.rank);
  });
  for (const c of ordered) {
    const rv = rankValue(c.rank);
    if (!repByValue.has(rv)) repByValue.set(rv, c);
  }
  // Ace also counts as 1 for the wheel.
  if (repByValue.has(14) && !repByValue.has(1)) {
    repByValue.set(1, repByValue.get(14)!);
  }

  // Scan straights from highValue 14 down to 5 (high value of the run).
  for (let high = 14; high >= 5; high--) {
    const run: Card[] = [];
    let ok = true;
    for (let v = high; v >= high - 4; v--) {
      const card = repByValue.get(v);
      if (!card) { ok = false; break; }
      run.push(card);
    }
    if (ok) {
      return { cards: run, highValue: high };
    }
  }
  return null;
}

/** Highest card not having one of the excluded rank values. */
function highestExcluding(
  cards: readonly Card[],
  excludeValues: number[],
): { card: Card; value: number } {
  const ex = new Set(excludeValues);
  let best: { card: Card; value: number } | null = null;
  for (const c of cards) {
    const v = rankValue(c.rank);
    if (ex.has(v)) continue;
    if (!best || v > best.value) best = { card: c, value: v };
  }
  if (!best) throw new Error('holdem-engine: highestExcluding found no card');
  return best;
}

/** N highest distinct-position cards not having an excluded rank value, desc. */
function highestNExcluding(
  cards: readonly Card[],
  excludeValues: number[],
  n: number,
): Array<{ card: Card; value: number }> {
  const ex = new Set(excludeValues);
  const pool = cards
    .filter((c) => !ex.has(rankValue(c.rank)))
    .map((c) => ({ card: c, value: rankValue(c.rank) }))
    .sort((a, b) => b.value - a.value);
  return pool.slice(0, n);
}

// ---------------------------------------------------------------------------
// Deck shuffle (HMAC Fisher–Yates) + dealing
// ---------------------------------------------------------------------------

/**
 * Deterministically shuffle a fresh 52-card deck from the HMAC stream. Full
 * Fisher–Yates from the high index down, each swap index drawn via unbiased
 * rejection sampling. Cursor starts at 0 (nonce isolates the hand). Returns the
 * shuffled deck — index 0 is the TOP (first dealt).
 */
export function shuffleDeck(args: {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
}): Card[] {
  const deck = buildDeck();
  let cursor = 0;
  for (let i = deck.length - 1; i >= 1; i--) {
    const { value: j, bytesConsumed } = sampleIntFromBytes({
      serverSeed: args.serverSeed,
      clientSeed: args.clientSeed,
      nonce: args.nonce,
      cursorStart: cursor,
      min: 0,
      max: i + 1,
    });
    cursor += bytesConsumed;
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck;
}

// ---------------------------------------------------------------------------
// Bot personalities (deterministic)
// ---------------------------------------------------------------------------

export type BotPersonality =
  | 'tag'              // tight-aggressive
  | 'lag'             // loose-aggressive
  | 'tight-passive'   // nit-ish, calls little, rarely raises
  | 'calling-station' // calls a lot, rarely folds, rarely raises
  | 'nit';            // only plays premium hands

/** Seats 1..5 personalities (seat 0 is the human, no personality). */
export const BOT_PERSONALITIES: Record<number, BotPersonality> = {
  1: 'tag',
  2: 'lag',
  3: 'tight-passive',
  4: 'calling-station',
  5: 'nit',
};

// ---------------------------------------------------------------------------
// Engine result types
// ---------------------------------------------------------------------------

export type SeatStatus = 'active' | 'folded' | 'allin';

/** One seat's final state in a resolved hand. */
export interface SeatResult {
  seat: number;
  isHuman: boolean;
  personality: BotPersonality | null;
  holeCards: Card[];
  /** Chips this seat put in the pot across all streets. */
  committed: bigint;
  /** Chips returned to this seat (won from pots). 0 if none. */
  won: bigint;
  /** committed-relative net for the seat (won - committed). */
  net: bigint;
  status: SeatStatus;
  /** Best 5-card hand at showdown — null if the seat folded before showdown. */
  handRank: HandRank | null;
  /** True iff this seat was at (or among) the winners of at least one pot. */
  isWinner: boolean;
}

/** One resolved (side) pot. */
export interface PotResult {
  /** Total chips in this pot. */
  amount: bigint;
  /** Seats eligible to win this pot. */
  eligibleSeats: number[];
  /** Seats that won (split) this pot. */
  winners: number[];
  /** Chips each winner received from this pot (amount split, remainder to earliest seat). */
  perWinner: bigint;
}

/** A single recorded action that happened in the hand (human or bot), for replay/display. */
export interface ActionLogEntry {
  seat: number;
  street: 'preflop' | 'flop' | 'turn' | 'river';
  type: HoldemActionType | 'post-sb' | 'post-bb';
  /** Total street commitment after the action (for bet/raise/call), atomic CT string. */
  amount: string;
  isHuman: boolean;
}

/** The full record of a played hand — what the route serializes + the verifier reproduces. */
export interface HoldemHandResult {
  handIndex: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  seats: SeatResult[];
  board: Card[];
  pots: PotResult[];
  actionLog: ActionLogEntry[];
  /** Street at which the hand ended ('preflop' if everyone folded preflop, else 'showdown'). */
  endedAt: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  /** Total chips the HUMAN put in the pot this hand. */
  humanBet: bigint;
  /** Gross chips the HUMAN won back (0 if none). */
  humanPayout: bigint;
  /** Human net = humanPayout - humanBet. */
  humanNet: bigint;
}

// ---------------------------------------------------------------------------
// Internal mutable seat state during play
// ---------------------------------------------------------------------------

/**
 * Per-seat mutable state during a hand. Exported (behavior unchanged) so the
 * NET-NEW live multi-human `PokerTableSim` (apps/api/src/services/poker/) can
 * construct chip-conserving showdown inputs for the SHARED pure showdown math
 * (`buildSidePots` + `awardPots`) without reimplementing side-pot / award logic
 * and risking divergence. The sim only ever fills the fields the showdown math
 * reads (`seat`, `hole`, `committedTotal`, `status`, `isHuman`, `personality`);
 * the betting-loop fields (`stack`, `streetCommitted`, `hasActed`) are set to
 * inert values it does not depend on.
 */
export interface PlaySeat {
  seat: number;
  isHuman: boolean;
  personality: BotPersonality | null;
  hole: Card[];
  stack: bigint;          // remaining chips behind
  committedTotal: bigint; // chips put in across ALL streets
  streetCommitted: bigint;// chips put in THIS street
  status: SeatStatus;
  /** True once the seat has acted at least once since the last bet/raise. */
  hasActed: boolean;
}

// ---------------------------------------------------------------------------
// playHand — the core entry point
// ---------------------------------------------------------------------------

export interface PlayHoldemHandArgs {
  serverSeed: string;
  clientSeed: string;
  /** Hand index within the session = RNG nonce. */
  nonce: number;
  /** Button (dealer) seat 0..5. SB = next seat, BB = seat after. */
  buttonSeat: number;
  /** Human seat (seat 0) starting stack this hand, atomic CT. Must be > 0n. */
  humanStartingStack: bigint;
  /**
   * Recorded human decisions in order. The engine replays them, running bots
   * between each. If the human runs out of recorded decisions while it is still
   * the human's turn, the engine THROWS (the route must record a decision for
   * every human turn before settling). For display peeks the route passes a
   * script ending in a synthetic 'fold'/'check'.
   */
  humanActions: HoldemActionRecord[];
  /** Per-bot starting stack this hand, atomic CT. Defaults to humanStartingStack-equivalent buy-in. */
  botStartingStack?: bigint;
}

/**
 * Play (or replay) one full hand deterministically. Returns the resolved
 * HoldemHandResult. Pure.
 */
export function playHand(args: PlayHoldemHandArgs): HoldemHandResult {
  validateArgs(args);

  const deck = shuffleDeck({
    serverSeed: args.serverSeed,
    clientSeed: args.clientSeed,
    nonce: args.nonce,
  });

  const botStack = args.botStartingStack ?? args.humanStartingStack;

  // ── Seat construction + hole-card deal ──────────────────────────────────
  const seats: PlaySeat[] = [];
  for (let s = 0; s < SEATS; s++) {
    const isHuman = s === HUMAN_SEAT;
    seats.push({
      seat: s,
      isHuman,
      personality: isHuman ? null : BOT_PERSONALITIES[s] ?? 'tag',
      hole: [],
      stack: isHuman ? args.humanStartingStack : botStack,
      committedTotal: 0n,
      streetCommitted: 0n,
      status: 'active',
      hasActed: false,
    });
  }
  // Around the table twice: card[s] then card[SEATS + s].
  let top = 0;
  for (let round = 0; round < 2; round++) {
    for (let s = 0; s < SEATS; s++) {
      seats[s]!.hole.push(deck[top++]!);
    }
  }
  // Board cards come straight off the top (no burns — see header).
  const flop = [deck[top++]!, deck[top++]!, deck[top++]!];
  const turn = deck[top++]!;
  const river = deck[top++]!;
  const fullBoard = [...flop, turn, river];

  const sbSeat = (args.buttonSeat + 1) % SEATS;
  const bbSeat = (args.buttonSeat + 2) % SEATS;

  const actionLog: ActionLogEntry[] = [];

  // Track how many human decisions we've consumed.
  const humanCursor = { idx: 0 };

  // ── Post blinds ──────────────────────────────────────────────────────────
  postBlind(seats[sbSeat]!, SMALL_BLIND, actionLog, 'preflop', 'post-sb');
  postBlind(seats[bbSeat]!, BIG_BLIND, actionLog, 'preflop', 'post-bb');

  // Betting state.
  let currentBet = BIG_BLIND;       // highest streetCommitted to match
  let lastRaiseSize = BIG_BLIND;    // size of the last bet/raise increment (min-raise)

  // ── Preflop betting (first to act = seat after BB) ─────────────────────────
  runBettingRound({
    seats,
    board: [],
    street: 'preflop',
    firstToAct: (bbSeat + 1) % SEATS,
    currentBet,
    lastRaiseSize,
    actionLog,
    args,
    humanActions: args.humanActions,
    humanCursor,
  });

  let endedAt: HoldemHandResult['endedAt'] = 'showdown';

  // After each street, if only one seat is non-folded the hand ends.
  const streets: Array<{ key: HoldemHandResult['endedAt']; board: Card[]; first: number }> = [
    { key: 'flop', board: flop, first: firstActivePostflop(args.buttonSeat, seats) },
    { key: 'turn', board: [...flop, turn], first: firstActivePostflop(args.buttonSeat, seats) },
    { key: 'river', board: fullBoard, first: firstActivePostflop(args.buttonSeat, seats) },
  ];

  if (countLive(seats) <= 1) {
    endedAt = 'preflop';
  } else {
    for (const st of streets) {
      // Reset per-street state.
      for (const s of seats) { s.streetCommitted = 0n; s.hasActed = false; }
      runBettingRound({
        seats,
        board: st.board,
        street: st.key as 'flop' | 'turn' | 'river',
        firstToAct: firstActivePostflop(args.buttonSeat, seats),
        currentBet: 0n,
        lastRaiseSize: BIG_BLIND, // min bet postflop = one big blind
        actionLog,
        args,
        humanActions: args.humanActions,
        humanCursor,
      });
      if (countLive(seats) <= 1) {
        endedAt = st.key;
        break;
      }
    }
  }

  // ── Resolve pots ───────────────────────────────────────────────────────────
  const showdownBoard = boardForStreet(endedAt, flop, turn, river, fullBoard);
  const pots = buildSidePots(seats);
  const seatResults = awardPots(seats, pots, showdownBoard, endedAt);

  // Distribute winnings into seat.won and stacks.
  const human = seatResults.find((s) => s.isHuman)!;

  return {
    handIndex: args.nonce,
    buttonSeat: args.buttonSeat,
    smallBlindSeat: sbSeat,
    bigBlindSeat: bbSeat,
    seats: seatResults,
    board: showdownBoard,
    pots,
    actionLog,
    endedAt,
    humanBet: human.committed,
    humanPayout: human.won,
    humanNet: human.won - human.committed,
  };
}

/** Pure re-derivation of a hand from the revealed seed. Identical to playHand. */
export function replayHand(args: PlayHoldemHandArgs): HoldemHandResult {
  return playHand(args);
}

// ---------------------------------------------------------------------------
// TEST-ONLY scripted betting-round driver
// ---------------------------------------------------------------------------
//
// Pure, deterministic helper that drives the REAL `runBettingRound` /
// `applyDecision` state machine through an EXPLICIT per-seat action script —
// including seat 0. This lets the scripted-bet regression harness assert exact
// betting-machine behavior (the BUG 1 reopen / short-all-in / canReopen gate)
// without depending on which deterministic decisions the bots happen to make.
//
// It is NOT used by any route or by playHand — it exists purely so tests can
// construct a precise table state and observe the machine. The `__` prefix +
// this comment mark it test-only.

/** One seat's starting config for the scripted driver. */
export interface ScriptedSeatConfig {
  seat: number;
  /** Starting stack BEHIND (chips not yet committed this street), atomic CT. */
  stack: bigint;
  /** Chips already committed THIS street before the round starts (e.g. blinds). */
  streetCommitted?: bigint;
  /** Status at round start. Defaults to 'active'. */
  status?: SeatStatus;
  /** Whether this seat already acted since the last full raise. Defaults false. */
  hasActed?: boolean;
  /** Ordered actions this seat will take. seat 0 is treated as the human path. */
  actions: HoldemActionRecord[];
}

/** Observable result of a scripted betting round (post-round state). */
export interface ScriptedBettingResult {
  /** Per-seat final state, keyed by seat index. */
  seats: Array<{
    seat: number;
    stack: bigint;
    streetCommitted: bigint;
    committedTotal: bigint;
    status: SeatStatus;
    hasActed: boolean;
  }>;
  actionLog: ActionLogEntry[];
  /** Final betting level reached this street. */
  finalCurrentBet: bigint;
  /** Final min-raise size this street (the table lastRaiseSize after the round). */
  finalLastRaiseSize: bigint;
}

/**
 * Drive `runBettingRound` through an explicit per-seat action script. Seat 0 is
 * the human (its actions feed `humanActions`); every other configured seat feeds
 * the test-only `scriptedNonHuman` source. Both paths go through the SAME
 * `applyDecision` legality gate as live play — so an illegal scripted bet/raise
 * (e.g. an already-acted seat re-raising over a short all-in) THROWS exactly as
 * it would in production. Pure + deterministic.
 *
 * NOTE: `runBettingRound` mutates the per-street `finalLastRaiseSize` it returns
 * but the *table* min-raise is read back from the seats' commits + the returned
 * value; the harness asserts both directly.
 */
export function __runScriptedBettingRound(input: {
  seats: ScriptedSeatConfig[];
  street: 'preflop' | 'flop' | 'turn' | 'river';
  firstToAct: number;
  currentBet: bigint;
  lastRaiseSize: bigint;
  board?: Card[];
}): ScriptedBettingResult {
  const playSeats: PlaySeat[] = [];
  const scriptedNonHuman = new Map<number, { actions: HoldemActionRecord[]; idx: number }>();
  let humanActions: HoldemActionRecord[] = [];

  // Build a dense seat array of length SEATS (the round pointer steps
  // `(pointer + 1) % SEATS` over a full 0..SEATS-1 array, so EVERY slot must
  // exist). Configured seats fill their index; the rest are inert 'folded'
  // placeholders that never act. Reject out-of-range seat indices loudly.
  const byIndex = new Map<number, ScriptedSeatConfig>();
  for (const cfg of input.seats) {
    if (!Number.isInteger(cfg.seat) || cfg.seat < 0 || cfg.seat >= SEATS) {
      throw new Error(`__runScriptedBettingRound: seat ${cfg.seat} out of range 0..${SEATS - 1}`);
    }
    byIndex.set(cfg.seat, cfg);
  }

  for (let i = 0; i < SEATS; i++) {
    const cfg = byIndex.get(i);
    if (!cfg) {
      // Inert placeholder seat (folded, no chips) — never acts.
      playSeats.push({
        seat: i, isHuman: false, personality: 'tag', hole: [],
        stack: 0n, committedTotal: 0n, streetCommitted: 0n,
        status: 'folded', hasActed: true,
      });
      continue;
    }
    const isHuman = cfg.seat === HUMAN_SEAT;
    const streetCommitted = cfg.streetCommitted ?? 0n;
    playSeats.push({
      seat: cfg.seat,
      isHuman,
      personality: isHuman ? null : BOT_PERSONALITIES[cfg.seat] ?? 'tag',
      hole: [],
      stack: cfg.stack,
      committedTotal: streetCommitted, // prior-street commits irrelevant to the round logic
      streetCommitted,
      status: cfg.status ?? 'active',
      hasActed: cfg.hasActed ?? false,
    });
    if (isHuman) {
      humanActions = cfg.actions;
    } else {
      scriptedNonHuman.set(cfg.seat, { actions: cfg.actions, idx: 0 });
    }
  }

  const actionLog: ActionLogEntry[] = [];
  // A throwaway args object — only serverSeed/clientSeed/nonce are read, and only
  // by decideBot, which the scripted source bypasses entirely.
  const args: PlayHoldemHandArgs = {
    serverSeed: 'f'.repeat(64),
    clientSeed: 'ab',
    nonce: 0,
    buttonSeat: 0,
    humanStartingStack: 1n,
    humanActions,
  };

  // runBettingRound reads currentBet/lastRaiseSize from ctx but tracks them
  // locally; we recover the final values by re-deriving from the seats + a
  // Run the REAL betting machine. A LOCAL out-holder (not a module global)
  // captures the final table min-raise — `runBettingRound` accepts an optional
  // out-param so production `playHand` stays instrumentation-free and the two
  // callers can never drift in betting LOGIC (only this readback differs).
  const lastRaiseOut = { value: input.lastRaiseSize };
  runBettingRound(
    {
      seats: playSeats,
      board: input.board ?? [],
      street: input.street,
      firstToAct: input.firstToAct,
      currentBet: input.currentBet,
      lastRaiseSize: input.lastRaiseSize,
      actionLog,
      args,
      humanActions,
      humanCursor: { idx: 0 },
      scriptedNonHuman,
    },
    lastRaiseOut,
  );

  const finalCurrentBet = playSeats
    .filter((s) => s.status !== 'folded')
    .reduce((m, s) => (s.streetCommitted > m ? s.streetCommitted : m), input.currentBet);

  return {
    seats: playSeats
      .filter((s) => byIndex.has(s.seat))
      .map((s) => ({
        seat: s.seat,
        stack: s.stack,
        streetCommitted: s.streetCommitted,
        committedTotal: s.committedTotal,
        status: s.status,
        hasActed: s.hasActed,
      })),
    actionLog,
    finalCurrentBet,
    finalLastRaiseSize: lastRaiseOut.value,
  };
}

// ---------------------------------------------------------------------------
// Betting round
// ---------------------------------------------------------------------------

interface BettingRoundCtx {
  seats: PlaySeat[];
  board: Card[];
  street: 'preflop' | 'flop' | 'turn' | 'river';
  firstToAct: number;
  currentBet: bigint;
  lastRaiseSize: bigint;
  actionLog: ActionLogEntry[];
  args: PlayHoldemHandArgs;
  humanActions: HoldemActionRecord[];
  humanCursor: { idx: number };
  /**
   * TEST-ONLY: explicit per-seat action scripts for non-human seats, replacing
   * `decideBot` so the betting state machine can be driven deterministically by
   * the scripted-bet regression harness. Keyed by seat index → ordered actions.
   * When a non-human seat is to act and a script exists for it, the next action
   * is pulled (and validated through the SAME `applyDecision` gate as live play,
   * so an illegal scripted raise THROWS just like a human one). Undefined in
   * production — bots decide via `decideBot`. Never wired by any route.
   */
  scriptedNonHuman?: Map<number, { actions: HoldemActionRecord[]; idx: number }>;
}

function runBettingRound(ctx: BettingRoundCtx, lastRaiseOut?: { value: bigint }): void {
  const { seats } = ctx;
  let currentBet = ctx.currentBet;
  let lastRaiseSize = ctx.lastRaiseSize;

  // Per-(seat,street) MONOTONIC decision counter for the bot-roll cursor (BUG 3
  // fix). Resets each street because runBettingRound is called fresh per street;
  // every distinct decision a seat makes this street gets a distinct, dense,
  // non-overlapping cursor window → distinct roll bytes. Deterministic +
  // replay-stable: the decision SEQUENCE is fully determined by the engine.
  const botDecisionCount = new Map<number, number>();

  // Count seats that can still make a decision (active, with chips behind).
  // If ≤1 can act AND all matched, the round is over immediately.
  let pointer = ctx.firstToAct;
  let safety = 0;
  const maxIterations = SEATS * 64; // generous bound; betting always terminates

  // A counter so we know everyone has had a chance to act since the last raise.
  // The round ends when every non-folded, non-all-in seat has acted AND has
  // streetCommitted === currentBet (or has folded / is all-in).

  while (safety++ < maxIterations) {
    if (bettingRoundComplete(seats, currentBet)) break;

    const seat = seats[pointer]!;
    pointer = (pointer + 1) % SEATS;

    if (seat.status === 'folded' || seat.status === 'allin') continue;
    // A seat with no chips behind that already matched cannot act.
    if (seat.stack === 0n) { seat.status = 'allin'; continue; }
    // Skip a seat that has already acted and is square with the current bet,
    // UNLESS it still owes chips (a raise reopened the action).
    if (seat.hasActed && seat.streetCommitted === currentBet) continue;

    const toCall = currentBet - seat.streetCommitted;

    // ── Raise-rights gate (BUG 1) ────────────────────────────────────────────
    // A seat may RAISE only if it has NOT yet acted since the last FULL bet/raise
    // — i.e. exactly when its `hasActed` is false at the moment it acts. A seat
    // that already acted and is only acting again because a SHORT all-in lifted
    // currentBet may ONLY call or fold. Captured BEFORE we mark hasActed=true.
    const canReopen = !seat.hasActed;

    if (seat.isHuman) {
      const rec = ctx.humanActions[ctx.humanCursor.idx];
      if (!rec) {
        throw new Error(
          `holdem-engine: ran out of human actions on ${ctx.street} (seat 0 to act, toCall=${toCall})`,
        );
      }
      ctx.humanCursor.idx++;
      applyDecision(seat, rec, {
        currentBet,
        lastRaiseSize,
        toCall,
        actionLog: ctx.actionLog,
        street: ctx.street,
        seats,
        canReopen,
      });
    } else {
      const scripted = ctx.scriptedNonHuman?.get(seat.seat);
      let decision: HoldemActionRecord;
      if (scripted) {
        const rec = scripted.actions[scripted.idx];
        if (!rec) {
          throw new Error(
            `holdem-engine: ran out of scripted actions for seat ${seat.seat} on ${ctx.street} (toCall=${toCall})`,
          );
        }
        scripted.idx++;
        decision = rec;
      } else {
        const n = botDecisionCount.get(seat.seat) ?? 0;
        botDecisionCount.set(seat.seat, n + 1);
        decision = decideBot(seat, {
          board: ctx.board,
          street: ctx.street,
          currentBet,
          lastRaiseSize,
          toCall,
          seats,
          args: ctx.args,
          canReopen,
          decisionIndex: n,
        });
      }
      applyDecision(seat, decision, {
        currentBet,
        lastRaiseSize,
        toCall,
        actionLog: ctx.actionLog,
        street: ctx.street,
        seats,
        canReopen,
      });
    }

    // Update the round's bet level if this seat raised/bet.
    if (seat.streetCommitted > currentBet) {
      const increment = seat.streetCommitted - currentBet; // raise-over amount
      // ── FULL raise vs SHORT all-in (BUG 1) ────────────────────────────────
      // A FULL raise (increment >= lastRaiseSize) sets the new min-raise size
      // and REOPENS action (everyone else regains full call/raise rights). A
      // SHORT all-in (increment < lastRaiseSize — only reachable via the all-in
      // legality bypass in applyDecision) RAISES currentBet (so everyone still
      // owes up to the new level and must act on it) but does NOT reopen action
      // and does NOT shrink lastRaiseSize.
      const isFullRaise = increment >= lastRaiseSize;
      currentBet = seat.streetCommitted;
      if (isFullRaise) {
        lastRaiseSize = increment;
        for (const s of seats) {
          if (s.seat !== seat.seat && s.status === 'active' && s.stack > 0n) {
            s.hasActed = false;
          }
        }
      }
      // SHORT all-in: leave lastRaiseSize unchanged + do NOT reset hasActed.
      // Already-acted seats are NOT forced to re-decide with raise rights; they
      // re-enter the loop only because streetCommitted < currentBet now (owing
      // the difference), and the canReopen gate restricts them to call/fold.
    }
    seat.hasActed = true;
  }

  if (safety >= maxIterations) {
    throw new Error(`holdem-engine: betting round did not terminate on ${ctx.street}`);
  }

  // TEST-ONLY readback: surface the final table min-raise to the scripted driver.
  // Production callers (playHand) pass no out-param, so this is a no-op for them.
  if (lastRaiseOut) lastRaiseOut.value = lastRaiseSize;
}

/**
 * A betting round is complete when every seat that is still `active` (not
 * folded, not all-in) has acted at least once this street AND has matched the
 * current bet. All-in / folded seats are ignored. Special case: if ≤1 seat can
 * still voluntarily act (others folded/all-in) and that seat has matched, done.
 */
function bettingRoundComplete(seats: PlaySeat[], currentBet: bigint): boolean {
  const live = seats.filter((s) => s.status === 'active');
  if (live.length === 0) return true;
  for (const s of live) {
    if (s.stack === 0n) continue; // can't act (auto all-in handled in loop)
    if (!s.hasActed) return false;
    if (s.streetCommitted !== currentBet) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Apply a single decision to a seat (validates legality)
// ---------------------------------------------------------------------------

interface ApplyCtx {
  currentBet: bigint;
  lastRaiseSize: bigint;
  toCall: bigint;
  actionLog: ActionLogEntry[];
  street: 'preflop' | 'flop' | 'turn' | 'river';
  seats: PlaySeat[];
  /**
   * Raise-rights flag (BUG 1). True iff this seat had NOT yet acted since the
   * last FULL bet/raise at the moment it acts — i.e. it keeps full raise rights.
   * When false the seat may only call or fold: a bet/raise attempt is ILLEGAL
   * (it already acted and is re-acting solely because a short all-in lifted the
   * bet). Defaults to permissive (true) when the caller omits it so existing
   * legal-raise behavior is unchanged.
   */
  canReopen?: boolean;
}

function applyDecision(seat: PlaySeat, rec: HoldemActionRecord, ctx: ApplyCtx): void {
  const { toCall, currentBet, lastRaiseSize } = ctx;
  const canReopen = ctx.canReopen ?? true;

  switch (rec.type) {
    case 'fold': {
      seat.status = 'folded';
      log(ctx.actionLog, seat, ctx.street, 'fold', seat.streetCommitted);
      return;
    }
    case 'check': {
      if (toCall !== 0n) {
        throw new Error(`holdem-engine: illegal check — owes ${toCall} (seat ${seat.seat})`);
      }
      log(ctx.actionLog, seat, ctx.street, 'check', seat.streetCommitted);
      return;
    }
    case 'call': {
      // Call the lesser of toCall and the remaining stack (all-in call).
      const pay = toCall < seat.stack ? toCall : seat.stack;
      moveChips(seat, pay);
      if (seat.stack === 0n) seat.status = 'allin';
      log(ctx.actionLog, seat, ctx.street, 'call', seat.streetCommitted);
      return;
    }
    case 'bet':
    case 'raise': {
      // BUG 1 gate: an already-acted seat re-acting only because a SHORT all-in
      // lifted the bet has NO raise rights — it may only call or fold. Reject a
      // bet/raise BEFORE any amount/min-raise checks so the illegal re-raise is
      // unambiguous (and so it fires even on an all-in re-shove for less).
      if (!canReopen) {
        throw new Error(
          `holdem-engine: illegal ${rec.type} — action not reopened to seat ${seat.seat} ` +
            `(may only call/fold over a short all-in)`,
        );
      }
      if (rec.amount === undefined) {
        throw new Error(`holdem-engine: ${rec.type} requires an amount (seat ${seat.seat})`);
      }
      const target = BigInt(rec.amount); // total street commitment after the action
      const maxTarget = seat.streetCommitted + seat.stack; // shove ceiling
      if (target > maxTarget) {
        throw new Error(
          `holdem-engine: ${rec.type} to ${target} exceeds stack (max ${maxTarget}, seat ${seat.seat})`,
        );
      }
      const increment = target - seat.streetCommitted;
      const raiseOver = target - currentBet; // how much above the current bet
      const isAllIn = target === maxTarget;

      if (rec.type === 'bet') {
        if (currentBet !== 0n) {
          throw new Error(`holdem-engine: bet illegal when currentBet=${currentBet} (use raise)`);
        }
        // Min bet = one big blind (lastRaiseSize seeded to BB postflop) unless all-in.
        if (!isAllIn && raiseOver < lastRaiseSize) {
          throw new Error(
            `holdem-engine: bet ${target} below min ${lastRaiseSize} (seat ${seat.seat})`,
          );
        }
      } else {
        if (currentBet === 0n) {
          throw new Error(`holdem-engine: raise illegal when currentBet=0 (use bet)`);
        }
        if (target <= currentBet) {
          throw new Error(`holdem-engine: raise to ${target} not above currentBet ${currentBet}`);
        }
        // Min-raise = previous raise size, unless this is an all-in for less.
        if (!isAllIn && raiseOver < lastRaiseSize) {
          throw new Error(
            `holdem-engine: raise increment ${raiseOver} below min-raise ${lastRaiseSize} (seat ${seat.seat})`,
          );
        }
      }

      moveChips(seat, increment);
      if (seat.stack === 0n) seat.status = 'allin';
      log(ctx.actionLog, seat, ctx.street, rec.type, seat.streetCommitted);
      return;
    }
    default: {
      const _exhaustive: never = rec.type;
      throw new Error(`holdem-engine: unknown action ${String(_exhaustive)}`);
    }
  }
}

function moveChips(seat: PlaySeat, amount: bigint): void {
  if (amount < 0n) throw new Error('holdem-engine: negative chip move');
  if (amount > seat.stack) throw new Error('holdem-engine: chip move exceeds stack');
  seat.stack -= amount;
  seat.streetCommitted += amount;
  seat.committedTotal += amount;
}

function postBlind(
  seat: PlaySeat,
  blind: bigint,
  actionLog: ActionLogEntry[],
  street: 'preflop',
  kind: 'post-sb' | 'post-bb',
): void {
  const pay = blind < seat.stack ? blind : seat.stack;
  moveChips(seat, pay);
  if (seat.stack === 0n) seat.status = 'allin';
  actionLog.push({
    seat: seat.seat,
    street,
    type: kind,
    amount: seat.streetCommitted.toString(),
    isHuman: seat.isHuman,
  });
}

function log(
  actionLog: ActionLogEntry[],
  seat: PlaySeat,
  street: 'preflop' | 'flop' | 'turn' | 'river',
  type: HoldemActionType,
  streetCommitted: bigint,
): void {
  actionLog.push({
    seat: seat.seat,
    street,
    type,
    amount: streetCommitted.toString(),
    isHuman: seat.isHuman,
  });
}

// ---------------------------------------------------------------------------
// Bot decision engine (deterministic)
// ---------------------------------------------------------------------------

interface BotCtx {
  board: Card[];
  street: 'preflop' | 'flop' | 'turn' | 'river';
  currentBet: bigint;
  lastRaiseSize: bigint;
  toCall: bigint;
  seats: PlaySeat[];
  args: PlayHoldemHandArgs;
  /**
   * Raise-rights flag (BUG 1). When false the bot has already acted since the
   * last full bet/raise and is re-acting only because a short all-in lifted the
   * bet — it MUST clamp to call/fold and never emit a raise it cannot legally
   * make (the server gate in applyDecision would otherwise throw).
   */
  canReopen: boolean;
  /**
   * MONOTONIC per-(seat,street) decision index (BUG 3). 0 for the seat's first
   * decision this street, 1 for the second, … Threaded into the bot-roll cursor
   * so distinct same-seat same-street decisions consume distinct, non-colliding
   * stream bytes. Deterministic + replay-stable.
   */
  decisionIndex: number;
}

/**
 * Decide a bot's action deterministically. Strength is a 0..1 estimate from
 * hole+board; thresholds vary by personality. Any mixed-strategy "roll" is
 * derived from the HMAC stream at a dedicated cursor region so it stays
 * replayable. Bots never use Math.random.
 */
function decideBot(seat: PlaySeat, ctx: BotCtx): HoldemActionRecord {
  const personality = seat.personality ?? 'tag';
  const strength = estimateStrength(seat.hole, ctx.board, ctx.street);
  const potBefore = totalPot(ctx.seats);

  // Deterministic mixed-strategy roll in [0,1) from the stream.
  const roll = botRoll(seat, ctx);

  const p = PROFILES[personality];

  // Facing no chips owed (toCall===0): the seat may check, OR be aggressive.
  // CRUCIAL: "owes nothing" is NOT the same as "no bet exists". Preflop the BB
  // has toCall===0 but currentBet===BB, so an aggressive action there is a
  // RAISE (the big-blind option), not a bet. Postflop with currentBet===0 it is
  // a true opening bet. Pick the verb off currentBet to keep the script legal.
  if (ctx.toCall === 0n) {
    // BUG 1: an aggressive verb here is a bet (currentBet===0) or a BB-option
    // RAISE (currentBet>0). A raise requires reopened rights — clamp to check
    // when the action is not reopened to this seat. (A true opening bet when
    // currentBet===0 always has reopened rights, but gate defensively anyway.)
    const wantsAggression =
      strength >= p.betThreshold || (strength >= p.semiBluffThreshold && roll < p.bluffFreq);
    if (wantsAggression && ctx.canReopen) {
      if (ctx.currentBet === 0n) {
        const betSize = sizeBet(seat, ctx, potBefore, p.betSizing);
        if (betSize !== null) return { type: 'bet', amount: betSize.toString() };
      } else {
        // BB option raise — must clear the current bet by ≥ min-raise.
        const raiseTo = sizeRaise(seat, ctx, potBefore, p.betSizing);
        if (raiseTo !== null && raiseTo > ctx.currentBet) {
          return { type: 'raise', amount: raiseTo.toString() };
        }
      }
    }
    return { type: 'check' };
  }

  // Facing a bet: fold / call / raise.
  // Pot odds: callCost / (pot + callCost). Bots fold weak hands to big bets.
  const callCost = ctx.toCall < seat.stack ? ctx.toCall : seat.stack;
  const potOdds = Number(callCost) / Number(potBefore + callCost);

  // Raise with very strong hands (or a profile-driven bluff-raise) — but ONLY
  // when the action is reopened to this seat (BUG 1). An already-acted seat
  // facing a short all-in clamps to call/fold here; it can NEVER re-raise.
  if (
    ctx.canReopen &&
    (strength >= p.raiseThreshold ||
      (strength >= p.semiBluffThreshold && roll < p.bluffRaiseFreq))
  ) {
    const raiseTo = sizeRaise(seat, ctx, potBefore, p.betSizing);
    if (raiseTo !== null && raiseTo > ctx.currentBet) {
      return { type: 'raise', amount: raiseTo.toString() };
    }
    // Can't make a legal raise (stack too short) → call/all-in.
    return { type: 'call' };
  }

  // Call if hand strength clears the call threshold relative to pot odds.
  // calling stations call far more liberally (low effective threshold).
  const callThreshold = p.callThreshold + potOdds * p.potOddsWeight;
  if (strength >= callThreshold) {
    return { type: 'call' };
  }

  // Otherwise fold — but never fold when the call is free-ish for a station
  // already covered by toCall===0 above. A nit/tight folds.
  return { type: 'fold' };
}

interface Profile {
  betThreshold: number;
  raiseThreshold: number;
  callThreshold: number;
  semiBluffThreshold: number;
  bluffFreq: number;
  bluffRaiseFreq: number;
  potOddsWeight: number;
  /** Fraction of pot for bets/raises (e.g. 0.66 = two-thirds pot). */
  betSizing: number;
}

const PROFILES: Record<BotPersonality, Profile> = {
  // tight-aggressive: folds weak, bets/raises strong, occasional bluff.
  tag: {
    betThreshold: 0.55, raiseThreshold: 0.72, callThreshold: 0.42,
    semiBluffThreshold: 0.30, bluffFreq: 0.18, bluffRaiseFreq: 0.10,
    potOddsWeight: 0.5, betSizing: 0.66,
  },
  // loose-aggressive: plays many hands, bets/raises light, bluffs a lot.
  lag: {
    betThreshold: 0.42, raiseThreshold: 0.58, callThreshold: 0.30,
    semiBluffThreshold: 0.20, bluffFreq: 0.35, bluffRaiseFreq: 0.22,
    potOddsWeight: 0.6, betSizing: 0.75,
  },
  // tight-passive: calls little, rarely raises, folds to aggression.
  'tight-passive': {
    betThreshold: 0.70, raiseThreshold: 0.85, callThreshold: 0.50,
    semiBluffThreshold: 0.99, bluffFreq: 0.0, bluffRaiseFreq: 0.0,
    potOddsWeight: 0.4, betSizing: 0.5,
  },
  // calling-station: calls almost anything, rarely raises, rarely folds.
  'calling-station': {
    betThreshold: 0.75, raiseThreshold: 0.90, callThreshold: 0.18,
    semiBluffThreshold: 0.99, bluffFreq: 0.0, bluffRaiseFreq: 0.0,
    potOddsWeight: 0.9, betSizing: 0.5,
  },
  // nit: only premium hands.
  nit: {
    betThreshold: 0.78, raiseThreshold: 0.88, callThreshold: 0.62,
    semiBluffThreshold: 0.99, bluffFreq: 0.0, bluffRaiseFreq: 0.0,
    potOddsWeight: 0.3, betSizing: 0.6,
  },
};

/**
 * Per-decision cursor window width, in bytes. `sampleIntFromBytes` consumes 4
 * bytes per rejection attempt and bounds itself at 64 attempts, so 64*4 = 256
 * bytes is the absolute max a single decision can consume. Giving each decision
 * a 256-byte window guarantees NO two decisions ever overlap stream bytes, even
 * in the (astronomically unlikely) worst-case rejection run.
 */
const BOT_DECISION_WINDOW = 256; // 64 attempts × SAMPLE_WIDTH(4)
/** Per-(seat,street) span: room for 64 distinct decisions × the window. */
const BOT_DECISION_STREET_SPAN = 64 * BOT_DECISION_WINDOW; // 16384
/** Per-seat span: 4 streets × the per-(seat,street) span. */
const BOT_DECISION_SEAT_SPAN = 4 * BOT_DECISION_STREET_SPAN; // 65536

/**
 * Deterministic roll in [0,1) for a bot decision, from the HMAC stream (BUG 3
 * fix). The cursor is a dense, NON-OVERLAPPING per-(seat, street, decisionIndex)
 * window within the dedicated bot-decision region (≥ 2^20, far above any
 * card-deal byte). `decisionIndex` is a MONOTONIC counter threaded from the
 * betting loop — so two distinct decisions by the same bot on the same street
 * (e.g. open then re-decide after a reopen) get DISTINCT bytes and can no longer
 * collide. Stable per replay because the decision sequence is fully
 * deterministic. The old `committedTotal%1000 + currentBet%1000` discriminator
 * could collapse two distinct decisions onto one window (reusing roll bytes and
 * correlating bluffs); the monotonic index cannot.
 */
function botRoll(seat: PlaySeat, ctx: BotCtx): number {
  const streetIndex = { preflop: 0, flop: 1, turn: 2, river: 3 }[ctx.street];
  // Clamp the index into its street span (64 decisions/street is far beyond any
  // real betting round; the clamp only guards against a pathological input and
  // keeps every cursor inside the dedicated bot region).
  const safeIndex = ctx.decisionIndex < 0
    ? 0
    : ctx.decisionIndex >= 64
      ? 63
      : ctx.decisionIndex;
  const cursor =
    BOT_DECISION_CURSOR_BASE +
    (seat.seat * BOT_DECISION_SEAT_SPAN) +
    (streetIndex * BOT_DECISION_STREET_SPAN) +
    (safeIndex * BOT_DECISION_WINDOW);
  const { value } = sampleIntFromBytes({
    serverSeed: ctx.args.serverSeed,
    clientSeed: ctx.args.clientSeed,
    nonce: ctx.args.nonce,
    cursorStart: cursor,
    min: 0,
    max: 1_000_000,
  });
  return value / 1_000_000;
}

/** Total chips currently in the pot (all seats' committedTotal). */
function totalPot(seats: PlaySeat[]): bigint {
  let t = 0n;
  for (const s of seats) t += s.committedTotal;
  return t;
}

/**
 * Size a bet (currentBet===0 street). Returns the TOTAL street commitment
 * target, clamped to legal min and the stack. Null if no legal bet (can't
 * cover min) — caller falls back to check.
 */
function sizeBet(seat: PlaySeat, ctx: BotCtx, pot: bigint, fraction: number): bigint | null {
  const maxTarget = seat.streetCommitted + seat.stack;
  const min = seat.streetCommitted + ctx.lastRaiseSize; // min bet = lastRaiseSize (BB postflop)
  if (maxTarget < min) {
    // Can only shove for less than min — that's a legal all-in bet.
    return maxTarget > seat.streetCommitted ? maxTarget : null;
  }
  const desired = seat.streetCommitted + bigintFraction(pot, fraction);
  let target = desired < min ? min : desired;
  if (target > maxTarget) target = maxTarget;
  return target > seat.streetCommitted ? target : null;
}

/**
 * Size a raise (currentBet>0). Returns TOTAL street commitment target ≥ legal
 * min-raise, clamped to stack. Null if the seat can't even min-raise (then the
 * caller calls instead).
 */
function sizeRaise(seat: PlaySeat, ctx: BotCtx, pot: bigint, fraction: number): bigint | null {
  const maxTarget = seat.streetCommitted + seat.stack;
  const minRaiseTo = ctx.currentBet + ctx.lastRaiseSize;
  if (maxTarget < minRaiseTo) {
    // Can shove for less than a full min-raise — legal all-in raise only if it
    // is strictly above the current bet (otherwise it's just a call).
    return maxTarget > ctx.currentBet ? maxTarget : null;
  }
  // Pot-fraction raise sizing: raise to currentBet + fraction*(pot + call).
  const callCost = ctx.currentBet - seat.streetCommitted;
  const raiseIncrement = bigintFraction(pot + callCost, fraction);
  let target = ctx.currentBet + (raiseIncrement < ctx.lastRaiseSize ? ctx.lastRaiseSize : raiseIncrement);
  if (target < minRaiseTo) target = minRaiseTo;
  if (target > maxTarget) target = maxTarget;
  return target > ctx.currentBet ? target : null;
}

/** floor(value * fraction) using bigint-safe integer math (fraction in 0..1). */
function bigintFraction(value: bigint, fraction: number): bigint {
  const numer = BigInt(Math.round(fraction * 1000));
  return (value * numer) / 1000n;
}

// ---------------------------------------------------------------------------
// Hand strength estimate (0..1), deterministic
// ---------------------------------------------------------------------------

/**
 * Estimate a hand's strength in [0,1]. Preflop uses a Chen-like formula on the
 * two hole cards; postflop uses the made-hand category (from the 5–7 known
 * cards) plus the high card, normalized. This is a heuristic — its only hard
 * requirements are DETERMINISM and monotonicity (better cards ⇒ higher score),
 * which the tests assert.
 */
export function estimateStrength(
  hole: readonly Card[],
  board: readonly Card[],
  street: 'preflop' | 'flop' | 'turn' | 'river',
): number {
  if (street === 'preflop' || board.length === 0) {
    return preflopStrength(hole);
  }
  const known = [...hole, ...board];
  const rank = evaluateBest5(known);
  // Map category (0..8) to a base band, refine with the top tiebreaker.
  const base = rank.category / 9; // 0 .. 0.889
  const topKicker = (rank.tiebreakers[0] ?? 2) / 14; // 0.14 .. 1
  // Weight base heavily (made-hand class dominates), kicker as fine-grain.
  const score = base + topKicker * (1 / 9) * 0.9;
  return Math.min(0.999, score);
}

/** Chen-like preflop strength normalized to [0,1]. */
function preflopStrength(hole: readonly Card[]): number {
  if (hole.length !== 2) return 0;
  const a = rankValue(hole[0]!.rank);
  const b = rankValue(hole[1]!.rank);
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  const suited = hole[0]!.suit === hole[1]!.suit;
  const pair = a === b;
  const gap = high - low;

  // Chen formula points.
  let pts: number;
  const highPts =
    high === 14 ? 10 :
    high === 13 ? 8 :
    high === 12 ? 7 :
    high === 11 ? 6 :
    high / 2;
  if (pair) {
    pts = Math.max(5, highPts * 2); // pairs: max(5, 2×high points)
  } else {
    pts = highPts;
    if (suited) pts += 2;
    // gap penalty
    const gapPenalty =
      gap === 1 ? 0 :
      gap === 2 ? 1 :
      gap === 3 ? 2 :
      gap === 4 ? 4 : 5;
    pts -= gapPenalty;
    // straight bonus for 0/1-gap low cards
    if (gap <= 1 && high < 12) pts += 1;
  }
  // Chen ranges roughly -1..20; normalize. AA = 20, 72o ≈ 0.
  const norm = (pts + 1) / 21;
  return Math.max(0, Math.min(0.99, norm));
}

// ---------------------------------------------------------------------------
// Side-pot construction + award
// ---------------------------------------------------------------------------

/**
 * Build side pots from each seat's total committed chips. Standard algorithm:
 * sort distinct commitment levels ascending; each level forms a pot layer
 * funded by `min(level, committed)` from every seat that put in ≥ prior level.
 * Folded seats' chips are still in the pots (dead money) but they are NOT
 * eligible to win. Eligibility = seats that reached that commitment level AND
 * did not fold.
 */
export function buildSidePots(seats: PlaySeat[]): PotResult[] {
  const committed = seats.map((s) => ({ seat: s.seat, amt: s.committedTotal, folded: s.status === 'folded' }));
  const levels = [...new Set(committed.filter((c) => c.amt > 0n).map((c) => c.amt.toString()))]
    .map((v) => BigInt(v))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const pots: PotResult[] = [];
  let prevLevel = 0n;
  for (const level of levels) {
    const layer = level - prevLevel;
    if (layer <= 0n) { prevLevel = level; continue; }
    let amount = 0n;
    const contributorsAtLevel = committed.filter((c) => c.amt >= level);
    amount = layer * BigInt(contributorsAtLevel.length);
    // Eligible = contributed up to this level AND not folded.
    const eligible = contributorsAtLevel.filter((c) => !c.folded).map((c) => c.seat);
    if (amount > 0n) {
      pots.push({ amount, eligibleSeats: eligible, winners: [], perWinner: 0n });
    }
    prevLevel = level;
  }
  // Merge consecutive pots with identical eligibility (cleaner display, same award math).
  return mergePotsByEligibility(pots);
}

function mergePotsByEligibility(pots: PotResult[]): PotResult[] {
  const merged: PotResult[] = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    if (last && sameSeatSet(last.eligibleSeats, pot.eligibleSeats)) {
      last.amount += pot.amount;
    } else {
      merged.push({ ...pot, eligibleSeats: [...pot.eligibleSeats] });
    }
  }
  return merged;
}

function sameSeatSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Award each pot to the best eligible hand(s), split on ties. Builds the final
 * SeatResult[] including won amounts and hand ranks. The odd-chip remainder on a
 * split goes to the eligible winner in the EARLIEST seat order (deterministic).
 *
 * Exported (behavior unchanged) so the NET-NEW live multi-human `PokerTableSim`
 * reuses the SAME showdown award/eligibility/tie-split/remainder logic as
 * `playHand`, rather than reimplementing it (a parity test asserts no
 * divergence). The sim builds `PlaySeat[]` from its own seat state, calls
 * `buildSidePots(seats)` then `awardPots(seats, pots, board, endedAt)`.
 */
export function awardPots(
  seats: PlaySeat[],
  pots: PotResult[],
  board: Card[],
  endedAt: HoldemHandResult['endedAt'],
): SeatResult[] {
  // Compute hand ranks for seats that can be evaluated (have a full board view).
  // A hand that ended preflop/flop/turn (everyone else folded) has a single
  // live seat that wins without showdown — but we still evaluate any non-folded
  // seat against whatever board exists for display (board may be < 5 cards).
  const rankBySeat = new Map<number, HandRank | null>();
  for (const s of seats) {
    if (s.status === 'folded') { rankBySeat.set(s.seat, null); continue; }
    if (board.length >= 5) {
      rankBySeat.set(s.seat, evaluateBest5([...s.hole, ...board]));
    } else if (board.length >= 0 && (board.length + s.hole.length) >= 5) {
      rankBySeat.set(s.seat, evaluateBest5([...s.hole, ...board]));
    } else {
      rankBySeat.set(s.seat, null);
    }
  }

  const wonBySeat = new Map<number, bigint>();
  for (const s of seats) wonBySeat.set(s.seat, 0n);

  for (const pot of pots) {
    const eligible = pot.eligibleSeats;
    if (eligible.length === 0) continue;
    if (eligible.length === 1) {
      // Uncontested layer.
      pot.winners = [eligible[0]!];
      pot.perWinner = pot.amount;
      wonBySeat.set(eligible[0]!, (wonBySeat.get(eligible[0]!) ?? 0n) + pot.amount);
      continue;
    }
    // Find the best rank among eligible seats.
    let best: HandRank | null = null;
    for (const seat of eligible) {
      const r = rankBySeat.get(seat) ?? null;
      if (!r) continue;
      if (!best || compareHandRank(r, best) > 0) best = r;
    }
    if (!best) {
      // No evaluable hands (shouldn't happen at showdown) — split evenly.
      const share = pot.amount / BigInt(eligible.length);
      pot.winners = [...eligible];
      pot.perWinner = share;
      distributeWithRemainder(pot.amount, eligible, wonBySeat);
      continue;
    }
    const winners = eligible.filter((seat) => {
      const r = rankBySeat.get(seat);
      return r ? compareHandRank(r, best!) === 0 : false;
    });
    pot.winners = winners;
    pot.perWinner = pot.amount / BigInt(winners.length);
    distributeWithRemainder(pot.amount, winners, wonBySeat);
  }

  return seats.map((s) => {
    const won = wonBySeat.get(s.seat) ?? 0n;
    return {
      seat: s.seat,
      isHuman: s.isHuman,
      personality: s.personality,
      holeCards: s.hole,
      committed: s.committedTotal,
      won,
      net: won - s.committedTotal,
      status: s.status,
      handRank: s.status === 'folded' ? null : rankBySeat.get(s.seat) ?? null,
      isWinner: won > 0n,
    };
  });
}

/**
 * Split `amount` among `winners` (sorted by seat order). Each gets
 * floor(amount/n); the odd-chip remainder goes one chip at a time to the
 * earliest seats (deterministic, conserves total chips exactly).
 *
 * TODO(P3): odd-chip remainder is assigned by ascending SEAT INDEX, not
 * button-relative order (first seat left of the button gets the odd chip per
 * standard NLHE). Button-relative ordering is deferred to the button-rotation
 * work phase; it needs the button seat threaded down here. Do NOT change this
 * seat-index ordering now — it is intentionally pinned for the current phase.
 */
function distributeWithRemainder(
  amount: bigint,
  winners: number[],
  wonBySeat: Map<number, bigint>,
): void {
  const ordered = [...winners].sort((a, b) => a - b);
  const n = BigInt(ordered.length);
  const share = amount / n;
  let remainder = amount - share * n;
  for (const seat of ordered) {
    let give = share;
    if (remainder > 0n) { give += 1n; remainder -= 1n; }
    wonBySeat.set(seat, (wonBySeat.get(seat) ?? 0n) + give);
  }
}

// ---------------------------------------------------------------------------
// Rake — "rake the pot, then distribute" (economy fix 2026-05-29)
// ---------------------------------------------------------------------------

/** Result of raking a resolved hand's pot. */
export interface HoldemRakeResult {
  /** Total chips in the pot = sum of every seat's committed (= sum of awards). */
  pot: bigint;
  /** House take = min(floor(pot * 5/100), 5). Removed from the pot, not credited. */
  rake: bigint;
  /**
   * Each WINNING seat's raked award after the pot rake is removed. Keyed by
   * seat index; non-winning seats are absent (award 0). Sum of values = pot - rake.
   */
  rakedWonBySeat: Map<number, bigint>;
  /** The human seat's (seat 0) raked payout — what the route credits. */
  humanRakedPayout: bigint;
  /** Human net after rake = humanRakedPayout - humanBet. */
  humanRakedNet: bigint;
}

/**
 * Compute the standard "rake the pot" outcome for a resolved hand. Pure.
 *
 *   pot  = sum of every seat's committed chips (chip-conserving: equals the sum
 *          of every seat's `won`, since the engine never creates/destroys chips).
 *   rake = min(floor(pot * HOLDEM_RAKE_PERCENT / 100), HOLDEM_RAKE_CAP).
 *
 * The rake is taken from the pot BEFORE awarding, so winners split `pot - rake`.
 * We realize this by distributing the rake across the WINNING seats in
 * proportion to each winner's gross `won`, integer floor, with the odd-chip
 * remainder taken from the earliest winning seat (deterministic, so the verifier
 * reproduces it). Each winner's raked award = won - rakeShare. Chip conservation:
 * sum(rakedWonBySeat) + rake === pot.
 *
 * NB: in the current vs-bots table only the human seat is credited real CT (the
 * bots are the house). So the rake the HOUSE actually keeps from the player is
 * `humanRakedPayout`'s shortfall vs the gross `humanPayout`; the bot-side rake is
 * a no-op on the ledger (bot chips are minted/burned by the house either way).
 * The chip-conservation identity is asserted over ALL seats for correctness.
 */
export function computeHoldemRake(result: HoldemHandResult): HoldemRakeResult {
  let pot = 0n;
  for (const s of result.seats) pot += s.committed;

  const rawRake = (pot * HOLDEM_RAKE_PERCENT) / 100n; // floored
  const rake = rawRake < HOLDEM_RAKE_CAP ? rawRake : HOLDEM_RAKE_CAP;

  // Winners (seats that collected chips), ascending seat order (deterministic).
  const winners = result.seats
    .filter((s) => s.won > 0n)
    .map((s) => ({ seat: s.seat, won: s.won }))
    .sort((a, b) => a.seat - b.seat);

  const rakedWonBySeat = new Map<number, bigint>();

  if (winners.length === 0 || rake === 0n) {
    // No winners (impossible at settle — chips always go somewhere) or no rake
    // (tiny pot): every winner keeps its gross award.
    for (const w of winners) rakedWonBySeat.set(w.seat, w.won);
  } else {
    const totalWon = winners.reduce((acc, w) => acc + w.won, 0n); // == pot
    // TODO(P3): the remainder-chip rule below assigns leftover rake chips by
    // ascending SEAT INDEX, not button-relative order. Button-relative ordering
    // (rake the odd chip off the seat first-left-of-button) is deferred to the
    // button-rotation work phase, which threads the button seat down here. Do
    // NOT change this seat-index ordering now.
    //
    // Proportional rake share per winner = floor(rake * won / totalWon), CAPPED
    // at the winner's own `won` so the seeded award can never go negative (the
    // cap only bites in the degenerate case rake > totalWon, e.g. a synthetic
    // result; for a real hand rake <= pot === totalWon so the floor never
    // exceeds won). Capping here means the leftover-reassignment loop below sees
    // the true under-allocation and distributes it correctly.
    let allocated = 0n;
    const shares = winners.map((w) => {
      const raw = (rake * w.won) / totalWon; // floored
      const share = raw > w.won ? w.won : raw; // never rake more than the seat holds
      allocated += share;
      return { seat: w.seat, won: w.won, rakeShare: share };
    });
    // Seed each winner's raked award at won - share (always >= 0 by the cap).
    for (const sh of shares) {
      rakedWonBySeat.set(sh.seat, sh.won - sh.rakeShare);
    }
    // Distribute the leftover rake chips (rake - sum of floored shares) ONE AT A
    // TIME across winners that can still absorb a chip (raked award > 0), in
    // ascending seat order, looping until either the remainder is exhausted or
    // no winner can give another chip. BUG 5 fix: the previous code did a single
    // pass and, if a chip could not be placed on its target seat, FLOORED that
    // seat's award to 0 — which DROPPED a chip and broke chip conservation
    // (sum(rakedWon) + rake != pot) on a tiny pot where the rake exceeds a
    // single winner's whole award. We instead REASSIGN the leftover to another
    // winner. Because sum(won) === totalWon >= rake, the winners can always
    // collectively absorb exactly `rake` chips, so the remainder always reaches
    // 0 without flooring any seat below 0 and exactly `rake` total is removed.
    let remainder = rake - allocated;
    let guard = 0;
    const maxGuard = remainder * 2n + BigInt(shares.length) + 1n;
    while (remainder > 0n && BigInt(guard++) < maxGuard) {
      let placedThisPass = false;
      for (const sh of shares) {
        if (remainder === 0n) break;
        const cur = rakedWonBySeat.get(sh.seat) ?? 0n;
        if (cur > 0n) {
          rakedWonBySeat.set(sh.seat, cur - 1n);
          remainder -= 1n;
          placedThisPass = true;
        }
      }
      if (!placedThisPass) break; // no winner can absorb more (defensive; unreachable when rake <= totalWon)
    }
  }

  const humanRakedPayout = rakedWonBySeat.get(HUMAN_SEAT) ?? 0n;
  const humanSeat = result.seats.find((s) => s.isHuman)!;

  return {
    pot,
    rake,
    rakedWonBySeat,
    humanRakedPayout,
    humanRakedNet: humanRakedPayout - humanSeat.committed,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function countLive(seats: PlaySeat[]): number {
  return seats.filter((s) => s.status !== 'folded').length;
}

/** First seat to act postflop = first non-folded seat left of the button. */
function firstActivePostflop(buttonSeat: number, seats: PlaySeat[]): number {
  for (let i = 1; i <= SEATS; i++) {
    const s = (buttonSeat + i) % SEATS;
    if (seats[s]!.status === 'active') return s;
  }
  // No active seats (all all-in/folded) — return SB position; betting round will no-op.
  return (buttonSeat + 1) % SEATS;
}

function boardForStreet(
  endedAt: HoldemHandResult['endedAt'],
  flop: Card[],
  turn: Card,
  river: Card,
  full: Card[],
): Card[] {
  // The board shown reflects how far the hand progressed. If everyone folded
  // preflop, no community cards are revealed.
  switch (endedAt) {
    case 'preflop': return [];
    case 'flop': return [...flop];
    case 'turn': return [...flop, turn];
    case 'river':
    case 'showdown': return [...full];
    default: return [...full];
  }
}

function validateArgs(args: PlayHoldemHandArgs): void {
  if (!Number.isInteger(args.nonce) || args.nonce < 0) {
    throw new Error(`holdem-engine: nonce must be a non-negative integer, got ${args.nonce}`);
  }
  if (!Number.isInteger(args.buttonSeat) || args.buttonSeat < 0 || args.buttonSeat >= SEATS) {
    throw new Error(`holdem-engine: buttonSeat must be 0..${SEATS - 1}, got ${args.buttonSeat}`);
  }
  if (typeof args.humanStartingStack !== 'bigint' || args.humanStartingStack <= 0n) {
    throw new Error(`holdem-engine: humanStartingStack must be a positive bigint`);
  }
  if (args.botStartingStack !== undefined && (typeof args.botStartingStack !== 'bigint' || args.botStartingStack <= 0n)) {
    throw new Error(`holdem-engine: botStartingStack must be a positive bigint when provided`);
  }
  if (!Array.isArray(args.humanActions)) {
    throw new Error('holdem-engine: humanActions must be an array');
  }
  for (const a of args.humanActions) {
    if (!a || typeof a.type !== 'string') {
      throw new Error('holdem-engine: each humanAction needs a type');
    }
    if ((a.type === 'bet' || a.type === 'raise') && a.amount === undefined) {
      throw new Error(`holdem-engine: ${a.type} action requires an amount`);
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization for cove_game_events.outcomeJson
// ---------------------------------------------------------------------------

export interface SerializedHoldemHand {
  kind: 'holdem';
  handIndex: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  board: Card[];
  endedAt: HoldemHandResult['endedAt'];
  seats: Array<{
    seat: number;
    isHuman: boolean;
    personality: BotPersonality | null;
    holeCards: Card[];
    committed: string;
    won: string;
    net: string;
    status: SeatStatus;
    handCategory: number | null;
    handCategoryName: string | null;
    isWinner: boolean;
  }>;
  pots: Array<{
    amount: string;
    eligibleSeats: number[];
    winners: number[];
    perWinner: string;
  }>;
  actionLog: ActionLogEntry[];
  /** GROSS chips the human won back before the rake (engine award). */
  humanBet: string;
  humanPayout: string;
  humanNet: string;
  /**
   * Total pot raked = min(floor(pot*5/100), 5). House take, not credited.
   * OPTIONAL for back-compat with pre-fix rows stored before the rake existed
   * (mirrors the shared @clawville/shared copy). `serializeHoldemHand` always
   * sets it; readers of a stored `outcomeJson` MUST `?? '0'`-fallback.
   */
  rake?: string;
  /**
   * Human payout AFTER the rake — what the route actually credits to the stack.
   * OPTIONAL for back-compat; readers MUST `?? humanPayout`-fallback.
   */
  humanRakedPayout?: string;
  /**
   * Human net AFTER the rake = humanRakedPayout - humanBet.
   * OPTIONAL for back-compat; readers MUST `?? humanNet`-fallback.
   */
  humanRakedNet?: string;
  nonce: number;
  engineVersion: string;
}

export function serializeHoldemHand(result: HoldemHandResult): SerializedHoldemHand {
  const raked = computeHoldemRake(result);
  return {
    kind: 'holdem',
    handIndex: result.handIndex,
    buttonSeat: result.buttonSeat,
    smallBlindSeat: result.smallBlindSeat,
    bigBlindSeat: result.bigBlindSeat,
    board: result.board,
    endedAt: result.endedAt,
    seats: result.seats.map((s) => ({
      seat: s.seat,
      isHuman: s.isHuman,
      personality: s.personality,
      holeCards: s.holeCards,
      committed: s.committed.toString(),
      // `won` stays the GROSS engine award (chip-conserving). The rake is
      // recorded separately + applied to the credited human payout below.
      won: s.won.toString(),
      net: s.net.toString(),
      status: s.status,
      handCategory: s.handRank ? s.handRank.category : null,
      handCategoryName: s.handRank ? handCategoryName(s.handRank.category) : null,
      isWinner: s.isWinner,
    })),
    pots: result.pots.map((p) => ({
      amount: p.amount.toString(),
      eligibleSeats: p.eligibleSeats,
      winners: p.winners,
      perWinner: p.perWinner.toString(),
    })),
    actionLog: result.actionLog,
    humanBet: result.humanBet.toString(),
    humanPayout: result.humanPayout.toString(),
    humanNet: result.humanNet.toString(),
    rake: raked.rake.toString(),
    humanRakedPayout: raked.humanRakedPayout.toString(),
    humanRakedNet: raked.humanRakedNet.toString(),
    nonce: result.handIndex,
    engineVersion: HOLDEM_ENGINE_VERSION,
  };
}

/** Re-export the commit hash helper so the route commits the seed identically. */
export { sha256Hex };
