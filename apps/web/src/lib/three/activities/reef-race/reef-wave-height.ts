/**
 * reef-wave-height.ts — CPU mirror of the surf-ribbon.tsx water SURFACE HEIGHT.
 *
 * The water in `surf-ribbon.tsx` is a 7-octave GERSTNER surface: a base grid vertex is
 * displaced BOTH vertically (`dispY`) AND horizontally (`dispX/dispZ`, the crest pinch),
 * so `displaced = base + (dispX, dispY, dispZ)`. The surface point that ends up at a given
 * world XZ therefore started at a DIFFERENT grid point. Sampling `dispY` at the world XZ
 * directly (the old approach) over-/under-shoots: Gerstner crests pile up NARROW + TALL
 * and troughs go BROAD + shallow, so a board placed at the naive sine height sits BELOW
 * the real crests (submerged) and ABOVE the real troughs (floating) — the founder's
 * "floats then submerges" bug.
 *
 * Fix: INVERT the horizontal map. Find the grid base whose displaced position lands at the
 * board's world XZ (fixed-point: base = worldXZ − dispXZ(base)), then return the height
 * `dispY(base)` there. The shader normalises steepness so Σ(WSTEEP/N)=0.726 < 1, which makes
 * the map a contraction ⇒ the fixed point converges; ~8 iterations gives sub-wu accuracy.
 *
 * ⚠️ CONSTANTS MUST STAY IN SYNC with `surf-ribbon.tsx` `_waterVert` (WDIR / WLEN / WAMP /
 * WSPD / WSTEEP + the setEnv swing/freq + the Q normalisation). If you retune the shader's
 * Gerstner bank, update here in the same diff (like the CANYON_SAMPLES==RIBBON_SAMPLES seam
 * contract). Time is read from the SAME `state.clock.elapsedTime` the shader's `uTime` uses,
 * so the heave is phase-locked to what the water renders. Reads `WATER_TUNING.waveAmp` /
 * `.setStrength` so it matches whatever the water is currently rendering (committed defaults
 * in prod; live values under the water tuner).
 *
 * DELIBERATE POSE/RENDER SPLIT (R18a): the shader and `surfWaveHeightAt` retain all seven
 * octaves. `surfConformHeightAt` inverts that SAME full horizontal map, then returns only the
 * long-swell vertical octaves 0..2. Boards therefore ride the rendered groundswell while
 * planing over 300–640wu chop; boost portals keep the full-detail sampler and continue bobbing.
 *
 * NOT applied: the bank edge-taper `mask` (uv.x → 0 at the ribbon edges). The board rides
 * near the channel centre where mask≈1; if a board parks against a bank the height will read
 * slightly high there (acceptable for the sandbox; add the lateral-fraction mask if needed).
 */

import { WATER_TUNING } from './reef-water-tuning';

const TWO_PI = 6.28318530718;
const NWAVES = 7;
const CONFORM_WAVES = 3;

// Mirror of surf-ribbon.tsx WDIR (pre-normalized), WLEN, WAMP, WSPD, WSTEEP (7 octaves).
const WDIR: ReadonlyArray<readonly [number, number]> = [
  [0.242536, 0.970143],
  [0.928477, 0.371391],
  [-0.668965, 0.743276],
  [0.873704, -0.486502],
  [0.148556, 0.988899],
  [-0.947696, 0.319234],
  [0.695468, 0.718558],
];
const WLEN = [2300, 1500, 980, 640, 460, 340, 300];
const WAMP = [50, 33, 19, 10, 5, 2.6, 1.6];
const WSPD = [150, 126, 108, 94, 82, 70, 62];
const WSTEEP = [0.92, 0.90, 0.86, 0.80, 0.66, 0.52, 0.42];

// Reused output [dispX, dispZ, dispY] — surfWaveHeightAt is called sequentially (not
// reentrant), so a shared module scratch avoids per-call allocation.
const _disp = [0, 0, 0];

/**
 * Full 7-octave horizontal Gerstner displacement at grid point (bx,bz), time tSec.
 * Vertical displacement includes only the first `heightWaveCount` octaves. Writes _disp.
 */
function gerstnerDisp(
  bx: number,
  bz: number,
  tSec: number,
  waveAmp: number,
  setStrength: number,
  heightWaveCount: number,
): void {
  // Traveling "set" envelope on the two long swells (mirror surf-ribbon.tsx); negative-safe.
  const setSwing = 0.28 * Math.min(setStrength, 1) + 0.4 * Math.max(setStrength - 1, 0);
  const setFreq = 0.00075 * (1 + 0.6 * Math.max(setStrength - 1, 0));
  const setPhase = (WDIR[0][0] * bx + WDIR[0][1] * bz) * setFreq - tSec * 0.6;
  const setEnv = Math.max(0, 1 - setSwing * (1 - Math.sin(setPhase)));

  let dispX = 0;
  let dispZ = 0;
  let dispY = 0;
  for (let k = 0; k < 7; k++) {
    const w = TWO_PI / WLEN[k];
    const a = WAMP[k] * (k < 2 ? setEnv : 1) * waveAmp;
    const q = WSTEEP[k] / (w * Math.max(a, 1e-3) * NWAVES); // matches shader Q normalisation
    const ph = w * (WDIR[k][0] * bx + WDIR[k][1] * bz) + WSPD[k] * w * tSec;
    const cc = Math.cos(ph);
    dispX += q * a * WDIR[k][0] * cc;
    dispZ += q * a * WDIR[k][1] * cc;
    if (k < heightWaveCount) dispY += a * Math.sin(ph);
  }
  _disp[0] = dispX; _disp[1] = dispZ; _disp[2] = dispY;
}

/**
 * World-space surface HEIGHT (wu, above the centerline datum) of the water at world (x,z)
 * and time `tSec` — the Gerstner-correct height (horizontal pinch inverted), so a board
 * placed at `elevationAtT + this + rideHeight` sits ON the rendered surface through crests
 * and troughs (no float / submerge). Add to the centerline datum (`elevationAtT`).
 */
function invertedWaveHeightAt(
  x: number,
  z: number,
  tSec: number,
  heightWaveCount: number,
): number {
  const waveAmp = WATER_TUNING.waveAmp;
  const setStrength = WATER_TUNING.setStrength;

  // Invert the horizontal Gerstner map: base ← worldXZ − dispXZ(base). Contraction
  // (Σ WSTEEP/N = 0.726 < 1) ⇒ converges; 8 iters → sub-wu residual at our steepness.
  let bx = x;
  let bz = z;
  for (let i = 0; i < 8; i++) {
    // Height is unused while finding the base point; skip those sine evaluations.
    gerstnerDisp(bx, bz, tSec, waveAmp, setStrength, 0);
    bx = x - _disp[0];
    bz = z - _disp[1];
  }
  gerstnerDisp(bx, bz, tSec, waveAmp, setStrength, heightWaveCount);
  return _disp[2];
}

export function surfWaveHeightAt(x: number, z: number, tSec: number): number {
  return invertedWaveHeightAt(x, z, tSec, NWAVES);
}

/**
 * Board-pose conform datum at world (x,z): full rendered horizontal-map inversion,
 * but vertical height from only the 2300/1500/980wu long swells. The rendered water
 * and boost portals deliberately retain all seven vertical octaves.
 */
export function surfConformHeightAt(x: number, z: number, tSec: number): number {
  return invertedWaveHeightAt(x, z, tSec, CONFORM_WAVES);
}
