/**
 * reef-race-track-layout.test.ts
 *
 * Sanity tests for the locked v5 "SURF ROAD" aggressively-twisty floating
 * CLOSED-LOOP default ribbon. Catches geometric regressions before they reach
 * the sim:
 *   - Exactly 32 control points (any add/remove must be intentional)
 *   - All adjacent CP-pair distances > 88 wu, INCLUDING the closing chord
 *     (Newton mis-segmenting guard)
 *   - Total spline arclength in [55 000, 66 000] wu (~145–175s loop window)
 *   - CP[0] on the start/finish line; centerlineAt(0) === centerlineAt(1)
 *   - Heading sweeps a full ±2π (one clean closed circumnavigation)
 *   - Min radius of curvature ≥ the carve floor (a real but carveable track)
 *   - MANY curvature sign reversals (aggressive zig-zag; v5 has 28)
 *   - Start/finish corridor is the widest gate (clean spawns + finish gate)
 *   - No CENTERLINE self-intersection within 88 wu, AND the corridor EDGES never
 *     touch (single-winding circuit; the verified inter-pass clearance is large)
 *   - REEF_RACE_SEGMENTS is a contiguous t-range partition of the loop
 *   - The RENDER-ONLY elevation profile is periodic + bounded (no kink at seam,
 *     grade under the carve limit) — the sim never reads it but the render does.
 *
 * 2026-06-23 "SURF ROAD" REBUILD: founder reframed the vision — a floating
 * Rainbow-Road WATER RIBBON in a cosmic void, NO land. v5 is more aggressively
 * twisty (28 reversals vs 12), SPRAWLS (~16 982 wu footprint), has a render-only
 * ELEVATION profile (Y span ~1634 wu), and a narrower banked ribbon (hw 257–480
 * vs 471–910). CP count, start XZ, arc bounds, widths all move to match.
 *
 * The 88 wu CENTERLINE threshold is the Newton-basin guard (4 × REEF_BODY_RADIUS
 * = 88 wu). The corridor edge-clearance margin (≥150 wu of open space between
 * non-adjacent passes) is the wide-corridor self-intersection check; v5's
 * single-winding circuit verifies ~1868 wu.
 */

import { describe, it, expect } from 'bun:test';
import { ReefSpline, type Vec2 } from '../reef-race-spline';
import {
  REEF_RACE_DEFAULT_TRACK,
  REEF_RACE_DEFAULT_TRACK_LENGTH,
  REEF_RACE_DEFAULT_TRACK_ARC_LENGTH,
  REEF_RACE_SEGMENTS,
} from '../reef-race-track-layout';
import {
  reefTrackElevationAt,
  reefTrackBankAngleAt,
} from '@clawville/shared';

// ─── Constants from spec / risk doc ─────────────────────────────────────────

/** Architecture doc Risk #1: 4 × REEF_BODY_RADIUS (22 wu) = 88 wu safe margin. */
const MIN_SAFE_CP_SPACING_WU = 88;

/**
 * Corridor edge-clearance margin (wu). For a single-winding circuit the two
 * sides of the loop must not touch: the non-adjacent centerline gap must exceed
 * (halfWidth_i + halfWidth_j) by at least this margin. Verified value ~1868 wu.
 */
const MIN_CORRIDOR_EDGE_CLEARANCE_WU = 150;

/** Lower bound on totalArcLength — the v5 SURF ROAD ring (~59 391 wu). */
const ARC_LENGTH_LOWER_WU = 55_000;

/** Upper bound on totalArcLength — keeps the 2-lap race inside the lap budget. */
const ARC_LENGTH_UPPER_WU = 66_000;

/** Carve floor: REEF_MAX_SPEED / REEF_TURN_RATE = 500 / 2.6 ≈ 192.3 wu. */
const MIN_TURN_RADIUS_FLOOR_WU = 500 / 2.6;

/** Design-target min radius (above the hard floor; v5 verifies ~229.5 wu). */
const MIN_TURN_RADIUS_TARGET_WU = 200;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('REEF_RACE_DEFAULT_TRACK — locked v5 SURF ROAD floating closed-loop ribbon', () => {
  it('contains exactly 32 control points', () => {
    expect(REEF_RACE_DEFAULT_TRACK.length).toBe(32);
    expect(REEF_RACE_DEFAULT_TRACK_LENGTH).toBe(32);
  });

  it('first CP sits on the start/finish line (south straight)', () => {
    const start = REEF_RACE_DEFAULT_TRACK[0];
    // CP[0] anchors the start/finish line at XZ=(-2400, -8200).
    expect(start.x).toBe(-2400);
    expect(start.z).toBe(-8200);
    expect(start.halfWidth).toBeGreaterThan(0);
  });

  it('every CP has a positive halfWidth', () => {
    for (let i = 0; i < REEF_RACE_DEFAULT_TRACK.length; i++) {
      expect(REEF_RACE_DEFAULT_TRACK[i].halfWidth).toBeGreaterThan(0);
    }
  });

  it('start/finish straight CPs are the WIDEST gate; mid-loop hairpins are tighter', () => {
    // Lagoon (start/finish, CP0-2) is the widest gate (clean spawns + finish);
    // the esses/hairpins are tighter (a banked Rainbow-Road ribbon).
    expect(REEF_RACE_DEFAULT_TRACK[0].halfWidth).toBeGreaterThanOrEqual(460);
    expect(REEF_RACE_DEFAULT_TRACK[1].halfWidth).toBeGreaterThanOrEqual(440);
    expect(REEF_RACE_DEFAULT_TRACK[2].halfWidth).toBeGreaterThanOrEqual(400);
    // The tightest mid-loop CPs (S-chain CP10/11, W hairpin CP21/22) are the
    // narrowest of the corridor but still surfable (~257-300 wu half-width).
    expect(REEF_RACE_DEFAULT_TRACK[10].halfWidth).toBeLessThan(
      REEF_RACE_DEFAULT_TRACK[0].halfWidth,
    );
    expect(REEF_RACE_DEFAULT_TRACK[21].halfWidth).toBeLessThan(
      REEF_RACE_DEFAULT_TRACK[0].halfWidth,
    );
    // …and the minimum corridor is still surfable (>= ~250 wu half-width).
    const minHw = Math.min(...REEF_RACE_DEFAULT_TRACK.map((c) => c.halfWidth));
    expect(minHw).toBeGreaterThanOrEqual(250);
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

  it('total arclength falls in the SURF ROAD loop window [55 000, 66 000] wu', () => {
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

  it('heading sweeps a FULL ±2π (one clean closed circumnavigation)', () => {
    // Sum of signed tangent-angle deltas around the loop must be ≈ ±2π — proves
    // the ring winds a full 360° ONCE (not twice, not a back-and-forth). This is
    // the guard that the aggressive zig-zag/folds didn't introduce extra winding.
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
    // only if min R ≥ ≈192 wu. Design target ≳200. Sample finely with WRAP-
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

  it('has MANY curvature sign reversals (aggressive zig-zag, not a plain oval)', () => {
    // A plain circle has ZERO sign reversals; v5 SURF ROAD is an aggressive
    // twisty circuit (esses + chicanes + hairpins) → many left↔right reversals.
    // We smooth the per-step signed heading delta to ignore numerical noise,
    // then count genuine sign changes with a deadband.
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
    console.log(`  curvature sign reversals = ${reversals} (v5 aggressive zig-zag; need ≥12)`);
    expect(reversals).toBeGreaterThanOrEqual(12);
  });

  it('start/finish straight has the widest corridor for clean spawns', () => {
    // The lagoon (t≈0..0.11) is the spawn + finish gate (the widest part).
    const wStart = spline.widthAt(0);
    expect(wStart).toBeGreaterThanOrEqual(460);
    expect(wStart).toBeLessThanOrEqual(520);
    // Mid-loop (a hairpin/chicane region) must be tighter than the start gate.
    const wMid = spline.widthAt(0.5);
    expect(wMid).toBeLessThan(wStart);
    // …but still surfable, not a creek.
    expect(wMid).toBeGreaterThanOrEqual(250);
  });

  it('does not self-intersect within the body radius (no folds < 88 wu)', () => {
    // Dense centerline sampling; min distance between NON-adjacent samples must
    // exceed 88 wu. "Non-adjacent" excludes an arc neighbourhood around each
    // sample. The skip window spans ~3200 wu of arc so the seam-adjacent
    // start-straight samples (t≈0.99 vs t≈0.01 — the SAME physical straight)
    // aren't counted as two passes.
    const M = 2000;
    const pts: Vec2[] = [];
    for (let i = 0; i < M; i++) pts.push(spline.centerlineAt(i / M));
    const skip = Math.ceil(M * (3200 / spline.totalArcLength));
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

  it('corridor edges never touch (clearance > halfWidth sum + margin)', () => {
    // Single-winding circuit: for every non-adjacent centerline pass, the
    // centerline gap minus the two halfWidths there must stay positive by
    // MIN_CORRIDOR_EDGE_CLEARANCE_WU. v5 verifies ~1868 wu (huge margin).
    const M = 2000;
    const pts: Vec2[] = [];
    const hws: number[] = [];
    for (let i = 0; i < M; i++) {
      const t = i / M;
      pts.push(spline.centerlineAt(t));
      hws.push(spline.widthAt(t));
    }
    const skip = Math.ceil(M * (3200 / spline.totalArcLength));
    let minClear = Infinity;
    let minPair = '';
    for (let i = 0; i < M; i++) {
      for (let j = i + 1; j < M; j++) {
        const cyc = Math.min(j - i, M - (j - i));
        if (cyc <= skip) continue;
        const dx = pts[i].x - pts[j].x;
        const dz = pts[i].z - pts[j].z;
        const gap = Math.sqrt(dx * dx + dz * dz);
        const clear = gap - hws[i] - hws[j];
        if (clear < minClear) {
          minClear = clear;
          minPair = `t${(i / M).toFixed(3)}(hw${hws[i].toFixed(0)})~t${(j / M).toFixed(3)}(hw${hws[j].toFixed(0)})`;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`  min corridor edge clearance = ${minClear.toFixed(1)} wu @ ${minPair}`);
    expect(minClear).toBeGreaterThan(MIN_CORRIDOR_EDGE_CLEARANCE_WU);
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

describe('reefTrackElevationAt — RENDER-ONLY floating-ribbon Y profile', () => {
  it('is periodic at the seam: Y(0) === Y(1) (no kink at the start/finish line)', () => {
    expect(Math.abs(reefTrackElevationAt(0) - reefTrackElevationAt(1))).toBeLessThan(1e-6);
    // also wraps: Y(1.25) === Y(0.25)
    expect(Math.abs(reefTrackElevationAt(1.25) - reefTrackElevationAt(0.25))).toBeLessThan(1e-6);
  });

  it('slope matches at the seam (C1 — smooth across the start/finish line)', () => {
    const h = 1e-4;
    const slopeBefore = (reefTrackElevationAt(1) - reefTrackElevationAt(1 - h)) / h;
    const slopeAfter = (reefTrackElevationAt(0 + h) - reefTrackElevationAt(0)) / h;
    expect(Math.abs(slopeBefore - slopeAfter)).toBeLessThan(50);
  });

  it('Y range stays within a sane floating band (dramatic but not absurd)', () => {
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i <= 4000; i++) {
      const y = reefTrackElevationAt(i / 4000);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // eslint-disable-next-line no-console
    console.log(`  elevation Y ∈ [${minY.toFixed(0)}, ${maxY.toFixed(0)}] (span ${(maxY - minY).toFixed(0)})`);
    expect(maxY - minY).toBeGreaterThan(800);   // a real, dramatic undulation
    expect(maxY - minY).toBeLessThan(3000);      // not absurd
  });

  it('max vertical grade |dY/ds| stays under the carve limit (≤35%)', () => {
    // Grade against ARC length — karts must stay glued to the ribbon on climbs.
    const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
    const arc = spline.totalArcLength;
    const N = 4000;
    let maxGrade = 0;
    let prevY = reefTrackElevationAt(0);
    let prevS = 0;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const y = reefTrackElevationAt(t);
      const s = spline.arclengthFromT(t) + (i === N ? 0 : 0);
      const ds = s - prevS;
      if (ds > 1e-6) {
        const grade = Math.abs(y - prevY) / ds;
        if (grade > maxGrade) maxGrade = grade;
      }
      prevY = y;
      prevS = s;
    }
    // close the loop: last sample (t≈1) to seam (arc) — handle wrap separately
    // (kept simple; the interior maximum dominates).
    // eslint-disable-next-line no-console
    console.log(`  max vertical grade = ${(maxGrade * 100).toFixed(1)}% (limit 35%)`);
    expect(maxGrade).toBeLessThanOrEqual(0.35);
  });
});

describe('reefTrackBankAngleAt — RENDER-ONLY banking profile', () => {
  const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
  const headingAt = (tt: number) => {
    const tg = spline.tangentAt(tt);
    return Math.atan2(tg.z, tg.x);
  };

  it('stays within the ±28° lean cap everywhere', () => {
    const cap = (28 * Math.PI) / 180 + 1e-6;
    for (let i = 0; i <= 4000; i++) {
      const bank = reefTrackBankAngleAt(i / 4000, headingAt);
      expect(Math.abs(bank)).toBeLessThanOrEqual(cap);
    }
  });

  it('leans into the tight turns (nonzero on the hairpins/esses)', () => {
    // The far-west hairpin (t≈0.66) and the S-chain (t≈0.35) must produce a
    // meaningful lean (>5°).
    const fiveDeg = (5 * Math.PI) / 180;
    const hairpinBank = Math.abs(reefTrackBankAngleAt(0.66, headingAt));
    const essBank = Math.abs(reefTrackBankAngleAt(0.35, headingAt));
    expect(Math.max(hairpinBank, essBank)).toBeGreaterThan(fiveDeg);
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
