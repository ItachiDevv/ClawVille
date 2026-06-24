/**
 * scratchpad/ring-redesign.ts — design + verify the WIDE v6 "SURF ROAD" ring.
 *
 * The founder problem: the river is TOO THIN for 4 players. Target a water
 * surface ~1400–2200 wu wide (half-width ~700–1100). The v5 ring's tightest
 * corner is R=261 wu — far tighter than a 700+ corridor, so a racing line does
 * NOT fit inside the corridor on that corner (the WALL-CLAMP-STALL trap).
 *
 * KEY GEOMETRIC TRUTH: a road of half-width hw can only carve a corner whose
 * radius R satisfies R - hw > carve floor (192). For hw=760 that needs R>952.
 * So a WIDE river physically CANNOT have tight chicanes/hairpins — every turn
 * must be a BROAD sweeping bend. Reversals come from many broad alternating
 * sweeps, not pinhead esses. This still reads as an aggressive Mario-Kart
 * zig-zag because the sweeps alternate direction frequently over a huge
 * footprint — but each individual turn is wide.
 */
import { ReefSpline, type SplineControlPoint } from '../packages/shared/src/reef-race/spline';

const CARVE_FLOOR = 192;   // inside-line radius floor (matches sim)
const SAMPLES = 4000;
const ARC_SKIP = 6000;     // ignore near-arc neighbours when checking self-overlap

type CP = [number, number, number]; // x, z, halfWidth

// ─── v6 WIDE ring: 32 CPs, BROAD sweeping turns, huge footprint ──────────────
// Single CCW winding. CP0 on the south start straight. Every turn is a wide
// sweep (radius >> corridor hw). The esses are now BROAD alternating sweeps,
// not tight chicanes (a wide road can't carve tight chicanes). Footprint ~ ±15k
// so the broad turns have room. Reversals stay high (alternating broad sweeps).
const RING: CP[] = [
  // ── Seg 0: lagoon — START/FINISH STRAIGHT (south), very wide ──────────────
  [ -4600, -13800, 1000], // CP 0  START/FINISH (t=0)
  [   400, -14200, 1000], // CP 1  straight
  [  5400, -13700,  940], // CP 2  straight end → SE turn-in

  // ── Seg 1: kelp — broad SE sweeper into a wide EAST U-bend ────────────────
  [  9800, -11600,  860], // CP 3  SE sweeper
  [ 13200,  -8000,  800], // CP 4  climb (broad)
  [ 15000,  -3800,  760], // CP 5  wide U approach
  [ 15300,   1200,  740], // CP 6  U apex (east) — wide R
  [ 13300,  5400,   760], // CP 7  U exit (broad)
  [ 10200,  7400,   800], // CP 8  back inward (broad)

  // ── Seg 2: shipwreck — BROAD L-R-L-R sweeps (alternating, wide radius) ────
  [  6600,  8000,   800], // CP 9  broad sweep L
  [  7600, 11400,   760], // CP 10 broad sweep R
  [  4400, 12900,   760], // CP 11 broad sweep L
  [   600, 13400,   760], // CP 12 broad sweep R → far north
  [ -3400, 13100,   780], // CP 13 north top (broad)

  // ── Seg 3: coral — N→W big sweep + wide far-west U-BEND ───────────────────
  [ -7000, 12000,   780], // CP 14 NW sweep
  [-10200,  9900,   760], // CP 15 NW descent (broad)
  [-13000,  6800,   740], // CP 16 W run-in
  [-14800,  3000,   720], // CP 17 wide W U approach
  [-15300, -1400,   720], // CP 18 W U apex (far west) — wide R
  [-14000, -5600,   740], // CP 19 W U exit
  [-11600, -8400,   780], // CP 20 SW descent (broad)
  [ -9400, -9600,   800], // CP 21 broad sweep
  [ -7200, -9100,   800], // CP 22 broad sweep R (kink toward centre)
  [ -5400, -7600,   800], // CP 23 broad sweep L

  // ── Seg 4: finish — broad mid sweep + long SW return run to start ─────────
  [ -3800, -6400,   800], // CP 24 inward sweep
  [ -2800, -8400,   780], // CP 25 broad mid sweep
  [ -4400, -10400,  780], // CP 26 broad sweep out
  [ -6800, -11400,  800], // CP 27 SW
  [ -9000, -11900,  820], // CP 28 SW
  [-10000, -13400,  860], // CP 29 SW sweep widening
  [ -8200, -14200,  940], // CP 30 SW sweep
  [ -6400, -14000, 1000], // CP 31 → closing chord to CP0
];

function build(cps: CP[]): ReefSpline {
  const pts: SplineControlPoint[] = cps.map(([x, z, halfWidth]) => ({ x, z, halfWidth }));
  return new ReefSpline(pts, { closed: true });
}

function analyze(cps: CP[]) {
  const spline = build(cps);
  const arc = spline.totalArcLength;

  const sList: { t: number; x: number; z: number; hw: number; s: number }[] = [];
  for (let i = 0; i < SAMPLES; i += 4) {
    const t = i / SAMPLES;
    const c = spline.centerlineAt(t);
    sList.push({ t, x: c.x, z: c.z, hw: spline.widthAt(t), s: spline.arclengthFromT(t) });
  }

  let prevH = Math.atan2(spline.tangentAt(0).z, spline.tangentAt(0).x);
  let sweep = 0;
  let reversals = 0;
  let prevCurvSign = 0;
  function curv(t: number) {
    const h = 1 / SAMPLES;
    const a = spline.centerlineAt(((t - h) % 1 + 1) % 1);
    const b = spline.centerlineAt(t % 1);
    const c = spline.centerlineAt((t + h) % 1);
    const d1x = (c.x - a.x) / (2 * h), d1z = (c.z - a.z) / (2 * h);
    const d2x = (c.x - 2 * b.x + a.x) / (h * h), d2z = (c.z - 2 * b.z + a.z) / (h * h);
    return (d1x * d2z - d1z * d2x) / (Math.pow(d1x * d1x + d1z * d1z, 1.5) || 1e-9);
  }
  // collect curvature profile so we can report the tightest few corners
  const corners: { t: number; r: number; hw: number }[] = [];
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const tg = spline.tangentAt(t % 1);
    let h = Math.atan2(tg.z, tg.x);
    let d = h - prevH;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    sweep += d;
    prevH = h;
    const cs = Math.sign(curv(t));
    if (cs !== 0 && prevCurvSign !== 0 && cs !== prevCurvSign) reversals++;
    if (cs !== 0) prevCurvSign = cs;
    const k = Math.abs(curv(t));
    const r = k > 1e-9 ? 1 / k : Infinity;
    if (r < 3000) corners.push({ t, r, hw: spline.widthAt(t) });
  }

  let minR = Infinity, minRt = 0;
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const k = Math.abs(curv(t));
    const r = k > 1e-9 ? 1 / k : Infinity;
    if (r < minR) { minR = r; minRt = t; }
  }
  const hwAtMinR = spline.widthAt(minRt);
  const carveMargin = minR - hwAtMinR;

  let hwMin = Infinity, hwMax = -Infinity;
  for (let i = 0; i < SAMPLES; i++) { const w = spline.widthAt(i / SAMPLES); if (w < hwMin) hwMin = w; if (w > hwMax) hwMax = w; }

  let worstEdge = Infinity, worstPair = '';
  for (let a = 0; a < sList.length; a++) for (let b = a + 1; b < sList.length; b++) {
    const A = sList[a], B = sList[b];
    let ds = Math.abs(A.s - B.s); ds = Math.min(ds, arc - ds);
    if (ds < ARC_SKIP) continue;
    const xz = Math.hypot(A.x - B.x, A.z - B.z);
    const edge = xz - A.hw - B.hw;
    if (edge < worstEdge) { worstEdge = edge; worstPair = `t${A.t.toFixed(3)}~t${B.t.toFixed(3)} xz=${xz.toFixed(0)} hw=${A.hw.toFixed(0)}/${B.hw.toFixed(0)}`; }
  }

  let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (const s of sList) { if (s.x < xMin) xMin = s.x; if (s.x > xMax) xMax = s.x; if (s.z < zMin) zMin = s.z; if (s.z > zMax) zMax = s.z; }

  let minSpace = Infinity, minSpacePair = '';
  for (let i = 0; i < cps.length; i++) {
    const j = (i + 1) % cps.length;
    const d = Math.hypot(cps[i][0] - cps[j][0], cps[i][1] - cps[j][1]);
    if (d < minSpace) { minSpace = d; minSpacePair = `CP${i}->CP${j}`; }
  }

  const start = spline.centerlineAt(0);

  // Per-CP turn angle (exterior angle between incoming + outgoing chord). A big
  // angle at a CP = a tight kink there. This attributes tight corners to CPs.
  console.log(`\n  per-CP turn angle (deg) — big = tight kink:`);
  const angRows: string[] = [];
  for (let i = 0; i < cps.length; i++) {
    const p = cps[(i - 1 + cps.length) % cps.length];
    const c = cps[i];
    const n = cps[(i + 1) % cps.length];
    const v1x = c[0] - p[0], v1z = c[1] - p[1];
    const v2x = n[0] - c[0], v2z = n[1] - c[1];
    const a1 = Math.atan2(v1z, v1x), a2 = Math.atan2(v2z, v2x);
    let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    const deg = Math.abs(d * 180 / Math.PI);
    angRows.push(`    CP${i.toString().padStart(2)}  turn=${deg.toFixed(0).padStart(3)}deg  hw=${c[2]}  ${deg > 45 ? '<-- sharp' : ''}`);
  }
  console.log(angRows.join('\n'));

  // tightest distinct corners (local minima of R)
  const tight = corners.filter((c, i) => i > 0 && i < corners.length - 1).sort((a, b) => a.r - b.r).slice(0, 8);

  console.log(`\n========= v6 WIDE RING =========`);
  console.log(`  CPs                = ${cps.length}`);
  console.log(`  arc                = ${arc.toFixed(1)} wu`);
  console.log(`  heading sweep      = ${(sweep / Math.PI).toFixed(4)} π   ${Math.abs(Math.abs(sweep) - 2 * Math.PI) < 0.05 ? 'OK single winding' : '*** NOT single winding ***'}`);
  console.log(`  curvature reversals= ${reversals}`);
  console.log(`  min radius         = ${minR.toFixed(1)} wu @t${minRt.toFixed(3)}`);
  console.log(`  hw @ min-R         = ${hwAtMinR.toFixed(0)} wu`);
  console.log(`  CARVE MARGIN R-hw  = ${carveMargin.toFixed(1)} wu   ${carveMargin > CARVE_FLOOR ? `OK (>${CARVE_FLOOR} floor, line fits)` : `*** WALL-CLAMP RISK (<${CARVE_FLOOR}) ***`}`);
  console.log(`  hw range           = [${hwMin.toFixed(0)}, ${hwMax.toFixed(0)}]  (water ${(2 * hwMin).toFixed(0)}-${(2 * hwMax).toFixed(0)} wu WIDE)`);
  console.log(`  4-board fit?       = narrowest water = ${(2 * hwMin).toFixed(0)} wu  ${2 * hwMin > 700 ? 'OK 4+ boards fit' : '*** too thin somewhere ***'}`);
  console.log(`  worst inter-pass EDGE clearance = ${worstEdge.toFixed(1)} wu   ${worstEdge > 300 ? 'OK corridors separate' : '*** TOO TIGHT ***'}`);
  console.log(`    ${worstPair}`);
  console.log(`  min adjacent-CP spacing = ${minSpace.toFixed(0)} wu  ${minSpacePair}  ${minSpace > 200 ? 'OK' : '*** Newton guard risk ***'}`);
  console.log(`  footprint          = X[${xMin.toFixed(0)},${xMax.toFixed(0)}] Z[${zMin.toFixed(0)},${zMax.toFixed(0)}]  span ${(xMax - xMin).toFixed(0)} x ${(zMax - zMin).toFixed(0)}`);
  console.log(`  start centerline   = (${start.x.toFixed(0)}, ${start.z.toFixed(0)})`);
  console.log(`  tightest corners (R, hw, R-hw):`);
  for (const c of tight) console.log(`    t${c.t.toFixed(3)}  R=${c.r.toFixed(0)}  hw=${c.hw.toFixed(0)}  margin=${(c.r - c.hw).toFixed(0)} ${c.r - c.hw > CARVE_FLOOR ? '' : '  <-- TIGHT'}`);
}

analyze(RING);
