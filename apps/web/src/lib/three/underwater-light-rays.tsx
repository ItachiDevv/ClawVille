'use client';

import { useMemo, useEffect } from 'react';
import * as THREE from 'three/webgpu';
import { float, vec3, sin, time } from 'three/tsl';

// ---------------------------------------------------------------------------
// UnderwaterLightRays
//
// 7 cone-shaped cylinders (CylinderGeometry) simulating sunlight shafts
// filtering down through the water surface. Each ray is a separate mesh
// (7 draw calls total — very cheap).
//
// Technique:
//   - MeshBasicNodeMaterial + AdditiveBlending — rays add light, never darken
//   - opacityNode: sin(time * speed + phaseOffset) mapped to [minOp, maxOp]
//     so each ray independently pulses in and out
//   - radiusTop ≈ 2–4, radiusBottom ≈ 30–55 — wide cone shape
//   - transparent: true, depthWrite: false, side: DoubleSide
//   - All material creation happens once in useMemo (zero CPU per frame)
// ---------------------------------------------------------------------------

// Ray definition — one entry per light shaft
interface RayDef {
  /** World-space centre position [x, y, z] — y is the vertical midpoint */
  position: [number, number, number];
  /** Euler rotation [rx, ry, rz] in radians — slight tilt for realism */
  rotation: [number, number, number];
  /** CylinderGeometry radiusTop (narrow end, at water surface) */
  radiusTop: number;
  /** CylinderGeometry radiusBottom (wide end, at seafloor) */
  radiusBottom: number;
  /** Total height of the cylinder — rays span ground to above buildings */
  height: number;
  /** Angular frequency of the opacity pulse (radians/sec) */
  speed: number;
  /** Phase offset so rays don't all pulse in sync */
  phase: number;
  /** Minimum opacity during pulse */
  opacityMin: number;
  /** Maximum opacity during pulse */
  opacityMax: number;
}

// Seven rays distributed across the central map area (x: -250..250, z: -150..150).
// Positions, angles, and sizes are hand-tuned for a natural, asymmetric look.
const RAY_DEFS: RayDef[] = [
  {
    position: [-180, 150, -80],
    rotation: [0.08, 0.0, -0.12],
    radiusTop: 2,
    radiusBottom: 42,
    height: 300,
    speed: 0.28,
    phase: 0.0,
    opacityMin: 0.01,
    opacityMax: 0.055,
  },
  {
    position: [60, 150, 30],
    rotation: [-0.06, 0.15, 0.09],
    radiusTop: 3,
    radiusBottom: 55,
    height: 300,
    speed: 0.22,
    phase: 1.1,
    opacityMin: 0.015,
    opacityMax: 0.06,
  },
  {
    position: [220, 150, -120],
    rotation: [0.10, -0.08, 0.14],
    radiusTop: 1.5,
    radiusBottom: 33,
    height: 280,
    speed: 0.35,
    phase: 2.3,
    opacityMin: 0.01,
    opacityMax: 0.045,
  },
  {
    position: [-60, 150, 120],
    rotation: [-0.09, 0.05, -0.07],
    radiusTop: 2.5,
    radiusBottom: 48,
    height: 310,
    speed: 0.19,
    phase: 3.7,
    opacityMin: 0.012,
    opacityMax: 0.05,
  },
  {
    position: [140, 150, 100],
    rotation: [0.05, 0.12, 0.11],
    radiusTop: 2,
    radiusBottom: 38,
    height: 290,
    speed: 0.31,
    phase: 0.8,
    opacityMin: 0.01,
    opacityMax: 0.04,
  },
  {
    position: [-230, 150, 60],
    rotation: [0.12, -0.06, -0.10],
    radiusTop: 3,
    radiusBottom: 50,
    height: 300,
    speed: 0.25,
    phase: 5.1,
    opacityMin: 0.015,
    opacityMax: 0.055,
  },
  {
    position: [30, 150, -160],
    rotation: [-0.07, 0.09, 0.06],
    radiusTop: 1.5,
    radiusBottom: 30,
    height: 270,
    speed: 0.40,
    phase: 4.2,
    opacityMin: 0.008,
    opacityMax: 0.038,
  },
];

// Warm sunlight colour — yellow-white, matching the directional light in World3DCanvas
const RAY_COLOR = vec3(float(1.0), float(0.937), float(0.733)); // #ffeebb

function createRayMaterial(def: RayDef): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  // Pulsing opacity: maps sin output from [-1,1] to [opacityMin, opacityMax].
  // sin(time * speed + phase) => [−1, 1]
  // remapped => [0, 1] via .mul(0.5).add(0.5)
  // then scaled to [opacityMin, opacityMax]
  const sinWave = sin(time.mul(float(def.speed)).add(float(def.phase)));
  const normalized = sinWave.mul(float(0.5)).add(float(0.5)); // [0, 1]
  const range = def.opacityMax - def.opacityMin;
  const opacity = normalized.mul(float(range)).add(float(def.opacityMin));

  mat.colorNode = RAY_COLOR;
  mat.opacityNode = opacity;

  return mat;
}

// Single ray mesh — geometry + material created once in useMemo
function LightRay({ def }: { def: RayDef }) {
  const { geometry, material } = useMemo(() => {
    // 6 radial segments is enough for a soft cone — low polygon cost
    const geo = new THREE.CylinderGeometry(
      def.radiusTop,    // narrow end (top — near water surface)
      def.radiusBottom, // wide end (bottom — near seafloor)
      def.height,
      6,                // radial segments
      1,                // height segments
      true,             // openEnded — no caps, saves 2 faces and looks better
    );
    const mat = createRayMaterial(def);
    return { geometry: geo, material: mat };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — def is a static constant

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
      position={def.position}
      rotation={def.rotation}
      frustumCulled={false}
    />
  );
}

// ---------------------------------------------------------------------------
// Exported composite component — drop into SceneContents after UnderwaterAtmosphere
// ---------------------------------------------------------------------------
export default function UnderwaterLightRays() {
  return (
    <>
      {RAY_DEFS.map((def, i) => (
        <LightRay key={i} def={def} />
      ))}
    </>
  );
}
