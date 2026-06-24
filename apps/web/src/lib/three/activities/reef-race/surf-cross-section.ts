/**
 * surf-cross-section.ts — the WATERTIGHT cross-section contract shared by
 * `surf-ribbon.tsx` (water) and `canyon-river.tsx` (rock walls + shoulders).
 *
 * ─── Why this file exists (the hole bug) ─────────────────────────────────────
 * The water surface heaves (Gerstner wave displacement) while the canyon wall
 * inner base sits at the static banked corridor edge (`elevationAtT(t)`). If the
 * water edge moves up/down independently of the rock, a crest lifts water ABOVE
 * the rock base (gap below) and a trough drops it BELOW (gap above) — a visible
 * hole to the void at the seam, on either bank, through every climb/dip/bank.
 *
 * The fix is a two-part contract both files import from HERE so they can never
 * drift:
 *
 *   1. WATER_EDGE_TAPER_WU — the water shader tapers its vertical wave
 *      displacement to ZERO within this lateral band of each bank (UV.x near
 *      0 and 1). So the water's OUTER edge vertices sit EXACTLY on the static
 *      banked datum `elevationAtT(t)` — the same line the canyon inner base
 *      uses. The waves still heave fully across the open channel; they just
 *      pin to the datum where they meet the rock. This alone closes the seam.
 *
 *   2. WATER_SEAL_DROP_WU — belt-and-suspenders: the canyon wall inner base
 *      (v0 of the cliff cross-section) drops this many wu BELOW the datum, so
 *      the rock forms a submerged lip UNDER the waterline. Even if a numerical
 *      edge case (bank lean × wave residual) nudged the water edge a hair off
 *      the datum, the rock lip is already below it — no light leaks through.
 *
 * Both constants are consumed identically on BOTH banks at EVERY longitudinal
 * sample, so the seal holds across the full closed loop regardless of elevation
 * grade or bank angle.
 *
 * @module surf-cross-section
 */

/**
 * Lateral band (in UV.x units, 0..0.5 from each bank) over which the water's
 * vertical wave displacement tapers from FULL (open channel) to ZERO (at the
 * very bank). 0.10 means the outer 10% of the half-channel pins to the datum.
 *
 * Tuned so the taper is wide enough that the pinning is gentle (no visible
 * crease where waves meet the rock) but narrow enough that the surfable middle
 * of the channel still heaves with full wave amplitude.
 */
export const WATER_EDGE_TAPER = 0.1;

/**
 * How far (wu) the canyon wall inner base descends BELOW the static banked datum
 * to form a submerged sealing lip under the waterline. Must exceed any plausible
 * residual gap between the (tapered-to-datum) water edge and the rock. 40wu is
 * generous against the ~0wu the taper already guarantees, and is hidden under
 * the water surface so it never reads as a visible rock ledge.
 */
export const WATER_SEAL_DROP = 40;
