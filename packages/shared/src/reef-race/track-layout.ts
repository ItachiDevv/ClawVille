/**
 * reef-race-track-layout.ts
 *
 * LOCKED v3 default track for Reef Race — a CLOSED-LOOP ring of 20 centripetal
 * Catmull-Rom control points winding 360° around a central island. Consumed by
 * `ReefSpline` (see `./spline.ts`, built with `{ closed: true }`) for both the
 * server sim corridor math AND the client-side 3D river-bed builder. Single
 * source of truth.
 *
 * 2026-06-22 CLOSED-LOOP REBUILD (this version): the prior v2 track was an OPEN
 * dead-straight-z slalom (z monotonically 0→28000). The rebuild replaces it
 * with a true closed ring — the race now LOOPS (t wraps 1→0 at the seam) rather
 * than running point-to-point. The ring winds CCW around the island at (0,0):
 * a wide START/FINISH STRAIGHT at the south, sweeping bends up the east + over
 * the north, an S-CHICANE on the northwest, and a tight-but-carveable HAIRPIN
 * on the far west, then a return run back to the start straight.
 *
 *   Built as: `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`.
 *   The array is the 20 REAL control points only — do NOT repeat CP[0] at the
 *   end; the periodic wrap is internal to ReefSpline (see spline.ts note #3b).
 *
 * Why a loop: progress `t` is now CYCLIC. A lap/finish crossing is a +direction
 * seam crossing (t 0.99→0.01), NOT "t reaches 1". The sim + anti-cheat handle
 * the wrap (cyclic progress delta) — see `reef-race.ts` consumers.
 *
 * ─── Numeric verification (driving the REAL closed ReefSpline) ──────────────
 *
 *   - totalArcLength       = 30434.3 wu                  (need [28000, 31000])
 *   - heading sweep        = +2.0000 π                   (full 360° circumnav.)
 *   - curvature reversals  = 4                           (chicane + hairpin)
 *   - min radius of curv.  = 304.0 wu @ t≈0.775 (hairpin) (need ≥250, floor 192)
 *   - HAIRPIN: R≈304 @ tip XZ≈(-5061,1006); 136° heading reversal over t≈0.62→0.80
 *   - CHICANE: left-right reversal at t≈0.55→0.61 (R dips to ~1178 then back)
 *   - min adjacent-CP spacing = 608.3 wu (CP14→CP15)     (need >88, Newton guard)
 *   - min non-adjacent self-distance = 432.0 wu @ t≈0.763~0.787  (need >88)
 *   - START/FINISH straight: t≈0.00→0.11, corridor 540-568 wu, heading change
 *       only ~21° over the spawn zone (t=0..0.07) → clean spawns + finish gate.
 *   - centerlineAt(0) at XZ=(-1600, -4300) (start/finish line, south).
 *
 *   At REEF_MAX_SPEED = 500 wu/s and ~330 wu/s effective cruise, one loop time
 *   ≈ 30434 / 330 ≈ 92 s — matches the 90s soft-timeout + grace window
 *   (REEF_SOFT_TIMEOUT_MS=90000 + REEF_STRAGGLER_GRACE_MS=30000).
 *
 * ─── 5 themed segments (LOOP-APPROPRIATE — t-ranges, NOT z-ranges) ───────────
 *
 *   The old z-range scheme is BROKEN on a loop (z is non-monotonic — the ring
 *   goes north then back south). Segments now carry explicit `tStart`/`tEnd`
 *   spline-parameter fractions in [0,1], contiguous around the loop
 *   (seg[0].tStart=0, last seg tEnd=1, seg[i].tStart === seg[i-1].tEnd). The
 *   anti-cheat `buildSegmentTRanges` reads these DIRECTLY (no z-bisection).
 *
 *   Segment            t-range          CPs        Theme / shape
 *   ----------------   --------------   --------    -------------------------
 *   0  lagoon          0.0000–0.1110    CP 0,1,2    start/finish straight (S)
 *   1  kelp            0.1110–0.3482    CP 2-6      SE + east climbing sweep
 *   2  shipwreck       0.3482–0.6105    CP 6-11     north sweep + NW chicane
 *   3  coral           0.6105–0.8097    CP 11-16    far-west HAIRPIN
 *   4  finish          0.8097–1.0000    CP 16-0     SW return run to start
 *
 *   (CP→t are approximate — centripetal parameterisation is non-uniform; the
 *   t-range boundaries are pinned to the CP transitions above.)
 *
 * ─── Top-down schematic (X horizontal ±5200, Z vertical ±4500; island at 0,0)─
 *
 *                       NORTH sweep (CP7,8)
 *               CP9 ╮          ╭──────╮
 *          chicane  ╰─ CP10 ─╮ │      │ CP6
 *           CP11 ──╯         ╰─╯       ╲
 *          ╱                            ╲ CP5  (east climb)
 *     CP12 (hairpin approach)            │
 *      │                                 │ CP4
 *   CP13                                 │
 *   CP14 ◄── HAIRPIN tip (far west)      ╱ CP3
 *   CP15                               ╱
 *      │                             ╱
 *   CP16 (exit)                    ╱
 *       ╲                        ╱  CP2
 *        CP17 ── CP18 ── CP19 ──┤
 *                      ╔════════╪════════╗
 *                CP0 ──╫── START/FINISH ─╫── CP1   (south straight, t=0)
 *                      ╚═════════════════╝
 *
 * ─── Periodic closure (no phantom CPs) ───────────────────────────────────────
 *
 *   Per `./spline.ts` note #3b, the closed ReefSpline wraps the four-point
 *   Catmull-Rom neighbours around the ring (CP[N-1] and CP[0] are neighbours).
 *   There are N=20 SEGMENTS (the closing chord CP19→CP0 is a real segment), and
 *   centerlineAt(0)===centerlineAt(1) by construction. Authors place only the
 *   20 real CPs; the wrap is added internally. No phantoms, no reflection.
 *
 * @module reef-race-track-layout
 */

import type { SplineControlPoint } from './spline';

// ─── Themed segment t-range helpers ─────────────────────────────────────────
//
// Exported so the visual track builder + obstacle placer + anti-cheat can ask
// "what segment am I in" by spline parameter t and theme/score accordingly.
// Keep these in lock-step with the table in the module doc above.

export interface ReefRaceSegmentRange {
  readonly id: 'lagoon' | 'kelp' | 'shipwreck' | 'coral' | 'finish';
  /**
   * Inclusive lower-bound spline parameter for this segment (t ∈ [0,1]).
   * Contiguous around the loop: seg[0].tStart === 0, and
   * seg[i].tStart === seg[i-1].tEnd.
   */
  readonly tStart: number;
  /**
   * Exclusive upper-bound spline parameter for this segment (t ∈ [0,1]).
   * The last segment's tEnd === 1 (the seam, == t=0).
   */
  readonly tEnd: number;
  /**
   * Designer-intent half-width for the segment (wu). The actual sim half-width
   * is the Catmull-Rom interpolation of the per-CP `halfWidth` values; this
   * field is the spec value for documentation + obstacle placement.
   */
  readonly halfWidth: number;
}

export const REEF_RACE_SEGMENTS: ReadonlyArray<ReefRaceSegmentRange> = [
  // 2026-06-22 CLOSED-LOOP REBUILD — t-range segments (z-range scheme retired;
  // z is non-monotonic on a loop). Boundaries pinned to CP transitions, all
  // verified by driving the real closed spline. See module doc for the full
  // verified-numbers block + schematic.
  //
  //   lagoon    CP0-2   start/finish straight (south)   wide  (540)
  //   kelp      CP2-6   SE + east climbing sweep        tight (290)
  //   shipwreck CP6-11  north sweep + NW chicane         tight (290)
  //   coral     CP11-16 far-west HAIRPIN                 tight (290)
  //   finish    CP16-0  SW return run to start          tight→wide
  { id: 'lagoon',    tStart: 0.0000, tEnd: 0.1110, halfWidth: 540 },
  { id: 'kelp',      tStart: 0.1110, tEnd: 0.3482, halfWidth: 290 },
  { id: 'shipwreck', tStart: 0.3482, tEnd: 0.6105, halfWidth: 290 },
  { id: 'coral',     tStart: 0.6105, tEnd: 0.8097, halfWidth: 290 },
  { id: 'finish',    tStart: 0.8097, tEnd: 1.0000, halfWidth: 290 },
];

// ─── Track layout ───────────────────────────────────────────────────────────

/**
 * REEF_RACE_DEFAULT_TRACK — locked v3 CLOSED-LOOP ring, 20 real control points.
 *
 * Coordinate frame: XZ plane (Y is altitude, owned by `body.heightOffset`
 * per spline-architecture §4). The ring winds CCW around the island at (0,0).
 * CP[0] sits on the START/FINISH line on the south straight at (-1600, -4300).
 *
 * Build with `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`. Do
 * NOT append a copy of CP[0] — the periodic wrap is internal to ReefSpline.
 *
 * Field shape matches `SplineControlPoint` exactly. Indices map to the themed
 * segments documented above.
 */
export const REEF_RACE_DEFAULT_TRACK: ReadonlyArray<SplineControlPoint> = [
  // 2026-06-22 CLOSED-LOOP REBUILD — see REEF_RACE_SEGMENTS + module doc.
  // Verified on the real closed spline: arc 30434 wu, heading sweep +2π,
  // min R 304 (hairpin), 4 curvature reversals (chicane+hairpin), min self-
  // distance 432, min CP spacing 608.

  // ── Segment 0: lagoon — START/FINISH STRAIGHT (south, wide) ───────────────
  { x: -1600, z: -4300, halfWidth: 540 }, // CP  0  START/FINISH line (t=0)
  { x:   200, z: -4480, halfWidth: 540 }, // CP  1  straight
  { x:  2000, z: -4350, halfWidth: 540 }, // CP  2  straight end → SE turn-in

  // ── Segment 1: kelp — SE + east climbing sweep (tight) ────────────────────
  { x:  3900, z: -3500, halfWidth: 290 }, // CP  3  SE sweep
  { x:  4900, z: -1700, halfWidth: 290 }, // CP  4  east climb
  { x:  5100, z:   350, halfWidth: 290 }, // CP  5  far east
  { x:  4500, z:  2300, halfWidth: 290 }, // CP  6  east → north

  // ── Segment 2: shipwreck — north sweep + NW S-CHICANE (tight) ─────────────
  { x:  3050, z:  3750, halfWidth: 290 }, // CP  7  north sweep
  { x:  1150, z:  4400, halfWidth: 290 }, // CP  8  north apex
  { x:  -300, z:  4050, halfWidth: 290 }, // CP  9  CHICANE left
  { x: -1100, z:  3050, halfWidth: 290 }, // CP 10  chicane reversal (bite)
  { x: -2400, z:  3250, halfWidth: 290 }, // CP 11  chicane exit

  // ── Segment 3: coral — far-west HAIRPIN (out-and-back, tight) ─────────────
  { x: -3900, z:  2600, halfWidth: 290 }, // CP 12  hairpin approach (NW)
  { x: -4750, z:  1750, halfWidth: 290 }, // CP 13  hairpin entry
  { x: -5050, z:  1150, halfWidth: 290 }, // CP 14  hairpin tip (far west)
  { x: -4950, z:   550, halfWidth: 290 }, // CP 15  hairpin pinch-back
  { x: -4350, z:   150, halfWidth: 290 }, // CP 16  hairpin exit → finish run

  // ── Segment 4: finish — SW return run to start straight ───────────────────
  { x: -3500, z: -1100, halfWidth: 290 }, // CP 17  SW return
  { x: -3000, z: -2600, halfWidth: 290 }, // CP 18  SW return
  { x: -2400, z: -3700, halfWidth: 290 }, // CP 19  → closing chord to CP0
];

/**
 * Compile-time sanity: 20 real control points exactly (was 19 OPEN before the
 * 2026-06-22 closed-loop rebuild). The closing chord CP19→CP0 is the 20th
 * SEGMENT, added internally by ReefSpline's periodic wrap.
 */
export const REEF_RACE_DEFAULT_TRACK_LENGTH = 20 as const;

/**
 * Verified total arc length of the closed ring (wu), driving the real
 * `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`. Exported so the
 * sim/anti-cheat can avoid re-constructing the spline just to read the length.
 * INCLUDES the closing chord. Re-verify if any CP changes.
 */
export const REEF_RACE_DEFAULT_TRACK_ARC_LENGTH = 30434.3 as const;
