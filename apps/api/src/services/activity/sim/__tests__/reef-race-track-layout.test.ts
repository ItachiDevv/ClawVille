/**
 * reef-race-track-layout.test.ts
 *
 * Sanity tests for the locked v2 default track. Catches geometric regressions
 * before they reach the sim:
 *   - Exactly 16 control points (any add/remove must be intentional)
 *   - All adjacent CP-pair distances > 88 wu (Newton mis-segmenting guard)
 *   - Total spline arclength in [17 000, 21 000] wu (~60s race window)
 *   - First CP at origin (z = 0, x = 0) — start-line invariant
 *   - Last CP near (x ≈ 0, z ≈ 18 000) — finish-line invariant
 *
 * The 88 wu threshold comes from `.claude/plans/reef-race-v2-spline-architecture.md`
 * Risk #1: "no folds within 88 wu of itself in XZ".
 *
 * The 17k-21k arclength window:
 *   - Lower bound 17 000: even with zero curvature added by the slalom we expect
 *     at least the straight-line z-span (~18 000); 17k catches a layout that
 *     accidentally truncates the finish straight.
 *   - Upper bound 21 000: a layout with excessive S-bend amplitude would inflate
 *     arc by >15%, breaking the 60s race-time target.
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

/** Lower bound on totalArcLength — straight line minus a small slack. */
const ARC_LENGTH_LOWER_WU = 17_000;

/** Upper bound on totalArcLength — slalom adds ~5-15%, anything more breaks 60s. */
const ARC_LENGTH_UPPER_WU = 21_000;

/** Final-CP target z-coordinate (per layout doc). */
const FINISH_Z_TARGET_WU = 18_000;

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

  it('last CP sits on the finish line (x≈0, z≈18000)', () => {
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

  it('total arclength falls in the 60s race-time window [17 000, 21 000] wu', () => {
    const arc = spline.totalArcLength;
    // eslint-disable-next-line no-console
    console.log(`  totalArcLength = ${arc.toFixed(1)} wu`);
    expect(arc).toBeGreaterThanOrEqual(ARC_LENGTH_LOWER_WU);
    expect(arc).toBeLessThanOrEqual(ARC_LENGTH_UPPER_WU);
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
    // Spot-check: t=0 sits in the lagoon (halfWidth ~500), t≈0.45 sits in the
    // shipwreck segment (halfWidth ~250), t=1 sits in the finish (halfWidth ~500).
    // We don't pin to exact numbers since centripetal interpolation smooths
    // across the boundary; we check ranges. Updated 2026-04-29 from the
    // original 30-50 wu values after preview confirmed the surfboard kart
    // measures ~115 wu wide and would not fit. New baseline matches the
    // OLD ellipse track's REEF_TRACK_HALF_WIDTH = 300.
    const wStart = spline.widthAt(0);
    const wFinish = spline.widthAt(1);
    expect(wStart).toBeGreaterThanOrEqual(450);
    expect(wStart).toBeLessThanOrEqual(550);
    expect(wFinish).toBeGreaterThanOrEqual(450);
    expect(wFinish).toBeLessThanOrEqual(550);

    // Mid-track must be tighter than start/finish (we have chokepoints there).
    const wMid = spline.widthAt(0.5);
    expect(wMid).toBeLessThan(wStart);
    expect(wMid).toBeLessThan(wFinish);
  });
});

describe('REEF_RACE_SEGMENTS — themed segment table', () => {
  it('covers z=[0, 18000] contiguously with no gaps or overlaps', () => {
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
