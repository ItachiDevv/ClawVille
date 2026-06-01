/**
 * reef-race-track-layout.ts
 *
 * LOCKED v2 default track for Reef Race — 16 control-point centripetal
 * Catmull-Rom WIDE river. Consumed by `ReefSpline` (see `./spline.ts`) for
 * both the server sim corridor math AND the client-side 3D river-bed builder.
 * Single source of truth — the visual ribbon AND the server wall-clamp BOTH
 * read `widthAt(t)`, so widening the corridor here auto-cascades to both.
 *
 * 2026-06-02 WATER-DOMINANT WIDE REBUILD (this version): the 2026-06-01
 * "steering-mandatory" tune (below) had it BACKWARDS — it forced steering by
 * collapsing the corridor to halfWidth 290 (580 wu wide) and making the slalom
 * amplitude (±440/460) EXCEED the halfWidth so a dead-straight line clipped the
 * wall. The result LOOKED like a skinny canal threaded through 90% land, not a
 * river. The fix: water is the HERO. Steering matters through COURSE DESIGN
 * (3 wide sweeping bends with a real inside/outside racing line + 2 deliberate
 * chicane pinches + slow-zone obstacle clusters on the inside line — see
 * `reef-race-config.ts buildSplineObstacles()`), NOT through narrow walls.
 *
 *   - Lagoon / finish: halfWidth 540 → 1300 wu  (corridor 2600 wu)
 *   - Sweeping-bend straights: 290 → 1200 wu     (corridor 2400 wu ≈ 32 lanes)
 *   - Two chicane pinches: halfWidth ~960/980 wu (corridor ~1920/1960 wu) —
 *     still multi-kart, just tighter; the racing line commits through them.
 *
 * Bend amplitude is now SMALL relative to the corridor (centerline max |x| ≈
 * 606 wu vs ~2400 wu corridor = ~25% of half-width) so the water NEVER walls
 * the straight line off — but the bends still bend enough that an inside vs
 * outside line is a real choice (the curvature-aware bot biases the inside).
 *
 * 2026-06-01 STEERING-MANDATORY RE-TUNE (superseded): slalom amplitude raised
 * ABOVE halfWidth (290) so a straight x=0 line EXITED the corridor by +256.5 wu
 * — that wall-as-steering trick is exactly the skinny-canal bug this rebuild
 * reverses. The "STEERING IS MANDATORY straight-line-exits-corridor" test that
 * enforced it is rewritten in reef-race-track-layout.test.ts the same diff.
 *
 * 2026-04-30 90s rebuild (superseded): track lengthened 18 000 → 28 000 wu
 * z-span via CP-insertion with too-wide corridors.
 *
 * ─── 5 themed segments ──────────────────────────────────────────────────────
 *
 *   Segment            z-range (wu)        CPs          halfWidth   Bend max|x|
 *   ----------------   -----------------   ----------   ---------   ----------
 *   0  Open lagoon       0 →  3 000        CP 0,1,2     1300 wu     0 (straight)
 *   1  Kelp forest     3 000 → 12 100      CP 3-6       1200/960*   +580 (sweep R)
 *   2  Shipwreck      12 100 → 19 600      CP 7-10      1200/980*   −600 (sweep L)
 *   3  Coral canyon   19 600 → 26 100      CP 11-13     1200 wu     +600 (sweep R)
 *   4  Finish straight 26 100 → 28 000     CP 14,15     1300 wu     0 (straight)
 *
 *   *the last CP of kelp (z=12100) and shipwreck (z=19600) is a CHICANE PINCH
 *    (halfWidth 960 / 980, vs 1200 on the straights) — the corridor narrows to
 *    ~1920/1960 wu there, forcing a committed line without ever walling off.
 *
 *   Amplitude (≤600) << halfWidth (≥960) at EVERY CP → the x=0 axis stays
 *   INSIDE the corridor everywhere → no wall-as-steering. Steering pressure
 *   comes from bends + chicanes + obstacle clusters (config), not walls.
 *
 * ─── Numeric verification (driving the real ReefSpline) ─────────────────────
 *
 *   - totalArcLength = 28356.5 wu                          (need [28000, 31500])
 *   - centerline max|x| = 606.4 wu                         (bends real; need ≥300)
 *   - min widthAt over track = 959.6 wu (chicane pinch)    (need [~800, ~1200])
 *   - straight-segment widthAt ≥ 1100 wu → corridor ≥ 2200 (8-kart-fit; need ≥1000)
 *   - min radius of curvature = 1590.7 wu                  (need ≥192, ≳250)
 *   - min adjacent-CP spacing = 750 wu                     (need >88, Newton)
 *   - z strictly monotonic; straight corridor 2400 wu ≈ 54 kart-diameters (r=22)
 *
 *   At REEF_MAX_SPEED = 500 wu/s and ~330 wu/s effective cruise, one-shot race
 *   time ≈ 28356 / 330 ≈ 86 s — matches the 90s soft-timeout + grace window.
 *
 * ─── Top-down schematic (X horizontal ±600, Z down 0→28000) ─────────────────
 *
 *   The wide corridor (halfWidth ≥960) is drawn as the band around centerline
 *   `C`. The x=0 axis (`:`) — the dead-straight path — now stays INSIDE the
 *   band everywhere (no wall). The bends shift the FAST racing line off the
 *   axis; obstacle clusters sit on the inside line at the bends/chicanes.
 *
 *     X:  -600 ............. 0 ............. +600
 *
 *      [========:========]        z=0      CP0  start  (x=0, hw 1300)
 *      [========:========]        z=3000   CP2  lagoon→kelp gate
 *      [====:===C========]        z=8000   CP4  kelp sweep +580  (axis inside)
 *      [========C:=======]        z=12100  CP6  CHICANE pinch (hw 960)
 *      [=======C:========]        z=16400  CP8  wreck sweep −600
 *      [========:C=======]        z=19600  CP10 CHICANE pinch (hw 980)
 *      [====:===C========]        z=24000  CP12 coral sweep +600
 *      [========:========]        z=27250  CP14 finish entry (x=0, hw 1300)
 *      [========:========]        z=28000  CP15 FINISH       (x=0)
 *
 *   The lagoon and finish are dead-straight on the X=0 axis for clean spawn /
 *   finish gates. The three sweeping bends + two chicanes give the racing line
 *   its shape; the corridor stays wide enough (≥1920 wu even at a pinch) that
 *   the water reads as a river, not a canal.
 *
 * ─── Phantom control points ─────────────────────────────────────────────────
 *
 *   Per `./spline.ts` design note #3, phantom CPs at t=0 and t=1 are computed
 *   AUTOMATICALLY by the ReefSpline constructor by reflecting CP[1] across
 *   CP[0] and CP[N-2] across CP[N-1]. Authors of this layout do NOT include
 *   phantoms in the array — only the 16 real interior CPs.
 *
 *   To verify the start-line tangent points "down-track" (+Z), we keep
 *   CP[0]=(0,0) and CP[1]=(0,1500): the reflection produces phantom_start
 *   at (0,-1500), so the t=0 tangent is exactly +Z. Same logic at the
 *   finish (CP14=(0,27250), CP15=(0,28000) → phantom_end at (0,28750)).
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
  // 2026-06-02 WATER-DOMINANT WIDE REBUILD (supersedes the 2026-06-01
  // steering-mandatory tune): the prior tune forced steering by collapsing the
  // corridor to halfWidth 290 (580 wu wide) and making the slalom amplitude
  // (±440/460) EXCEED halfWidth so a straight line clipped the wall — which
  // rendered as a skinny canal threaded through 90% land, the bug this fixes.
  //
  // FIX (water is the HERO; verified numerically by driving the real spline):
  //   - halfWidth restored to 1200 on the sweeping straights, 1300 on the
  //     lagoon/finish → corridor 2400/2600 wu (~32–35 kart-LANES wide; the
  //     water fills the frame). Two CHICANE PINCHES to 960/980 (corridor
  //     ~1920/1960) keep a tighter committed line without ever walling off.
  //   - Steering now matters through COURSE DESIGN: 3 wide sweeping bends
  //     (centerline max|x| ≈ 606 wu, ~25% of half-width — small enough that
  //     water never walls, big enough that inside vs outside is a real choice)
  //     + the 2 chicanes + slow-zone obstacle clusters on the inside line
  //     (`reef-race-config.ts buildSplineObstacles()`). NOT narrow walls.
  //   - min radius of curvature = 1590.7 wu (>> 192 wu floor) → carve-able at
  //     REEF_MAX_SPEED; totalArcLength = 28356.5 wu (inside [28000, 31500]).
  //   - CP count drops 19→16 (the slalom became 3 gentle bends). The
  //     "STEERING IS MANDATORY straight-line-exits-corridor" test is rewritten
  //     to design-correct guards (bends exist + wide straights + chicane pinch)
  //     in reef-race-track-layout.test.ts the same diff.
  //   `halfWidth` here is the per-segment SPEC value for docs + obstacle
  //   placement; the actual sim half-width is the Catmull-Rom interpolation of
  //   the per-CP `halfWidth` (the chicane pinch lives on the LAST CP of kelp
  //   and shipwreck, so the spec value below is the STRAIGHT half-width).
  //
  // 2026-04-30 (superseded): 90s rebuild via CP-INSERTION, half-widths from
  // iter-9 (×1.5 widening).
  { id: 'lagoon',    zStart:     0, zEnd:  3000, halfWidth: 1300 },
  { id: 'kelp',      zStart:  3000, zEnd: 12100, halfWidth: 1200 },
  { id: 'shipwreck', zStart: 12100, zEnd: 19600, halfWidth: 1200 },
  { id: 'coral',     zStart: 19600, zEnd: 26100, halfWidth: 1200 },
  { id: 'finish',    zStart: 26100, zEnd: 28000, halfWidth: 1300 },
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
  // 2026-06-02 WATER-DOMINANT WIDE REBUILD — see REEF_RACE_SEGMENTS note above.
  // Bend amplitude (≤600) << halfWidth (≥960) everywhere → the x=0 axis stays
  // INSIDE the corridor (no wall-as-steering); steering pressure comes from the
  // bends + 2 chicane pinches + the obstacle clusters in reef-race-config.ts.
  // Verified by driving the real spline: arc=28356.5 wu, max|x|=606.4 wu,
  // min widthAt=959.6 wu (chicane), min radius=1590.7 wu.
  //
  // ── Segment 0: Open lagoon (wide straight, hw 1300) ───────────────────────
  { x:    0, z:     0, halfWidth: 1300 }, // CP  0  start line, lagoon mouth
  { x:    0, z:  1500, halfWidth: 1300 }, // CP  1  lagoon middle
  { x:    0, z:  3000, halfWidth: 1300 }, // CP  2  lagoon → kelp gate

  // ── Segment 1: Kelp forest (sweeping bend RIGHT +x, hw 1200, chicane@end) ─
  { x:  440, z:  5500, halfWidth: 1200 }, // CP  3  kelp bend entry +
  { x:  580, z:  8000, halfWidth: 1200 }, // CP  4  kelp bend apex +580 (max)
  { x:  340, z: 10500, halfWidth: 1100 }, // CP  5  kelp bend exit (narrowing)
  { x:    0, z: 12100, halfWidth:  960 }, // CP  6  CHICANE PINCH (kelp→wreck)

  // ── Segment 2: Shipwreck graveyard (sweeping bend LEFT -x, hw 1200) ───────
  { x: -480, z: 14200, halfWidth: 1200 }, // CP  7  wreck bend entry -
  { x: -600, z: 16400, halfWidth: 1200 }, // CP  8  wreck bend apex -600 (max)
  { x: -380, z: 18500, halfWidth: 1100 }, // CP  9  wreck bend exit (narrowing)
  { x:    0, z: 19600, halfWidth:  980 }, // CP 10  CHICANE PINCH (wreck→coral)

  // ── Segment 3: Coral canyon (sweeping bend RIGHT +x, hw 1200) ─────────────
  { x:  460, z: 21800, halfWidth: 1200 }, // CP 11  coral bend entry +
  { x:  600, z: 24000, halfWidth: 1200 }, // CP 12  coral bend apex +600 (max)
  { x:  300, z: 26100, halfWidth: 1200 }, // CP 13  coral bend exit → finish

  // ── Segment 4: Finish straight (wide straight, hw 1300) ───────────────────
  { x:    0, z: 27250, halfWidth: 1300 }, // CP 14  finish-straight entry
  { x:    0, z: 28000, halfWidth: 1300 }, // CP 15  FINISH LINE
];

/**
 * Compile-time sanity: 16 control points exactly (was 19 before the
 * 2026-06-02 water-dominant wide rebuild collapsed the slalom into 3 bends).
 */
export const REEF_RACE_DEFAULT_TRACK_LENGTH = 16 as const;
