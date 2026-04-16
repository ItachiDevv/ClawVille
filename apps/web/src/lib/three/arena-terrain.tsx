'use client';

import { Suspense, useEffect, useRef, useMemo, type ReactElement } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import {
  float, vec3, sin, cos, fract,
  positionLocal, vertexColor,
  mix, smoothstep,
} from 'three/tsl';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Terrain: Bikini Bottom GLB + sand floor + coral/kelp decorations
// ---------------------------------------------------------------------------

export const TERRAIN_LAYER = 1;

// bikini-bottom.glb REMOVED — it contained duplicate buildings (Krusty Krab,
// Pineapple, Squidward's, Patrick's Rock) baked into one scene, overlapping
// with our individual building GLBs. Sand floor + individual buildings is cleaner.
//
// Decoration preloads have been MOVED to DeferredTerrainPreloads (exported below).
// They are fired via requestAnimationFrame after first paint from the game page,
// so they don't delay the initial scene mount.  The Suspense fallback={null} wrapper
// on ArenaTerrain means decorations simply render nothing until the assets resolve.

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
  const segsY = 120;
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

// ---------------------------------------------------------------------------
// TSL sand ripple helper — fract(sin(dot)) hash gives cheap 2D noise
// ---------------------------------------------------------------------------
function createSandMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    metalness: 0.0,
  });

  // World-space XZ position of each fragment (before the -PI/2 rotation the
  // mesh applies, positionLocal.xz gives us the geometry's pre-rotation XY —
  // that's fine for a purely procedural pattern).
  const px = positionLocal.x;
  const py = positionLocal.y; // geometry Y = world Z before rotation

  // ---- Sand ripple pattern ----
  // Two overlapping sine waves at different angles simulate wind-blown ripples.
  const rippleA = sin(px.mul(float(0.07)).add(py.mul(float(0.05))));
  const rippleB = sin(px.mul(float(0.11)).sub(py.mul(float(0.08))).add(float(2.3)));
  // Combine and remap to [0, 1]
  const ripple = rippleA.add(rippleB).mul(float(0.25)).add(float(0.5));

  // ---- Cheap 2D hash for grain noise ----
  // fract(sin(dot(floor(p * scale), vec2(127.1, 311.7))) * 43758.5453)
  // We approximate with two orthogonal high-freq sines combined via fract.
  const grainScale = float(3.7);
  const grainA = sin(px.mul(grainScale).add(py.mul(float(7.3))));
  const grainB = sin(px.mul(float(5.1)).sub(py.mul(grainScale.mul(float(1.9)))));
  const grain = fract(grainA.add(grainB).mul(float(43.758)));

  // ---- Height-based color blend ----
  // positionLocal.z holds the displaced height baked by createSandGeometry.
  // Range is roughly -28..+28 → normalise to 0..1
  const h = positionLocal.z;
  const heightT = smoothstep(float(-28.0), float(28.0), h);

  // Warm ridge tone vs cool deep-water valley tone
  const warmSand = vec3(float(1.0), float(0.91), float(0.78));   // near-white peaks
  const coolDeep = vec3(float(0.25), float(0.19), float(0.12));  // dark wet valley

  // Blend vertex color with the height-driven warm/cool tint
  const heightTint = mix(coolDeep, warmSand, heightT);
  const baseColor = vertexColor();

  // Mix vertex color with height tint (keep vertex color dominant)
  const tintStrength = float(0.28);
  const blendedColor = mix(baseColor, heightTint, tintStrength);

  // Ripple pattern darkens the color slightly in troughs (multiply)
  const rippleMul = ripple.mul(float(0.18)).add(float(0.82));

  // Grain adds a very subtle speckling
  const grainMul = grain.mul(float(0.06)).add(float(0.97));

  mat.colorNode = blendedColor.mul(rippleMul).mul(grainMul);

  // ---- Roughness: valleys are smoother (wet), ridges rougher (dry sand) ----
  // heightT=0 → valley (smoother ~0.55), heightT=1 → ridge (rougher ~0.92)
  mat.roughnessNode = mix(float(0.55), float(0.92), heightT);

  // ---- Normal perturbation — sand grain feel ----
  // Perturb the flat normals with a sin-based bump in XY, scaled very small
  const bumpFreq = float(0.15);
  const bumpAmp  = float(0.04);
  const bumpX = sin(px.mul(bumpFreq).add(float(1.1))).mul(bumpAmp);
  const bumpY = cos(py.mul(bumpFreq).add(float(0.7))).mul(bumpAmp);
  // vec3(perturbX, perturbY, 1) normalised approximation — sufficient at low amp
  const perturbedNormal = vec3(bumpX, bumpY, float(1.0));
  mat.normalNode = perturbedNormal;

  return mat;
}

function SandFloor() {
  const ref = useRef<THREE.Mesh>(null);
  const sandGeo = useMemo(() => createSandGeometry(), []);
  const sandMat = useMemo(() => createSandMaterial(), []);

  useEffect(() => {
    if (ref.current) ref.current.layers.enable(TERRAIN_LAYER);
    // Dispose both geometry and material on unmount to prevent GPU memory leaks.
    // sandGeo is a large subdivided plane (120×120 segs = ~14400 quads).
    return () => {
      sandGeo.dispose();
      sandMat.dispose();
    };
  }, [sandGeo, sandMat]);

  return (
    <mesh
      ref={ref}
      geometry={sandGeo}
      material={sandMat}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -2, 0]}
    />
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

// Decoration models — scale ranges capped to keep max dimension ≤ 150 world units.
// Rationale: at perspective from origin, a 600-unit wide coral cluster at distance
// 3000-5000 dominates the view even though it's outside the village ring.
// Coral/kelp native bboxes are ~5-10 units wide/tall; cap at 15 → max ~150 wu.
// Shell/seashell native bboxes ~3-5 units; cap at 15 → max ~75 wu.
// Small props (anchor, barrel, chest, lantern, tower2) already safe at their caps.
const DECO_TYPES = [
  // Coral — moderate presence, capped at 15 to prevent 500+ wu wide clusters
  { model: '/models/coral-reef1.glb', weight: 3, minScale: 4,   maxScale: 15  },
  { model: '/models/coral-reef2.glb', weight: 3, minScale: 3,   maxScale: 13  },
  { model: '/models/coral-reef3.glb', weight: 3, minScale: 3,   maxScale: 12  },
  // Kelp — tall accent, capped at 15 (was 30; was producing 600+ wu wide blades)
  { model: '/models/kelp.glb',        weight: 3, minScale: 6,   maxScale: 15  },
  // Shells — clusters of tiny to medium (was maxScale 18-20, now 12)
  { model: '/models/building-shell.glb',    weight: 5, minScale: 2,   maxScale: 12  },
  { model: '/models/building-seashell.glb', weight: 5, minScale: 2,   maxScale: 12  },
  // Anchors — scattered singles, small to moderate
  { model: '/models/building-anchor.glb', weight: 4, minScale: 3,   maxScale: 14  },
  // Barrels — common ocean-floor clutter
  { model: '/models/building-barrel.glb', weight: 4, minScale: 3,   maxScale: 10  },
  // Chests — treasure accents
  { model: '/models/building-chest.glb',  weight: 4, minScale: 3,   maxScale: 12  },
  // Lanterns — ambient glow props, small to medium
  { model: '/models/building-lantern.glb', weight: 3, minScale: 4,  maxScale: 12  },
  // Crayfish — scattered critters, small
  { model: '/models/crayfish.glb',         weight: 3, minScale: 3,  maxScale: 10  },
  // Tower2 — distinctive landmark towers, rare
  { model: '/models/building-tower2.glb',  weight: 2, minScale: 4,  maxScale: 14  },
  // Shipwrecks and submarines are placed as FIXED LANDMARKS below (not scattered)
  // so they always appear in visually meaningful spots rather than random.
];

// All decoration preloads have been moved to DeferredTerrainPreloads() below.

// Building exclusion zones (world coords) — no decorations within 80px of building center
const HALF_MW = MAP_WIDTH / 2;
const HALF_MH = MAP_HEIGHT / 2;
// Derive exclusion zones from canonical tilemap-data buildingZones (single source of truth)
const BUILDING_ZONES = buildingZones.map(z => ({
  cx: -HALF_MW + (z.x + z.width / 2) * TILE_SIZE,
  cz: -HALF_MH + (z.y + z.height / 2) * TILE_SIZE,
  radius: Math.max(z.width, z.height) * TILE_SIZE * 2.0,
}));

function isNearBuilding(x: number, z: number): boolean {
  for (const b of BUILDING_ZONES) {
    const dx = x - b.cx;
    const dz = z - b.cz;
    if (dx * dx + dz * dz < b.radius * b.radius) return true;
  }
  return false;
}

// Village center world coordinates: center tile (80, 80) in 160×160 grid
// worldX = -HALF_MW + 80*TILE_SIZE = -2560 + 2560 = 0
// worldZ = -HALF_MH + 80*TILE_SIZE = -2560 + 2560 = 0
const VILLAGE_CX = 0;
const VILLAGE_CZ = 0;
// No decorations within this radius of village center — keeps the town plaza and ring clear.
// Increased from 600→2300 (2026-04-16): ring buildings sit at radius 1792 (56 tiles × 32);
// 2300 = 1792 + ~224 (one building zone, 7 tiles × 32) + buffer. Decorations now scatter
// in the annulus outside the ring, not through it.
const DECO_INNER_EXCLUSION_R = 2300;

/** Generate all decorations with cluster-based organic scatter.
 *
 *  Algorithm (mirrors the merged-seaweed multivariant pattern):
 *  1. Generate N_CLUSTERS cluster centres spread across the full map extents.
 *  2. For each decoration attempt, pick a random cluster centre.
 *  3. Sample distance from that centre using a triangular distribution
 *     (rng() + rng()) * CLUSTER_RADIUS — biases placements toward the centre,
 *     producing Gaussian-like falloff without an actual Gaussian.
 *  4. Reject if inside the inner village exclusion zone or a building zone.
 *
 *  This creates natural dense patches with sparse gaps between them instead of
 *  the uniform "salt-and-pepper" look of pure random placement.
 */
function generateDecorations(): DecoEntry[] {
  const rng = seededRandom(12345);
  const totalWeight = DECO_TYPES.reduce((s, d) => s + d.weight, 0);
  const entries: DecoEntry[] = [];
  // Keep at 80 to maintain FPS on Intel Iris Xe — the larger map doesn't need
  // more decorations because the camera view frustum is the same size.
  const TARGET_COUNT = 80;

  // Map extents — auto-scales with MAP_WIDTH/MAP_HEIGHT imports
  const EXTENT_X = MAP_WIDTH  * 2.4;
  const EXTENT_Z = MAP_HEIGHT * 2.4;

  // ---- Cluster centres ----
  // Keep at 24 clusters — same density, just spread across larger area
  const N_CLUSTERS    = 24;
  const CLUSTER_RADIUS = 280; // world-space units; controls patch spread
  const clusters: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < N_CLUSTERS; i++) {
    clusters.push({
      x: (rng() - 0.5) * EXTENT_X,
      z: (rng() - 0.5) * EXTENT_Z,
    });
  }

  // Pick a model based on weighted random
  function pickModel() {
    let r = rng() * totalWeight;
    for (const dt of DECO_TYPES) {
      r -= dt.weight;
      if (r <= 0) return dt;
    }
    return DECO_TYPES[0];
  }

  // Minimum spacing between decorations — tighter than before for denser look
  const MIN_SPACING_SQ = 35 * 35;

  let attempts = 0;
  while (entries.length < TARGET_COUNT && attempts < 1200) {
    attempts++;

    // Pick a random cluster centre
    const cluster = clusters[Math.floor(rng() * N_CLUSTERS)];

    // Triangular distribution for distance: (rng()+rng()) biases toward 0
    const dist  = (rng() + rng()) * CLUSTER_RADIUS;
    const angle = rng() * Math.PI * 2;
    const x = cluster.x + Math.cos(angle) * dist;
    const z = cluster.z + Math.sin(angle) * dist;

    // Clamp to map extents so nothing spawns off the sand plane
    if (Math.abs(x) > EXTENT_X * 0.5 || Math.abs(z) > EXTENT_Z * 0.5) continue;

    // Skip if inside the inner village plaza — keep the town center clear
    const dcx = x - VILLAGE_CX;
    const dcz = z - VILLAGE_CZ;
    if (dcx * dcx + dcz * dcz < DECO_INNER_EXCLUSION_R * DECO_INNER_EXCLUSION_R) continue;

    // Skip if inside a building exclusion zone
    if (isNearBuilding(x, z)) continue;

    // Minimum spacing check
    const tooClose = entries.some(e => {
      const dx = e.x - x;
      const dz = e.z - z;
      return dx * dx + dz * dz < MIN_SPACING_SQ;
    });
    if (tooClose) continue;

    const dt    = pickModel();
    const scale = dt.minScale + rng() * (dt.maxScale - dt.minScale);
    entries.push({ model: dt.model, x, z, scale, rotY: rng() * Math.PI * 2 });
  }

  return entries;
}

const DECORATIONS: DecoEntry[] = generateDecorations();

/** Recursively dispose all geometries and materials in a cloned THREE.Object3D tree. */
function disposeClone(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else {
        mesh.material?.dispose();
      }
    }
  });
}

function SingleDecoration({ entry }: { entry: DecoEntry }) {
  const { scene } = useGLTF(entry.model);
  const cloned = useMemo(() => scene.clone(true), [scene]);

  // Dispose cloned scene geometry + materials on unmount to prevent GPU leaks.
  // scene.clone(true) deep-clones all child geometries and materials, so they
  // must be manually disposed — R3F does not know about them.
  useEffect(() => () => disposeClone(cloned), [cloned]);

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

// ---------------------------------------------------------------------------
// UnderwaterDecorationsGlb — places the 6MB underwater-decorations.glb as a
// single scene primitive. It provides dense sea-floor props in one draw call,
// in addition to the procedurally-scattered individual decorations above.
// Positioned OUTSIDE the village ring so it doesn't clutter the town center.
// ---------------------------------------------------------------------------
function UnderwaterDecorationsGlb() {
  const { scene } = useGLTF('/models/underwater-decorations.glb');
  // Clone once so we own the scene (avoid mutating the cached original)
  const cloned = useMemo(() => scene.clone(true), [scene]);

  useEffect(() => () => disposeClone(cloned), [cloned]);

  return (
    <primitive
      object={cloned}
      position={[-600, -2, 1900]}
      scale={8}
      rotation={[0, 0, 0]}
    />
  );
}

// ---------------------------------------------------------------------------
// Fixed landmark decorations — shipwreck + submarine placed at world-space
// coordinates chosen to be visually dramatic without cluttering the village.
// These are rendered as single cloned primitives (no instancing) — safe on
// Intel Iris Xe WebGPU.
// ---------------------------------------------------------------------------
function FixedLandmarks() {
  const { scene: shipwreckScene } = useGLTF('/models/building-shipwreck.glb');
  const { scene: submarineScene } = useGLTF('/models/building-submarine.glb');
  const shipwreckClone = useMemo(() => shipwreckScene.clone(true), [shipwreckScene]);
  const submarineClone = useMemo(() => submarineScene.clone(true), [submarineScene]);

  useEffect(() => {
    return () => {
      disposeClone(shipwreckClone);
      disposeClone(submarineClone);
    };
  }, [shipwreckClone, submarineClone]);

  return (
    <group>
      {/* Shipwreck — northwest outer zone (scaled out for 5120x5120 map) */}
      <primitive
        object={shipwreckClone}
        position={[-1900, -2, -700]}
        scale={2.5}
        rotation={[0, 0.8, 0]}
      />
      {/* Submarine — southeast outer zone (scaled out for 5120x5120 map) */}
      <primitive
        object={submarineClone}
        position={[1900, -2, 700]}
        scale={2.0}
        rotation={[0, -0.5, 0]}
      />
    </group>
  );
}

export default function ArenaTerrain() {
  return (
    <Suspense fallback={null}>
      <SandFloor />
      {/* Procedurally scattered individual GLB decorations */}
      <UnderwaterDecorations />
      {/*
        REMOVED 2026-04-16: `UnderwaterDecorationsGlb` (underwater-decorations.glb @ scale 8)
        and `FixedLandmarks` (submarine @ scale 2.0 + shipwreck @ scale 2.5). All three were
        authored for the old 2560x2560 world; in the current 5120x5120 world they appeared
        as massive floating silhouettes dominating the scene. The submarine landmark was
        the immediate user complaint ("this massive floating object needs to just be
        removed"). If we want hero-scale landmarks later, they need proper bbox
        normalization + positioning well outside the ring, like the procedural decorations.
      */}
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// DeferredTerrainPreloads
// Render this component OUTSIDE the Canvas (e.g. in the game page HUD layer).
// It fires useGLTF.preload() for all decoration + environment GLBs via
// requestAnimationFrame so the calls land AFTER the first painted frame, not
// at module-evaluation time. The ArenaTerrain Suspense fallback={null} means
// the decorations simply render nothing until each asset resolves — safe.
// ---------------------------------------------------------------------------
export function DeferredTerrainPreloads(): ReactElement | null {
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      // Scatter decoration models
      useGLTF.preload('/models/coral-reef1.glb');
      useGLTF.preload('/models/coral-reef2.glb');
      useGLTF.preload('/models/coral-reef3.glb');
      useGLTF.preload('/models/kelp.glb');
      useGLTF.preload('/models/building-shell.glb');
      useGLTF.preload('/models/building-seashell.glb');
      useGLTF.preload('/models/building-anchor.glb');
      useGLTF.preload('/models/building-barrel.glb');
      useGLTF.preload('/models/building-chest.glb');
      useGLTF.preload('/models/building-lantern.glb');
      useGLTF.preload('/models/crayfish.glb');
      useGLTF.preload('/models/building-tower2.glb');
      // Note: building-lighthouse.glb is intentionally omitted here — arena-buildings.tsx
      // already preloads it via its module-scope loop over BUILDING_MODELS.
      // REMOVED 2026-04-16: preloads for building-shipwreck, building-submarine, and
      // underwater-decorations.glb. The components that used them (FixedLandmarks +
      // UnderwaterDecorationsGlb) were removed — those landmarks were authored for
      // the old 2560x2560 world and appeared as massive floating silhouettes in the
      // current 5120x5120 world.
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}
