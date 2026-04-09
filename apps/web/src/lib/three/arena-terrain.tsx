'use client';

import { Suspense, useEffect, useRef, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Terrain: Bikini Bottom GLB + sand floor + coral/kelp decorations
// ---------------------------------------------------------------------------

export const TERRAIN_LAYER = 1;

// bikini-bottom.glb REMOVED — it contained duplicate buildings (Krusty Krab,
// Pineapple, Squidward's, Patrick's Rock) baked into one scene, overlapping
// with our individual building GLBs. Sand floor + individual buildings is cleaner.
useGLTF.preload('/models/coral-reef1.glb');
useGLTF.preload('/models/coral-reef2.glb');
useGLTF.preload('/models/coral-reef3.glb');
useGLTF.preload('/models/kelp.glb');
// Border decorations — old generic buildings repurposed as scenery
useGLTF.preload('/models/building-lighthouse.glb');
useGLTF.preload('/models/building-shipwreck.glb');
useGLTF.preload('/models/building-submarine.glb');
useGLTF.preload('/models/building-tower2.glb');
useGLTF.preload('/models/building-seashell.glb');
useGLTF.preload('/models/building-anchor.glb');
useGLTF.preload('/models/building-barrel.glb');
useGLTF.preload('/models/building-chest.glb');

const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;

// Sand colors — GRAPHIC high-contrast palette, visible from any camera distance
const SAND_RIDGE  = new THREE.Color(0xfff0d4); // Bright white-sand peaks
const SAND_HIGH   = new THREE.Color(0xe8d0a8); // Warm sand
const SAND_MID    = new THREE.Color(0xc4a878); // Golden mid-tone
const SAND_VALLEY = new THREE.Color(0x8a7050); // Dark moody valleys
const SAND_DEEP   = new THREE.Color(0x5c4a32); // Deep brown-black troughs

/** Seeded PRNG for deterministic terrain */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Build subdivided sand plane with LARGE visible dunes and strong per-vertex colors */
function createSandGeometry(): THREE.PlaneGeometry {
  const w = MAP_WIDTH * 3;
  const h = MAP_HEIGHT * 3;
  const segsX = 120;
  const segsY = 80;
  const geo = new THREE.PlaneGeometry(w, h, segsX, segsY);

  const pos = geo.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const rng = seededRandom(42);
  const tmpColor = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);

    // Large dramatic dunes with multiple octaves
    const dune1 = Math.sin(x * 0.004 + 1.3) * Math.cos(y * 0.006 + 0.7) * 14;
    const dune2 = Math.sin(x * 0.01 + 3.1) * Math.sin(y * 0.013 + 2.4) * 8;
    const dune3 = Math.sin(x * 0.025 + 0.5) * Math.cos(y * 0.03 + 1.2) * 4;
    // Visible sand ripple pattern — tighter frequency, adds texture detail
    const ripple = Math.sin(x * 0.08 + y * 0.06) * 2;
    const ripple2 = Math.sin(x * 0.12 - y * 0.09) * 1;
    const noise = (rng() - 0.5) * 1.5;
    const totalHeight = dune1 + dune2 + dune3 + ripple + ripple2 + noise;
    pos.setZ(i, totalHeight);

    // GRAPHIC color bands — sharp contrast between heights
    // Heights range roughly -28 to +28, normalize to 0..1
    const t = Math.max(0, Math.min(1, (totalHeight + 28) / 56));

    if (t < 0.15) {
      tmpColor.lerpColors(SAND_DEEP, SAND_VALLEY, t / 0.15);
    } else if (t < 0.35) {
      tmpColor.lerpColors(SAND_VALLEY, SAND_MID, (t - 0.15) / 0.2);
    } else if (t < 0.55) {
      tmpColor.lerpColors(SAND_MID, SAND_HIGH, (t - 0.35) / 0.2);
    } else if (t < 0.8) {
      tmpColor.lerpColors(SAND_HIGH, SAND_RIDGE, (t - 0.55) / 0.25);
    } else {
      tmpColor.copy(SAND_RIDGE);
    }

    // Scattered dark wet patches for visual interest
    if (rng() < 0.1) {
      tmpColor.lerp(SAND_DEEP, 0.5);
    }
    // Occasional bright spots
    if (rng() < 0.05) {
      tmpColor.lerp(SAND_RIDGE, 0.3);
    }

    colors[i * 3] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function SandFloor() {
  const ref = useRef<THREE.Mesh>(null);
  const sandGeo = useMemo(() => createSandGeometry(), []);

  useEffect(() => {
    if (ref.current) ref.current.layers.enable(TERRAIN_LAYER);
  }, []);

  return (
    <mesh
      ref={ref}
      geometry={sandGeo}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -2, 0]}
    >
      <meshStandardMaterial
        vertexColors
        roughness={0.8}
        metalness={0.0}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Procedural decoration placement across the full map
// Uses seeded RNG for deterministic placement, avoids building zones
// ---------------------------------------------------------------------------
interface DecoEntry {
  model: string;
  x: number;
  z: number;
  scale: number;
  rotY: number;
}

// Decoration models — scales must be LARGE LANDMARKS visible from default camera
const DECO_TYPES = [
  // Coral — tall reef formations, almost building-sized
  { model: '/models/coral-reef1.glb', weight: 5, minScale: 10, maxScale: 20 },
  { model: '/models/coral-reef2.glb', weight: 5, minScale: 10, maxScale: 18 },
  { model: '/models/coral-reef3.glb', weight: 5, minScale: 10, maxScale: 18 },
  // Kelp — tall forest columns, biggest decorations
  { model: '/models/kelp.glb', weight: 7, minScale: 14, maxScale: 25 },
  // Props — clearly visible objects
  { model: '/models/building-anchor.glb', weight: 2, minScale: 5, maxScale: 8 },
  { model: '/models/building-barrel.glb', weight: 2, minScale: 5, maxScale: 8 },
  { model: '/models/building-shell.glb', weight: 3, minScale: 6, maxScale: 12 },
  { model: '/models/building-lantern.glb', weight: 2, minScale: 6, maxScale: 10 },
  { model: '/models/crayfish.glb', weight: 2, minScale: 6, maxScale: 12 },
  // Large set pieces — shipwrecks and submarines as real landmarks
  { model: '/models/building-shipwreck.glb', weight: 1, minScale: 1.0, maxScale: 2.0 },
  { model: '/models/building-submarine.glb', weight: 1, minScale: 0.8, maxScale: 1.5 },
  { model: '/models/building-seashell.glb', weight: 2, minScale: 5, maxScale: 10 },
  { model: '/models/building-tower2.glb', weight: 1, minScale: 3, maxScale: 6 },
];

// Preload new decoration models
useGLTF.preload('/models/building-shell.glb');
useGLTF.preload('/models/building-lantern.glb');
useGLTF.preload('/models/crayfish.glb');

// Building exclusion zones (world coords) — no decorations within 80px of building center
const TILE_SIZE = 32;
const HALF_MW = MAP_WIDTH / 2;
const HALF_MH = MAP_HEIGHT / 2;
const BUILDING_ZONES = [
  { x: 5, y: 2, w: 4, h: 3 }, { x: 17, y: 2, w: 4, h: 3 }, { x: 29, y: 2, w: 4, h: 3 },
  { x: 2, y: 9, w: 4, h: 3 }, { x: 12, y: 9, w: 3, h: 3 }, { x: 21, y: 9, w: 3, h: 3 },
  { x: 31, y: 9, w: 4, h: 4 }, { x: 5, y: 17, w: 4, h: 3 }, { x: 17, y: 17, w: 4, h: 3 },
  { x: 29, y: 17, w: 3, h: 3 },
].map(z => ({
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

/** Generate all decorations procedurally with seeded RNG */
function generateDecorations(): DecoEntry[] {
  const rng = seededRandom(12345);
  const totalWeight = DECO_TYPES.reduce((s, d) => s + d.weight, 0);
  const entries: DecoEntry[] = [];
  const TARGET_COUNT = 80;

  // Pick a model based on weighted random
  function pickModel() {
    let r = rng() * totalWeight;
    for (const dt of DECO_TYPES) {
      r -= dt.weight;
      if (r <= 0) return dt;
    }
    return DECO_TYPES[0];
  }

  // Generate decorations spread across the full map — dense enough to feel populated
  let attempts = 0;
  while (entries.length < TARGET_COUNT && attempts < 500) {
    attempts++;
    const x = (rng() - 0.5) * MAP_WIDTH * 2.4;
    const z = (rng() - 0.5) * MAP_HEIGHT * 2.4;

    // Skip if too close to a building
    if (isNearBuilding(x, z)) continue;

    // Min 40px apart — tighter spacing for denser coverage
    const tooClose = entries.some(e => {
      const dx = e.x - x;
      const dz = e.z - z;
      return dx * dx + dz * dz < 40 * 40;
    });
    if (tooClose) continue;

    const dt = pickModel();
    const scale = dt.minScale + rng() * (dt.maxScale - dt.minScale);
    entries.push({ model: dt.model, x, z, scale, rotY: rng() * Math.PI * 2 });
  }

  return entries;
}

const DECORATIONS: DecoEntry[] = generateDecorations();

function SingleDecoration({ entry }: { entry: DecoEntry }) {
  const { scene } = useGLTF(entry.model);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  return (
    <primitive
      object={cloned}
      position={[entry.x, -2, entry.z]}
      scale={entry.scale}
      rotation={[0, entry.rotY, 0]}
    />
  );
}

function UnderwaterDecorations() {
  return (
    <group>
      {DECORATIONS.map((entry, i) => (
        <SingleDecoration key={i} entry={entry} />
      ))}
    </group>
  );
}

export default function ArenaTerrain() {
  return (
    <Suspense fallback={null}>
      <SandFloor />
      <UnderwaterDecorations />
    </Suspense>
  );
}
