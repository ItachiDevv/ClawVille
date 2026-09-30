/**
 * The tuner's published numbers (docs/trading-floor-arena.md D10 + D27). A
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
