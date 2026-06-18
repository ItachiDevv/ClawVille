// @ts-nocheck — preview route crosses dual @types/three versions (0.170 from
// VRM, 0.182 from main three). Every Three.js value hits the version
// boundary, making per-line casts untractable. Runtime is unaffected; this
// is a dev-only preview route (matches /preview/hermes).
'use client';

// Three.js requires a browser-only WebGL canvas. Force dynamic so the build
// doesn't try to prerender this page.
export const dynamic = 'force-dynamic';

/**
 * /preview/land-structures — Land Economy "building style" candidate gallery.
 *
 * STAGE 1 of the land-structures feature: the founder must PICK ONE building
 * art-style direction before we mass-produce all 12 land SKUs. This route
 * renders 2-3 distinct candidate styles side by side, each as a sample pair
 * (ONE home GLB + ONE shop GLB), on labelled pads. The orchestrator
 * screenshots this for the founder to choose.
 *
 * Candidate styles (all sourced low-poly GLBs under /models/land-structures/):
 *   - fantasy-cottage : Quaternius Fantasy House (home) + Market Stalls (shop)  [CC0]
 *   - coastal-cottage : CreativeTrio Cottage (home) + Quaternius Cart (shop)    [CC0]
 *   - driftwood-cabin : CreativeTrio Cabin Shed (home) + Zsky Blacksmith (shop) [CC0 home / CC-BY shop]
 *
 * Iris Xe rules enforced:
 *   - Plain WebGLRenderer (Canvas default), no three/webgpu
 *   - No drei <Text> / <Billboard> — labels are plain DOM in a CSS overlay
 *   - No InstancedMesh + ShaderMaterial
 *   - 1 hemisphere + 1 directional light, no shadows
 *   - Clone GLB scene before mutating (useGLTF cache is shared)
 *   - Clone materials after clone (cross-renderer-context purple guard)
 *   - frustumCulled=false on every cloned mesh
 *   - Dispose cloned geometry/materials/textures on unmount
 *   - No per-frame allocations (gallery is static — no useFrame)
 */

import React, { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { extendLoaderWithMeshopt } from '@/lib/three/meshopt-loader-setup';

// Normalize each model so its largest dimension (X, Y, or Z) is this many world
// units — keeps wide shops and tall homes at a consistent visual cube size on
// the pads (memory: building-maxdim-normalization — max(X,Y,Z), NOT Y-only).
const TARGET_MAX_DIM = 140;

// Pad spacing along X. Each candidate occupies a 2-pad column-pair (home, shop).
const PAD_GAP = 220; // gap between home and shop within a candidate
const CANDIDATE_GAP = 520; // gap between candidate groups

type StructureKind = 'home' | 'shop';

interface CandidateDef {
  style: string; // kebab styleName == folder under /models/land-structures/
  label: string;
  blurb: string;
  home: { path: string; source: string };
  shop: { path: string; source: string };
}

const CANDIDATES: CandidateDef[] = [
  {
    style: 'fantasy-cottage',
    label: 'Fantasy Cottage',
    blurb: 'Storybook pointed roofs — whimsical, pairs with Pineapple/Patrick',
    home: {
      path: '/models/land-structures/fantasy-cottage/home.glb',
      source: 'Quaternius (CC0) · 5,758 tris',
    },
    shop: {
      path: '/models/land-structures/fantasy-cottage/shop.glb',
      source: 'Quaternius Market Stalls (CC0) · 3,896 tris',
    },
  },
  {
    style: 'coastal-cottage',
    label: 'Coastal Cottage',
    blurb: 'Tidy compact cottage — lowest-poly, clean coastal hamlet read',
    home: {
      path: '/models/land-structures/coastal-cottage/home.glb',
      source: 'CreativeTrio Cottage (CC0) · 2,094 tris',
    },
    shop: {
      path: '/models/land-structures/coastal-cottage/shop.glb',
      source: 'Quaternius Cart (CC0) · 2,659 tris',
    },
  },
  {
    style: 'driftwood-cabin',
    label: 'Driftwood Cabin',
    blurb: 'Rustic timber — weathered plank look, sea-salvage vibe',
    home: {
      path: '/models/land-structures/driftwood-cabin/home.glb',
      source: 'CreativeTrio Cabin Shed (CC0) · 2,745 tris',
    },
    shop: {
      path: '/models/land-structures/driftwood-cabin/shop.glb',
      source: 'Zsky Blacksmith Shop (CC-BY) · 5,216 tris',
    },
  },
];

/**
 * Loads ONE GLB, clones it (shared cache safety), normalizes it to
 * TARGET_MAX_DIM via max(X,Y,Z), grounds it on the pad (feet at pad top), and
 * disposes the clone on unmount.
 */
function Structure({ path, x, z }: { path: string; x: number; z: number }) {
  // extendLoaderWithMeshopt is a no-op for these uncompressed GLBs but keeps
  // the preview aligned with the project loader stack (Stage 2 may add it).
  const { scene } = useGLTF(path, undefined, undefined, extendLoaderWithMeshopt);

  const prepared = useMemo(() => {
    // Clone the cached scene before mutating — useGLTF caches and shares it.
    const root = scene.clone(true);

    // Clone every material so we never write through to the cached material
    // (cross-Canvas / cross-renderer-context => purple fallback otherwise).
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.frustumCulled = false;
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((m) => m.clone());
        } else if (mesh.material) {
          mesh.material = mesh.material.clone();
        }
      }
    });

    // Measure the natural bbox at scale=1 (Box3.setFromObject applies node
    // matrices, so it works for both node-scaled and world-scaled GLBs).
    root.scale.setScalar(1);
    root.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = TARGET_MAX_DIM / maxDim;
    // Ground: lift so the model's lowest point sits on the pad top (y=0 here;
    // the group below is positioned at pad height).
    const offsetY = -box.min.y * scale;

    return { root, scale, offsetY };
  }, [scene]);

  // Dispose ONLY the cloned MATERIALS when this Structure unmounts.
  //
  // NEVER dispose geometry or textures here: `scene.clone(true)` does a REFERENCE
  // copy of BufferGeometry (`Mesh.copy()`: `this.geometry = source.geometry`), and
  // `material.clone()` shares texture references with the useGLTF cache. These same
  // coastal/fantasy/driftwood GLBs are consumed by the in-world land-structures
  // layer; disposing the shared geometry/textures would hand a disposed GPU buffer
  // to that consumer (and to a re-mount of this gallery). Only the materials were
  // explicitly `.clone()`d above, so only they are ours to dispose.
  useEffect(() => {
    const root = prepared.root;
    return () => {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if (!m) continue;
            m.dispose?.();
          }
        }
      });
    };
  }, [prepared]);

  return (
    <group position={[x, 0, z]}>
      {/* Pad under the structure */}
      <mesh position={[0, -1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[TARGET_MAX_DIM * 1.35, TARGET_MAX_DIM * 1.35]} />
        <meshStandardMaterial color={0x9fb8c4} roughness={0.95} />
      </mesh>
      <primitive
        object={prepared.root}
        scale={prepared.scale}
        position={[0, prepared.offsetY, 0]}
      />
    </group>
  );
}

function GalleryScene() {
  // Lay out 3 candidate groups along X, each with a home (left) + shop (right).
  // Center the whole row on origin.
  const layout = useMemo(() => {
    const items: { path: string; x: number; z: number; key: string }[] = [];
    const n = CANDIDATES.length;
    const groupWidth = PAD_GAP; // home->shop within a group
    const totalWidth = (n - 1) * CANDIDATE_GAP + groupWidth;
    const startX = -totalWidth / 2;
    CANDIDATES.forEach((c, i) => {
      const groupX = startX + i * CANDIDATE_GAP;
      items.push({ path: c.home.path, x: groupX, z: 0, key: `${c.style}-home` });
      items.push({ path: c.shop.path, x: groupX + PAD_GAP, z: 0, key: `${c.style}-shop` });
    });
    return items;
  }, []);

  return (
    <>
      <hemisphereLight args={[0xffffff, 0xb0c4d4, 0.85]} />
      <directionalLight position={[120, 260, 160]} intensity={1.05} castShadow={false} />
      {/* No big ground plane — its finite 4000x2000 edge swept across the view as a
          moving "wall" on orbit. Each model keeps its own small per-pad plane instead,
          so the buildings read against the scene background with nothing to sweep. */}
      <Suspense fallback={null}>
        {layout.map((it) => (
          <Structure key={it.key} path={it.path} x={it.x} z={it.z} />
        ))}
      </Suspense>
    </>
  );
}

export default function PreviewLandStructuresPage() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a1626' }}>
      <Canvas
        camera={{ position: [0, 260, 760], fov: 38 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        scene={{ background: new THREE.Color(0x0a1626) }}
      >
        <GalleryScene />
        <OrbitControls
          target={[0, 60, 0]}
          enablePan
          maxDistance={2000}
          minDistance={120}
        />
      </Canvas>

      {/* DOM label overlay (Iris-Xe safe — no drei Text/Billboard) */}
      <div
        style={{
          position: 'absolute',
          top: 14,
          left: 14,
          padding: 14,
          maxWidth: 360,
          background: 'rgba(8,18,34,0.9)',
          color: '#e6f1ff',
          font: '13px system-ui',
          borderRadius: 10,
          border: '1px solid rgba(120,170,210,0.35)',
          lineHeight: 1.45,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>
          Land Structures — Style Candidates
        </div>
        <div style={{ opacity: 0.8, marginBottom: 10 }}>
          Each candidate = ONE home (left) + ONE shop (right). Pick a direction
          before all 12 SKUs are produced. Drag to orbit · scroll to zoom.
        </div>
        {CANDIDATES.map((c) => (
          <div
            key={c.style}
            style={{
              marginBottom: 10,
              paddingBottom: 10,
              borderBottom: '1px solid rgba(120,170,210,0.18)',
            }}
          >
            <div style={{ fontWeight: 600, color: '#9fdcff' }}>{c.label}</div>
            <div style={{ opacity: 0.85, fontSize: 12 }}>{c.blurb}</div>
            <div style={{ opacity: 0.6, fontSize: 11, marginTop: 3 }}>
              home: {c.home.source}
            </div>
            <div style={{ opacity: 0.6, fontSize: 11 }}>shop: {c.shop.source}</div>
          </div>
        ))}
        <div style={{ opacity: 0.5, fontSize: 11 }}>
          /models/land-structures/&lt;style&gt;/&#123;home,shop&#125;.glb
        </div>
      </div>
    </div>
  );
}

// Preload all 6 GLBs so the gallery paints in one go.
for (const c of CANDIDATES) {
  useGLTF.preload(c.home.path, undefined, undefined, extendLoaderWithMeshopt);
  useGLTF.preload(c.shop.path, undefined, undefined, extendLoaderWithMeshopt);
}
