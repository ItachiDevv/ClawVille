/**
 * scratchpad/v6-width-verify.ts
 * Verify new wider half-widths on the LOCKED v6 ring CPs.
 * Tests scaled-up hw profiles: target water surface ~2400-3000wu wide (hw 1200-1500).
 */
import { ReefSpline, type SplineControlPoint } from '../packages/shared/src/reef-race/spline';

// LOCKED v6 ring CPs (from track-layout.ts)
const V6_CPS: [number, number, number][] = [
  [     0, -11425, 986 ],  // CP  0
  [  1952,  -9813, 981 ],  // CP  1
  [  3640,  -8788, 1018],  // CP  2
  [  5284,  -7909, 939 ],  // CP  3
  [  6658,  -6658, 1028],  // CP  4
  [  8011,  -5353, 905 ],  // CP  5
  [ 10320,  -4275, 1038],  // CP  6
  [ 13682,  -2721, 894 ],  // CP  7
  [ 16369,      0, 752 ],  // CP  8
  [ 16606,   3303, 760 ],  // CP  9
  [ 14647,   6067, 920 ],  // CP 10
  [ 12072,   8066, 1020],  // CP 11
  [  9715,   9715, 997 ],  // CP 12
  [  7360,  11016, 947 ],  // CP 13
  [  4857,  11727, 976 ],  // CP 14
  [  2391,  12023, 1000],  // CP 15
  [     0,  12072, 936 ],  // CP 16
  [ -2292,  11523, 899 ],  // CP 17
  [ -4242,  10240, 1003],  // CP 18
  [ -5938,   8887, 949 ],  // CP 19
  [ -7927,   7927, 1025],  // CP 20
  [-10123,   6764, 836 ],  // CP 21
  [-11456,   4745, 804 ],  // CP 22
  [-11465,   2281, 1015],  // CP 23
  [-11334,      0, 867 ],  // CP 24
  [-12274,  -2442, 1027],  // CP 25
  [-13627,  -5645, 886 ],  // CP 26
  [-13703,  -9156, 795 ],  // CP 27
  [-11903, -11903, 831 ],  // CP 28
  [ -8968, -13422, 893 ],  // CP 29
  [ -5716, -13800, 896 ],  // CP 30
  [ -2595, -13047, 909 ],  // CP 31
];

const FLOOR = 192;
const SAMPLES = 4000;
const ARC_SKIP = 7000;

function buildSpline(hwScale: number): ReefSpline {
  const cps: SplineControlPoint[] = V6_CPS.map(([x, z, hw]) => ({
    x,
    z,
    halfWidth: Math.round(hw * hwScale),
  }));
  return new ReefSpline(cps, { closed: true });
}

function analyze(label: string, hwScale: number) {
  const sp = buildSpline(hwScale);
  const arc = sp.totalArcLength;

  // Sample list for inter-pass clearance check
  const sList: { t: number; x: number; z: number; hw: number; s: number }[] = [];
  for (let i = 0; i < SAMPLES; i += 4) {
    const t = i / SAMPLES;
    const c = sp.centerlineAt(t);
    sList.push({ t, x: c.x, z: c.z, hw: sp.widthAt(t), s: sp.arclengthFromT(t) });
  }

  let worstEdge = Infinity, worstPair = '';
  for (let a = 0; a < sList.length; a++) {
    for (let b = a + 1; b < sList.length; b++) {
      const A = sList[a], B = sList[b];
      let ds = Math.abs(A.s - B.s);
      ds = Math.min(ds, arc - ds);
      if (ds < ARC_SKIP) continue;
      const xz = Math.hypot(A.x - B.x, A.z - B.z);
      const edge = xz - A.hw - B.hw;
      if (edge < worstEdge) {
        worstEdge = edge;
        worstPair = `t${A.t.toFixed(3)}~t${B.t.toFixed(3)} xz=${xz.toFixed(0)} hw=${A.hw.toFixed(0)}/${B.hw.toFixed(0)}`;
      }
    }
  }

  // Min radius (finite-difference curvature)
  function curv(t: number): number {
    const h = 1 / SAMPLES;
    const a = sp.centerlineAt(((t - h) % 1 + 1) % 1);
    const b = sp.centerlineAt(t % 1);
    const c = sp.centerlineAt((t + h) % 1);
    const d1x = (c.x - a.x) / (2 * h), d1z = (c.z - a.z) / (2 * h);
    const d2x = (c.x - 2 * b.x + a.x) / (h * h), d2z = (c.z - 2 * b.z + a.z) / (h * h);
    return (d1x * d2z - d1z * d2x) / (Math.pow(d1x * d1x + d1z * d1z, 1.5) || 1e-9);
  }

  let minR = Infinity, minRt = 0;
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const k = Math.abs(curv(t));
    const r = k > 1e-9 ? 1 / k : Infinity;
    if (r < minR) { minR = r; minRt = t; }
  }

  const hwAtMinR = sp.widthAt(minRt);
  const carveMargin = minR - hwAtMinR;

  let hwMin = Infinity, hwMax = -Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const w = sp.widthAt(i / SAMPLES);
    if (w < hwMin) hwMin = w;
    if (w > hwMax) hwMax = w;
  }

  const waterMin = 2 * hwMin, waterMax = 2 * hwMax;

  console.log(`\n=== ${label} (scale ×${hwScale.toFixed(3)}) ===`);
  console.log(`  arc = ${arc.toFixed(1)} wu`);
  console.log(`  hw = [${hwMin.toFixed(0)}, ${hwMax.toFixed(0)}] wu`);
  console.log(`  water width = ${waterMin.toFixed(0)}–${waterMax.toFixed(0)} wu  (target: 2400–3000)`);
  console.log(`  min R = ${minR.toFixed(1)} @ t${minRt.toFixed(3)}  hw_there = ${hwAtMinR.toFixed(0)}  carveMargin = ${carveMargin.toFixed(0)} ${carveMargin > FLOOR ? 'OK' : '*** BELOW FLOOR ***'}`);
  console.log(`  worst inter-pass EDGE clearance = ${worstEdge.toFixed(1)} wu  ${worstEdge > 300 ? 'OK' : '*** TOO TIGHT ***'}`);
  console.log(`    ${worstPair}`);
}

// Current v6 baseline
analyze('v6 baseline (×1.000)', 1.000);
// Candidates for ~2400-3000wu water surface
analyze('scale ×1.55 → water ~2290-3218wu', 1.55);
analyze('scale ×1.60 → water ~2364-3323wu', 1.60);
analyze('scale ×1.65 → water ~2437-3427wu', 1.65);
analyze('scale ×1.50 → water ~2214-3118wu', 1.50);
