'use client';

/**
 * river-scene.tsx — Low-poly stylized river atmosphere for Reef Race v2.
 *
 * Visual target: Kagelok "The River" Sketchfab aesthetic.
 *   Bright sunny sky, animated stylized cartoon water, sandy cream bank ribbons,
 *   green grass hills, low-poly trees / rocks / fences on the grass.
 *
 * Contains:
 *   A. GroundShader (REPLACED flat GroundPlane) — subdivided terrain with
 *      per-vertex noise displacement + multi-color fragment shader.
 *   B. Rocky canyon cliff banks (<RockyCliffs />) — real CC0 boulder GLBs tiled
 *      along the spline, merged into 2 draw calls (~58K tris, 3 vertical rows).
 *   C. Water ribbon (<WaterSurf />) — Wave Race 64-style depth gradient + Phong
 *      sun glint, soft white-cap foam, pulsing edge foam (water-surf.tsx).
 *   D. Sky dome (SphereGeometry + MeshBasicMaterial vertexColors)
 *   E. ScenerySpawner (low-poly prop GLBs ON THE GRASS, not in water)
 *   F. Finish-line gate (wooden arch at z~28000, Part 2A)
 *   G. Distance markers every 2000wu (Part 2B)
 *   H. Power-up boxes mid-river (Part 2C)
 *   I. <RacingKarts /> — 5 surfboard karts riding the spline (imported from racing-karts.tsx)
 *   J. Bridge prop (Part 2F)
 *
 * Iter-6 cascade (WATER_Y -40 → -200 — 200wu dramatic ravine):
 *   WATER_Y  = -200 (water surface, deep sunken canyon)
 *   GROUND_Y =   -1 (grass / terrain surface ≈ y=0)
 *   BRIDGE_H =   80 (bridge floor y=+80; clearance above water = 280wu — dramatic over-canyon)
 *   Rocky cliff banks authored to match: ground=0, water=-200, riverbed=-250.
 *
 * Iris Xe invariants:
 *   - ShaderMaterial ONLY on plain Mesh — NO InstancedMesh + ShaderMaterial
 *   - NO drei <Text> or <Billboard>
 *   - import from 'three' only (not 'three/webgpu')
 *   - All static geo/mat at module scope — zero per-frame GC
 *   - frustumCulled=false on all atmosphere meshes
 *   - matrixAutoUpdate=false on all static meshes
 *   - NO point lights — emissive only for power-up glow (budget: 1 hemi + 1 dir)
 *
 * Draw call budget (iter-5):
 *   1 ground + 1 rocky banks + 1 water ribbon + 1 dome + ≤6 scenery GLB types
 *   + 1 finish gate + 1 distance markers (instanced) + 6 power-up boxes
 *   + 5 kart meshes (<RacingKarts />) + 1 bridge = ≤24 draw calls (within 30-call budget)
 *
 * Tri count (iter-5):
 *   Ground terrain: 96×192×2 = 36 864 tris
 *   Water ribbon: 126 tris | Rocky banks: 1 264 tris (replaces 126-tri sand ribbon)
 *   Sky dome: ~512 tris | Scenery GLBs: ~37 030 tris (iter-10: 162 instances both sides)
 *   Gate+markers+bridge+powerups: ~800 tris | Karts: ~300 tris (5 × surfboard_1.glb)
 *   Total: ~76 896 tris — within ≤80k Iris Xe budget.
 *
 * Water Y placement (iter-5 — CANYON DEPTH):
 *   Ground / grass at y=0. River bed at y=-250.
 *   Water ribbon at y=-200 (WATER_Y, deep sunken canyon).
 *   Rocky banks bracket the canyon: ground→water→river-bed (cliffs authored to match).
 *   Ground plane at y=-1 (just below grass — no z-fight with terrain).
 */

import { Suspense, useRef, useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clientSpline } from './reef-race-spline-instance';
import { RockyCliffs } from './rocky-cliffs';
import { WaterSurf } from './water-surf';
import { RacingKarts } from './racing-karts';
import { Ramps } from './ramps';

// ─── Track layout constants ───────────────────────────────────────────────────
// Track runs z=[0,28000] (90s rebuild); slight overrun on each end for ground coverage.
const TRACK_LEN_Z    = 30000;
const TRACK_START_Z  = -500;
const TRACK_CENTER_Z = TRACK_START_Z + TRACK_LEN_Z / 2; // 14500

// ─── Ground shader terrain — spline-following ribbon (v2-wide-water) ─────────
// Two ribbons (left + right) swept along clientSpline following the river path.
// Each ribbon's inner edge sits at (halfWidth + GROUND_INNER_OFFSET) from the
// spline centerline.
//
// Non-overlap proof (v2-wide-water, halfWidths expanded to 800–1300wu):
//   max corridor halfWidth = 1300wu (lagoon/finish, track-layout v2)
//   new cliff LATERAL_BAND_MAX = 350wu
//   rock body half-width   ≈  173wu (3.85wu × SCALE_MAX=90 / 2)
//   → max rock outer edge  = 1300 + 350 + 173 = 1823wu from centerline
//
//   GROUND_INNER_OFFSET = 250wu — ground inner edge at lagoon = 1300+250 = 1550wu
//   1550 < 1823 → ground starts 273wu INSIDE the rock zone (rocks sit ON the grass).
//   This is the intended look (boulders resting on the bank), not a visual bug.
//   The critical invariant is that ground does NOT intrude into the water corridor:
//     ground inner 1550wu >> corridor halfWidth 1300wu — 250wu clearance ✓
//
//   Per-section water-clearance check (ground inner must > halfWidth):
//     Lagoon  hw=1300: ground inner 1550 — 250wu gap ✓
//     Kelp    hw=1200: ground inner 1450 — 250wu gap ✓
//     Shipwreck pinch hw≈500: ground inner 750 — 250wu gap ✓
//     Coral   hw=1200: ground inner 1450 — 250wu gap ✓
//
//   Result: GROUND_W 2500 (halved from 6000) + GROUND_INNER_OFFSET 250 (cut from 873)
//   makes water ~27–34% of the total cross-section vs the old 3.7% — water dominant.
//
// Tri budget:
//   RIBBON_SAMPLES=128, RIBBON_W_SEGS=64.
//   tris per side = 128 × 64 × 2 = 16 384. Both sides = 32 768 tris.
//
// Iris Xe safety: plain Mesh + existing _groundShaderMat (THREE.ShaderMaterial).
// NO InstancedMesh. matrixAutoUpdate=false. frustumCulled=false.
const GROUND_INNER_OFFSET = 250;  // wu from corridor edge to ribbon inner edge (tight bank)
const GROUND_W            = 2500; // ribbon width per side (wu) — halved for water-dominance
const GROUND_RIBBON_SAMPLES = 128; // longitudinal samples along spline (t-axis)
const GROUND_RIBBON_W_SEGS  = 64;  // lateral segments per ribbon
const GROUND_Y            = -1;   // slight Y below grass to avoid z-fight

// ─── Sky dome ────────────────────────────────────────────────────────────────
const DOME_RADIUS  = 28000;
const DOME_W_SEGS  = 32;
const DOME_H_SEGS  = 16;
const DOME_HORIZON = new THREE.Color('#cfe9ff');
const DOME_ZENITH  = new THREE.Color('#5ab8e8');

// ─── Water Y (must match water-surf.tsx + racing-karts.tsx + rocky-cliffs.tsx) ─
const WATER_Y        = -200; // option-C: deep canyon (200wu)

// DEV-mode assertion: rocky-cliffs.tsx + water-surf.tsx expect WATER_Y < 0; cliffs will render inverted otherwise.
if (process.env.NODE_ENV === 'development' && WATER_Y >= 0) {
  console.warn('[river-scene] RockyCliffs/WaterSurf expect WATER_Y < 0; cliffs may render inverted. Current WATER_Y:', WATER_Y);
}

// ─── Gameplay prop constants ──────────────────────────────────────────────────
// Part 2A: Finish-line gate
const GATE_POST_HALF_W = 1400; // half-width: spans wide lagoon corridor (halfWidth 1300 + 100wu margin)
const GATE_POST_W      = 40;
const GATE_POST_H      = 250;
const GATE_POST_D      = 60;
const GATE_BAR_H       = 30;
const GATE_BAR_D       = 40;
const GATE_Z           = 28200; // just past finish line CP21 z≈28000 (90s rebuild)

// Part 2B: Distance markers
const MARKER_SPACING   = 2000;  // wu between markers
const MARKER_X_OFFSET  = 1800;  // absolute +X world position — past wide lagoon corridor edge (lagoon hw=1300 + 250 margin = 1550; at slalom peaks where CL.x=+500, effective clearance from corridor edge = 1800-(500+1200) = 100wu, just outside)
const MARKER_POLE_W    = 4;
const MARKER_POLE_H    = 200;
const MARKER_FLAG_W    = 80;
const MARKER_FLAG_H    = 40;
const MARKER_COLORS    = [
  new THREE.Color('#ff4400'),  // red
  new THREE.Color('#44cc22'),  // green
  new THREE.Color('#2266ff'),  // blue
  new THREE.Color('#ffcc00'),  // yellow
  new THREE.Color('#ff22aa'),  // pink
  new THREE.Color('#22cccc'),  // teal
  new THREE.Color('#ff8800'),  // orange
  new THREE.Color('#aa44ff'),  // purple
  new THREE.Color('#ff4400'),  // red again
];

// Part 2C: Power-up boxes
const POWERUP_T_VALUES = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
const POWERUP_X_ALTS   = [150, -150, 150, -150, 150, -150]; // lateral offset alternating
const POWERUP_SIZE     = 30;
const POWERUP_BOB_AMP  = 5;
const POWERUP_BOB_FREQ = 2;

// Part 2F: Bridge
const BRIDGE_Z         = 8500; // mid-track z position (kelp zone, halfWidth ~1200 → corridor 2400wu)
const BRIDGE_W         = 2800; // wu span — covers wide kelp corridor (2400wu) + 400wu margin for bank props
const BRIDGE_H         = 80;   // option-C: deep canyon, bridge floor y=+80, clearance over water (-200) = 280wu
const BRIDGE_PLANK_H   = 30;   // plank thickness
const BRIDGE_SUPPORT_W = 30;

// (AnimatedKarts inline kart constants removed — see racing-karts.tsx)

// ─── Scenery spawning ────────────────────────────────────────────────────────
const SCENERY_PROP_PATHS = [
  '/models/reef-race/scenery/prop-tree-pine.glb',
  '/models/reef-race/scenery/prop-tree-leafy.glb',
  '/models/reef-race/scenery/prop-rock-1.glb',
  '/models/reef-race/scenery/prop-rock-2.glb',
  '/models/reef-race/scenery/prop-fence.glb',
  '/models/reef-race/scenery/prop-grass-tuft.glb',
] as const;

for (const path of SCENERY_PROP_PATHS) {
  try { useGLTF.preload(path); } catch { /* not yet available */ }
}

interface SpawnerDef {
  key: string;     // unique key for React (path+seed combo)
  path: string;
  tValues: number[];
  side: number;   // +1 = left, -1 = right
  xJitter: number; // wu from corridor edge (must be >= GROUND_INNER_OFFSET=250 to land on grass, v2-wide-water)
  scaleMin: number;
  scaleMax: number;
  seed: number;
}

function seededRand(seed: number) {
  let s = (seed * 1664525 + 1013904223) | 0;
  return {
    next(): number {
      s = ((s ^ (s << 13)) ^ (s >>> 17) ^ (s << 5)) | 0;
      return ((s >>> 0) / 0xffffffff);
    },
  };
}

/** Sample spline bank edge + xJitter for a prop spawn position.
 *  Props are placed at: centerline ± normal*(halfWidth + xJitter)
 *  so they are guaranteed to be BEYOND the water edge and onto the grass. */
function spawnPos(t: number, side: number, xJitter: number): THREE.Vector3 {
  const c  = clientSpline.centerlineAt(t);
  const n  = clientSpline.normalAt(t);
  const hw = clientSpline.widthAt(t);
  const dist = hw + xJitter;  // total lateral offset from centerline
  return new THREE.Vector3(
    c.x + n.x * dist * side,
    0,
    c.z + n.z * dist * side,
  );
}

// Spawner defs: xJitter is the extra lateral offset BEYOND the spline corridor halfWidth.
// Ground inner edge = halfWidth + GROUND_INNER_OFFSET (250wu, v2-wide-water).
// Props MUST have xJitter >= 250 to land on grass, not inside the cliff zone.
// Grass extends from halfWidth+250 to halfWidth+2750wu — target [300, 2700].
//
// Per-type notes:
//   Pine ~765 tris, Leafy ~724 tris, Rock-1/2 ~80 tris, Fence ~50 tris, Grass ~30 tris.
//   Both sides populated for visual balance (split tValues across two entries per type).
//
// Tri budget (scenery only): 22×765 + 20×724 + 28×80 + 36×50 + 56×30 ≈ 37,030 tris.
// Non-scenery geometry ≈ 39,866 tris (ground+water+sky+gate+markers+bridge+karts).
// Grand total ≈ 76,896 tris — within ≤80K Iris Xe budget.
//
// Instance count: 162 instances — within ≤250 budget.
const SPAWNER_DEFS: SpawnerDef[] = [
  // ── Pine trees — left side (near cliff edge, into grass)
  // Quaternius prop-tree-pine.glb has hidden compounding-scale node transforms.
  // Empirically scale 17 gave 3000-wu mountain trees. Tuned to 1.0-1.5 range.
  // xJitter rescaled for v2-wide-water grass band [250, 2750wu from corridor edge].
  {
    key: 'pine-L',
    path: '/models/reef-race/scenery/prop-tree-pine.glb',
    tValues: Array.from({ length: 11 }, (_, i) => (i + 0.3) / 11),
    side: 1, xJitter: 500, scaleMin: 1.0, scaleMax: 1.5, seed: 1,
  },
  // ── Pine trees — right side (deeper into grass, cross-side visual layering)
  {
    key: 'pine-R',
    path: '/models/reef-race/scenery/prop-tree-pine.glb',
    tValues: Array.from({ length: 11 }, (_, i) => (i + 0.65) / 11),
    side: -1, xJitter: 650, scaleMin: 0.9, scaleMax: 1.4, seed: 11,
  },
  // ── Leafy trees — right side
  // Same compounding-scale issue. Scale range 1.6-2.1 empirically safe.
  {
    key: 'leafy-R',
    path: '/models/reef-race/scenery/prop-tree-leafy.glb',
    tValues: Array.from({ length: 10 }, (_, i) => (i + 0.1) / 10),
    side: -1, xJitter: 850, scaleMin: 1.6, scaleMax: 2.1, seed: 2,
  },
  // ── Leafy trees — left side (creates depth-of-field of trees from both banks)
  {
    key: 'leafy-L',
    path: '/models/reef-race/scenery/prop-tree-leafy.glb',
    tValues: Array.from({ length: 10 }, (_, i) => (i + 0.55) / 10),
    side: 1, xJitter: 1000, scaleMin: 1.4, scaleMax: 1.9, seed: 22,
  },
  // ── Rocks — left bank (at the cliff/grass boundary)
  {
    key: 'rock1-L',
    path: '/models/reef-race/scenery/prop-rock-1.glb',
    tValues: Array.from({ length: 14 }, (_, i) => (i + 0.05) / 14),
    side: 1, xJitter: 350, scaleMin: 0.7, scaleMax: 1.3, seed: 3,
  },
  // ── Rocks — right bank (slightly further out)
  {
    key: 'rock2-R',
    path: '/models/reef-race/scenery/prop-rock-2.glb',
    tValues: Array.from({ length: 14 }, (_, i) => (i + 0.55) / 14),
    side: -1, xJitter: 500, scaleMin: 0.8, scaleMax: 1.4, seed: 4,
  },
  // ── Fences — left bank (right at the cliff/grass border — decorative line)
  {
    key: 'fence-L',
    path: '/models/reef-race/scenery/prop-fence.glb',
    tValues: Array.from({ length: 18 }, (_, i) => i / 18),
    side: 1, xJitter: 270, scaleMin: 1.0, scaleMax: 1.0, seed: 5,
  },
  // ── Fences — right bank
  {
    key: 'fence-R',
    path: '/models/reef-race/scenery/prop-fence.glb',
    tValues: Array.from({ length: 18 }, (_, i) => (i + 0.5) / 18),
    side: -1, xJitter: 280, scaleMin: 1.0, scaleMax: 1.0, seed: 55,
  },
  // ── Grass tufts — right bank (clustered near cliff edge, on grass)
  {
    key: 'grass-R',
    path: '/models/reef-race/scenery/prop-grass-tuft.glb',
    tValues: Array.from({ length: 28 }, (_, i) => (i + 0.15) / 28),
    side: -1, xJitter: 350, scaleMin: 0.8, scaleMax: 1.5, seed: 6,
  },
  // ── Grass tufts — left bank (denser second pass)
  {
    key: 'grass-L',
    path: '/models/reef-race/scenery/prop-grass-tuft.glb',
    tValues: Array.from({ length: 28 }, (_, i) => (i + 0.65) / 28),
    side: 1, xJitter: 400, scaleMin: 0.9, scaleMax: 1.6, seed: 66,
  },
];

// (Water ribbon geometry now lives in water-surf.tsx — module-scope, single source of truth)

// ─── Sky dome geometry ────────────────────────────────────────────────────────
function makeDomeGeo(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(DOME_RADIUS, DOME_W_SEGS, DOME_H_SEGS);
  const positions = geo.attributes.position!;
  const count = positions.count;
  const colorsArr = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const y = positions.getY(i);
    const tc = Math.max(0, Math.min(1, y / DOME_RADIUS * 0.5 + 0.5));
    const r = DOME_HORIZON.r + (DOME_ZENITH.r - DOME_HORIZON.r) * tc;
    const g = DOME_HORIZON.g + (DOME_ZENITH.g - DOME_HORIZON.g) * tc;
    const b = DOME_HORIZON.b + (DOME_ZENITH.b - DOME_HORIZON.b) * tc;
    colorsArr[i * 3 + 0] = r;
    colorsArr[i * 3 + 1] = g;
    colorsArr[i * 3 + 2] = b;
  }

  geo.setAttribute('color', new THREE.Float32BufferAttribute(colorsArr, 3));
  return geo;
}

// ─── Ground terrain ShaderMaterial ───────────────────────────────────────────
//
// Vertex: inline value-noise for Y displacement. River corridor guard:
//   distFromRiverCenter = |position.x| (acceptable approximation for spline
//   that stays within ±200wu of x=0). displacementMask attenuates hills to
//   zero within 700wu of x=0 so they never poke through the water ribbon.
//
// Fragment: two grass tones + dirt patches via multi-octave noise, with a
//   slight lighter highlight at the very edge of the displacement falloff
//   to suggest a grassy berm.
//
const _groundVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying float vDisp;
  varying float vRiverMask;

  // Simple value noise for Y displacement
  float hashF(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep
    float a = hashF(i);
    float b = hashF(i + vec2(1.0, 0.0));
    float c = hashF(i + vec2(0.0, 1.0));
    float d = hashF(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    vUv = uv;

    // 2026-04-29 iter-7c: no riverMask needed — strips are fully outside corridor.
    float riverMask = 1.0;
    vRiverMask = riverMask;

    // 2026-04-29 iter-9 FIX: sample noise in UV space (u=lateral [0,1], v=spline-t [0,1])
    // NOT in world-space position.xz.
    //
    // WHY: The ribbon vertices live at 4000-10000wu from the spline centerline in
    // world XZ. Sampling position.xz directly caused two problems:
    //   1. Non-uniform noise density — the outer edge of the ribbon covers 2.4× more
    //      world-XZ per t-step than the inner edge on curved sections, stretching noise
    //      features unevenly and creating sharp transitions that look like zigzag/sawtooth
    //      from the top-down camera at altitude 23770wu.
    //   2. The old ±50wu amplitude equals 54% of the lateral vertex step (93wu), making
    //      adjacent displaced vertices form near-90° angles — which renders as shark-teeth
    //      rather than smooth rolling hills when viewed from high altitude.
    //
    // UV sampling gives uniform parameterisation regardless of spline curvature.
    // uv.x = lateral frac [0,1] (inner→outer), uv.y = spline t [0,1] (start→finish).
    // Scaled to produce ~6 noise hills laterally and ~14 along the track.
    vec2 uvScale1 = vec2(6.0, 14.0);
    vec2 uvScale2 = vec2(14.0, 30.0);
    float n1 = valueNoise(uv * uvScale1) * 2.0 - 1.0;
    float n2 = valueNoise(uv * uvScale2) * 0.5 - 0.25;
    // Amplitude capped to ±12wu — safe for 93wu lateral step from altitude 23770wu.
    // Old ±50wu was the root cause of the sawtooth appearance.
    float noiseVal = (n1 + n2) * 12.0 * riverMask;

    vDisp = noiseVal;

    vec3 displaced = position;
    displaced.y += noiseVal;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const _groundFragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying float vDisp;
  varying float vRiverMask;

  float hashF(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hashF(i);
    float b = hashF(i + vec2(1.0, 0.0));
    float c = hashF(i + vec2(0.0, 1.0));
    float d = hashF(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    // Grass colours
    vec3 grassLight = vec3(0.545, 0.784, 0.282); // #8bc848
    vec3 grassDark  = vec3(0.369, 0.620, 0.180); // #5e9e2e
    vec3 dirtSandy  = vec3(0.773, 0.647, 0.447); // #c5a572

    // UV in world-like scale for noise sampling (vUv is 0→1 on the 12000×24000 plane)
    vec2 wUv = vUv * vec2(12.0, 24.0); // roughly 1 unit = 1000wu

    float nPatch  = valueNoise(wUv * 1.2);          // large colour patches
    float nDetail = valueNoise(wUv * 4.0) * 0.5;    // fine grass variation
    float nDirt   = valueNoise(wUv * 0.6 + 7.3);    // low-freq dirt patches

    // Blend grass light ↔ dark via noise
    float grassBlend = clamp(nPatch + nDetail, 0.0, 1.0);
    vec3 baseGrass = mix(grassDark, grassLight, grassBlend);

    // Add dirt patches where nDirt > 0.65
    float dirtMix = smoothstep(0.65, 0.75, nDirt);
    vec3 groundColor = mix(baseGrass, dirtSandy, dirtMix * 0.6);

    // Slight berm highlight: near the river mask transition, brighten grass
    // to give a raised-levee feel at the bank edge.
    float bermHighlight = smoothstep(0.0, 0.2, vRiverMask) *
                          (1.0 - smoothstep(0.2, 0.5, vRiverMask));
    groundColor = mix(groundColor, grassLight * 1.2, bermHighlight * 0.4);

    // Displacement-based darkening: lower spots (shadow pools)
    // Normalizer matches vertex shader amplitude cap (±12wu, was ±50wu).
    float dispNorm = clamp(vDisp / 12.0, -1.0, 1.0);
    groundColor *= 1.0 + dispNorm * 0.08;

    gl_FragColor = vec4(groundColor, 1.0);
  }
`;

// Shared ground terrain material — module scope, no uniforms to update per-frame
const _groundShaderMat = new THREE.ShaderMaterial({
  vertexShader:   _groundVertexShader,
  fragmentShader: _groundFragmentShader,
  side:   THREE.FrontSide,
  fog:    true,
});

// (Animated water ShaderMaterial moved to water-surf.tsx — see <WaterSurf /> below.
//  The new shader uses depth-gradient + Phong sun glint inspired by Wave Race 64,
//  identified as a significant upgrade vs the inline vignette+stripes approach.)

// ─── Power-up box material (module scope) ────────────────────────────────────
// Emissive gold — no point lights (Iris Xe budget constraint)
const _powerupMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#ffd700'),
  emissive: new THREE.Color('#ffaa00'),
  emissiveIntensity: 0.6,
  metalness: 0.3,
  roughness: 0.4,
  fog: false,
});

// ─── Finish gate material ─────────────────────────────────────────────────────
const _gateMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#8B4513'),   // wooden brown
  roughness: 0.9,
  metalness: 0.0,
  fog: false,
});

// ─── Checker flag canvas texture (for finish gate) ───────────────────────────
function makeCheckerTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const cols = 8;
  const rows = 4;
  const cellW = canvas.width  / cols;
  const cellH = canvas.height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#ffffff' : '#000000';
      ctx.fillRect(c * cellW, r * cellH, cellW, cellH);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

// ─── Distance marker material (instanced flag colors set per mesh) ────────────
const _poleMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#c8a050'),
  roughness: 0.8,
  metalness: 0.1,
  fog: true,
});

// ─── Bridge material ───────────────────────────────────────────────────────────
const _bridgeMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#9b7040'),   // weathered wood
  roughness: 0.9,
  metalness: 0.0,
  fog: false,
});

// (Kart BoxGeometry + MeshStandardMaterial removed — see racing-karts.tsx)

// ─── Ground ribbon geometry builder ──────────────────────────────────────────
/**
 * buildGroundRibbonGeo — sweeps a ground strip along clientSpline.
 *
 * @param side       +1 = left of travel (CCW normal direction), -1 = right
 * @param samples    number of cross-section planes along the spline [0,1]
 * @param widthSegs  lateral subdivisions within each cross-section pair
 *
 * For each t-sample the cross-section row has (widthSegs+1) vertices:
 *   lateral t_i = (i / widthSegs)
 *   lateral distance from centerline = hw + GROUND_INNER_OFFSET + t_i * GROUND_W
 * where hw = clientSpline.widthAt(t) varies per sample.
 *
 * Triangle strip winds pairs of adjacent rows into quads, each split into 2 tris.
 *
 * Winding order differs by side — cross-product analysis determines the correct order:
 *
 * Left ribbon (side=+1): spline normal n.x < 0 (points west), so vertex b is WEST of a.
 *   v1 = b - a = (-widthStep, 0, 0)
 *   v2 = c - a = (0, 0, +Δz)
 *   v1 × v2 = (0·Δz - 0·0, 0·0 - (-widthStep)·Δz, (-widthStep)·0 - 0·0)
 *           = (0, +widthStep·Δz, 0)  → +Y normal ✓
 *   So tri1 = (a, b, c), tri2 = (b, d, c).
 *
 * Right ribbon (side=−1): spline normal n.x > 0 (points east), so vertex b is EAST of a.
 *   v1 = c - a = (0, 0, +Δz)
 *   v2 = b - a = (+widthStep, 0, 0)
 *   v1 × v2 = (0·0 - Δz·0, Δz·widthStep - 0·0, 0·0 - 0·widthStep)
 *   Wait — use opposite order for the fix: tri = (a, c, b):
 *   v1 = c - a = (0, 0, +Δz), v2 = b - a = (+widthStep, 0, 0)
 *   v1 × v2 y = Δz·widthStep > 0 → +Y ✓   (a, c, b) correct for right ribbon.
 *   So tri1 = (a, c, b), tri2 = (b, c, d).
 *
 * NOTE: the two branches are SWAPPED relative to what naive "mirror winding" logic suggests.
 * The previous code had them backwards, causing backface culling to hide both ribbons.
 */
function buildGroundRibbonGeo(
  side: 1 | -1,
  samples: number,
  widthSegs: number,
): THREE.BufferGeometry {
  const rows     = samples + 1; // t-axis sample count (including t=1)
  const cols     = widthSegs + 1; // lateral vertex count per row
  const vtxCount = rows * cols;

  const positions = new Float32Array(vtxCount * 3);
  const normals   = new Float32Array(vtxCount * 3);
  const uvs       = new Float32Array(vtxCount * 2);

  // Build vertex grid
  for (let r = 0; r < rows; r++) {
    const t  = r / (rows - 1); // [0, 1]
    const c  = clientSpline.centerlineAt(t);
    const n  = clientSpline.normalAt(t);
    const hw = clientSpline.widthAt(t);
    const innerLateral = hw + GROUND_INNER_OFFSET;

    for (let col = 0; col < cols; col++) {
      const lateralFrac = col / widthSegs; // [0, 1] across ribbon width
      const totalLateral = innerLateral + lateralFrac * GROUND_W;

      const wx = c.x + n.x * totalLateral * side;
      const wz = c.z + n.z * totalLateral * side;

      const idx = r * cols + col;
      positions[idx * 3 + 0] = wx;
      positions[idx * 3 + 1] = GROUND_Y;
      positions[idx * 3 + 2] = wz;

      // Normal always +Y for horizontal ground
      normals[idx * 3 + 0] = 0;
      normals[idx * 3 + 1] = 1;
      normals[idx * 3 + 2] = 0;

      // UV: u across lateral width [0,1], v along spline [0,1]
      uvs[idx * 2 + 0] = lateralFrac;
      uvs[idx * 2 + 1] = t;
    }
  }

  // Build index buffer — two triangles per quad between adjacent rows.
  // Cross-product analysis (see JSDoc above) shows:
  //   side=+1 (left):  vertices extend in -X → tri1=(a,b,c), tri2=(b,d,c) for +Y normal
  //   side=-1 (right): vertices extend in +X → tri1=(a,c,b), tri2=(b,c,d) for +Y normal
  // These look like a swap vs. naive mirroring — that's intentional and mathematically correct.
  const quadCount = (rows - 1) * widthSegs;
  const indices   = new Uint32Array(quadCount * 6);
  let   idxPtr    = 0;

  for (let r = 0; r < rows - 1; r++) {
    for (let col = 0; col < widthSegs; col++) {
      const a = r       * cols + col;
      const b = r       * cols + col + 1;
      const c = (r + 1) * cols + col;
      const d = (r + 1) * cols + col + 1;

      if (side === 1) {
        // Left ribbon — vertices extend in -X direction (n.x < 0 for straight spline)
        // (a,b,c): v1=b-a=(-Δx,0,0), v2=c-a=(0,0,+Δz) → cross.y = +Δx·Δz > 0 → +Y ✓
        indices[idxPtr++] = a;
        indices[idxPtr++] = b;
        indices[idxPtr++] = c;
        indices[idxPtr++] = b;
        indices[idxPtr++] = d;
        indices[idxPtr++] = c;
      } else {
        // Right ribbon — vertices extend in +X direction (n.x > 0 for straight spline)
        // (a,c,b): v1=c-a=(0,0,+Δz), v2=b-a=(+Δx,0,0) → cross.y = +Δz·Δx > 0 → +Y ✓
        indices[idxPtr++] = a;
        indices[idxPtr++] = c;
        indices[idxPtr++] = b;
        indices[idxPtr++] = b;
        indices[idxPtr++] = c;
        indices[idxPtr++] = d;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,       2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

// ─── Module-scope geometries (baked at module load, shared forever) ───────────
// (water ribbon geo lives in water-surf.tsx)
const _domeGeo = makeDomeGeo();

// Spline-following ground ribbons — built once at module load.
// Left (+1) and right (-1) sides. Each = 128 × 64 × 2 = 16 384 tris.
// Combined = 32 768 tris (target: ~32k, within ≤80k budget).
const _groundGeoLeft  = buildGroundRibbonGeo( 1, GROUND_RIBBON_SAMPLES, GROUND_RIBBON_W_SEGS);
const _groundGeoRight = buildGroundRibbonGeo(-1, GROUND_RIBBON_SAMPLES, GROUND_RIBBON_W_SEGS);

// Part 2A: finish gate geometry
function buildFinishGateGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Left post
  const leftPost = new THREE.BoxGeometry(GATE_POST_W, GATE_POST_H, GATE_POST_D);
  leftPost.translate(-GATE_POST_HALF_W, GATE_POST_H / 2, GATE_Z);
  parts.push(leftPost);

  // Right post
  const rightPost = new THREE.BoxGeometry(GATE_POST_W, GATE_POST_H, GATE_POST_D);
  rightPost.translate(GATE_POST_HALF_W, GATE_POST_H / 2, GATE_Z);
  parts.push(rightPost);

  // Top bar spanning posts
  const barW = GATE_POST_HALF_W * 2 + GATE_POST_W;
  const topBar = new THREE.BoxGeometry(barW, GATE_BAR_H, GATE_BAR_D);
  topBar.translate(0, GATE_POST_H + GATE_BAR_H / 2, GATE_Z);
  parts.push(topBar);

  // Merge
  const merged = mergeGeometries(parts, false)!;
  parts.forEach(g => g.dispose());
  return merged;
}

// Part 2C: power-up box geometry (single 30wu cube — shared)
const _powerupBoxGeo = new THREE.BoxGeometry(POWERUP_SIZE, POWERUP_SIZE, POWERUP_SIZE);

// Part 2B: distance marker pole + flag (single shared geo, cloned per marker)
const _markerPoleGeo  = new THREE.BoxGeometry(MARKER_POLE_W, MARKER_POLE_H, MARKER_POLE_W);
const _markerFlagGeo  = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(MARKER_FLAG_W, 0, 0),
  new THREE.Vector3(0, -MARKER_FLAG_H, 0),
]);
_markerFlagGeo.setIndex([0, 1, 2]);
_markerFlagGeo.computeVertexNormals();

// Part 2F: bridge geometry
function buildBridgeGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Main plank
  const plank = new THREE.BoxGeometry(BRIDGE_W, BRIDGE_PLANK_H, 120);
  plank.translate(0, BRIDGE_H + BRIDGE_PLANK_H / 2, BRIDGE_Z);
  parts.push(plank);

  // Left support
  const ls = new THREE.BoxGeometry(BRIDGE_SUPPORT_W, BRIDGE_H, BRIDGE_SUPPORT_W);
  ls.translate(-BRIDGE_W / 2 + BRIDGE_SUPPORT_W, BRIDGE_H / 2, BRIDGE_Z);
  parts.push(ls);

  // Right support
  const rs = new THREE.BoxGeometry(BRIDGE_SUPPORT_W, BRIDGE_H, BRIDGE_SUPPORT_W);
  rs.translate(BRIDGE_W / 2 - BRIDGE_SUPPORT_W, BRIDGE_H / 2, BRIDGE_Z);
  parts.push(rs);

  const merged = mergeGeometries(parts, false)!;
  parts.forEach(g => g.dispose());
  return merged;
}

// ─── Module-scope materials (page-lifetime, never disposed) ──────────────────

/** Sky dome material — vertex colors, BackSide, no fog. */
const _domeMat = new THREE.MeshBasicMaterial({
  vertexColors: true,
  side: THREE.BackSide,
  fog: false,
  depthWrite: false,
});

// (Kart t-state removed — racing-karts.tsx owns its own _kartT)

// ─── Ground terrain shader component ─────────────────────────────────────────

function GroundShader() {
  // Two spline-following ribbon strips bracketing the canyon (left + right of spline).
  // Geometry is baked at module scope — no props, no position offset needed
  // (vertices are in world XZ, built directly from clientSpline samples).
  return (
    <>
      <mesh
        geometry={_groundGeoLeft}
        material={_groundShaderMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
        receiveShadow
        renderOrder={0}
      />
      <mesh
        geometry={_groundGeoRight}
        material={_groundShaderMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
        receiveShadow
        renderOrder={0}
      />
    </>
  );
}

// (WaterRibbon component moved to water-surf.tsx as <WaterSurf />.)

// ─── Sky dome component ───────────────────────────────────────────────────────

function SkyDome() {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    m.position.set(0, 0, TRACK_CENTER_Z);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      geometry={_domeGeo}
      material={_domeMat}
      frustumCulled={false}
      matrixAutoUpdate={false}
      renderOrder={-1}
    />
  );
}

// ─── Individual scenery prop component — InstancedMesh per prop type ─────────
//
// PERF FIX (2026-04-29): Previously each instance was a full scene.clone(true) added
// to a Group — one draw call per instance (16+14+10+10+24+30 = 104 draw calls total).
// Now: one InstancedMesh per SpawnerDef = 1 draw call per prop type.
// 6 prop types × 1 draw call = 6 draw calls (was 104).
//
// Iris Xe gotcha: InstancedMesh + ShaderMaterial = silent WebGPU crash (no console output).
// Guard: extract material from GLB, replace any ShaderMaterial with MeshStandardMaterial.
// Quaternius CC0 assets use MeshStandardMaterial so this is a safety net only.

interface PropInstancesProps {
  def: SpawnerDef;
}

// Scratch objects reused across instances to avoid per-frame allocation
const _dummy   = new THREE.Object3D();

function PropInstances({ def }: PropInstancesProps) {
  const { scene: srcScene } = useGLTF(def.path);
  // groupRef declared FIRST — useEffect closes over it
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    if (!srcScene) return;
    const gr = groupRef.current;
    if (!gr) return;

    // ── 1. Extract first Mesh from the GLB scene ────────────────────────────
    //    Quaternius props are single-mesh GLBs. We take the first Mesh child.
    let srcMesh: THREE.Mesh | null = null;
    srcScene.traverse((child) => {
      if (!srcMesh && child instanceof THREE.Mesh && child.geometry) {
        srcMesh = child as THREE.Mesh;
      }
    });
    if (!srcMesh) return;

    const geo = (srcMesh as THREE.Mesh).geometry;

    // ── 2. Safe material — replace ShaderMaterial to avoid Iris Xe crash ───
    //    InstancedMesh + ShaderMaterial = silent WebGPU crash (gotcha documented).
    //    Quaternius assets use MeshStandardMaterial, so this path is a safety net.
    const srcMat = Array.isArray((srcMesh as THREE.Mesh).material)
      ? ((srcMesh as THREE.Mesh).material as THREE.Material[])[0]!
      : ((srcMesh as THREE.Mesh).material as THREE.Material);

    const needsFallbackMat =
      srcMat instanceof THREE.ShaderMaterial ||
      srcMat instanceof THREE.RawShaderMaterial;

    const safeMat: THREE.Material = needsFallbackMat
      ? new THREE.MeshStandardMaterial({
          color: new THREE.Color('#7a9c55'), // neutral green — acceptable fallback
          roughness: 0.8,
          metalness: 0.0,
        })
      : srcMat;

    // ── 3. Build InstancedMesh with N = tValues.length instances ───────────
    const count = def.tValues.length;
    const im = new THREE.InstancedMesh(geo, safeMat, count);
    // frustumCulled=true (default): Three.js computes per-IM bounding-box cull.
    // Chase cam is always near the track so most props will be in frustum anyway.
    im.castShadow    = false; // Props are small — skip shadow cost on Iris Xe
    im.receiveShadow = false;

    const rng = seededRand(def.seed);
    def.tValues.forEach((t, i) => {
      const jitter = def.xJitter + rng.next() * 60 - 30;
      const pos    = spawnPos(t, def.side, jitter);
      const yRot   = rng.next() * Math.PI * 2;
      const scale  = def.scaleMin + rng.next() * (def.scaleMax - def.scaleMin);

      _dummy.position.copy(pos);
      _dummy.rotation.set(0, yRot, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      im.setMatrixAt(i, _dummy.matrix);
    });

    im.instanceMatrix.needsUpdate = true;
    im.matrixAutoUpdate = false;
    im.updateMatrix();

    gr.add(im);

    return () => {
      gr.remove(im);
      // Only dispose the fallback material — GLB's own material belongs to the cache
      if (needsFallbackMat) {
        safeMat.dispose();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcScene]);

  return <group ref={groupRef} />;
}

// ─── Scenery spawner ──────────────────────────────────────────────────────────

function ScenerySpawner() {
  return (
    <>
      {SPAWNER_DEFS.map((def) => (
        <Suspense key={def.key} fallback={null}>
          <PropInstances def={def} />
        </Suspense>
      ))}
    </>
  );
}

// ─── Part 2A: Finish-line gate ────────────────────────────────────────────────
// Wooden arch over the river at GATE_Z with procedural checkered flag.

function FinishGate() {
  const gateGeo = useMemo(() => buildFinishGateGeo(), []);
  const checkerTex = useMemo(() => {
    if (typeof document === 'undefined') return null;
    return makeCheckerTexture();
  }, []);

  // Checker flag plane between the posts
  const flagMat = useMemo(() => new THREE.MeshBasicMaterial({
    map: checkerTex,
    side: THREE.DoubleSide,
    fog: false,
    transparent: false,
  }), [checkerTex]);

  const flagGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(GATE_POST_HALF_W * 2, GATE_POST_H * 0.6);
    // Stand the flag plane vertically (PlaneGeometry is XY by default)
    geo.translate(0, GATE_POST_H * 0.7, GATE_Z);
    return geo;
  }, []);

  const meshRef = useRef<THREE.Mesh>(null);
  const flagRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    [meshRef.current, flagRef.current].forEach(m => {
      if (m) { m.matrixAutoUpdate = false; m.updateMatrix(); }
    });
    return () => {
      gateGeo.dispose();
      flagGeo.dispose();
      checkerTex?.dispose();
      flagMat.dispose();
    };
  }, [gateGeo, flagGeo, checkerTex, flagMat]);

  return (
    <group>
      <mesh ref={meshRef} geometry={gateGeo} material={_gateMat} castShadow matrixAutoUpdate={false} />
      {checkerTex && (
        <mesh ref={flagRef} geometry={flagGeo} material={flagMat} matrixAutoUpdate={false} />
      )}
    </group>
  );
}

// ─── Part 2B: Distance markers ────────────────────────────────────────────────
// Small flag-on-pole at z = 2000, 4000, ..., 28000, placed at x=+MARKER_X_OFFSET.
// Gentle flag sway animation.

const _markerCount = Math.floor(28000 / MARKER_SPACING); // 14 markers (90s rebuild)

function DistanceMarkers() {
  // Each marker: pole + flag — all placed via useEffect for perf
  const groupRef = useRef<THREE.Group>(null);

  // Store flag meshes for animation
  const flagRefs = useRef<THREE.Mesh[]>([]);

  useEffect(() => {
    const gr = groupRef.current;
    if (!gr) return;
    flagRefs.current = [];

    for (let i = 0; i < _markerCount; i++) {
      const z = (i + 1) * MARKER_SPACING;
      const x = MARKER_X_OFFSET;
      const color = MARKER_COLORS[i % MARKER_COLORS.length]!;

      // Pole
      const poleMesh = new THREE.Mesh(_markerPoleGeo, _poleMat);
      poleMesh.position.set(x, MARKER_POLE_H / 2, z);
      poleMesh.matrixAutoUpdate = false;
      poleMesh.updateMatrix();
      gr.add(poleMesh);

      // Flag — individual material per flag for color variety
      const flagMat = new THREE.MeshStandardMaterial({
        color,
        side: THREE.DoubleSide,
        fog: true,
        roughness: 0.8,
        metalness: 0.0,
      });
      const flagMesh = new THREE.Mesh(_markerFlagGeo, flagMat);
      // Position: top of pole, +X direction (flag hangs to the right of pole)
      flagMesh.position.set(x + MARKER_POLE_W / 2, MARKER_POLE_H, z);
      gr.add(flagMesh);
      flagRefs.current.push(flagMesh);
    }

    return () => {
      // Clean up individual flag materials
      flagRefs.current.forEach(m => {
        if ((m.material as THREE.Material).dispose) {
          (m.material as THREE.Material).dispose();
        }
      });
      while (gr.children.length > 0) gr.remove(gr.children[0]);
    };
  }, []);

  // Gentle flag sway
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    flagRefs.current.forEach((flag, i) => {
      flag.rotation.y = Math.sin(t * 1.5 + i * 0.7) * 0.15;
    });
  });

  return <group ref={groupRef} />;
}

// ─── Part 2C: Power-up boxes ──────────────────────────────────────────────────
// Glowing rotating golden cubes hovering above water mid-river.
// NO point lights — emissive material only (Iris Xe budget).
//
// Positions are computed once at module scope (spline is available at load time).
const _powerupBasePositions = POWERUP_T_VALUES.map((t, i) => {
  const c  = clientSpline.centerlineAt(t);
  const n  = clientSpline.normalAt(t);
  const lat = POWERUP_X_ALTS[i] ?? 150;
  return new THREE.Vector3(
    c.x + n.x * lat,
    WATER_Y + POWERUP_SIZE / 2 + 30,
    c.z + n.z * lat,
  );
});

function PowerUpBoxes() {
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);

  // Rotation + bobbing
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    meshRefs.current.forEach((mesh, i) => {
      if (!mesh) return;
      const base = _powerupBasePositions[i]!;
      mesh.position.set(
        base.x,
        base.y + Math.sin(t * POWERUP_BOB_FREQ + i) * POWERUP_BOB_AMP,
        base.z,
      );
      mesh.rotation.y += 0.02;
    });
  });

  return (
    <>
      {POWERUP_T_VALUES.map((_, i) => (
        <mesh
          key={i}
          ref={(el) => { meshRefs.current[i] = el; }}
          geometry={_powerupBoxGeo}
          material={_powerupMat}
          castShadow
          position={[
            _powerupBasePositions[i]!.x,
            _powerupBasePositions[i]!.y,
            _powerupBasePositions[i]!.z,
          ]}
        />
      ))}
    </>
  );
}

// (AnimatedKarts function removed — replaced by <RacingKarts /> from racing-karts.tsx)

// ─── Part 2F: Bridge prop ─────────────────────────────────────────────────────
// Wooden plank bridge over the river at z=BRIDGE_Z.

function Bridge() {
  const bridgeGeo = useMemo(() => buildBridgeGeo(), []);
  const meshRef   = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const m = meshRef.current;
    if (m) { m.matrixAutoUpdate = false; m.updateMatrix(); }
    return () => { bridgeGeo.dispose(); };
  }, [bridgeGeo]);

  return (
    <mesh
      ref={meshRef}
      geometry={bridgeGeo}
      material={_bridgeMat}
      castShadow
      receiveShadow
      matrixAutoUpdate={false}
    />
  );
}

// ─── Public composite component ───────────────────────────────────────────────

/**
 * RiverScene — drop-in atmosphere block for Reef Race v2.
 *
 * Wire into any R3F Canvas that uses the v2 spline track:
 *   - /preview/reef-race-v2: placed inside <SceneContents>
 *   - ReefRaceScene.tsx: placed inside production <SceneContents>
 *
 * Does NOT include lighting, fog, or track geometry — those are managed by
 * the parent scene. The parent SHOULD:
 *   - Use fog color '#a8d8ff' (sky-blue) not the old deep-navy '#061525'
 *   - Use <color attach="background" args={['#a8d8ff']} /> to match horizon
 *   - HEMI_GROUND_COLOR: '#7cb342' grass green (matches ground plane)
 *
 * Renders (render order):
 *   -1: Sky dome (sunny blue gradient, BackSide sphere)
 *    0: Terrain shader ground (subdivided, rolling hills outside river corridor)
 *    1: Rocky cliff banks (canyon walls, 1264 tris, 1 draw call)
 *    2: Animated water ribbon (simplex noise + bank-edge foam, WATER_Y=-200)
 *    ?: Scenery props along banks (Quaternius CC0 trees at visible scale)
 *    ?: Gameplay juice: finish gate, distance markers, power-ups, <RacingKarts />, bridge
 *
 * Bank wall geometry from SplineTrack (buildSplineBankGeos) is intentionally
 * hidden by the parent page — set visible=false or recolor to grass green.
 * See page.tsx: _bankMat color is '#7cb342' grass green to blend with ground.
 *
 * WATER SHADER (iter-7+, see water-surf.tsx):
 *   Wave Race 64 depth gradient + Phong sun glint + iter-9 vertex Y heave (±8wu)
 *   + iter-9 organic-cluster soft white-caps + iter-4 dual-layer bank turbulence.
 *   Drei `shaderMaterial()` factory + `extend()`. Iris Xe safe (plain Mesh).
 *   Water surface at WATER_Y=-200 (200wu deep ravine).
 *
 * GROUND SHADER (v2-wide-water, spline-following ribbon — tight framing band):
 *   THREE.ShaderMaterial on TWO plain Meshes (one per side, sign ±1).
 *   Geometry = `buildGroundRibbonGeo` — 128 spline samples × 64 width-segments
 *   per side, ~32k tris total. Each ribbon cross-section sweeps along the spline
 *   at lateral `hw + 250wu` (tight cliff-rim buffer, v2-wide-water)
 *   outward to `+ GROUND_W (2500wu)` — narrow framing band, water is the hero.
 *   Vertex: value-noise Y displacement (mask removed; geometry is always outside corridor).
 *   Fragment: 3-tone grass+dirt blending with berm highlight.
 *
 * KARTS (iter-6): <RacingKarts /> imported from racing-karts.tsx and wired here.
 *   racing-karts.tsx WATER_Y cascade is complete — value is -200 (confirmed iter-6).
 */
/**
 * @param showDemoKarts - Defaults to true (preview route). Real gameplay should
 *   pass `false` so the 5 decorative spline karts don't compete visually with
 *   the player + bot karts driven by the server sim. PowerUpBoxes are also
 *   hidden in gameplay because <ReefRacePickups /> renders the server-spawned
 *   power-up state — the static decorative boxes would double-render alongside.
 */
export function RiverScene({
  showDemoKarts = true,
  showDemoPickups = true,
}: { showDemoKarts?: boolean; showDemoPickups?: boolean } = {}) {
  return (
    <>
      {/* -1: Sky dome — renders behind everything */}
      <SkyDome />

      {/* 0: Terrain shader ground — subdivided rolling hills */}
      <GroundShader />

      {/* 1: Rocky canyon cliff banks — real CC0 boulder GLBs tiled along spline (~58K tris, 2 draw calls) */}
      <RockyCliffs />

      {/* 2: Animated water — Wave Race 64-style depth gradient + Phong sun glint (water-surf.tsx) */}
      <WaterSurf />

      {/* Scenery props on the grass */}
      <ScenerySpawner />

      {/* Gameplay juice — Part 2A: Finish-line gate */}
      <FinishGate />

      {/* Gameplay juice — Part 2B: Distance markers every 2000wu */}
      <DistanceMarkers />

      {/* Gameplay juice — Part 2C: Power-up boxes mid-river. Hidden in gameplay
          because <ReefRacePickups /> renders server-authoritative power-up state. */}
      {showDemoPickups && <PowerUpBoxes />}

      {/* 5 surfboard karts animated along the spline. Hidden in gameplay because
          the player + 3 bots are rendered separately by <ReefRacePlayer />. */}
      {showDemoKarts && <RacingKarts />}

      {/* Gameplay juice — Part 2F: Bridge at z=8500 */}
      <Bridge />

      {/* SPEC 3: Ramp wedge meshes at 6 trigger volume positions */}
      <Ramps />
    </>
  );
}
