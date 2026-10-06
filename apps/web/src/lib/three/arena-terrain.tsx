'use client';

import { Suspense, useEffect, useRef, useMemo, useState, type ReactElement } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import {
  decorationPlacement,
  generateDecorations,
  seededRandom,
  type DecoEntry,
  type DecoNativeBounds,
} from '@/lib/three/arena-terrain-decorations';
import { makeGeometryWebGPUSafe, makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { initTerrainHeightfield } from '@/lib/three/terrain-heightfield';
import { useOptionalGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import { isDecorativeReleased, onDecorativeReleaseStaggered } from '@/lib/three/decorative-release';
import { DeferredWarmAttachment } from '@/lib/three/deferred-warm-attachment';

// ---------------------------------------------------------------------------
// Terrain: Bikini Bottom GLB + sand floor + coral/kelp decorations
// ---------------------------------------------------------------------------

export const TERRAIN_LAYER = 1;

// bikini-bottom.glb REMOVED — it contained duplicate buildings (Krusty Krab,
// Pineapple, Squidward's, Patrick's Rock) baked into one scene, overlapping
// with our individual building GLBs. Sand floor + individual buildings is cleaner.
//
// Decoration demand begins only when UnderwaterDecorations receives its
// staggered decorative-release tick. The resolved subtree then warms hidden;
// it cannot enter an ordinary draw until upload + compile + direct warm finish.

// Sand colors — GRAPHIC high-contrast palette, visible from any camera distance
const SAND_RIDGE  = new THREE.Color(0xfff0d4); // Bright white-sand peaks
const SAND_HIGH   = new THREE.Color(0xe8d0a8); // Warm sand
const SAND_MID    = new THREE.Color(0xc4a878); // Golden mid-tone
const SAND_VALLEY = new THREE.Color(0x8a7050); // Dark moody valleys
const SAND_DEEP   = new THREE.Color(0x5c4a32); // Deep brown-black troughs

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

  // Build the O(1) heightfield for NPC / avatar terrain-Y queries.
  // Must be called AFTER pos.setZ() loop above so displaced positions are baked.
  // segsX=120, segsY=120 must match the PlaneGeometry constructor above.
  initTerrainHeightfield(geo, 120, 120);

  return geo;
}

function SandFloor() {
  const ref = useRef<THREE.Mesh>(null);
  const sandGeo = useMemo(() => createSandGeometry(), []);
  const sandMat = useMemo(
    () => new THREE.MeshBasicMaterial({ vertexColors: true, fog: true }),
    [],
  );

  useEffect(() => {
    if (ref.current) {
      ref.current.layers.enable(TERRAIN_LAYER);
      // PERF: terrain never moves after mount. Disable matrixAutoUpdate so
      // Three.js skips the per-frame matrix re-multiply for this mesh
      // (was contributing to the 9.9% updateMatrixWorld cost in the profile).
      ref.current.matrixAutoUpdate = false;
      ref.current.updateMatrix();
    }
    // Dispose both geometry and material on unmount to prevent GPU memory leaks.
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

// ---------------------------------------------------------------------------
// MergedDecorations — replaces 80 × SingleDecoration (~3000+ individual meshes)
// with geometry-merged draw calls bucketed by (spatialCell, materialUUID).
//
// Strategy:
//   1. Load all 12 unique decoration models (fixed hook calls — count never changes).
//   2. For each of the 60 DECORATIONS entries, determine its 3×3 spatial grid cell
//      based on world-space X/Z position.
//   3. For each mesh in that entry's source scene, apply the combined world transform
//      (entry position, size-derived scale + ground lift, rotY × GLB-internal matrixWorld) into a geometry clone.
//   4. Bucket by `${cellIndex}_${materialUUID}`.
//   5. mergeGeometries() per bucket → one Mesh per (cell, material).
//   6. frustumCulled stays at THREE default (true) — each chunk has a tight AABB
//      covering only its grid cell, so off-screen chunks are culled correctly.
//      This restores the pre-merge frustum-cull behaviour that was broken by the
//      single-merged-mesh iteration (which had to use frustumCulled=false because
//      the AABB spanned the whole scene and Three.js would have wrongly culled it
//      based on the spectator cam direction).
//
// Grid: 3×3 = 9 cells covering ±DECO_GRID_HALF (8000wu). The scatter lives in the
// 800–3800wu band (arena-terrain-decorations.ts), so most of the 60 entries fall in
// the centre cell (|x|,|z| < 2667wu).
//
// Constraints respected:
//   - No SkinnedMesh (decoration GLBs are all static)
//   - No ShaderMaterial / NodeMaterial (guard present; GLBs use MeshStandardMaterial)
//   - matrixAutoUpdate=false on all merged meshes (static, transforms baked in)
//   - Temporary per-mesh geometry clones disposed after merge
//   - computeBoundingBox() called on each merged geometry so Three.js frustum
//     culling uses the actual tight AABB, not the default unset (infinite) box
// ---------------------------------------------------------------------------

// All 12 unique decoration model paths (must match DECO_TYPES exactly)
const DECO_MODEL_PATHS = [
  '/models/coral-reef1-ktx.glb?v=2',
  '/models/coral-reef2-ktx.glb?v=2',
  '/models/coral-reef3-ktx.glb?v=2',
  '/models/kelp.glb',
  '/models/building-shell-ktx.glb?v=2',
  '/models/building-seashell-ktx.glb?v=2',
  '/models/building-anchor.glb',
  '/models/building-barrel.glb',
  '/models/building-chest.glb',
  '/models/building-lantern-ktx.glb?v=2',
  '/models/crayfish-ktx.glb?v=2',
  '/models/building-tower2.glb',
] as const;

// 3×3 spatial grid for chunk-merged frustum culling.
// Half-extent 8000wu wraps the 3800wu scatter band with margin.
const DECO_GRID_CELLS = 3;
const DECO_GRID_HALF  = 8000; // ±8000wu total 16000wu; each cell = 16000/3 ≈ 5333wu

function decoGridCell(worldX: number, worldZ: number): number {
  // Map worldX/worldZ from [-HALF, +HALF] → [0, CELLS)
  const col = Math.min(DECO_GRID_CELLS - 1, Math.max(0,
    Math.floor((worldX + DECO_GRID_HALF) / (DECO_GRID_HALF * 2) * DECO_GRID_CELLS)
  ));
  const row = Math.min(DECO_GRID_CELLS - 1, Math.max(0,
    Math.floor((worldZ + DECO_GRID_HALF) / (DECO_GRID_HALF * 2) * DECO_GRID_CELLS)
  ));
  return row * DECO_GRID_CELLS + col;
}

// Scratch matrix for baking world transforms into geometry vertices.
// Module-scope to avoid GC allocations inside the useMemo.
const _decoMatrix = new THREE.Matrix4();
const _decoBox = new THREE.Box3();

interface MergedBucket {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/** Inner component — loaded inside a Suspense; receives all 12 scenes via hooks.
 *  `visible` is the governor tier switch: it flips an ancestor group only, so a
 *  tier toggle never re-merges, re-uploads or disposes. */
function MergedDecorationsInner({ visible }: { visible: boolean }) {
  // Fixed-count hook calls — one per unique model path. Order is stable (constant array).
  // Optional reads: a GLB whose own load fails (request failure after the
  // loader's retries, or a corrupt file) is null and logged with
  // console.error, so only that model's entries are skipped, not the world.
  const s0  = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[0])?.scene ?? null;
  const s1  = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[1])?.scene ?? null;
  const s2  = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[2])?.scene ?? null;
  const s3  = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[3])?.scene ?? null;
  const s4  = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[4])?.scene ?? null;
  const s5  = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[5])?.scene ?? null;
  const s6  = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[6])?.scene ?? null;
  const s7  = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[7])?.scene ?? null;
  const s8  = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[8])?.scene ?? null;
  const s9  = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[9])?.scene ?? null;
  const s10 = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[10])?.scene ?? null;
  const s11 = useOptionalGLTFWithKTX2(DECO_MODEL_PATHS[11])?.scene ?? null;

  // Build a lookup: model path → GLTF scene
  const sceneMap = useMemo<Map<string, THREE.Object3D>>(() => {
    const m = new Map<string, THREE.Object3D>();
    const scenes = [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11];
    DECO_MODEL_PATHS.forEach((p, i) => {
      const scene = scenes[i];
      if (scene) m.set(p, scene);
    });
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11]);

  // Compute spatially-chunked merged buckets — runs once when all scenes are loaded.
  const buckets = useMemo<MergedBucket[]>(() => {
    // key = `${cellIndex}_${materialUUID}` → { geometries, material }
    const bucketMap = new Map<string, { geometries: THREE.BufferGeometry[]; material: THREE.Material }>();
    const tempGeos: THREE.BufferGeometry[] = [];
    // Native world bounds per GLB scene, measured once: entry.size is a target
    // max-dimension in wu and the box centre goes on the site, so both depend
    // on the model's own units and origin.
    const nativeBounds = new Map<THREE.Object3D, DecoNativeBounds>();

    for (const entry of DECORATIONS) {
      const sourceScene = sceneMap.get(entry.model);
      if (!sourceScene) continue;

      // Determine the 3×3 grid cell for this decoration's world position
      const cell = decoGridCell(entry.x, entry.z);

      // Update world matrices of the source scene for correct mesh.matrixWorld
      sourceScene.updateMatrixWorld(true);

      let bounds = nativeBounds.get(sourceScene);
      if (!bounds) {
        _decoBox.setFromObject(sourceScene);
        bounds = {
          minX: _decoBox.min.x, minY: _decoBox.min.y, minZ: _decoBox.min.z,
          maxX: _decoBox.max.x, maxY: _decoBox.max.y, maxZ: _decoBox.max.z,
        };
        nativeBounds.set(sourceScene, bounds);
      }
      const placement = decorationPlacement(entry, bounds);
      if (!placement) continue;

      sourceScene.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        // Skip SkinnedMesh (safety — decoration GLBs should not have any)
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
        if (!mesh.geometry) return;

        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!mat) return;
        // Skip ShaderMaterial / NodeMaterial — merging these causes WebGPU pipeline crashes
        if ((mat as any).isShaderMaterial || (mat as any).isNodeMaterial) return;

        // Build entry's world transform matrix: T(ex,ey,ez) * Ry(rotY) * S(s)
        const cosY = Math.cos(entry.rotY);
        const sinY = Math.sin(entry.rotY);
        const s = placement.scale;
        const ex = placement.x, ey = placement.y, ez = placement.z;
        // prettier-ignore
        _decoMatrix.set(
          s * cosY,  0, s * sinY, ex,
          0,         s, 0,        ey,
          -s * sinY, 0, s * cosY, ez,
          0,         0, 0,        1,
        );
        // Compose with the mesh's GLB-internal world matrix
        const combinedMatrix = _decoMatrix.clone().multiply(mesh.matrixWorld);

        const geo = makeGeometryWebGPUSafe(mesh.geometry.clone());
        geo.applyMatrix4(combinedMatrix);
        tempGeos.push(geo);

        // Bucket key includes grid cell so each chunk gets its own tight AABB
        const key = `${cell}_${mat.uuid}`;
        if (!bucketMap.has(key)) {
          bucketMap.set(key, { geometries: [], material: mat });
        }
        bucketMap.get(key)!.geometries.push(geo);
      });
    }

    // Merge each bucket and compute a tight bounding box for frustum culling
    const result: MergedBucket[] = [];
    for (const { geometries, material } of bucketMap.values()) {
      if (geometries.length === 0) continue;
      const merged = mergeGeometries(geometries, false);
      if (!merged) {
        console.warn('[MergedDecorations] mergeGeometries returned null for material', material.name);
        geometries.forEach((g) => g.dispose());
        continue;
      }
      // CRITICAL: compute bounding box/sphere so Three.js frustum culling uses
      // the actual tight AABB for this spatial chunk, not the default null box.
      // Without this, frustumCulled=true would behave as always-visible.
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      result.push({ geometry: merged, material });
    }

    // Dispose all temporary per-mesh geometry clones — the merged geometry has
    // independent attribute buffers (mergeGeometries copies data via TypedArray.set)
    tempGeos.forEach((g) => g.dispose());

    return result;
  }, [sceneMap]);

  // Dispose merged geometries on unmount
  useEffect(() => {
    return () => {
      buckets.forEach(({ geometry }) => geometry.dispose());
    };
  }, [buckets]);

  // The visibility group sits OUTSIDE the warm attachment: compileAsync starts
  // at the attachment root, so the GPU warm completes even while hidden.
  return (
    <group visible={visible}>
      <DeferredWarmAttachment
        label="arena-terrain:merged-decorations"
        priority={Number.POSITIVE_INFINITY}
      >
        {buckets.map(({ geometry, material }, i) => (
          <mesh
            key={i}
            name="arena-terrain-decoration"
            geometry={geometry}
            material={material}
            // matrixAutoUpdate=false: merged meshes sit at world origin with identity
            // matrix — all transforms were baked into vertex positions.
            // frustumCulled: default true — each chunk has a tight cell-local AABB
            // computed above, so off-screen chunks are correctly skipped by the renderer.
            matrixAutoUpdate={false}
          />
        ))}
      </DeferredWarmAttachment>
    </group>
  );
}

function UnderwaterDecorations({ visible }: { visible: boolean }) {
  // Rung-3 Lever 3: the parent stops BEFORE the child that calls
  // useGLTFWithKTX2, so its 12 GLB fetches begin on this consumer's stagger
  // tick. MergedDecorationsInner then commits hidden and joins the one-at-a-
  // time GPU warm queue before attachment (timing-only deferral).
  // Post-release remounts initialize released (one-shot monotonic contract);
  // bulk decorations take POSITIVE_INFINITY priority so visible NPC slots
  // drain from the stagger queue first.
  const [released, setReleased] = useState(isDecorativeReleased);
  useEffect(() => {
    // Subscribe on LOCAL state only: re-checking the global here loses the
    // release fired between render and effect (returning without subscribing
    // OR setting state = hidden forever — Codex final-review HIGH). A
    // post-release staggered subscribe delivers via the queue, so this stays
    // correct in every interleaving.
    if (released) return undefined;
    return onDecorativeReleaseStaggered(
      () => setReleased(true),
      Number.POSITIVE_INFINITY,
    );
  }, [released]);
  if (!released) return null;
  return (
    <Suspense fallback={null}>
      <MergedDecorationsInner visible={visible} />
    </Suspense>
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
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    makeObject3DWebGPUSafe(c);
    return c;
  }, [scene]);

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
  const shipwreckClone = useMemo(() => {
    const c = shipwreckScene.clone(true);
    makeObject3DWebGPUSafe(c);
    return c;
  }, [shipwreckScene]);
  const submarineClone = useMemo(() => {
    const c = submarineScene.clone(true);
    makeObject3DWebGPUSafe(c);
    return c;
  }, [submarineScene]);

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

/**
 * The seabed scatter follows the ground-cover switch, in two parts:
 * - `decorationsMounted` = the device profile's `ambientGroundCover` (false on
 *   phones and tablets): when false the scatter never mounts and demands none
 *   of its 12 GLBs;
 * - `decorationsVisible` = `showGroundCover` (the adaptive governor clears it
 *   at tier 1): it only flips visibility. The scatter mounts once, keeps its
 *   merged meshes, and disposes them only on a real unmount, so a tier toggle
 *   costs no merge, upload or dispose (staging ac36e4e1: a remount on recovery
 *   spiked the frame and latched tier 1 for the session).
 * The sand floor always renders.
 */
export default function ArenaTerrain({
  decorationsMounted,
  decorationsVisible,
}: {
  decorationsMounted: boolean;
  decorationsVisible: boolean;
}) {
  return (
    <Suspense fallback={null}>
      <SandFloor />
      {/* Procedurally scattered individual GLB decorations */}
      {decorationsMounted && <UnderwaterDecorations visible={decorationsVisible} />}
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
// Compatibility export retained for game/page.tsx. Scatter preloads are now
// deliberately absent: MergedDecorationsInner must start all 12 demands only
// after its own stagger callback, otherwise a release-wide preload gets ahead
// of the warm-before-attach consumer boundary.
// ---------------------------------------------------------------------------
export function DeferredTerrainPreloads(): ReactElement | null {
  return null;
}
