/**
 * reef-wave-height.ts — CPU mirror of the surf-ribbon.tsx water VERTICAL HEAVE.
 *
 * The water surface in `surf-ribbon.tsx` is `datum + Gerstner displacement`. The
 * GERSTNER VERTICAL HEAVE (`dispY = Σ A·sin(phase)`) can reach ~±120wu above/below
 * the centerline datum. A kart placed at the datum therefore sits UNDERWATER half the
 * time. To make the board SURF, place it on the actual surface: datum + this heave.
 *
 * This evaluates the SAME vertical-heave sum the vertex shader computes, in world XZ,
 * in time-sync with the shader (same `clock.elapsedTime`). The horizontal Gerstner
 * pinch is omitted — it only nudges where a surface point lands laterally, which is
 * negligible for placing a kart that's already tracking its own XZ.
 *
 * ⚠️ CONSTANTS MUST STAY IN SYNC with `surf-ribbon.tsx` `_waterVert` (WDIR / WLEN /
 * WAMP / WSPD + the setEnv boost). If you retune the shader's Gerstner bank, update
 * here in the same diff (like the CANYON_SAMPLES==RIBBON_SAMPLES seam contract).
 * Reads `WATER_TUNING.waveAmp` / `.setStrength` so it matches whatever the water is
 * currently rendering (committed defaults in prod; live values under the water tuner).
 */

import { WATER_TUNING } from './reef-water-tuning';

const TWO_PI = 6.28318530718;

// Mirror of surf-ribbon.tsx WDIR (pre-normalized), WLEN, WAMP, WSPD (7 octaves).
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

/**
 * World-space vertical heave (wu) of the water surface at (x,z) and time `tSec`.
 * Add to the centerline datum (`elevationAtT`) + a small ride height to float a kart
 * on the surface. Mirrors the shader's traveling "set" envelope on the two long
 * swells (k<2), negative-safe floor included.
 */
export function surfWaveHeightAt(x: number, z: number, tSec: number): number {
  const waveAmp = WATER_TUNING.waveAmp;
  const setStrength = WATER_TUNING.setStrength;

  // Traveling set envelope (mirror surf-ribbon.tsx): swing + freq boost above 1,
  // floored at 0 so a boosted swing can't invert. Applied to the two long swells.
  const setSwing = 0.28 * Math.min(setStrength, 1) + 0.4 * Math.max(setStrength - 1, 0);
  const setFreq = 0.00075 * (1 + 0.6 * Math.max(setStrength - 1, 0));
  const setPhase = (WDIR[0][0] * x + WDIR[0][1] * z) * setFreq - tSec * 0.6;
  const setEnv = Math.max(0, 1 - setSwing * (1 - Math.sin(setPhase)));

  let dispY = 0;
  for (let k = 0; k < 7; k++) {
    const w = TWO_PI / WLEN[k];
    const a = WAMP[k] * (k < 2 ? setEnv : 1) * waveAmp;
    const ph = w * (WDIR[k][0] * x + WDIR[k][1] * z) + WSPD[k] * w * tSec;
    dispY += a * Math.sin(ph);
  }
  return dispY;
}
