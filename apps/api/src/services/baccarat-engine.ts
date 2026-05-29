/**
 * Phase 6.6.1 — Baccarat (Punto Banco) engine (pure, deterministic, provably-fair).
 *
 * Built on top of `provable-rng.ts` (the same commit-reveal HMAC-SHA256 byte
 * stream that drives slot-engine.ts, blackjack-engine.ts, holdem-engine.ts).
 * Every card dealt is a deterministic function of (serverSeed, clientSeed,
 * nonce=coupIndex, cursor) so the disputes verifier / browser verifier can
 * replay any coup from the revealed seed via the exported pure `replayCoup`.
 *
 * ── Why baccarat is SIMPLER than blackjack ───────────────────────────────────
 *
 * Punto Banco has NO player decisions. After the bet is placed, the drawing of
 * cards (Player + Banker tableau) is FULLY determined by the standard fixed
 * rules. So unlike blackjack there is no per-coup decision script — the engine
 * deals + resolves the whole coup from (seed, coupIndex, cursor) + the bet. The
 * route records only WHICH bet the player placed (PLAYER / BANKER / TIE) + the
 * stake; the engine derives every card and the winner.
 *
 * ── Locked rules (Phase 6.6.1 spec) ──────────────────────────────────────────
 *   • 8-deck shoe (416 cards), reshuffle at ~75% penetration = a NEW shoe with a
 *     fresh seed pair (mirror blackjack). Reshuffle handled OUTSIDE the engine:
 *     each shoe is its OWN commit-reveal session; the route opens a new session
 *     when penetration crosses 75%. The engine exposes SHOE_DECKS,
 *     CARDS_PER_SHOE, RESHUFFLE_CARD_THRESHOLD so the route can decide when to
 *     roll, but the engine NEVER reshuffles mid-coup (would break replay).
 *   • One bet per coup: PLAYER, BANKER, or TIE. Stake bounds (5–500) enforced by
 *     the route's Zod schema, not the engine — the engine validates stake > 0n.
 *   • Card values: A=1, 2-9 face value, 10/J/Q/K=0. Hand total = sum mod 10.
 *   • Deal: 2 cards each to Player + Banker (P, B, P, B order).
 *   • NATURAL: if Player or Banker totals 8 or 9 on the first two cards, the
 *     coup ends immediately (no third cards).
 *   • THIRD-CARD TABLEAU (standard, implemented EXACTLY):
 *       - PLAYER: stands on 6-7, draws a third card on 0-5 (only if no natural).
 *       - BANKER (if Player DREW a third card): the standard banker tableau —
 *           banker total 0-2 → always draws;
 *           3 → draws unless player 3rd card is 8;
 *           4 → draws if player 3rd card is 2-7;
 *           5 → draws if player 3rd card is 4-7;
 *           6 → draws if player 3rd card is 6-7;
 *           7 → stands.
 *       - BANKER (if Player did NOT draw): draws on 0-5, stands on 6-7.
 *   • PAYOUTS (integer math, house-friendly rounding):
 *       - PLAYER win: 1:1 → gross = stake * 2 (stake back + 1:1 winnings).
 *       - BANKER win: 1:1 minus 5% commission → net 0.95:1; the commission is
 *         FLOORED so the house keeps fractional cents. winnings = stake -
 *         floor(stake * 5 / 100); gross = stake + winnings.
 *       - TIE bet win: 8:1 → gross = stake * 9 (stake back + 8:1 winnings).
 *       - On a TIE, PLAYER and BANKER bets PUSH: stake is returned (gross =
 *         stake); only the TIE bet wins.
 *       - Any losing bet: gross = 0 (stake lost).
 *
 * ── Card draw model (provably-fair, no-replacement) ──────────────────────────
 *
 * Identical to blackjack-engine: the shoe is a fixed, KNOWN multiset (8 copies
 * of each (suit, rank)). We draw WITHOUT replacement by treating the shoe as an
 * ordered list and pulling the k-th still-undealt card, where
 *
 *     k = sampleIntFromBytes(min=0, max=remainingCount)
 *
 * advancing the cursor by the sampler's `bytesConsumed`. The canonical shoe
 * order from `buildShoe()` (deck-major → suit-major → rank-major) is what the
 * verifier reconstructs. The cursor passed to `playCoup` / `replayCoup` is the
 * BYTE OFFSET into the (serverSeed, clientSeed, nonce) stream at which THIS
 * coup's first draw begins; the engine returns `cursorAfter` so the next coup
 * continues the stream without gaps or overlaps — the same cursor-bookkeeping
 * contract as blackjack.
 *
 * Pure. No I/O, no time, no global state. Same inputs ⇒ byte-identical
 * `CoupResult`. Throws on invalid inputs.
 */

import { sampleIntFromBytes, sha256Hex } from './provable-rng';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Decks in a baccarat shoe. */
export const SHOE_DECKS = 8;

/** Cards in an 8-deck shoe. */
export const CARDS_PER_SHOE = SHOE_DECKS * 52; // 416

/**
 * Reshuffle penetration — reshuffle once ~75% of the shoe has been dealt. The
 * route compares `dealtCount >= RESHUFFLE_CARD_THRESHOLD` AT COUP BOUNDARIES
 * (never mid-coup) to decide whether the NEXT coup needs a fresh shoe/session.
 * 75% of 416 = 312.
 */
export const RESHUFFLE_PENETRATION = 0.75;
export const RESHUFFLE_CARD_THRESHOLD = Math.floor(CARDS_PER_SHOE * RESHUFFLE_PENETRATION); // 312

/** Banker commission, percent (5%), floored at settle (house-friendly). */
export const BANKER_COMMISSION_PERCENT = 5n;

/** Tie payout (8:1). Tie WIN gross = stake * (TIE_PAYOUT_NUM + 1). */
export const TIE_PAYOUT_NUM = 8n;

/** Engine version pin for the cove_game_events row (mirrors slot/bj/holdem). */
export const BACCARAT_ENGINE_VERSION = 'bac-v1';

/** Canonical suit + rank order — the verifier must reconstruct the shoe in THIS order. */
export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const RANKS = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];

/** The three legal bets in Punto Banco. */
export type BaccaratBet = 'player' | 'banker' | 'tie';

/** Coup outcome (who won the coup, independent of the player's bet). */
export type CoupWinner = 'player' | 'banker' | 'tie';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Card {
  suit: Suit;
  rank: Rank;
}

/** A resolved hand (Player or Banker side) in a coup. */
export interface BaccaratHand {
  cards: Card[];
  /** Final total (sum of card values mod 10). */
  total: number;
  /** True iff this hand was a two-card natural (8 or 9). */
  isNatural: boolean;
}

/**
 * The full record of a played coup. This is what the route serializes into
 * `cove_game_events.outcomeJson` (after `serializeCoupResult`) and what
 * `replayCoup` re-derives byte-for-byte from the revealed seed.
 */
export interface CoupResult {
  /** The bet the player placed this coup. */
  bet: BaccaratBet;
  /** Stake risked, atomic CT. */
  stake: bigint;
  player: BaccaratHand;
  banker: BaccaratHand;
  /** Who won the coup (player / banker / tie). */
  winner: CoupWinner;
  /**
   * Gross amount returned to the player for this coup, atomic CT.
   *   - bet wins:      stake + winnings (banker win nets the floored 5% commission).
   *   - tie + P/B bet: stake (PUSH).
   *   - bet loses:     0.
   */
  payout: bigint;
  /** Net P&L = payout - stake (signed; negative = player down). */
  net: bigint;
  /** Banker commission deducted (atomic CT). 0 unless the player WON a BANKER bet. */
  commission: bigint;
  /** Byte cursor AFTER all draws for this coup — the next coup starts here. */
  cursorAfter: number;
  /** Cards dealt count AFTER this coup (shoe-global). Route uses this for the 75% gate. */
  dealtAfter: number;
}

// ---------------------------------------------------------------------------
// Shoe construction + card values
// ---------------------------------------------------------------------------

/**
 * Build the canonical ordered 8-deck shoe. Order is deck-major → suit-major →
 * rank-major. The verifier MUST use this exact order so the index→card mapping
 * reproduces. This is the "undealt cards" list we draw from without replacement.
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

/** Baccarat card value: A=1, 2-9 face, 10/J/Q/K=0. */
export function cardValue(rank: Rank): number {
  if (rank === 'A') return 1;
  if (rank === '10' || rank === 'J' || rank === 'Q' || rank === 'K') return 0;
  return Number(rank); // '2'..'9'
}

/** Baccarat hand total = sum of card values mod 10. */
export function handTotal(cards: readonly Card[]): number {
  let sum = 0;
  for (const c of cards) sum += cardValue(c.rank);
  return sum % 10;
}

// ---------------------------------------------------------------------------
// Deterministic shoe dealer (no-replacement draw) — exposes the post-coup
// remaining shoe so callers can thread state across coups cheaply.
// (Identical mechanics to blackjack-engine's ShoeDealer.)
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
      // Unreachable in practice: an 8-deck shoe (416) can never be exhausted by
      // a single coup (≤6 cards) before the 75% reshuffle gate fires. Fail loud.
      throw new Error('baccarat-engine: shoe exhausted — reshuffle gate missed');
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
// Third-card tableau (the fixed standard Punto Banco drawing rules)
// ---------------------------------------------------------------------------

/**
 * Whether the Banker draws a third card, GIVEN the Banker's two-card total and
 * the Player's third card (or `null` if the Player did NOT draw). Pure — this is
 * the canonical standard banker tableau, exposed for unit testing every cell.
 *
 *   Player did NOT draw → banker draws on 0-5, stands on 6-7.
 *   Player DID draw (playerThirdValue is the 0-9 baccarat VALUE of the card):
 *     banker 0-2 → always draw;
 *     3 → draw unless player 3rd is 8;
 *     4 → draw if player 3rd in 2-7;
 *     5 → draw if player 3rd in 4-7;
 *     6 → draw if player 3rd in 6-7;
 *     7 → stand.
 */
export function bankerDraws(bankerTotal: number, playerThirdValue: number | null): boolean {
  if (bankerTotal >= 7) return false; // 7 stands (8/9 are naturals, handled upstream)
  if (playerThirdValue === null) {
    // Player stood — banker plays like the player rule: draw on 0-5.
    return bankerTotal <= 5;
  }
  switch (bankerTotal) {
    case 0:
    case 1:
    case 2:
      return true;
    case 3:
      return playerThirdValue !== 8;
    case 4:
      return playerThirdValue >= 2 && playerThirdValue <= 7;
    case 5:
      return playerThirdValue >= 4 && playerThirdValue <= 7;
    case 6:
      return playerThirdValue >= 6 && playerThirdValue <= 7;
    default:
      // bankerTotal must be 0..6 here (7+ returned above); defensive.
      return false;
  }
}

// ---------------------------------------------------------------------------
// Core: play a single coup
// ---------------------------------------------------------------------------

export interface PlayCoupArgs {
  /** 64-char lowercase hex server seed (held secret until shoe close). */
  serverSeed: string;
  /** Non-empty hex client seed. */
  clientSeed: string;
  /** Per-shoe coup index (monotonic from 0). Used as the RNG nonce. */
  nonce: number;
  /** Byte offset into the stream where THIS coup's first draw begins. */
  cursor: number;
  /** The player's bet this coup. */
  bet: BaccaratBet;
  /** Stake risked, atomic CT. Must be > 0n. */
  stake: bigint;
  /**
   * Cards already dealt from this shoe by prior coups (0 for the first coup of a
   * fresh shoe). Required to be consistent with `remainingShoe`.
   */
  dealtBefore?: number;
  /**
   * The exact remaining-shoe state (canonical order, packed) at the start of
   * this coup. Required when `dealtBefore > 0`. When omitted a full fresh shoe
   * is built (first coup of a shoe).
   */
  remainingShoe?: Card[];
}

/** Internal richer result that also carries the post-coup remaining shoe. */
interface PlayCoupInternal extends CoupResult {
  remainingAfter: Card[];
}

/**
 * Play (or replay) a single coup. Deterministic.
 *
 * Deal order mirrors a real table: Player card, Banker card, Player card,
 * Banker card. Then naturals short-circuit; otherwise the fixed third-card
 * tableau runs (Player first, then Banker). Then the winner + payout settle.
 */
export function playCoup(args: PlayCoupArgs): CoupResult {
  const { remainingAfter: _drop, ...result } = playCoupInternal(args);
  void _drop;
  return result;
}

function playCoupInternal(args: PlayCoupArgs): PlayCoupInternal {
  if (typeof args.stake !== 'bigint' || args.stake <= 0n) {
    throw new Error(`baccarat-engine: stake must be a positive bigint, got ${args.stake}`);
  }
  if (args.bet !== 'player' && args.bet !== 'banker' && args.bet !== 'tie') {
    throw new Error(`baccarat-engine: bet must be 'player' | 'banker' | 'tie', got ${String(args.bet)}`);
  }
  if (!Number.isInteger(args.nonce) || args.nonce < 0) {
    throw new Error(`baccarat-engine: nonce must be a non-negative integer, got ${args.nonce}`);
  }
  if (!Number.isInteger(args.cursor) || args.cursor < 0) {
    throw new Error(`baccarat-engine: cursor must be a non-negative integer, got ${args.cursor}`);
  }

  const dealtBefore = args.dealtBefore ?? 0;
  if (dealtBefore > 0 && !args.remainingShoe) {
    throw new Error(
      'baccarat-engine: remainingShoe is required when dealtBefore > 0 (mid-shoe replay)',
    );
  }
  if (args.remainingShoe && args.remainingShoe.length !== CARDS_PER_SHOE - dealtBefore) {
    throw new Error(
      `baccarat-engine: remainingShoe length ${args.remainingShoe.length} ` +
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

  // ── Initial deal: P, B, P, B ───────────────────────────────────────────────
  const playerCards: Card[] = [];
  const bankerCards: Card[] = [];
  playerCards.push(dealer.draw());
  bankerCards.push(dealer.draw());
  playerCards.push(dealer.draw());
  bankerCards.push(dealer.draw());

  let playerTotal = handTotal(playerCards);
  let bankerTotal = handTotal(bankerCards);
  const playerNatural = playerTotal === 8 || playerTotal === 9;
  const bankerNatural = bankerTotal === 8 || bankerTotal === 9;

  // ── Third-card tableau (skipped entirely on any natural) ────────────────────
  if (!playerNatural && !bankerNatural) {
    let playerThirdValue: number | null = null;
    // Player rule: stands on 6-7, draws on 0-5.
    if (playerTotal <= 5) {
      const third = dealer.draw();
      playerCards.push(third);
      playerThirdValue = cardValue(third.rank);
      playerTotal = handTotal(playerCards);
    }
    // Banker rule depends on banker total + (player third value | null).
    if (bankerDraws(bankerTotal, playerThirdValue)) {
      bankerCards.push(dealer.draw());
      bankerTotal = handTotal(bankerCards);
    }
  }

  const player: BaccaratHand = {
    cards: playerCards,
    total: playerTotal,
    isNatural: playerNatural,
  };
  const banker: BaccaratHand = {
    cards: bankerCards,
    total: bankerTotal,
    isNatural: bankerNatural,
  };

  // ── Determine winner ────────────────────────────────────────────────────────
  let winner: CoupWinner;
  if (playerTotal > bankerTotal) winner = 'player';
  else if (bankerTotal > playerTotal) winner = 'banker';
  else winner = 'tie';

  // ── Settle the player's bet ─────────────────────────────────────────────────
  const { payout, commission } = settleBet(args.bet, args.stake, winner);

  return {
    bet: args.bet,
    stake: args.stake,
    player,
    banker,
    winner,
    payout,
    net: payout - args.stake,
    commission,
    cursorAfter: dealer.cursorNow,
    dealtAfter: dealer.dealtNow,
    remainingAfter: dealer.packedRemaining,
  };
}

/**
 * Compute the gross payout + banker commission for a settled coup. Integer math,
 * house-friendly rounding (commission floored). Pure — exported indirectly via
 * playCoup; broken out so the unit tests can assert every payout cell.
 *
 *   PLAYER bet:
 *     winner=player → 1:1 → gross = stake * 2; commission 0.
 *     winner=tie    → PUSH → gross = stake; commission 0.
 *     winner=banker → loss → gross = 0; commission 0.
 *   BANKER bet:
 *     winner=banker → 1:1 minus floored 5% commission →
 *                     commission = floor(stake * 5 / 100);
 *                     winnings = stake - commission; gross = stake + winnings.
 *     winner=tie    → PUSH → gross = stake; commission 0.
 *     winner=player → loss → gross = 0; commission 0.
 *   TIE bet:
 *     winner=tie    → 8:1 → gross = stake * 9; commission 0.
 *     winner≠tie    → loss → gross = 0; commission 0.
 */
export function settleBet(
  bet: BaccaratBet,
  stake: bigint,
  winner: CoupWinner,
): { payout: bigint; commission: bigint } {
  if (bet === 'player') {
    if (winner === 'player') return { payout: stake * 2n, commission: 0n };
    if (winner === 'tie') return { payout: stake, commission: 0n }; // push
    return { payout: 0n, commission: 0n }; // banker won → loss
  }
  if (bet === 'banker') {
    if (winner === 'banker') {
      const commission = (stake * BANKER_COMMISSION_PERCENT) / 100n; // floored
      const winnings = stake - commission; // net 0.95:1
      return { payout: stake + winnings, commission };
    }
    if (winner === 'tie') return { payout: stake, commission: 0n }; // push
    return { payout: 0n, commission: 0n }; // player won → loss
  }
  // tie bet
  if (winner === 'tie') return { payout: stake * (TIE_PAYOUT_NUM + 1n), commission: 0n };
  return { payout: 0n, commission: 0n }; // P/B won → tie bet loses
}

// ---------------------------------------------------------------------------
// replayCoup + shoe reconstruction — the PROVABLY-FAIR contract surface
// ---------------------------------------------------------------------------

/**
 * Pure re-derivation of a coup outcome from the REVEALED seed. Thin wrapper over
 * `playCoup` — identical inputs ⇒ identical `CoupResult`. The disputes verifier
 * (server) and the browser verifier both call this.
 *
 * For a mid-shoe coup (`nonce > 0`) the caller MUST pass the exact
 * `remainingShoe` + `dealtBefore` at the start of the coup. When only the
 * per-coup bets are known, use `replayShoeUpToCoup` which reconstructs the shoe
 * by replaying every prior coup from nonce 0.
 */
export function replayCoup(args: PlayCoupArgs): CoupResult {
  return playCoup(args);
}

/**
 * Advance the shoe state across one coup and return BOTH the engine result and
 * the post-coup remaining shoe (+ cursor/dealt). The route uses this to thread
 * mid-shoe state cheaply (O(prior coups)) without re-storing the shoe array per
 * coup. Mirrors blackjack-engine.playHandWithState.
 */
export function playCoupWithState(args: PlayCoupArgs): {
  result: CoupResult;
  remainingAfter: Card[];
  cursorAfter: number;
  dealtAfter: number;
} {
  const internal = playCoupInternal(args);
  const { remainingAfter, ...result } = internal;
  return {
    result,
    remainingAfter,
    cursorAfter: internal.cursorAfter,
    dealtAfter: internal.dealtAfter,
  };
}

/**
 * Reconstruct a shoe up to (and including) `targetNonce` by replaying every coup
 * from nonce 0, threading the cursor + remaining-shoe state, and return
 * `targetNonce`'s result. Used by the disputes verifier for any coup where
 * `nonce > 0`.
 *
 * `coups[i]` is the recorded `{ bet, stake }` for coup i (0..targetNonce
 * inclusive). The route loads these from the shoe's persisted coup history.
 */
export function replayShoeUpToCoup(args: {
  serverSeed: string;
  clientSeed: string;
  targetNonce: number;
  coups: Array<{ bet: BaccaratBet; stake: bigint }>;
  startCursor?: number;
}): CoupResult {
  if (!Number.isInteger(args.targetNonce) || args.targetNonce < 0) {
    throw new Error('baccarat-engine: targetNonce must be a non-negative integer');
  }
  if (args.coups.length !== args.targetNonce + 1) {
    throw new Error(
      `baccarat-engine: need ${args.targetNonce + 1} coups (0..${args.targetNonce}), ` +
        `got ${args.coups.length}`,
    );
  }

  let remaining = buildShoe();
  let cursor = args.startCursor ?? 0;
  let dealt = 0;
  let result: CoupResult | null = null;

  for (let n = 0; n <= args.targetNonce; n++) {
    const { bet, stake } = args.coups[n]!;
    const internal = playCoupInternal({
      serverSeed: args.serverSeed,
      clientSeed: args.clientSeed,
      nonce: n,
      cursor,
      bet,
      stake,
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
    throw new Error('baccarat-engine: replayShoeUpToCoup produced no result');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Serialization for cove_game_events.outcomeJson
// ---------------------------------------------------------------------------

/**
 * Stringify a CoupResult for the `cove_game_events.outcomeJson` column. Bigints
 * become decimal strings (matching the slots/blackjack/holdem convention). The
 * `kind: 'baccarat'` discriminator routes the cross-game verifier.
 */
export interface SerializedCoupResult {
  kind: 'baccarat';
  bet: BaccaratBet;
  stake: string;
  player: {
    cards: Card[];
    total: number;
    isNatural: boolean;
  };
  banker: {
    cards: Card[];
    total: number;
    isNatural: boolean;
  };
  winner: CoupWinner;
  payout: string;
  net: string;
  commission: string;
  cursorBefore: number;
  cursorAfter: number;
  dealtBefore: number;
  dealtAfter: number;
  nonce: number;
  engineVersion: string;
}

export function serializeCoupResult(
  result: CoupResult,
  meta: { cursorBefore: number; dealtBefore: number; nonce: number },
): SerializedCoupResult {
  return {
    kind: 'baccarat',
    bet: result.bet,
    stake: result.stake.toString(),
    player: {
      cards: result.player.cards,
      total: result.player.total,
      isNatural: result.player.isNatural,
    },
    banker: {
      cards: result.banker.cards,
      total: result.banker.total,
      isNatural: result.banker.isNatural,
    },
    winner: result.winner,
    payout: result.payout.toString(),
    net: result.net.toString(),
    commission: result.commission.toString(),
    cursorBefore: meta.cursorBefore,
    cursorAfter: result.cursorAfter,
    dealtBefore: meta.dealtBefore,
    dealtAfter: result.dealtAfter,
    nonce: meta.nonce,
    engineVersion: BACCARAT_ENGINE_VERSION,
  };
}

/** Re-export the commit hash helper so the route commits the seed identically. */
export { sha256Hex };
