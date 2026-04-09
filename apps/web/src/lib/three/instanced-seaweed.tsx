'use client';

import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Instanced Seaweed / Kelp Ground Cover
// ~4000 blade instances in 1 draw call via InstancedMesh
// Vertex-shader sway animation — rooted at base, swaying at tips
// Compatible with WebGL2 and WebGPU renderers
// ---------------------------------------------------------------------------

const BLADE_COUNT = 4000;
const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const TILE_SIZE = 32;
const HALF_MW = MAP_WIDTH / 2;
const HALF_MH = MAP_HEIGHT / 2;

// Spread seaweed across the full explorable area (matches arena-terrain)
const SPREAD_X = MAP_WIDTH * 2.4;
const SPREAD_Z = MAP_HEIGHT * 2.4;

// Building exclusion zones (tile coords -> world coords)
const BUILDING_ZONES = [
  { x: 5, y: 2, w: 4, h: 3 },
  { x: 17, y: 2, w: 4, h: 3 },
  { x: 29, y: 2, w: 4, h: 3 },
  { x: 2, y: 9, w: 4, h: 3 },
  { x: 12, y: 9, w: 3, h: 3 },
  { x: 21, y: 9, w: 3, h: 3 },
  { x: 31, y: 9, w: 4, h: 4 },
  { x: 5, y: 17, w: 4, h: 3 },
  { x: 17, y: 17, w: 4, h: 3 },
  { x: 29, y: 17, w: 3, h: 3 },
].map((z) => ({
  cx: -HALF_MW + (z.x + z.w / 2) * TILE_SIZE,
  cz: -HALF_MH + (z.y + z.h / 2) * TILE_SIZE,
  radius: Math.max(z.w, z.h) * TILE_SIZE * 0.7,
}));

function isNearBuilding(x: number, z: number): boolean {
  for (const b of BUILDING_ZONES) {
    const dx = x - b.cx;
    const dz = z - b.cz;
    if (dx * dx + dz * dz < b.radius * b.radius) return true;
  }
  return false;
}

/** Seeded PRNG for deterministic placement */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Palette of underwater greens/teals
const SEAWEED_COLORS = [
  new THREE.Color(0x1a6b3a),
  new THREE.Color(0x2d8a4e),
  new THREE.Color(0x4a7741),
  new THREE.Color(0x1a8a6a),
];

// ---------------------------------------------------------------------------
// GLSL Shaders
// No #version directive — Three.js prepends the correct one for the renderer.
// Uses standard Three.js ShaderMaterial built-ins (modelViewMatrix,
// projectionMatrix, position, uv) which work on both WebGL2 and WebGPU.
// ---------------------------------------------------------------------------

const vertexShader = /* glsl */ `
  // Per-instance attributes (via InstancedBufferAttribute)
  attribute vec3 aOffset;
  attribute float aScale;
  attribute float aPhase;
  attribute vec3 aColor;

  uniform float uTime;

  varying float vHeight;
  varying vec3 vColor;

  void main() {
    // uv.y = 0 at blade base, 1 at blade tip (PlaneGeometry default after shift)
    vHeight = uv.y;
    vColor = aColor;

    // Local vertex position
    vec3 pos = position;

    // Scale blade: height by aScale, width slightly thinner for tall blades
    pos.y *= aScale;
    pos.x *= (0.7 + aScale * 0.3);

    // Sway — amplitude increases with height squared (rooted at base)
    float swayAmount = vHeight * vHeight;

    // Primary sway: slow, large sinusoidal
    float sway1 = sin(uTime * 0.8 + aPhase) * 2.5 * swayAmount;
    // Secondary sway: faster, smaller (simulates current gusts)
    float sway2 = sin(uTime * 1.7 + aPhase * 1.3 + 2.0) * 0.8 * swayAmount;
    // Cross-axis sway for 3D natural feel
    float sway3 = cos(uTime * 0.6 + aPhase * 0.7) * 1.2 * swayAmount;

    pos.x += sway1 + sway2;
    pos.z += sway3;

    // Rotate blade around Y axis per-instance (deterministic from aPhase)
    float angle = aPhase * 3.0;
    float ca = cos(angle);
    float sa = sin(angle);
    vec3 rotated = vec3(
      pos.x * ca - pos.z * sa,
      pos.y,
      pos.x * sa + pos.z * ca
    );

    // Apply instance world offset (positioning done in shader, not instance matrix)
    vec3 worldPos = rotated + aOffset;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying float vHeight;
  varying vec3 vColor;

  void main() {
    // Darken base, lighten tips for underwater depth gradient
    vec3 color = vColor * (0.55 + 0.45 * vHeight);

    // Alpha gradient: fully opaque at base, fading toward tip
    float alpha = 1.0 - vHeight * vHeight * 0.7;

    // Hard discard for nearly invisible fragments (avoids blend artifacts)
    if (alpha < 0.05) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

// ---------------------------------------------------------------------------
// Per-instance data generation (runs once)
// ---------------------------------------------------------------------------

interface InstanceData {
  offsets: Float32Array;
  scales: Float32Array;
  phases: Float32Array;
  colors: Float32Array;
  count: number;
}

function generateInstanceData(): InstanceData {
  const rng = seededRandom(77777);
  const offsets: number[] = [];
  const scales: number[] = [];
  const phases: number[] = [];
  const colors: number[] = [];
  let placed = 0;
  let attempts = 0;
  const maxAttempts = BLADE_COUNT * 3;

  while (placed < BLADE_COUNT && attempts < maxAttempts) {
    attempts++;
    const x = (rng() - 0.5) * SPREAD_X;
    const z = (rng() - 0.5) * SPREAD_Z;

    if (isNearBuilding(x, z)) continue;

    // Y offset is 0 — the group position handles sand floor level
    offsets.push(x, 0, z);
    scales.push(0.4 + rng() * 1.2); // range 0.4 to 1.6
    phases.push(rng() * Math.PI * 2); // desync animation

    // Pick a color from the palette with slight random variation
    const baseColor = SEAWEED_COLORS[Math.floor(rng() * SEAWEED_COLORS.length)];
    const variation = 0.9 + rng() * 0.2; // 0.9-1.1 multiplier
    colors.push(
      baseColor.r * variation,
      baseColor.g * variation,
      baseColor.b * variation,
    );

    placed++;
  }

  return {
    offsets: new Float32Array(offsets),
    scales: new Float32Array(scales),
    phases: new Float32Array(phases),
    colors: new Float32Array(colors),
    count: placed,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function InstancedSeaweed() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  // Build geometry, material, and instance data once
  const { geometry, material, count } = useMemo(() => {
    // Blade: thin plane with 4 vertical subdivisions for smooth vertex bending
    const geo = new THREE.PlaneGeometry(0.6, 6, 1, 4);

    // Shift geometry so base sits at y=0, tip at y=6
    // (PlaneGeometry is centered at origin by default)
    const posAttr = geo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      posAttr.setY(i, posAttr.getY(i) + 3.0);
    }
    posAttr.needsUpdate = true;
    // UVs: uv.y=0 at bottom (base), uv.y=1 at top (tip) — correct by default

    // Generate per-instance data
    const data = generateInstanceData();

    // Attach instanced attributes to geometry
    geo.setAttribute(
      'aOffset',
      new THREE.InstancedBufferAttribute(data.offsets, 3),
    );
    geo.setAttribute(
      'aScale',
      new THREE.InstancedBufferAttribute(data.scales, 1),
    );
    geo.setAttribute(
      'aPhase',
      new THREE.InstancedBufferAttribute(data.phases, 1),
    );
    geo.setAttribute(
      'aColor',
      new THREE.InstancedBufferAttribute(data.colors, 3),
    );

    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
      },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });

    return { geometry: geo, material: mat, count: data.count };
  }, []);

  // Initialize all instance matrices to identity (positioning is in the shader)
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, identity);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [count]);

  // Per-frame: only update the time uniform (no matrix writes)
  useFrame((_, delta) => {
    material.uniforms.uTime.value += delta;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      position={[0, -2, 0]}
      frustumCulled={false}
    />
  );
}
