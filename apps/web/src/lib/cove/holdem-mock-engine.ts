/**
 * Phase 6.5.0 — Hold'em mock engine.
 *
 * Client-side deterministic card deck + dealing + winner evaluation.
 * No API calls. No ledger writes.
 * Phase 6.5.1 replaces this with the vendored pokerpocket engine + real RNG.
 *
 * Iris Xe safe: no Three.js, no DOM, no per-frame allocations.
 */

import type {
  HoldemCard,
  HoldemSuit,
  HoldemRank,
  SeatState,
  BotActionKind,
} from './holdem-types';
import {
  HOLDEM_SEATS,
  HOLDEM_SMALL_BLIND,
  HOLDEM_BIG_BLIND,
  HOLDEM_DEFAULT_BUY_IN,
  RANK_VALUE,
} from './holdem-types';

// ---------------------------------------------------------------------------
// RNG — mulberry32 (same family as blackjack engine)
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let z = Math.imul(s ^ (s >>> 15), 1 | s);
    z = z ^ z + Math.imul(z ^ (z >>> 7), 61 | z);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Deck construction
// ---------------------------------------------------------------------------
const SUITS: HoldemSuit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANKS: HoldemRank[] = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
];

/**
 * Build and shuffle a 52-card deck using mulberry32(seed).
 * Deterministic: same seed → same deck order every time.
 */
export function createMockDeck(seed: number): HoldemCard[] {
  const deck: HoldemCard[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  const rand = mulberry32(seed);
  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck;
}

// ---------------------------------------------------------------------------
// Deal
// ---------------------------------------------------------------------------
export interface DealtHand {
  /** holeCards[seatIdx] = [card0, card1] */
  holeCards: [HoldemCard, HoldemCard][];
  /** Full 5-card community sequence */
  communityDeck: [HoldemCard, HoldemCard, HoldemCard, HoldemCard, HoldemCard];
  /** Remaining deck after dealing hole + community cards */
  remainingDeck: HoldemCard[];
}

/**
 * Deal hole cards and community cards from `deck`.
 * Standard rotation: deal one card per seat twice, then burn+3, burn+1, burn+1.
 * For 6.5.0 we skip the burn cards (client-side mock) to keep it simple.
 */
export function dealHand(deck: HoldemCard[], seatCount = HOLDEM_SEATS): DealtHand {
  let cursor = 0;

  // Deal 2 cards per seat (interleaved rounds)
  const round1: HoldemCard[] = [];
  const round2: HoldemCard[] = [];
  for (let s = 0; s < seatCount; s++) {
    round1.push(deck[cursor++]!);
  }
  for (let s = 0; s < seatCount; s++) {
    round2.push(deck[cursor++]!);
  }

  const holeCards: [HoldemCard, HoldemCard][] = [];
  for (let s = 0; s < seatCount; s++) {
    holeCards.push([round1[s]!, round2[s]!]);
  }

  // Community cards (flop×3, turn×1, river×1)
  const c0 = deck[cursor++]!;
  const c1 = deck[cursor++]!;
  const c2 = deck[cursor++]!;
  const c3 = deck[cursor++]!;
  const c4 = deck[cursor++]!;

  return {
    holeCards,
    communityDeck: [c0, c1, c2, c3, c4],
    remainingDeck: deck.slice(cursor),
  };
}

// ---------------------------------------------------------------------------
// Winner evaluation — mock (pick-best-2 of hole+community by highest rank sum)
// ---------------------------------------------------------------------------
export interface SeatForEval {
  seatIndex: number;
  holeCards: [HoldemCard, HoldemCard] | null;
  status: string; // 'folded' | 'allin' | 'active' | 'out'
}

/**
 * Mock winner: among non-folded seats with hole cards,
 * pick the seat with the highest sum of its best 2 cards
 * (from hole + community), using RANK_VALUE.
 * Ties broken by lower seatIndex (player-favoured).
 */
export function mockWinner(
  seats: SeatForEval[],
  communityCards: (HoldemCard | null)[],
): number {
  const community = communityCards.filter((c): c is HoldemCard => c !== null);

  let bestScore = -1;
  let bestSeat = 0;

  for (const seat of seats) {
    if (seat.status === 'folded' || seat.status === 'out') continue;
    if (!seat.holeCards) continue;

    const allCards = [...seat.holeCards, ...community];
    // Best-2 = top 2 rank values
    const values = allCards.map(c => RANK_VALUE[c.rank]).sort((a, b) => b - a);
    const score = (values[0] ?? 0) + (values[1] ?? 0);

    if (score > bestScore) {
      bestScore = score;
      bestSeat = seat.seatIndex;
    }
  }

  return bestSeat;
}

// ---------------------------------------------------------------------------
// Bot action — always-call for 6.5.0 (personalities in 6.5.1)
// ---------------------------------------------------------------------------
export interface BotActionResult {
  action: BotActionKind;
  /** Amount the bot commits to the pot this action */
  amount: number;
  /** New stack after this action */
  newStack: number;
}

/**
 * Deterministic bot: always calls (or goes all-in if stack < callAmount).
 * Full TAG/LAG/TP personalities ship in Phase 6.5.1.
 */
export function mockBotAction(
  seatStack: number,
  callAmount: number,
): BotActionResult {
  if (seatStack <= 0) {
    return { action: 'allin', amount: 0, newStack: 0 };
  }
  if (seatStack <= callAmount) {
    return { action: 'allin', amount: seatStack, newStack: 0 };
  }
  return { action: 'call', amount: callAmount, newStack: seatStack - callAmount };
}

// ---------------------------------------------------------------------------
// Initial seat setup
// ---------------------------------------------------------------------------
/**
 * Build the initial 6 SeatState entries for a new hand.
 * Seat 0 = player, seats 1–5 = bots.
 * Blinds: seat 1 = small blind (10 CT), seat 2 = big blind (20 CT).
 * Dealer button: seat 0 (player).
 */
export function buildInitialSeats(
  playerBalance: number,
  buyIn: number = HOLDEM_DEFAULT_BUY_IN,
): SeatState[] {
  const seats: SeatState[] = [];
  const botNames = ['Bot A', 'Bot B', 'Bot C', 'Bot D', 'Bot E'];

  for (let i = 0; i < HOLDEM_SEATS; i++) {
    const isSmallBlind = i === 1;
    const isBigBlind = i === 2;
    const isDealer = i === 0;
    const isPlayer = i === 0;

    const stack = isPlayer ? Math.min(playerBalance, buyIn) : buyIn;
    // Post blinds immediately
    const streetBet = isSmallBlind
      ? HOLDEM_SMALL_BLIND
      : isBigBlind
        ? HOLDEM_BIG_BLIND
        : 0;

    seats.push({
      seatIndex: i,
      name: isPlayer ? 'You' : botNames[i - 1]!,
      stack: stack - streetBet,
      streetBet,
      holeCards: null,
      status: 'active',
      isSmallBlind,
      isBigBlind,
      isDealer,
      isActing: false,
    });
  }

  return seats;
}

// Explicit re-export so HoldemModal doesn't need to import from holdem-types directly
export type { SeatState, BotActionKind };
