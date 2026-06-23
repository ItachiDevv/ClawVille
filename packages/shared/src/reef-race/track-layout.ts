/**
 * reef-race-track-layout.ts
 *
 * LOCKED v4 default track for Reef Race — a BIG, WIDE, WINDY CLOSED-LOOP ring of
 * 27 centripetal Catmull-Rom control points winding 360° around a large central
 * island. Consumed by `ReefSpline` (see `./spline.ts`, built with `{ closed: true }`)
 * for both the server sim corridor math AND the client-side 3D river-bed builder.
 * Single source of truth.
 *
 * 2026-06-23 WATER-DOMINANT REBUILD (this version, v4). The founder reviewed the
 * v3 ring (`/preview/reef-race-v2`) and gave art direction: the racing loop read
 * as a NARROW blue creek sitting in the middle of a HUGE unused green LAND disc,
 * with terrain covering parts of the water. "Make the river WIDER, take MORE
 * TURNS, and use the space — most of that land should be windy surfing track."
 *
 * v4 vs v3:
 *   - WIDER corridor: half-width now 471–910 wu (was 290–540). The corridor IS
 *     the water — a proper wide surf channel for 4–8 racers side-by-side +
 *     overtaking lines, not a creek. Start/finish straight hw≈900; sweeping
 *     bends ≈560–700; ess/hairpin ≈480–520.
 *   - BIGGER loop: footprint ≈ 15 400 × 15 300 wu (was ~10 400 × 9 000). The ring
 *     fills the play area the green disc used to waste.
 *   - WINDIER: 12 curvature reversals (was 4) — sweeping bends + a NE S-ess + a
 *     far-west U-hairpin + an upper-NE chicane, varied radii.
 *   - Longer arc: ~53 506 wu (was ~30 434) → race is now 2 LAPS (see
 *     `REEF_RACE_LAPS`), ~4–4.5 min total; per-lap soft timeout scaled up so no
 *     legit racer DNFs (see `REEF_RACE_LOOP_SOFT_TIMEOUT_MS`).
 *
 *   Built as: `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`.
 *   The array is the 27 REAL control points only — do NOT repeat CP[0] at the
 *   end; the periodic wrap is internal to ReefSpline (see spline.ts note #3b).
 *
 * Why a loop: progress `t` is CYCLIC. A lap/finish crossing is a +direction seam
 * crossing (t 0.99→0.01), NOT "t reaches 1". The sim + anti-cheat handle the wrap
 * (cyclic progress delta) — see `reef-race.ts` consumers.
 *
 * ─── Numeric verification (driving the REAL closed ReefSpline) ──────────────
 *
 *   - totalArcLength       = 53505.9 wu                 (need [50000, 56000])
 *   - heading sweep        = +2.0000 π                  (full 360° circumnav.)
 *   - curvature reversals  = 12                          (esses + hairpin = windy)
 *   - min radius of curv.  = 378.7 wu @ t≈0.788 (W hairpin) (need ≥250, floor 192)
 *   - W HAIRPIN: far-west U-turn, apex CP19 XZ≈(-8000,2200), reversal CP19→CP22
 *       over t≈0.725→0.823; tightest carve R≈379 at the CP21 bite (-6900,-300).
 *   - NE ESS: left-right reversal CP6→CP9 (7000,0 → 6000,1300 → 6500,2700 →
 *       7300,4100) over t≈0.253→0.353, hw drops to 480.
 *   - UPPER-NE CHICANE: inner dip CP12 (2600,5800) → CP13 (1700,7200) over
 *       t≈0.46→0.50.
 *   - min adjacent-CP spacing = 1081.7 wu (CP21→CP22)    (need >88, Newton guard)
 *   - min non-adjacent self-distance = 2347.0 wu @ t≈0.761~0.822  (need >88)
 *   - min CORRIDOR CLEARANCE (centerline gap − the two halfWidths at the closest
 *       non-adjacent pass) = 1292.5 wu @ t≈0.432(hw637)~0.492(hw543). This is the
 *       load-bearing WIDE-corridor check: even with the wide corridor the two
 *       sides of the loop never touch — >1290 wu of open water between passes.
 *   - START/FINISH straight: t≈0.00→0.09, corridor hw 860-900 wu, gentle heading
 *       change over the spawn zone → clean spawns + a wide finish gate.
 *   - centerlineAt(0) at XZ=(-2600, -7300) (start/finish line, south).
 *   - footprint X ∈ [-8026, 7401], Z ∈ [-7607, 7700]  (span ≈ 15427 × 15307 wu).
 *   - min inner-edge distance from origin = 5657 wu @ t≈0.286 → a central island
 *       at origin may be up to ~5000 wu radius without overlapping the corridor
 *       (the render uses ISLAND_RADIUS ≈ 4500, leaving >850 wu of clear water).
 *
 *   At REEF_MAX_SPEED = 500 wu/s, full-thrust straight cruise ≈ 496 wu/s and a
 *   realistic average lap pace ≈ 387–427 wu/s (humans) / ~340 wu/s (0.85-thrust
 *   bots). One loop ≈ 125–160 s. A 2-lap race ≈ 4–5 min — within the per-lap
 *   soft budget (REEF_RACE_LOOP_SOFT_TIMEOUT_MS, scaled per lap).
 *
 * ─── 5 themed segments (LOOP-APPROPRIATE — t-ranges, NOT z-ranges) ───────────
 *
 *   The z-range scheme is BROKEN on a loop (z is non-monotonic — the ring goes
 *   north then back south). Segments carry explicit `tStart`/`tEnd` spline-
 *   parameter fractions in [0,1], contiguous around the loop (seg[0].tStart=0,
 *   last seg tEnd=1, seg[i].tStart === seg[i-1].tEnd). The anti-cheat
 *   `buildSegmentTRanges` reads these DIRECTLY (no z-bisection).
 *
 *   Segment            t-range          CPs        Theme / shape
 *   ----------------   --------------   --------    -------------------------
 *   0  lagoon          0.0000–0.0899    CP 0-2     start/finish straight (S, WIDE)
 *   1  kelp            0.0899–0.2533    CP 2-6     SE + east climbing sweep
 *   2  shipwreck       0.2533–0.5326    CP 6-14    NE S-ESS + north sweep + chicane
 *   3  coral           0.5326–0.8230    CP 14-22   NW run + far-west U-HAIRPIN
 *   4  finish          0.8230–1.0000    CP 22-0    SW return run to the start
 *
 *   (CP→t are exact closest-point projections — centripetal parameterisation is
 *   non-uniform; the t-range boundaries are pinned to the CP transitions above.)
 *
 * ─── Top-down schematic (X horizontal ±8000, Z vertical ±7700; island at 0,0) ─
 *
 *                       NORTH sweep (CP13,14)        upper-NE chicane (CP12,13)
 *               CP15 ╮      ╭──────╮       ╭── CP11
 *         CP16 ──╯       CP14│      │CP13──╯      ╲ CP10  (NE ess: CP6-9)
 *        ╱                   ╰──────╯              ╲ CP9
 *    CP17                                           │ CP8 ┐ ess
 *     │                                             │ CP7 ┘
 *   CP18                                            │ CP6
 *   CP19 ◄── W HAIRPIN (far west, t≈0.79)           │ CP5  (east climb)
 *   CP20                                            │ CP4
 *   CP21 ── CP22                                    ╱ CP3
 *      ╲        ╲                                  ╱ CP2
 *      CP23      CP24 ── CP25 ── CP26 ──┐      ╱
 *                          ╔════════════╪═════╪════╗
 *                    CP0 ──╫─ START/FINISH ───╫── CP1  (south straight, t=0, WIDE)
 *                          ╚══════════════════════╝
 *
 * ─── Periodic closure (no phantom CPs) ───────────────────────────────────────
 *
 *   Per `./spline.ts` note #3b, the closed ReefSpline wraps the four-point
 *   Catmull-Rom neighbours around the ring (CP[N-1] and CP[0] are neighbours).
 *   There are N=27 SEGMENTS (the closing chord CP26→CP0 is a real segment), and
 *   centerlineAt(0)===centerlineAt(1) by construction. Authors place only the
 *   27 real CPs; the wrap is added internally. No phantoms, no reflection.
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
  // 2026-06-23 WATER-DOMINANT REBUILD — t-range segments, all verified by
  // driving the real closed spline (see module doc for the full numbers block
  // + schematic). t-boundaries pinned to CP transitions via closest-point t.
  //
  //   lagoon    CP0-2    start/finish straight (south)   WIDE  (900)
  //   kelp      CP2-6    SE + east climbing sweep        wide  (700)
  //   shipwreck CP6-14   NE S-ess + north sweep + chicane mid  (560)
  //   coral     CP14-22  NW run + far-west U-HAIRPIN      tight (520)
  //   finish    CP22-0   SW return run to start          mid→WIDE
  { id: 'lagoon',    tStart: 0.0000, tEnd: 0.0899, halfWidth: 900 },
  { id: 'kelp',      tStart: 0.0899, tEnd: 0.2533, halfWidth: 700 },
  { id: 'shipwreck', tStart: 0.2533, tEnd: 0.5326, halfWidth: 560 },
  { id: 'coral',     tStart: 0.5326, tEnd: 0.8230, halfWidth: 520 },
  { id: 'finish',    tStart: 0.8230, tEnd: 1.0000, halfWidth: 640 },
];

// ─── Track layout ───────────────────────────────────────────────────────────

/**
 * REEF_RACE_DEFAULT_TRACK — locked v4 BIG/WIDE/WINDY CLOSED-LOOP ring, 27 real
 * control points.
 *
 * Coordinate frame: XZ plane (Y is altitude, owned by `body.heightOffset`
 * per spline-architecture §4). The ring winds CCW around the island at (0,0).
 * CP[0] sits on the START/FINISH line on the south straight at (-2600, -7300).
 *
 * Build with `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`. Do
 * NOT append a copy of CP[0] — the periodic wrap is internal to ReefSpline.
 *
 * Field shape matches `SplineControlPoint` exactly. Indices map to the themed
 * segments documented above.
 */
export const REEF_RACE_DEFAULT_TRACK: ReadonlyArray<SplineControlPoint> = [
  // 2026-06-23 WATER-DOMINANT REBUILD — see REEF_RACE_SEGMENTS + module doc.
  // Verified on the real closed spline: arc 53506 wu, heading sweep +2π,
  // min R 378.7 (W hairpin), 12 curvature reversals, min self-distance 2347,
  // min corridor clearance 1292, min CP spacing 1082, width 471-910.

  // ── Segment 0: lagoon — START/FINISH STRAIGHT (south, WIDE) ───────────────
  { x: -2600, z: -7300, halfWidth: 900 }, // CP  0  START/FINISH line (t=0)
  { x:   300, z: -7600, halfWidth: 900 }, // CP  1  straight
  { x:  3100, z: -7400, halfWidth: 860 }, // CP  2  straight end → SE turn-in

  // ── Segment 1: kelp — SE + east climbing sweep (wide) ─────────────────────
  { x:  5500, z: -6300, halfWidth: 700 }, // CP  3  SE sweep
  { x:  6900, z: -4300, halfWidth: 680 }, // CP  4  east climb
  { x:  7400, z: -2100, halfWidth: 660 }, // CP  5  far east
  { x:  7000, z:     0, halfWidth: 560 }, // CP  6  east apex → ess entry

  // ── Segment 2: shipwreck — NE S-ESS + north sweep + chicane (mid) ─────────
  { x:  6000, z:  1300, halfWidth: 480 }, // CP  7  ess left
  { x:  6500, z:  2700, halfWidth: 480 }, // CP  8  ess reversal (right)
  { x:  7300, z:  4100, halfWidth: 560 }, // CP  9  ess exit
  { x:  6400, z:  5500, halfWidth: 620 }, // CP 10  NE sweep
  { x:  4400, z:  6100, halfWidth: 640 }, // CP 11  north-east bend
  { x:  2600, z:  5800, halfWidth: 600 }, // CP 12  chicane inner dip
  { x:  1700, z:  7200, halfWidth: 540 }, // CP 13  chicane apex (out)
  { x:  -100, z:  7700, halfWidth: 560 }, // CP 14  north apex → coral

  // ── Segment 3: coral — NW run + far-west U-HAIRPIN (tight) ────────────────
  { x: -2200, z:  7200, halfWidth: 620 }, // CP 15  NW sweep
  { x: -4200, z:  6600, halfWidth: 600 }, // CP 16  NW run
  { x: -6200, z:  5800, halfWidth: 540 }, // CP 17  NW descent
  { x: -7500, z:  4100, halfWidth: 500 }, // CP 18  hairpin approach
  { x: -8000, z:  2200, halfWidth: 480 }, // CP 19  HAIRPIN apex (far west)
  { x: -7800, z:   300, halfWidth: 480 }, // CP 20  hairpin pinch
  { x: -6900, z:  -300, halfWidth: 500 }, // CP 21  hairpin bite (tightest carve)
  { x: -6900, z: -1900, halfWidth: 520 }, // CP 22  hairpin exit → finish run

  // ── Segment 4: finish — SW return run to start straight ───────────────────
  { x: -7600, z: -3600, halfWidth: 560 }, // CP 23  SW return
  { x: -7300, z: -5300, halfWidth: 640 }, // CP 24  SW return
  { x: -6100, z: -6500, halfWidth: 740 }, // CP 25  SW sweep widening
  { x: -4400, z: -7100, halfWidth: 820 }, // CP 26  → closing chord to CP0 (wide)
];

/**
 * Compile-time sanity: 27 real control points exactly (was 20 in the v3
 * closed-loop ring, 19 OPEN before that). The closing chord CP26→CP0 is the
 * 27th SEGMENT, added internally by ReefSpline's periodic wrap.
 */
export const REEF_RACE_DEFAULT_TRACK_LENGTH = 27 as const;

/**
 * Verified total arc length of the closed ring (wu), driving the real
 * `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`. Exported so the
 * sim/anti-cheat can avoid re-constructing the spline just to read the length.
 * INCLUDES the closing chord. Re-verify if any CP changes.
 */
export const REEF_RACE_DEFAULT_TRACK_ARC_LENGTH = 53505.9 as const;
