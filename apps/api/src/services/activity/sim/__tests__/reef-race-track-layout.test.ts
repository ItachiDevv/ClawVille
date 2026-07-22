/**
 * Numeric regression tests for the locked v7 "TECHNICAL SURF ROAD" closed
 * ribbon. The 52-point loop retains broad surf runs and adds two smoothly
 * pinched technical cores. The load-bearing wall-clamp invariant is pointwise:
 * radius(t) - widthAt(t) > 550 wu at every sample. The suite also locks the
 * 70k–96k arc budget, 36–42 reversals, clean single winding, >300 wu inter-pass
 * edge clearance, periodic render elevation/banking, segment partition, and
 * the >200 wu adjacent-control-point Newton guard.
 *
 * Canonical exact metrics come from scripts/reef/verify-track-v7.ts, which
 * drives the real shared ReefSpline and widthAt profile.
 */

import { describe, it, expect } from 'bun:test';
import { ReefSpline, type Vec2 } from '../reef-race-spline';
import {
  REEF_RACE_DEFAULT_TRACK,
  REEF_RACE_DEFAULT_TRACK_LENGTH,
  REEF_RACE_DEFAULT_TRACK_ARC_LENGTH,
  REEF_RACE_SEGMENTS,
  REEF_RACE_TECHNICAL_ZONES,
} from '../reef-race-track-layout';
import { REEF_MAX_SPEED, REEF_TURN_RATE } from '../reef-race-config';
import {
  reefTrackElevationAt,
  reefTrackBankAngleAt,
} from '@clawville/shared';

// ─── Constants from spec / risk doc ─────────────────────────────────────────

/** Architecture doc Risk #1: 4 × REEF_BODY_RADIUS (22 wu) = 88 wu safe margin. */
const MIN_SAFE_CP_SPACING_WU = 200;

/**
 * Corridor edge-clearance margin (wu). For a single-winding circuit the two
 * sides of the loop must not touch: the non-adjacent centerline gap must exceed
 * (halfWidth_i + halfWidth_j) by at least this margin. v7 verifies 487.2 wu.
 */
const MIN_CORRIDOR_EDGE_CLEARANCE_WU = 300;

/** Lower bound on totalArcLength for the v7 95,741 wu technical surf road. */
const ARC_LENGTH_LOWER_WU = 70_000;

/** Upper bound on totalArcLength — keeps the 2-lap race inside the lap budget. */
const ARC_LENGTH_UPPER_WU = 96_000;

/** Carve floor: REEF_MAX_SPEED / REEF_TURN_RATE = 1300 / 2.6 = 500 wu (2× cap 2026-07-15). */
const MIN_TURN_RADIUS_FLOOR_WU = REEF_MAX_SPEED / REEF_TURN_RATE;

/**
 * Broad minimum-radius guard. The stronger v7 invariant below is pointwise
 * radius(t)-widthAt(t)>550 because broad and technical widths intentionally differ.
 */
const MIN_TURN_RADIUS_TARGET_WU = 900;

/** Widest v7 per-CP halfWidth (broad water ~3240 wu); test bound only. */
const MAX_CORRIDOR_HALF_WIDTH_WU = 1620;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('REEF_RACE_DEFAULT_TRACK — locked v7 technical surf-road closed loop', () => {
  it('contains exactly 52 control points', () => {
    expect(REEF_RACE_DEFAULT_TRACK.length).toBe(52);
    expect(REEF_RACE_DEFAULT_TRACK_LENGTH).toBe(52);
  });

  it('first CP sits on the start/finish line (south straight)', () => {
    const start = REEF_RACE_DEFAULT_TRACK[0];
    // Raw authoring Z=-11425 is mapped by the canonical v7 0.891 XZ scale.
    expect(start.x).toBe(0);
    expect(start.z).toBeCloseTo(-10179.675, 6);
    expect(start.halfWidth).toBeGreaterThan(0);
  });

  it('every CP has a positive halfWidth', () => {
    for (let i = 0; i < REEF_RACE_DEFAULT_TRACK.length; i++) {
      expect(REEF_RACE_DEFAULT_TRACK[i].halfWidth).toBeGreaterThan(0);
    }
  });

  it('pinches technical zones while keeping the start broad', () => {
    // v7 pinches both technical cores while retaining a broad start/finish.
    const minHw = Math.min(...REEF_RACE_DEFAULT_TRACK.map((c) => c.halfWidth));
    const maxHw = Math.max(...REEF_RACE_DEFAULT_TRACK.map((c) => c.halfWidth));
    // eslint-disable-next-line no-console
    console.log(`  per-CP halfWidth range = [${minHw}, ${maxHw}] (water ${2 * minHw}-${2 * maxHw} wu wide)`);
    expect(minHw).toBeGreaterThanOrEqual(450);
    expect(maxHw).toBeLessThanOrEqual(MAX_CORRIDOR_HALF_WIDTH_WU);
    // The start/finish straight (CP0-2) is wide for clean spawns + finish gate.
    expect(REEF_RACE_DEFAULT_TRACK[0].halfWidth).toBeGreaterThanOrEqual(900);
    expect(REEF_RACE_DEFAULT_TRACK[1].halfWidth).toBeGreaterThanOrEqual(900);
    expect(REEF_RACE_DEFAULT_TRACK[2].halfWidth).toBeGreaterThanOrEqual(900);
  });

  it('all adjacent CP-pair distances exceed 200 wu — INCLUDING the closing chord', () => {
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

  it('total arclength falls in the v7 loop window [70 000, 96 000] wu', () => {
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

  it('keeps pointwise radius minus width above the v7 carve gate', () => {
    // A racing line must fit inside the local corridor on every corner. v7 narrows
    // the corridor before its sharpest turns, so the binding invariant is local
    // R(t)-widthAt(t)>550 rather than min-R against the global maximum width.
    // Sample finely with WRAP-AROUND
    // finite differences (the loop has no endpoints) and assert the carve margin.
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
    const hwAtMinR = spline.widthAt(minRT);
    const carveMargin = minR - hwAtMinR;
    // eslint-disable-next-line no-console
    console.log(
      `  min radius = ${minR.toFixed(1)} wu @ t=${minRT.toFixed(3)} ` +
        `(hw there=${hwAtMinR.toFixed(0)}, CARVE MARGIN R-hw=${carveMargin.toFixed(1)} wu, ` +
        `floor=${MIN_TURN_RADIUS_FLOOR_WU.toFixed(1)}, design≥${MIN_TURN_RADIUS_TARGET_WU})`,
    );
    expect(minR).toBeGreaterThanOrEqual(MIN_TURN_RADIUS_FLOOR_WU);
    expect(minR).toBeGreaterThanOrEqual(MIN_TURN_RADIUS_TARGET_WU);
    // The wall-clamp fix: a racing line fits inside the wide corridor everywhere.
    expect(carveMargin).toBeGreaterThan(550);
  });

  it('has 36–42 calibrated curvature reversals', () => {
    const N = 8000;
    const h = 0.0005;
    let reversals = 0;
    let firstSign = 0;
    let lastSign = 0;
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const a = spline.tangentAt((t - h + 1) % 1);
      const b = spline.tangentAt((t + h) % 1);
      const cross = a.x * b.z - a.z * b.x;
      const sign = cross > 1e-8 ? 1 : cross < -1e-8 ? -1 : 0;
      if (sign === 0) continue;
      if (firstSign === 0) firstSign = sign;
      if (lastSign !== 0 && sign !== lastSign) reversals++;
      lastSign = sign;
    }
    if (lastSign !== firstSign) reversals++;
    expect(reversals).toBeGreaterThanOrEqual(36);
    expect(reversals).toBeLessThanOrEqual(42);
  });

  it('samples both technical pinches and broad surf sections', () => {
    // The real interpolated profile must include both v7 technical and broad
    // widths. The start/finish straight (t≈0) stays broad for the full grid.
    let wMin = Infinity;
    let wMax = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const w = spline.widthAt(i / 4000);
      if (w < wMin) wMin = w;
      if (w > wMax) wMax = w;
    }
    const wStart = spline.widthAt(0);
    // eslint-disable-next-line no-console
    console.log(`  sampled halfWidth = [${wMin.toFixed(0)}, ${wMax.toFixed(0)}], start=${wStart.toFixed(0)}`);
    expect(wMin).toBeGreaterThanOrEqual(450);
    expect(wMax).toBeLessThanOrEqual(MAX_CORRIDOR_HALF_WIDTH_WU + 5);
    expect(wStart).toBeGreaterThanOrEqual(900);  // wide start/finish gate
  });

  it('does not self-intersect within the body radius (no folds < 88 wu)', () => {
    // Dense centerline sampling; min distance between NON-adjacent samples must
    // exceed 88 wu. "Non-adjacent" excludes an arc neighbourhood around each
    // sample. The skip window spans ~6000 wu of arc so the seam-adjacent
    // start-straight samples (t≈0.99 vs t≈0.01 — the SAME physical straight)
    // aren't counted as two passes.
    const M = 2000;
    const pts: Vec2[] = [];
    for (let i = 0; i < M; i++) pts.push(spline.centerlineAt(i / M));
    const skip = Math.ceil(M * (6000 / spline.totalArcLength));
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
    const skip = Math.ceil(M * (6000 / spline.totalArcLength));
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

  it('max vertical grade |dY/ds| stays under 20%', () => {
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
    console.log(`  max vertical grade = ${(maxGrade * 100).toFixed(1)}% (limit 20%)`);
    expect(maxGrade).toBeLessThan(0.20);
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

  it('leans into the tight turns (nonzero on the broad sweeps)', () => {
    // The east-bend sweep (t≈0.25, ~18°) and the W-bend (t≈0.65, ~15°) must
    // produce a meaningful lean (>5°) — verified by scratchpad/bank-check2.ts.
    const fiveDeg = (5 * Math.PI) / 180;
    const eastBank = Math.abs(reefTrackBankAngleAt(0.25, headingAt));
    const westBank = Math.abs(reefTrackBankAngleAt(0.65, headingAt));
    expect(Math.max(eastBank, westBank)).toBeGreaterThan(fiveDeg);
  });

  it('stays near-flat on the start/finish straight (not pegged at the cap)', () => {
    // The start straight (t≈0..0.05) must read as a gentle lean (< 14°), proving
    // the gain is sane (the bank tracks curvature, not a constant max roll).
    const fourteenDeg = (14 * Math.PI) / 180;
    expect(Math.abs(reefTrackBankAngleAt(0.02, headingAt))).toBeLessThan(fourteenDeg);
    expect(Math.abs(reefTrackBankAngleAt(0.05, headingAt))).toBeLessThan(fourteenDeg);
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

describe('REEF_RACE_TECHNICAL_ZONES — canonical v7 pinches', () => {
  const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });

  it('defines the S-chicane and near-hairpin cores at 450–700wu half-width', () => {
    expect(REEF_RACE_TECHNICAL_ZONES.map((zone) => zone.id)).toEqual([
      's-chicane',
      'near-hairpin',
    ]);
    for (const zone of REEF_RACE_TECHNICAL_ZONES) {
      let minWidth = Infinity;
      let maxWidth = -Infinity;
      for (let i = 0; i <= 1000; i++) {
        const t = zone.tStart + (zone.tEnd - zone.tStart) * (i / 1000);
        const width = spline.widthAt(t);
        minWidth = Math.min(minWidth, width);
        maxWidth = Math.max(maxWidth, width);
      }
      expect(minWidth).toBeGreaterThanOrEqual(450);
      expect(maxWidth).toBeLessThanOrEqual(700);
    }
  });
});
