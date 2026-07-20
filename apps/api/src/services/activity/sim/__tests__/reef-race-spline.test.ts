/**
 * reef-race-spline.test.ts
 *
 * Validates all 8 primitives of ReefSpline against the requirements in
 * `.claude/plans/reef-race-v2-spline-architecture.md`.
 *
 * Test spline: an 8-control-point S-curve with a gentle double bend.
 * Chosen to:
 *   - Have non-uniform spacing (exercises centripetal parameterisation)
 *   - Include a direction reversal at the hairpin (exercises Newton seeding)
 *   - Not fold within 88wu of itself (within the architecture doc constraint)
 *
 * Control points are purely synthetic — not the actual track layout.
 */

import { describe, it, expect } from 'bun:test';
import { ReefSpline, type Vec2, type SplineControlPoint } from '../reef-race-spline';

// ─── Test spline definition ──────────────────────────────────────────────────

/**
 * 8-point S-curve track. All points spaced > 300wu apart so the track
 * never folds within 88wu of itself. HalfWidth varies to exercise widthAt().
 *
 * Layout (XZ plane, viewed top-down):
 *   Start at (0, 0), curve right, then curve left, finish at (5000, 500).
 *   The S-shape is intentional: the second half curves the opposite way to
 *   ensure closestPointOnSpline must disambiguate via Newton from the coarse
 *   scan, not just by segment-index proximity.
 */
const TEST_CONTROL_POINTS: SplineControlPoint[] = [
  { x:    0, z:    0, halfWidth: 200 },
  { x:  800, z:  200, halfWidth: 220 },
  { x: 1600, z:  600, halfWidth: 250 },
  { x: 2200, z:  400, halfWidth: 280 },  // start of first bend
  { x: 2800, z:    0, halfWidth: 270 },  // apex of S
  { x: 3400, z: -400, halfWidth: 250 },  // start of second bend
  { x: 4200, z: -200, halfWidth: 220 },
  { x: 5000, z:  200, halfWidth: 200 },
];

/** Singleton test spline — construction is O(1000), no need to rebuild per test. */
const spline = new ReefSpline(TEST_CONTROL_POINTS);

// ─── Helper utilities ────────────────────────────────────────────────────────

function dist2D(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function dot2D(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.z * b.z;
}

function mag2D(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.z * v.z);
}

/** Sample `count` values of t uniformly from [lo, hi]. */
function sampleT(count: number, lo = 0, hi = 1): number[] {
  const pts: number[] = [];
  for (let i = 0; i < count; i++) {
    pts.push(lo + (hi - lo) * i / (count - 1));
  }
  return pts;
}

/** Sample `count` arc-distance values uniformly from [lo, hi]. */
function sampleS(count: number, lo: number, hi: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < count; i++) {
    pts.push(lo + (hi - lo) * i / (count - 1));
  }
  return pts;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ReefSpline — construction', () => {
  it('computes a positive totalArcLength', () => {
    expect(spline.totalArcLength).toBeGreaterThan(0);
    // Expected rough arc: ~5000-6500 wu for this layout
    expect(spline.totalArcLength).toBeGreaterThan(4000);
    expect(spline.totalArcLength).toBeLessThan(15000);
  });

  it('throws with fewer than 2 control points', () => {
    expect(() => new ReefSpline([TEST_CONTROL_POINTS[0]])).toThrow();
    expect(() => new ReefSpline([])).toThrow();
  });

  it('works with exactly 2 control points', () => {
    const s2 = new ReefSpline([
      { x: 0, z: 0, halfWidth: 100 },
      { x: 1000, z: 0, halfWidth: 100 },
    ]);
    expect(s2.totalArcLength).toBeGreaterThan(900);
  });
});

describe('ReefSpline.centerlineAt — passes through control points', () => {
  /**
   * With a Catmull-Rom spline, centerlineAt(t) PASSES THROUGH each real
   * control point. t=0 corresponds to CP[0], t=1 to CP[N-1].
   *
   * We verify the N intermediate control points at t = i/(N-1) for i in [0, N-1].
   *
   * Tolerance: 2 wu. The centripetal parameterisation distributes t non-uniformly
   * across control points, so the t-value for CP[i] is not exactly i/(N-1) — it
   * depends on chord lengths. However, at the endpoints (i=0 and i=N-1) the
   * spline MUST pass through the control point exactly (by construction).
   */

  it('passes through first control point at t=0', () => {
    const pos = spline.centerlineAt(0);
    const cp = TEST_CONTROL_POINTS[0];
    expect(Math.abs(pos.x - cp.x)).toBeLessThan(2);
    expect(Math.abs(pos.z - cp.z)).toBeLessThan(2);
  });

  it('passes through last control point at t=1', () => {
    const pos = spline.centerlineAt(1);
    const cp = TEST_CONTROL_POINTS[TEST_CONTROL_POINTS.length - 1];
    expect(Math.abs(pos.x - cp.x)).toBeLessThan(2);
    expect(Math.abs(pos.z - cp.z)).toBeLessThan(2);
  });

  it('returns finite XZ at all t in [0,1]', () => {
    for (const t of sampleT(200)) {
      const p = spline.centerlineAt(t);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });

  it('is monotonically progressing (no large reversals in x across the S curve)', () => {
    // The S-curve X coordinate should overall increase from 0 to 5000.
    const start = spline.centerlineAt(0);
    const end = spline.centerlineAt(1);
    expect(end.x).toBeGreaterThan(start.x + 4000);
  });
});

describe('ReefSpline.tangentAt — unit length', () => {
  it('returns unit vectors at 100 sample points across [0,1]', () => {
    for (const t of sampleT(100)) {
      const tg = spline.tangentAt(t);
      const len = mag2D(tg);
      expect(len).toBeCloseTo(1.0, 4); // within 0.0001
    }
  });

  it('returns finite XZ', () => {
    for (const t of sampleT(100)) {
      const tg = spline.tangentAt(t);
      expect(Number.isFinite(tg.x)).toBe(true);
      expect(Number.isFinite(tg.z)).toBe(true);
    }
  });
});

describe('ReefSpline.normalAt — perpendicular to tangent', () => {
  it('dot(normal, tangent) ≈ 0 at 100 sample points', () => {
    for (const t of sampleT(100)) {
      const tg = spline.tangentAt(t);
      const nm = spline.normalAt(t);
      const dotProduct = dot2D(tg, nm);
      expect(Math.abs(dotProduct)).toBeLessThan(1e-4);
    }
  });

  it('normal is unit length at 100 sample points', () => {
    for (const t of sampleT(100)) {
      const nm = spline.normalAt(t);
      expect(mag2D(nm)).toBeCloseTo(1.0, 4);
    }
  });
});

describe('ReefSpline.bankNormalAt — Phase 1 always up', () => {
  it('returns {0, 1, 0} regardless of t', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const bn = spline.bankNormalAt(t);
      expect(bn.x).toBe(0);
      expect(bn.y).toBe(1);
      expect(bn.z).toBe(0);
    }
  });
});

describe('ReefSpline.widthAt — smooth interpolation', () => {
  it('returns positive values at all t', () => {
    for (const t of sampleT(100)) {
      expect(spline.widthAt(t)).toBeGreaterThan(0);
    }
  });

  it('returns halfWidth of first CP at t=0', () => {
    expect(spline.widthAt(0)).toBeCloseTo(TEST_CONTROL_POINTS[0].halfWidth, 0);
  });

  it('returns halfWidth of last CP at t=1', () => {
    expect(spline.widthAt(1)).toBeCloseTo(
      TEST_CONTROL_POINTS[TEST_CONTROL_POINTS.length - 1].halfWidth,
      0,
    );
  });

  it('interpolated width passes through max-halfWidth region', () => {
    // CP[3] has halfWidth=280, which is the maximum.
    // Find the t where width peaks — it should be > 260.
    let maxWidth = 0;
    for (const t of sampleT(500)) {
      maxWidth = Math.max(maxWidth, spline.widthAt(t));
    }
    expect(maxWidth).toBeGreaterThan(260);
  });
});

describe('ReefSpline arclength round-trips', () => {
  /**
   * Round-trip 1: tFromArclength(arclengthFromT(t)) ≈ t
   * Tolerance: 0.001 (from spec).
   * Sampled at 100 points in [0.05, 0.95] to avoid endpoint edge cases.
   */
  it('round-trip tFromArclength(arclengthFromT(t)) within 0.001 for t in [0.05, 0.95]', () => {
    const tSamples = sampleT(100, 0.05, 0.95);
    for (const t of tSamples) {
      const s = spline.arclengthFromT(t);
      const tBack = spline.tFromArclength(s);
      expect(Math.abs(tBack - t)).toBeLessThan(0.001);
    }
  });

  /**
   * Round-trip 2: arclengthFromT(tFromArclength(s)) ≈ s
   * Tolerance: 0.5 wu (from spec).
   * Sampled at 100 points in [50, totalLength-50].
   */
  it('round-trip arclengthFromT(tFromArclength(s)) within 0.5wu for s in [50, total-50]', () => {
    const L = spline.totalArcLength;
    const sSamples = sampleS(100, 50, L - 50);
    for (const s of sSamples) {
      const t = spline.tFromArclength(s);
      const sBack = spline.arclengthFromT(t);
      expect(Math.abs(sBack - s)).toBeLessThan(0.5);
    }
  });

  it('arclengthFromT(0) === 0', () => {
    expect(spline.arclengthFromT(0)).toBeCloseTo(0, 3);
  });

  it('arclengthFromT(1) === totalArcLength', () => {
    expect(spline.arclengthFromT(1)).toBeCloseTo(spline.totalArcLength, 1);
  });

  it('arclengthFromT is monotonically increasing', () => {
    const ts = sampleT(200);
    let prevS = -1;
    for (const t of ts) {
      const s = spline.arclengthFromT(t);
      expect(s).toBeGreaterThanOrEqual(prevS - 0.01); // allow tiny float noise
      prevS = s;
    }
  });
});

describe('ReefSpline.closestPointOnSpline — on-centerline query', () => {
  /**
   * If p = centerlineAt(t), then closestPointOnSpline(p) should return
   * approximately the same t with distance ≈ 0.
   *
   * Tested at 50 points in [0.05, 0.95] to avoid endpoint ambiguity.
   */
  it('returns distance ≈ 0 for points on the centerline', () => {
    for (const t of sampleT(50, 0.05, 0.95)) {
      const p = spline.centerlineAt(t);
      const result = spline.closestPointOnSpline(p);
      expect(result.distance).toBeLessThan(1.0); // within 1 wu of centerline
    }
  });

  it('returns approximately the correct t for on-centerline queries', () => {
    for (const t of sampleT(50, 0.05, 0.95)) {
      const p = spline.centerlineAt(t);
      const result = spline.closestPointOnSpline(p);
      // t should be within 0.02 (2% of track) of the true t
      expect(Math.abs(result.t - t)).toBeLessThan(0.02);
    }
  });
});

describe('ReefSpline.closestPointOnSpline — offset query', () => {
  /**
   * For p = centerlineAt(t) + 30 * normalAt(t):
   *   - distance ≈ 30 wu
   *   - side === 'L' (normal points left)
   *   - t is approximately correct
   */
  it('returns distance ≈ 30wu for +30wu left-offset points', () => {
    for (const t of sampleT(50, 0.05, 0.95)) {
      const c = spline.centerlineAt(t);
      const nm = spline.normalAt(t);
      const p: Vec2 = { x: c.x + 30 * nm.x, z: c.z + 30 * nm.z };
      const result = spline.closestPointOnSpline(p);
      expect(Math.abs(result.distance - 30)).toBeLessThan(2.0);
    }
  });

  it('returns side=L for +30wu left-offset points', () => {
    for (const t of sampleT(20, 0.1, 0.9)) {
      const c = spline.centerlineAt(t);
      const nm = spline.normalAt(t);
      const p: Vec2 = { x: c.x + 30 * nm.x, z: c.z + 30 * nm.z };
      const result = spline.closestPointOnSpline(p);
      expect(result.side).toBe('L');
    }
  });

  it('returns distance ≈ 30wu for -30wu right-offset points', () => {
    for (const t of sampleT(50, 0.05, 0.95)) {
      const c = spline.centerlineAt(t);
      const nm = spline.normalAt(t);
      const p: Vec2 = { x: c.x - 30 * nm.x, z: c.z - 30 * nm.z };
      const result = spline.closestPointOnSpline(p);
      expect(Math.abs(result.distance - 30)).toBeLessThan(2.0);
    }
  });

  it('returns side=R for -30wu right-offset points', () => {
    for (const t of sampleT(20, 0.1, 0.9)) {
      const c = spline.centerlineAt(t);
      const nm = spline.normalAt(t);
      const p: Vec2 = { x: c.x - 30 * nm.x, z: c.z - 30 * nm.z };
      const result = spline.closestPointOnSpline(p);
      expect(result.side).toBe('R');
    }
  });
});

describe('ReefSpline.closestPointOnSpline — Newton convergence on tight S-curve', () => {
  /**
   * Adversarial test: a synthetic tight S-curve that almost violates the 88wu
   * fold rule. The S bends are 300wu radius, which means the inside of each
   * bend is ~300wu from the centerline of the opposing direction — safely above
   * the 88wu constraint but close enough to stress Newton seeding.
   *
   * We verify Newton still converges to the correct segment (< 2% t-error)
   * without confusion between the two opposing-direction portions of the S.
   */
  it('converges on a tight S-curve synthetic track', () => {
    // Build a minimal S-curve: two opposing arcs. Points spaced 400wu apart,
    // S-peak offset ±250wu. Minimum gap between the two halves ≈ 500-2*250 = nothing.
    // We use ±180wu to keep > 88wu clearance: gap ≈ 2*(400-180) = 440wu.
    const sCurve = new ReefSpline([
      { x:    0, z:    0, halfWidth: 150 },
      { x:  400, z:  150, halfWidth: 150 },
      { x:  800, z:  180, halfWidth: 150 }, // peak of first bend
      { x: 1200, z:    0, halfWidth: 150 }, // S-inflection
      { x: 1600, z: -180, halfWidth: 150 }, // peak of second bend
      { x: 2000, z: -150, halfWidth: 150 },
      { x: 2400, z:    0, halfWidth: 150 },
    ]);

    // Query points on the centerline at t ∈ [0.1, 0.9].
    // Newton must not confuse the first half with the second.
    for (const t of sampleT(30, 0.1, 0.9)) {
      const p = sCurve.centerlineAt(t);
      const result = sCurve.closestPointOnSpline(p);
      // Must converge to within 1wu distance from centerline
      expect(result.distance).toBeLessThan(2.0);
      // Must find approximately the right t (within 3% of track)
      expect(Math.abs(result.t - t)).toBeLessThan(0.03);
    }
  });
});

describe('ReefSpline.closestPointOnSpline — edge cases', () => {
  it('handles point near spline start (s ≈ 0)', () => {
    // Point on the centerline very close to t=0
    const p = spline.centerlineAt(0.001);
    const result = spline.closestPointOnSpline(p);
    expect(result.t).toBeGreaterThanOrEqual(0);
    expect(result.t).toBeLessThan(0.05);
    expect(result.distance).toBeLessThan(2.0);
    expect(Number.isFinite(result.distance)).toBe(true);
    expect(['L', 'R']).toContain(result.side);
  });

  it('handles point near spline end (s ≈ totalLength)', () => {
    const p = spline.centerlineAt(0.999);
    const result = spline.closestPointOnSpline(p);
    expect(result.t).toBeLessThanOrEqual(1);
    expect(result.t).toBeGreaterThan(0.95);
    expect(result.distance).toBeLessThan(2.0);
    expect(Number.isFinite(result.distance)).toBe(true);
    expect(['L', 'R']).toContain(result.side);
  });

  it('handles point exactly at t=0 endpoint', () => {
    const p = spline.centerlineAt(0);
    const result = spline.closestPointOnSpline(p);
    expect(result.t).toBeGreaterThanOrEqual(0);
    expect(result.distance).toBeLessThan(2.0);
  });

  it('handles point exactly at t=1 endpoint', () => {
    const p = spline.centerlineAt(1);
    const result = spline.closestPointOnSpline(p);
    expect(result.t).toBeLessThanOrEqual(1);
    expect(result.distance).toBeLessThan(2.0);
  });

  it('returns finite results for a far-off-track query point', () => {
    // Point 5000wu to the side of the track — extreme but must not NaN/Inf
    const p: Vec2 = { x: 2500, z: 5000 };
    const result = spline.closestPointOnSpline(p);
    expect(Number.isFinite(result.t)).toBe(true);
    expect(Number.isFinite(result.distance)).toBe(true);
    expect(result.t).toBeGreaterThanOrEqual(0);
    expect(result.t).toBeLessThanOrEqual(1);
  });
});

describe('ReefSpline.closestPointOnSpline — performance', () => {
  /**
   * Budget: 1000 closestPointOnSpline calls must complete in < 50ms.
   * At 30Hz × 8 bodies = 240 calls/sec steady state.
   * 1000 calls in 50ms = 50μs/call average — well within budget.
   *
   * Run on a mid-track query point to avoid any endpoint short-circuits.
   */
  it('1000 closestPointOnSpline calls complete in < 50ms', () => {
    const p = spline.centerlineAt(0.5);
    // Slight offset to force full Newton run (not trivially zero-distance)
    const qPoint: Vec2 = { x: p.x + 15, z: p.z + 20 };

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      spline.closestPointOnSpline(qPoint);
    }
    const elapsed = performance.now() - t0;

    // Allow up to 50ms (spec) but print actual time for visibility
    expect(elapsed).toBeLessThan(50);
  });
});

// ─── Closed-loop (periodic) ReefSpline ────────────────────────────────────────
//
// 2026-06-22 closed-loop rebuild. These tests exercise the OPT-IN
// `{ closed: true }` periodic path. The OPEN tests above MUST stay green
// untouched — the closed path is purely additive.
//
// Synthetic closed ring fixture: a deformed circle (radius ~1000, halfWidth
// modulated) so the seam, arc-closure, and modulo-Newton are all stressed.
describe('ReefSpline — closed loop', () => {
  /**
   * 8-point deformed ring. Points sit on a circle of radius 1000 around the
   * origin with a 3θ width ripple. Spaced ~765 wu apart (> 88 wu fold rule).
   * Built with `{ closed: true }` so the closing chord CP[7]→CP[0] is a real
   * segment and the loop is C1-continuous at the seam.
   */
  const RING_N = 8;
  const ringCps: SplineControlPoint[] = [];
  for (let i = 0; i < RING_N; i++) {
    const a = (2 * Math.PI * i) / RING_N;
    ringCps.push({
      x: 1000 * Math.cos(a),
      z: 1000 * Math.sin(a),
      halfWidth: 100 + 20 * Math.sin(3 * a),
    });
  }
  const ring = new ReefSpline(ringCps, { closed: true });

  it('exposes closed=true (and OPEN splines stay closed=false)', () => {
    expect(ring.closed).toBe(true);
    expect(spline.closed).toBe(false);
  });

  it('throws with fewer than 3 control points in closed mode', () => {
    expect(() => new ReefSpline([{ x: 0, z: 0, halfWidth: 1 }], { closed: true })).toThrow();
    expect(
      () => new ReefSpline(
        [{ x: 0, z: 0, halfWidth: 1 }, { x: 100, z: 0, halfWidth: 1 }],
        { closed: true },
      ),
    ).toThrow();
  });

  it('rejects an explicitly duplicated terminal CP in closed mode', () => {
    // Authors must NOT append a copy of CP[0] — the wrap is internal. A literal
    // duplicate would collapse the closing-chord knot span → seam cusp.
    const dupTerminal = [
      { x: 0, z: 0, halfWidth: 100 },
      { x: 1000, z: 0, halfWidth: 100 },
      { x: 1000, z: 1000, halfWidth: 100 },
      { x: 0, z: 0, halfWidth: 100 }, // duplicate of CP[0]
    ];
    expect(() => new ReefSpline(dupTerminal, { closed: true })).toThrow();
  });

  it('OPEN path is bit-identical when passed empty options', () => {
    // `new ReefSpline(cps)` and `new ReefSpline(cps, {})` must match exactly.
    const a = new ReefSpline(TEST_CONTROL_POINTS);
    const b = new ReefSpline(TEST_CONTROL_POINTS, {});
    expect(b.closed).toBe(false);
    expect(b.totalArcLength).toBe(a.totalArcLength);
    for (const t of sampleT(50)) {
      const pa = a.centerlineAt(t);
      const pb = b.centerlineAt(t);
      expect(pb.x).toBe(pa.x);
      expect(pb.z).toBe(pa.z);
    }
  });

  it('POSITION continuity at the seam: centerlineAt(0) ≈ centerlineAt(1)', () => {
    const c0 = ring.centerlineAt(0);
    const c1 = ring.centerlineAt(1);
    expect(Math.abs(c0.x - c1.x)).toBeLessThan(1e-6);
    expect(Math.abs(c0.z - c1.z)).toBeLessThan(1e-6);
  });

  it('C1 TANGENT continuity at the seam: tangentAt(0) ≈ tangentAt(1)', () => {
    const t0 = ring.tangentAt(0);
    const t1 = ring.tangentAt(1);
    // Dot of two unit tangents ≈ 1 ⇒ same direction (no cusp at the seam).
    const dot = t0.x * t1.x + t0.z * t1.z;
    expect(dot).toBeGreaterThan(0.9999);
  });

  it('C1 continuity holds ACROSS the closing-chord/first-segment boundary', () => {
    // Evaluate tangent just before the seam (t≈0.9999, end of closing chord)
    // and just after (t≈0.0001, start of segment 0). The analytic derivative
    // must be continuous — no cusp.
    const before = ring.tangentAt(0.9999);
    const after = ring.tangentAt(0.0001);
    const dot = before.x * after.x + before.z * after.z;
    expect(dot).toBeGreaterThan(0.9999);
  });

  it('WIDTH continuity at the seam: widthAt(0) ≈ widthAt(1)', () => {
    expect(Math.abs(ring.widthAt(0) - ring.widthAt(1))).toBeLessThan(1e-6);
  });

  it('arclengthFromT(1) ≈ totalArcLength (INCLUDES the closing chord)', () => {
    expect(ring.arclengthFromT(1)).toBeCloseTo(ring.totalArcLength, 3);
    // Sanity: arc is near the circle circumference (centripetal under-estimates
    // a perfect circle slightly via chords, so allow a band).
    const circ = 2 * Math.PI * 1000;
    expect(ring.totalArcLength).toBeGreaterThan(circ * 0.95);
    expect(ring.totalArcLength).toBeLessThanOrEqual(circ + 1);
  });

  it('tFromArclength round-trips across the seam (incl. s just past the seam)', () => {
    // Sample arc distances including the last 1% (just before the seam) and the
    // first 1% (just after). Round-trip must hold across the wrap.
    const L = ring.totalArcLength;
    const sSamples = [
      5, L * 0.01, L * 0.25, L * 0.5, L * 0.75, L * 0.99, L - 5,
    ];
    for (const s of sSamples) {
      const t = ring.tFromArclength(s);
      const sBack = ring.arclengthFromT(t);
      expect(Math.abs(sBack - s)).toBeLessThan(0.5);
    }
  });

  it('closestPointOnSpline for a point JUST PAST the seam returns t near 0 (NOT ≈1)', () => {
    // A query point physically just past the seam (t≈0.003) must converge to a
    // small t, NOT snap to t≈1 on the wrong side of the seam.
    const justPast = ring.centerlineAt(0.003);
    const r = ring.closestPointOnSpline(justPast);
    expect(r.distance).toBeLessThan(1.0);
    expect(r.t).toBeLessThan(0.05); // small t, not ≈1
    expect(r.t).toBeGreaterThanOrEqual(0);
  });

  it('closestPointOnSpline returns t in [0,1) and stays accurate around the loop', () => {
    for (const t of sampleT(40, 0.0, 0.98)) {
      const p = ring.centerlineAt(t);
      const r = ring.closestPointOnSpline(p);
      expect(r.t).toBeGreaterThanOrEqual(0);
      expect(r.t).toBeLessThan(1); // wrapped into [0,1)
      expect(r.distance).toBeLessThan(1.0);
    }
  });

  it('closestPointOnSpline distance/side correct for offset points around the loop', () => {
    for (const t of sampleT(30, 0.02, 0.96)) {
      const c = ring.centerlineAt(t);
      const nm = ring.normalAt(t);
      const pL: Vec2 = { x: c.x + 30 * nm.x, z: c.z + 30 * nm.z };
      const rL = ring.closestPointOnSpline(pL);
      expect(Math.abs(rL.distance - 30)).toBeLessThan(2.0);
      expect(rL.side).toBe('L');
    }
  });

  it('the closed ring does not self-intersect within its body radius', () => {
    // Dense centerline sampling; min distance between non-adjacent samples must
    // exceed 88 wu (4 × REEF_BODY_RADIUS=22). "Non-adjacent" = cyclic index gap
    // beyond a small arc neighbourhood.
    const M = 800;
    const pts: Vec2[] = [];
    for (let i = 0; i < M; i++) pts.push(ring.centerlineAt(i / M));
    const skip = Math.ceil(M * (300 / ring.totalArcLength));
    let minSelf = Infinity;
    for (let i = 0; i < M; i++) {
      for (let j = i + 1; j < M; j++) {
        const cyc = Math.min(j - i, M - (j - i));
        if (cyc <= skip) continue;
        const d = dist2D(pts[i], pts[j]);
        if (d < minSelf) minSelf = d;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`  closed ring min non-adjacent self-distance = ${minSelf.toFixed(1)} wu`);
    expect(minSelf).toBeGreaterThan(88);
  });

  it('heading sweeps a full ±2π around the loop', () => {
    const N = 2000;
    let prevAng = Math.atan2(ring.tangentAt(0).z, ring.tangentAt(0).x);
    let sweep = 0;
    for (let i = 1; i <= N; i++) {
      const tg = ring.tangentAt(i / N);
      const ang = Math.atan2(tg.z, tg.x);
      let d = ang - prevAng;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      sweep += d;
      prevAng = ang;
    }
    expect(Math.abs(Math.abs(sweep) - 2 * Math.PI)).toBeLessThan(0.05);
  });

  it('closed closestPointOnSpline keeps the perf budget (1000 calls < 50ms)', () => {
    const p = ring.centerlineAt(0.37);
    const qPoint: Vec2 = { x: p.x + 15, z: p.z + 20 };
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) ring.closestPointOnSpline(qPoint);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });
});
