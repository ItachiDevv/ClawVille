/**
 * House-trader RISK STATUS: the reported-pause feed (founder decision,
 * 2026-09-20).
 *
 * The public board must be able to say "Paused by risk limit" when a house
 * trader cannot open a position. The rule loop that knows the answer runs
 * OUTSIDE this repo, so it posts its state here and the board reads it back.
 *
 * THE INVARIANT, stated once and enforced by every function below: a pause is
 * REPORTED, never INFERRED. There is no code path in this file, or in the
 * route that uses it, that turns "no trades lately" into a pause. Trade
 * silence is equally consistent with "nothing passed the filter", so deriving
 * a reason from it would publish a guess. Nothing reported means `null`, which
 * reads as "we were not told" and is the honest answer.
 *
 * Deliberately NOT a database table. The state is ephemeral by nature (it
 * ages out in 150 s and the next post replaces it), it carries no money and no
 * history obligation, and a table would add a migration, a write path and a
 * retention question for data whose whole value is that it is current. If a
 * historical pause log is ever wanted, that is a separate decision with its
 * own schema, not a side effect of this feed.
 *
 * SHAPE OF THE MODULE. The pure pieces (`classifyRiskState`,
 * `sanitiseStatusDetail`, `isStatusFresh`, `toHouseTraderRisk`) take every
 * input they use, including the clock, so the rules are testable with no
 * environment and no database. The store is the only stateful part, and it is
 * a plain Map.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  HOUSE_TRADER_STATUS_DETAIL_MAX,
  HOUSE_TRADER_STATUS_MAX_AGE_MS,
  HOUSE_TRADER_STATUS_MAX_FUTURE_MS,
  HOUSE_TRADER_STATUS_MAX_PAST_MS,
  HOUSE_TRADER_STATUS_REASONS,
  type HouseTraderRisk,
  type HouseTraderRiskState,
  type HouseTraderStatusReason,
} from '@clawville/shared';

/** Base58, the same alphabet and the same length band the trade route uses for
 *  a mint. A pubkey that cannot be one is refused before anything looks it up. */
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The POST body, `.strict()` so an extra field is a 400 rather than a silently
 * ignored one. A field the server drops is how a runner ends up believing it
 * reported something it did not.
 *
 * `at` is validated as a plain bounded string here and parsed separately,
 * because its two failures answer DIFFERENT codes: a string that is not a
 * timestamp at all is `invalid_body` like any other malformed field, while a
 * well-formed time outside the window is `stale_timestamp`. One schema cannot
 * produce two codes, so the parse lives in `normaliseStatusTimestamp`.
 */
export const houseTraderStatusBodySchema = z
  .object({
    wallet: z.string().regex(BASE58_PUBKEY),
    canEnter: z.boolean(),
    reason: z.enum(HOUSE_TRADER_STATUS_REASONS),
    detail: z.string().max(HOUSE_TRADER_STATUS_DETAIL_MAX).optional(),
    dayLossUsd: z.number().finite().min(0),
    dayLossCapUsd: z.number().finite().gt(0),
    roomNeededUsd: z.number().finite().min(0),
    at: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    // `{ canEnter: false, reason: 'ok' }` is a CONTRADICTION, not a state.
    // It says "I cannot open a position and nothing is wrong", and under the
    // classification rules it would fall through to `live`, so the board would
    // print a working trader over a report that says the opposite. Refused
    // rather than mapped: silently choosing one half of a contradiction is how
    // a board ends up confidently wrong.
    if (!value.canEnter && value.reason === 'ok') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'reason "ok" contradicts canEnter false',
      });
    }
    // The MIRROR case, `{ canEnter: true, reason: 'daily_loss_floor' }`, is
    // deliberately ALLOWED and classifies as `live`. It is a real transitional
    // report: a runner that just recovered still carries the reason that held
    // it back on the tick it recovers, and the frozen contract says as much
    // ("everything else ... or canEnter true -> live"). It is also how the
    // `fault` rule reaches a runner that reports `price_feed_down` while still
    // believing it could enter. Refusing it would drop honest reports.
  });

export type HouseTraderStatusBody = z.infer<typeof houseTraderStatusBodySchema>;

/** One stored report. `receivedAtMs` is SERVER time, never the runner's: the
 *  ageout has to measure how long WE have been without news, and a runner with
 *  a fast clock must not be able to keep a stale state alive. */
export interface StoredHouseTraderStatus {
  wallet: string;
  canEnter: boolean;
  reason: HouseTraderStatusReason;
  detail: string | null;
  dayLossUsd: number;
  dayLossCapUsd: number;
  roomNeededUsd: number;
  /**
   * The time the runner SENT this post, normalised to ISO 8601 UTC. It advances
   * on EVERY post, including a heartbeat that reports no change.
   *
   * It is NOT the time the state began, and the difference is load bearing. An
   * earlier version of this comment said "the runner's own timestamp for the
   * state", which made an unchanged heartbeat plausibly carry an unchanged
   * timestamp; combined with dropping equal timestamps, that aged a live pause
   * off the board in 150 s while the runner was still reporting it correctly.
   */
  at: string;
  /** The same instant in epoch ms. Kept beside `at` so the ordering check never
   *  re-parses, and so a stored pair can never disagree with itself. */
  atMs: number;
  /** When the SERVER received it. Freshness and `ageSeconds` both measure from
   *  here, because the question they answer is "have we heard recently", not
   *  "has the state changed recently". Those are different facts. */
  receivedAtMs: number;
}

/**
 * Reasons that mean "a risk limit is holding this trader back". A pause needs
 * BOTH this set and `canEnter === false`: the runner is the authority on
 * whether it can enter, and the reason only explains why.
 */
const PAUSED_REASONS: ReadonlySet<HouseTraderStatusReason> = new Set([
  'daily_loss_floor',
  'halted',
  'insufficient_usdc',
  'gas_reserve',
]);

/**
 * Reasons that mean "the runner is not deciding at all". These win regardless
 * of `canEnter`, because a blind trader that still reports `canEnter: true` is
 * not live in any sense a reader would recognise, and a broken price feed must
 * never be dressed up as a deliberate risk decision.
 */
const FAULT_REASONS: ReadonlySet<HouseTraderStatusReason> = new Set([
  'price_feed_down',
  'other',
]);

/**
 * The whole classification, in one pure function.
 *
 * `at_max_positions` and `settling` are deliberately LIVE. Both mean the
 * trader is working: fully deployed, or mid-swap. Calling either a pause would
 * put a red badge on a healthy trader several times a day and teach readers to
 * ignore the badge, which costs us the one case it exists for.
 */
export function classifyRiskState(
  canEnter: boolean,
  reason: HouseTraderStatusReason,
): HouseTraderRiskState {
  if (FAULT_REASONS.has(reason)) return 'fault';
  if (!canEnter && PAUSED_REASONS.has(reason)) return 'paused';
  return 'live';
}

/**
 * Everything that can SPLIT a token without being seen: marks, format
 * characters, C0 and C1 controls, the line and paragraph separators, and the
 * default-ignorable set.
 *
 * THREE ROUNDS OF THIS BUG, and the class is not the lesson. Round one listed
 * U+0300-036F plus a handful of zero-width codepoints; Codex walked U+1AB0 and
 * U+FE0F through it. Round two moved to `\p{M}` and `\p{Cf}`; tfs-audit walked
 * `\p{Cc}`, `\p{Zl}` and `\p{Zp}` through THAT, and the winning input was a
 * bare newline, which is not an attack at all, it is a Python traceback. Each
 * class held for the members we had looked at and failed on the set.
 *
 * So the fix is the SPLIT below, not this list. `\p{Default_Ignorable_Code_Point}`
 * is taken from the board's copy (tfs-web got there first) and subsumes the
 * variation selectors and whatever Unicode adds next.
 *
 * `\p{Zs}` IS DELIBERATELY ABSENT, and this is the paragraph that should stop
 * you adding it. Joining across ordinary spaces makes plain English look like
 * an address, because base58 excludes only `l`, `0`, `O` and `I`, so any
 * sentence avoiding those four letters becomes one long run. Measured, not
 * guessed: "day trade entry refused by cap reset after ten minutes" is 45
 * base58 characters once the spaces go, and a perfectly good operator note
 * would be silently wiped. Every leak found so far is `Cc`, `Zl` or `Zp`, all
 * covered without `Zs`.
 *
 * RESIDUAL RISK, accepted deliberately: an address typed with an ordinary space
 * inside it is NOT detected. That is much smaller than the false-positive cost
 * above. A pasted address arrives whole and is caught; a traceback puts it on
 * its own line and `\p{Cc}` catches that; the space case needs someone to type
 * it on purpose. Recorded beside the other accepted risks in
 * `docs/clawpump-integration.md`.
 */
const SPLITTERS = /[\p{M}\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * The RENDER-path subset: characters that are genuinely INVISIBLE, so deleting
 * them changes nothing a reader would see.
 *
 * Narrower than `SPLITTERS` on purpose, and the difference is the whole point
 * of the two-copy design. Controls, line and paragraph separators are NOT here:
 * they occupy space in the reader's mind, so deleting a NUL or a newline
 * between two words would store one invented word out of two. They fall
 * through to the printable pass below and become a SPACE. That is safe only
 * because detection has already run on a copy where they were deleted.
 */
const INVISIBLE_FOR_RENDER = /[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * DETECTION regexes. NON-GLOBAL, and this is not style.
 *
 * `.replace()` resets `lastIndex`, so the `/g` copies below are safe where they
 * are. The bug appears exactly at the transition this file just made, the first
 * time one of those patterns is handed to `.test()`: a `/g` regex under
 * `.test()` advances `lastIndex` and returns true, false, true across
 * successive calls on the SAME pattern object. Measured in this runtime, on a
 * 40-character run: `true false true`.
 *
 * Applied here that means the first post gets redacted and the SECOND post
 * leaks the identical payload. It passes every single-call test and fails on
 * the second heartbeat in production, which is the worst failure shape there
 * is. Separate non-global copies remove the state entirely; `lastIndex = 0`
 * before each test, or `.search() !== -1`, would also work.
 */
const HEX_ADDRESS_ANYWHERE = /0x[0-9a-f]{6,}/i;
const BASE58_RUN_ANYWHERE = /[1-9A-HJ-NP-Za-km-z]{32,}/;

/**
 * UNPREFIXED hex, the shape both of the detectors above miss.
 *
 * Found by tfs-web. `0x742d35Cc...` is caught by `HEX_ADDRESS_ANYWHERE`, but
 * strip the prefix and nothing fires: base58 EXCLUDES `0`, so the zero inside
 * almost any real address chops the base58 run into pieces under 32. Measured
 * on `742d35Cc6634C0532925a3b844Bc454e4438f44e`: base58-32+ false, `0x` hex
 * false, longest base58 sub-run 26. It rendered verbatim onto the board.
 *
 * 20 rather than 32 because this class is denser: 20 hex characters is already
 * beyond anything an operator note says by accident. Measured against nine
 * realistic notes, seven survive, including "slot 301884412 confirmed". The two
 * that do not are 20-plus straight digits (a real lamport figure runs to about
 * 13) and a 24-character word built only from `a` to `f`. Neither is a note
 * anyone writes.
 */
const BARE_HEX_RUN_ANYWHERE = /[0-9a-f]{20,}/i;
/**
 * A base58 run long enough to be a Solana address.
 *
 * UNBOUNDED above, deliberately differing from the board's `{32,64}`. With a
 * `/g` sweep an upper bound chunks a long run, and a trailing remainder under
 * 32 characters is then left in place. That remainder can never be a complete
 * address, so the board's form is not wrong, but unbounded is strictly stronger
 * and there is no reason for a server-side strip to leave anything behind.
 */
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,}/g;
/** An EVM address. Base58 excludes 0, I, O and l, so hex needs its own pass.
 *  CASE-INSENSITIVE on the whole match, not just the digits: `0X` with a
 *  capital X is a valid prefix a checksummed address can arrive with, and the
 *  first version only lower-cased the `0x`, so `0X...dEaD` walked through. */
const HEX_ADDRESS = /0x[0-9a-f]{6,}/gi;

/**
 * `detail` reaches a PUBLIC board and a wall in the game world, so it is
 * reduced to safe printable ASCII before it is STORED, never on the way out.
 * Sanitising at ingest means no read path can forget to do it.
 *
 * THE ORDER IS LOAD BEARING. Do not reorder these four passes.
 *
 * 1. `normalize('NFKD')`, so a fullwidth or mathematical look-alike folds onto
 *    ASCII and cannot smuggle an address in another alphabet, AND so that any
 *    base letter carrying a combining mark is SPLIT into letter plus mark for
 *    pass 2. NFKD and deliberately NOT NFKC: NFKC RECOMPOSES `p` + U+0301 into
 *    a single `ṕ`, which pass 2 cannot delete, so the address run splits around
 *    it, pass 3 sees two sub-32 halves and misses both, and pass 4 turns the
 *    composed character into a space. The address then prints in full with one
 *    space in the middle. Verified against that exact case in the tests.
 * 2. DELETE the invisible set. Delete, do NOT replace with a space: a space
 *    re-creates the very split pass 3 is about to look for. This is the
 *    inverse of the defect already recorded in `trading-floor-screen-texture.ts`
 *    (`pro<ZWSP>fit` surviving a token pass and printing "PRO FIT"), and the
 *    rule it teaches is the same one: strip invisibles BEFORE anything looks
 *    for a token.
 * 3. Strip addresses, hex first, then base58. An operator note has no business
 *    carrying a wallet, and this surface publishes "wallet addresses are never
 *    included". Replaced with a space, because pass 4 collapses whitespace and
 *    the address is being REMOVED, not joined to its neighbours.
 * 4. Everything still outside `0x20..0x7E` becomes a SPACE, whitespace runs
 *    collapse, trim, cap. A space and not a deletion HERE, because an ordinary
 *    control character between two words is glue: deleting the NUL in
 *    `"floor\u0000reached"` would store one invented word. That reasoning does
 *    NOT apply to pass 2, which is scoped to the invisible set alone.
 *
 * An empty result is `null`, not `''`: "no detail" and "a detail that was
 * entirely unprintable" are the same fact to a reader.
 */
/**
 * Does this note contain an address, once everything that could hide one is
 * removed? Answered on a copy that exists only to be searched.
 *
 * This is the SECURITY half of the split. It is allowed to be maximally
 * destructive because nobody ever reads its output: it folds to NFKD and
 * deletes every splitting character before looking, so no character class can
 * be "the one we forgot" in the way three of them already have been.
 */
export function detailCarriesAddress(raw: string): boolean {
  const forDetection = raw.normalize('NFKD').replace(SPLITTERS, '');
  return HEX_ADDRESS_ANYWHERE.test(forDetection)
    || BASE58_RUN_ANYWHERE.test(forDetection)
    || BARE_HEX_RUN_ANYWHERE.test(forDetection);
}

/**
 * The READABILITY half. Runs only once detection has cleared the note, so it
 * never has to be the thing that catches an address, which is what let a
 * newline leak one: the render pass turns a control character into a SPACE, and
 * a space between two halves of a pubkey is a fully readable pubkey.
 *
 * A note that DOES carry an address is dropped WHOLE rather than patched. A
 * partial strip means reasoning about whether the render path caught the same
 * thing the detector did, and that reasoning is exactly what has been wrong
 * three times. Losing an operator's sentence is a small cost; printing a wallet
 * on a wall in the game world is not.
 */
export function sanitiseStatusDetail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (detailCarriesAddress(raw)) return null;
  const cleaned = raw
    .normalize('NFKD')
    .replace(INVISIBLE_FOR_RENDER, '')
    // Belt and braces. Detection has already cleared the note, so these two can
    // only ever be no-ops; they stay because a future edit that weakens the
    // detector should not silently become a leak.
    .replace(HEX_ADDRESS, ' ')
    .replace(BASE58_RUN, ' ')
    // Anything still outside printable ASCII becomes a SPACE, not a deletion:
    // deleting a stray character between two words invents one word out of two.
    // Safe here precisely because the splitting classes are already gone above.
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, HOUSE_TRADER_STATUS_DETAIL_MAX).trim();
}

/**
 * Freshness, with the clock passed in so a test does not have to wait.
 * Measured from SERVER receipt: stale means "we have heard nothing recently",
 * which is exactly what the board needs to know.
 */
export function isStatusFresh(
  receivedAtMs: number,
  nowMs: number,
  maxAgeMs: number = HOUSE_TRADER_STATUS_MAX_AGE_MS,
): boolean {
  return nowMs - receivedAtMs <= maxAgeMs;
}

/** Whole seconds since receipt, floored at zero. A negative age would mean the
 *  clock moved backwards; publishing it as negative helps nobody. */
export function statusAgeSeconds(receivedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - receivedAtMs) / 1000));
}

/**
 * Turn one stored report into the public `risk` block, or `null` when it has
 * aged out. The stale case returns the SAME value an unpaired slot returns, so
 * a reader never has to distinguish "no feed" from "dead feed" to know that
 * the board is not claiming present knowledge.
 */
export function toHouseTraderRisk(
  status: StoredHouseTraderStatus | null,
  nowMs: number,
  maxAgeMs: number = HOUSE_TRADER_STATUS_MAX_AGE_MS,
): HouseTraderRisk | null {
  if (!status) return null;
  if (!isStatusFresh(status.receivedAtMs, nowMs, maxAgeMs)) return null;
  return {
    state: classifyRiskState(status.canEnter, status.reason),
    reason: status.reason,
    detail: status.detail,
    dayLossUsd: status.dayLossUsd,
    dayLossCapUsd: status.dayLossCapUsd,
    roomNeededUsd: status.roomNeededUsd,
    at: status.at,
    ageSeconds: statusAgeSeconds(status.receivedAtMs, nowMs),
  };
}

/**
 * `at` must parse AND sit near server time, and the two failures are DIFFERENT
 * answers (orchestrator ruling, 2026-09-20).
 *
 * A string that is not a timestamp at all is a malformed field like any other,
 * so it answers `invalid_body`; the runner author reads that as "fix your
 * serialiser". `stale_timestamp` is reserved for a well-formed timestamp that
 * sits outside the window, which is the one the runner author reads as "fix
 * your clock, or stop replaying". Collapsing them sends a clock-skew message
 * to someone whose real bug is a format bug.
 *
 * The window is checked in BOTH directions. A future `at` is refused too: a
 * runner two minutes ahead would otherwise produce a negative age everywhere
 * downstream, and a far-future `at` is the shape a replay takes.
 *
 * On success the value is normalised to ISO 8601 UTC, so the public `at` is
 * one shape whatever offset the runner sent.
 */
export type StatusTimestampResult =
  | { ok: true; at: string; atMs: number }
  | { ok: false; code: 'unparseable' | 'out_of_window' };

export function normaliseStatusTimestamp(
  raw: string,
  nowMs: number,
  maxPastMs: number = HOUSE_TRADER_STATUS_MAX_PAST_MS,
  maxFutureMs: number = HOUSE_TRADER_STATUS_MAX_FUTURE_MS,
): StatusTimestampResult {
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return { ok: false, code: 'unparseable' };
  // ASYMMETRIC. A future `at` is far more dangerous than a past one, because it
  // gets STORED and then rejects every later report as older until the wall
  // clock catches up. See `HOUSE_TRADER_STATUS_MAX_FUTURE_MS`.
  if (parsed - nowMs > maxFutureMs) return { ok: false, code: 'out_of_window' };
  if (nowMs - parsed > maxPastMs) return { ok: false, code: 'out_of_window' };
  // `atMs` travels with the string so the ordering check below never re-parses
  // a value we have already parsed, and so the two can never disagree.
  return { ok: true, at: new Date(parsed).toISOString(), atMs: parsed };
}

/**
 * ORDERING. HTTP does not promise delivery order, so two posts a second apart
 * can arrive reversed. The store is last-write-wins BY ARRIVAL, which is wrong
 * on its own: a delayed `canEnter: false` overwriting the newer
 * `canEnter: true` behind it would pin a pause on the board for a trader that
 * has already recovered. So a report that is STRICTLY OLDER than the one held
 * is dropped, on the runner's own clock.
 *
 * EQUAL STORES, and it must. A first version of this dropped an equal `at` as a
 * duplicate and refused to refresh `receivedAtMs`, reasoning that a retry
 * should not keep a frozen state alive. That reasoning was sound in isolation
 * and WRONG against the contract, because at the time `at` was documented as
 * the timestamp FOR THE STATE: a desk paused for ten minutes would heartbeat
 * every 60 s carrying the same `at`, every heartbeat would be dropped,
 * `receivedAtMs` would never move, and the report would age out at 150 s. The
 * board would then drop the PAUSED badge off a desk that is still paused and
 * still reporting correctly. That is the exact failure this whole feature
 * exists to prevent, reproduced in three minutes while the feed is healthy,
 * which is worse than the original because the surface looks fine.
 *
 * The fix was to the CONTRACT, not to this function: `at` is now the time the
 * runner SENT the post, fresh on every post including a heartbeat that reports
 * no change. See `StoredHouseTraderStatus.at`.
 *
 * EQUAL IS NOT A REPLAY HOLE, and this sentence is here so nobody "hardens" it
 * back to strict-greater and silently restores the ageout bug: the plus or
 * minus ten minute `at` window already bounds a replayed body to re-asserting a
 * state at most ten minutes old, and the next heartbeat corrects it within 60
 * seconds.
 *
 * ORDERING ONLY APPLIES WHILE THE HELD REPORT IS STILL FRESH, and that gate is
 * a deadlock breaker, not an optimisation. The rule compares against a stored
 * `at`, so a runner that banked a FUTURE timestamp (a fast clock) and then
 * corrected itself would have every later report refused as older until the
 * wall clock caught up. Once the held report is past the 150 s ageout it is
 * publishing nothing anyway, so there is nothing left to protect and any valid
 * report takes over. Worst case is now bounded twice over: by the 60 s future
 * skew limit and by this 150 s gate, whichever is shorter.
 *
 * NOT ORDERED: two reports carrying the SAME millisecond. Accepted risk. The
 * runner posts from one sequential loop, so it cannot produce two states in one
 * millisecond, and if it ever did the second would simply win.
 *
 * An ignored report answers 200, because the runner did nothing wrong and must
 * not retry.
 */
export type StatusWriteDecision = 'store' | 'older_report';

export function decideStatusWrite(
  incomingAtMs: number,
  stored: StoredHouseTraderStatus | null,
  nowMs: number,
): StatusWriteDecision {
  if (!stored) return 'store';
  // A stale held report protects nothing: it is already `risk: null` on the
  // wire, so refusing a newer body on its behalf only prolongs a blackout.
  if (!isStatusFresh(stored.receivedAtMs, nowMs)) return 'store';
  return incomingAtMs < stored.atMs ? 'older_report' : 'store';
}

/**
 * The store. One entry per wallet, last write wins.
 *
 * The route refuses any wallet that is not a CURRENT lineup slot's bound wallet
 * before it writes, so the live working set is the lineup size (two today). But
 * "current" moves: pairing and unpairing happen in the database with no deploy,
 * and every re-pairing over a long-lived process adds a key that nothing
 * deletes, because the old wallet was legitimate when it wrote. So the map is
 * also hard-capped and evicts in insertion order. That is safe precisely
 * because a dropped entry can only ever read as `risk: null`, which is the
 * honest "we were not told" value, never a wrong state.
 *
 * Process local on purpose, like the 15 s slot cache next to it. A second API
 * container holds its own copy and the map dies on every deploy, so `risk:
 * null` on all slots is the NORMAL reading straight after a flip, until the
 * runner's next heartbeat lands.
 */
const HOUSE_TRADER_STATUS_MAX_ENTRIES = 16;

const statuses = new Map<string, StoredHouseTraderStatus>();

export function recordHouseTraderStatus(status: StoredHouseTraderStatus): void {
  // Delete first so a re-report moves the wallet to the END of the insertion
  // order. Without it, a desk that reports every 60 s for a week would still be
  // evicted as "oldest" the moment 16 historical wallets pile up behind it.
  statuses.delete(status.wallet);
  statuses.set(status.wallet, status);
  while (statuses.size > HOUSE_TRADER_STATUS_MAX_ENTRIES) {
    const oldest = statuses.keys().next();
    if (oldest.done) break;
    statuses.delete(oldest.value);
  }
}

export function readHouseTraderStatus(wallet: string): StoredHouseTraderStatus | null {
  return statuses.get(wallet) ?? null;
}

/** Tests only. The store is module level, so a case that writes must clean up
 *  or it changes what the next case reads. */
export function clearHouseTraderStatuses(): void {
  statuses.clear();
}

/**
 * The shared secret, read at REQUEST time rather than at module load, so a
 * deployment that sets it does not need a restart to be believed and a test
 * can drive both the configured and unconfigured branches in one process.
 *
 * An empty or whitespace-only value counts as UNSET. A blank secret would make
 * `Authorization: Bearer ` a valid credential, which is worse than being off.
 */
export function readConfiguredStatusToken(): string | null {
  const raw = process.env.HOUSE_TRADER_STATUS_TOKEN;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Constant-time token compare.
 *
 * Both sides are sha256-digested FIRST so the buffers handed to
 * `timingSafeEqual` are always 32 bytes. That satisfies the equal-length
 * precondition (it throws otherwise) without the usual early `length !==`
 * return, which leaks the secret's length to a caller who can time it.
 */
export function statusTokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Pull the bearer credential out of an `Authorization` header. Returns null for
 * a missing header or any other scheme; the token itself is never logged and
 * never echoed back in an error.
 *
 * The scheme match is CASE-INSENSITIVE, per RFC 7235. A runner or a proxy that
 * sends `bearer <token>` is spec-compliant, and rejecting it would hand back a
 * 401 that looks exactly like a wrong secret, which is the worst possible error
 * message for a credential problem that is not one.
 */
export function bearerToken(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}
