/**
 * reef-race-spline.ts
 *
 * Standalone Catmull-Rom spline math for Reef Race v2.
 *
 * DESIGN DECISIONS
 * ────────────────
 * 1. Centripetal Catmull-Rom (alpha = 0.5).
 *    Uniform Catmull-Rom (alpha = 0) can overshoot and self-intersect when
 *    control points are non-uniformly spaced (e.g. a tight chicane followed
 *    by a long straight). Centripetal uses sqrt(chord-length) as the
 *    parameterisation increment, which provably avoids self-intersection and
 *    eliminates cusps without any designer-side tuning. The track designer
 *    only places XZ positions; the math handles the rest.
 *
 * 2. Arclength LUT — 1 000 entries via Simpson integration.
 *    The current closed track is ≈ 88 052 wu, or ≈ 88 wu/LUT interval. A body
 *    moves ≤ 43.3 wu/tick at REEF_MAX_SPEED=1300 wu/s, 30 Hz. Speed does not
 *    determine inverse-arclength accuracy: binary search brackets the monotonic
 *    LUT and linearly interpolates within the bracket. The isolated spline suite
 *    enforces the load-bearing <0.5 wu arclength round-trip tolerance.
 *
 * 3. Phantom control points at open endpoints (OPEN mode only).
 *    Catmull-Rom needs four control points to evaluate one segment. At the
 *    open ends (t=0 and t=1) one phantom point is prepended/appended.
 *    Phantom[start] = CP[0] + (CP[0] - CP[1]) — reflects CP[1] across CP[0].
 *    Phantom[end]   = CP[N-1] + (CP[N-1] - CP[N-2]) — reflects inward.
 *    This keeps the tangent at the endpoint consistent with the first/last
 *    real segment direction. The "+200 wu" note in the architecture doc refers
 *    to a specific track-design suggestion, not a formula invariant.
 *
 * 3b. PERIODIC CLOSURE (CLOSED mode, opt-in via `{ closed: true }`, added
 *    2026-06-22 for the closed-loop ring track).
 *    A closed loop has N real control points and **N segments, not N-1** —
 *    the closing chord CP[N-1] → CP[0] is a REAL segment. There are NO phantom
 *    reflections; instead the four-point neighbours WRAP AROUND the ring.
 *
 *    We build an AUGMENTED point array of length N+3 by wrapping:
 *      pts = [ CP[N-1], CP[0], CP[1], …, CP[N-1], CP[0], CP[1] ]
 *              ^wrap-1   ^─────── the N real CPs ───────^  ^wrap +1 +2
 *    Indices 1..N are the N real CPs (pts[1] = CP[0], pts[N] = CP[N-1]).
 *    Segment i (0..N-1) is evaluated from the four points pts[i..i+3] with
 *    knot values knots[i..i+3] — identical machinery to the OPEN evaluator,
 *    so the seam (segment N-1, the closing chord, → segment 0) is treated
 *    EXACTLY like any interior boundary. That is why C1 continuity holds at
 *    the seam with no special-casing: there is no special boundary.
 *
 *    Real parametric domain: t∈[0,1] maps to knot range [knots[1], knots[1+N]]
 *    (CP[0] → CP[0]-again, one full loop). By construction
 *      centerlineAt(0) === centerlineAt(1)  (same physical point — CP[0]),
 *      tangentAt(0)    ≈   tangentAt(1)      (C1 across the seam),
 *      widthAt(0)      ===  widthAt(1).
 *    The knot increments for the wrap neighbours use the SAME real
 *    sqrt-chord-length math (alpha=0.5) as interior knots, so the closing
 *    chord contributes its true arc length to totalArcLength.
 *
 *    closestPointOnSpline in CLOSED mode: the coarse LUT scan covers the whole
 *    loop (including the closing segment), and Newton is wrapped MODULO the
 *    loop so a query point sitting just past the seam converges to the nearest
 *    side (t near 0) instead of snapping to t≈1 on the wrong side. The final t
 *    is normalised into [0, 1).
 *
 * 4. closestPointOnSpline — Newton's method seeded from LUT coarse scan.
 *    The LUT coarse scan (1 000 samples) identifies the t with smallest
 *    distance to the query point. This guarantees Newton starts in the correct
 *    basin even on tight S-curves, as long as the track never folds within
 *    88 wu of itself (the 4×REEF_BODY_RADIUS constraint from the architecture
 *    doc). 6 Newton iterations give sub-0.01 wu error.
 *
 * 5. Side determination.
 *    cross = tangent.x * (p.z - c.z) - tangent.z * (p.x - c.x)
 *    cross > 0 → 'L' (left of travel direction = normal side).
 *    cross < 0 → 'R'.
 *
 * COORDINATE SYSTEM
 * ─────────────────
 * All math is in the XZ plane (Y is altitude, handled by heightOffset in the
 * sim — orthogonal to this module). Vec2 has fields { x, z } to make this
 * explicit. The sim's "flat plane" matches Three.js XZ convention.
 *
 * DERIVATIVE CHAIN (centripetal parameterisation)
 * ───────────────────────────────────────────────
 * Global t ∈ [0, 1] maps to knot space via:
 *   kTarget = kStart + t * kRange
 *
 * where kStart = knots[1] (first real CP) and kEnd = knots[N] (last real CP)
 * and kRange = kEnd - kStart.
 *
 * Within each segment, the knot parameter tK equals kTarget directly.
 * So dtK/dt_global = kRange.
 *
 * Therefore: dC/dt_global = dC/dtK * kRange
 *
 * The Simpson integrand for arc length is |dC/dt_global| = |dC/dtK| * kRange.
 * The Newton residual uses dC/dtK (unnormalized), and the chain-rule correction
 * is absorbed into the finite-difference step size (also in global t).
 *
 * UNITS
 * ─────
 * World units (wu). Typical track: ~30 000 wu total arc.
 *
 * @module reef-race-spline
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * 2D vector in the XZ plane.
 * We use `z` (not `y`) to match Three.js XZ convention and avoid confusion
 * with the sim's Y-axis (altitude / heightOffset).
 */
export interface Vec2 {
  x: number;
  z: number;
}

/** 3D vector (for bankNormalAt which returns a world-up vector). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * One immutable arclength LUT sample. Position is cached alongside `t`/`s`
 * because closest-point queries scan every sample at 30 Hz for every racer.
 */
interface LutEntry {
  t: number;
  s: number;
  x: number;
  z: number;
}

/**
 * A control point on the spline with a half-width annotation.
 * `halfWidth` is the corridor half-width (wu) at this control point.
 * It is interpolated by Catmull-Rom in `widthAt(t)`. Must be > 0.
 */
export interface SplineControlPoint {
  x: number;
  z: number;
  /** Corridor half-width at this control point (wu). Must be > 0. */
  halfWidth: number;
}

/**
 * Construction options for {@link ReefSpline}.
 *
 * Omitting the options object (or passing `{}`) yields a 100%-back-compat OPEN
 * spline — bit-identical to the pre-2026-06-22 behaviour.
 */
export interface ReefSplineOptions {
  /**
   * When `true`, the spline is a TRUE PERIODIC (closed) loop: the four-point
   * Catmull-Rom neighbours wrap around (CP[n-1] and CP[0] are neighbours), the
   * closing chord CP[n-1]→CP[0] is a real segment (n segments, not n-1), and
   * centerlineAt(0) === centerlineAt(1). Default `false` (open with phantom
   * endpoints). See module doc note #3b.
   */
  closed?: boolean;
}

/**
 * Result of the closest-point query.
 */
export interface ClosestPointResult {
  /** Parametric t in [0, 1]. */
  t: number;
  /** Unsigned perpendicular distance from the centerline (wu). */
  distance: number;
  /** Which side of the track the point is on. 'L' = left of travel direction. */
  side: 'L' | 'R';
  /** Closest point on the centerline (XZ). */
  closestX: number;
  closestZ: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Number of LUT samples. The current ~88 052 wu ring is verified by the
 * <0.5 wu arclength round-trip tests. See design note #2.
 */
const LUT_SAMPLES = 1000;

/**
 * Number of Newton iterations for closestPointOnSpline.
 * 6 iterations reliably converge to < 0.01 wu on all tested geometries.
 */
const NEWTON_MAX_ITER = 6;

/**
 * Early-exit tolerance for Newton (in global t units).
 * If the Newton step |dt| falls below this, convergence is assumed.
 */
const NEWTON_TOLERANCE = 1e-7;

/**
 * Step size for the finite-difference first derivative used in Newton's method
 * (in global t units). Must be large enough to avoid float cancellation but
 * small enough to capture local curvature. 5e-4 is safe for tracks with
 * segment knot spans ≥ 0.001 in global t.
 */
const NEWTON_DERIV_H = 5e-4;

// ─── ReefSpline class ─────────────────────────────────────────────────────────

/**
 * Centripetal Catmull-Rom spline for Reef Race v2 corridor math.
 *
 * Construction is O(LUT_SAMPLES). After construction the object is immutable
 * in practice — all methods are pure (no mutation of internal state at runtime).
 *
 * @example
 * ```ts
 * const spline = new ReefSpline([
 *   { x: 0, z: 0, halfWidth: 200 },
 *   { x: 1000, z: 500, halfWidth: 250 },
 *   // … more control points
 * ]);
 *
 * const pos = spline.centerlineAt(0.5);
 * const t = spline.tFromArclength(spline.totalArcLength * 0.5);
 * ```
 */
export class ReefSpline {
  /**
   * Phantom-augmented control-point array.
   * Index 0 = start phantom, 1..n = real CPs, n+1 = end phantom.
   */
  private readonly pts: ReadonlyArray<SplineControlPoint>;

  /** Number of REAL control points (excludes phantoms). */
  private readonly n: number;

  /**
   * Centripetal knot values for ALL points (including phantoms).
   * knots[i] is the cumulative sum of sqrt(chord_length) increments.
   * The real parametric range is [knots[1], knots[n]].
   */
  private readonly knots: ReadonlyArray<number>;

  /**
   * The full knot range: kEnd - kStart.
   * Used as the scale factor dtK/dt_global in derivative computations.
   *   dC/dt_global = dC/dtK * kRange
   */
  private readonly kRange: number;

  /** Knot value at t=0 (first real control point). */
  private readonly kStart: number;

  /**
   * Arclength LUT. Monotonically increasing in both `t` and `s`; each entry
   * also caches the immutable centerline position used by closest-point scans.
   * lut[0].s = 0, lut[LUT_SAMPLES].s ≈ totalArcLength.
   */
  private readonly lut: ReadonlyArray<LutEntry>;

  /** Total arc length of the spline (wu). */
  public readonly totalArcLength: number;

  /** True when this spline is a periodic (closed) loop. See module doc #3b. */
  public readonly closed: boolean;

  /**
   * @param controlPoints  The N real control points (no phantoms; for a closed
   *                        loop do NOT repeat CP[0] at the end — the wrap is
   *                        added internally).
   * @param opts           Optional. `{ closed: true }` builds a periodic loop.
   *                        Omitting it (or `{}`) is the back-compat OPEN spline.
   */
  constructor(
    controlPoints: ReadonlyArray<SplineControlPoint>,
    opts?: ReefSplineOptions,
  ) {
    const closed = opts?.closed === true;
    // A closed loop needs at least 3 real CPs to form a non-degenerate ring;
    // the open path keeps its historical 2-CP minimum.
    if (closed) {
      if (controlPoints.length < 3) {
        throw new Error('ReefSpline closed loop requires at least 3 control points');
      }
      // Reject an explicitly duplicated terminal CP (author appended a copy of
      // CP[0] at the end). The wrap is INTERNAL — a literal duplicate makes the
      // closing chord CP[N-1]→CP[0] zero/epsilon length, which collapses the
      // seam knot span (the _kl/_kld helpers treat span<1e-12 as degenerate)
      // and produces a seam CUSP. Authors must NOT include the closing point.
      const f = controlPoints[0];
      const l = controlPoints[controlPoints.length - 1];
      if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.z - l.z) < 1e-6) {
        throw new Error(
          'ReefSpline closed loop: do not duplicate the start point as the last ' +
            'control point — the periodic wrap is added internally (CP[N-1]→CP[0] ' +
            'is the closing chord). Drop the duplicated terminal CP.',
        );
      }
    } else if (controlPoints.length < 2) {
      throw new Error('ReefSpline requires at least 2 control points');
    }
    this.closed = closed;
    this.n = controlPoints.length;

    let pts: SplineControlPoint[];
    if (closed) {
      // ── Periodic wrap (no phantom reflection) ───────────────────────────
      //
      // Augmented array of length N+3 wrapping the ring:
      //   [ CP[N-1], CP[0], CP[1], …, CP[N-1], CP[0], CP[1] ]
      //     wrap-1    1      2          N        N+1   N+2
      // pts[1..N] are the N real CPs (pts[1]=CP[0] … pts[N]=CP[N-1]).
      // Segment i (0..N-1) reads pts[i..i+3]; segment N-1 (the closing chord)
      // reads pts[N-1..N+2] = [CP[N-2], CP[N-1], CP[0], CP[1]] — a real wrap,
      // identical machinery to an interior segment so the seam is C1.
      const n = controlPoints.length;
      pts = new Array(n + 3);
      pts[0] = controlPoints[n - 1];           // wrap before: CP[N-1]
      for (let i = 0; i < n; i++) {
        pts[i + 1] = controlPoints[i];         // the N real CPs
      }
      pts[n + 1] = controlPoints[0];           // wrap after: CP[0]
      pts[n + 2] = controlPoints[1];           // wrap after: CP[1]
    } else {
      // ── Phantom control points (OPEN mode) ──────────────────────────────
      //
      // Phantom[start] = 2*CP[0] - CP[1]   (reflects CP[1] across CP[0])
      // Phantom[end]   = 2*CP[N-1] - CP[N-2] (reflects CP[N-2] across CP[N-1])
      //
      // This ensures the tangent at t=0 and t=1 is continuous with the
      // adjacent real segment, with no special-casing in the evaluator.
      const first = controlPoints[0];
      const second = controlPoints[1];
      const last = controlPoints[controlPoints.length - 1];
      const secondLast = controlPoints[controlPoints.length - 2];

      const phantomStart: SplineControlPoint = {
        x: 2 * first.x - second.x,
        z: 2 * first.z - second.z,
        halfWidth: first.halfWidth,
      };
      const phantomEnd: SplineControlPoint = {
        x: 2 * last.x - secondLast.x,
        z: 2 * last.z - secondLast.z,
        halfWidth: last.halfWidth,
      };

      pts = [phantomStart, ...controlPoints, phantomEnd];
    }
    this.pts = pts;

    // ── Centripetal knot sequence ────────────────────────────────────────
    //
    // For centripetal Catmull-Rom (alpha = 0.5):
    //   knot[i+1] = knot[i] + |pts[i+1] - pts[i]|^0.5
    //             = knot[i] + sqrt(sqrt(dx² + dz²))
    //
    // This is the standard centripetal parameterisation that prevents
    // self-intersection and overshoot on non-uniform point spacing.
    // In CLOSED mode the wrap neighbours use the SAME real sqrt-chord math, so
    // the closing chord contributes its true length to the arc.
    const knots: number[] = new Array(pts.length);
    knots[0] = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dz = pts[i].z - pts[i - 1].z;
      // alpha=0.5: increment = (dx²+dz²)^(alpha/2) = (dx²+dz²)^0.25
      const increment = Math.pow(dx * dx + dz * dz, 0.25);
      knots[i] = knots[i - 1] + Math.max(increment, 1e-10);
    }
    this.knots = knots;

    // kStart = knots[1] (t=0 maps here).
    // OPEN:   kEnd = knots[n]   (t=1 maps to CP[N-1], the last real CP).
    // CLOSED: kEnd = knots[1+n] (t=1 maps to the wrap copy of CP[0] — i.e. one
    //         full loop back to the start, INCLUDING the closing chord).
    const kStart = knots[1];
    const kEnd = closed ? knots[1 + this.n] : knots[this.n];
    this.kStart = kStart;
    this.kRange = kEnd - kStart;

    // ── Arclength LUT via Simpson's rule ─────────────────────────────────
    //
    // Integrate |dC/dt_global| from t=0 to t=1 in LUT_SAMPLES equal steps.
    // Simpson's rule on each interval [t0, t1] with midpoint tm:
    //   arc ≈ (t1-t0)/6 * (|speed(t0)| + 4*|speed(tm)| + |speed(t1)|)
    //
    // |dC/dt_global| = |dC/dtK| * kRange  (see derivative chain in module doc).
    const lutArr: LutEntry[] = new Array(LUT_SAMPLES + 1);
    const start = this.centerlineAt(0);
    lutArr[0] = { t: 0, s: 0, x: start.x, z: start.z };
    let totalArc = 0;
    const dt = 1 / LUT_SAMPLES;

    for (let i = 1; i <= LUT_SAMPLES; i++) {
      const t0 = (i - 1) * dt;
      const t1 = i * dt;
      const tm = (t0 + t1) * 0.5;
      const spd0 = this._speedAt(t0);
      const spdM = this._speedAt(tm);
      const spd1 = this._speedAt(t1);
      const segArc = ((t1 - t0) / 6) * (spd0 + 4 * spdM + spd1);
      totalArc += segArc;
      const center = this.centerlineAt(t1);
      lutArr[i] = {
        t: t1,
        s: totalArc,
        x: center.x,
        z: center.z,
      };
    }

    this.lut = lutArr;
    this.totalArcLength = totalArc;
  }

  // ─── Public primitives ──────────────────────────────────────────────────

  /**
   * Catmull-Rom interpolated centerline position at parametric t ∈ [0, 1].
   *
   * @param t  Parametric position. Clamped to [0, 1].
   * @returns  XZ position (wu).
   */
  public centerlineAt(t: number): Vec2 {
    const { seg, tK } = this._toKnot(t);
    return this._evalXZ(seg, tK);
  }

  /**
   * Unit tangent vector (direction of increasing t) at parametric t ∈ [0, 1].
   *
   * Computed as the analytic derivative of the Catmull-Rom position function
   * w.r.t. the knot parameter, then normalized. Degenerate (zero-length)
   * case returns { x: 1, z: 0 }.
   *
   * @param t  Parametric position. Clamped to [0, 1].
   * @returns  Normalized XZ tangent vector (unit length).
   */
  public tangentAt(t: number): Vec2 {
    const { seg, tK } = this._toKnot(t);
    const raw = this._derivXZ(seg, tK);
    const mag = Math.sqrt(raw.x * raw.x + raw.z * raw.z);
    if (mag < 1e-10) return { x: 1, z: 0 };
    return { x: raw.x / mag, z: raw.z / mag };
  }

  /**
   * Unit normal vector — 90° CCW rotation of the tangent in the XZ plane.
   * Points to the LEFT of the travel direction.
   *
   * @param t  Parametric position. Clamped to [0, 1].
   * @returns  Normalized XZ normal vector (unit length, perpendicular to tangent).
   */
  public normalAt(t: number): Vec2 {
    const tg = this.tangentAt(t);
    // 90° CCW rotation in XZ: (x, z) → (-z, x)
    return { x: -tg.z, z: tg.x };
  }

  /**
   * Bank normal (world up vector) at parametric t ∈ [0, 1].
   *
   * Phase 1: always { 0, 1, 0 }. Reserved for future banked-turn support.
   *
   * @param _t  Parametric position. Ignored in Phase 1.
   * @returns   World-up Vec3.
   */
  public bankNormalAt(_t: number): Vec3 {
    return { x: 0, y: 1, z: 0 };
  }

  /**
   * Catmull-Rom interpolated half-width of the track corridor at t ∈ [0, 1].
   * Widths interpolate smoothly through chicanes and wide sections.
   *
   * @param t  Parametric position. Clamped to [0, 1].
   * @returns  Half-width (wu). Positive for well-formed control points.
   */
  public widthAt(t: number): number {
    const { seg, tK } = this._toKnot(t);
    return this._evalWidth(seg, tK);
  }

  /**
   * Arc distance from the spline start to parametric t (wu).
   * Binary search on the prebuilt LUT + linear interpolation.
   *
   * @param t  Parametric position. Clamped to [0, 1].
   * @returns  Arc distance s ≥ 0 (wu).
   */
  public arclengthFromT(t: number): number {
    const tc = Math.max(0, Math.min(1, t));
    let lo = 0;
    let hi = this.lut.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.lut[mid].t <= tc) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const e0 = this.lut[lo];
    const e1 = this.lut[hi];
    if (e1.t === e0.t) return e0.s;
    const alpha = (tc - e0.t) / (e1.t - e0.t);
    return e0.s + alpha * (e1.s - e0.s);
  }

  /**
   * Inverse arclength: converts arc distance s (wu) to parametric t ∈ [0, 1].
   * Binary search on the monotonic LUT + linear interpolation.
   *
   * @param s  Arc distance (wu). Clamped to [0, totalArcLength].
   * @returns  Parametric t ∈ [0, 1].
   */
  public tFromArclength(s: number): number {
    const sc = Math.max(0, Math.min(this.totalArcLength, s));
    let lo = 0;
    let hi = this.lut.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.lut[mid].s <= sc) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const e0 = this.lut[lo];
    const e1 = this.lut[hi];
    if (e1.s === e0.s) return e0.t;
    const alpha = (sc - e0.s) / (e1.s - e0.s);
    return e0.t + alpha * (e1.t - e0.t);
  }

  /**
   * Closest point on the spline to the given XZ position p.
   *
   * Algorithm:
   *   1. Coarse scan: evaluate centerlineAt at every LUT sample, find the
   *      t* with minimum squared distance to p. O(LUT_SAMPLES).
   *   2. Newton refinement starting from t*: minimize
   *        f(t) = (C(t) - p) · C'(t)   (zero when perpendicular)
   *      using:
   *        t ← t - f(t) / f'(t)
   *      f'(t) approximated via central finite difference.
   *   3. Clamp t to [0, 1].
   *   4. Compute side from cross product of tangent × offset.
   *
   * Convergence guarantee: as long as the track never folds within 88 wu
   * (4×REEF_BODY_RADIUS) of itself, the coarse scan places Newton in the
   * correct basin. 6 iterations give < 0.01 wu error.
   *
   * @param p  Query XZ position (wu).
   * @returns  Closest point with t, unsigned distance, side, closestX/Z.
   */
  public closestPointOnSpline(p: Vec2): ClosestPointResult {
    // ── Step 1: Coarse scan ─────────────────────────────────────────────
    let bestT = 0;
    let bestDistSq = Infinity;

    for (let i = 0; i < this.lut.length; i++) {
      const sample = this.lut[i];
      const dx = sample.x - p.x;
      const dz = sample.z - p.z;
      const dsq = dx * dx + dz * dz;
      if (dsq < bestDistSq) {
        bestDistSq = dsq;
        bestT = sample.t;
      }
    }

    // ── Step 2: Newton refinement ───────────────────────────────────────
    //
    // Minimize: f(t) = (C(t) - p) · T(t)
    // where T(t) is the UNNORMALIZED tangent dC/dtK.
    // (Normalizing doesn't change where f=0, but avoids a division in the inner loop.)
    //
    // f'(t) ≈ central finite difference: (f(t+h) - f(t-h)) / (2h)
    // h is in global t units (NEWTON_DERIV_H).
    let t = bestT;
    if (this.closed) {
      // CLOSED: the seam is continuous, so Newton wraps MODULO the loop rather
      // than clamping. Central differences straddle the seam with wrap-around
      // (no one-sided clamp), and the step wraps into [0,1) — so a point just
      // past the seam converges to t near 0 instead of snapping to t≈1.
      for (let iter = 0; iter < NEWTON_MAX_ITER; iter++) {
        const f0 = this._newtonResidual(p, t);

        const tP = wrap01(t + NEWTON_DERIV_H);
        const tM = wrap01(t - NEWTON_DERIV_H);
        const fP = this._newtonResidual(p, tP);
        const fM = this._newtonResidual(p, tM);

        // Denominator is the true (unwrapped) 2h — wrap01 only moves the
        // EVALUATION point, the parametric spacing is still 2·NEWTON_DERIV_H.
        const fPrime = (fP - fM) / (2 * NEWTON_DERIV_H);
        if (Math.abs(fPrime) < 1e-12) break; // degenerate segment

        const dt = f0 / fPrime;
        t = wrap01(t - dt);

        if (Math.abs(dt) < NEWTON_TOLERANCE) break;
      }
    } else {
      for (let iter = 0; iter < NEWTON_MAX_ITER; iter++) {
        const f0 = this._newtonResidual(p, t);

        const tP = Math.min(1, t + NEWTON_DERIV_H);
        const tM = Math.max(0, t - NEWTON_DERIV_H);
        const fP = this._newtonResidual(p, tP);
        const fM = this._newtonResidual(p, tM);

        const fPrime = (fP - fM) / (tP - tM);
        if (Math.abs(fPrime) < 1e-12) break; // degenerate segment

        const dt = f0 / fPrime;
        t = Math.max(0, Math.min(1, t - dt));

        if (Math.abs(dt) < NEWTON_TOLERANCE) break;
      }
    }

    // ── Step 3: Result ──────────────────────────────────────────────────
    const closest = this.centerlineAt(t);
    const dx = p.x - closest.x;
    const dz = p.z - closest.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    // ── Step 4: Side ────────────────────────────────────────────────────
    // cross = tangent × offset (2D cross product):
    //   cross = tg.x * dz - tg.z * dx
    // cross > 0 → p is to the LEFT of travel direction → 'L'
    // cross < 0 → p is to the RIGHT → 'R'
    const tg = this.tangentAt(t);
    const cross = tg.x * dz - tg.z * dx;
    const side: 'L' | 'R' = cross >= 0 ? 'L' : 'R';

    return {
      t,
      distance,
      side,
      closestX: closest.x,
      closestZ: closest.z,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Convert global t ∈ [0, 1] to the knot parameter tK and the segment index.
   *
   * Segment i spans between real points i and i+1 (0-indexed).
   * The four Catmull-Rom points for segment i are:
   *   pts[i], pts[i+1], pts[i+2], pts[i+3]
   *   (= phantom/CP[i-1], CP[i], CP[i+1], phantom/CP[i+2] in 0-indexed terms)
   *
   * tK is the knot parameter in [knots[1], knots[n]], equal to
   *   kStart + t * kRange.
   */
  private _toKnot(t: number): { seg: number; tK: number } {
    const tc = Math.max(0, Math.min(1, t));
    const tK = this.kStart + tc * this.kRange;

    // Binary search for the segment whose knot interval contains tK.
    // Segment i has knot interval [knots[i+1], knots[i+2]] in the pts array.
    // OPEN:   i ∈ [0, n-2] — n-1 segments between n real points.
    // CLOSED: i ∈ [0, n-1] — n segments (the extra one is the closing chord).
    const numSegs = this.closed ? this.n : this.n - 1;
    let lo = 0;
    let hi = numSegs - 1;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      // knots[mid+2] is the right edge of segment mid
      if (this.knots[mid + 2] < tK) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const seg = Math.max(0, Math.min(numSegs - 1, lo));
    return { seg, tK };
  }

  /**
   * Evaluate centripetal Catmull-Rom XZ position for segment `seg` at knot
   * parameter `tK`.
   *
   * The four control points for segment seg are pts[seg..seg+3].
   * The knot values for those points are knots[seg..seg+3].
   */
  private _evalXZ(seg: number, tK: number): Vec2 {
    const pts = this.pts;
    const k = this.knots;
    return {
      x: _cr(pts[seg].x, pts[seg+1].x, pts[seg+2].x, pts[seg+3].x,
              k[seg], k[seg+1], k[seg+2], k[seg+3], tK),
      z: _cr(pts[seg].z, pts[seg+1].z, pts[seg+2].z, pts[seg+3].z,
              k[seg], k[seg+1], k[seg+2], k[seg+3], tK),
    };
  }

  /**
   * Evaluate centripetal Catmull-Rom halfWidth for segment `seg` at knot
   * parameter `tK`.
   */
  private _evalWidth(seg: number, tK: number): number {
    const pts = this.pts;
    const k = this.knots;
    return _cr(pts[seg].halfWidth, pts[seg+1].halfWidth,
                pts[seg+2].halfWidth, pts[seg+3].halfWidth,
                k[seg], k[seg+1], k[seg+2], k[seg+3], tK);
  }

  /**
   * Unnormalized tangent (derivative of position w.r.t. the knot parameter tK).
   * To convert to derivative w.r.t. global t ∈ [0, 1]: multiply by kRange.
   * The tangentAt() method normalizes this; Newton's method uses the sign
   * without needing the global-t scaling (it only needs the zero-crossing).
   */
  private _derivXZ(seg: number, tK: number): Vec2 {
    const pts = this.pts;
    const k = this.knots;
    return {
      x: _crDeriv(pts[seg].x, pts[seg+1].x, pts[seg+2].x, pts[seg+3].x,
                  k[seg], k[seg+1], k[seg+2], k[seg+3], tK),
      z: _crDeriv(pts[seg].z, pts[seg+1].z, pts[seg+2].z, pts[seg+3].z,
                  k[seg], k[seg+1], k[seg+2], k[seg+3], tK),
    };
  }

  /**
   * Speed (magnitude of global-t derivative) at parametric t ∈ [0, 1].
   * |dC/dt_global| = |dC/dtK| * kRange.
   * Used by the LUT builder for arc length integration.
   */
  private _speedAt(t: number): number {
    const { seg, tK } = this._toKnot(t);
    const d = this._derivXZ(seg, tK);
    // Multiply by kRange to get derivative w.r.t. global t
    return Math.sqrt(d.x * d.x + d.z * d.z) * this.kRange;
  }

  /**
   * Newton residual: f(t) = (C(t) - p) · T_unnorm(t)
   * where T_unnorm is the unnormalized tangent w.r.t. tK.
   *
   * This is zero when the vector from C(t) to p is perpendicular to the
   * tangent, i.e. when t is the closest point on the spline to p.
   *
   * Using the unnormalized tangent is valid: normalization doesn't move zeros.
   */
  private _newtonResidual(p: Vec2, t: number): number {
    const { seg, tK } = this._toKnot(t);
    const c = this._evalXZ(seg, tK);
    const d = this._derivXZ(seg, tK);
    return (c.x - p.x) * d.x + (c.z - p.z) * d.z;
  }
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

/**
 * Wrap a parametric value into [0, 1) for closed-loop math. Handles arbitrary
 * negative or >1 inputs (e.g. a Newton step that overshoots the seam).
 */
function wrap01(t: number): number {
  const r = t - Math.floor(t);
  // Math.floor handles negatives correctly; guard the exact-1.0 float edge.
  return r >= 1 ? 0 : r;
}

// ─── Centripetal Catmull-Rom basis (Barry-Goldman recursive algorithm) ────────

/**
 * Evaluate the centripetal Catmull-Rom scalar value at knot parameter `tK`
 * for four scalar values (v0..v3) with corresponding knot times (k0..k3).
 *
 * Barry-Goldman recursive algorithm:
 *   L01(t) = lerp(v0, v1) over [k0, k1]
 *   L12(t) = lerp(v1, v2) over [k1, k2]
 *   L23(t) = lerp(v2, v3) over [k2, k3]
 *   L012(t) = lerp(L01, L12) over [k0, k2]
 *   L123(t) = lerp(L12, L23) over [k1, k3]
 *   C(t)   = lerp(L012, L123) over [k1, k2]
 *
 * This is numerically stable and handles non-uniform knot spacing correctly.
 * The result is C1-continuous across segment boundaries.
 */
function _cr(
  v0: number, v1: number, v2: number, v3: number,
  k0: number, k1: number, k2: number, k3: number,
  tK: number,
): number {
  const L01  = _kl(v0, v1, k0, k1, tK);
  const L12  = _kl(v1, v2, k1, k2, tK);
  const L23  = _kl(v2, v3, k2, k3, tK);
  const L012 = _kl(L01, L12, k0, k2, tK);
  const L123 = _kl(L12, L23, k1, k3, tK);
  return _kl(L012, L123, k1, k2, tK);
}

/**
 * Analytic derivative of `_cr` w.r.t. tK.
 * Derived by applying the chain rule at each level of the Barry-Goldman
 * recursion. See derivation in module docs.
 */
function _crDeriv(
  v0: number, v1: number, v2: number, v3: number,
  k0: number, k1: number, k2: number, k3: number,
  tK: number,
): number {
  const L01  = _kl(v0, v1, k0, k1, tK);
  const L12  = _kl(v1, v2, k1, k2, tK);
  const L23  = _kl(v2, v3, k2, k3, tK);
  const L012 = _kl(L01, L12, k0, k2, tK);
  const L123 = _kl(L12, L23, k1, k3, tK);

  const dL01  = _kld(v0, v1, k0, k1);
  const dL12  = _kld(v1, v2, k1, k2);
  const dL23  = _kld(v2, v3, k2, k3);
  const dL012 = _kldf(L01, L12, dL01, dL12, k0, k2, tK);
  const dL123 = _kldf(L12, L23, dL12, dL23, k1, k3, tK);
  return _kldf(L012, L123, dL012, dL123, k1, k2, tK);
}

/** Knot-parametric linear interpolation. Safe for zero-span intervals. */
function _kl(a: number, b: number, ta: number, tb: number, t: number): number {
  const span = tb - ta;
  if (span < 1e-12) return a;
  return a + (b - a) * (t - ta) / span;
}

/** Simple derivative of _kl w.r.t. t: (b-a)/span. */
function _kld(a: number, b: number, ta: number, tb: number): number {
  const span = tb - ta;
  if (span < 1e-12) return 0;
  return (b - a) / span;
}

/**
 * Full chain-rule derivative of _kl(A, B, ta, tb, t) w.r.t. t,
 * where A and B themselves depend on t with derivatives dA and dB.
 *
 * d/dt [A + (B - A) * (t - ta) / (tb - ta)]
 *   = dA * (tb - t)/(tb - ta)
 *   + dB * (t - ta)/(tb - ta)
 *   + (B - A) / (tb - ta)
 */
function _kldf(
  a: number, b: number,
  da: number, db: number,
  ta: number, tb: number,
  t: number,
): number {
  const span = tb - ta;
  if (span < 1e-12) return da;
  const alpha = (t - ta) / span;
  return da * (1 - alpha) + db * alpha + (b - a) / span;
}
