/**
 * reef-water-tuning.ts — LIVE tuning singleton for the SURF ROAD water shader.
 *
 * DEV TOOL (preview-only). A single mutable object that the water shader
 * (`surf-ribbon.tsx`) and the bloom pass (`surf-bloom.tsx`) READ every frame, and
 * the tuner panel (`ReefWaterTunerPanel.tsx`) WRITES on slider/toggle change. This
 * lets the founder dial the water look live on the real Iris-Xe GPU and watch the
 * frame-time cost of each knob in the preview HUD — the instrument for the
 * "no visual downgrade in frame time" goal.
 *
 * ─── Why a module singleton, not React state / context ───────────────────────
 * The shader reads these in a `useFrame` loop. Threading them through React state
 * would re-render the Canvas subtree on every slider drag (jank, defeats the
 * purpose). Instead the panel mutates THIS object in place; the shader's useFrame
 * copies the current values into its uniforms each frame (≈8 scalar writes + a few
 * Color.copy — zero allocation, negligible cost). One source of truth, no churn.
 *
 * ─── DEFAULTS == the committed round-2 look ──────────────────────────────────
 * Every default below is the EXACT value shipped in `018f0898` (the founder-liked
 * round 2). All the `*Amt` knobs are ×1 multipliers folded into the shader, so a
 * fresh load with untouched sliders renders byte-identical to the committed shader.
 * Tuning only DEVIATES from the committed look; it never silently changes it.
 *
 * ─── "v1 baseline" ───────────────────────────────────────────────────────────
 * `applyV1Baseline()` zeroes every round-2 addition (caustics, spray, mist, set
 * envelope) and restores the v1 amplitude + the v1 cold palette, so the founder can
 * A/B the committed round 2 against the signed-off v1 and read the frame-time delta
 * directly. `resetToRound2()` restores the committed defaults.
 *
 * This module is imported ONLY by the preview render path + the tuner panel. The
 * production reef scene (`ReefRaceScene.tsx`) does not mount the panel; the shader
 * still reads the singleton, which stays at its committed defaults there (so prod
 * renders the committed look). Nothing here ships a behaviour change to prod.
 */

import * as THREE from 'three';

export interface WaterTuningScalars {
  /** Master Gerstner amplitude multiplier (heave height). 1 = committed (~245wu p2p). */
  waveAmp: number;
  /** Traveling "set" envelope strength. 1 = committed sets; 0 = uniform swell, no sets. */
  setStrength: number;
  /** Micro-normal detail-band intensity (fine sparkle between crests). 1 = committed. */
  microAmt: number;
  /** Caustic light-web intensity. 1 = committed; 0 = caustics OFF. */
  causticAmt: number;
  /** Crest-spray intensity off breaking tips. 1 = committed; 0 = spray OFF. */
  sprayAmt: number;
  /** Drifting-mist veil intensity. 1 = committed; 0 = mist OFF. */
  mistAmt: number;
  /** Whitecap/foam intensity. 1 = committed. */
  foamAmt: number;
  /** Sun glint + Blinn-spec sparkle intensity. 1 = committed. */
  sunIntensity: number;
  /** Bloom pass strength.   Committed BLOOM_STRENGTH. */
  bloomStrength: number;
  /** Bloom pass radius.      Committed BLOOM_RADIUS. */
  bloomRadius: number;
  /** Bloom pass luminance threshold. Committed BLOOM_THRESHOLD. */
  bloomThreshold: number;
}

export interface WaterTuningColors {
  colorDeep: THREE.Color;
  colorShallow: THREE.Color;
  colorFoam: THREE.Color;
  skyHorizon: THREE.Color;
  skyZenith: THREE.Color;
  sunColor: THREE.Color;
}

export type WaterTuning = WaterTuningScalars & WaterTuningColors;

// ─── Committed round-2 defaults (mirror surf-ribbon.tsx uniforms @ 018f0898) ──
const ROUND2_SCALARS: WaterTuningScalars = {
  waveAmp: 1,
  setStrength: 1,
  microAmt: 1,
  causticAmt: 1,
  sprayAmt: 1,
  mistAmt: 1,
  foamAmt: 1,
  sunIntensity: 1,
  bloomStrength: 0.75,   // BLOOM_STRENGTH
  bloomRadius: 0.45,     // BLOOM_RADIUS
  bloomThreshold: 0.8,   // BLOOM_THRESHOLD
};

const ROUND2_COLOR_HEX = {
  colorDeep: '#0a4f97',
  colorShallow: '#1ec4b2',
  colorFoam: '#dcf0f5',
  skyHorizon: '#4d7fb0',
  skyZenith: '#16386b',
  sunColor: '#ffe0b0',
} as const;

// v1 (founder-signed, tag reef-water-v1-signed) palette + amplitude, for A/B.
const V1_COLOR_HEX = {
  colorDeep: '#04304f',
  colorShallow: '#117f93',
  colorFoam: '#cfeaf1',
  skyHorizon: '#3a4f78',
  skyZenith: '#101d3a',
  sunColor: '#ffd9a0',
} as const;
// v1 master amplitude relative to round 2: v1 p2p ~185 vs round2 ~245 ⇒ ~0.755.
const V1_WAVE_AMP = 0.755;

/** The live singleton. Mutated by the tuner panel; read by the shader + bloom. */
export const WATER_TUNING: WaterTuning = {
  ...ROUND2_SCALARS,
  colorDeep: new THREE.Color(ROUND2_COLOR_HEX.colorDeep),
  colorShallow: new THREE.Color(ROUND2_COLOR_HEX.colorShallow),
  colorFoam: new THREE.Color(ROUND2_COLOR_HEX.colorFoam),
  skyHorizon: new THREE.Color(ROUND2_COLOR_HEX.skyHorizon),
  skyZenith: new THREE.Color(ROUND2_COLOR_HEX.skyZenith),
  sunColor: new THREE.Color(ROUND2_COLOR_HEX.sunColor),
};

/** Restore the committed round-2 look (panel "Reset" button). */
export function resetToRound2(): void {
  Object.assign(WATER_TUNING, ROUND2_SCALARS);
  WATER_TUNING.colorDeep.set(ROUND2_COLOR_HEX.colorDeep);
  WATER_TUNING.colorShallow.set(ROUND2_COLOR_HEX.colorShallow);
  WATER_TUNING.colorFoam.set(ROUND2_COLOR_HEX.colorFoam);
  WATER_TUNING.skyHorizon.set(ROUND2_COLOR_HEX.skyHorizon);
  WATER_TUNING.skyZenith.set(ROUND2_COLOR_HEX.skyZenith);
  WATER_TUNING.sunColor.set(ROUND2_COLOR_HEX.sunColor);
}

/** Strip every round-2 addition → the signed-off v1 water, for a frame-time A/B. */
export function applyV1Baseline(): void {
  WATER_TUNING.waveAmp = V1_WAVE_AMP;
  WATER_TUNING.setStrength = 0;   // v1 had no traveling sets
  WATER_TUNING.causticAmt = 0;    // v1 had no caustics
  WATER_TUNING.sprayAmt = 0;      // v1 had no crest spray
  WATER_TUNING.mistAmt = 0;       // v1 had no drifting mist
  WATER_TUNING.microAmt = 1;      // micro-normal existed in v1
  WATER_TUNING.foamAmt = 1;       // foam existed in v1
  WATER_TUNING.sunIntensity = 1;
  // Bloom params unchanged (same composer config in v1).
  WATER_TUNING.colorDeep.set(V1_COLOR_HEX.colorDeep);
  WATER_TUNING.colorShallow.set(V1_COLOR_HEX.colorShallow);
  WATER_TUNING.colorFoam.set(V1_COLOR_HEX.colorFoam);
  WATER_TUNING.skyHorizon.set(V1_COLOR_HEX.skyHorizon);
  WATER_TUNING.skyZenith.set(V1_COLOR_HEX.skyZenith);
  WATER_TUNING.sunColor.set(V1_COLOR_HEX.sunColor);
}

/** Snapshot the current tuning as a copy-pasteable summary (panel "Copy values"). */
export function snapshotTuning(): string {
  const t = WATER_TUNING;
  const f = (n: number) => Number(n.toFixed(3));
  return JSON.stringify(
    {
      waveAmp: f(t.waveAmp),
      setStrength: f(t.setStrength),
      microAmt: f(t.microAmt),
      causticAmt: f(t.causticAmt),
      sprayAmt: f(t.sprayAmt),
      mistAmt: f(t.mistAmt),
      foamAmt: f(t.foamAmt),
      sunIntensity: f(t.sunIntensity),
      bloom: { strength: f(t.bloomStrength), radius: f(t.bloomRadius), threshold: f(t.bloomThreshold) },
      colors: {
        deep: '#' + t.colorDeep.getHexString(),
        shallow: '#' + t.colorShallow.getHexString(),
        foam: '#' + t.colorFoam.getHexString(),
        skyHorizon: '#' + t.skyHorizon.getHexString(),
        skyZenith: '#' + t.skyZenith.getHexString(),
        sun: '#' + t.sunColor.getHexString(),
      },
    },
    null,
    2,
  );
}
