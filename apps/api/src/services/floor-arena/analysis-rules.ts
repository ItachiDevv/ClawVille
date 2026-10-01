/**
 * The tuner's published numbers and report cadence (docs/trading-floor-arena.md
 * D10 + D27 + D33). A
 * module with no imports, so the served manual (`skill-protocol.ts`) can print
 * the same values `analysis.ts` enforces without pulling the engine or the
 * database into the manual's import graph.
 */

/** D27/D33: the code tuner changes or suggests nothing before the CURRENT
 *  params have this many closed trades (every agent, auto-apply or not). It
 *  is also the first entry of TUNER_CHECKPOINTS. */
export const MIN_CLOSED_FOR_AUTO_APPLY = 20;
/** D27 split check: the trades the new value keeps and the trades it
 *  excludes each need this many closed trades... */
export const EVIDENCE_MIN_PER_SIDE = 8;
/** ...and the kept side's mean pnl_mult must beat the excluded side's by at
 *  least this much (3 points). */
export const EVIDENCE_MIN_EDGE = 0.03;
/** D33: the code tuner searches many one-filter tightenings, so the best
 *  split it finds must also pass a max-statistic shuffle test: this many
 *  shuffles of pnl_mult across the trades, each one redoing the whole search
 *  family... */
export const EVIDENCE_PERMUTATIONS = 2000;
/** ...with p = (1 + hits) / (1 + EVIDENCE_PERMUTATIONS), hits = shuffles whose
 *  best edge is at least the observed one. This is the FAMILY budget per
 *  params version: the sum of TUNER_CHECKPOINT_ALPHA. One look compares p
 *  with the alpha of its checkpoint, never with this number. */
export const EVIDENCE_MAX_SEARCH_P = 0.05;
/** D33 (statistics review 2026-10-01): the shuffle test runs at most once per
 *  checkpoint of a params version, n = closed trades on that version. A
 *  report tests the LARGEST checkpoint <= n that this version has not tested
 *  yet; a smaller untested checkpoint is forfeited (its alpha is not reused).
 *  Testing every report at 0.05 was optional stopping: 43% (review
 *  simulation) and 54% (floor-arena-tuner.test.ts multi-look test) of
 *  pure-noise agents changed by 400 trades. A params change starts a new version,
 *  so the schedule starts again. */
export const TUNER_CHECKPOINTS: readonly number[] = [20, 40, 80, 160, 200, 400, 800];
/** The p threshold of each checkpoint (same order); the sum is
 *  EVIDENCE_MAX_SEARCH_P (0.05), so a noise agent changes with at most that
 *  chance per params version. */
export const TUNER_CHECKPOINT_ALPHA: readonly number[] = [0.01, 0.01, 0.01, 0.01, 0.005, 0.0025, 0.0025];
/** Every `stats.suggestionCheck.tuner.reason` (D33). The web parser and the
 *  docs copy this list. */
export const ARENA_TUNER_REASONS = [
  'below_sample',
  'waiting_checkpoint',
  'budget_spent',
  'no_candidate',
  'not_significant',
  'rate_limited',
  'changed',
  'suggested',
  'params_changed',
  'not_tunable',
] as const;

/** A report is due when the last one is at least this old. */
export const ARENA_REPORT_INTERVAL_MS = 30 * 60_000;
/** An agent with no trade in the period gets a short "no trades" report at
 *  most this often, so the stream shows the analysis still runs. */
export const ARENA_QUIET_REPORT_INTERVAL_MS = 2 * 60 * 60_000;
/** At most one automatic param change per agent in this window. */
export const ARENA_AUTO_CHANGE_MIN_GAP_MS = 30 * 60_000;
