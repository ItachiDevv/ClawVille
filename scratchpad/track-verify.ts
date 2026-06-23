/**
 * scratchpad/track-verify.ts — Reef Race "SURF ROAD" (Rainbow-Road) track verifier.
 *
 * Drives the REAL `new ReefSpline(cands, { closed: true })` + a render-only
 * elevationAt(t) profile and reports EVERY load-bearing constraint at once.
 * NEVER hand-pick track numbers — iterate here until all PASS, then port the
 * winning candidate into packages/shared/src/reef-race/track-layout.ts.
 *
 * Run: bun run scratchpad/track-verify.ts
 *
 * The big difference vs the v4 (water-dominant land-disc) verifier:
 *  - We WANT aggressive zig-zag (many curvature reversals, hairpins/switchbacks).
 *  - The ribbon FLOATS in a void and can cross OVER/UNDER itself, so the
 *    self-intersection check is 3D: where two non-adjacent passes are close in
 *    XZ, they MUST be separated in ELEVATION by more than (ribbon thickness +
 *    vertical clearance). Pure-XZ corridor overlap is ALLOWED if there's a
 *    healthy Y gap (that's a Rainbow-Road overpass).
 */

import { ReefSpline, type SplineControlPoint } from '../packages/shared/src/reef-race/spline';

// ─── Candidate "SURF ROAD" control points ───────────────────────────────────
// Aggressive twisty floating circuit. CCW around origin, but it does NOT have
// to hug a circle — it sprawls and folds. Start/finish on the south straight.
// halfWidth: corridor half-width (the WATER ribbon is 2×hw wide). Rainbow Road
// ribbons are narrowish + banked; keep 240–520 (ribbon 480–1040 wu wide).

const CAND: SplineControlPoint[] = [
  // ── START / FINISH straight (south, gently wide for clean spawns) ──────────
  { x: -2400, z: -8200, halfWidth: 480 }, // 0  START/FINISH (t=0)
  { x:   200, z: -8500, halfWidth: 460 }, // 1  straight
  { x:  2900, z: -8200, halfWidth: 420 }, // 2  straight end → turn-in

  // ── SE rising sweeper into a RIGHT hairpin (widened so the carve fits) ─────
  { x:  5200, z: -7000, halfWidth: 400 }, // 3  SE sweeper
  { x:  7000, z: -5000, halfWidth: 380 }, // 4  climb
  { x:  8100, z: -3000, halfWidth: 360 }, // 5  hairpin approach
  { x:  8400, z:  -900, halfWidth: 360 }, // 6  HAIRPIN apex A (east)
  { x:  7300, z:   600, halfWidth: 360 }, // 7  hairpin bite
  { x:  6000, z:   600, halfWidth: 380 }, // 8  hairpin exit (back inward)

  // ── flowing S-CHAIN (chicane train: L-R-L-R) — eased so the carve fits the
  //    corridor (sharper esses wall-clamp the sim physics and stall karts).
  //    Lateral throw kept ≤ ~900 wu so the centerline radius stays > floor. ──
  { x:  5000, z:  1400, halfWidth: 380 }, // 9   ess L
  { x:  5600, z:  2800, halfWidth: 360 }, // 10  ess R
  { x:  4900, z:  4100, halfWidth: 360 }, // 11  ess L
  { x:  5500, z:  5300, halfWidth: 360 }, // 12  ess R
  { x:  4500, z:  6200, halfWidth: 360 }, // 13  ess exit L

  // ── NORTH big sweeping left, into the upper chicane ────────────────────────
  { x:  3000, z:  6600, halfWidth: 340 }, // 14  north sweep
  { x:  1300, z:  7000, halfWidth: 300 }, // 15  chicane in
  { x:   400, z:  8400, halfWidth: 280 }, // 16  chicane apex (out, far north)
  { x: -1500, z:  7900, halfWidth: 320 }, // 17  chicane exit

  // ── NW descent into a far-west U-HAIRPIN (one clean ~180° reversal) ────────
  { x: -3600, z:  7100, halfWidth: 360 }, // 18  NW run
  { x: -5600, z:  6200, halfWidth: 360 }, // 19  NW descent
  { x: -7700, z:  4900, halfWidth: 360 }, // 20  hairpin approach
  { x: -9000, z:  3000, halfWidth: 360 }, // 21  HAIRPIN apex B (far west, top)
  { x: -9100, z:   900, halfWidth: 360 }, // 22  hairpin around (wide enough to carve)
  { x: -7600, z:  -300, halfWidth: 380 }, // 23  hairpin exit heading S/E

  // ── a flowing chicane back toward centre, then out to the west wall ───────
  // CP24-26 sweep in then fold back out; a GENTLE S (not a 360 curl) so it does
  // NOT add a full winding turn. (A deliberate self-overpass here was tried and
  // rejected — it forced either a cusp (min-R→0.7) or extra winding; the clean
  // single-winding circuit with large inter-pass clearance + the undulating
  // elevation profile gives the floating Rainbow-Road read safely.)
  { x: -5800, z: -1100, halfWidth: 380 }, // 24  sweep SE (inward)
  { x: -5000, z: -2600, halfWidth: 360 }, // 25  mid chicane
  { x: -6200, z: -3700, halfWidth: 360 }, // 26  chicane out (back toward W wall)

  // ── long SW run back down to the start straight ────────────────────────────
  { x: -7400, z: -4200, halfWidth: 360 }, // 27  SW descent
  { x: -7600, z: -5900, halfWidth: 400 }, // 28  SW
  { x: -6500, z: -7100, halfWidth: 440 }, // 29  SW sweep widening
  { x: -5000, z: -7900, halfWidth: 460 }, // 30  SW sweep
  { x: -3300, z: -8100, halfWidth: 470 }, // 31  → closing chord to CP0
];

// ─── Render-only elevation profile (Y, world units) ─────────────────────────
// The sim is purely XZ. This lifts the ribbon + rider + camera together so the
// track floats + undulates like Rainbow Road, and so near-XZ passes separate
// vertically (overpass). t ∈ [0,1] cyclic. MUST be periodic: elevationAt(0) ===
// elevationAt(1) and slopes match at the seam (C1) so there's no kink at the
// start/finish line. We use a sum of sines with INTEGER cycle counts (periodic)
// + a controlled "big climb/drop" hump phased so the t≈0.78 fold (CP25 over the
// CP21 pass) sits at a different Y than t≈0.66 (CP21 region).
//
// NOTE: this is duplicated as `elevationAt` in track-layout.ts — verifier copy.
const TWO_PI = Math.PI * 2;
function elevationAt(t: number): number {
  const u = ((t % 1) + 1) % 1;
  // ALL components periodic in u (integer cycle counts / cos powers) so
  // elevationAt(0)===elevationAt(1) and the slope matches at the seam (C1):
  //   - base undulation: 2 gentle cycles around the loop
  //   - ripple: 4 finer cycles
  //   - hump: a broad single "mountain" via a high-power raised-cosine centred
  //     at the west overpass region (peak ~u=0.72), naturally periodic.
  const base = 460 * Math.sin(TWO_PI * (u * 2 - 0.08));
  const ripple = 130 * Math.sin(TWO_PI * (u * 4 + 0.25));
  // raised-cosine bump: ((1+cos)/2)^p peaks at the centre, 0 a half-period away.
  const cosArg = TWO_PI * (u - 0.72);
  const hump = 620 * Math.pow(0.5 + 0.5 * Math.cos(cosArg), 6);
  return base + ripple + hump;
}

// ─── Build the real closed spline ───────────────────────────────────────────
const spline = new ReefSpline(CAND, { closed: true });
const N = CAND.length;
const SAMPLES = 4000;

// ─── Arc length (driven, not assumed) ────────────────────────────────────────
const arc = spline.totalArcLength;

// ─── Heading sweep (must be exactly ±2π for one full closed loop) ────────────
let sweep = 0;
let prevAng = Math.atan2(spline.tangentAt(0).z, spline.tangentAt(0).x);
for (let i = 1; i <= SAMPLES; i++) {
  const t = i / SAMPLES;
  const tg = spline.tangentAt(t % 1);
  const ang = Math.atan2(tg.z, tg.x);
  let d = ang - prevAng;
  while (d > Math.PI) d -= TWO_PI;
  while (d < -Math.PI) d += TWO_PI;
  sweep += d;
  prevAng = ang;
}

// ─── Curvature reversals + min radius of curvature (wrap-around) ─────────────
function curvatureAt(t: number): number {
  const h = 1 / SAMPLES;
  const a = spline.centerlineAt(((t - h) % 1 + 1) % 1);
  const b = spline.centerlineAt(t % 1);
  const c = spline.centerlineAt((t + h) % 1);
  const d1x = (c.x - a.x) / (2 * h);
  const d1z = (c.z - a.z) / (2 * h);
  const d2x = (c.x - 2 * b.x + a.x) / (h * h);
  const d2z = (c.z - 2 * b.z + a.z) / (h * h);
  const num = d1x * d2z - d1z * d2x;
  const den = Math.pow(d1x * d1x + d1z * d1z, 1.5) || 1e-9;
  return num / den; // signed curvature
}
let reversals = 0;
let prevSign = Math.sign(curvatureAt(0));
let minRadius = Infinity;
let minRadiusT = 0;
for (let i = 1; i <= SAMPLES; i++) {
  const t = i / SAMPLES;
  const k = curvatureAt(t);
  const s = Math.sign(k);
  if (s !== 0 && prevSign !== 0 && s !== prevSign) reversals++;
  if (s !== 0) prevSign = s;
  const r = Math.abs(k) > 1e-9 ? 1 / Math.abs(k) : Infinity;
  if (r < minRadius) { minRadius = r; minRadiusT = t; }
}

// ─── CP spacing (adjacent) ───────────────────────────────────────────────────
let minCpSpacing = Infinity;
let minCpSpacingIdx = -1;
for (let i = 0; i < N; i++) {
  const a = CAND[i];
  const b = CAND[(i + 1) % N];
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  if (d < minCpSpacing) { minCpSpacing = d; minCpSpacingIdx = i; }
}

// ─── 3D self-intersection: min ribbon-edge clearance accounting for ELEVATION ─
// Sample the loop; for each pair of non-adjacent samples (skip a wide arc
// window so the seam-straight + adjacent corners don't false-positive), compute:
//   xzGap   = centerline XZ distance
//   yGap    = |elevationAt(ti) - elevationAt(tj)|
//   edgeGap = xzGap - hw(ti) - hw(tj)   (negative => corridors overlap in XZ)
// A pair is a COLLISION only if the corridors overlap in XZ (edgeGap < margin)
// AND they are NOT vertically separated (yGap < RIBBON_THICK + VCLEAR).
// Report: worst (most negative) 3D separation = max over pairs of
//   min(edgeGap, yGap - (RIBBON_THICK + VCLEAR))  ... we want the WORST case
//   where BOTH are small. We compute the closest "true 3D touch".
const STEP = 6;                 // sample stride
const ARC_SKIP = 4200;          // skip pairs within this much ARC of each other
const RIBBON_THICK = 60;        // visual ribbon slab thickness (wu)
const VCLEAR = 240;             // min vertical air gap for an overpass (wu)
const sList: { t: number; x: number; z: number; hw: number; y: number; s: number }[] = [];
for (let i = 0; i < SAMPLES; i += STEP) {
  const t = i / SAMPLES;
  const c = spline.centerlineAt(t);
  sList.push({ t, x: c.x, z: c.z, hw: spline.widthAt(t), y: elevationAt(t), s: spline.arclengthFromT(t) });
}
let worstXzEdgeGap = Infinity;       // most-negative XZ edge gap among ALL near pairs
let worstXzEdgeGapPair = '';
let worst3dTouch = Infinity;         // worst TRUE 3D clearance (collision if < 0)
let worst3dPair = '';
let overlapCount = 0;                // # of XZ-overlapping pairs (need elevation)
for (let a = 0; a < sList.length; a++) {
  for (let b = a + 1; b < sList.length; b++) {
    const A = sList[a], B = sList[b];
    // cyclic arc separation
    let ds = Math.abs(A.s - B.s);
    ds = Math.min(ds, arc - ds);
    if (ds < ARC_SKIP) continue;
    const xzGap = Math.hypot(A.x - B.x, A.z - B.z);
    const edgeGap = xzGap - A.hw - B.hw;
    const yGap = Math.abs(A.y - B.y);
    if (edgeGap < worstXzEdgeGap) { worstXzEdgeGap = edgeGap; worstXzEdgeGapPair = `t${A.t.toFixed(3)}~t${B.t.toFixed(3)} xzGap=${xzGap.toFixed(0)} hw=${A.hw.toFixed(0)}/${B.hw.toFixed(0)}`; }
    if (edgeGap < 0) {
      overlapCount++;
      // true 3D touch = how close the two slabs get. If XZ overlaps, the only
      // separation is vertical: yGap minus (slab thickness + clearance).
      const touch = yGap - (RIBBON_THICK + VCLEAR);
      if (touch < worst3dTouch) { worst3dTouch = touch; worst3dPair = `t${A.t.toFixed(3)}~t${B.t.toFixed(3)} xzGap=${xzGap.toFixed(0)} edgeGap=${edgeGap.toFixed(0)} yGap=${yGap.toFixed(0)}`; }
    }
  }
}

// ─── Footprint ────────────────────────────────────────────────────────────────
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
let minInnerEdgeFromOrigin = Infinity;
for (let i = 0; i < SAMPLES; i++) {
  const t = i / SAMPLES;
  const c = spline.centerlineAt(t);
  if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
  if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;
  const distOrigin = Math.hypot(c.x, c.z);
  const innerEdge = distOrigin - spline.widthAt(t);
  if (innerEdge < minInnerEdgeFromOrigin) minInnerEdgeFromOrigin = innerEdge;
}

// ─── Elevation profile stats ─────────────────────────────────────────────────
let minY = Infinity, maxY = -Infinity;
let maxAbsSlope = 0; // |dY/ds| — vertical grade (wu of Y per wu of arc)
const seamY = elevationAt(0);
const seamYend = elevationAt(1 - 1e-9);
let prevY = elevationAt(0), prevS2 = 0;
for (let i = 0; i <= SAMPLES; i++) {
  const t = i / SAMPLES;
  const y = elevationAt(t);
  if (y < minY) minY = y; if (y > maxY) maxY = y;
  const s = spline.arclengthFromT(t % 1) + (i === SAMPLES ? arc : 0);
  const dseg = s - prevS2;
  if (dseg > 1e-6) {
    const grade = Math.abs(y - prevY) / dseg;
    if (grade > maxAbsSlope) maxAbsSlope = grade;
  }
  prevY = y; prevS2 = s;
}
// seam C1 check: slope just before 1 vs just after 0
const seamSlopeBefore = (elevationAt(1) - elevationAt(1 - 0.001)) / 0.001;
const seamSlopeAfter = (elevationAt(0.001) - elevationAt(0)) / 0.001;

// ─── Arclength round-trip (sanity) ───────────────────────────────────────────
let maxRtErr = 0;
for (let i = 0; i <= 100; i++) {
  const t = i / 100;
  const s = spline.arclengthFromT(t);
  const t2 = spline.tFromArclength(s);
  maxRtErr = Math.max(maxRtErr, Math.abs(t - t2));
}

// ─── Report ───────────────────────────────────────────────────────────────────
const P = (b: boolean) => (b ? 'PASS' : '*** FAIL ***');
console.log('═══ SURF ROAD track verify ═══');
console.log(`control points        = ${N}`);
console.log(`arc length            = ${arc.toFixed(1)} wu`);
console.log(`heading sweep         = ${(sweep / Math.PI).toFixed(4)} π   ${P(Math.abs(Math.abs(sweep / Math.PI) - 2) < 0.02)}`);
console.log(`curvature reversals   = ${reversals}              ${P(reversals >= 18)}  (want >=18, aggressive zig-zag)`);
console.log(`min radius of curv.   = ${minRadius.toFixed(1)} wu @ t=${minRadiusT.toFixed(3)}   ${P(minRadius >= 190)}  (floor 190; carveable)`);
console.log(`min adjacent CP space = ${minCpSpacing.toFixed(1)} wu @ CP${minCpSpacingIdx}   ${P(minCpSpacing > 200)}  (Newton-basin guard)`);
console.log('--- 3D self-intersection (elevation-aware) ---');
console.log(`XZ-overlapping pairs  = ${overlapCount}   (these REQUIRE vertical separation)`);
console.log(`worst XZ edge gap     = ${worstXzEdgeGap.toFixed(1)} wu   (${worstXzEdgeGapPair})`);
console.log(`worst 3D touch        = ${worst3dTouch === Infinity ? 'n/a (no XZ overlaps)' : worst3dTouch.toFixed(1) + ' wu'}   ${P(worst3dTouch === Infinity || worst3dTouch > 0)}  (>0 = clean overpass, slabs ${RIBBON_THICK} + ${VCLEAR} clear)`);
if (worst3dTouch !== Infinity) console.log(`  closest 3D pair     = ${worst3dPair}`);
console.log('--- elevation profile (render-only) ---');
console.log(`Y range               = [${minY.toFixed(0)}, ${maxY.toFixed(0)}] wu  (span ${(maxY - minY).toFixed(0)})`);
console.log(`max vertical grade    = ${(maxAbsSlope * 100).toFixed(1)}%   ${P(maxAbsSlope < 0.35)}  (<35% so karts stay on the ribbon)`);
console.log(`seam Y continuity     = start ${seamY.toFixed(1)} vs end ${seamYend.toFixed(1)}   ${P(Math.abs(seamY - seamYend) < 1)}`);
console.log(`seam slope continuity = before ${seamSlopeBefore.toFixed(1)} vs after ${seamSlopeAfter.toFixed(1)}   ${P(Math.abs(seamSlopeBefore - seamSlopeAfter) < 50)}`);
console.log('--- footprint ---');
console.log(`X range               = [${minX.toFixed(0)}, ${maxX.toFixed(0)}]  (span ${(maxX - minX).toFixed(0)})`);
console.log(`Z range               = [${minZ.toFixed(0)}, ${maxZ.toFixed(0)}]  (span ${(maxZ - minZ).toFixed(0)})`);
console.log(`min inner-edge/origin = ${minInnerEdgeFromOrigin.toFixed(0)} wu`);
console.log(`arclength round-trip  = ${maxRtErr.toExponential(2)}   ${P(maxRtErr < 1e-3)}`);
console.log(`centerlineAt(0)       = (${spline.centerlineAt(0).x.toFixed(0)}, ${spline.centerlineAt(0).z.toFixed(0)})`);

// ─── Cruise pace estimate (for lap-budget tuning) ────────────────────────────
const REEF_MAX_SPEED = 500;
const fullThrustStraight = REEF_MAX_SPEED * 0.992;
const humanAvg = 410, botAvg = 340;
console.log('--- pacing (for lap budget) ---');
console.log(`one loop @ human ~${humanAvg} wu/s = ${(arc / humanAvg).toFixed(0)} s; @ bot ~${botAvg} wu/s = ${(arc / botAvg).toFixed(0)} s`);
console.log(`2-lap race ≈ ${((arc / humanAvg) * 2 / 60).toFixed(1)}–${((arc / botAvg) * 2 / 60).toFixed(1)} min`);

// ─── CP → t projections (for pinning REEF_RACE_SEGMENTS t-ranges) ────────────
console.log('--- CP -> t projections (segment boundary pinning) ---');
const boundaryCPs = [0, 3, 9, 14, 18, 24, 31];
for (const idx of boundaryCPs) {
  const cp = CAND[idx];
  const r = spline.closestPointOnSpline({ x: cp.x, z: cp.z });
  console.log(`CP${idx} (${cp.x},${cp.z}) -> t=${r.t.toFixed(4)} hw=${spline.widthAt(r.t).toFixed(0)} dist=${r.distance.toFixed(1)}`);
}
// hw sweep min/max
let hwMin = Infinity, hwMax = -Infinity;
for (let i = 0; i < SAMPLES; i++) { const w = spline.widthAt(i / SAMPLES); if (w < hwMin) hwMin = w; if (w > hwMax) hwMax = w; }
console.log(`hw sweep: [${hwMin.toFixed(0)}, ${hwMax.toFixed(0)}] wu  (water ribbon ${(2*hwMin).toFixed(0)}-${(2*hwMax).toFixed(0)} wu wide)`);
