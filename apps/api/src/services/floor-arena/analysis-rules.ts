/**
 * The tuner's published numbers and report cadence (docs/trading-floor-arena.md
 * D10 + D27). A
 * module with no imports, so the served manual (`skill-protocol.ts`) can print
 * the same values `analysis.ts` enforces without pulling the engine or the
 * database into the manual's import graph.
 */

/** The old click-to-apply minimum for a MODEL proposal. Since D33 the model
 *  proposes nothing and the code tuner needs MIN_CLOSED_FOR_AUTO_APPLY for
 *  every agent; kept only for the served manual until it drops the number. */
export const MIN_CLOSED_ON_CURRENT_PARAMS = 6;
/** D27/D33: the code tuner changes or suggests nothing before the CURRENT
 *  params have this many closed trades (every agent, auto-apply or not). */
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
/** ...and the share of shuffles whose best edge is at least the observed one
 *  must be at most this (p = (1 + hits) / (1 + EVIDENCE_PERMUTATIONS)). */
export const EVIDENCE_MAX_SEARCH_P = 0.05;

/** A report is due when the last one is at least this old. */
export const ARENA_REPORT_INTERVAL_MS = 30 * 60_000;
/** An agent with no trade in the period gets a short "no trades" report at
 *  most this often, so the stream shows the analysis still runs. */
export const ARENA_QUIET_REPORT_INTERVAL_MS = 2 * 60 * 60_000;
/** At most one automatic param change per agent in this window. */
export const ARENA_AUTO_CHANGE_MIN_GAP_MS = 30 * 60_000;
