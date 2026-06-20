/**
 * Cove provably-fair verifier — back-compat equality helpers (economy fix
 * 2026-05-29, fixer pass).
 *
 * The /verify endpoint (`cove-history.ts`) re-derives a hand/coup from the
 * revealed seed via the LIVE engine serializers, then deep-equals the fresh
 * serialization against the STORED `outcomeJson`. The economy fix changed two
 * kinds of serialized bytes:
 *
 *   1. NEW FIELDS (blackjack + hold'em): `serializeHandResult` /
 *      `serializeHoldemHand` now ALWAYS emit rake fields (`rake`,
 *      `rakedPayout`/`humanRakedPayout`, `rakedNet`/`humanRakedNet`). A row
 *      SETTLED BY PRE-RAKE CODE stored an `outcomeJson` WITHOUT those keys, so a
 *      strict deep-equal against the new serialization fails — even though the
 *      hand was perfectly fair and the GROSS fields (cards, totals, payout,
 *      net) are byte-identical. Fix: when the stored row lacks the rake keys,
 *      strip the SAME keys from the replayed (expected) serialization before
 *      comparing — i.e. compare only the fields the stored row actually carries.
 *
 *   2. CHANGED VALUES (baccarat banker-win): the commission-rounding fix
 *      (`floor(stake * 95/100)` winnings instead of `stake - floor(stake*5/100)`)
 *      changed the actual `payout` / `net` / `commission` VALUES on a WON BANKER
 *      bet at any stake that is not a multiple of 20. The serialized SHAPE is
 *      unchanged (those keys always existed); only the numbers differ. Fix:
 *      compare every NON-monetary field strictly; for `payout`/`net`/`commission`
 *      accept the stored row if it equals EITHER the new formula's value
 *      (`expected`) OR the OLD formula's value (recomputed here from the coup's
 *      winner/bet/stake). A pre-fix banker win settled correctly under the OLD
 *      rules is thus reported `verified:true`, not silently failed.
 *
 * These are PURE (no DB, no I/O) so they're unit-tested directly against
 * hand-rolled pre-fix and post-fix stored payloads. Slots are unaffected (no
 * rake, no payout-formula change) so they keep their own inline comparison.
 *
 * Reference: `.claude/plans/cove-casino-economy.md` §3 + the fixer BLOCKING
 * finding (verifier deep-equal regressed for pre-fix rows).
 */

import {
  settleBet as baccaratSettleBet,
  type BaccaratBet,
  type CoupWinner,
} from './baccarat-engine';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Return a shallow copy of `o` with the listed keys removed. */
function omit(o: Json, keys: readonly string[]): Json {
  const out: Json = {};
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) out[k] = o[k];
  }
  return out;
}

/**
 * Recursively canonicalize a JSON value so equality is INSENSITIVE to object
 * key order. Object keys are sorted; ARRAY order is PRESERVED (card sequences,
 * reels, and winning lines are positional and must stay ordered).
 *
 * This is load-bearing for the /verify endpoint. `expected` is freshly built by
 * the live engine serializers (keys in insertion order), while `stored` is read
 * back from a Postgres `jsonb` column — and jsonb DOES NOT preserve key order
 * (it stores keys sorted by length, then bytewise). A raw `JSON.stringify`
 * comparison of the two therefore false-negatives on EVERY real stored row: the
 * hand is provably fair (hash matches, every value identical) yet `verified`
 * reports false, telling honest players the game was rigged. Sorting keys before
 * stringify removes that artifact while STILL catching any genuine value or
 * structural divergence (a wrong card, payout, or net still fails).
 *
 * (The unit tests never caught this because they build the "stored" side with JS
 * object literals / `JSON.parse(JSON.stringify(...))`, both of which preserve
 * insertion order — so they never reproduced jsonb's reordering. See the
 * key-shuffle regression tests added alongside this fix.)
 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonicalize(o[k]);
    return out;
  }
  return v;
}

/**
 * Deep-equal that is INSENSITIVE to object key order but SENSITIVE to array
 * order and every value (see `canonicalize`). Replaces the previous raw
 * `JSON.stringify` equality, which silently broke against jsonb-stored rows.
 * Exported so the slots verify branch (`cove-history.ts`) — which compares
 * `winningLines`, an array of OBJECTS whose keys jsonb also reorders — shares
 * the same correct equality op.
 */
export function canonicalJsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/** Internal alias kept so the per-game comparators below read unchanged. */
const jsonEq = canonicalJsonEq;

// ---------------------------------------------------------------------------
// Blackjack — new-field back-compat
// ---------------------------------------------------------------------------

/** Rake keys `serializeHandResult` started emitting on the 2026-05-29 fix. */
const BLACKJACK_RAKE_KEYS = ['rake', 'rakedPayout', 'rakedNet'] as const;

/** Metadata keys the single-hand replay can't re-derive (persisted-only). */
const BLACKJACK_META_KEYS = ['cursorBefore', 'dealtBefore'] as const;

/**
 * Whether a replayed blackjack serialization matches the stored `outcomeJson`,
 * tolerant of a PRE-RAKE stored row (no rake keys). `cursorBefore`/`dealtBefore`
 * are persisted-only metadata and are excluded by both the legacy verifier and
 * here. When the stored row is missing ANY rake key (pre-fix), the rake keys are
 * stripped from BOTH sides so the comparison is over the gross fields the stored
 * row actually carries. A post-fix row keeps all keys and compares strictly.
 */
export function blackjackOutcomesMatch(expected: Json, stored: Json): boolean {
  const storedHasRake = BLACKJACK_RAKE_KEYS.every((k) => k in stored);
  const dropKeys = storedHasRake
    ? BLACKJACK_META_KEYS
    : [...BLACKJACK_META_KEYS, ...BLACKJACK_RAKE_KEYS];
  return jsonEq(omit(expected, dropKeys), omit(stored, dropKeys));
}

// ---------------------------------------------------------------------------
// Hold'em — new-field back-compat
// ---------------------------------------------------------------------------

/** Rake keys `serializeHoldemHand` started emitting on the 2026-05-29 fix. */
const HOLDEM_RAKE_KEYS = ['rake', 'humanRakedPayout', 'humanRakedNet'] as const;

/**
 * Whether a replayed hold'em serialization matches the stored `outcomeJson`,
 * tolerant of a PRE-RAKE stored row (no rake keys). Hold'em has no
 * cursor/dealt metadata to exclude (per-hand fresh deck), so the only
 * back-compat concern is the new rake keys. When the stored row lacks ANY rake
 * key (pre-fix), the rake keys are stripped from BOTH sides before comparing.
 * A post-fix row keeps all keys and compares strictly.
 */
export function holdemOutcomesMatch(expected: Json, stored: Json): boolean {
  const storedHasRake = HOLDEM_RAKE_KEYS.every((k) => k in stored);
  if (storedHasRake) {
    return jsonEq(expected, stored);
  }
  return jsonEq(omit(expected, HOLDEM_RAKE_KEYS), omit(stored, HOLDEM_RAKE_KEYS));
}

// ---------------------------------------------------------------------------
// Baccarat — changed-value back-compat (banker-win commission rounding)
// ---------------------------------------------------------------------------

/** Metadata keys the single-coup replay can't re-derive (persisted-only). */
const BACCARAT_META_KEYS = ['cursorBefore', 'dealtBefore'] as const;

/** Monetary keys whose VALUES changed on the banker-win commission fix. */
const BACCARAT_MONEY_KEYS = ['payout', 'net', 'commission'] as const;

/**
 * The OLD (pre-2026-05-29) banker-win payout math, kept ONLY for verifying
 * historical rows. Old rule: commission = floor(stake * 5/100) (rounded the
 * COMMISSION down → undercharged below stake 20); winnings = stake - commission;
 * payout = stake + winnings; net = payout - stake (= winnings). Every other bet
 * (player / tie / push / loss) was UNCHANGED by the fix, so this only differs
 * from the new `settleBet` on a WON BANKER bet.
 */
function oldBaccaratSettle(
  bet: BaccaratBet,
  stake: bigint,
  winner: CoupWinner,
): { payout: bigint; net: bigint; commission: bigint } {
  if (bet === 'banker' && winner === 'banker') {
    const commission = (stake * 5n) / 100n; // floored — the OLD undercharging rule
    const winnings = stake - commission;
    const payout = stake + winnings;
    return { payout, net: payout - stake, commission };
  }
  // All other cells are identical to the new engine → reuse it.
  const { payout, commission } = baccaratSettleBet(bet, stake, winner);
  return { payout, net: payout - stake, commission };
}

/**
 * Whether a replayed baccarat serialization matches the stored `outcomeJson`,
 * tolerant of a PRE-FIX banker-win row whose stored `payout`/`net`/`commission`
 * were computed under the OLD commission-rounding rule.
 *
 * Strategy: `cursorBefore`/`dealtBefore` are excluded (persisted-only metadata,
 * as the legacy verifier did). Every other NON-monetary field (cards, totals,
 * winner, bet, stake, nonce, engineVersion, …) MUST match the replay exactly —
 * those are unaffected by the fix and any mismatch is a real verification
 * failure. The three monetary fields are accepted if they match EITHER the new
 * engine's values (the replayed `expected`) OR the OLD formula's values
 * recomputed from the coup's own `bet`/`stake`/`winner`.
 *
 * `expected` is the fresh replay (always new-formula); `stored` is the row.
 */
export function baccaratOutcomesMatch(expected: Json, stored: Json): boolean {
  const dropKeys = [...BACCARAT_META_KEYS, ...BACCARAT_MONEY_KEYS];
  // 1. Non-monetary, non-metadata fields must match exactly.
  if (!jsonEq(omit(expected, dropKeys), omit(stored, dropKeys))) {
    return false;
  }

  // 2. Monetary fields: accept the NEW values...
  const expMoney = {
    payout: String(expected.payout),
    net: String(expected.net),
    commission: String(expected.commission),
  };
  const storedMoney = {
    payout: String(stored.payout),
    net: String(stored.net),
    commission: String(stored.commission),
  };
  if (
    storedMoney.payout === expMoney.payout &&
    storedMoney.net === expMoney.net &&
    storedMoney.commission === expMoney.commission
  ) {
    return true;
  }

  // 3. ...or accept the OLD-formula values recomputed from the stored coup's
  // own bet/stake/winner. Anything else is a genuine mismatch.
  const bet = stored.bet;
  const winner = stored.winner;
  const stakeStr = stored.stake;
  if (
    (bet !== 'player' && bet !== 'banker' && bet !== 'tie') ||
    (winner !== 'player' && winner !== 'banker' && winner !== 'tie') ||
    typeof stakeStr !== 'string'
  ) {
    return false;
  }
  let stake: bigint;
  try {
    stake = BigInt(stakeStr);
  } catch {
    return false;
  }
  if (stake <= 0n) return false;

  const old = oldBaccaratSettle(bet, stake, winner);
  return (
    storedMoney.payout === old.payout.toString() &&
    storedMoney.net === old.net.toString() &&
    storedMoney.commission === old.commission.toString()
  );
}
