/**
 * reef-race-track-layout.test.ts
 *
 * Sanity tests for the locked v2 default track. Catches geometric regressions
 * before they reach the sim:
 *   - Exactly 16 control points (any add/remove must be intentional)
 *   - All adjacent CP-pair distances > 88 wu (Newton mis-segmenting guard)
 *   - Total spline arclength in [28 000, 31 500] wu (~90s race window)
 *   - First CP at origin (z = 0, x = 0) — start-line invariant
 *   - Last CP near (x ≈ 0, z ≈ 28 000) — finish-line invariant
 *   - WIDE WATER-DOMINANT COURSE (2026-06-02 rebuild — these REPLACE the old
 *     "STEERING IS MANDATORY straight-line-exits-corridor" guard, which CAUSED
 *     the skinny-canal bug by forcing amplitude > halfWidth so a wall engaged):
 *       (a) the centerline genuinely BENDS — max|x| ≥ 300 wu (sweeping bends
 *           exist; a re-straighten fails here);
 *       (b) the straight segments are WIDE — corridor (2×widthAt) ≥ 2000 wu so
 *           8 karts fit + overtake (a re-skinny fails here);
 *       (c) a CHICANE PINCH exists — min widthAt over the track sits in
 *           [800, 1200] wu (multi-kart but tighter; guards BOTH a re-skinny
 *           below 800 AND a "no pinch at all" above 1200).
 *     Steering pressure now comes from bends + chicanes + obstacle clusters
 *     (`reef-race-config.ts buildSplineObstacles()`), NOT narrow walls.
 *
 * The 88 wu threshold comes from `.claude/plans/reef-race-v2-spline-architecture.md`
 * Risk #1: "no folds within 88 wu of itself in XZ".
 *
 * The 28k-31.5k arclength window (2026-04-30 90s rebuild):
 *   - Lower bound 28 000: catches a layout that truncates the finish straight.
 *   - Upper bound 31 500: an excessive-S layout would inflate arc by >12%,
 *     breaking the 90s race-time target.
 */

import { describe, it, expect } from 'bun:test';
import { ReefSpline } from '../reef-race-spline';
import {
  REEF_RACE_DEFAULT_TRACK,
  REEF_RACE_DEFAULT_TRACK_LENGTH,
  REEF_RACE_SEGMENTS,
} from '../reef-race-track-layout';

// ─── Constants from spec / risk doc ─────────────────────────────────────────

/** Architecture doc Risk #1: 4 × REEF_BODY_RADIUS (22 wu) = 88 wu safe margin. */
const MIN_SAFE_CP_SPACING_WU = 88;

/** Lower bound on totalArcLength — z-span minus a small slack. */
const ARC_LENGTH_LOWER_WU = 28_000;

/** Upper bound on totalArcLength — slalom adds ~3-5%, anything more breaks 90s. */
const ARC_LENGTH_UPPER_WU = 31_500;

/** Final-CP target z-coordinate (per layout doc). */
const FINISH_Z_TARGET_WU = 28_000;

/** Tolerance for "near origin" / "near finish" assertions on x/z. */
const POSITION_TOLERANCE_WU = 50;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('REEF_RACE_DEFAULT_TRACK — locked v2 layout', () => {
  it('contains exactly 16 control points', () => {
    expect(REEF_RACE_DEFAULT_TRACK.length).toBe(16);
    expect(REEF_RACE_DEFAULT_TRACK_LENGTH).toBe(16);
  });

  it('first CP sits exactly at the origin (start line)', () => {
    const start = REEF_RACE_DEFAULT_TRACK[0];
    expect(start.x).toBe(0);
    expect(start.z).toBe(0);
    expect(start.halfWidth).toBeGreaterThan(0);
  });

  it('last CP sits on the finish line (x≈0, z≈28000)', () => {
    const finish = REEF_RACE_DEFAULT_TRACK[REEF_RACE_DEFAULT_TRACK.length - 1];
    expect(Math.abs(finish.x)).toBeLessThan(POSITION_TOLERANCE_WU);
    expect(Math.abs(finish.z - FINISH_Z_TARGET_WU)).toBeLessThan(POSITION_TOLERANCE_WU);
    expect(finish.halfWidth).toBeGreaterThan(0);
  });

  it('every CP has a positive halfWidth', () => {
    for (let i = 0; i < REEF_RACE_DEFAULT_TRACK.length; i++) {
      const cp = REEF_RACE_DEFAULT_TRACK[i];
      expect(cp.halfWidth).toBeGreaterThan(0);
    }
  });

  it('z-coordinates are strictly monotonic (no backtracking)', () => {
    for (let i = 1; i < REEF_RACE_DEFAULT_TRACK.length; i++) {
      const prev = REEF_RACE_DEFAULT_TRACK[i - 1];
      const curr = REEF_RACE_DEFAULT_TRACK[i];
      expect(curr.z).toBeGreaterThan(prev.z);
    }
  });

  it('all adjacent CP-pair distances exceed 88 wu (Newton-mis-seg guard)', () => {
    const violations: Array<{ pair: string; distance: number }> = [];
    let minDist = Infinity;
    let maxDist = -Infinity;
    let sumDist = 0;

    for (let i = 1; i < REEF_RACE_DEFAULT_TRACK.length; i++) {
      const a = REEF_RACE_DEFAULT_TRACK[i - 1];
      const b = REEF_RACE_DEFAULT_TRACK[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < MIN_SAFE_CP_SPACING_WU) {
        violations.push({ pair: `CP${i - 1}→CP${i}`, distance: d });
      }
      if (d < minDist) minDist = d;
      if (d > maxDist) maxDist = d;
      sumDist += d;
    }

    expect(violations).toEqual([]);

    // Diagnostic — surface min/max/avg in test output for quick eyeballing.
    const avg = sumDist / (REEF_RACE_DEFAULT_TRACK.length - 1);
    // eslint-disable-next-line no-console
    console.log(
      `  CP-pair distance: min=${minDist.toFixed(1)} wu, ` +
      `max=${maxDist.toFixed(1)} wu, avg=${avg.toFixed(1)} wu ` +
      `(threshold=${MIN_SAFE_CP_SPACING_WU} wu)`,
    );
  });
});

describe('REEF_RACE_DEFAULT_TRACK — spline integration', () => {
  const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK);

  it('total arclength falls in the 90s race-time window [28 000, 31 500] wu', () => {
    const arc = spline.totalArcLength;
    // eslint-disable-next-line no-console
    console.log(`  totalArcLength = ${arc.toFixed(1)} wu`);
    expect(arc).toBeGreaterThanOrEqual(ARC_LENGTH_LOWER_WU);
    expect(arc).toBeLessThanOrEqual(ARC_LENGTH_UPPER_WU);
  });

  it('(a) the centerline genuinely BENDS — max|x| ≥ 300 wu (sweeping bends exist)', () => {
    // 2026-06-02 wide-course guard (REPLACES the old "straight-line-exits-
    // corridor" test that caused the skinny-canal bug). Steering now comes from
    // COURSE DESIGN, not walls — so the FIRST thing to assert is that the
    // course actually curves. A future re-straighten (centerline collapsing to
    // x≈0 everywhere) fails here. We sample the real centerline densely and
    // take the max absolute lateral excursion.
    const MIN_CENTERLINE_EXCURSION_WU = 300;
    const SAMPLES = 2000;
    let maxAbsX = 0;
    let atT = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const x = Math.abs(spline.centerlineAt(t).x);
      if (x > maxAbsX) {
        maxAbsX = x;
        atT = t;
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `  centerline max|x| = ${maxAbsX.toFixed(1)} wu @ t=${atT.toFixed(3)} ` +
        `(need ≥ ${MIN_CENTERLINE_EXCURSION_WU})`,
    );
    expect(maxAbsX).toBeGreaterThanOrEqual(MIN_CENTERLINE_EXCURSION_WU);
  });

  it('(b) straight segments are WIDE — corridor (2×widthAt) ≥ 2000 wu (8-kart-fit)', () => {
    // 2026-06-02 anti-re-skinny guard. The whole point of the rebuild is that
    // the water is wide enough to be the hero + fit 8 karts abreast with
    // overtaking room. The non-chicane straights must keep a corridor of at
    // least 2000 wu (= 2 × halfWidth 1000). We assert this on the lagoon,
    // finish, and bend-apex regions (sampled t-values that are NOT chicanes).
    // A regression that re-collapses the corridor to ~580 wu fails here.
    const MIN_STRAIGHT_CORRIDOR_WU = 2000;
    // Sample points known to be on the wide straights / bend apexes (NOT the
    // chicane pinches at t≈0.41 / t≈0.69). See track-layout.ts schematic.
    const straightTs = [0.02, 0.08, 0.16, 0.27, 0.55, 0.82, 0.92, 0.98];
    for (const t of straightTs) {
      const corridor = 2 * spline.widthAt(t);
      expect(corridor).toBeGreaterThanOrEqual(MIN_STRAIGHT_CORRIDOR_WU);
    }
    // eslint-disable-next-line no-console
    console.log(
      `  straight corridors (2×widthAt): ` +
        straightTs
          .map((t) => `t=${t}:${(2 * spline.widthAt(t)).toFixed(0)}`)
          .join('  '),
    );
  });

  it('(c) a CHICANE PINCH exists — min widthAt over track in [800, 1200] wu', () => {
    // 2026-06-02 guard: the course MUST have a deliberate pinch (a committed,
    // tighter-but-still-multi-kart section), but NOT re-skinny below 800 wu
    // half-width (that's the canal bug) NOR be so wide everywhere that there's
    // no pinch at all (> 1200). We drive the real spline and take the global
    // minimum widthAt — exactly the value the sim's wall-clamp reads.
    const CHICANE_MIN_HALF_WIDTH = 800;
    const CHICANE_MAX_HALF_WIDTH = 1200;
    const SAMPLES = 2000;
    let minW = Infinity;
    let atT = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const w = spline.widthAt(t);
      if (w < minW) {
        minW = w;
        atT = t;
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `  min widthAt (chicane pinch) = ${minW.toFixed(1)} wu @ t=${atT.toFixed(3)} ` +
        `(need [${CHICANE_MIN_HALF_WIDTH}, ${CHICANE_MAX_HALF_WIDTH}])`,
    );
    expect(minW).toBeGreaterThanOrEqual(CHICANE_MIN_HALF_WIDTH);
    expect(minW).toBeLessThanOrEqual(CHICANE_MAX_HALF_WIDTH);
  });

  it('the meander is followable — min radius of curvature ≥ the carve floor', () => {
    // Constraint #2: a clean carve at REEF_MAX_SPEED=500 with REEF_TURN_RATE≈2.6
    // can hold the line only if the meander's radius of curvature stays above
    // speed/turnRate ≈ 192 wu. We compute the worst-case (minimum) radius of
    // curvature numerically off the centerline and assert it clears the floor
    // with margin (design target ≳250 wu). A meander a kart physically cannot
    // follow at speed (constant wall-clamp) is as bad as a too-wide one.
    const MIN_TURN_RADIUS_FLOOR_WU = 500 / 2.6; // ≈ 192.3 wu
    const h = 1e-3;
    let minR = Infinity;
    let minRT = 0;
    for (let i = 20; i <= 980; i++) {
      const t = i / 1000;
      const p0 = spline.centerlineAt(t - h);
      const p1 = spline.centerlineAt(t);
      const p2 = spline.centerlineAt(t + h);
      const vx = (p2.x - p0.x) / (2 * h);
      const vz = (p2.z - p0.z) / (2 * h);
      const ax = (p2.x - 2 * p1.x + p0.x) / (h * h);
      const az = (p2.z - 2 * p1.z + p0.z) / (h * h);
      const speed = Math.hypot(vx, vz);
      const cross = Math.abs(vx * az - vz * ax);
      if (cross < 1e-9) continue;
      const R = (speed * speed * speed) / cross;
      if (R < minR) {
        minR = R;
        minRT = t;
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `  min radius of curvature = ${minR.toFixed(1)} wu @ t=${minRT.toFixed(3)} ` +
        `(floor=${MIN_TURN_RADIUS_FLOOR_WU.toFixed(1)} wu)`,
    );
    expect(minR).toBeGreaterThanOrEqual(MIN_TURN_RADIUS_FLOOR_WU);
    expect(minR).toBeGreaterThanOrEqual(250);
  });

  it('centerlineAt(0) lands at the start CP', () => {
    const start = spline.centerlineAt(0);
    expect(Math.abs(start.x)).toBeLessThan(0.01);
    expect(Math.abs(start.z)).toBeLessThan(0.01);
  });

  it('centerlineAt(1) lands at the finish CP', () => {
    const finish = spline.centerlineAt(1);
    const lastCP = REEF_RACE_DEFAULT_TRACK[REEF_RACE_DEFAULT_TRACK.length - 1];
    expect(Math.abs(finish.x - lastCP.x)).toBeLessThan(0.01);
    expect(Math.abs(finish.z - lastCP.z)).toBeLessThan(0.01);
  });

  it('arclength round-trip tFromArclength(arclengthFromT(t)) ≈ t for sample t', () => {
    const samples = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
    for (const t of samples) {
      const s = spline.arclengthFromT(t);
      const tBack = spline.tFromArclength(s);
      expect(Math.abs(tBack - t)).toBeLessThan(0.001);
    }
  });

  it('halfWidth interpolation respects per-segment design intent', () => {
    // 2026-06-02 wide-course intent: t=0 sits in the lagoon (halfWidth ~1300),
    // t=1 in the finish (~1300) — WIDE open water at the gates. The chicane
    // pinches (t≈0.41 / t≈0.69) are TIGHTER than the lagoon/finish but still
    // multi-kart. We check ranges (centripetal interpolation smooths the
    // boundaries) rather than pinning exact numbers.
    const wStart = spline.widthAt(0);
    const wFinish = spline.widthAt(1);
    expect(wStart).toBeGreaterThanOrEqual(1250);
    expect(wStart).toBeLessThanOrEqual(1320);
    expect(wFinish).toBeGreaterThanOrEqual(1250);
    expect(wFinish).toBeLessThanOrEqual(1320);

    // The chicane pinches must be TIGHTER than the wide lagoon/finish gates —
    // a regression that flattens the corridor to a uniform width (no pinch)
    // fails here. Sample the two chicane t-values (kelp→wreck, wreck→coral).
    const wChicane1 = spline.widthAt(0.41);
    const wChicane2 = spline.widthAt(0.69);
    expect(wChicane1).toBeLessThan(wStart);
    expect(wChicane2).toBeLessThan(wFinish);

    // But the pinch stays WIDE enough to be a river, not a canal: ≥ 800 wu
    // half-width (corridor ≥ 1600 wu ≈ multi-kart). A re-skinny fails here.
    expect(wChicane1).toBeGreaterThanOrEqual(800);
    expect(wChicane2).toBeGreaterThanOrEqual(800);
  });
});

describe('REEF_RACE_SEGMENTS — themed segment table', () => {
  it('covers z=[0, 28000] contiguously with no gaps or overlaps', () => {
    expect(REEF_RACE_SEGMENTS[0].zStart).toBe(0);
    expect(REEF_RACE_SEGMENTS[REEF_RACE_SEGMENTS.length - 1].zEnd)
      .toBe(FINISH_Z_TARGET_WU);
    for (let i = 1; i < REEF_RACE_SEGMENTS.length; i++) {
      expect(REEF_RACE_SEGMENTS[i].zStart).toBe(REEF_RACE_SEGMENTS[i - 1].zEnd);
    }
  });

  it('lists the 5 themed segments in down-track order', () => {
    expect(REEF_RACE_SEGMENTS.map((s) => s.id)).toEqual([
      'lagoon',
      'kelp',
      'shipwreck',
      'coral',
      'finish',
    ]);
  });
});
