'use client';

import { useMemo, useEffect } from 'react';
import * as THREE from 'three/webgpu';
import {
  float,
  vec3,
  sin,
  cos,
  time,
  positionLocal,
  uv,
  mix,
  fract,
} from 'three/tsl';

// ---------------------------------------------------------------------------
// UnderwaterAtmosphere
//
// Three GPU-driven effects — no post-processing, no InstancedMesh, no GLSL.
// All animation is TSL node-based (runs entirely on GPU, zero CPU per frame).
//
// 1. CausticPlane  — large horizontal plane at y=150, animated light pattern
// 2. DepthBackdrop — vertical plane at z=-1200, blue-green gradient
// 3. DustParticles — ~300 Points drifting upward via TSL positionNode
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Caustic Light Plane
// ---------------------------------------------------------------------------
function createCausticMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  // UV coords of the plane (0..1 range)
  const u = uv().x;
  const v = uv().y;

  // Four overlapping sine waves at different angles and frequencies.
  // Each wave is sin(u*fx + v*fy + time*speed), remapped to [0,1].
  const t = time;

  const w1 = sin(u.mul(float(6.0)).add(v.mul(float(3.0))).add(t.mul(float(0.4))))
    .mul(float(0.5))
    .add(float(0.5));

  const w2 = sin(u.mul(float(4.0)).sub(v.mul(float(5.0))).add(t.mul(float(0.31))))
    .mul(float(0.5))
    .add(float(0.5));

  const w3 = cos(u.mul(float(7.5)).add(v.mul(float(2.0))).add(t.mul(float(0.27))))
    .mul(float(0.5))
    .add(float(0.5));

  const w4 = sin(u.mul(float(3.0)).add(v.mul(float(8.0))).sub(t.mul(float(0.19))))
    .mul(float(0.5))
    .add(float(0.5));

  // Multiply waves together — produces sharp caustic-like bright spots
  const caustic = w1.mul(w2).mul(w3).mul(w4);

  // Bright cyan-white caustic colour
  const causticColor = vec3(float(0.5), float(0.85), float(1.0));

  mat.colorNode = causticColor.mul(caustic);

  // Opacity: caustic intensity × overall max opacity (0.10)
  // opacityNode controls per-pixel transparency
  mat.opacityNode = caustic.mul(float(0.10));

  return mat;
}

function CausticPlane() {
  const { geometry, material } = useMemo(() => {
    // Caustic coverage — only needs to cover what the camera can see (fog far = 3600).
    // 4000x4000 covers the visible area with margin. Larger wastes fragment shader work.
    const geo = new THREE.PlaneGeometry(4000, 4000, 1, 1);
    const mat = createCausticMaterial();
    return { geometry: geo, material: mat };
  }, []);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return (
    <mesh
      geometry={geometry}
      material={material}
      // Horizontal, facing down — rotated so +Y is up
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 150, 0]}
      frustumCulled={false}
    />
  );
}

// ---------------------------------------------------------------------------
// 2. Depth Gradient Backdrop
// ---------------------------------------------------------------------------
function createBackdropMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });

  // Deep ocean floor colour (dark blue-navy)
  const deepColor = vec3(float(0.02), float(0.08), float(0.18));
  // Mid-water colour (muted teal)
  const midColor = vec3(float(0.06), float(0.22), float(0.38));
  // Near-surface colour (lighter blue-green)
  const shallowColor = vec3(float(0.10), float(0.35), float(0.52));

  // uv().y is 0 at the bottom of the plane, 1 at the top.
  const vCoord = uv().y;

  // Two-step gradient: deep → mid → shallow
  const bottomHalf = mix(deepColor, midColor, vCoord.mul(float(2.0)).min(float(1.0)));
  const topHalf = mix(
    midColor,
    shallowColor,
    vCoord.sub(float(0.5)).mul(float(2.0)).max(float(0.0)),
  );
  const gradient = mix(bottomHalf, topHalf, vCoord);

  mat.colorNode = gradient;
  mat.opacityNode = float(0.88);

  return mat;
}

function DepthBackdrop() {
  const { geometry, material } = useMemo(() => {
    // Wide plane spanning the full expanded world horizon
    const geo = new THREE.PlaneGeometry(12000, 700, 1, 1);
    const mat = createBackdropMaterial();
    return { geometry: geo, material: mat };
  }, []);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return (
    <mesh
      geometry={geometry}
      material={material}
      // Vertical plane pushed far behind all buildings (northernmost is at z≈-1504).
      // z=-3200 ensures the backdrop never clips in front of any building or decoration.
      position={[0, 250, -3200]}
      frustumCulled={false}
    />
  );
}

// ---------------------------------------------------------------------------
// 3. Underwater Dust Particles
// ---------------------------------------------------------------------------
const PARTICLE_COUNT = 300;
const FIELD_W = 2000;
const FIELD_D = 1400;
const FIELD_H = 350; // vertical range the particles occupy

function createDustGeometry(): THREE.BufferGeometry {
  // Seeded RNG for deterministic placement
  let seed = 12345;
  const rng = () => {
    seed = (seed * 16807 + 0) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const positions = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    positions[i * 3 + 0] = (rng() - 0.5) * FIELD_W;
    positions[i * 3 + 1] = rng() * FIELD_H; // base Y, GPU animates from here
    positions[i * 3 + 2] = (rng() - 0.5) * FIELD_D;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

function createDustMaterial(): THREE.PointsNodeMaterial {
  const mat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });

  // Drift speed — slow upward float (units per second)
  const DRIFT_SPEED = 8.0;

  // Each particle drifts upward by time * speed, wrapping within FIELD_H using fract.
  // This creates a continuous upward loop with no CPU involvement.
  const driftY = fract(
    positionLocal.y.div(float(FIELD_H)).add(time.mul(float(DRIFT_SPEED / FIELD_H))),
  ).mul(float(FIELD_H));

  // Gentle sideways sway — different frequency per particle (using X pos as phase)
  const swayX = sin(time.mul(float(0.3)).add(positionLocal.x.mul(float(0.012)))).mul(
    float(4.0),
  );
  const swayZ = cos(time.mul(float(0.22)).add(positionLocal.z.mul(float(0.015)))).mul(
    float(3.0),
  );

  mat.positionNode = vec3(
    positionLocal.x.add(swayX),
    driftY,
    positionLocal.z.add(swayZ),
  );

  // Soft white-blue colour
  mat.colorNode = vec3(float(0.7), float(0.88), float(1.0));
  mat.opacityNode = float(0.18);

  // Point size in world units (sizeAttenuation: true scales by depth)
  mat.size = 2.5;

  return mat;
}

function DustParticles() {
  const { geometry, material } = useMemo(() => {
    const geo = createDustGeometry();
    const mat = createDustMaterial();
    return { geometry: geo, material: mat };
  }, []);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return (
    <points
      geometry={geometry}
      material={material}
      position={[0, 0, 0]}
      frustumCulled={false}
    />
  );
}

// ---------------------------------------------------------------------------
// Exported composite component — drop into SceneContents
// ---------------------------------------------------------------------------
export default function UnderwaterAtmosphere() {
  return (
    <>
      <CausticPlane />
      <DepthBackdrop />
      <DustParticles />
    </>
  );
}
