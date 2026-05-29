/**
 * Phase 6 economy-fix sizing — Blackjack house-edge Monte Carlo (sims only).
 *
 * Drives the AS-BUILT `playHandWithState` from
 * `apps/api/src/services/blackjack-engine.ts` with a CORRECT, flat-bet
 * BASIC-STRATEGY player and reports the real house edge:
 *
 *     house edge = (total bet − total payout) / total bet
 *
 * over a threaded 6-deck shoe (reshuffle at the 75% gate with a fresh seed).
 * NO card counting — flat bets, decisions depend ONLY on the player's own
 * cards + the dealer upcard (textbook basic strategy). Counting EV is a
 * separate future concern; this is the flat baseline that sizes the rake.
 *
 * Expected result for these rules (6-deck, S17, DAS, late surrender, no
 * resplit, no hit-split-aces, BJ 3:2): house edge ≈ +0.40% … +0.55%. A correct
 * chart is load-bearing — a wrong cell silently shifts the edge — so the chart
 * below is the canonical 6-deck/S17 chart and each block cites its source rows
 * (Wizard of Odds "4/6/8 decks, dealer stands on soft 17" basic-strategy chart,
 * https://wizardofodds.com/games/blackjack/strategy/4-decks/).
 *
 * ── Engine action surface (drives which chart variant is legal) ──────────────
 *   • hit / stand / double / split (single level) / surrender (late).
 *   • DOUBLE: legal as the first decision on ANY 2-card hand (incl. hands from a
 *     split → DAS = YES), but NOT on a split-ace sub-hand.
 *   • SPLIT: one level only (didSplit flag → 2 hands). No resplit.
 *   • SPLIT ACES: exactly one card each, no further action (engine throws on a
 *     hit/double of a split ace) → "no hit split aces".
 *   • SURRENDER: only the ORIGINAL 2-card hand, first decision (late surrender;
 *     dealer-natural already short-circuits to a loss before the player acts).
 *   • INSURANCE: never taken by basic strategy (−EV without a count) → false.
 *
 * ── How the script is built (engine takes a recorded script, not callbacks) ──
 * The engine consumes a full `HandScript`. We build it deterministically by
 * peeking: a stand-only replay of the SAME (seed, nonce, cursor, shoe) reveals
 * the opening two player cards + the dealer upcard. From those we pick split /
 * surrender / double / hit-or-stand via the chart. For a hit sequence we append
 * 'hit', re-run, read the freshly-drawn card from the result, and re-decide —
 * every intermediate replay uses the identical shoe state, so the cards are
 * stable and the final script reproduces byte-for-byte. (This is exactly how
 * the engine's own unit tests peek the opening pair before splitting.)
 *
 * ── Seeding (per CLAUDE.md sims rule) ────────────────────────────────────────
 * A FRESH 32-byte serverSeed (crypto.randomBytes via createServerSeed) per shoe;
 * the engine's card draws come ONLY from the HMAC stream. Hands within a shoe are
 * threaded no-replacement via playHandWithState until the 75% gate, then a fresh
 * shoe (fresh seed) — mirroring a real session.
 *
 * Does NOT modify any engine or route. Sims only.
 *
 * CLI:
 *   bun scripts/casino/edge-sim-blackjack.ts [--hands 200000] [--bet 100] [--client-seed deadbeef]
 */

import { performance } from 'node:perf_hooks';

import {
  playHand,
  playHandWithState,
  handTotal,
  cardBaseValue,
  RESHUFFLE_CARD_THRESHOLD,
  type HandScript,
  type Card,
  type Rank,
  type BlackjackActionType,
} from '../../apps/api/src/services/blackjack-engine';
import { createServerSeed } from '../../apps/api/src/services/provable-rng';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  hands: number;
  bet: bigint;
  clientSeed: string;
}

function parseCli(argv: readonly string[]): Cli {
  const cli: Cli = { hands: 200_000, bet: 100n, clientSeed: 'deadbeef' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--hands') {
      const v = argv[++i];
      if (!v) throw new Error('--hands requires a value');
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--hands must be a positive integer, got ${v}`);
      cli.hands = n;
    } else if (a === '--bet') {
      const v = argv[++i];
      if (!v) throw new Error('--bet requires a value');
      const n = BigInt(v);
      if (n <= 0n) throw new Error(`--bet must be > 0, got ${v}`);
      cli.bet = n;
    } else if (a === '--client-seed') {
      const v = argv[++i];
      if (!v) throw new Error('--client-seed requires a value');
      cli.clientSeed = v;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: bun scripts/casino/edge-sim-blackjack.ts [--hands 200000] [--bet 100] [--client-seed deadbeef]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return cli;
}

// ---------------------------------------------------------------------------
// Basic strategy chart — 6-deck, dealer STANDS on soft 17 (S17), DAS, late
// surrender. Source: Wizard of Odds "4/6/8 decks, dealer stands on soft 17".
// Dealer upcard value 'd' is 2..11 (Ace = 11).
// ---------------------------------------------------------------------------

type Decision = 'H' | 'S' | 'D' | 'Ds' | 'P' | 'R';
// H=hit, S=stand, D=double else hit, Ds=double else stand, P=split, R=surrender else hit.

/** Dealer upcard value used by the chart: A=11, T/J/Q/K=10, else face. */
function dealerChartValue(rank: Rank): number {
  if (rank === 'A') return 11;
  return cardBaseValue(rank); // 10 for T/J/Q/K, face for 2..9
}

/**
 * PAIRS chart (key = the pair's single-card value, A=11, T=10). Index by dealer
 * upcard value 2..11. Source: WoO pairs row (6-deck S17, DAS).
 *   A,A → split always; T,T → never split; 9,9 → split vs 2-9 except 7;
 *   8,8 → split always; 7,7 → split 2-7; 6,6 → split 2-6 (DAS adds 2);
 *   5,5 → never split (treat as hard 10); 4,4 → split 5-6 (DAS); 3,3/2,2 → split 2-7 (DAS).
 */
const PAIRS: Record<number, Partial<Record<number, 'P' | 'no'>>> = {
  11: { 2: 'P', 3: 'P', 4: 'P', 5: 'P', 6: 'P', 7: 'P', 8: 'P', 9: 'P', 10: 'P', 11: 'P' }, // A,A
  10: {}, // T,T → never split (all 'no')
  9: { 2: 'P', 3: 'P', 4: 'P', 5: 'P', 6: 'P', 7: 'no', 8: 'P', 9: 'P', 10: 'no', 11: 'no' },
  8: { 2: 'P', 3: 'P', 4: 'P', 5: 'P', 6: 'P', 7: 'P', 8: 'P', 9: 'P', 10: 'P', 11: 'P' },
  7: { 2: 'P', 3: 'P', 4: 'P', 5: 'P', 6: 'P', 7: 'P' },
  6: { 2: 'P', 3: 'P', 4: 'P', 5: 'P', 6: 'P' }, // DAS: 2-6
  5: {}, // never split — play as hard 10
  4: { 5: 'P', 6: 'P' }, // DAS: 5-6
  3: { 2: 'P', 3: 'P', 4: 'P', 5: 'P', 6: 'P', 7: 'P' }, // DAS: 2-7
  2: { 2: 'P', 3: 'P', 4: 'P', 5: 'P', 6: 'P', 7: 'P' }, // DAS: 2-7
};

/**
 * SOFT totals chart (Ace counted as 11). Key = soft total 13..21 (A2..A9, A,T+ is
 * a natural handled elsewhere). Index by dealer upcard 2..11.
 * Source: WoO soft-hands row (6-deck S17).
 */
const SOFT: Record<number, Partial<Record<number, Decision>>> = {
  // A,9 = soft 20 → always stand.
  20: { 2: 'S', 3: 'S', 4: 'S', 5: 'S', 6: 'S', 7: 'S', 8: 'S', 9: 'S', 10: 'S', 11: 'S' },
  // A,8 = soft 19 → stand (S17: double vs 6 is the ONLY exception → Ds vs 6).
  19: { 2: 'S', 3: 'S', 4: 'S', 5: 'S', 6: 'Ds', 7: 'S', 8: 'S', 9: 'S', 10: 'S', 11: 'S' },
  // A,7 = soft 18 (6-deck S17): S vs 2, Ds vs 3-6, S vs 7-8, H vs 9-A.
  // (vs 2 the made 18 stands — doubling vs a weak 2 is a slight -EV over-double.)
  18: { 2: 'S', 3: 'Ds', 4: 'Ds', 5: 'Ds', 6: 'Ds', 7: 'S', 8: 'S', 9: 'H', 10: 'H', 11: 'H' },
  // A,6 = soft 17 → D vs 3-6 else H.
  17: { 2: 'H', 3: 'D', 4: 'D', 5: 'D', 6: 'D', 7: 'H', 8: 'H', 9: 'H', 10: 'H', 11: 'H' },
  // A,5 = soft 16 → D vs 4-6 else H.
  16: { 2: 'H', 3: 'H', 4: 'D', 5: 'D', 6: 'D', 7: 'H', 8: 'H', 9: 'H', 10: 'H', 11: 'H' },
  // A,4 = soft 15 → D vs 4-6 else H.
  15: { 2: 'H', 3: 'H', 4: 'D', 5: 'D', 6: 'D', 7: 'H', 8: 'H', 9: 'H', 10: 'H', 11: 'H' },
  // A,3 = soft 14 → D vs 5-6 else H.
  14: { 2: 'H', 3: 'H', 4: 'H', 5: 'D', 6: 'D', 7: 'H', 8: 'H', 9: 'H', 10: 'H', 11: 'H' },
  // A,2 = soft 13 → D vs 5-6 else H.
  13: { 2: 'H', 3: 'H', 4: 'H', 5: 'D', 6: 'D', 7: 'H', 8: 'H', 9: 'H', 10: 'H', 11: 'H' },
};

/**
 * HARD totals chart. Key = hard total 4..21. Index by dealer upcard 2..11.
 * Source: WoO hard-hands row (6-deck S17, late surrender).
 *   17+ → stand; 16 → S vs 2-6, R vs 9-A else H; 15 → S vs 2-6, R vs 10(-A) else H;
 *   13-14 → S vs 2-6 else H; 12 → S vs 4-6 else H; 11 → D always (incl vs A under S17);
 *   10 → D vs 2-9 else H; 9 → D vs 3-6 else H; 5-8 → H.
 */
const HARD: Record<number, Partial<Record<number, Decision>>> = {
  21: all('S'),
  20: all('S'),
  19: all('S'),
  18: all('S'),
  17: all('S'),
  16: { 2: 'S', 3: 'S', 4: 'S', 5: 'S', 6: 'S', 7: 'H', 8: 'H', 9: 'R', 10: 'R', 11: 'R' },
  15: { 2: 'S', 3: 'S', 4: 'S', 5: 'S', 6: 'S', 7: 'H', 8: 'H', 9: 'H', 10: 'R', 11: 'H' },
  14: { 2: 'S', 3: 'S', 4: 'S', 5: 'S', 6: 'S', 7: 'H', 8: 'H', 9: 'H', 10: 'H', 11: 'H' },
  13: { 2: 'S', 3: 'S', 4: 'S', 5: 'S', 6: 'S', 7: 'H', 8: 'H', 9: 'H', 10: 'H', 11: 'H' },
  12: { 2: 'H', 3: 'H', 4: 'S', 5: 'S', 6: 'S', 7: 'H', 8: 'H', 9: 'H', 10: 'H', 11: 'H' },
  11: all('D'),
  10: { 2: 'D', 3: 'D', 4: 'D', 5: 'D', 6: 'D', 7: 'D', 8: 'D', 9: 'D', 10: 'H', 11: 'H' },
  9: { 2: 'H', 3: 'D', 4: 'D', 5: 'D', 6: 'D', 7: 'H', 8: 'H', 9: 'H', 10: 'H', 11: 'H' },
  8: all('H'),
  7: all('H'),
  6: all('H'),
  5: all('H'),
  4: all('H'),
};

function all(d: Decision): Partial<Record<number, Decision>> {
  const o: Partial<Record<number, Decision>> = {};
  for (let up = 2; up <= 11; up++) o[up] = d;
  return o;
}

/**
 * Should the player SPLIT this opening pair vs the dealer upcard?
 * (5,5 and T,T are handled by the chart returning 'no' / undefined.)
 */
function shouldSplit(card0: Card, card1: Card, up: number): boolean {
  if (cardBaseValue(card0.rank) !== cardBaseValue(card1.rank)) return false;
  // Pair key: aces=11, tens=10, else base value.
  const pairKey = card0.rank === 'A' ? 11 : cardBaseValue(card0.rank);
  const row = PAIRS[pairKey];
  if (!row) return false;
  return row[up] === 'P';
}

/**
 * Decide hit/stand/double/surrender for a NON-pair (or post-split) hand from the
 * chart. `firstDecision` gates double/surrender (only legal on the first action,
 * and the engine forbids surrender on split hands). `canDouble` is false once a
 * card has been drawn or for split-ace hands (handled by caller). Returns the
 * concrete engine action, demoting D/Ds/R to their fallback when illegal.
 */
function decideAction(
  cards: Card[],
  up: number,
  opts: { firstDecision: boolean; canDouble: boolean; canSurrender: boolean },
): BlackjackActionType {
  const { total, isSoft } = handTotal(cards);
  let raw: Decision | undefined;

  if (isSoft && total >= 13 && total <= 20) {
    raw = SOFT[total]?.[up];
  }
  if (raw === undefined) {
    // Hard total path (also covers soft totals the SOFT table doesn't list).
    const hardTotal = Math.min(21, Math.max(4, total));
    raw = HARD[hardTotal]?.[up];
  }
  if (raw === undefined) raw = total >= 17 ? 'S' : 'H';

  switch (raw) {
    case 'S':
      return 'stand';
    case 'H':
      return 'hit';
    case 'D':
      return opts.firstDecision && opts.canDouble && cards.length === 2 ? 'double' : 'hit';
    case 'Ds':
      return opts.firstDecision && opts.canDouble && cards.length === 2 ? 'double' : 'stand';
    case 'R':
      return opts.firstDecision && opts.canSurrender && cards.length === 2 ? 'surrender' : 'hit';
    case 'P':
      // Pairs are decided before this function; treat as hit fallback.
      return 'hit';
    default:
      return total >= 17 ? 'S' : 'hit';
  }
}

// ---------------------------------------------------------------------------
// Build a full HandScript by peeking the shoe, then play it for real.
// ---------------------------------------------------------------------------

interface ShoeState {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  cursor: number;
  dealtBefore: number;
  remainingShoe: Card[] | undefined;
}

const STAND_ONLY: HandScript = { hands: [['stand']], didSplit: false, tookInsurance: false };

/** Decision-frequency counters for chart verification (printed at the end). */
const STATS = {
  hands: 0,
  splits: 0,
  doubles: 0,
  surrenders: 0,
  naturals: 0,
};

/**
 * Play one hand with full basic strategy under the given shoe state. Returns the
 * engine HandResult (already settled) using the basic-strategy script. Uses
 * repeated peeks (same shoe state) to discover drawn cards before committing.
 */
function playBasicStrategyHand(st: ShoeState): {
  net: bigint;
  totalBet: bigint;
  cursorAfter: number;
  dealtAfter: number;
  remainingAfter: Card[];
} {
  const peekArgs = {
    serverSeed: st.serverSeed,
    clientSeed: st.clientSeed,
    nonce: st.nonce,
    cursor: st.cursor,
    bet: 1n, // bet size irrelevant for card discovery / strategy decisions
    dealtBefore: st.dealtBefore,
    remainingShoe: st.remainingShoe,
  };

  // Peek with stand-only to discover the opening hand + dealer upcard.
  const peek = playHand({ ...peekArgs, script: STAND_ONLY });
  const opening = peek.playerHands[0]!.cards.slice(0, 2);
  const up = dealerChartValue(peek.dealer.cards[0]!.rank);

  STATS.hands++;

  // Natural short-circuit: player or dealer BJ ends the hand — script is moot.
  if (peek.playerHands[0]!.isBlackjack || peek.dealer.isBlackjack) {
    STATS.naturals++;
    return stepReal(st, STAND_ONLY);
  }

  // ── SPLIT decision ──────────────────────────────────────────────────────
  if (opening.length === 2 && shouldSplit(opening[0]!, opening[1]!, up)) {
    STATS.splits++;
    const splitScript = buildSplitScript(st, opening, up);
    countTerminals(splitScript);
    return stepReal(st, splitScript);
  }

  // ── Non-split: build the single-hand action list by iterative peeking ─────
  const actions = buildHandActions(st, /*didSplit*/ false, /*handIndex*/ 0, up, {
    canSurrender: true,
  });
  const script: HandScript = { hands: [actions], didSplit: false, tookInsurance: false };
  countTerminals(script);
  return stepReal(st, script);
}

/**
 * Build the action list for ONE (sub-)hand by iteratively appending decisions
 * and re-peeking the engine to read the freshly drawn card. Terminates on
 * stand/double/surrender/bust/21.
 *
 * `otherHandActions` (split mode only) is the OTHER sub-hand's FINAL action list.
 * Because the engine plays hand 0 fully BEFORE hand 1 and they share the
 * no-replacement shoe, hand 1's drawn cards depend on how many cards hand 0 drew.
 * So when building hand 1 we MUST probe with hand 0's real actions fixed (not a
 * placeholder 'stand'), or the probe reads cards from a different shoe sequence
 * than the final script → "action recorded after bust" / wrong strategy.
 */
function buildHandActions(
  st: ShoeState,
  didSplit: boolean,
  handIndex: number,
  up: number,
  opts: { canSurrender: boolean; otherHandActions?: BlackjackActionType[] },
): BlackjackActionType[] {
  const actions: BlackjackActionType[] = [];

  for (let guard = 0; guard < 12; guard++) {
    // Probe this hand's current cards. The OTHER split hand is pinned to its
    // final actions (hand 0) or 'stand' (hand 1 not yet built — only used while
    // building hand 0, which is shoe-order-first so 'stand' for hand 1 is fine).
    const probeScript = buildProbeScript(didSplit, handIndex, actions, opts.otherHandActions);
    const probe = playHand({
      serverSeed: st.serverSeed,
      clientSeed: st.clientSeed,
      nonce: st.nonce,
      cursor: st.cursor,
      bet: 1n,
      dealtBefore: st.dealtBefore,
      remainingShoe: st.remainingShoe,
      script: probeScript,
    });
    const cards = probe.playerHands[handIndex]!.cards;
    const { total } = handTotal(cards);

    // Split-ace sub-hand: engine forbids any action but stand → auto-stop.
    if (didSplit && cards[0]!.rank === 'A') {
      return [];
    }
    if (total >= 21) {
      // 21 or bust — no further action. The action list so far is already
      // terminal: a trailing 'hit' that reached 21/busted needs NO 'stand'
      // (the engine resolves an exhausted list as an implicit stand, and a
      // 'stand' AFTER a busting hit throws). An empty list (a 2-card 21, only
      // possible post-split non-natural) also resolves as an implicit stand.
      return actions;
    }

    const firstDecision = actions.length === 0;
    const action = decideAction(cards, up, {
      firstDecision,
      // Double legal only as the first decision on a 2-card hand. After a split,
      // engine permits double on the 2-card sub-hand (DAS). Not on split aces
      // (handled above).
      canDouble: firstDecision && cards.length === 2,
      canSurrender: opts.canSurrender && firstDecision && !didSplit && cards.length === 2,
    });

    if (action === 'stand' || action === 'double' || action === 'surrender') {
      actions.push(action);
      return actions;
    }
    // hit → append and loop to read the new card.
    actions.push('hit');
  }
  // Safety: force a stand if we somehow looped out.
  if (actions[actions.length - 1] !== 'stand') actions.push('stand');
  return actions;
}

/**
 * A probe script that keeps `handIndex`'s in-progress actions VERBATIM and makes
 * the OTHER hand auto-stand, so a single playHand reveals handIndex's current
 * cards. We pass the raw action list WITHOUT appending a terminal action: the
 * engine treats an exhausted action list as an implicit stand and resolves a
 * busted hand fine, whereas appending a 'stand' AFTER a hit that busted throws
 * "action recorded after bust". So the raw list is always a legal probe.
 */
function buildProbeScript(
  didSplit: boolean,
  handIndex: number,
  actions: BlackjackActionType[],
  otherHandActions?: BlackjackActionType[],
): HandScript {
  if (!didSplit) {
    return { hands: [[...actions]], didSplit: false, tookInsurance: false };
  }
  // The OTHER hand is pinned to its final actions when known (building hand 1
  // after hand 0), else 'stand' (building hand 0; hand 1 doesn't affect hand 0's
  // cards since hand 0 is dealt+played first in shoe order).
  const otherIndex = handIndex === 0 ? 1 : 0;
  const hands: BlackjackActionType[][] = [[], []];
  hands[handIndex] = [...actions];
  hands[otherIndex] = otherHandActions ? [...otherHandActions] : ['stand'];
  return { hands, didSplit: true, tookInsurance: false };
}

/**
 * Build the full split script: decide each of the two split sub-hands. Split
 * aces get an empty action list (engine auto-stands the single dealt card).
 */
function buildSplitScript(st: ShoeState, opening: Card[], up: number): HandScript {
  const isAces = opening[0]!.rank === 'A';
  if (isAces) {
    // Split aces: one card each, no action (engine forbids hit/double).
    return { hands: [[], []], didSplit: true, tookInsurance: false };
  }
  // For non-ace splits, each sub-hand plays basic strategy (DAS allowed, no
  // resplit since the engine is single-level, no surrender on split hands).
  // Order matters: build hand 0 FIRST (it's dealt + played first in shoe order),
  // then build hand 1 with hand 0's FINAL actions pinned so the probe reads the
  // same shoe sequence the final script will produce.
  const hand0 = buildHandActions(st, /*didSplit*/ true, 0, up, { canSurrender: false });
  const hand1 = buildHandActions(st, /*didSplit*/ true, 1, up, {
    canSurrender: false,
    otherHandActions: hand0,
  });
  return { hands: [hand0, hand1], didSplit: true, tookInsurance: false };
}

/** Tally double/surrender across all sub-hands of a final script (verification). */
function countTerminals(script: HandScript): void {
  for (const hand of script.hands) {
    for (const a of hand) {
      if (a === 'double') STATS.doubles++;
      else if (a === 'surrender') STATS.surrenders++;
    }
  }
}

/** Execute the chosen script FOR REAL with the actual bet, threading shoe state. */
function stepReal(st: ShoeState, script: HandScript): {
  net: bigint;
  totalBet: bigint;
  cursorAfter: number;
  dealtAfter: number;
  remainingAfter: Card[];
} {
  const stepped = playHandWithState({
    serverSeed: st.serverSeed,
    clientSeed: st.clientSeed,
    nonce: st.nonce,
    cursor: st.cursor,
    bet: CURRENT_BET,
    script,
    dealtBefore: st.dealtBefore,
    remainingShoe: st.remainingShoe,
  });
  return {
    net: stepped.result.net,
    totalBet: stepped.result.totalBet,
    cursorAfter: stepped.cursorAfter,
    dealtAfter: stepped.dealtAfter,
    remainingAfter: stepped.remainingAfter,
  };
}

// The bet used by stepReal; set once in main (peeks use bet=1n, irrelevant to
// card draws since the deal/draw consumes the same bytes regardless of stake).
let CURRENT_BET = 100n;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface SimResult {
  hands: number;
  totalBet: bigint;
  totalPayout: bigint; // totalBet + sum(net)
  netToHouse: bigint; // -sum(net)
  wins: number;
  pushes: number;
  losses: number;
  wallMs: number;
}

function runSimulation(cli: Cli): SimResult {
  CURRENT_BET = cli.bet;
  const res: SimResult = {
    hands: 0,
    totalBet: 0n,
    totalPayout: 0n,
    netToHouse: 0n,
    wins: 0,
    pushes: 0,
    losses: 0,
    wallMs: 0,
  };

  let serverSeed = createServerSeed().serverSeed;
  let remaining: Card[] | undefined = undefined;
  let cursor = 0;
  let dealt = 0;
  let nonce = 0;

  const t0 = performance.now();
  const stride = cli.hands >= 50_000 ? Math.floor(cli.hands / 20) : 0;

  for (let i = 0; i < cli.hands; i++) {
    if (dealt >= RESHUFFLE_CARD_THRESHOLD) {
      serverSeed = createServerSeed().serverSeed;
      remaining = undefined;
      cursor = 0;
      dealt = 0;
      nonce = 0;
    }

    const st: ShoeState = {
      serverSeed,
      clientSeed: cli.clientSeed,
      nonce,
      cursor,
      dealtBefore: dealt,
      remainingShoe: dealt === 0 ? undefined : remaining,
    };

    const out = playBasicStrategyHand(st);

    res.hands++;
    res.totalBet += out.totalBet;
    res.totalPayout += out.totalBet + out.net;
    res.netToHouse += -out.net;
    if (out.net > 0n) res.wins++;
    else if (out.net === 0n) res.pushes++;
    else res.losses++;

    remaining = out.remainingAfter;
    cursor = out.cursorAfter;
    dealt = out.dealtAfter;
    nonce++;

    if (stride > 0 && i > 0 && i % stride === 0) {
      const edge = Number(res.totalBet - res.totalPayout) / Number(res.totalBet);
      process.stderr.write(`  ${((i / cli.hands) * 100).toFixed(0)}% (edge so far ${(edge * 100).toFixed(3)}%)\n`);
    }
  }

  res.wallMs = performance.now() - t0;
  return res;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function formatReport(cli: Cli, r: SimResult): string {
  const edge = Number(r.totalBet - r.totalPayout) / Number(r.totalBet);
  // Approx 95% CI on the edge: blackjack net per hand has stdev ≈ 1.14 units
  // (incl. doubles/splits). half-width = 1.96 * 1.14 / sqrt(n) in stake units.
  const ciUnits = (1.96 * 1.14) / Math.sqrt(r.hands);

  const lines: string[] = [];
  lines.push('═'.repeat(88));
  lines.push('Blackjack house-edge Monte Carlo — AS-BUILT engine, flat BASIC-STRATEGY player (no count)');
  lines.push('═'.repeat(88));
  lines.push('');
  lines.push(`Rules:           6-deck · dealer STANDS soft 17 (S17) · BJ 3:2 · DAS · late surrender · no resplit · no hit-split-aces`);
  lines.push(`Hands:           ${r.hands.toLocaleString()}`);
  lines.push(`Bet/hand:        ${cli.bet}`);
  lines.push(`Client seed:     ${cli.clientSeed}`);
  lines.push(`Fresh serverSeed per shoe (crypto.randomBytes); reshuffle gate = ${RESHUFFLE_CARD_THRESHOLD} cards`);
  lines.push(`Wall clock:      ${(r.wallMs / 1000).toFixed(2)}s  (${(r.hands / (r.wallMs / 1000)).toFixed(0)} hands/s)`);
  lines.push('');
  lines.push(`Total wagered:   ${r.totalBet}   (sum of per-hand bets incl. doubles + split second hands)`);
  lines.push(`Total returned:  ${r.totalPayout}`);
  lines.push(`House profit:    ${r.netToHouse}`);
  lines.push('');
  lines.push(`HOUSE EDGE:      ${(edge * 100).toFixed(4)}%   (±${(ciUnits * 100).toFixed(3)}% approx 95% CI)`);
  lines.push(`Player EV:       ${(-edge * 100).toFixed(4)}%  per unit wagered`);
  lines.push('');
  const total = r.wins + r.pushes + r.losses;
  lines.push(`Win/push/loss:   ${((r.wins / total) * 100).toFixed(2)}% / ${((r.pushes / total) * 100).toFixed(2)}% / ${((r.losses / total) * 100).toFixed(2)}%  (by hand net sign)`);
  lines.push('');
  lines.push('');
  lines.push('Decision frequencies (chart sanity — published 6-deck S17 LS+DAS rates in parens):');
  lines.push(`  split:     ${((STATS.splits / STATS.hands) * 100).toFixed(2)}%  (~2.5%)`);
  lines.push(`  double:    ${((STATS.doubles / STATS.hands) * 100).toFixed(2)}%  (~10.5% incl. DAS)`);
  lines.push(`  surrender: ${((STATS.surrenders / STATS.hands) * 100).toFixed(2)}%  (~4.4% with LS: 15v10, 16v9/10/A)`);
  lines.push(`  natural:   ${((STATS.naturals / STATS.hands) * 100).toFixed(2)}%  (~9.3% either-side BJ short-circuit)`);
  lines.push('');
  const inBand = edge >= 0.003 && edge <= 0.007;
  lines.push(`Expected band (6-deck S17 basic strategy): ~+0.40% … +0.55%.  ${inBand ? 'IN BAND ✓' : 'OUT OF BAND — check chart'}`);
  lines.push('═'.repeat(88));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  process.stderr.write(`Blackjack edge sim: ${cli.hands.toLocaleString()} hands, bet=${cli.bet}\n\n`);
  const r = runSimulation(cli);
  process.stdout.write(formatReport(cli, r) + '\n');
}

main();
