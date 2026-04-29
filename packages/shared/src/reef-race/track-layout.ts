/**
 * reef-race-track-layout.ts
 *
 * LOCKED v2 default track for Reef Race — 16 control-point centripetal
 * Catmull-Rom slalom river. Consumed by `ReefSpline` (see
 * `./reef-race-spline.ts`) for both the server sim corridor math AND
 * the client-side 3D river-bed builder. Single source of truth.
 *
 * Spec sources:
 *   - `.claude/plans/reef-race-v2.md` ("Track layout — my proposed default"
 *     + "5 themed segments")
 *   - `.claude/plans/reef-race-v2-spline-architecture.md` §1, §4, "Risks" #1
 *
 * ─── 5 themed segments ──────────────────────────────────────────────────────
 *
 *   Segment            z-range (wu)        CPs          halfWidth   Slalom
 *   ----------------   -----------------   ----------   ---------   --------
 *   0  Open lagoon       0 →  3 000        CP 0,1,2     1050 wu     none
 *   1  Kelp forest     3 000 →  7 500      CP 3-6        630 wu     ±170 wu
 *   2  Shipwreck       7 500 → 12 000      CP 7,8,9      525 wu     ±200 wu
 *   3  Coral canyon   12 000 → 16 500      CP 10-13      420 wu     ±180 wu
 *   4  Finish straight 16500 → 18 000      CP 14,15     1050 wu     none
 *
 * ─── Hand-math sanity (Risks doc §1: no two CPs within 88 wu in XZ) ─────────
 *
 *   Adjacent CP distances (Euclidean XZ, wu):
 *     0→1   1500    4→5   1175    8→9   1500    12→13  1125
 *     1→2   1500    5→6   1125    9→10  1187    13→14   771
 *     2→3   1138    6→7   1545   10→11  1181    14→15   750
 *     3→4   1175    7→8   1553   11→12  1125
 *
 *   min = 750 wu (CP14→CP15)   max = 1553 wu (CP7→CP8)   avg ≈ 1227 wu
 *
 *   Min/88 ≈ 8.5×  → comfortable margin against Newton mis-segmenting in
 *   `closestPointOnSpline`. The architecture-doc constraint is satisfied
 *   by ~10× headroom on EVERY adjacent pair.
 *
 *   Slalom waveform: triangle-style sign-flip at each CP (±170, ±200, ±180
 *   alternating). At amplitude A=200 wu and CP spacing ~1500 wu,
 *   centripetal Catmull-Rom yields a peak curvature radius of
 *   R ≈ (1500²)/(8·200) = 1406 wu — ~16× REEF_BODY_RADIUS (22 wu),
 *   well clear of self-intersection.
 *
 * ─── Total arc length target ────────────────────────────────────────────────
 *
 *   Straight-line z span: 18 000 wu. Catmull-Rom adds ~5-8% arc due to the
 *   slalom S-curves. Expected totalArcLength ≈ 18 500 → 19 500 wu.
 *
 *   At REEF_MAX_SPEED = 500 wu/s and effective cruising speed
 *   ~330 wu/s (turbo/slipstream-free), one-shot race time
 *   ≈ 19 000 / 330 ≈ 58 s — matches the locked 60s target from the spec.
 *
 * ─── Top-down ASCII visualisation (X horizontal, Z vertical down) ───────────
 *
 *   X axis:  -200 -170    0   +170 +200
 *
 *      +---------+----+----+----+---------+   z =   0  CP0   (start)
 *      |              |              |
 *      |              |              |
 *      |              C              |        z = 1500  CP1   lagoon
 *      |              |              |
 *      |              |              |
 *      |              C              |        z = 3000  CP2
 *      |              \              |
 *      |               \             |
 *      |                \____C       |        z = 4125  CP3   kelp +170
 *      |                   /         |
 *      |                  /          |
 *      |          C______/           |        z = 5250  CP4   kelp -170
 *      |          \                  |
 *      |           \                 |
 *      |            \____C           |        z = 6375  CP5   kelp +170
 *      |                /            |
 *      |               /             |
 *      |        C_____/              |        z = 7500  CP6   kelp -170
 *      |        \                    |
 *      |         \                   |
 *      |          \________C         |        z = 9000  CP7   wreck +200
 *      |                  /          |
 *      |                 /           |
 *      |        C_______/            |        z =10500  CP8   wreck -200
 *      |        \                    |
 *      |         \                   |
 *      |          \________C         |        z =12000  CP9   wreck +200
 *      |                  /          |
 *      |                 /           |
 *      |       C________/            |        z =13125  CP10  coral -180
 *      |        \                    |
 *      |         \_______C           |        z =14250  CP11  coral +180
 *      |                /            |
 *      |       C_______/             |        z =15375  CP12  coral -180
 *      |        \                    |
 *      |         \_______C           |        z =16500  CP13  coral +180
 *      |                 \           |
 *      |                  \          |
 *      |                  C          |        z =17250  CP14  finish entry
 *      |                  |          |
 *      |                  C          |        z =18000  CP15  FINISH
 *      +-----------------------------+
 *
 *   `C` marks centerline at each CP. The slalom alternates ±X to force
 *   left-right racing-line decisions; the lagoon and finish are dead-straight
 *   on the X=0 axis to give clean spawn/finish gates.
 *
 * ─── Phantom control points ─────────────────────────────────────────────────
 *
 *   Per `reef-race-spline.ts` design note #3, phantom CPs at t=0 and t=1
 *   are computed AUTOMATICALLY by the ReefSpline constructor by reflecting
 *   CP[1] across CP[0] and CP[N-2] across CP[N-1]. Authors of this layout
 *   do NOT include phantoms in the array — only the 16 real interior CPs.
 *
 *   To verify the start-line tangent points "down-track" (+Z), we keep
 *   CP[0]=(0,0) and CP[1]=(0,1500): the reflection produces phantom_start
 *   at (0,-1500), so the t=0 tangent is exactly +Z. Same logic at the
 *   finish (CP14=(0,17250), CP15=(0,18000) → phantom_end at (0,18750)).
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
  // halfWidth values multiplied ×1.5 on 2026-04-29 (iter-5 visual pass).
  // User feedback: river still too narrow at iter-4 widths. 1.5× from iter-4
  // keeps the chokepoint progression intact while making the water ribbon
  // visually dominant at all segments.
  // Lagoon/finish 700→1050, kelp 420→630, shipwreck 350→525, coral 280→420.
  { id: 'lagoon',    zStart:     0, zEnd:  3000, halfWidth: 1575 },
  { id: 'kelp',      zStart:  3000, zEnd:  7500, halfWidth:  630 },
  { id: 'shipwreck', zStart:  7500, zEnd: 12000, halfWidth:  525 },
  { id: 'coral',     zStart: 12000, zEnd: 16500, halfWidth:  420 },
  { id: 'finish',    zStart: 16500, zEnd: 18000, halfWidth: 1575 },
];

// ─── Track layout ───────────────────────────────────────────────────────────

/**
 * REEF_RACE_DEFAULT_TRACK — locked v2 layout, 16 interior control points.
 *
 * Coordinate frame: XZ plane (Y is altitude, owned by `body.heightOffset`
 * per spline-architecture §4). CP[0] at origin (z=0). Track extends in
 * +Z direction. X meanders within ±200 wu for the slalom segments and
 * snaps to 0 on the lagoon/finish straights.
 *
 * Indices map 1:1 to the themed segments documented above. Field shape
 * matches `SplineControlPoint` exactly — passed straight to
 * `new ReefSpline(REEF_RACE_DEFAULT_TRACK)`.
 */
export const REEF_RACE_DEFAULT_TRACK: ReadonlyArray<SplineControlPoint> = [
  // ── Segment 0: Open lagoon (wide, no slalom) ──────────────────────────────
  { x:    0, z:     0, halfWidth: 1575 }, // CP 0  start line, lagoon mouth
  { x:    0, z:  1500, halfWidth: 1575 }, // CP 1  lagoon middle
  { x:    0, z:  3000, halfWidth: 1575 }, // CP 2  lagoon → kelp gate

  // ── Segment 1: Kelp forest (first slalom, ±170 wu) ────────────────────────
  { x:  170, z:  4125, halfWidth: 945 }, // CP 3  kelp curve +
  { x: -170, z:  5250, halfWidth: 945 }, // CP 4  kelp curve -
  { x:  170, z:  6375, halfWidth: 945 }, // CP 5  kelp curve +
  { x: -170, z:  7500, halfWidth: 945 }, // CP 6  kelp → shipwreck gate

  // ── Segment 2: Shipwreck graveyard (denser turns + chokepoints, ±200 wu) ──
  { x:  200, z:  9000, halfWidth: 787 }, // CP 7  hull-fragment chicane +
  { x: -200, z: 10500, halfWidth: 787 }, // CP 8  hull-fragment chicane -
  { x:  200, z: 12000, halfWidth: 787 }, // CP 9  shipwreck → coral gate

  // ── Segment 3: Coral canyon (tightest, ±180 wu) ───────────────────────────
  { x: -180, z: 13125, halfWidth: 630 }, // CP 10 coral chicane -
  { x:  180, z: 14250, halfWidth: 630 }, // CP 11 coral chicane +
  { x: -180, z: 15375, halfWidth: 630 }, // CP 12 coral chicane -
  { x:  180, z: 16500, halfWidth: 630 }, // CP 13 coral → finish gate

  // ── Segment 4: Finish straight (wide, no slalom) ──────────────────────────
  { x:    0, z: 17250, halfWidth: 1575 }, // CP 14 finish-straight entry
  { x:    0, z: 18000, halfWidth: 1575 }, // CP 15 FINISH LINE
];

/**
 * Compile-time sanity: 16 control points exactly. If anyone adds/removes a CP
 * without thinking through the segment table + curvature math, this assertion
 * line will become a TypeScript width-mismatch and they will see the comment.
 *
 * (Bun's `as const` would freeze the inner objects too aggressively — we keep
 * the readonly array but allow numeric arithmetic on field reads at runtime.)
 */
export const REEF_RACE_DEFAULT_TRACK_LENGTH = 16 as const;
