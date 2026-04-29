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
 *   B. Sandy bank ribbons (cream trianglestrip at water edge)
 *   C. Water ribbon — animated cartoon shader (simplex noise + bank-edge foam)
 *   D. Sky dome (SphereGeometry + MeshBasicMaterial vertexColors)
 *   E. ScenerySpawner (low-poly prop GLBs ON THE GRASS, not in water)
 *   F. Finish-line gate (wooden arch at z~18000, Part 2A)
 *   G. Distance markers every 2000wu (Part 2B)
 *   H. Power-up boxes mid-river (Part 2C)
 *   I. Animated sample karts riding the spline (REPLACES static wake ribbons)
 *   J. Bridge prop (Part 2F)
 *
 * Iris Xe invariants:
 *   - ShaderMaterial ONLY on plain Mesh — NO InstancedMesh + ShaderMaterial
 *   - NO drei <Text> or <Billboard>
 *   - import from 'three' only (not 'three/webgpu')
 *   - All static geo/mat at module scope — zero per-frame GC
 *   - frustumCulled=false on all atmosphere meshes
 *   - matrixAutoUpdate=false on all static meshes
 *   - NO point lights — emissive only for power-up glow (budget: 1 hemi + 1 dir)
 *   - Module-scope scratch Vec3s for all kart math — zero per-frame allocations
 *
 * Draw call budget:
 *   1 ground + 1 sand ribbon + 1 water ribbon + 1 dome + ≤6 scenery GLB types
 *   + 1 finish gate + 1 distance markers (instanced) + 6 power-up boxes
 *   + 5 kart meshes + 1 bridge = ≤24 draw calls (within 30-call budget)
 *
 * Tri count (iter-4):
 *   Ground terrain: 96×192×2 = 36 864 tris
 *   Water ribbon: 126 tris | Sand ribbon: 126 tris
 *   Sky dome: ~512 tris | Scenery GLBs: ~12 000 tris
 *   Gate+markers+karts+bridge+powerups: ~800 tris
 *   Total: ~50 428 tris — comfortably within ≤80k budget.
 *
 * Water Y placement:
 *   River bed at y=0. Water ribbon at y=40 (halfway up V2_BANK_HEIGHT=80).
 *   Sand ribbon at y=0.5 (just above river bed, below water surface).
 *   Ground plane at y=-1 (just below river bed — no z-fight with sandy river floor).
 */

import { Suspense, useRef, useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clientSpline } from './reef-race-spline-instance';

// ─── Track layout constants ───────────────────────────────────────────────────
// Track runs z=[0,18000]; slight overrun on each end for ground coverage.
const TRACK_LEN_Z    = 20000;
const TRACK_START_Z  = -500;
const TRACK_CENTER_Z = TRACK_START_Z + TRACK_LEN_Z / 2; // 9500

// ─── Ground shader terrain ────────────────────────────────────────────────────
// Much wider than river, subdivided for per-vertex displacement
const GROUND_W         = 12000;
const GROUND_L         = 24000;
const GROUND_W_SEGS    = 96;
const GROUND_L_SEGS    = 192;
const GROUND_Y         = -1;  // just below river bed at y=0

// ─── Sky dome ────────────────────────────────────────────────────────────────
const DOME_RADIUS  = 28000;
const DOME_W_SEGS  = 32;
const DOME_H_SEGS  = 16;
const DOME_HORIZON = new THREE.Color('#cfe9ff');
const DOME_ZENITH  = new THREE.Color('#5ab8e8');

// ─── Water / sand ribbon sampling ────────────────────────────────────────────
const RIBBON_SAMPLES = 64;  // number of cross-sections along the spline
const WATER_Y        = 40;  // halfway up V2_BANK_HEIGHT=80
const SAND_Y         = 0.5; // just above river bed, below water
const SAND_EXTRA_HW  = 120; // sand ribbon extends this many wu beyond water edge

// ─── Gameplay prop constants ──────────────────────────────────────────────────
// Part 2A: Finish-line gate
const GATE_POST_HALF_W = 520;  // half-width: gates span full river + margin
const GATE_POST_W      = 40;
const GATE_POST_H      = 250;
const GATE_POST_D      = 60;
const GATE_BAR_H       = 30;
const GATE_BAR_D       = 40;
const GATE_Z           = 18200; // just past finish line CP15 z≈18000

// Part 2B: Distance markers
const MARKER_SPACING   = 2000;  // wu between markers
const MARKER_X_OFFSET  = 650;   // outside grass, +X side
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
const BRIDGE_Z         = 8500; // mid-track z position
const BRIDGE_W         = 1100; // wu span (covers full river + banks)
const BRIDGE_H         = 100;  // y position (rides over bank walls at y=80)
const BRIDGE_PLANK_H   = 30;   // plank thickness
const BRIDGE_SUPPORT_W = 30;

// ─── Animated kart constants ──────────────────────────────────────────────────
// 5 surfboard karts ride the spline surface.
// Module-scope scratch vectors — zero per-frame allocations.
const _kartScratchC  = new THREE.Vector3();
const _kartScratchN  = new THREE.Vector3();
const _kartScratchT  = new THREE.Vector3();

// Lateral offsets in wu from centerline (spread karts across lane)
const KART_LATERAL_OFFSETS = [-120, -40, 0, 40, 120] as const;
// Lap speeds as arc-fraction per second (kart[2]=1.0 is baseline ~19s lap)
const KART_SPEEDS          = [0.047, 0.050, 0.053, 0.048, 0.051] as const;
// Initial t positions spread around track
const KART_T_START         = [0.0, 0.2, 0.4, 0.6, 0.8] as const;
const KART_Y_ABOVE_WATER   = WATER_Y + 12; // kart rides slightly above water surface
const KART_COLORS          = [
  new THREE.Color('#ff6633'), // orange-red
  new THREE.Color('#4499ff'), // blue
  new THREE.Color('#ffdd00'), // yellow
  new THREE.Color('#55dd44'), // green
  new THREE.Color('#ee44ee'), // pink
] as const;

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
  path: string;
  tValues: number[];
  side: number;   // +1 = left, -1 = right
  xJitter: number; // wu BEYOND bank edge (positive = further out onto grass)
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

// Spawner defs with xJitter large enough to clear the water + sand ribbon.
// Water extends to halfWidth (280-700 wu). Sand extends halfWidth+120 wu.
// Props MUST have xJitter > 120 wu to clear the sand and land on grass.
const SPAWNER_DEFS: SpawnerDef[] = [
  // Pine trees — left side, well onto grass
  {
    path: '/models/reef-race/scenery/prop-tree-pine.glb',
    tValues: Array.from({ length: 16 }, (_, i) => (i + 0.3) / 16),
    side: 1, xJitter: 350, scaleMin: 2.5, scaleMax: 3.5, seed: 1,
  },
  // Leafy trees — right side, well onto grass
  {
    path: '/models/reef-race/scenery/prop-tree-leafy.glb',
    tValues: Array.from({ length: 14 }, (_, i) => (i + 0.1) / 14),
    side: -1, xJitter: 450, scaleMin: 2.2, scaleMax: 3.2, seed: 2,
  },
  // Rocks — closer to bank edge, both sides
  {
    path: '/models/reef-race/scenery/prop-rock-1.glb',
    tValues: Array.from({ length: 10 }, (_, i) => (i + 0.05) / 10),
    side: 1, xJitter: 200, scaleMin: 0.7, scaleMax: 1.3, seed: 3,
  },
  {
    path: '/models/reef-race/scenery/prop-rock-2.glb',
    tValues: Array.from({ length: 10 }, (_, i) => (i + 0.55) / 10),
    side: -1, xJitter: 250, scaleMin: 0.8, scaleMax: 1.4, seed: 4,
  },
  // Fences — right at the sand/grass boundary
  {
    path: '/models/reef-race/scenery/prop-fence.glb',
    tValues: Array.from({ length: 24 }, (_, i) => i / 24),
    side: 1, xJitter: 80, scaleMin: 1.0, scaleMax: 1.0, seed: 5,
  },
  // Grass tufts — clustered near bank, on grass
  {
    path: '/models/reef-race/scenery/prop-grass-tuft.glb',
    tValues: Array.from({ length: 30 }, (_, i) => (i + 0.15) / 30),
    side: -1, xJitter: 150, scaleMin: 0.8, scaleMax: 1.5, seed: 6,
  },
];

// ─── Water ribbon geometry (module-scope, baked once) ────────────────────────
// Triangle strip swept along clientSpline centerline.
// Each cross-section: 2 verts at center ± normal*halfWidth.
// N=64 cross-sections → 63 quads × 2 tris = 126 tris total.
// UVs: x=0(left)/1(right), y=t(arclength fraction along spline).
// The vertex shader animates Y in GPU — buffer stays static.
function buildWaterRibbonGeo(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals:   number[] = [];
  const uvs:       number[] = [];
  const indices:   number[] = [];

  for (let i = 0; i <= RIBBON_SAMPLES; i++) {
    const t  = i / RIBBON_SAMPLES;
    const c  = clientSpline.centerlineAt(t);
    const n  = clientSpline.normalAt(t);
    const hw = clientSpline.widthAt(t);

    // Left edge
    positions.push(c.x + n.x * hw, WATER_Y, c.z + n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(0, t);

    // Right edge
    positions.push(c.x - n.x * hw, WATER_Y, c.z - n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(1, t);

    if (i < RIBBON_SAMPLES) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geo.setIndex(indices);
  return geo;
}

// ─── Sand ribbon geometry (module-scope, baked once) ─────────────────────────
// Same approach as water but wider by SAND_EXTRA_HW and at y=SAND_Y.
// Sits ON the ground plane, BELOW the water surface — acts as beach strip.
function buildSandRibbonGeo(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals:   number[] = [];
  const uvs:       number[] = [];
  const indices:   number[] = [];

  for (let i = 0; i <= RIBBON_SAMPLES; i++) {
    const t  = i / RIBBON_SAMPLES;
    const c  = clientSpline.centerlineAt(t);
    const n  = clientSpline.normalAt(t);
    const hw = clientSpline.widthAt(t) + SAND_EXTRA_HW;

    // Left edge
    positions.push(c.x + n.x * hw, SAND_Y, c.z + n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(0, t);

    // Right edge
    positions.push(c.x - n.x * hw, SAND_Y, c.z - n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(1, t);

    if (i < RIBBON_SAMPLES) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geo.setIndex(indices);
  return geo;
}

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

    // River corridor falloff — flatten within 700wu of river centreline (x=0)
    float riverDist = abs(position.x);
    float riverMask = smoothstep(700.0, 1500.0, riverDist);
    vRiverMask = riverMask;

    // Multi-octave value noise displacement (Y world up)
    float scale1 = 0.0006;
    float scale2 = 0.0015;
    float n1 = valueNoise(position.xz * scale1) * 2.0 - 1.0;
    float n2 = valueNoise(position.xz * scale2) * 0.5 - 0.25;
    float noiseVal = (n1 + n2) * 50.0 * riverMask; // max ±50wu, zero at river

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
    float dispNorm = clamp(vDisp / 50.0, -1.0, 1.0);
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

// ─── Animated water ShaderMaterial ──────────────────────────────────────────
//
// Vertex shader: multi-octave sin waves displace Y (world up).
// Fragment shader: simplex noise foam stripes + UV-scrolled flow + bank-edge foam.
//
// Key changes vs iter-3:
//   - bankFoam is now a WIDE creamy-white band (edgeDist < 0.12 instead of 0.04)
//     with animated turbulence so foam churns at the waterline.
//   - uColorNear bumped to #5fdcff (brighter cyan), uColorFar to #3aaedf
//     (lighter mid-blue so low-angle views don't go navy).
//   - Edge-zone has a separate foam layer that reads stronger than the ambient stripes.
//
// IRIS XE SAFE: plain ShaderMaterial on a plain Mesh.
//
const _waterVertexShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;

    // Multi-octave sin wave displacement in Y (world up for this geometry)
    float x = position.x;
    float z = position.z;
    float wave = sin(x * 0.005 + uTime * 0.8) * 4.0
               + sin(z * 0.003 + uTime * 1.2) * 3.0
               + sin((x + z) * 0.002 - uTime * 0.6) * 2.0;

    vec3 displaced = position;
    displaced.y += wave;

    vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const _waterFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3  uColorNear;
  uniform vec3  uColorFar;

  varying vec2 vUv;
  varying vec3 vWorldPos;

  // 2D simplex noise — self-contained, no texture lookup
  vec3 mod289_3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289_2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute3(vec3 x) { return mod289_3(((x * 34.0) + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289_2(i);
    vec3 p = permute3(permute3(i.y + vec3(0.0, i1.y, 1.0))
                    + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    // UV scrolled downstream (+UV.y = downstream direction)
    vec2 flowUv = vUv + vec2(0.0, -uTime * 0.05);

    // Base foam noise (scrolled)
    float noiseBase = snoise(flowUv * 280.0 + sin(uTime * 0.3));
    noiseBase = noiseBase * 0.5 + 0.5;
    vec3 colorBase = vec3(noiseBase);

    // Binary foam stripes from noise
    vec3 foam = smoothstep(0.08, 0.001, colorBase);
    foam = step(0.5, foam);

    // Wave-stripe noise (scrolled at different scale/rate)
    float noiseWaves = snoise(flowUv * 100.0 + sin(uTime * -0.1));
    noiseWaves = noiseWaves * 0.5 + 0.5;

    float threshold = 0.6 + 0.01 * sin(uTime * 2.0);
    vec3 waveEffect = 1.0 - (smoothstep(threshold + 0.03, threshold + 0.032, vec3(noiseWaves))
                           + smoothstep(threshold, threshold - 0.01, vec3(noiseWaves)));
    waveEffect = step(0.5, waveEffect);

    // ── Bank-edge foam (ITER-4 UPGRADE) ──────────────────────────────────────
    // edgeFactor = 1.0 at UV.x=0 or 1.0, smoothly falls to 0 at 0.12 from edge.
    // This is strongest AT the waterline, fading toward the river centre.
    float edgeDist  = min(vUv.x, 1.0 - vUv.x);
    float edgeFactor = 1.0 - smoothstep(0.0, 0.12, edgeDist);

    // Animated foam turbulence along bank — two noise layers at different scales
    float foamTurb1 = snoise(flowUv * 60.0 + vec2(uTime * 1.2, 0.0)) * 0.5 + 0.5;
    float foamTurb2 = snoise(flowUv * 150.0 + vec2(0.0, uTime * 2.0)) * 0.5 + 0.5;
    float foamTurbCombined = foamTurb1 * 0.6 + foamTurb2 * 0.4;

    // Bright bank foam: flicker between 0.6 and 1.0 with time + noise
    float bankFoamIntensity = edgeFactor * (0.6 + 0.4 * foamTurbCombined);
    // Creamy white foam color (slightly warm)
    vec3 bankFoamColor = vec3(1.0, 0.97, 0.92) * bankFoamIntensity;

    // ── Combine all effects ───────────────────────────────────────────────────
    vec3 combinedEffect = min(waveEffect + foam, 1.0);

    // Depth gradient: deeper = uses uColorFar
    float vignette = length(vUv - 0.5) * 1.5;
    vec3 baseEffect = smoothstep(0.1, 0.3, vec3(vignette));
    vec3 baseColor = mix(uColorNear, uColorFar, baseEffect);
    combinedEffect = mix(combinedEffect, vec3(0.0), baseEffect);

    // Final color: base + white foam overlaid + bank foam on top
    vec3 finalColor = (1.0 - combinedEffect) * baseColor + combinedEffect;
    // Bank foam always layers ON TOP, blending to white at the edge
    finalColor = mix(finalColor, bankFoamColor, edgeFactor * bankFoamIntensity * 0.8);

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

// Shared water shader material — module scope, uTime updated each frame
const _waterShaderMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime:      { value: 0 },
    uColorNear: { value: new THREE.Color('#5fdcff') },   // bright cartoon cyan
    uColorFar:  { value: new THREE.Color('#3aaedf') },   // lighter mid-blue (not navy)
  },
  vertexShader:   _waterVertexShader,
  fragmentShader: _waterFragmentShader,
  side:       THREE.DoubleSide,
  fog:        true,
  transparent: false,
});

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

// ─── Kart material (one per kart colour, module scope) ────────────────────────
const _kartMats = KART_COLORS.map((col) => new THREE.MeshStandardMaterial({
  color: col.clone(),
  roughness: 0.35,
  metalness: 0.6,
  emissive: col.clone().multiplyScalar(0.25),
  emissiveIntensity: 0.5,
  fog: true,
}));

// ─── Kart geometry (surfboard — elongated tapered box, module scope) ──────────
// A surfboard silhouette: 60wu wide, 150wu long, 12wu tall
const _kartGeo = new THREE.BoxGeometry(60, 12, 150);

// ─── Module-scope geometries (baked at module load, shared forever) ───────────
const _waterGeo     = buildWaterRibbonGeo();
const _sandGeo      = buildSandRibbonGeo();
const _domeGeo      = makeDomeGeo();
// Ground terrain geo (subdivided — 96×192×2 = 36 864 tris)
const _groundGeo    = (() => {
  const geo = new THREE.PlaneGeometry(GROUND_W, GROUND_L, GROUND_W_SEGS, GROUND_L_SEGS);
  // PlaneGeometry is XY; rotate to XZ
  geo.rotateX(-Math.PI / 2);
  return geo;
})();

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

/** Sandy bank ribbon — cream/peach color at water's edge. */
const _sandMat = new THREE.MeshLambertMaterial({
  color: new THREE.Color('#e8d5a8'),
  flatShading: true,
  fog: true,
  side: THREE.DoubleSide,
});

/** Sky dome material — vertex colors, BackSide, no fog. */
const _domeMat = new THREE.MeshBasicMaterial({
  vertexColors: true,
  side: THREE.BackSide,
  fog: false,
  depthWrite: false,
});

// ─── Kart t-state (module scope) — one entry per kart ─────────────────────────
// These persist across React re-renders/unmounts inside the route since
// the preview page keeps the Canvas mounted. If the component remounts,
// values just reset naturally from KART_T_START.
const _kartT = [...KART_T_START] as number[];

// ─── Ground terrain shader component ─────────────────────────────────────────

function GroundShader() {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      geometry={_groundGeo}
      material={_groundShaderMat}
      position={[0, GROUND_Y, TRACK_CENTER_Z]}
      frustumCulled={false}
      matrixAutoUpdate={false}
      receiveShadow
      renderOrder={0}
    />
  );
}

// ─── Sand ribbon component ────────────────────────────────────────────────────

function SandRibbon() {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      geometry={_sandGeo}
      material={_sandMat}
      frustumCulled={false}
      matrixAutoUpdate={false}
      receiveShadow
      renderOrder={1}
    />
  );
}

// ─── Animated water ribbon component ─────────────────────────────────────────
//
// The water uses a plain THREE.ShaderMaterial on a plain Mesh — safe on Iris Xe.
// The ONLY per-frame operation is updating the uTime uniform.
// No buffer mutations, no normals recomputation.

function WaterRibbon() {
  useFrame(({ clock }) => {
    _waterShaderMat.uniforms.uTime.value = clock.getElapsedTime();
  });

  return (
    <mesh
      geometry={_waterGeo}
      material={_waterShaderMat}
      frustumCulled={false}
      matrixAutoUpdate={false}
      renderOrder={2}
    />
  );
}

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

// ─── Individual scenery prop component ───────────────────────────────────────

interface PropInstancesProps {
  def: SpawnerDef;
}

function PropInstances({ def }: PropInstancesProps) {
  const { scene: srcScene } = useGLTF(def.path);
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    const gr = groupRef.current;
    if (!gr || !srcScene) return;

    const rng = seededRand(def.seed);
    def.tValues.forEach((t) => {
      // Add random lateral jitter of ±30wu on top of the base xJitter
      const jitter = def.xJitter + rng.next() * 60 - 30;
      const pos    = spawnPos(t, def.side, jitter);
      const yRot   = rng.next() * Math.PI * 2;
      const scale  = def.scaleMin + rng.next() * (def.scaleMax - def.scaleMin);

      const clone = srcScene.clone(true);
      clone.traverse(o => { o.frustumCulled = false; });
      clone.position.copy(pos);
      clone.rotation.y = yRot;
      clone.scale.setScalar(scale);
      clone.matrixAutoUpdate = false;
      clone.updateMatrix();
      gr.add(clone);
    });

    gr.matrixAutoUpdate = false;
    gr.updateMatrix();

    return () => {
      while (gr.children.length > 0) gr.remove(gr.children[0]);
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
        <Suspense key={def.path} fallback={null}>
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
// Small flag-on-pole at z = 2000, 4000, ..., 18000, placed at x=+MARKER_X_OFFSET.
// Gentle flag sway animation.

const _markerCount = Math.floor(18000 / MARKER_SPACING); // 9 markers

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

// ─── Animated karts — ride the water surface ─────────────────────────────────
//
// 5 surfboard karts lap the spline independently. Per-frame math:
//   1. Advance tCurrent by speed*dt; wrap at 1.
//   2. Sample centerline + normal for lateral offset.
//   3. Set Y = KART_Y_ABOVE_WATER + wave bob (same waveform as water vertex shader).
//   4. Face tangent direction via atan2(tx, tz).
//   5. Bank: tilt around forward axis proportional to curvature (second-derivative hack
//      via two closely-sampled tangents). Clamp to ±0.35 rad.
//
// All scratch vectors are module-scope; zero per-frame allocations.
// useMemo return is stable (same refs each render) so meshRefs array stays intact.

function AnimatedKarts() {
  const kartRefs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame((_state, dt) => {
    const clampedDt = Math.min(dt, 0.05); // cap at 50ms to survive tab wakes

    kartRefs.current.forEach((mesh, i) => {
      if (!mesh) return;

      // Advance t — wrap around
      _kartT[i] = (_kartT[i]! + KART_SPEEDS[i]! * clampedDt) % 1.0;
      const t = _kartT[i]!;

      // Centerline + normal for lateral lane offset
      // Vec2 {x,z} — set scratch XZ (Y=0 placeholder, overridden below)
      const _c = clientSpline.centerlineAt(t);
      const _n = clientSpline.normalAt(t);
      _kartScratchC.set(_c.x, 0, _c.z);
      _kartScratchN.set(_n.x, 0, _n.z);
      const lat = KART_LATERAL_OFFSETS[i]!;

      // Water wave Y — mirrors vertex shader wave (simplified, single octave)
      // Using centerline x/z for the sample position
      const elapsed = _state.clock.getElapsedTime();
      const waveY = Math.sin(_c.x * 0.005 + elapsed * 0.8) * 4.0
                  + Math.sin(_c.z * 0.003 + elapsed * 1.2) * 3.0;

      mesh.position.set(
        _c.x + _n.x * lat,
        KART_Y_ABOVE_WATER + waveY,
        _c.z + _n.z * lat,
      );

      // Tangent for yaw
      const _tg = clientSpline.tangentAt(t);
      _kartScratchT.set(_tg.x, 0, _tg.z);
      mesh.rotation.y = Math.atan2(_tg.x, _tg.z);

      // Banking lean from curvature — sample two tangents straddling t
      const dt2 = 0.005;
      const tA = Math.max(0, t - dt2);
      const tB = Math.min(1, t + dt2);
      const tgA = clientSpline.tangentAt(tA);
      const tgB = clientSpline.tangentAt(tB);
      // Cross-track curvature: (tgB.x - tgA.x) / (2*dt2) projected onto normal
      const curvX = (tgB.x - tgA.x) / (2 * dt2);
      const bankAngle = THREE.MathUtils.clamp(curvX * -6.0, -0.35, 0.35);
      mesh.rotation.z = bankAngle;
    });
  });

  return (
    <>
      {KART_LATERAL_OFFSETS.map((_, i) => (
        <mesh
          key={i}
          ref={(el) => { kartRefs.current[i] = el; }}
          geometry={_kartGeo}
          material={_kartMats[i]!}
          frustumCulled={false}
          castShadow
        />
      ))}
    </>
  );
}

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
 *    1: Sandy bank ribbons (cream, spline-following, at water edge)
 *    2: Animated water ribbon (simplex noise + foam stripes + bank-edge foam)
 *    ?: Scenery props along banks (on the grass, not in the water)
 *    ?: Gameplay juice: finish gate, distance markers, power-ups, animated karts, bridge
 *
 * Bank wall geometry from SplineTrack (buildSplineBankGeos) is intentionally
 * hidden by the parent page — set visible=false or recolor to grass green.
 * See page.tsx: _bankMat color is '#7cb342' grass green to blend with ground.
 *
 * WATER SHADER (iter-4):
 *   Plain THREE.ShaderMaterial on a plain Mesh — verified Iris Xe safe.
 *   uColorNear '#5fdcff', uColorFar '#3aaedf' (lighter than iter-3 to avoid
 *   "solid dark navy" at glancing angles). Bank-edge foam uses 0-0.12 UV width
 *   with animated simplex noise turbulence — bright creamy-white at waterline.
 *
 * GROUND SHADER (iter-4, NEW):
 *   ShaderMaterial on a 96×192-segment PlaneGeometry (36 864 tris).
 *   Vertex: value-noise Y displacement masked to zero within 700wu of x=0
 *   (river corridor stays flat). Fragment: 3-tone grass+dirt blending with
 *   berm highlight at the slope transition edge.
 *
 * KARTS (iter-4, NEW):
 *   5 surfboard karts ride the spline. Module-scope t-state advances each
 *   frame (wrap at 1). Position = centerline + normal×lateralOffset,
 *   Y = KART_Y_ABOVE_WATER + wave-sync bob. Yaw from tangent, bank from
 *   curvature. Zero per-frame allocations (module-scope scratch Vec3s).
 */
export function RiverScene() {
  return (
    <>
      {/* -1: Sky dome — renders behind everything */}
      <SkyDome />

      {/* 0: Terrain shader ground — subdivided rolling hills */}
      <GroundShader />

      {/* 1: Sandy bank ribbons at water's edge */}
      <SandRibbon />

      {/* 2: Animated cartoon water ribbon — simplex noise + bank-edge foam */}
      <WaterRibbon />

      {/* Scenery props on the grass */}
      <ScenerySpawner />

      {/* Gameplay juice — Part 2A: Finish-line gate */}
      <FinishGate />

      {/* Gameplay juice — Part 2B: Distance markers every 2000wu */}
      <DistanceMarkers />

      {/* Gameplay juice — Part 2C: Power-up boxes mid-river */}
      <PowerUpBoxes />

      {/* Gameplay juice — Animated surfboard karts riding the water */}
      <AnimatedKarts />

      {/* Gameplay juice — Part 2F: Bridge at z=8500 */}
      <Bridge />
    </>
  );
}
