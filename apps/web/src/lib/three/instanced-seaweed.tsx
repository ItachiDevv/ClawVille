'use client';

import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Instanced Seaweed / Kelp Ground Cover
// ~3000 blade instances in 1 draw call via InstancedMesh
// Uses MeshBasicMaterial with vertexColors (WebGPU + WebGL2 safe)
// Animation via gentle instance matrix Y-rotation over time
// ---------------------------------------------------------------------------

const BLADE_COUNT = 3000;
const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const TILE_SIZE = 32;
const HALF_MW = MAP_WIDTH / 2;
const HALF_MH = MAP_HEIGHT / 2;
const SPREAD_X = MAP_WIDTH * 2.2;
const SPREAD_Z = MAP_HEIGHT * 2.2;

// Building exclusion zones
const BUILDING_ZONES = [
  { x: 5, y: 2, w: 4, h: 3 }, { x: 17, y: 2, w: 4, h: 3 }, { x: 29, y: 2, w: 4, h: 3 },
  { x: 2, y: 9, w: 4, h: 3 }, { x: 12, y: 9, w: 3, h: 3 }, { x: 21, y: 9, w: 3, h: 3 },
  { x: 31, y: 9, w: 4, h: 4 }, { x: 5, y: 17, w: 4, h: 3 }, { x: 17, y: 17, w: 4, h: 3 },
  { x: 29, y: 17, w: 3, h: 3 },
].map((z) => ({
  cx: -HALF_MW + (z.x + z.w / 2) * TILE_SIZE,
  cz: -HALF_MH + (z.y + z.h / 2) * TILE_SIZE,
  radius: Math.max(z.w, z.h) * TILE_SIZE * 0.8,
}));

function isNearBuilding(x: number, z: number): boolean {
  for (const b of BUILDING_ZONES) {
    const dx = x - b.cx;
    const dz = z - b.cz;
    if (dx * dx + dz * dz < b.radius * b.radius) return true;
  }
  return false;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Underwater color palette
const COLORS = [
  new THREE.Color(0x1a6b3a), // Deep green
  new THREE.Color(0x2d8a4e), // Mid green
  new THREE.Color(0x4a7741), // Olive green
  new THREE.Color(0x1a8a6a), // Teal
  new THREE.Color(0x3a9960), // Bright green
];

/** Create a curved seaweed blade geometry with baked vertex colors */
function createBladeGeometry(): THREE.BufferGeometry {
  const segs = 5;
  const width = 0.5;
  const height = 6;
  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Build a strip of quads from base (y=0) to tip (y=height)
  for (let i = 0; i <= segs; i++) {
    const t = i / segs; // 0 at base, 1 at tip
    const y = t * height;
    // Blade narrows toward tip
    const w = width * (1 - t * 0.7);
    // Pre-baked curve — blade bends outward at tip
    const bendX = t * t * 1.5;

    vertices.push(-w + bendX, y, 0);
    vertices.push(w + bendX, y, 0);

    // Color gradient: darker at base, lighter at tip
    const brightness = 0.5 + t * 0.5;
    colors.push(brightness, brightness, brightness);
    colors.push(brightness, brightness, brightness);
  }

  // Build triangle indices
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b);
    indices.push(b, c, d);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Generate instance transforms */
interface BladeInstance {
  x: number;
  z: number;
  rotY: number;
  scale: number;
  colorMul: THREE.Color;
}

function generateBlades(): BladeInstance[] {
  const rng = seededRandom(77777);
  const blades: BladeInstance[] = [];
  let attempts = 0;

  while (blades.length < BLADE_COUNT && attempts < BLADE_COUNT * 3) {
    attempts++;
    const x = (rng() - 0.5) * SPREAD_X;
    const z = (rng() - 0.5) * SPREAD_Z;
    if (isNearBuilding(x, z)) continue;

    const baseColor = COLORS[Math.floor(rng() * COLORS.length)];
    const variation = 0.85 + rng() * 0.3;

    blades.push({
      x,
      z,
      rotY: rng() * Math.PI * 2,
      scale: 0.5 + rng() * 1.5,
      colorMul: new THREE.Color(
        baseColor.r * variation,
        baseColor.g * variation,
        baseColor.b * variation,
      ),
    });
  }
  return blades;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function InstancedSeaweed() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const { geometry, blades } = useMemo(() => {
    const geo = createBladeGeometry();
    const b = generateBlades();
    return { geometry: geo, blades: b };
  }, []);

  // Set instance matrices and colors once
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < blades.length; i++) {
      const blade = blades[i];
      dummy.position.set(blade.x, 0, blade.z);
      dummy.rotation.set(0, blade.rotY, 0);
      dummy.scale.set(blade.scale * 0.8, blade.scale, blade.scale * 0.8);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, blade.colorMul);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [blades]);

  // Gentle sway animation — rotate batches of instances slightly over time
  // Only update a subset each frame to keep CPU cost low
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const frameRef = useRef(0);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    frameRef.current++;
    // Update 200 blades per frame in a rolling window (full cycle every 15 frames)
    const batchSize = 200;
    const startIdx = (frameRef.current * batchSize) % blades.length;
    const endIdx = Math.min(startIdx + batchSize, blades.length);
    const t = clock.elapsedTime;

    for (let i = startIdx; i < endIdx; i++) {
      const blade = blades[i];
      const phase = blade.rotY; // Use original rotation as phase offset
      const sway = Math.sin(t * 0.8 + phase) * 0.15 + Math.sin(t * 1.3 + phase * 1.5) * 0.08;

      dummy.position.set(blade.x, 0, blade.z);
      dummy.rotation.set(sway * 0.5, blade.rotY + sway, 0);
      dummy.scale.set(blade.scale * 0.8, blade.scale, blade.scale * 0.8);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, undefined, blades.length]}
      position={[0, -2, 0]}
      frustumCulled={false}
    >
      <meshBasicMaterial
        vertexColors
        side={THREE.DoubleSide}
        transparent
        opacity={0.85}
        depthWrite={false}
      />
    </instancedMesh>
  );
}
