/**
 * reef-race-track-layout.ts
 *
 * LOCKED v2 default track for Reef Race — 22 control-point centripetal
 * Catmull-Rom slalom river. Consumed by `ReefSpline` (see
 * `./reef-race-spline.ts`) for both the server sim corridor math AND
 * the client-side 3D river-bed builder. Single source of truth.
 *
 * 2026-04-30 90s rebuild (CP-INSERTION approach, see
 * `.claude/plans/track-90s-RECONCILED.md`): track lengthened from 18 000 →
 * 28 000 wu z-span by inserting +3 kelp / +2 shipwreck / +1 coral CPs while
 * preserving slalom amplitudes (±170 / ±200 / ±180) and per-segment halfWidth.
 *
 * ─── 5 themed segments ──────────────────────────────────────────────────────
 *
 *   Segment            z-range (wu)        CPs          halfWidth   Slalom
 *   ----------------   -----------------   ----------   ---------   --------
 *   0  Open lagoon       0 →  3 000        CP 0,1,2     3300 wu     none
 *   1  Kelp forest     3 000 → 12 100      CP 3-9       1990 wu     ±170 wu
 *   2  Shipwreck      12 100 → 19 600      CP 10-14     1650 wu     ±200 wu
 *   3  Coral canyon   19 600 → 26 100      CP 15-19     1320 wu     ±180 wu
 *   4  Finish straight 26 100 → 28 000      CP 20,21    3300 wu     none
 *
 * ─── Hand-math sanity (Risks doc §1: no two CPs within 88 wu in XZ) ─────────
 *
 *   Adjacent CP distances (Euclidean XZ, wu):
 *     0→1   1500    7→8   1344   14→15  1354
 *     1→2   1500    8→9   1344   15→16  1349
 *     2→3   1311    9→10  1545   16→17  1349
 *     3→4   1344   10→11  1552   17→18  1349
 *     4→5   1344   11→12  1552   18→19  1349
 *     5→6   1344   12→13  1552   19→20  1164
 *     6→7   1344   13→14  1552   20→21   750
 *
 *   min = 750 wu (CP20→CP21)   max = 1552 wu (CP10–CP14)   avg ≈ 1334 wu
 *
 *   Min/88 ≈ 8.5×  → comfortable margin against Newton mis-segmenting in
 *   `closestPointOnSpline`. The architecture-doc constraint is satisfied
 *   by ~10× headroom on EVERY adjacent pair.
 *
 *   Slalom waveform: alternating sign-flip per CP within each segment.
 *   Δz widened to ~1300 wu in kelp/coral (was 1125) for the 90s extension.
 *   Curvature radius math: R ≈ Δz²/(8·A) = 1300²/(8·170) ≈ 1242 wu in kelp,
 *   ~56× REEF_BODY_RADIUS (22 wu) — comfortable margin.
 *
 * ─── Total arc length target ────────────────────────────────────────────────
 *
 *   Straight-line z span: 28 000 wu. Catmull-Rom adds ~3-5% arc.
 *   Expected totalArcLength ≈ 29 500 → 30 200 wu.
 *
 *   At REEF_MAX_SPEED = 500 wu/s and effective cruising speed
 *   ~330 wu/s (turbo/slipstream-free), one-shot race time
 *   ≈ 30 000 / 330 ≈ 91 s — matches the 90s soft-timeout target.
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
 *   finish (CP20=(0,27250), CP21=(0,28000) → phantom_end at (0,28750)).
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
  // 2026-04-30: 90s rebuild via CP-INSERTION (was 18000 wu z-span / ~58s race).
  // Slalom segments lengthened proportionally: kelp 4500→9100, shipwreck 4500→7500,
  // coral 4500→6500. Lagoon + finish straights unchanged.
  // Half-widths preserved from iter-9 (×1.5 widening kept).
  { id: 'lagoon',    zStart:     0, zEnd:  3000, halfWidth: 3300 },
  { id: 'kelp',      zStart:  3000, zEnd: 12100, halfWidth: 1990 },
  { id: 'shipwreck', zStart: 12100, zEnd: 19600, halfWidth: 1650 },
  { id: 'coral',     zStart: 19600, zEnd: 26100, halfWidth: 1320 },
  { id: 'finish',    zStart: 26100, zEnd: 28000, halfWidth: 3300 },
];

// ─── Track layout ───────────────────────────────────────────────────────────

/**
 * REEF_RACE_DEFAULT_TRACK — locked v2 layout, 22 interior control points.
 *
 * Coordinate frame: XZ plane (Y is altitude, owned by `body.heightOffset`
 * per spline-architecture §4). CP[0] at origin (z=0). Track extends in
 * +Z direction to z=28 000. X meanders within ±200 wu for the slalom segments
 * and snaps to 0 on the lagoon/finish straights.
 *
 * Indices map 1:1 to the themed segments documented above. Field shape
 * matches `SplineControlPoint` exactly — passed straight to
 * `new ReefSpline(REEF_RACE_DEFAULT_TRACK)`.
 */
export const REEF_RACE_DEFAULT_TRACK: ReadonlyArray<SplineControlPoint> = [
  // ── Segment 0: Open lagoon (wide, no slalom) ──────────────────────────────
  { x:    0, z:     0, halfWidth: 3300 }, // CP  0  start line, lagoon mouth
  { x:    0, z:  1500, halfWidth: 3300 }, // CP  1  lagoon middle
  { x:    0, z:  3000, halfWidth: 3300 }, // CP  2  lagoon → kelp gate

  // ── Segment 1: Kelp forest (first slalom, ±170 wu, 7 CPs) ─────────────────
  { x:  170, z:  4300, halfWidth: 1990 }, // CP  3  kelp curve +
  { x: -170, z:  5600, halfWidth: 1990 }, // CP  4  kelp curve -
  { x:  170, z:  6900, halfWidth: 1990 }, // CP  5  kelp curve +
  { x: -170, z:  8200, halfWidth: 1990 }, // CP  6  kelp curve -        (NEW)
  { x:  170, z:  9500, halfWidth: 1990 }, // CP  7  kelp curve +        (NEW)
  { x: -170, z: 10800, halfWidth: 1990 }, // CP  8  kelp curve -        (NEW)
  { x:  170, z: 12100, halfWidth: 1990 }, // CP  9  kelp → shipwreck gate

  // ── Segment 2: Shipwreck graveyard (denser turns, ±200 wu, 5 CPs) ─────────
  { x: -200, z: 13600, halfWidth: 1650 }, // CP 10  hull-fragment chicane -
  { x:  200, z: 15100, halfWidth: 1650 }, // CP 11  hull-fragment chicane +
  { x: -200, z: 16600, halfWidth: 1650 }, // CP 12  hull-fragment chicane - (NEW)
  { x:  200, z: 18100, halfWidth: 1650 }, // CP 13  hull-fragment chicane + (NEW)
  { x: -200, z: 19600, halfWidth: 1650 }, // CP 14  shipwreck → coral gate

  // ── Segment 3: Coral canyon (tightest, ±180 wu, 5 CPs) ────────────────────
  { x:  180, z: 20900, halfWidth: 1320 }, // CP 15  coral chicane +
  { x: -180, z: 22200, halfWidth: 1320 }, // CP 16  coral chicane -
  { x:  180, z: 23500, halfWidth: 1320 }, // CP 17  coral chicane +
  { x: -180, z: 24800, halfWidth: 1320 }, // CP 18  coral chicane -      (NEW)
  { x:  180, z: 26100, halfWidth: 1320 }, // CP 19  coral → finish gate

  // ── Segment 4: Finish straight (wide, no slalom) ──────────────────────────
  { x:    0, z: 27250, halfWidth: 3300 }, // CP 20  finish-straight entry
  { x:    0, z: 28000, halfWidth: 3300 }, // CP 21  FINISH LINE
];

/**
 * Compile-time sanity: 22 control points exactly.
 */
export const REEF_RACE_DEFAULT_TRACK_LENGTH = 22 as const;
