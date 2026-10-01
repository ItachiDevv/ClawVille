/**
 * The tuner's published numbers and report cadence (docs/trading-floor-arena.md
 * D10 + D27). A
 * module with no imports, so the served manual (`skill-protocol.ts`) can print
 * the same values `analysis.ts` enforces without pulling the engine or the
 * database into the manual's import graph.
 */

/** No suggestion until the CURRENT params have this many closed trades: a
 *  change must rest on trades that ran under the rules it changes. */
export const MIN_CLOSED_ON_CURRENT_PARAMS = 6;
/** D27: no automatic apply (house tuner, or owner auto-apply) before the
 *  current params have this many closed trades. */
export const MIN_CLOSED_FOR_AUTO_APPLY = 20;
/** D27 split check: the trades the new value keeps and the trades it
 *  excludes each need this many closed trades... */
export const EVIDENCE_MIN_PER_SIDE = 8;
/** ...and the kept side's mean pnl_mult must beat the excluded side's by at
 *  least this much (3 points). */
export const EVIDENCE_MIN_EDGE = 0.03;

/** A report is due when the last one is at least this old. */
export const ARENA_REPORT_INTERVAL_MS = 30 * 60_000;
/** An agent with no trade in the period gets a short "no trades" report at
 *  most this often, so the stream shows the analysis still runs. */
export const ARENA_QUIET_REPORT_INTERVAL_MS = 2 * 60 * 60_000;
/** At most one automatic param change per agent in this window. */
export const ARENA_AUTO_CHANGE_MIN_GAP_MS = 30 * 60_000;
