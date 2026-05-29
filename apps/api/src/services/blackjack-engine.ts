/**
 * Phase 6.4.1 — Blackjack engine (pure, deterministic, provably-fair).
 *
 * Built on top of `provable-rng.ts` (the same commit-reveal HMAC-SHA256
 * byte stream that drives `slot-engine.ts`). Every card dealt is a
 * deterministic function of `(serverSeed, clientSeed, nonce, cursor)` so
 * the frontend / disputes verifier can replay any hand from the revealed
 * seed via the exported pure `replayHand(args)`.
 *
 * ── Locked rules (Phase 6.4.1 spec) ──────────────────────────────────
 *   • 6-deck shoe (312 cards), reshuffle at 75% penetration. Reshuffle is
 *     handled OUTSIDE the engine: each shoe is its OWN commit-reveal
 *     session with a fresh seed pair; the route opens a new session when
 *     penetration crosses 75%. The engine exposes `SHOE_DECKS`,
 *     `CARDS_PER_SHOE`, and `RESHUFFLE_CARD_THRESHOLD` so the route can
 *     decide when to roll a new shoe, but the engine itself never reshuffles
 *     mid-shoe (that would break replay determinism).
 *   • Dealer STANDS on soft 17 (S17).
 *   • Blackjack pays 3:2.
 *   • Bets 5–500 CT (enforced by the route's Zod schema, not the engine —
 *     the engine validates `bet > 0` only, so unit tests can use any stake).
 *   • Actions: hit / stand / double / split / surrender / insurance.
 *   • Insurance is resolved BEFORE the main hand (offered only when the
 *     dealer's upcard is an Ace; pays 2:1 on dealer blackjack).
 *
 * ── Card draw model (provably-fair, no-replacement) ──────────────────
 *
 * The shoe is a fixed, KNOWN multiset: 6 copies of each (suit, rank). We
 * draw WITHOUT replacement by treating the shoe as an ordered list and
 * pulling the k-th still-undealt card, where
 *
 *     k = sampleIntFromBytes(min=0, max=remainingCount)
 *
 * advancing the cursor by the sampler's `bytesConsumed`. This is a partial
 * Fisher–Yates: identical inputs ⇒ identical card sequence, byte-for-byte,
 * across machines. The "ordered list" is the canonical shoe order produced
 * by `buildShoe()` (deck-major, then suit-major, then rank-major) so the
 * verifier reconstructs the same index→card mapping.
 *
 * The cursor passed to `playHand` / `replayHand` is the BYTE OFFSET into
 * the (serverSeed, clientSeed, nonce) stream at which THIS hand's first
 * draw begins. The route stores `cursorBefore` per hand and the engine
 * returns `cursorAfter` so the next hand continues the stream without gaps
 * or overlaps — exactly the slot-engine cursor-bookkeeping contract.
 *
 * IMPORTANT determinism note: because draws are no-replacement against a
 * shared shoe, the cursor is shoe-global and monotonic across hands within
 * a shoe (nonce = handIndex). Replaying a single hand needs the shoe state
 * AT THE START of that hand. For hand 0 the engine builds a full shoe; for
 * a mid-shoe hand the caller supplies the `remainingShoe` + `dealtBefore`
 * it persisted. `replayShoeUpToHand` reconstructs the shoe by replaying
 * every prior hand from nonce 0 when only the per-hand scripts are known.
 *
 * Pure. No I/O, no time, no global state. Same inputs ⇒ byte-identical
 * `HandResult`. Throws on invalid inputs.
 */

import { sampleIntFromBytes, sha256Hex } from './provable-rng';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Decks in a shoe. */
export const SHOE_DECKS = 6;

/** Cards in a 6-deck shoe. */
export const CARDS_PER_SHOE = SHOE_DECKS * 52; // 312

/**
 * Reshuffle penetration — reshuffle once 75% of the shoe has been dealt.
 * The route compares `dealtCount >= RESHUFFLE_CARD_THRESHOLD` AT HAND
 * BOUNDARIES (never mid-hand) to decide whether the NEXT hand needs a
 * fresh shoe/session. 75% of 312 = 234.
 */
export const RESHUFFLE_PENETRATION = 0.75;
export const RESHUFFLE_CARD_THRESHOLD = Math.floor(CARDS_PER_SHOE * RESHUFFLE_PENETRATION); // 234

/** Blackjack payout numerator/denominator (3:2). */
export const BLACKJACK_PAYOUT_NUM = 3n;
export const BLACKJACK_PAYOUT_DEN = 2n;

/** Insurance payout (2:1) on the insurance side bet. */
export const INSURANCE_PAYOUT_NUM = 2n;
export const INSURANCE_PAYOUT_DEN = 1n;

/** Engine version pin for the cove_game_events row (mirrors slot-engine convention). */
export const BLACKJACK_ENGINE_VERSION = 'bj-v1';

/** Canonical suit + rank order — the verifier must reconstruct the shoe in THIS order. */
export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const RANKS = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Card {
  suit: Suit;
  rank: Rank;
}

/** A player action driving the engine state machine. */
export type BlackjackActionType =
  | 'hit'
  | 'stand'
  | 'double'
  | 'split'
  | 'surrender';

/** Terminal outcome of a single player hand vs. the dealer. */
export type HandOutcome =
  | 'blackjack' // natural 21 (2 cards), pays 3:2
  | 'win'       // beats dealer (or dealer bust), pays 1:1
  | 'push'      // tie, stake returned
  | 'loss'      // dealer wins / player bust
  | 'surrender';// player surrendered, half stake returned

/**
 * One resolved player hand (a base hand, or one of the two hands produced
 * by a split). `bet` is the stake on THIS hand in atomic CT (a double
 * already reflects the doubled stake here). `payout` is the GROSS amount
 * returned to the player for this hand (stake + winnings; 0 on a loss,
 * `bet` on a push). Net P&L for the hand = `payout - bet`.
 */
export interface ResolvedPlayerHand {
  cards: Card[];
  /** Best (largest ≤ 21, else the hard) total. */
  total: number;
  /** True if the total counts an ace as 11. */
  isSoft: boolean;
  isBust: boolean;
  /** Natural blackjack = 2-card 21 on the ORIGINAL hand (never on a split). */
  isBlackjack: boolean;
  /** Whether this hand's stake was doubled. */
  isDoubled: boolean;
  /** Stake risked on this hand (post-double). */
  bet: bigint;
  outcome: HandOutcome;
  /** Gross return to player (stake + winnings). 0 = lost stake. */
  payout: bigint;
}

export interface DealerHand {
  cards: Card[];
  total: number;
  isSoft: boolean;
  isBust: boolean;
  isBlackjack: boolean;
}

/** Insurance side-bet resolution (null when not offered/taken). */
export interface InsuranceResult {
  /** Insurance stake the player put up (half the main bet, atomic CT). */
  bet: bigint;
  /** Gross return to player on the insurance bet (0 if dealer had no BJ). */
  payout: bigint;
  /** True iff the dealer turned over a blackjack. */
  dealerHadBlackjack: boolean;
}

/**
 * The full record of a played hand. This is what the route serializes into
 * `cove_game_events.outcomeJson` (after `serializeHandResult`) and what
 * `replayHand` re-derives byte-for-byte from the revealed seed.
 */
export interface HandResult {
  playerHands: ResolvedPlayerHand[];
  dealer: DealerHand;
  insurance: InsuranceResult | null;
  /** Total stake the player risked across all hands + insurance (atomic CT). */
  totalBet: bigint;
  /** Total gross returned to the player across all hands + insurance (atomic CT). */
  totalPayout: bigint;
  /** Net P&L = totalPayout - totalBet (signed; negative = player down). */
  net: bigint;
  /** Byte cursor AFTER all draws for this hand — the next hand starts here. */
  cursorAfter: number;
  /** Cards dealt count AFTER this hand (shoe-global). Route uses this for the 75% gate. */
  dealtAfter: number;
}

// ---------------------------------------------------------------------------
// Shoe construction + card values
// ---------------------------------------------------------------------------

/**
 * Build the canonical ordered 6-deck shoe. Order is deck-major →
 * suit-major → rank-major. The verifier MUST use this exact order so the
 * index→card mapping reproduces. This is the "undealt cards" list we draw
 * from without replacement.
 */
export function buildShoe(): Card[] {
  const shoe: Card[] = new Array<Card>(CARDS_PER_SHOE);
  let i = 0;
  for (let d = 0; d < SHOE_DECKS; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        shoe[i++] = { suit, rank };
      }
    }
  }
  return shoe;
}

/** Base value of a rank (Ace counted as 1 here; soft-11 handled in totals). */
export function cardBaseValue(rank: Rank): number {
  if (rank === 'A') return 1;
  if (rank === 'K' || rank === 'Q' || rank === 'J' || rank === '10') return 10;
  return Number(rank); // '2'..'9'
}

/**
 * Compute the best total of a hand with correct soft-ace demotion.
 * Counts each ace as 1, then promotes ONE ace to 11 if that keeps the
 * total ≤ 21 (only one ace can ever be 11 without busting).
 */
export function handTotal(cards: readonly Card[]): { total: number; isSoft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardBaseValue(c.rank);
    if (c.rank === 'A') aces++;
  }
  let isSoft = false;
  if (aces > 0 && total + 10 <= 21) {
    total += 10; // promote one ace 1→11
    isSoft = true;
  }
  return { total, isSoft };
}

function isBust(total: number): boolean {
  return total > 21;
}

/** A 2-card natural 21. */
function isNaturalBlackjack(cards: readonly Card[]): boolean {
  if (cards.length !== 2) return false;
  return handTotal(cards).total === 21;
}

// ---------------------------------------------------------------------------
// Deterministic shoe dealer (no-replacement draw) — exposes the post-hand
// remaining shoe so callers can thread state across hands cheaply.
// ---------------------------------------------------------------------------

class ShoeDealer {
  /** Mutable canonical-order list; [0, count) are still undealt. */
  list: Card[];
  private count: number;
  private cursor: number;
  private dealt: number;
  constructor(
    private readonly serverSeed: string,
    private readonly clientSeed: string,
    private readonly nonce: number,
    startingCursor: number,
    initialRemaining: Card[],
    dealtSoFar: number,
  ) {
    this.list = initialRemaining;
    this.count = initialRemaining.length;
    this.cursor = startingCursor;
    this.dealt = dealtSoFar;
  }

  get cursorNow(): number {
    return this.cursor;
  }
  get dealtNow(): number {
    return this.dealt;
  }
  /** Packed remaining list AFTER all draws (the dealt tail is sliced off). */
  get packedRemaining(): Card[] {
    return this.list.slice(0, this.count);
  }

  draw(): Card {
    if (this.count <= 0) {
      // Unreachable in practice: a 6-deck shoe (312) can never be exhausted
      // by a single hand before the 75% reshuffle gate fires. Fail loudly.
      throw new Error('blackjack-engine: shoe exhausted — reshuffle gate missed');
    }
    const { value: k, bytesConsumed } = sampleIntFromBytes({
      serverSeed: this.serverSeed,
      clientSeed: this.clientSeed,
      nonce: this.nonce,
      cursorStart: this.cursor,
      min: 0,
      max: this.count,
    });
    this.cursor += bytesConsumed;
    const card = this.list[k]!;
    // Swap-with-last removal keeps the remaining list packed at [0, count).
    this.list[k] = this.list[this.count - 1]!;
    this.list[this.count - 1] = card;
    this.count--;
    this.dealt++;
    return card;
  }
}

// ---------------------------------------------------------------------------
// Action scripts (player decisions are replayed, not chosen, by the engine)
// ---------------------------------------------------------------------------

/**
 * A scripted sequence of player decisions for a single hand. The route
 * accumulates these across `/action` calls and the engine replays the whole
 * script to produce the final `HandResult`. This is what makes the engine
 * PURE — the server is authoritative, but the engine never "asks" for input;
 * it consumes a recorded decision list.
 *
 * `hands[i]` is the ordered decisions for player sub-hand i. Index 0 is the
 * original hand; a split produces a second sub-hand (index 1). Each entry's
 * allowed terminal decisions: 'stand' | 'double' | 'surrender' (or a bust
 * after a 'hit'). 'split' is recorded via the `didSplit` flag (one split
 * level supported), not as a per-hand action.
 *
 * `tookInsurance` is resolved before the main hand and only honored when the
 * dealer's upcard is an Ace.
 */
export interface HandScript {
  hands: BlackjackActionType[][];
  /** True iff the player split the opening pair (single split level). */
  didSplit: boolean;
  /** True iff the player took insurance (only honored on dealer-Ace upcard). */
  tookInsurance: boolean;
}

// ---------------------------------------------------------------------------
// Core: play a single hand from a script
// ---------------------------------------------------------------------------

export interface PlayHandArgs {
  /** 64-char lowercase hex server seed (held secret until shoe close). */
  serverSeed: string;
  /** Non-empty hex client seed. */
  clientSeed: string;
  /** Per-shoe hand index (monotonic from 0). Used as the RNG nonce. */
  nonce: number;
  /** Byte offset into the stream where THIS hand's first draw begins. */
  cursor: number;
  /** Base stake on the opening hand, atomic CT. Must be > 0n. */
  bet: bigint;
  /** Player's recorded decisions for this hand. */
  script: HandScript;
  /**
   * Cards already dealt from this shoe by prior hands (0 for the first hand
   * of a fresh shoe). Required to be consistent with `remainingShoe`.
   */
  dealtBefore?: number;
  /**
   * The exact remaining-shoe state (canonical order, packed) at the start of
   * this hand. Required when `dealtBefore > 0`. When omitted a full fresh
   * shoe is built (first hand of a shoe).
   */
  remainingShoe?: Card[];
}

/** Internal richer result that also carries the post-hand remaining shoe. */
interface PlayHandInternal extends HandResult {
  remainingAfter: Card[];
}

/**
 * Play (or replay) a single hand. Deterministic.
 *
 * Deal order mirrors a real table: player card, dealer upcard, player card,
 * dealer hole card. Then insurance (if offered + taken) is resolved before
 * the player acts on the main hand. Then the player's scripted decisions
 * run. Then the dealer plays out (S17). Then outcomes + payouts settle.
 */
export function playHand(args: PlayHandArgs): HandResult {
  const { remainingAfter: _drop, ...result } = playHandInternal(args);
  void _drop;
  return result;
}

function playHandInternal(args: PlayHandArgs): PlayHandInternal {
  if (typeof args.bet !== 'bigint' || args.bet <= 0n) {
    throw new Error(`blackjack-engine: bet must be a positive bigint, got ${args.bet}`);
  }
  if (!Number.isInteger(args.nonce) || args.nonce < 0) {
    throw new Error(`blackjack-engine: nonce must be a non-negative integer, got ${args.nonce}`);
  }
  if (!Number.isInteger(args.cursor) || args.cursor < 0) {
    throw new Error(`blackjack-engine: cursor must be a non-negative integer, got ${args.cursor}`);
  }
  validateScript(args.script);

  const dealtBefore = args.dealtBefore ?? 0;
  if (dealtBefore > 0 && !args.remainingShoe) {
    throw new Error(
      'blackjack-engine: remainingShoe is required when dealtBefore > 0 (mid-shoe replay)',
    );
  }
  if (args.remainingShoe && args.remainingShoe.length !== CARDS_PER_SHOE - dealtBefore) {
    throw new Error(
      `blackjack-engine: remainingShoe length ${args.remainingShoe.length} ` +
        `!= expected ${CARDS_PER_SHOE - dealtBefore}`,
    );
  }
  // Copy — the dealer mutates the list in place.
  const remaining = args.remainingShoe ? args.remainingShoe.slice() : buildShoe();

  const dealer = new ShoeDealer(
    args.serverSeed,
    args.clientSeed,
    args.nonce,
    args.cursor,
    remaining,
    dealtBefore,
  );

  // ── Initial deal: P, D(up), P, D(hole) ────────────────────────────────
  const playerOpening: Card[] = [dealer.draw()];
  const dealerCards: Card[] = [dealer.draw()]; // upcard
  playerOpening.push(dealer.draw());
  dealerCards.push(dealer.draw()); // hole card

  const dealerUpcard = dealerCards[0]!;
  const dealerHasBlackjack = isNaturalBlackjack(dealerCards);

  // ── Insurance (resolved BEFORE the main hand) ─────────────────────────
  // Offered only when the dealer upcard is an Ace. Insurance stake = half
  // the base bet (standard). Pays 2:1 on dealer blackjack.
  //
  // ORDERING CONTRACT (defense-in-depth): `tookInsurance` is a boolean — the
  // engine CANNOT tell from it alone whether the player decided insurance
  // before or after acting on the main hand. The LOCKED rule ("insurance
  // resolved BEFORE the main hand") is therefore enforced UPSTREAM by the
  // route: the /action 'insure' handler rejects an insure once the main hand
  // has had any decision (cove-blackjack.ts — guard 2, under the hand row
  // lock). Any future caller of this engine MUST preserve that invariant; a
  // `tookInsurance=true` reaching here is trusted to have been a legal
  // before-first-action decision. The engine still gates on the Ace upcard so
  // a stray flag on a non-Ace board is silently dropped (no money effect).
  let insurance: InsuranceResult | null = null;
  if (args.script.tookInsurance && dealerUpcard.rank === 'A') {
    const insBet = args.bet / 2n; // floor — half the main stake
    const insPayout = dealerHasBlackjack
      ? insBet + (insBet * INSURANCE_PAYOUT_NUM) / INSURANCE_PAYOUT_DEN // stake back + 2:1
      : 0n;
    insurance = { bet: insBet, payout: insPayout, dealerHadBlackjack: dealerHasBlackjack };
  }

  const playerNatural = isNaturalBlackjack(playerOpening);

  // ── Naturals short-circuit the player's turn ──────────────────────────
  if (playerNatural || dealerHasBlackjack) {
    return settleNaturals({
      playerOpening,
      dealerCards,
      bet: args.bet,
      playerNatural,
      dealerHasBlackjack,
      insurance,
      cursorAfter: dealer.cursorNow,
      dealtAfter: dealer.dealtNow,
      remainingAfter: dealer.packedRemaining,
    });
  }

  // ── Build player hands from the script (handles one split level) ──────
  const playerHands: PlayingHand[] = [];
  if (args.script.didSplit) {
    if (
      playerOpening.length !== 2 ||
      cardBaseValue(playerOpening[0]!.rank) !== cardBaseValue(playerOpening[1]!.rank)
    ) {
      throw new Error('blackjack-engine: split requested but opening hand is not a value-pair');
    }
    // Each split hand gets one new card immediately, then plays its script.
    playerHands.push({
      cards: [playerOpening[0]!, dealer.draw()],
      bet: args.bet,
      isDoubled: false,
      surrendered: false,
      fromSplit: true,
    });
    playerHands.push({
      cards: [playerOpening[1]!, dealer.draw()],
      bet: args.bet,
      isDoubled: false,
      surrendered: false,
      fromSplit: true,
    });
  } else {
    playerHands.push({
      cards: playerOpening,
      bet: args.bet,
      isDoubled: false,
      surrendered: false,
      fromSplit: false,
    });
  }

  if (args.script.hands.length !== playerHands.length) {
    throw new Error(
      `blackjack-engine: script has ${args.script.hands.length} hand-action-lists ` +
        `but ${playerHands.length} player hands exist`,
    );
  }

  // ── Run each player hand's scripted decisions ─────────────────────────
  for (let h = 0; h < playerHands.length; h++) {
    runPlayerHandScript(playerHands[h]!, args.script.hands[h]!, dealer);
  }

  // ── Dealer plays out (S17) — only if at least one player hand is live ──
  const anyLive = playerHands.some((h) => !h.surrendered && !isBust(handTotal(h.cards).total));
  if (anyLive) {
    playDealer(dealerCards, dealer);
  }

  const dealerFinal = buildDealerHand(dealerCards);
  const resolved: ResolvedPlayerHand[] = playerHands.map((h) => settlePlayerHand(h, dealerFinal));

  return assembleResult(
    resolved,
    dealerFinal,
    insurance,
    dealer.cursorNow,
    dealer.dealtNow,
    dealer.packedRemaining,
  );
}

// ---------------------------------------------------------------------------
// replayHand + shoe reconstruction — the PROVABLY-FAIR contract surface
// ---------------------------------------------------------------------------

/**
 * Pure re-derivation of a hand outcome from the REVEALED seed. Thin wrapper
 * over `playHand` — identical inputs ⇒ identical `HandResult`. The disputes
 * verifier (server) and the browser verifier both call this.
 *
 * For a mid-shoe hand (`nonce > 0`) the caller MUST pass the exact
 * `remainingShoe` + `dealtBefore` at the start of the hand. When only the
 * per-hand scripts are known, use `replayShoeUpToHand` which reconstructs
 * the shoe by replaying every prior hand from nonce 0.
 */
export function replayHand(args: PlayHandArgs): HandResult {
  return playHand(args);
}

/**
 * Reconstruct a shoe up to (and including) `targetNonce` by replaying every
 * hand from nonce 0, threading the cursor + remaining-shoe state, and return
 * `targetNonce`'s result. Used by the disputes verifier for any hand where
 * `nonce > 0`.
 *
 * `scripts[i]` is the recorded `{ bet, script }` for hand i (0..targetNonce
 * inclusive). The route loads these from the shoe's persisted hand history.
 */
export function replayShoeUpToHand(args: {
  serverSeed: string;
  clientSeed: string;
  targetNonce: number;
  scripts: Array<{ bet: bigint; script: HandScript }>;
  startCursor?: number;
}): HandResult {
  if (!Number.isInteger(args.targetNonce) || args.targetNonce < 0) {
    throw new Error('blackjack-engine: targetNonce must be a non-negative integer');
  }
  if (args.scripts.length !== args.targetNonce + 1) {
    throw new Error(
      `blackjack-engine: need ${args.targetNonce + 1} scripts (hands 0..${args.targetNonce}), ` +
        `got ${args.scripts.length}`,
    );
  }

  let remaining = buildShoe();
  let cursor = args.startCursor ?? 0;
  let dealt = 0;
  let result: HandResult | null = null;

  for (let n = 0; n <= args.targetNonce; n++) {
    const { bet, script } = args.scripts[n]!;
    const internal = playHandInternal({
      serverSeed: args.serverSeed,
      clientSeed: args.clientSeed,
      nonce: n,
      cursor,
      bet,
      script,
      dealtBefore: dealt,
      remainingShoe: dealt === 0 ? undefined : remaining,
    });
    remaining = internal.remainingAfter;
    cursor = internal.cursorAfter;
    dealt = internal.dealtAfter;
    if (n === args.targetNonce) {
      const { remainingAfter: _drop, ...r } = internal;
      void _drop;
      result = r;
    }
  }

  if (!result) {
    throw new Error('blackjack-engine: replayShoeUpToHand produced no result');
  }
  return result;
}

/**
 * Advance the shoe state across one hand and return BOTH the engine result
 * and the post-hand remaining shoe (+ cursor/dealt). The route uses this to
 * thread mid-shoe state cheaply (O(prior hands)) without re-storing the shoe
 * array per hand.
 */
export function playHandWithState(args: PlayHandArgs): {
  result: HandResult;
  remainingAfter: Card[];
  cursorAfter: number;
  dealtAfter: number;
} {
  const internal = playHandInternal(args);
  const { remainingAfter, ...result } = internal;
  return {
    result,
    remainingAfter,
    cursorAfter: internal.cursorAfter,
    dealtAfter: internal.dealtAfter,
  };
}

// ---------------------------------------------------------------------------
// Internal hand-state machine
// ---------------------------------------------------------------------------

interface PlayingHand {
  cards: Card[];
  bet: bigint;
  isDoubled: boolean;
  surrendered: boolean;
  fromSplit: boolean;
}

/**
 * A split-ace sub-hand. Standard rule: split aces receive EXACTLY ONE card
 * each and may NOT hit, double, re-split, or surrender — the sub-hand is
 * auto-terminal after its single dealt card. By the time `runPlayerHandScript`
 * runs, a split sub-hand already holds `[splitCard, oneDealtCard]`, so a
 * split-ace hand here is exactly a 2-card hand whose first card is an Ace.
 */
function isSplitAceHand(hand: PlayingHand): boolean {
  return hand.fromSplit && hand.cards[0]?.rank === 'A';
}

function runPlayerHandScript(hand: PlayingHand, actions: BlackjackActionType[], dealer: ShoeDealer): void {
  // ── Split aces — one card only, then forced stand (standard rule) ────────
  // The hand already has its single dealt card. Any decision OTHER than a
  // single 'stand' (or no decision at all) is illegal: 'hit'/'double' draw a
  // forbidden extra card and inflate RTP; 'surrender'/'split' are also illegal.
  // The route blocks these, but the engine is the authoritative re-validator
  // at settle, so it throws loudly here too.
  if (isSplitAceHand(hand)) {
    for (const action of actions) {
      if (action !== 'stand') {
        throw new Error(
          `blackjack-engine: split aces receive exactly one card — '${action}' is illegal on a split-ace hand`,
        );
      }
    }
    // No further draws; the single card already dealt stands.
    return;
  }

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const isFirstDecision = i === 0;
    const total = handTotal(hand.cards).total;
    if (isBust(total)) {
      throw new Error('blackjack-engine: action recorded after bust');
    }
    switch (action) {
      case 'hit': {
        hand.cards.push(dealer.draw());
        break;
      }
      case 'stand': {
        if (i !== actions.length - 1) {
          throw new Error('blackjack-engine: stand must be the final action');
        }
        return;
      }
      case 'double': {
        if (!isFirstDecision || hand.cards.length !== 2) {
          throw new Error('blackjack-engine: double only legal as first decision on a 2-card hand');
        }
        if (i !== actions.length - 1) {
          throw new Error('blackjack-engine: double must be the final action');
        }
        hand.bet = hand.bet * 2n;
        hand.isDoubled = true;
        hand.cards.push(dealer.draw()); // exactly one card on double
        return;
      }
      case 'surrender': {
        if (!isFirstDecision || hand.cards.length !== 2 || hand.fromSplit) {
          throw new Error(
            'blackjack-engine: surrender only legal as first decision on the original 2-card hand',
          );
        }
        if (i !== actions.length - 1) {
          throw new Error('blackjack-engine: surrender must be the final action');
        }
        hand.surrendered = true;
        return;
      }
      case 'split': {
        throw new Error('blackjack-engine: split is a top-level flag, not a per-hand action');
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`blackjack-engine: unknown action ${String(_exhaustive)}`);
      }
    }
  }
}

/** Dealer hits until hard/soft 17+ — STANDS on soft 17 (S17). */
function playDealer(dealerCards: Card[], dealer: ShoeDealer): void {
  for (;;) {
    const { total } = handTotal(dealerCards);
    // S17: dealer stands on ALL 17s including soft 17.
    if (total >= 17) return;
    dealerCards.push(dealer.draw());
    if (isBust(handTotal(dealerCards).total)) return;
  }
}

function buildDealerHand(cards: Card[]): DealerHand {
  const { total, isSoft } = handTotal(cards);
  return {
    cards,
    total,
    isSoft,
    isBust: isBust(total),
    isBlackjack: isNaturalBlackjack(cards),
  };
}

function settlePlayerHand(hand: PlayingHand, dealer: DealerHand): ResolvedPlayerHand {
  const { total, isSoft } = handTotal(hand.cards);
  const bust = isBust(total);
  const naturalBJ = !hand.fromSplit && isNaturalBlackjack(hand.cards);

  let outcome: HandOutcome;
  let payout: bigint;

  if (hand.surrendered) {
    outcome = 'surrender';
    payout = hand.bet / 2n; // half the stake returned
  } else if (bust) {
    outcome = 'loss';
    payout = 0n;
  } else if (naturalBJ) {
    // By the time we reach here the dealer did NOT have a natural (that path
    // short-circuits in settleNaturals). Player natural pays 3:2.
    outcome = 'blackjack';
    payout = hand.bet + (hand.bet * BLACKJACK_PAYOUT_NUM) / BLACKJACK_PAYOUT_DEN;
  } else if (dealer.isBust) {
    outcome = 'win';
    payout = hand.bet * 2n; // stake + 1:1
  } else if (total > dealer.total) {
    outcome = 'win';
    payout = hand.bet * 2n;
  } else if (total < dealer.total) {
    outcome = 'loss';
    payout = 0n;
  } else {
    outcome = 'push';
    payout = hand.bet; // stake returned
  }

  return {
    cards: hand.cards,
    total,
    isSoft,
    isBust: bust,
    isBlackjack: naturalBJ,
    isDoubled: hand.isDoubled,
    bet: hand.bet,
    outcome,
    payout,
  };
}

function settleNaturals(p: {
  playerOpening: Card[];
  dealerCards: Card[];
  bet: bigint;
  playerNatural: boolean;
  dealerHasBlackjack: boolean;
  insurance: InsuranceResult | null;
  cursorAfter: number;
  dealtAfter: number;
  remainingAfter: Card[];
}): PlayHandInternal {
  const dealerFinal = buildDealerHand(p.dealerCards);
  const { total, isSoft } = handTotal(p.playerOpening);

  let outcome: HandOutcome;
  let payout: bigint;
  if (p.playerNatural && p.dealerHasBlackjack) {
    outcome = 'push';
    payout = p.bet;
  } else if (p.playerNatural) {
    outcome = 'blackjack';
    payout = p.bet + (p.bet * BLACKJACK_PAYOUT_NUM) / BLACKJACK_PAYOUT_DEN;
  } else {
    // Dealer natural, player not — player loses the main bet.
    outcome = 'loss';
    payout = 0n;
  }

  const resolved: ResolvedPlayerHand = {
    cards: p.playerOpening,
    total,
    isSoft,
    isBust: false,
    isBlackjack: p.playerNatural,
    isDoubled: false,
    bet: p.bet,
    outcome,
    payout,
  };

  return assembleResult(
    [resolved],
    dealerFinal,
    p.insurance,
    p.cursorAfter,
    p.dealtAfter,
    p.remainingAfter,
  );
}

function assembleResult(
  resolved: ResolvedPlayerHand[],
  dealer: DealerHand,
  insurance: InsuranceResult | null,
  cursorAfter: number,
  dealtAfter: number,
  remainingAfter: Card[],
): PlayHandInternal {
  let totalBet = 0n;
  let totalPayout = 0n;
  for (const h of resolved) {
    totalBet += h.bet;
    totalPayout += h.payout;
  }
  if (insurance) {
    totalBet += insurance.bet;
    totalPayout += insurance.payout;
  }
  return {
    playerHands: resolved,
    dealer,
    insurance,
    totalBet,
    totalPayout,
    net: totalPayout - totalBet,
    cursorAfter,
    dealtAfter,
    remainingAfter,
  };
}

// ---------------------------------------------------------------------------
// Script validation
// ---------------------------------------------------------------------------

function validateScript(script: HandScript): void {
  if (!script || !Array.isArray(script.hands)) {
    throw new Error('blackjack-engine: script.hands must be an array');
  }
  if (typeof script.didSplit !== 'boolean' || typeof script.tookInsurance !== 'boolean') {
    throw new Error('blackjack-engine: script.didSplit / tookInsurance must be booleans');
  }
  const expectedHands = script.didSplit ? 2 : 1;
  if (script.hands.length !== expectedHands) {
    throw new Error(
      `blackjack-engine: script.hands length ${script.hands.length} != expected ${expectedHands} (didSplit=${script.didSplit})`,
    );
  }
  for (const list of script.hands) {
    if (!Array.isArray(list)) {
      throw new Error('blackjack-engine: each script.hands entry must be an array of actions');
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization for cove_game_events.outcomeJson
// ---------------------------------------------------------------------------

/**
 * Stringify a HandResult for the `cove_game_events.outcomeJson` column.
 * Bigints become decimal strings (matching the slots convention). The
 * `kind: 'blackjack'` discriminator routes the cross-game verifier.
 */
export interface SerializedHandResult {
  kind: 'blackjack';
  playerHands: Array<{
    cards: Card[];
    total: number;
    isSoft: boolean;
    isBust: boolean;
    isBlackjack: boolean;
    isDoubled: boolean;
    bet: string;
    outcome: HandOutcome;
    payout: string;
  }>;
  dealer: DealerHand;
  insurance: { bet: string; payout: string; dealerHadBlackjack: boolean } | null;
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

export function serializeHandResult(
  result: HandResult,
  meta: { cursorBefore: number; dealtBefore: number; nonce: number },
): SerializedHandResult {
  return {
    kind: 'blackjack',
    playerHands: result.playerHands.map((h) => ({
      cards: h.cards,
      total: h.total,
      isSoft: h.isSoft,
      isBust: h.isBust,
      isBlackjack: h.isBlackjack,
      isDoubled: h.isDoubled,
      bet: h.bet.toString(),
      outcome: h.outcome,
      payout: h.payout.toString(),
    })),
    dealer: result.dealer,
    insurance: result.insurance
      ? {
          bet: result.insurance.bet.toString(),
          payout: result.insurance.payout.toString(),
          dealerHadBlackjack: result.insurance.dealerHadBlackjack,
        }
      : null,
    totalBet: result.totalBet.toString(),
    totalPayout: result.totalPayout.toString(),
    net: result.net.toString(),
    cursorBefore: meta.cursorBefore,
    cursorAfter: result.cursorAfter,
    dealtBefore: meta.dealtBefore,
    dealtAfter: result.dealtAfter,
    nonce: meta.nonce,
    engineVersion: BLACKJACK_ENGINE_VERSION,
  };
}

/** Re-export the commit hash helper so the route commits the seed identically to slots. */
export { sha256Hex };
