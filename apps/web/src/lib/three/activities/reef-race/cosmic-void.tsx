'use client';

/**
 * cosmic-void.tsx — the abstract COSMIC VOID backdrop for the SURF ROAD scene.
 *
 * Replaces the old sunny SkyDome + grass ground + sandy banks. The SURF ROAD is
 * a glowing floating water ribbon winding through a dreamlike deep void — there
 * is NO land, NO island, NO ground beneath it. This module is the mood: a deep
 * twilight-ocean-into-cosmos gradient dome, a starfield, and drifting glow
 * particles. The ribbon floats inside it.
 *
 * Layers (render order):
 *   -2  GradientDome — huge BackSide sphere, vertex-color gradient (deep
 *        indigo zenith → teal-cyan horizon glow → violet nadir). MeshBasicMaterial
 *        (vertexColors), fog:false, depthWrite:false. Reads as a boundless void.
 *   -1  Starfield — two Points clouds (far dim + near bright), PointsMaterial
 *        (NEVER ShaderMaterial — Iris-Xe InstancedMesh/Points+Shader crash class).
 *        A slow yaw drift gives parallax life without per-vertex cost.
 *   -1  GlowMotes — a sparser cloud of larger additive cyan/violet motes that
 *        drift, suggesting cosmic dust + bioluminescence around the ribbon.
 *
 * Iris Xe invariants:
 *   - NO ShaderMaterial on Points/Instanced (PointsMaterial only).
 *   - NO drei <Text>/<Billboard>.
 *   - import from 'three' (NOT 'three/webgpu').
 *   - All geo/mat module-scope, baked once; frustumCulled=false on the dome.
 *   - One cheap group.rotation.y mutate per frame (no per-frame allocation).
 *   - fog:false everywhere — the void IS the far backdrop; fog would wall it.
 *
 * Draw calls: 1 dome + 2 starfields + 1 glow motes = 4.
 * Tris/points: dome ~768 tris, ~3600 star points, ~280 glow points.
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ─── Footprint sizing ─────────────────────────────────────────────────────────
// SURF ROAD footprint ≈ 17687 × 16941 wu, centred near origin; elevation span
// ≈ 1634 wu. The void must comfortably enclose the whole ribbon + chase-cam
// pull-back from every angle. Dome radius 30000 sits well beyond CAMERA_FAR's
// reach of the ribbon perimeter while staying inside camera.far headroom.
const DOME_RADIUS = 30000;
const DOME_W_SEGS = 32;
const DOME_H_SEGS = 16;

// Deep cosmic gradient — twilight ocean dissolving into space.
const VOID_NADIR   = new THREE.Color('#0a0418'); // near-black violet (below)
const VOID_HORIZON = new THREE.Color('#163a5c'); // deep teal-blue band (mid)
const VOID_GLOW    = new THREE.Color('#1f8fb0'); // cyan horizon glow (just above mid)
const VOID_ZENITH  = new THREE.Color('#0c0b2a'); // deep indigo (above)

// Starfield extents — a box cloud filling the void interior.
const STAR_SPREAD_XZ = 26000;
const STAR_SPREAD_Y  = 16000;
const STAR_Y_CENTER  = 2000; // bias up a touch so stars frame above the ribbon

const FAR_STAR_COUNT  = 2400;
const NEAR_STAR_COUNT = 1200;
const GLOW_MOTE_COUNT = 280;

// ─── Gradient dome geometry (vertex colours) ─────────────────────────────────
function makeVoidDomeGeo(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(DOME_RADIUS, DOME_W_SEGS, DOME_H_SEGS);
  const pos = geo.attributes.position!;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    // normalised height tc ∈ [0,1]: 0 = nadir, 0.5 = horizon, 1 = zenith
    const tc = THREE.MathUtils.clamp(pos.getY(i) / DOME_RADIUS * 0.5 + 0.5, 0, 1);

    if (tc < 0.5) {
      // nadir → horizon
      c.copy(VOID_NADIR).lerp(VOID_HORIZON, tc / 0.5);
    } else if (tc < 0.62) {
      // horizon → cyan glow band (a thin bright belt at the waterline level)
      c.copy(VOID_HORIZON).lerp(VOID_GLOW, (tc - 0.5) / 0.12);
    } else {
      // glow band → zenith
      c.copy(VOID_GLOW).lerp(VOID_ZENITH, (tc - 0.62) / 0.38);
    }
    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

// ─── Starfield geometry (Points) ─────────────────────────────────────────────
function makeStarGeo(count: number, seed: number): THREE.BufferGeometry {
  // Deterministic mulberry32 so the field is stable across hot-reloads.
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const cool = new THREE.Color('#bcd8ff'); // cool white-blue
  const warm = new THREE.Color('#ffe6c8'); // faint warm
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = (rand() * 2 - 1) * STAR_SPREAD_XZ;
    positions[i * 3 + 1] = STAR_Y_CENTER + (rand() * 2 - 1) * STAR_SPREAD_Y;
    positions[i * 3 + 2] = (rand() * 2 - 1) * STAR_SPREAD_XZ;
    // Mostly cool stars, a few warm; vary brightness via the colour value.
    c.copy(rand() > 0.85 ? warm : cool);
    const b = 0.55 + rand() * 0.45;
    colors[i * 3 + 0] = c.r * b;
    colors[i * 3 + 1] = c.g * b;
    colors[i * 3 + 2] = c.b * b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

// ─── Glow-mote geometry (larger additive drifting points) ────────────────────
function makeGlowMoteGeo(): THREE.BufferGeometry {
  let s = 0x9e3779b9 >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const positions = new Float32Array(GLOW_MOTE_COUNT * 3);
  const colors = new Float32Array(GLOW_MOTE_COUNT * 3);
  const cyan = new THREE.Color('#5fe9ff');
  const violet = new THREE.Color('#9d7bff');
  const c = new THREE.Color();
  // Glow motes cluster nearer the ribbon band (smaller XZ spread, mid Y) so they
  // read as bioluminescent dust drifting around the floating road.
  for (let i = 0; i < GLOW_MOTE_COUNT; i++) {
    positions[i * 3 + 0] = (rand() * 2 - 1) * 14000;
    positions[i * 3 + 1] = 400 + (rand() * 2 - 1) * 4000;
    positions[i * 3 + 2] = (rand() * 2 - 1) * 14000;
    c.copy(rand() > 0.5 ? cyan : violet);
    const b = 0.6 + rand() * 0.4;
    colors[i * 3 + 0] = c.r * b;
    colors[i * 3 + 1] = c.g * b;
    colors[i * 3 + 2] = c.b * b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

// ─── Module-scope geometries + materials (baked once, page lifetime) ─────────
const _domeGeo = makeVoidDomeGeo();
const _farStarGeo = makeStarGeo(FAR_STAR_COUNT, 0xC0FFEE);
const _nearStarGeo = makeStarGeo(NEAR_STAR_COUNT, 0x1337BEEF);
const _glowGeo = makeGlowMoteGeo();

const _domeMat = new THREE.MeshBasicMaterial({
  vertexColors: true,
  side: THREE.BackSide,
  fog: false,
  depthWrite: false,
});

// PointsMaterial — sizeAttenuation makes nearer points larger (parallax depth).
const _farStarMat = new THREE.PointsMaterial({
  size: 26,
  sizeAttenuation: true,
  vertexColors: true,
  transparent: true,
  opacity: 0.7,
  depthWrite: false,
  fog: false,
});
const _nearStarMat = new THREE.PointsMaterial({
  size: 48,
  sizeAttenuation: true,
  vertexColors: true,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  fog: false,
});
// Glow motes — additive so they bloom against the dark void.
const _glowMat = new THREE.PointsMaterial({
  size: 120,
  sizeAttenuation: true,
  vertexColors: true,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  fog: false,
});

// ─── CosmicVoid component ─────────────────────────────────────────────────────

/**
 * CosmicVoid — the dome + starfield + glow-mote backdrop. Drop into the scene
 * once, OUTSIDE any track-elevation group (it lives in absolute world space and
 * has no vertical datum dependence). Does NOT own lighting or fog.
 *
 * A single slow group.rotation.y drift on the star groups gives the void subtle
 * parallax life — one scalar mutate per frame, no allocation.
 */
export function CosmicVoid() {
  const starGroupRef = useRef<THREE.Group>(null);
  const glowGroupRef = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    // Very slow celestial drift (~0.6°/s). Stars + glow rotate together.
    const sg = starGroupRef.current;
    if (sg) sg.rotation.y += delta * 0.010;
    const gg = glowGroupRef.current;
    if (gg) gg.rotation.y -= delta * 0.014; // counter-drift = depth parallax
  });

  return (
    <>
      {/* -2: gradient void dome */}
      <mesh
        geometry={_domeGeo}
        material={_domeMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
        renderOrder={-2}
      />

      {/* -1: starfield (drifts) */}
      <group ref={starGroupRef}>
        <points geometry={_farStarGeo} material={_farStarMat} frustumCulled={false} renderOrder={-1} />
        <points geometry={_nearStarGeo} material={_nearStarMat} frustumCulled={false} renderOrder={-1} />
      </group>

      {/* -1: drifting glow motes (counter-drift) */}
      <group ref={glowGroupRef}>
        <points geometry={_glowGeo} material={_glowMat} frustumCulled={false} renderOrder={-1} />
      </group>
    </>
  );
}
