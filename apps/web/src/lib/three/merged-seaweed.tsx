'use client';

import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { attribute, positionLocal, float, sin, vec3, time } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Merged Seaweed / Kelp Ground Cover
// ~1500 blade geometries baked into ONE BufferGeometry = 1 draw call
// Wind animation via TSL positionNode (GPU vertex shader, zero CPU cost)
// NO InstancedMesh — avoids Intel Iris Xe WebGPU crash
// ---------------------------------------------------------------------------

const BLADE_COUNT = 1500;
const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const HALF_MW = MAP_WIDTH / 2;
const HALF_MH = MAP_HEIGHT / 2;
const SPREAD_X = MAP_WIDTH * 2.2;
const SPREAD_Z = MAP_HEIGHT * 2.2;
const TILE_SIZE = 32;

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

/** Create a single curved seaweed blade geometry (5-segment strip) */
function createBladeGeometry(): THREE.BufferGeometry {
  const segs = 5;
  const width = 0.5;
  const height = 6;
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = t * height;
    const w = width * (1 - t * 0.7);
    const bendX = t * t * 1.5;

    vertices.push(-w + bendX, y, 0);
    vertices.push(w + bendX, y, 0);
  }

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
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

interface BladeData {
  x: number;
  z: number;
  rotY: number;
  scale: number;
  color: THREE.Color;
}

/** Generate blade placement data */
function generateBlades(): BladeData[] {
  const rng = seededRandom(77777);
  const blades: BladeData[] = [];
  let attempts = 0;

  while (blades.length < BLADE_COUNT && attempts < BLADE_COUNT * 3) {
    attempts++;
    const x = (rng() - 0.5) * SPREAD_X;
    const z = (rng() - 0.5) * SPREAD_Z;
    if (isNearBuilding(x, z)) continue;

    const baseColor = COLORS[Math.floor(rng() * COLORS.length)];
    const variation = 0.85 + rng() * 0.3;

    blades.push({
      x, z,
      rotY: rng() * Math.PI * 2,
      scale: 0.5 + rng() * 1.5,
      color: new THREE.Color(
        baseColor.r * variation,
        baseColor.g * variation,
        baseColor.b * variation,
      ),
    });
  }
  return blades;
}

/** Bake all blades into a single merged BufferGeometry with custom attributes */
function createMergedSeaweedGeometry(): THREE.BufferGeometry {
  const baseGeo = createBladeGeometry();
  const blades = generateBlades();
  const geometries: THREE.BufferGeometry[] = [];

  // Per-vertex custom attributes for the TSL vertex shader
  const allPhases: number[] = [];
  const allHeights: number[] = [];
  const allColors: number[] = [];

  const segs = 5;
  const vertsPerBlade = (segs + 1) * 2; // 12 vertices per blade

  for (const blade of blades) {
    const geo = baseGeo.clone();

    // Apply transform: position, rotation, scale
    const matrix = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, blade.rotY, 0));
    const s = new THREE.Vector3(blade.scale * 0.8, blade.scale, blade.scale * 0.8);
    const p = new THREE.Vector3(blade.x, 0, blade.z);
    matrix.compose(p, q, s);
    geo.applyMatrix4(matrix);

    // Bake per-vertex attributes
    for (let v = 0; v < vertsPerBlade; v++) {
      allPhases.push(blade.rotY); // Reuse rotation as phase offset
      // Height factor: 0 at base, 1 at tip
      const row = Math.floor(v / 2);
      allHeights.push(row / segs);
      // Vertex color with brightness gradient (darker at base, lighter at tip)
      const brightness = 0.5 + (row / segs) * 0.5;
      allColors.push(
        blade.color.r * brightness,
        blade.color.g * brightness,
        blade.color.b * brightness,
      );
    }

    geometries.push(geo);
  }

  const merged = mergeGeometries(geometries, false);
  if (!merged) {
    console.warn('[MergedSeaweed] mergeGeometries returned null');
    return new THREE.BufferGeometry();
  }

  // Attach custom attributes for TSL vertex shader
  merged.setAttribute('aPhase', new THREE.Float32BufferAttribute(allPhases, 1));
  merged.setAttribute('aHeight', new THREE.Float32BufferAttribute(allHeights, 1));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(allColors, 3));

  return merged;
}

// ---------------------------------------------------------------------------
// TSL Material — GPU wind animation via positionNode
// ---------------------------------------------------------------------------
function createSeaweedMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });

  // Read custom per-vertex attributes
  const phase = attribute('aPhase', 'float');
  const heightFactor = attribute('aHeight', 'float');

  // Wind sway — two sine waves at different frequencies for organic motion
  // heightFactor ensures base stays planted, tips sway most
  const swayX = sin(time.mul(float(0.8)).add(phase))
    .mul(heightFactor)
    .mul(float(1.2));
  const swayZ = sin(time.mul(float(1.3)).add(phase.mul(float(1.5))))
    .mul(heightFactor)
    .mul(float(0.6));

  // Displace vertices on the GPU — zero CPU cost per frame
  mat.positionNode = positionLocal.add(vec3(swayX, float(0), swayZ));

  return mat;
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------
export default function MergedSeaweed() {
  const { geometry, material } = useMemo(() => {
    const geo = createMergedSeaweedGeometry();
    const mat = createSeaweedMaterial();
    return { geometry: geo, material: mat };
  }, []);

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[0, -2, 0]}
      frustumCulled={false}
    />
  );
}
