/**
 * reef-race-track-layout.ts
 *
 * LOCKED v2 default track for Reef Race — 19 control-point centripetal
 * Catmull-Rom slalom river. Consumed by `ReefSpline` (see `./spline.ts`) for
 * both the server sim corridor math AND the client-side 3D river-bed builder.
 * Single source of truth.
 *
 * 2026-06-01 STEERING-MANDATORY RE-TUNE (this version): the prior layout's
 * slalom amplitudes (±300/±340/±300) were SMALLER than the local halfWidths
 * (480/440/400), so the x=0 axis stayed inside the corridor at every peak — a
 * kart driving dead-straight finished with zero wall contact on a path ~8.6%
 * SHORTER than the meander, making the slalom pointless (carve-skill premise
 * inverted; bots that follow the meander were systematically slower). Fixed by
 * raising amplitude ABOVE halfWidth at every slalom CP (A−W = +150..+170) and
 * lowering halfWidth to 290, so a straight x=0 line now EXITS the corridor by
 * +256.5 wu at its worst peak. Wavelength lengthened (kelp 7→6, wreck 5→4,
 * coral 5→4 CPs; CP count 22→19) so the min radius of curvature is 455.7 wu
 * (>> the 192 wu MAX_SPEED/TURN_RATE floor) and the arc stays at 30957 wu
 * (inside [28000, 31500]). All numbers verified by driving the real spline.
 *
 * 2026-04-30 90s rebuild (superseded): track lengthened 18 000 → 28 000 wu
 * z-span via CP-insertion with too-wide corridors.
 *
 * ─── 5 themed segments ──────────────────────────────────────────────────────
 *
 *   Segment            z-range (wu)        CPs          halfWidth   Slalom A
 *   ----------------   -----------------   ----------   ---------   --------
 *   0  Open lagoon       0 →  3 000        CP 0,1,2      540 wu     none
 *   1  Kelp forest     3 000 → 12 100      CP 3-8        290 wu     ±440 wu
 *   2  Shipwreck      12 100 → 19 600      CP 9-12       290 wu     ±460 wu
 *   3  Coral canyon   19 600 → 26 100      CP 13-16      290 wu     ±440 wu
 *   4  Finish straight 26 100 → 28 000     CP 17,18      540 wu     none
 *
 *   Amplitude > halfWidth at EVERY slalom CP → the x=0 axis is OUTSIDE the
 *   corridor at the peaks → steering is MANDATORY (no straight bypass).
 *
 * ─── Numeric verification (driving the real ReefSpline) ─────────────────────
 *
 *   - totalArcLength = 30957.3 wu                          (need [28000, 31500])
 *   - straight x=0 path: max(distance − halfWidth) = +256.5 wu @ z≈12917
 *       → walls ENGAGE (steering required; the bug this fixes was −97.8 wu)
 *   - min radius of curvature = 455.7 wu                    (need ≥192, ≳250)
 *   - min adjacent-CP spacing = 750 wu                      (need >88, Newton)
 *   - z strictly monotonic; corridor 580 wu ≈ 13 kart-widths (radius 22)
 *
 *   Slalom waveform: alternating sign per CP within a segment, with a
 *   same-side HANDOFF across segment boundaries (kelp ends −440, wreck starts
 *   −460; wreck ends +460, coral starts +440) so the transition is a gentle
 *   deepening rather than a hard fold — that keeps the arc under the ceiling
 *   while the within-segment peaks still wall off the straight line.
 *
 *   At REEF_MAX_SPEED = 500 wu/s and ~330 wu/s effective cruise, one-shot race
 *   time ≈ 30957 / 330 ≈ 94 s — matches the 90s soft-timeout + grace window.
 *
 * ─── Top-down schematic (X horizontal ±460, Z down 0→28000) ─────────────────
 *
 *   The corridor (halfWidth 290) is drawn as the band around the centerline
 *   `C`. The x=0 axis (`:`) shows the illegal "dead-straight" path — note it
 *   leaves the band at every slalom peak, which is the whole point.
 *
 *     X:  -460 ........ 0 ........ +460
 *
 *      [=====:=====]            z=0      CP0  start  (x=0)
 *      [=====:=====]            z=3000   CP2  lagoon→kelp gate
 *            : [===C===]        z=4400   CP3  kelp +440   (axis x=0 OUTSIDE)
 *      [===C===] :              z=5940   CP4  kelp −440
 *            : [===C===]        z=7480   CP5  kelp +440
 *        ...alternating ±440 through CP8 (−440) ...
 *      [===C===] :              z=13700  CP9  wreck −460  (handoff: stays L)
 *            : [===C===]        z=15670  CP10 wreck +460
 *        ...alternating ±460 through CP12 (+460) ...
 *            : [===C===]        z=21000  CP13 coral +440  (handoff: stays R)
 *        ...alternating ±440 through CP16 (−440) ...
 *      [=====:=====]            z=27250  CP17 finish entry (x=0)
 *      [=====:=====]            z=28000  CP18 FINISH       (x=0)
 *
 *   The slalom alternates ±X to force left-right racing-line decisions; the
 *   lagoon and finish are dead-straight on the X=0 axis for clean spawn/finish
 *   gates. Because amplitude (440/460) > halfWidth (290), the X=0 axis is
 *   walled off on every slalom peak → there is NO straight bypass.
 *
 * ─── Phantom control points ─────────────────────────────────────────────────
 *
 *   Per `./spline.ts` design note #3, phantom CPs at t=0 and t=1 are computed
 *   AUTOMATICALLY by the ReefSpline constructor by reflecting CP[1] across
 *   CP[0] and CP[N-2] across CP[N-1]. Authors of this layout do NOT include
 *   phantoms in the array — only the 19 real interior CPs.
 *
 *   To verify the start-line tangent points "down-track" (+Z), we keep
 *   CP[0]=(0,0) and CP[1]=(0,1500): the reflection produces phantom_start
 *   at (0,-1500), so the t=0 tangent is exactly +Z. Same logic at the
 *   finish (CP17=(0,27250), CP18=(0,28000) → phantom_end at (0,28750)).
 *
 * @module reef-race-track-layout
 */

import type { SplineControlPoint } from './spline';

// ─── Themed segment z-range helpers ─────────────────────────────────────────
//
// Exported so the visual track builder + obstacle placer can ask "what
// segment am I in" by arc-distance and theme its meshes accordingly.
// Keep these in lock-step with the table above.

export interface ReefRaceSegmentRange {
  readonly id: 'lagoon' | 'kelp' | 'shipwreck' | 'coral' | 'finish';
  /** Inclusive lower bound on z (wu). */
  readonly zStart: number;
  /** Exclusive upper bound on z (wu). */
  readonly zEnd: number;
  /** Designer-intent half-width for the segment (wu). The actual sim half-width
   * is the Catmull-Rom interpolation of the per-CP `halfWidth` values; this
   * field is the spec value for documentation + obstacle placement. */
  readonly halfWidth: number;
}

export const REEF_RACE_SEGMENTS: ReadonlyArray<ReefRaceSegmentRange> = [
  // 2026-06-01 STEERING-MANDATORY RE-TUNE (supersedes the first 2026-06-01
  // "tighten"): the prior tighten was a NO-OP because the slalom amplitudes
  // (±300/±340/±300) were SMALLER than the local halfWidths (480/440/400), so
  // the x=0 axis stayed INSIDE the corridor at every peak — a kart driving
  // dead-straight finished the whole track with ZERO wall contact, and that
  // straight path is ~8.6% SHORTER than the meander (28000 vs 30628 wu), so
  // ignoring the slalom was strictly optimal (carve-skill premise inverted).
  //
  // FIX (verified numerically by driving the real spline, audit-style):
  //   - Amplitude > halfWidth at every slalom CP (A−W = +150..+170), AND the
  //     spline-smoothed swing clears the wall so a straight x=0 line exits the
  //     corridor by +256.5 wu at its worst peak → steering is MANDATORY.
  //   - Wavelength lengthened (kelp 7→6 CPs Δz≈1820, shipwreck 5→4 Δz≈1967,
  //     coral 5→4 Δz≈1700) so min radius of curvature = 455.7 wu (>> the
  //     192 wu floor MAX_SPEED/TURN_RATE), i.e. a clean carve at REEF_MAX_SPEED
  //     can hold the line — AND so the higher amplitude doesn't blow the arc:
  //     totalArcLength = 30957 wu, inside [28000, 31500].
  //   - halfWidth 290 on every slalom segment → 580 wu corridor ≈ 13 kart-
  //     widths (kart radius 22 → ~44 width); well above the ~250 wu navigable
  //     floor so bots/players still fit through the chicanes.
  //   - CP count drops 22→19 (lengthened wavelength). REEF_RACE_DEFAULT_TRACK_LENGTH
  //     + the layout test's CP-count assertion updated in the same diff.
  //   See the per-CP table + the straight-line-exit regression test for proof.
  //
  // 2026-04-30 (superseded): 90s rebuild via CP-INSERTION, half-widths from
  // iter-9 (×1.5 widening).
  { id: 'lagoon',    zStart:     0, zEnd:  3000, halfWidth: 540 },
  { id: 'kelp',      zStart:  3000, zEnd: 12100, halfWidth: 290 },
  { id: 'shipwreck', zStart: 12100, zEnd: 19600, halfWidth: 290 },
  { id: 'coral',     zStart: 19600, zEnd: 26100, halfWidth: 290 },
  { id: 'finish',    zStart: 26100, zEnd: 28000, halfWidth: 540 },
];

// ─── Track layout ───────────────────────────────────────────────────────────

/**
 * REEF_RACE_DEFAULT_TRACK — locked v2 layout, 19 interior control points.
 *
 * Coordinate frame: XZ plane (Y is altitude, owned by `body.heightOffset`
 * per spline-architecture §4). CP[0] at origin (z=0). Track extends in
 * +Z direction to z=28 000. X meanders within ±440–±460 wu for the slalom
 * segments and snaps to 0 on the lagoon/finish straights.
 *
 * Indices map 1:1 to the themed segments documented above. Field shape
 * matches `SplineControlPoint` exactly — passed straight to
 * `new ReefSpline(REEF_RACE_DEFAULT_TRACK)`.
 */
export const REEF_RACE_DEFAULT_TRACK: ReadonlyArray<SplineControlPoint> = [
  // 2026-06-01 STEERING-MANDATORY RE-TUNE — see REEF_RACE_SEGMENTS note above.
  // amplitude > halfWidth at every slalom CP so a straight x=0 line is WALLED
  // OFF (exits corridor by +256.5 wu at worst); wavelength lengthened so the
  // meander's min radius of curvature (455.7 wu) stays carve-able at
  // REEF_MAX_SPEED and the arc lands at 30957 wu (inside [28000, 31500]).
  // The slalom uses a "same-side handoff" at the kelp→wreck and wreck→coral
  // boundaries (e.g. kelp ends -440, wreck starts -460) so the transition is a
  // gentle deepening, not a hard fold — this keeps the arc under the ceiling.
  //
  // Per-CP A vs halfWidth (A = |x|, W = halfWidth):
  //   kelp  A=440 W=290 → A−W=+150     wreck A=460 W=290 → A−W=+170
  //   coral A=440 W=290 → A−W=+150
  //
  // ── Segment 0: Open lagoon (wide, no slalom) ──────────────────────────────
  { x:    0, z:     0, halfWidth: 540 }, // CP  0  start line, lagoon mouth
  { x:    0, z:  1500, halfWidth: 540 }, // CP  1  lagoon middle
  { x:    0, z:  3000, halfWidth: 540 }, // CP  2  lagoon → kelp gate

  // ── Segment 1: Kelp forest (first slalom, ±440 wu, 6 CPs, Δz≈1820) ─────────
  { x:  440, z:  4400, halfWidth: 290 }, // CP  3  kelp curve +
  { x: -440, z:  5940, halfWidth: 290 }, // CP  4  kelp curve -
  { x:  440, z:  7480, halfWidth: 290 }, // CP  5  kelp curve +
  { x: -440, z:  9020, halfWidth: 290 }, // CP  6  kelp curve -
  { x:  440, z: 10560, halfWidth: 290 }, // CP  7  kelp curve +
  { x: -440, z: 12100, halfWidth: 290 }, // CP  8  kelp → shipwreck gate (-)

  // ── Segment 2: Shipwreck graveyard (±460 wu, 4 CPs, Δz≈1967) ──────────────
  // Starts -460 (kelp ended -440): same-side deepening, not a fold.
  { x: -460, z: 13700, halfWidth: 290 }, // CP  9  hull-fragment chicane -
  { x:  460, z: 15670, halfWidth: 290 }, // CP 10  hull-fragment chicane +
  { x: -460, z: 17640, halfWidth: 290 }, // CP 11  hull-fragment chicane -
  { x:  460, z: 19600, halfWidth: 290 }, // CP 12  shipwreck → coral gate (+)

  // ── Segment 3: Coral canyon (±440 wu, 4 CPs, Δz≈1700) ─────────────────────
  // Starts +440 (wreck ended +460): same-side handoff.
  { x:  440, z: 21000, halfWidth: 290 }, // CP 13  coral chicane +
  { x: -440, z: 22700, halfWidth: 290 }, // CP 14  coral chicane -
  { x:  440, z: 24400, halfWidth: 290 }, // CP 15  coral chicane +
  { x: -440, z: 26100, halfWidth: 290 }, // CP 16  coral → finish gate

  // ── Segment 4: Finish straight (wide, no slalom) ──────────────────────────
  { x:    0, z: 27250, halfWidth: 540 }, // CP 17  finish-straight entry
  { x:    0, z: 28000, halfWidth: 540 }, // CP 18  FINISH LINE
];

/**
 * Compile-time sanity: 19 control points exactly (was 22 before the
 * 2026-06-01 steering-mandatory re-tune lengthened the slalom wavelength).
 */
export const REEF_RACE_DEFAULT_TRACK_LENGTH = 19 as const;
