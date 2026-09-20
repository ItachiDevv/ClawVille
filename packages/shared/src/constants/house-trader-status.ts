/**
 * The house-trader RISK STATUS wire contract (founder decision, 2026-09-20).
 *
 * WHY THIS EXISTS. The public board could show a trader with a recent trade
 * list and no hint that the trader is currently unable to open a position at
 * all. A reader then treats silence as "nothing looked good today" when the
 * real cause is a risk limit. That happened to Genesis on 2026-09-20: it sat
 * cap-blocked from 03:25Z with `halted` still reading false, and NOTHING on any
 * surface said so.
 *
 * THE ONE RULE THAT MAKES THIS HONEST: a pause is REPORTED, never INFERRED.
 * The rule loop runs outside this repo (a Python process on the staging box),
 * so it is the only thing that knows why it did not buy. ClawVille must never
 * derive a pause from trade silence: silence is consistent with "no candidate
 * passed the filter", which is not a pause, and guessing would put an invented
 * reason on a public surface. A slot with no reported status carries
 * `risk: null`, which means "we were not told", and that is an honest answer.
 *
 * FRESHNESS IS PART OF THE CONTRACT. The runner posts on every state change
 * plus a heartbeat, so a status that stops arriving means the feed died, not
 * that the last state still holds. A report older than
 * `HOUSE_TRADER_STATUS_MAX_AGE_MS` is dropped back to `risk: null` rather than
 * shown as current. A stale "paused" banner is worse than no banner: it claims
 * present knowledge we do not have.
 *
 * This file carries the WIRE SHAPE only. The classifier, the sanitiser, the
 * freshness rule and the in-process store live in
 * `apps/api/src/services/house-trader-status.ts`, because the server is the
 * only classifier; a client that re-derived `state` could disagree with the
 * board it renders.
 */

/**
 * Every reason the runner may report, and nothing else. A closed vocabulary on
 * purpose: free text here would end up rendered verbatim on a public board.
 *
 * - `ok`: the runner can open a position right now.
 * - `daily_loss_floor`: the day's realised loss reached the configured floor,
 *   so no further entry is allowed until the floor resets or the founder
 *   raises it. This is the Genesis 2026-09-20 case.
 * - `halted`: an operator or a watchdog halted the trader.
 * - `insufficient_usdc`: not enough quote currency to take the smallest
 *   allowed position.
 * - `gas_reserve`: the SOL reserve is at or below its floor, so a buy would
 *   leave nothing to pay fees with.
 * - `at_max_positions`: every position slot is already used. NOT a pause: the
 *   trader is fully deployed and working, which is a normal live state.
 * - `settling`: a swap is in flight. A transient state, not a pause.
 * - `price_feed_down`: the price source is unusable, so the runner cannot
 *   judge anything. A FAULT: the trader is not deciding, it is blind.
 * - `other`: anything the runner could not classify. Also a FAULT, because an
 *   unclassified block is an unknown block and must not read as a tidy pause.
 */
export const HOUSE_TRADER_STATUS_REASONS = [
  'ok',
  'daily_loss_floor',
  'halted',
  'insufficient_usdc',
  'gas_reserve',
  'at_max_positions',
  'settling',
  'price_feed_down',
  'other',
] as const;

export type HouseTraderStatusReason = (typeof HOUSE_TRADER_STATUS_REASONS)[number];

/**
 * What the BOARD shows, derived by the server from `canEnter` plus `reason`.
 *
 * - `paused`: the trader cannot open a position and the cause is a risk
 *   limit. This is the only state that earns the words "Paused by risk limit".
 * - `fault`: the runner is blocked for a reason it could not classify, or its
 *   price feed is down. Kept SEPARATE from `paused` so a broken feed is never
 *   presented as a deliberate risk decision.
 * - `live`: everything else, including fully deployed (`at_max_positions`)
 *   and mid-swap (`settling`). Those are working states, not pauses.
 */
export type HouseTraderRiskState = 'paused' | 'live' | 'fault';

/**
 * A report older than this is STALE and the board drops it to `risk: null`.
 * 150 s is two and a half missed 60 s heartbeats, so one lost post does not
 * blank the badge while a dead feed clears it within three minutes.
 */
export const HOUSE_TRADER_STATUS_MAX_AGE_MS = 150_000;

/** Heartbeat cadence the runner is contracted to keep, on top of posting on
 *  every state change. Published so the ageout above is readable next to it. */
export const HOUSE_TRADER_STATUS_HEARTBEAT_MS = 60_000;

/** How far the runner's own `at` may sit from server time before the post is
 *  refused. Generous enough for ordinary clock drift, tight enough that a
 *  replayed old body cannot install a state that has since changed. */
export const HOUSE_TRADER_STATUS_MAX_SKEW_MS = 600_000;

/** Hard cap on the free-text `detail`, before and after sanitising. */
export const HOUSE_TRADER_STATUS_DETAIL_MAX = 120;

/**
 * The `risk` block on each slot of `GET /api/floor/house-traders`.
 *
 * `null` on the slot means one of: nothing is paired to it, the runner has
 * never posted for it, or the last post aged out. All three mean the same
 * thing to a reader, which is "we were not told", so they share one value.
 */
export interface HouseTraderRisk {
  state: HouseTraderRiskState;
  reason: HouseTraderStatusReason;
  /** Operator note, sanitised to printable ASCII. `null` when none was sent. */
  detail: string | null;
  /** Realised loss so far on the runner's own day clock, USD. */
  dayLossUsd: number;
  /** The floor that loss is measured against, USD. Always above zero. */
  dayLossCapUsd: number;
  /** Headroom the runner needs before it can enter again, USD. */
  roomNeededUsd: number;
  /**
   * The time the runner SENT the report behind this block, normalised to ISO
   * 8601 UTC. It advances on every post, including a heartbeat that reports no
   * change, so it reads as "as of", not as "the state began here".
   *
   * It is NOT the time the state began. This sentence used to say "the runner's
   * own timestamp for the state", and that wording caused a real bug: it made
   * an unchanged heartbeat plausibly carry an unchanged timestamp, which the
   * server then treated as a duplicate and refused to store, so a live pause
   * aged off the board in 150 s while the runner was still reporting it.
   */
  at: string;
  /** Seconds since the SERVER received it. Never negative. */
  ageSeconds: number;
}
