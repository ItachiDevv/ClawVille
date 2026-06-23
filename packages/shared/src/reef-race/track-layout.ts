/**
 * reef-race-track-layout.ts
 *
 * LOCKED v5 "SURF ROAD" default track for Reef Race — an aggressively twisty
 * Rainbow-Road-style CLOSED-LOOP circuit of 32 centripetal Catmull-Rom control
 * points. The track is a GLOWING FLOATING WATER RIBBON winding through an
 * abstract cosmic void — there is NO land, NO island, NO ground beneath it.
 * Consumed by `ReefSpline` (see `./spline.ts`, built with `{ closed: true }`)
 * for both the server sim corridor math AND the client-side 3D ribbon builder.
 * Single source of truth.
 *
 * 2026-06-23 "SURF ROAD" REBUILD (this version, v5). The founder reframed the
 * whole vision after two land-disc attempts: "Think RAINBOW ROAD. A floating
 * river that can be abstracted and NOT bound by land — the land here is
 * ultimately very irrelevant, the SURFING is the piece. Not zig-zaggy enough,
 * not utilizing the space enough for a game like Mario Kart that has zig zags."
 * There is NO world to circle, NO island, NO land map. The water ribbon IS the
 * world, floating in a cosmic void.
 *
 * v5 vs v4 (the water-dominant land-disc):
 *   - AGGRESSIVE ZIG-ZAG: 26 curvature reversals (was 12). A real twisty
 *     circuit — SE sweeper into an east hairpin, a flowing L-R-L-R S-chain, a
 *     north chicane, a far-west U-hairpin, a mid chicane, and a long sweeping
 *     SW return. Min radius 261.2 wu (carveable; floor 190).
 *   - SPRAWLS: footprint ≈ 17 687 × 16 941 wu (was ~15 400²). Uses the space.
 *   - ELEVATION (render-only): a periodic `reefTrackElevationAt(t)` profile
 *     (Y span ≈ 1634 wu, max grade 29 %) lifts/dips the ribbon, rider AND chase
 *     camera together so it FLOATS and undulates like Rainbow Road — while the
 *     SIM stays purely XZ (laps/finish/physics unchanged). See note below.
 *   - Banking: `reefTrackBankAngleAt(t)` (render-only) tilts the ribbon into
 *     turns proportional to signed curvature.
 *   - Corridor half-width 280–480 wu (water ribbon 559–960 wu wide) — a banked
 *     Rainbow-Road ribbon, narrower than the v4 wide surf channel, so the
 *     zig-zags read sharp and the ribbon floats rather than sprawls flat. (The
 *     corridor was tuned UP from a first sharper pass that wall-clamped the sim
 *     — see the corridor-width note in the numbers block below.)
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
 *   (full harness: scratchpad/track-verify.ts — drives the real spline + the
 *    elevation profile, never hand-picks numbers)
 *
 *   - totalArcLength       = 60256.6 wu                 (need [55000, 66000])
 *   - heading sweep        = +2.0000 π                  (one clean circumnav.)
 *   - curvature reversals  = 26                          (aggressive zig-zag)
 *   - min radius of curv.  = 261.2 wu @ t≈0.386 (S-chain) (need ≥190, carveable)
 *   - min adjacent-CP space= 905.5 wu @ CP31→CP0          (need >200, Newton guard)
 *   - XZ self-overlaps     = 0; min inter-pass edge clearance = 2078.6 wu
 *       (single-winding circuit — passes never touch in XZ; elevation gives the
 *        floating Rainbow-Road feel without a forced self-overpass cusp)
 *   - ELEVATION Y range    = [-559, 1075] wu (span 1634); max grade 29.3 %
 *       (< 35 % so karts/surfers stay glued to the ribbon through climbs)
 *   - elevation seam       : Y(0)===Y(1) and slope(0)≈slope(1) (C1, no kink)
 *   - footprint X ∈ [-9237, 8450], Z ∈ [-8500, 8441]  (span ≈ 17687 × 16941 wu)
 *   - centerlineAt(0) at XZ=(-2400, -8200) (start/finish line, south)
 *   - hw sweep [280, 480] wu (water ribbon 559-960 wu wide)
 *   - arclength round-trip < 1e-3 (LUT sane)
 *   - NOTE: corridor widths tuned UP from a first sharper pass — narrow esses
 *     WALL-CLAMP the sim physics (kart pins to the wall + stalls); every corner
 *     now holds a racing line inside the corridor (caught by the 8-body smoke).
 *
 *   At REEF_MAX_SPEED = 500 wu/s, full-thrust straight cruise ≈ 496 wu/s and a
 *   realistic average lap pace ≈ 410 wu/s (humans) / ~340 wu/s (bots). One loop
 *   ≈ 145–175 s. A 2-lap race ≈ 4.8–5.8 min — within the per-lap soft budget
 *   (REEF_RACE_LOOP_SOFT_TIMEOUT_MS, scaled per lap).
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
 *   0  lagoon          0.0000–0.1126    CP 0-3     start/finish straight (S)
 *   1  kelp            0.1126–0.3028    CP 3-9     SE sweeper + EAST hairpin
 *   2  shipwreck       0.3028–0.4416    CP 9-14    flowing L-R-L-R S-CHAIN + N
 *   3  coral           0.4416–0.7722    CP 14-24   N chicane + far-W U-HAIRPIN
 *   4  finish          0.7722–1.0000    CP 24-0    mid chicane + SW return run
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
  // 2026-06-23 "SURF ROAD" REBUILD — t-range segments, all verified by driving
  // the real closed spline (see module doc for the full numbers block). The
  // t-boundaries are exact closest-point projections of the boundary CPs:
  //   CP0 -> 0.0000, CP3 -> 0.1126, CP9 -> 0.3028, CP14 -> 0.4416,
  //   CP18 -> 0.5689 (within coral), CP24 -> 0.7722, CP31 -> 0.9780.
  //
  //   lagoon    CP0-3    start/finish straight (south)
  //   kelp      CP3-9    SE rising sweeper + EAST hairpin
  //   shipwreck CP9-14   flowing L-R-L-R S-chain + north entry
  //   coral     CP14-24  north chicane + far-west U-hairpin
  //   finish    CP24-0   mid chicane + long SW return run to start
  { id: 'lagoon',    tStart: 0.0000, tEnd: 0.1126, halfWidth: 480 },
  { id: 'kelp',      tStart: 0.1126, tEnd: 0.3028, halfWidth: 380 },
  { id: 'shipwreck', tStart: 0.3028, tEnd: 0.4416, halfWidth: 360 },
  { id: 'coral',     tStart: 0.4416, tEnd: 0.7722, halfWidth: 360 },
  { id: 'finish',    tStart: 0.7722, tEnd: 1.0000, halfWidth: 400 },
];

// ─── Track layout ───────────────────────────────────────────────────────────

/**
 * REEF_RACE_DEFAULT_TRACK — locked v5 "SURF ROAD" aggressively-twisty floating
 * CLOSED-LOOP ribbon, 32 real control points.
 *
 * Coordinate frame: XZ plane (Y altitude is RENDER-ONLY via
 * `reefTrackElevationAt` + per-body `heightOffset`; the sim is 2D). The ring
 * winds CCW around (0,0). CP[0] sits on the START/FINISH line on the south
 * straight at (-2400, -8200).
 *
 * Build with `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`. Do
 * NOT append a copy of CP[0] — the periodic wrap is internal to ReefSpline.
 *
 * Field shape matches `SplineControlPoint` exactly. Indices map to the themed
 * segments documented above.
 */
export const REEF_RACE_DEFAULT_TRACK: ReadonlyArray<SplineControlPoint> = [
  // 2026-06-23 "SURF ROAD" REBUILD — see REEF_RACE_SEGMENTS + module doc.
  // Verified on the real closed spline: arc 60257 wu, heading sweep +2π,
  // 26 curvature reversals, min R 261.2, min CP spacing 905, hw 280-480,
  // footprint ~17687×16941, elevation span 1634 (render-only).
  //
  // Corridor widths were tuned UP from a first sharper pass: the tight/narrow
  // esses + hairpins WALL-CLAMPED the sim physics (a kart that can't carve the
  // line inside the corridor pins to the wall and stalls forward progress — the
  // full 8-body integration smoke caught this). Every corner now holds a
  // racing line inside the corridor (min R 261 > carve floor 192).

  // ── Segment 0: lagoon — START/FINISH STRAIGHT (south) ─────────────────────
  { x: -2400, z: -8200, halfWidth: 480 }, // CP  0  START/FINISH line (t=0)
  { x:   200, z: -8500, halfWidth: 460 }, // CP  1  straight
  { x:  2900, z: -8200, halfWidth: 420 }, // CP  2  straight end → SE turn-in

  // ── Segment 1: kelp — SE rising sweeper into an EAST hairpin ──────────────
  { x:  5200, z: -7000, halfWidth: 400 }, // CP  3  SE sweeper
  { x:  7000, z: -5000, halfWidth: 380 }, // CP  4  climb
  { x:  8100, z: -3000, halfWidth: 360 }, // CP  5  hairpin approach
  { x:  8400, z:  -900, halfWidth: 360 }, // CP  6  HAIRPIN apex A (east)
  { x:  7300, z:   600, halfWidth: 360 }, // CP  7  hairpin bite
  { x:  6000, z:   600, halfWidth: 380 }, // CP  8  hairpin exit (back inward)

  // ── Segment 2: shipwreck — flowing L-R-L-R S-CHAIN (chicane train) ────────
  { x:  5000, z:  1400, halfWidth: 380 }, // CP  9  ess L
  { x:  5600, z:  2800, halfWidth: 360 }, // CP 10  ess R
  { x:  4900, z:  4100, halfWidth: 360 }, // CP 11  ess L
  { x:  5500, z:  5300, halfWidth: 360 }, // CP 12  ess R
  { x:  4500, z:  6200, halfWidth: 360 }, // CP 13  ess exit L → north entry

  // ── Segment 3: coral — N big sweeper + chicane + far-west U-HAIRPIN ────────
  { x:  3000, z:  6600, halfWidth: 340 }, // CP 14  north sweep
  { x:  1300, z:  7000, halfWidth: 300 }, // CP 15  chicane in
  { x:   400, z:  8400, halfWidth: 280 }, // CP 16  chicane apex (out, far north)
  { x: -1500, z:  7900, halfWidth: 320 }, // CP 17  chicane exit
  { x: -3600, z:  7100, halfWidth: 360 }, // CP 18  NW run
  { x: -5600, z:  6200, halfWidth: 360 }, // CP 19  NW descent
  { x: -7700, z:  4900, halfWidth: 360 }, // CP 20  hairpin approach
  { x: -9000, z:  3000, halfWidth: 360 }, // CP 21  HAIRPIN apex B (far west)
  { x: -9100, z:   900, halfWidth: 360 }, // CP 22  hairpin around (carveable)
  { x: -7600, z:  -300, halfWidth: 380 }, // CP 23  hairpin exit (heading S/E)

  // ── Segment 4: finish — mid chicane + long SW return run to start ─────────
  { x: -5800, z: -1100, halfWidth: 380 }, // CP 24  sweep SE (inward)
  { x: -5000, z: -2600, halfWidth: 360 }, // CP 25  mid chicane
  { x: -6200, z: -3700, halfWidth: 360 }, // CP 26  chicane out (toward W wall)
  { x: -7400, z: -4200, halfWidth: 360 }, // CP 27  SW descent
  { x: -7600, z: -5900, halfWidth: 400 }, // CP 28  SW
  { x: -6500, z: -7100, halfWidth: 440 }, // CP 29  SW sweep widening
  { x: -5000, z: -7900, halfWidth: 460 }, // CP 30  SW sweep
  { x: -3300, z: -8100, halfWidth: 470 }, // CP 31  → closing chord to CP0
];

/**
 * Compile-time sanity: 32 real control points exactly (was 27 in v4). The
 * closing chord CP31→CP0 is the 32nd SEGMENT, added internally by ReefSpline's
 * periodic wrap.
 */
export const REEF_RACE_DEFAULT_TRACK_LENGTH = 32 as const;

/**
 * Verified total arc length of the closed ring (wu), driving the real
 * `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`. Exported so the
 * sim/anti-cheat can avoid re-constructing the spline just to read the length.
 * INCLUDES the closing chord. Re-verify if any CP changes.
 */
export const REEF_RACE_DEFAULT_TRACK_ARC_LENGTH = 60256.6 as const;

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
 *              the far-west hairpin region (peak ~t=0.72) — a dramatic climb.
 *
 * Verified (scratchpad/track-verify.ts): Y ∈ [-559, 1075] wu (span 1634), max
 * |dY/ds| grade = 29.0 % (< 35 % so karts stay glued to the ribbon).
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
const BANK_GAIN = 9.0;                      // rad-of-bank per rad-of-heading-rate
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
