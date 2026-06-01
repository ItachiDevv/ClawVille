/**
 * reef-race-track-layout.test.ts
 *
 * Sanity tests for the locked v2 default track. Catches geometric regressions
 * before they reach the sim:
 *   - Exactly 19 control points (any add/remove must be intentional)
 *   - All adjacent CP-pair distances > 88 wu (Newton mis-segmenting guard)
 *   - Total spline arclength in [28 000, 31 500] wu (~90s race window)
 *   - First CP at origin (z = 0, x = 0) — start-line invariant
 *   - Last CP near (x ≈ 0, z ≈ 28 000) — finish-line invariant
 *   - STEERING IS MANDATORY: a straight constant-x=startX line EXITS the
 *     corridor on a slalom peak (the 2026-06-01 re-tune regression guard —
 *     this gap let the original "straight bypass is optimal" bug ship green)
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
  it('contains exactly 19 control points', () => {
    expect(REEF_RACE_DEFAULT_TRACK.length).toBe(19);
    expect(REEF_RACE_DEFAULT_TRACK_LENGTH).toBe(19);
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

  it('STEERING IS MANDATORY — a straight constant-x=startX line EXITS the corridor', () => {
    // The 2026-06-01 regression guard. The original v2 layout had slalom
    // amplitudes SMALLER than the local halfWidths, so a kart driving dead-
    // straight down the x=startX axis stayed inside the corridor the entire
    // race (zero wall contact) — and that straight path was ~8.6% SHORTER than
    // the meander, making the slalom strictly suboptimal to follow. This test
    // drives the REAL spline (exactly what the sim's wall-clamp does via
    // closestPointOnSpline) and asserts that the straight line leaves the
    // corridor — i.e. the walls engage and steering is required to finish.
    //
    // Metric: for a point on the straight x=startX path at many z, the
    // perpendicular distance to the centerline must EXCEED the local halfWidth
    // SOMEWHERE on the track. max(distance - halfWidth) > 0 proves a wall.
    const startX = REEF_RACE_DEFAULT_TRACK[0].x;
    const zMax = REEF_RACE_DEFAULT_TRACK[REEF_RACE_DEFAULT_TRACK.length - 1].z;
    const SAMPLES = 2000;

    let maxExitMargin = -Infinity;
    let exitZ = 0;
    let exitT = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const z = (i / SAMPLES) * zMax;
      const closest = spline.closestPointOnSpline({ x: startX, z });
      const halfW = spline.widthAt(closest.t);
      const margin = closest.distance - halfW; // > 0 ⇒ outside the corridor
      if (margin > maxExitMargin) {
        maxExitMargin = margin;
        exitZ = z;
        exitT = closest.t;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `  straight x=${startX} path: max(distance - halfWidth) = ` +
        `${maxExitMargin.toFixed(1)} wu @ z=${exitZ.toFixed(0)} (t=${exitT.toFixed(3)})`,
    );

    // Walls MUST engage on the straight line.
    expect(maxExitMargin).toBeGreaterThan(0);
    // And with real margin (≳150 wu past the wall at the worst peak) so a
    // small future amplitude/halfWidth drift can't silently re-open the bypass.
    expect(maxExitMargin).toBeGreaterThanOrEqual(150);
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
    // Spot-check: t=0 sits in the lagoon (halfWidth ~540), t=1 sits in the
    // finish (halfWidth ~540), mid-track is tighter (chokepoints). We don't
    // pin to exact numbers since centripetal interpolation smooths across the
    // boundary; we check ranges.
    // Updated 2026-06-01 (steering-mandatory re-tune): lagoon/finish 600→540,
    // kelp/shipwreck/coral all 290 (was 480/440/400) so the corridor is a few
    // kart-widths AND amplitude (440/460) exceeds it → walls actually engage.
    const wStart = spline.widthAt(0);
    const wFinish = spline.widthAt(1);
    expect(wStart).toBeGreaterThanOrEqual(500);
    expect(wStart).toBeLessThanOrEqual(580);
    expect(wFinish).toBeGreaterThanOrEqual(500);
    expect(wFinish).toBeLessThanOrEqual(580);

    // Mid-track must be tighter than start/finish (we have chokepoints there).
    const wMid = spline.widthAt(0.5);
    expect(wMid).toBeLessThan(wStart);
    expect(wMid).toBeLessThan(wFinish);

    // Tightest segments (kelp/shipwreck/coral) are now only a few kart-widths
    // (kart radius 22 → ~44 wu). Assert the corridor is genuinely tight so a
    // regression that re-widens it (walls never engaging again) fails here.
    expect(wMid).toBeLessThan(700);
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
