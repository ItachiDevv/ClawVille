/**
 * reef-race-track-layout.ts
 *
 * LOCKED v6 "WIDE SURF ROAD" default track for Reef Race — an aggressively
 * twisty Rainbow-Road-style CLOSED-LOOP circuit of 32 centripetal Catmull-Rom
 * control points, now WIDE ENOUGH for real 4-player side-by-side racing with
 * overtaking + surf room. The track is a GLOWING FLOATING WATER RIBBON winding
 * through an abstract cosmic void — there is NO land, NO island, NO ground
 * beneath it. Consumed by `ReefSpline` (see `./spline.ts`, built with
 * `{ closed: true }`) for both the server sim corridor math AND the client-side
 * 3D ribbon builder. Single source of truth.
 *
 * 2026-06-23 "WIDE SURF ROAD" REBUILD (this version, v6). The founder: "The
 * river is WAY TOO THIN, not nearly enough for 4 players. It needs to be rebuilt
 * … Redesign if you have to. ENLARGE the ring if needed to keep clearance."
 *
 * v6 vs v5 (the narrow Rainbow-Road ribbon):
 *   - WIDE FOR 4+ PLAYERS (WIDENED post-v6 per founder: "river still thin"):
 *     corridor half-width 1144–1609 wu → water surface 2289–3219 wu WIDE
 *     (was 738–1038 wu / 1476–2077 wu in the initial v6; now ×1.55 scaled for
 *     Mario-Kart roomy racing). Even the NARROWEST point fits 26 sim bodies
 *     (REEF_BODY_RADIUS=22 → 44 wu diameter) side-by-side — far past the
 *     founder's 4-board target, with aggressive overtaking + surf room.
 *   - THE WALL-CLAMP FIX (the load-bearing geometric truth): a road of
 *     half-width hw can only carve a corner of radius R if R − hw > the carve
 *     floor (192 wu); otherwise no racing line fits inside the corridor and the
 *     sim's outward-velocity wall scrub STALLS the kart (the v5 trap — see
 *     `[[surf-road-track-v5]]`). At hw≈800 that needs R > ~992. A WIDE river
 *     therefore CANNOT have pinhead chicanes/hairpins — every turn must be a
 *     BROAD sweeping bend. The v6 ring is a wavy circle (radius = 12 800 +
 *     harmonics 2,3,5,7) so every corner is broad: min radius 2087 wu, leaving
 *     a CARVE MARGIN of 1282 wu (R − hw) at the tightest point — wall-clamp is
 *     now geometrically impossible. The aggressive zig-zag comes from 30
 *     curvature reversals (was 26) of broad alternating sweeps over a huge
 *     footprint, not from tight corners.
 *   - SPRAWLS: footprint ≈ 30 648 × 25 926 wu (was ~17 687 × 16 941). Uses the
 *     space — a Mario-Kart-scale circuit.
 *   - ELEVATION (render-only): the SAME `reefTrackElevationAt(t)` /
 *     `reefTrackBankAngleAt(t)` profile (Y span ≈ 1634 wu). Because the arc is
 *     now longer (88 052 vs 60 257), the max grade DROPS to 14.8 % (was 29 %) —
 *     even gentler climbs, karts stay glued to the ribbon. The profile is
 *     t-parameterised (periodic in t), so it is arc-agnostic and unchanged.
 *   - Banking: `reefTrackBankAngleAt(t)` (render-only) tilts the ribbon into
 *     turns proportional to signed curvature. Unchanged.
 *
 *   Built as: `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`.
 *   The array is the 32 REAL control points only — do NOT repeat CP[0] at the
 *   end; the periodic wrap is internal to ReefSpline (see spline.ts note #3b).
 *
 * Why a loop: progress `t` is CYCLIC. A lap/finish crossing is a +direction seam
 * crossing (t 0.99→0.01), NOT "t reaches 1". The sim + anti-cheat handle the wrap
 * (cyclic progress delta) — see `reef-race.ts` consumers.
 *
 * ─── ELEVATION IS RENDER-ONLY (the load-bearing parity contract) ────────────
 *
 *   The server sim is 2D (XZ plane). `reefTrackElevationAt(t)` and
 *   `reefTrackBankAngleAt(t)` are RENDER-ONLY: the 3D scene lifts/tilts the
 *   track ribbon, the rider group AND the chase-cam eye/target/lookAt by the
 *   SAME elevation(t)+bank(t), so the surfer always rides ON the ribbon and the
 *   camera frames it through climbs/drops. The sim NEVER reads these — laps,
 *   finish, collision, position, anti-cheat are all unchanged. This keeps the
 *   "camera + racing content + sim share one vertical datum" invariant: the
 *   datum is now a SHARED FUNCTION of t instead of a flat plane. Per-body
 *   `heightOffset` (jump/ramp airborne metres) is ADDED on top of this.
 *
 *   The profile is fully PERIODIC in t (integer-cycle sines + a raised-cosine
 *   "mountain"), so elevationAt(0) === elevationAt(1) and the slope matches at
 *   the start/finish seam (no kink at the line).
 *
 * ─── Numeric verification (driving the REAL closed ReefSpline) ──────────────
 *   (full harness: scratchpad/ring-final.ts + scratchpad/width-scan.ts — drive
 *    the real spline + the elevation profile, never hand-pick numbers)
 *
 *   - totalArcLength       = 88051.9 wu                 (need [80000, 96000])
 *   - heading sweep        = +2.0000 π                  (one clean circumnav.)
 *   - curvature reversals  = 30                          (aggressive zig-zag)
 *   - min radius of curv.  = 2087.3 wu @ t≈0.670          (broad — see below)
 *   - hw @ min-R           = 1248 wu  (×1.55 scaled from 805)
 *   - CARVE MARGIN (R−hw)  = 839.3 wu  >> 192 floor       (NO wall-clamp — the
 *                                                          racing line fits)
 *   - hw sweep             = [1144, 1609] wu (water 2289–3219 wu WIDE; ×1.55 of v6)
 *   - min adjacent-CP space= 1858 wu @ CP3→CP4            (need >200, Newton guard)
 *   - XZ self-overlaps     = 0; min inter-pass edge clearance = 3226 wu
 *       (single-winding wavy circle — passes never touch in XZ even at the ×1.55
 *        wider corridors; elevation gives the floating Rainbow-Road feel; clearance
 *        verified by scratchpad/v6-width-verify.ts at ×1.55 scale)
 *   - ELEVATION Y range    = [-559, 1075] wu (span 1634); max grade 14.8 %
 *       (< 35 % so karts/surfers stay glued to the ribbon through climbs)
 *   - elevation seam       : Y(0)===Y(1) and slope(0)≈slope(1) (C1, no kink)
 *   - footprint X ∈ [-13876, 16772], Z ∈ [-13816, 12109]  (span ≈ 30648 × 25926)
 *   - centerlineAt(0) at XZ=(0, -11425) (start/finish line, south straight)
 *   - arclength round-trip < 1e-3 (LUT sane)
 *
 *   At REEF_MAX_SPEED = 500 wu/s, full-thrust straight cruise ≈ 496 wu/s and a
 *   realistic average lap pace ≈ 330 wu/s (mixed humans+bots). One loop ≈ 266 s
 *   at that pace; the per-lap soft budget (REEF_RACE_LOOP_LAP_BUDGET_MS) is
 *   grounded at 88 052 / 330 × 1.10 ≈ 294 s → 300 000 ms.
 *
 * ─── 5 themed segments (LOOP-APPROPRIATE — t-ranges, NOT z-ranges) ───────────
 *
 *   The z-range scheme is BROKEN on a loop (z is non-monotonic). Segments carry
 *   explicit `tStart`/`tEnd` spline-parameter fractions in [0,1], contiguous
 *   around the loop (seg[0].tStart=0, last seg tEnd=1). The anti-cheat
 *   `buildSegmentTRanges` reads these DIRECTLY (no z-bisection). t-boundaries
 *   pinned to CP transitions via closest-point projection (CP→t).
 *
 *   Segment            t-range          CPs        Theme / shape
 *   ----------------   --------------   --------    -------------------------
 *   0  lagoon          0.0000–0.0828    CP 0-3     start/finish straight (S→NE)
 *   1  kelp            0.0828–0.2732    CP 3-9     broad SE sweep + EAST bend
 *   2  shipwreck       0.2732–0.4363    CP 9-14    broad L-R sweeps + N entry
 *   3  coral           0.4363–0.7279    CP 14-24   N sweep + far-WEST broad bend
 *   4  finish          0.7279–1.0000    CP 24-0    SW broad sweeps + return run
 *
 * ─── Periodic closure (no phantom CPs) ───────────────────────────────────────
 *
 *   Per `./spline.ts` note #3b, the closed ReefSpline wraps the four-point
 *   Catmull-Rom neighbours around the ring (CP[N-1] and CP[0] are neighbours).
 *   There are N=32 SEGMENTS (the closing chord CP31→CP0 is a real segment), and
 *   centerlineAt(0)===centerlineAt(1) by construction. Authors place only the
 *   32 real CPs; the wrap is added internally. No phantoms, no reflection.
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
  // 2026-06-23 "WIDE SURF ROAD" REBUILD — t-range segments, all verified by
  // driving the real closed spline (see module doc for the full numbers block).
  // The t-boundaries are exact closest-point projections of the boundary CPs:
  //   CP0 -> 0.0000, CP3 -> 0.0828, CP9 -> 0.2732, CP14 -> 0.4363,
  //   CP18 -> 0.5538 (within coral), CP24 -> 0.7279, CP31 -> 0.9668.
  //
  //   lagoon    CP0-3    start/finish straight (south, heading NE)
  //   kelp      CP3-9    broad SE sweep + wide EAST bend
  //   shipwreck CP9-14   broad L-R sweeps + north entry
  //   coral     CP14-24  north sweep + far-west broad bend
  //   finish    CP24-0   SW broad sweeps + long return run to start
  // halfWidth values are documented design-intent (×1.55 of original v6 values):
  { id: 'lagoon',    tStart: 0.0000, tEnd: 0.0828, halfWidth: 1550 },
  { id: 'kelp',      tStart: 0.0828, tEnd: 0.2732, halfWidth: 1364 },
  { id: 'shipwreck', tStart: 0.2732, tEnd: 0.4363, halfWidth: 1488 },
  { id: 'coral',     tStart: 0.4363, tEnd: 0.7279, halfWidth: 1395 },
  { id: 'finish',    tStart: 0.7279, tEnd: 1.0000, halfWidth: 1395 },
];

// ─── Track layout ───────────────────────────────────────────────────────────

/**
 * REEF_RACE_DEFAULT_TRACK — locked v6 "WIDE SURF ROAD" aggressively-twisty
 * floating CLOSED-LOOP ribbon, 32 real control points, Mario-Kart-roomy WIDE
 * for 4+ player racing (water surface 2289–3219wu, ×1.55 of initial v6 widths).
 *
 * Coordinate frame: XZ plane (Y altitude is RENDER-ONLY via
 * `reefTrackElevationAt` + per-body `heightOffset`; the sim is 2D). The ring
 * winds CCW around (0,0). CP[0] sits on the START/FINISH line on the south
 * straight at (0, -11425), facing NE.
 *
 * Build with `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`. Do
 * NOT append a copy of CP[0] — the periodic wrap is internal to ReefSpline.
 *
 * Field shape matches `SplineControlPoint` exactly. Indices map to the themed
 * segments documented above. XZ positions generated by scratchpad/ring-final.ts
 * (radius = 12 800 + 2700·sin(2θ+0.4) + …); halfWidths set by scratchpad/
 * v6-width-verify.ts at scale ×1.55 of original v6 values. NEVER hand-pick
 * halfWidths — re-run the harness if you touch them.
 */
export const REEF_RACE_DEFAULT_TRACK: ReadonlyArray<SplineControlPoint> = [
  // 2026-06-23 "WIDE SURF ROAD" REBUILD — see REEF_RACE_SEGMENTS + module doc.
  // XZ positions: arc 88052 wu, heading sweep +2π, 30 curvature reversals,
  // min R 2087, footprint ~30648×25926, elevation span 1634 (render-only, max
  // grade 14.8%) — all unchanged from initial v6.
  // halfWidths: ×1.55 of initial v6 values. Verified by scratchpad/v6-width-verify.ts:
  //   hw [1144,1609] (water 2289-3219 WIDE), CARVE MARGIN 839 (NO wall-clamp),
  //   min CP spacing 1858, min inter-pass edge clearance 3226 (NO overlap).
  //
  // The v6 ring is a WAVY CIRCLE so every turn is a BROAD sweep (R >> corridor
  // hw): a wide river physically cannot carve pinhead chicanes/hairpins (R must
  // exceed hw + carve floor or the sim wall-clamps and stalls — the v5 lesson).
  // The aggressive zig-zag is 30 reversals of broad alternating sweeps over a
  // huge footprint, not tight corners.

  // ── Segment 0: lagoon — START/FINISH STRAIGHT (south, heading NE) ─────────
  // halfWidths are the original v6 values × 1.55 (rounded to nearest wu).
  // Verified by scratchpad/v6-width-verify.ts: hw [1144,1609], water 2289-3219wu,
  // carve margin 839wu (>> 192 floor), inter-pass clearance 3226wu.
  { x:     0, z: -11425, halfWidth: 1528 }, // CP  0  START/FINISH line (t=0)
  { x:  1952, z:  -9813, halfWidth: 1520 }, // CP  1  straight
  { x:  3640, z:  -8788, halfWidth: 1578 }, // CP  2  straight end → SE sweep

  // ── Segment 1: kelp — broad SE sweep into a wide EAST bend ────────────────
  { x:  5284, z:  -7909, halfWidth: 1455 }, // CP  3  SE sweep
  { x:  6658, z:  -6658, halfWidth: 1593 }, // CP  4  broad climb
  { x:  8011, z:  -5353, halfWidth: 1403 }, // CP  5  sweep
  { x: 10320, z:  -4275, halfWidth: 1609 }, // CP  6  widening into east bend
  { x: 13682, z:  -2721, halfWidth: 1386 }, // CP  7  east approach
  { x: 16369, z:      0, halfWidth: 1165 }, // CP  8  EAST apex (broad bend)

  // ── Segment 2: shipwreck — broad L-R alternating sweeps + north entry ─────
  { x: 16606, z:   3303, halfWidth: 1178 }, // CP  9  east exit (sweep R)
  { x: 14647, z:   6067, halfWidth: 1426 }, // CP 10  broad sweep L
  { x: 12072, z:   8066, halfWidth: 1581 }, // CP 11  broad sweep
  { x:  9715, z:   9715, halfWidth: 1545 }, // CP 12  broad sweep R
  { x:  7360, z:  11016, halfWidth: 1468 }, // CP 13  → north entry

  // ── Segment 3: coral — N sweep + far-west broad bend ──────────────────────
  { x:  4857, z:  11727, halfWidth: 1513 }, // CP 14  north sweep
  { x:  2391, z:  12023, halfWidth: 1550 }, // CP 15  north straight (far N)
  { x:     0, z:  12072, halfWidth: 1451 }, // CP 16  NORTH apex
  { x: -2292, z:  11523, halfWidth: 1393 }, // CP 17  NW run
  { x: -4242, z:  10240, halfWidth: 1555 }, // CP 18  NW descent
  { x: -5938, z:   8887, halfWidth: 1471 }, // CP 19  W run-in
  { x: -7927, z:   7927, halfWidth: 1589 }, // CP 20  wide W bend approach
  { x:-10123, z:   6764, halfWidth: 1296 }, // CP 21  W bend top
  { x:-11456, z:   4745, halfWidth: 1246 }, // CP 22  WEST apex (far west, broad)
  { x:-11465, z:   2281, halfWidth: 1573 }, // CP 23  W exit

  // ── Segment 4: finish — SW broad sweeps + long return run to start ────────
  { x:-11334, z:      0, halfWidth: 1344 }, // CP 24  SW run
  { x:-12274, z:  -2442, halfWidth: 1592 }, // CP 25  SW broad sweep
  { x:-13627, z:  -5645, halfWidth: 1373 }, // CP 26  SW descent
  { x:-13703, z:  -9156, halfWidth: 1232 }, // CP 27  SW apex (broad)
  { x:-11903, z: -11903, halfWidth: 1288 }, // CP 28  SW sweep back
  { x: -8968, z: -13422, halfWidth: 1384 }, // CP 29  S sweep widening
  { x: -5716, z: -13800, halfWidth: 1389 }, // CP 30  S sweep (far south)
  { x: -2595, z: -13047, halfWidth: 1409 }, // CP 31  → closing chord to CP0
];

/**
 * Compile-time sanity: 32 real control points exactly. The closing chord
 * CP31→CP0 is the 32nd SEGMENT, added internally by ReefSpline's periodic wrap.
 */
export const REEF_RACE_DEFAULT_TRACK_LENGTH = 32 as const;

/**
 * Verified total arc length of the closed ring (wu), driving the real
 * `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`. Exported so the
 * sim/anti-cheat can avoid re-constructing the spline just to read the length.
 * INCLUDES the closing chord. Re-verify if any CP changes.
 */
export const REEF_RACE_DEFAULT_TRACK_ARC_LENGTH = 88051.9 as const;

// ─── RENDER-ONLY elevation + banking profile (the sim NEVER reads these) ─────
//
// The server sim is purely 2D (XZ). These two pure functions describe the Y
// altitude + bank tilt of the floating ribbon as a function of spline parameter
// t. The 3D render lifts/tilts the track ribbon, the rider group AND the chase
// camera by the SAME elevation(t)+bank(t) so the surfer rides ON the ribbon and
// the camera frames it through climbs/drops. Per-body `heightOffset`
// (jump/ramp) is ADDED on top of reefTrackElevationAt(t). See module doc.

const REEF_TWO_PI = Math.PI * 2;

/**
 * Render-only Y altitude (world units) of the floating ribbon centerline at
 * spline parameter t ∈ [0,1] (cyclic). Fully PERIODIC: elevationAt(0) ===
 * elevationAt(1) and the slope matches at the seam (C1, no kink at the line).
 *
 * Composition (all periodic in t):
 *   - base   : 2 gentle undulation cycles around the loop (the big rises/dips)
 *   - ripple : 4 finer cycles (texture)
 *   - hump   : one broad "mountain" via a high-power raised-cosine centred at
 *              ~t=0.72 — a dramatic climb.
 *
 * Verified (scratchpad/elev-check.ts against the v6 arc 88052): Y ∈ [-559, 1075]
 * wu (span 1634), max |dY/ds| grade = 14.8 % (< 35 % so karts stay glued to the
 * ribbon — gentler than v5 because the v6 arc is ~46% longer).
 *
 * IMPORTANT: this is the SINGLE SOURCE of the ribbon's vertical datum. The 3D
 * scene MUST read it (not hand-author a parallel Y curve) so the ribbon, rider
 * and camera share one datum (the sim-coord-match invariant, extended to Y).
 */
export function reefTrackElevationAt(t: number): number {
  const u = ((t % 1) + 1) % 1;
  const base = 460 * Math.sin(REEF_TWO_PI * (u * 2 - 0.08));
  const ripple = 130 * Math.sin(REEF_TWO_PI * (u * 4 + 0.25));
  // raised-cosine bump: ((1+cos)/2)^p peaks at the centre, ~0 a half-period away.
  const hump = 620 * Math.pow(0.5 + 0.5 * Math.cos(REEF_TWO_PI * (u - 0.72)), 6);
  return base + ripple + hump;
}

/**
 * Render-only bank angle (radians) the floating ribbon tilts INTO turns at
 * spline parameter t ∈ [0,1] (cyclic). Proportional to the local heading-change
 * rate (finite-difference of tangent direction), sign = turn direction, capped
 * at ±BANK_MAX_RAD so even the tight hairpins don't roll past a sane lean.
 *
 * The render applies this as a roll about the ribbon's local forward (tangent)
 * axis — the same tilt on the track ribbon, the rider, and the camera up-vector
 * so a banked turn reads as a banked turn for all three. Cheap: two tangent
 * evaluations. NO allocation (returns a scalar).
 */
const BANK_MAX_RAD = (28 * Math.PI) / 180; // 28° max lean — Rainbow-Road banking
// rad-of-bank per (rad-of-heading-change-rate per unit t). Re-tuned for the v6
// WIDE ring (scratchpad/bank-tune.ts): the broad-sweep heading-rate runs ±9 rad/t
// median, ±27 p99, so 0.016 leaves straights ~flat, broad turns ~8°, and only the
// very tightest sweep approaches the 28° cap (≈2% saturation) — NOT the v5 gain
// of 9.0, which pegged the whole v6 ribbon at the cap (a violently rolling
// ribbon). Re-tune if the track curvature changes.
const BANK_GAIN = 0.016;
export function reefTrackBankAngleAt(
  t: number,
  // The caller passes a tangent-direction sampler so this stays pure + decoupled
  // from the spline instance (the render already holds `clientSpline`). Each
  // sampler returns the heading angle atan2(tangent.z, tangent.x) at a t.
  headingAt: (tt: number) => number,
): number {
  const u = ((t % 1) + 1) % 1;
  const h = 0.004; // ~one segment-fraction step
  const a0 = headingAt(((u - h) % 1 + 1) % 1);
  const a1 = headingAt((u + h) % 1);
  let d = a1 - a0;
  while (d > Math.PI) d -= REEF_TWO_PI;
  while (d < -Math.PI) d += REEF_TWO_PI;
  // heading-change rate per unit t → a lean; clamp.
  const rate = d / (2 * h);
  const bank = Math.max(-BANK_MAX_RAD, Math.min(BANK_MAX_RAD, rate * BANK_GAIN));
  return bank;
}
