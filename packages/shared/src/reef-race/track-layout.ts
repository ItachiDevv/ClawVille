/**
 * reef-race-track-layout.ts
 *
 * LOCKED v7 "TECHNICAL SURF ROAD" default: a 52-control-point closed
 * centripetal Catmull-Rom water ribbon. It preserves broad surf sweeps while
 * adding a four-bend alternating S-chicane and a 180-degree near-hairpin.
 * Those technical cores pinch smoothly to 455–700 wu half-width; broad runs
 * remain 800–1616 wu for overtaking. Per-CP `halfWidth` is interpolated by
 * `ReefSpline.widthAt(t)`, so server wall-clamp math and the client ribbon read
 * the exact same C1-continuous profile. There is no parallel width function.
 *
 * The load-bearing constraint is pointwise: R(t) - widthAt(t) > 550 wu. v7
 * narrows before it sharpens, yielding technical minima near 1020/1195 wu
 * without recreating the v5 wall-clamp stall. The seam remains a broad straight
 * with room for the complete 2x4 start grid (568 wu rear reach, +/-320 lateral).
 * Build with `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`; do
 * not repeat CP0 because periodic closure supplies the closing segment.
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
 *   Full harness: `scripts/reef/verify-track-v7.ts`, which drives the real
 *   shared spline, width, elevation, placement and start-grid implementations.
 *
 *   - totalArcLength       = 95741.0 wu (required [70000, 96000])
 *   - heading sweep        = +2.000000 pi; XZ overlaps = 0
 *   - curvature reversals  = 40 (stable at N=4000 and N=8000)
 *   - min radius overall   = 1020.1 wu @ t=0.63762
 *   - S-chicane core       = t 0.1742–0.3260, minR 1194.7, hw 466.3–699.7
 *   - near-hairpin core    = t 0.4911–0.7357, minR 1020.1, hw 454.6–699.2
 *   - broad-section minR   = 1478.5 wu
 *   - hw sweep             = 454.6–1615.6 wu
 *   - min carve margin     = 559.6 wu (>550, >=10% over the 500 floor)
 *   - min adjacent CP gap  = 556.0 wu (>200 Newton guard)
 *   - min inter-pass edge clearance = 487.2 wu (>300); edge overlaps = 0
 *   - max elevation grade  = 15.98%; elevation seam is C1
 *   - bank max             = 28 degrees (clamped; 20.49% sample saturation)
 *   - start-grid min inset = 1166.7 wu; min local tangent dot = 0.999996
 *
 *   At REEF_MAX_SPEED = 1300 wu/s, full-thrust straight cruise ≈ 1290 wu/s and
 *   a realistic average lap pace ≈ 858 wu/s (mixed humans+bots). One loop
 *   takes ≈ 111.6 s at that pace; 95 741/858×1.10 ≈ 123 s with safety.
 *   The existing 300 000 ms per-lap soft budget remains deliberately conservative
 *   for collisions, stalls and disconnected stragglers.
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
 *   0  lagoon          0.0000–0.1742    CP 0-8     start straight + broad east run
 *   1  kelp            0.1742–0.3366    CP 8-17    pinched S-chicane cluster
 *   2  shipwreck       0.3366–0.5086    CP 17-25   broad north/west surf sweep
 *   3  coral           0.5086–0.7885    CP 25-44   pinched near-hairpin + recovery
 *   4  finish          0.7885–1.0000    CP 44-0    broad south return to seam
 *
 * ─── Periodic closure (no phantom CPs) ───────────────────────────────────────
 *
 *   Per `./spline.ts` note #3b, the closed ReefSpline wraps the four-point
 *   Catmull-Rom neighbours around the ring (CP[N-1] and CP[0] are neighbours).
 *   There are N=52 SEGMENTS (the closing chord CP51→CP0 is a real segment), and
 *   centerlineAt(0)===centerlineAt(1) by construction. Authors place only the
 *   52 real CPs; the wrap is added internally. No phantoms, no reflection.
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
  // v7 boundaries are closest-point projections of CP0/8/17/25/44.
  // `halfWidth` here is documented intent; real geometry uses spline.widthAt(t).
  { id: 'lagoon',    tStart: 0.0000, tEnd: 0.1742, halfWidth: 1450 },
  { id: 'kelp',      tStart: 0.1742, tEnd: 0.3366, halfWidth: 550 },
  { id: 'shipwreck', tStart: 0.3366, tEnd: 0.5086, halfWidth: 1400 },
  { id: 'coral',     tStart: 0.5086, tEnd: 0.7885, halfWidth: 550 },
  { id: 'finish',    tStart: 0.7885, tEnd: 1.0000, halfWidth: 1300 },
];

export interface ReefRaceTechnicalZone {
  readonly id: 's-chicane' | 'near-hairpin';
  readonly tStart: number;
  readonly tEnd: number;
}

/** Canonical v7 pinched technical-zone bounds, shared by verification + placements. */
export const REEF_RACE_TECHNICAL_ZONES: ReadonlyArray<ReefRaceTechnicalZone> = [
  { id: 's-chicane', tStart: 0.1742, tEnd: 0.3260 },
  { id: 'near-hairpin', tStart: 0.4911, tEnd: 0.7357 },
];

// ─── Track layout ───────────────────────────────────────────────────────────

/**
 * Locked v7 technical surf-road: 52 real control points with two pinched cores.
 *
 * Coordinate frame: XZ plane (Y altitude is RENDER-ONLY via
 * `reefTrackElevationAt` + per-body `heightOffset`; the sim is 2D). The ring
 * winds CCW around (0,0). CP[0] sits on the START/FINISH line on the south
 * straight at scaled XZ=(0, -10179.675), facing NE.
 *
 * Build with `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`. Do
 * NOT append a copy of CP[0] — the periodic wrap is internal to ReefSpline.
 *
 * Source coordinates below are multiplied by `REEF_RACE_V7_XZ_SCALE`; the
 * canonical verified values are therefore the mapped export, not raw literals.
 * Re-run `bun scripts/reef/verify-track-v7.ts` after any geometry/width edit.
 */
const REEF_RACE_V7_XZ_SCALE = 0.891;

export const REEF_RACE_DEFAULT_TRACK: ReadonlyArray<SplineControlPoint> = ([
  // 2026-07-18 v7: 95,741wu arc, 40 reversals, minR 1,020wu, hw 455–1,616wu.

  // ── Segment 0: lagoon — START/FINISH + broad east run (CP0→CP8) ──────────
  { x:     0, z: -11425, halfWidth: 1528 }, // CP  0  START/FINISH line (t=0)
  { x:  1952, z:  -9813, halfWidth: 1520 }, // CP  1  straight
  { x:  3640, z:  -8788, halfWidth: 1578 }, // CP  2  straight end → SE sweep

  { x:  5284, z:  -7909, halfWidth: 1455 }, // CP  3  SE sweep
  { x:  6658, z:  -6658, halfWidth: 1593 }, // CP  4  broad climb
  { x:  8011, z:  -5353, halfWidth: 1403 }, // CP  5  sweep
  { x: 10320, z:  -4275, halfWidth: 1609 }, // CP  6  widening into east bend
  { x: 13682, z:  -2721, halfWidth: 900 },

  // ── Segment 1: kelp — pinched alternating S-chicane (CP8→CP17) ───────────
  { x: 16369, z:      0, halfWidth: 700 },
  { x: 16606, z:   3303, halfWidth: 650 },
  { x: 15833, z:   4556, halfWidth: 500 },
  { x: 14711, z:   5583, halfWidth: 470 },
  { x: 13646, z:   6850, halfWidth: 470 },
  { x: 12160, z:   7582, halfWidth: 470 },
  { x: 11095, z:   8849, halfWidth: 520 },
  { x:  9715, z:   9715, halfWidth: 650 },
  { x:  8500, z:  10400, halfWidth: 600 },

  // ── Segment 2: shipwreck — broad north/west surf sweep (CP17→CP25) ───────
  { x:  7360, z:  11016, halfWidth: 1000 },
  { x:  4857, z:  11727, halfWidth: 1513 },
  { x:  2391, z:  12023, halfWidth: 1550 },
  { x:     0, z:  12072, halfWidth: 1451 },
  { x: -2292, z:  11523, halfWidth: 1393 },
  { x: -4242, z:  10240, halfWidth: 1555 },
  { x: -5938, z:   8887, halfWidth: 1471 },
  { x: -7927, z:   7927, halfWidth: 800 },

  // ── Segment 3: coral — pinched near-hairpin + recovery (CP25→CP44) ───────
  { x:-10500, z:   7000, halfWidth: 550 },
  { x:-12000, z:   6000, halfWidth: 550 },
  { x:-13000, z:   5300, halfWidth: 550 },
  { x:-13600, z:   4750, halfWidth: 500 },
  { x:-14100, z:   3800, halfWidth: 500 },
  { x:-14300, z:   2400, halfWidth: 500 },
  { x:-13714, z:    986, halfWidth: 460 },
  { x:-12300, z:    400, halfWidth: 455 },
  { x:-10886, z:    986, halfWidth: 460 },
  { x:-10300, z:   2400, halfWidth: 500 },
  { x:-10300, z:   4000, halfWidth: 540 },
  { x:-10178, z:   4612, halfWidth: 540 },
  { x: -9831, z:   5131, halfWidth: 560 },
  { x: -9312, z:   5478, halfWidth: 580 },
  { x: -8700, z:   5600, halfWidth: 600 },
  { x: -7858, z:   5433, halfWidth: 650 },
  { x: -7144, z:   4956, halfWidth: 750 },
  { x: -6667, z:   4242, halfWidth: 900 },
  { x: -6500, z:   3400, halfWidth: 1100 },

  // ── Segment 4: finish — broad south return to the seam (CP44→CP0) ────────
  { x: -6500, z:   1000, halfWidth: 900 },
  { x:-10500, z:  -2500, halfWidth: 1400 },
  { x:-13627, z:  -5645, halfWidth: 1373 },
  { x:-13703, z:  -9156, halfWidth: 1232 },
  { x:-11903, z: -11903, halfWidth: 1288 },
  { x: -8968, z: -13422, halfWidth: 1384 },
  { x: -5716, z: -13800, halfWidth: 1389 },
  { x: -2595, z: -13047, halfWidth: 1409 }, // CP51 → closing chord to CP0
] satisfies ReadonlyArray<SplineControlPoint>).map(({ x, z, halfWidth }) => ({
  x: x * REEF_RACE_V7_XZ_SCALE,
  z: z * REEF_RACE_V7_XZ_SCALE,
  halfWidth,
}));

/**
 * Compile-time sanity: 52 real control points. CP51→CP0 is the closing segment.
 */
export const REEF_RACE_DEFAULT_TRACK_LENGTH = 52 as const;

/**
 * Verified total arc length of the closed ring (wu), driving the real
 * `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`. Exported so the
 * sim/anti-cheat can avoid re-constructing the spline just to read the length.
 * INCLUDES the closing chord. Re-verify if any CP changes.
 */
export const REEF_RACE_DEFAULT_TRACK_ARC_LENGTH = 95741.0 as const;

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
 * Verified by `verify-track-v7.ts`: Y ∈ [-559, 1075] wu (span 1634), max
 * |dY/ds| grade = 15.98% (<20%).
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
// rad-of-bank per (rad-of-heading-change-rate per unit t). v7 retains the 0.016
// gain and verifies the ±28° clamp; sharper technical bends saturate 20.49% of
// samples while the start straight remains near-flat.
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
