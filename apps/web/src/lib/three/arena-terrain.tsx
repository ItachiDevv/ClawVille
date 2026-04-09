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

// Sand colors for vertex color variation
const SAND_LIGHT = new THREE.Color(0xf0dfc0);
const SAND_MID   = new THREE.Color(0xe8d5b0);
const SAND_DARK  = new THREE.Color(0xc4a882);
const SAND_WET   = new THREE.Color(0xb09870);

/** Seeded PRNG for deterministic terrain */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Generate sand texture with grain + ripples for map/normalMap */
function createSandTexture(): { colorMap: THREE.CanvasTexture; normalMap: THREE.CanvasTexture } {
  const size = 1024;

  // --- Color map ---
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const ctx = colorCanvas.getContext('2d')!;
  ctx.fillStyle = '#e8d5b0';
  ctx.fillRect(0, 0, size, size);

  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;
  const heightMap = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const noise = (Math.random() - 0.5) * 35;
      const speckle = Math.random() < 0.03 ? -30 : 0;
      // Larger-scale variation using sine waves
      const largeNoise = Math.sin(x * 0.015) * Math.cos(y * 0.012) * 12;
      const ripple = Math.sin(x * 0.04 + y * 0.02) * 4;

      data[i]     = Math.max(0, Math.min(255, data[i] + noise + speckle + largeNoise));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise + speckle + largeNoise));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise * 0.8 + speckle + largeNoise * 0.6));

      heightMap[y * size + x] = noise + largeNoise + ripple;
    }
  }

  // Draw wave ripples
  ctx.putImageData(imageData, 0, 0);
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = '#c4a882';
  ctx.lineWidth = 1.5;
  for (let y = 10; y < size; y += 14 + Math.random() * 8) {
    ctx.beginPath();
    for (let x = 0; x < size; x += 3) {
      const wave = Math.sin(x * 0.025 + y * 0.08) * 3;
      if (x === 0) ctx.moveTo(x, y + wave);
      else ctx.lineTo(x, y + wave);
    }
    ctx.stroke();
  }

  const colorTex = new THREE.CanvasTexture(colorCanvas);
  colorTex.wrapS = THREE.RepeatWrapping;
  colorTex.wrapT = THREE.RepeatWrapping;
  colorTex.repeat.set(16, 10);

  // --- Normal map from height ---
  const normCanvas = document.createElement('canvas');
  normCanvas.width = size;
  normCanvas.height = size;
  const nCtx = normCanvas.getContext('2d')!;
  const normData = nCtx.createImageData(size, size);
  const nd = normData.data;
  const strength = 2.0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const l = heightMap[y * size + ((x - 1 + size) % size)];
      const r = heightMap[y * size + ((x + 1) % size)];
      const u = heightMap[((y - 1 + size) % size) * size + x];
      const d = heightMap[((y + 1) % size) * size + x];

      const dx = (l - r) * strength;
      const dy = (u - d) * strength;
      const i = idx * 4;
      nd[i]     = Math.max(0, Math.min(255, (dx * 0.5 + 0.5) * 255));
      nd[i + 1] = Math.max(0, Math.min(255, (dy * 0.5 + 0.5) * 255));
      nd[i + 2] = 255;
      nd[i + 3] = 255;
    }
  }
  nCtx.putImageData(normData, 0, 0);

  const normalTex = new THREE.CanvasTexture(normCanvas);
  normalTex.wrapS = THREE.RepeatWrapping;
  normalTex.wrapT = THREE.RepeatWrapping;
  normalTex.repeat.set(16, 10);

  return { colorMap: colorTex, normalMap: normalTex };
}

/** Build subdivided sand plane with vertex displacement and per-vertex colors */
function createSandGeometry(): THREE.PlaneGeometry {
  const w = MAP_WIDTH * 3;
  const h = MAP_HEIGHT * 3;
  const segsX = 100;
  const segsY = 66;
  const geo = new THREE.PlaneGeometry(w, h, segsX, segsY);

  const pos = geo.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const rng = seededRandom(42);
  const tmpColor = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);

    // Gentle sand dune displacement (applied to Z since plane is XY before rotation)
    const dune1 = Math.sin(x * 0.008 + 1.3) * Math.cos(y * 0.012 + 0.7) * 3;
    const dune2 = Math.sin(x * 0.018 + 3.1) * Math.sin(y * 0.022 + 2.4) * 1.5;
    const ripple = Math.sin(x * 0.05) * Math.cos(y * 0.04) * 0.5;
    const noise = (rng() - 0.5) * 0.8;
    pos.setZ(i, dune1 + dune2 + ripple + noise);

    // Per-vertex color: lerp between sand tones based on height + noise
    const heightFactor = (dune1 + dune2 + 5) / 10; // ~0..1
    const noiseFactor = rng();
    if (noiseFactor < 0.15) {
      tmpColor.copy(SAND_WET);
    } else if (heightFactor > 0.65) {
      tmpColor.lerpColors(SAND_MID, SAND_LIGHT, (heightFactor - 0.65) / 0.35);
    } else {
      tmpColor.lerpColors(SAND_DARK, SAND_MID, heightFactor / 0.65);
    }
    // Add slight random variation
    const jitter = (rng() - 0.5) * 0.04;
    tmpColor.r = Math.max(0, Math.min(1, tmpColor.r + jitter));
    tmpColor.g = Math.max(0, Math.min(1, tmpColor.g + jitter));
    tmpColor.b = Math.max(0, Math.min(1, tmpColor.b + jitter * 0.6));

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
  const textures = useMemo(() => {
    if (typeof document === 'undefined') return null;
    return createSandTexture();
  }, []);

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
      {textures ? (
        <meshStandardMaterial
          map={textures.colorMap}
          normalMap={textures.normalMap}
          normalScale={new THREE.Vector2(0.4, 0.4)}
          vertexColors
          roughness={0.85}
          metalness={0.0}
        />
      ) : (
        <meshStandardMaterial color={0xe8d5b0} roughness={0.85} metalness={0.0} />
      )}
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

// All available decoration models with their spawn weights and scale ranges
const DECO_TYPES = [
  // Coral — common, spread everywhere
  { model: '/models/coral-reef1.glb', weight: 5, minScale: 2.5, maxScale: 5 },
  { model: '/models/coral-reef2.glb', weight: 5, minScale: 2.5, maxScale: 4.5 },
  { model: '/models/coral-reef3.glb', weight: 5, minScale: 2.5, maxScale: 4.5 },
  // Kelp — common, tall
  { model: '/models/kelp.glb', weight: 6, minScale: 3.5, maxScale: 6 },
  // Small props — less common
  { model: '/models/building-anchor.glb', weight: 2, minScale: 1.5, maxScale: 2.5 },
  { model: '/models/building-barrel.glb', weight: 2, minScale: 1.5, maxScale: 2.5 },
  { model: '/models/building-chest.glb', weight: 1, minScale: 1.2, maxScale: 2 },
  // Unused models now included
  { model: '/models/building-shell.glb', weight: 2, minScale: 1.5, maxScale: 3 },
  { model: '/models/building-lantern.glb', weight: 2, minScale: 2, maxScale: 3.5 },
  { model: '/models/crayfish.glb', weight: 1, minScale: 2, maxScale: 4 },
  // Large distant scenery
  { model: '/models/building-shipwreck.glb', weight: 0.5, minScale: 0.3, maxScale: 0.6 },
  { model: '/models/building-submarine.glb', weight: 0.5, minScale: 0.3, maxScale: 0.5 },
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
  const TARGET_COUNT = 50;

  // Pick a model based on weighted random
  function pickModel() {
    let r = rng() * totalWeight;
    for (const dt of DECO_TYPES) {
      r -= dt.weight;
      if (r <= 0) return dt;
    }
    return DECO_TYPES[0];
  }

  // Generate decorations spread across the full map
  let attempts = 0;
  while (entries.length < TARGET_COUNT && attempts < 300) {
    attempts++;
    const x = (rng() - 0.5) * MAP_WIDTH * 2.2;  // Extended beyond map for edges
    const z = (rng() - 0.5) * MAP_HEIGHT * 2.2;

    // Skip if too close to a building
    if (isNearBuilding(x, z)) continue;

    // Skip if too close to existing decoration (min 50px apart)
    const tooClose = entries.some(e => {
      const dx = e.x - x;
      const dz = e.z - z;
      return dx * dx + dz * dz < 50 * 50;
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
