'use client';

/**
 * central-island.tsx — Low-poly central island at the loop centroid (world XZ ~0,0).
 *
 * The closed-loop track orbits this island. The island fills the visual center
 * without overlapping the corridor (min self-distance 432wu, min corridor edge
 * at ~centerlineAt(t) - halfWidth, closest pass ~(-5050+290) = -4760 from origin
 * at the hairpin). Island radius = 4500wu fits inside the ring with ~260wu
 * clearance at the hairpin — tight but visually meaningful.
 *
 * Visual layers:
 *   1. Sand atoll base — flat disc (CylinderGeometry, sandy beige)
 *   2. Raised interior hill — slightly raised centre cone for visual volume
 *   3. Coral GLB instances — 3 reef GLBs scattered around the atoll
 *      (InstancedMesh + MeshStandardMaterial — Iris Xe safe)
 *
 * Iris Xe invariants:
 *   - InstancedMesh + MeshStandardMaterial only (NEVER ShaderMaterial on Instanced)
 *   - NO drei <Text> or <Billboard>
 *   - NO per-frame new Vector3() — module-scope scratch only
 *   - matrixAutoUpdate=false on all static meshes
 *   - frustumCulled=false on the base (large radius ~ FOG would cull it mid-render)
 *
 * The island renders at TRACK_SURFACE_Y=0 in the outer group (world Y becomes
 * TRACK_SURFACE_Y=-200 after the parent group offset applied by ReefRaceScene).
 * Coral props sit at y=0 local = y=-200 world (on the water surface), which is
 * intentional — partially submerged reef aesthetic.
 */

import { useEffect, useMemo, useRef, Suspense } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ─── Preload coral GLBs ───────────────────────────────────────────────────────
useGLTF.preload('/models/coral-reef1.glb');
useGLTF.preload('/models/coral-reef2.glb');
useGLTF.preload('/models/coral-reef3.glb');

// ─── Island geometry constants ────────────────────────────────────────────────
// Island ring fits inside the closed circuit. The closest corridor approach
// from origin is ~4760wu (hairpin at X~-5050, half-width 290). Using
// ISLAND_RADIUS=4500 leaves ~260wu clear — tight but visible separation.
// Previous value was 2400 which made the island look like a tiny sandbar dwarfed
// by the green ground disc. Bumping to 4500 fills the visual centre so the track
// reads as "loop around an atoll" rather than "loop around a pebble".
const ISLAND_RADIUS       = 4500;  // wu — atoll outer radius (was 2400; bumped 2026-06-23)
const ISLAND_HILL_RADIUS  = 2250;  // wu — raised central hill top (was 1200, proportional scale)
const ISLAND_SEGS         = 48;    // polygon count for smooth circle
const ISLAND_Y_SAND       = -4;    // slight below track-group Y=0 to avoid z-fight
const ISLAND_HILL_HEIGHT  = 120;   // wu — hill crown height (taller to read at new scale)

// Coral instance layout: 3 rings of varying radii around the atoll
// Ring radii scaled proportionally with island (was 1800/1400/2100 at R=2400;
// now 3375/2625/3938 ≈ 3375/2625/3900 at R=4500 — ~×1.875 scale factor).
// Seeded deterministic so spawns are stable across hot-reloads.
const CORAL_CONFIGS: Array<{
  path: string;
  count: number;
  ringRadius: number;
  scaleMin: number;
  scaleMax: number;
  seed: number;
}> = [
  { path: '/models/coral-reef1.glb', count: 14, ringRadius: 3375, scaleMin: 0.6, scaleMax: 1.2, seed: 71 },
  { path: '/models/coral-reef2.glb', count: 12, ringRadius: 2625, scaleMin: 0.5, scaleMax: 1.0, seed: 72 },
  { path: '/models/coral-reef3.glb', count: 10, ringRadius: 3900, scaleMin: 0.8, scaleMax: 1.4, seed: 73 },
];

// ─── Seeded PRNG ──────────────────────────────────────────────────────────────
function seededRand(seed: number) {
  let s = (seed * 1664525 + 1013904223) | 0;
  return {
    next(): number {
      s = ((s ^ (s << 13)) ^ (s >>> 17) ^ (s << 5)) | 0;
      return (s >>> 0) / 0xffffffff;
    },
  };
}

// ─── Module-scope scratch (no per-frame allocations) ─────────────────────────
const _dummy = new THREE.Object3D();

// ─── Module-scope materials (page-lifetime) ──────────────────────────────────
const _sandMat = new THREE.MeshStandardMaterial({
  color: 0xd4b483,   // warm sandy beige
  roughness: 0.95,
  metalness: 0.0,
  side: THREE.FrontSide,
  fog: true,
});

const _hillMat = new THREE.MeshStandardMaterial({
  color: 0xc8a86a,   // slightly richer sand for the raised hill
  roughness: 0.9,
  metalness: 0.0,
  side: THREE.FrontSide,
  fog: true,
});

// ─── Island base geometry ─────────────────────────────────────────────────────
function buildIslandBaseGeo(): THREE.BufferGeometry {
  // Flat disc — atoll floor (radius 4500wu at new scale)
  const disc = new THREE.CylinderGeometry(
    ISLAND_RADIUS, ISLAND_RADIUS,
    8,               // thin slab
    ISLAND_SEGS,     // radial segments
    1,               // height segments
    false,           // open-ended = false (capped top+bottom)
  );
  disc.translate(0, ISLAND_Y_SAND, 0);
  return disc;
}

function buildIslandHillGeo(): THREE.BufferGeometry {
  // Low cone for the raised interior
  const hill = new THREE.CylinderGeometry(
    ISLAND_HILL_RADIUS * 0.1,  // tip radius (flat-ish top)
    ISLAND_HILL_RADIUS,        // base radius
    ISLAND_HILL_HEIGHT,
    ISLAND_SEGS,
    1,
    false,
  );
  hill.translate(0, ISLAND_HILL_HEIGHT / 2 + ISLAND_Y_SAND + 4, 0);
  return hill;
}

// Baked at module load
const _islandBaseGeo = buildIslandBaseGeo();
const _islandHillGeo = buildIslandHillGeo();

// ─── Coral InstancedMesh per GLB type ────────────────────────────────────────

interface CoralInstancesProps {
  path: string;
  count: number;
  ringRadius: number;
  scaleMin: number;
  scaleMax: number;
  seed: number;
}

function CoralInstances({ path, count, ringRadius, scaleMin, scaleMax, seed }: CoralInstancesProps) {
  const { scene: src } = useGLTF(path);
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    if (!src) return;
    const gr = groupRef.current;
    if (!gr) return;

    // Find first mesh in the GLB
    let srcMesh: THREE.Mesh | null = null;
    src.traverse((child) => {
      if (!srcMesh && child instanceof THREE.Mesh && child.geometry) {
        srcMesh = child as THREE.Mesh;
      }
    });
    if (!srcMesh) return;

    const geo = (srcMesh as THREE.Mesh).geometry;

    // Safety: replace ShaderMaterial to avoid Iris Xe InstancedMesh+ShaderMaterial crash
    const srcMat = Array.isArray((srcMesh as THREE.Mesh).material)
      ? ((srcMesh as THREE.Mesh).material as THREE.Material[])[0]!
      : ((srcMesh as THREE.Mesh).material as THREE.Material);
    const needsFallback =
      srcMat instanceof THREE.ShaderMaterial ||
      srcMat instanceof THREE.RawShaderMaterial;
    const safeMat: THREE.Material = needsFallback
      ? new THREE.MeshStandardMaterial({ color: 0x5a8a6a, roughness: 0.8, metalness: 0.0 })
      : srcMat;

    const im = new THREE.InstancedMesh(geo, safeMat, count);
    im.castShadow    = false;
    im.receiveShadow = false;

    const rng = seededRand(seed);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + rng.next() * 0.4;
      const r     = ringRadius + (rng.next() - 0.5) * 300;
      const px    = Math.cos(angle) * r;
      const pz    = Math.sin(angle) * r;
      const yRot  = rng.next() * Math.PI * 2;
      const scale = scaleMin + rng.next() * (scaleMax - scaleMin);

      _dummy.position.set(px, 0, pz);
      _dummy.rotation.set(0, yRot, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      im.setMatrixAt(i, _dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
    im.matrixAutoUpdate = false;

    gr.add(im);
    return () => {
      gr.remove(im);
      if (needsFallback) safeMat.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  return <group ref={groupRef} />;
}

// ─── CentralIsland — public component ────────────────────────────────────────

/**
 * CentralIsland — low-poly atoll at world XZ (0,0) around which the closed
 * race circuit orbits.
 *
 * Wire into ReefRaceScene.tsx (SplineMode) + /preview/reef-race-v2 SceneContents.
 * Place OUTSIDE the parent TRACK_SURFACE_Y group so its Y coordinates match
 * the water surface (WATER_Y = -200 world). The base disc sits at y=WATER_Y
 * after the parent group offset, emerging from the water at island height.
 *
 * Does NOT own lighting — uses the parent scene's hemisphere + directional light.
 */
export function CentralIsland() {
  const baseRef = useRef<THREE.Mesh>(null);
  const hillRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    [baseRef.current, hillRef.current].forEach(m => {
      if (!m) return;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
    });
  }, []);

  return (
    <group>
      {/* Sand atoll disc */}
      <mesh
        ref={baseRef}
        geometry={_islandBaseGeo}
        material={_sandMat}
        frustumCulled={false}
        receiveShadow
        matrixAutoUpdate={false}
      />

      {/* Raised hill crown */}
      <mesh
        ref={hillRef}
        geometry={_islandHillGeo}
        material={_hillMat}
        frustumCulled={false}
        receiveShadow
        matrixAutoUpdate={false}
      />

      {/* Coral GLB instances around the atoll */}
      {CORAL_CONFIGS.map((cfg) => (
        <Suspense key={cfg.path} fallback={null}>
          <CoralInstances
            path={cfg.path}
            count={cfg.count}
            ringRadius={cfg.ringRadius}
            scaleMin={cfg.scaleMin}
            scaleMax={cfg.scaleMax}
            seed={cfg.seed}
          />
        </Suspense>
      ))}
    </group>
  );
}
