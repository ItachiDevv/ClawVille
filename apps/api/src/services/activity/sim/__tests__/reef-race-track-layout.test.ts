/**
 * reef-race-track-layout.test.ts
 *
 * Sanity tests for the locked v3 CLOSED-LOOP default ring track. Catches
 * geometric regressions before they reach the sim:
 *   - Exactly 20 control points (any add/remove must be intentional)
 *   - All adjacent CP-pair distances > 88 wu, INCLUDING the closing chord
 *     (Newton mis-segmenting guard)
 *   - Total spline arclength in [28 000, 31 000] wu (~90s loop window)
 *   - CP[0] on the start/finish line; centerlineAt(0) === centerlineAt(1)
 *   - Heading sweeps a full ±2π (closed circumnavigation)
 *   - Min radius of curvature ≥ the carve floor (a real but carveable track)
 *   - ≥1 curvature sign reversal (the chicane + hairpin exist)
 *   - Start/finish corridor is WIDE (clean spawns + finish gate)
 *   - No self-intersection within 88 wu
 *   - REEF_RACE_SEGMENTS is a contiguous t-range partition of the loop
 *
 * 2026-06-22 CLOSED-LOOP REBUILD: the prior OPEN dead-straight-z slalom is
 * retired. The z-monotonicity + finish-z=28000 + z-range-segment assertions
 * are REPLACED with loop-appropriate ones (z is non-monotonic on a ring).
 *
 * The 88 wu threshold comes from `.claude/plans/reef-race-v2-spline-architecture.md`
 * Risk #1: "no folds within 88 wu of itself in XZ".
 */

import { describe, it, expect } from 'bun:test';
import { ReefSpline, type Vec2 } from '../reef-race-spline';
import {
  REEF_RACE_DEFAULT_TRACK,
  REEF_RACE_DEFAULT_TRACK_LENGTH,
  REEF_RACE_DEFAULT_TRACK_ARC_LENGTH,
  REEF_RACE_SEGMENTS,
} from '../reef-race-track-layout';

// ─── Constants from spec / risk doc ─────────────────────────────────────────

/** Architecture doc Risk #1: 4 × REEF_BODY_RADIUS (22 wu) = 88 wu safe margin. */
const MIN_SAFE_CP_SPACING_WU = 88;

/** Lower bound on totalArcLength — preserves the ~90s loop-time tuning. */
const ARC_LENGTH_LOWER_WU = 28_000;

/** Upper bound on totalArcLength — anything more breaks the 90s soft timeout. */
const ARC_LENGTH_UPPER_WU = 31_000;

/** Carve floor: REEF_MAX_SPEED / REEF_TURN_RATE = 500 / 2.6 ≈ 192.3 wu. */
const MIN_TURN_RADIUS_FLOOR_WU = 500 / 2.6;

/** Design-target min radius (well above the hard floor). */
const MIN_TURN_RADIUS_TARGET_WU = 250;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('REEF_RACE_DEFAULT_TRACK — locked v3 closed-loop ring', () => {
  it('contains exactly 20 control points', () => {
    expect(REEF_RACE_DEFAULT_TRACK.length).toBe(20);
    expect(REEF_RACE_DEFAULT_TRACK_LENGTH).toBe(20);
  });

  it('first CP sits on the start/finish line (south straight)', () => {
    const start = REEF_RACE_DEFAULT_TRACK[0];
    // CP[0] anchors the start/finish line at XZ=(-1600, -4300).
    expect(start.x).toBe(-1600);
    expect(start.z).toBe(-4300);
    expect(start.halfWidth).toBeGreaterThan(0);
  });

  it('every CP has a positive halfWidth', () => {
    for (let i = 0; i < REEF_RACE_DEFAULT_TRACK.length; i++) {
      expect(REEF_RACE_DEFAULT_TRACK[i].halfWidth).toBeGreaterThan(0);
    }
  });

  it('start/finish straight CPs are WIDE; mid-loop chicane/hairpin CPs are TIGHT', () => {
    // Lagoon (start/finish, CP0-2) is the wide gate; the bends are tight.
    expect(REEF_RACE_DEFAULT_TRACK[0].halfWidth).toBeGreaterThanOrEqual(500);
    expect(REEF_RACE_DEFAULT_TRACK[1].halfWidth).toBeGreaterThanOrEqual(500);
    expect(REEF_RACE_DEFAULT_TRACK[2].halfWidth).toBeGreaterThanOrEqual(500);
    // A mid-loop hairpin CP must be tight (a few kart-widths).
    expect(REEF_RACE_DEFAULT_TRACK[14].halfWidth).toBeLessThan(400);
  });

  it('all adjacent CP-pair distances exceed 88 wu — INCLUDING the closing chord', () => {
    // CLOSED loop: the pair CP[N-1]→CP[0] (closing chord) is a REAL segment and
    // must also clear the Newton mis-seg guard. Iterate modulo N.
    const N = REEF_RACE_DEFAULT_TRACK.length;
    const violations: Array<{ pair: string; distance: number }> = [];
    let minDist = Infinity;
    let maxDist = -Infinity;
    let sumDist = 0;

    for (let i = 0; i < N; i++) {
      const a = REEF_RACE_DEFAULT_TRACK[i];
      const b = REEF_RACE_DEFAULT_TRACK[(i + 1) % N];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < MIN_SAFE_CP_SPACING_WU) {
        violations.push({ pair: `CP${i}→CP${(i + 1) % N}`, distance: d });
      }
      if (d < minDist) minDist = d;
      if (d > maxDist) maxDist = d;
      sumDist += d;
    }

    expect(violations).toEqual([]);

    const avg = sumDist / N;
    // eslint-disable-next-line no-console
    console.log(
      `  CP-pair distance (incl. closing chord): min=${minDist.toFixed(1)} wu, ` +
      `max=${maxDist.toFixed(1)} wu, avg=${avg.toFixed(1)} wu ` +
      `(threshold=${MIN_SAFE_CP_SPACING_WU} wu)`,
    );
  });
});

describe('REEF_RACE_DEFAULT_TRACK — closed spline integration', () => {
  // The sim builds this CLOSED — exercise the same construction here.
  const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });

  it('builds as a closed loop', () => {
    expect(spline.closed).toBe(true);
  });

  it('total arclength falls in the ~90s loop window [28 000, 31 000] wu', () => {
    const arc = spline.totalArcLength;
    // eslint-disable-next-line no-console
    console.log(`  totalArcLength = ${arc.toFixed(1)} wu`);
    expect(arc).toBeGreaterThanOrEqual(ARC_LENGTH_LOWER_WU);
    expect(arc).toBeLessThanOrEqual(ARC_LENGTH_UPPER_WU);
    // The exported constant must track the real spline (re-verify on CP change).
    expect(arc).toBeCloseTo(REEF_RACE_DEFAULT_TRACK_ARC_LENGTH, 0);
  });

  it('centerlineAt(0) === centerlineAt(1) (the loop seam is one point)', () => {
    const c0 = spline.centerlineAt(0);
    const c1 = spline.centerlineAt(1);
    expect(Math.abs(c0.x - c1.x)).toBeLessThan(1e-6);
    expect(Math.abs(c0.z - c1.z)).toBeLessThan(1e-6);
  });

  it('centerlineAt(0) lands on the start CP', () => {
    const start = spline.centerlineAt(0);
    const cp0 = REEF_RACE_DEFAULT_TRACK[0];
    expect(Math.abs(start.x - cp0.x)).toBeLessThan(0.01);
    expect(Math.abs(start.z - cp0.z)).toBeLessThan(0.01);
  });

  it('heading sweeps a FULL ±2π (closed circumnavigation)', () => {
    // Sum of signed tangent-angle deltas around the loop must be ≈ ±2π — proves
    // the ring winds a full 360° (not a back-and-forth, not a partial arc).
    const N = 4000;
    let prevAng = Math.atan2(spline.tangentAt(0).z, spline.tangentAt(0).x);
    let sweep = 0;
    for (let i = 1; i <= N; i++) {
      const tg = spline.tangentAt(i / N);
      const ang = Math.atan2(tg.z, tg.x);
      let d = ang - prevAng;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      sweep += d;
      prevAng = ang;
    }
    // eslint-disable-next-line no-console
    console.log(`  heading sweep = ${(sweep / Math.PI).toFixed(4)}π`);
    expect(Math.abs(Math.abs(sweep) - 2 * Math.PI)).toBeLessThan(0.02);
  });

  it('min radius of curvature ≥ the carve floor (a followable track)', () => {
    // A clean carve at REEF_MAX_SPEED=500 with REEF_TURN_RATE≈2.6 holds the line
    // only if min R ≥ ≈192 wu. Design target ≳250. Sample finely with WRAP-
    // AROUND finite differences (the loop has no endpoints).
    const N = 4000;
    const h = 1e-3;
    let minR = Infinity;
    let minRT = 0;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p0 = spline.centerlineAt((t - h + 1) % 1);
      const p1 = spline.centerlineAt(t % 1);
      const p2 = spline.centerlineAt((t + h) % 1);
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
        `(floor=${MIN_TURN_RADIUS_FLOOR_WU.toFixed(1)} wu, target≥${MIN_TURN_RADIUS_TARGET_WU})`,
    );
    expect(minR).toBeGreaterThanOrEqual(MIN_TURN_RADIUS_FLOOR_WU);
    expect(minR).toBeGreaterThanOrEqual(MIN_TURN_RADIUS_TARGET_WU);
  });

  it('has ≥1 curvature sign reversal (the chicane + hairpin are present)', () => {
    // A plain circle has ZERO sign reversals (constant-sign curvature) and would
    // FAIL this — the track must have at least one left↔right reversal (chicane)
    // plus the hairpin. We smooth the per-step signed heading delta to ignore
    // numerical noise, then count genuine sign changes with a deadband.
    const N = 4000;
    const curv: number[] = [];
    let prevAng = Math.atan2(spline.tangentAt(0).z, spline.tangentAt(0).x);
    for (let i = 1; i <= N; i++) {
      const tg = spline.tangentAt(i / N);
      const ang = Math.atan2(tg.z, tg.x);
      let d = ang - prevAng;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      curv.push(d);
      prevAng = ang;
    }
    const W = 40;
    const DEAD = 2e-4;
    const sm: number[] = [];
    for (let i = 0; i < curv.length; i++) {
      let acc = 0;
      let cnt = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(curv.length - 1, i + W); j++) {
        acc += curv[j];
        cnt++;
      }
      sm.push(acc / cnt);
    }
    let reversals = 0;
    let lastSign = 0;
    for (const v of sm) {
      const sg = v > DEAD ? 1 : v < -DEAD ? -1 : 0;
      if (sg !== 0 && lastSign !== 0 && sg !== lastSign) reversals++;
      if (sg !== 0) lastSign = sg;
    }
    // eslint-disable-next-line no-console
    console.log(`  curvature sign reversals = ${reversals} (need ≥1; a plain circle = 0)`);
    expect(reversals).toBeGreaterThanOrEqual(1);
  });

  it('start/finish straight has a WIDE corridor for clean spawns', () => {
    // The lagoon (t≈0..0.11) is the spawn + finish gate. Corridor must be wide
    // and mid-loop bends must be tighter than it.
    const wStart = spline.widthAt(0);
    expect(wStart).toBeGreaterThanOrEqual(500);
    expect(wStart).toBeLessThanOrEqual(580);
    // Mid-loop (a hairpin/chicane region) must be tighter than the start gate.
    const wMid = spline.widthAt(0.5);
    expect(wMid).toBeLessThan(wStart);
    expect(wMid).toBeLessThan(700);
  });

  it('does not self-intersect within the body radius (no folds < 88 wu)', () => {
    // Dense centerline sampling; min distance between NON-adjacent samples must
    // exceed 88 wu. "Non-adjacent" excludes a small arc neighbourhood around
    // each sample (cyclic index gap).
    const M = 1500;
    const pts: Vec2[] = [];
    for (let i = 0; i < M; i++) pts.push(spline.centerlineAt(i / M));
    const skip = Math.ceil(M * (700 / spline.totalArcLength));
    let minSelf = Infinity;
    let minPair = '';
    for (let i = 0; i < M; i++) {
      for (let j = i + 1; j < M; j++) {
        const cyc = Math.min(j - i, M - (j - i));
        if (cyc <= skip) continue;
        const dx = pts[i].x - pts[j].x;
        const dz = pts[i].z - pts[j].z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < minSelf) {
          minSelf = d;
          minPair = `t${(i / M).toFixed(3)}~t${(j / M).toFixed(3)}`;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`  min non-adjacent self-distance = ${minSelf.toFixed(1)} wu @ ${minPair}`);
    expect(minSelf).toBeGreaterThan(MIN_SAFE_CP_SPACING_WU);
  });

  it('arclength round-trip tFromArclength(arclengthFromT(t)) ≈ t for sample t', () => {
    const samples = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
    for (const t of samples) {
      const s = spline.arclengthFromT(t);
      const tBack = spline.tFromArclength(s);
      expect(Math.abs(tBack - t)).toBeLessThan(0.001);
    }
  });
});

describe('REEF_RACE_SEGMENTS — themed loop t-range table', () => {
  it('lists the 5 themed segments in loop order', () => {
    expect(REEF_RACE_SEGMENTS.map((s) => s.id)).toEqual([
      'lagoon',
      'kelp',
      'shipwreck',
      'coral',
      'finish',
    ]);
  });

  it('partitions t∈[0,1] contiguously with no gaps or overlaps', () => {
    expect(REEF_RACE_SEGMENTS[0].tStart).toBe(0);
    expect(REEF_RACE_SEGMENTS[REEF_RACE_SEGMENTS.length - 1].tEnd).toBe(1);
    for (let i = 1; i < REEF_RACE_SEGMENTS.length; i++) {
      // tEnd of one segment === tStart of the next.
      expect(REEF_RACE_SEGMENTS[i].tStart).toBe(REEF_RACE_SEGMENTS[i - 1].tEnd);
      // Strictly increasing.
      expect(REEF_RACE_SEGMENTS[i].tStart).toBeGreaterThan(
        REEF_RACE_SEGMENTS[i - 1].tStart,
      );
    }
  });

  it('every segment has a positive non-empty t-range and halfWidth', () => {
    for (const seg of REEF_RACE_SEGMENTS) {
      expect(seg.tEnd).toBeGreaterThan(seg.tStart);
      expect(seg.tStart).toBeGreaterThanOrEqual(0);
      expect(seg.tEnd).toBeLessThanOrEqual(1);
      expect(seg.halfWidth).toBeGreaterThan(0);
    }
  });
});
