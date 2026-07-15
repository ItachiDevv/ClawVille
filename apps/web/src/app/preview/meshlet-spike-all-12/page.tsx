// @ts-nocheck — preview route crosses dual @types/three versions (0.170 from
// VRM deps, 0.182 from main three/webgpu). Every Three.js value in this file
// hits that boundary; per-line casts are intractable. Runtime is unaffected;
// this is a dev-only spike preview route.
'use client';

export const dynamic = 'force-dynamic';

/**
 * /preview/meshlet-spike-all-12 — GPU-driven Nanite-style rasterizer spike,
 * all 12 ClawVille building GLBs in one scene.
 *
 * DESIGN DECISION — 12 separate NaniteRasterizer instances (not one combined asset):
 *
 *   NaniteRasterizer stores every geometry buffer (vertex/index/meshlet/LOD) at
 *   construction time in TSL StorageBufferAttribute nodes that are baked into the
 *   compute pipeline at _buildPipelines(). The instance data (`staticInstanceData`)
 *   is `vec4(posX, posY, posZ, scale)` — every instance renders the SAME mesh
 *   geometry. There is no per-instance mesh selector in the compute shaders.
 *
 *   Combining 12 buildings into one rasterizer would require:
 *     - A "mega mesh" merging all 12 geometries in a single array
 *     - A per-instance mesh range table in the GPU (new compute stage)
 *     - Rewriting the frustum + rasterize kernels to read that range
 *   That is a research task, not a spike extension. Option B (12 separate instances)
 *   is measurable in one session and gives the data needed to decide whether
 *   Option A is worth building.
 *
 *   KNOWN LIMITATION: 12× compute pipeline compilation at init (~12× slower init).
 *   At render time: 5 compute dispatches × 12 per frame. The goal is FPS measurement
 *   only — Phase B will decide whether to collapse these.
 *
 * Camera: orbital ring at radius ~5000 wu, looking at origin, all 12 buildings
 * arranged in a flat circle of radius 4160 wu (the production ring radius).
 *
 * Iris Xe invariants honoured:
 *   - No drei <Text> / <Billboard> — FPS overlay is plain DOM
 *   - No InstancedMesh + ShaderMaterial
 *   - No per-frame new Vector3() / new Matrix4() allocations
 *   - No dynamic import('three/webgpu') — static import only
 *
 * Route: https://clawville.world/preview/meshlet-spike-all-12
 */

import * as THREE from 'three/webgpu';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import {
  mergeGeometriesToMeshletAsset,
  NaniteRasterizer,
  type MergedMeshletAsset,
} from '@/lib/three/experimental/nanite-rasterizer';

// ---------------------------------------------------------------------------
// Building manifest — mirrors the 12-slot ring from BUILDING_MODELS in arena-buildings.tsx.
// Positions: ring radius 4160 wu from origin, 30° spacing clockwise from North.
// rotY values are per the slot formula atan2(0-cx_tile, 0-cy_tile) × TILE_SIZE (32 wu).
// We don't apply per-building scale here — geometryToMeshletAsset receives raw geometry;
// the NaniteRasterizer staticInstanceData carries [posX, posY, posZ, scale] per instance.
// Scale is set to 1.0 for the spike — we just need triangle counts and FPS, not visual
// correctness. Correct per-building scales would require matching arena-buildings.tsx's
// computeBuildingScale pipeline, which is out of scope for Phase A.
// ---------------------------------------------------------------------------

interface BuildingSpec {
  /** Zone id for logging. */
  id: string;
  /** URL of the -opt1.glb file (relative to public/). */
  model: string;
  /** World-space X position (centre of ring slot). */
  posX: number;
  /** World-space Z position (centre of ring slot). */
  posZ: number;
}

// Ring radius 4160 wu, 12 slots × 30°, starting North (0°).
// Slot angle θ = -π/2 + slot × π/6; posX = R × sin(θ); posZ = -R × cos(θ)
// (Three.js +Z is toward viewer / South in ClawVille convention).
const R = 4160;

function ringPos(slot: number): [number, number] {
  const theta = (-Math.PI / 2) + slot * (Math.PI / 6);
  return [R * Math.cos(theta), R * Math.sin(theta)];
}

const BUILDINGS: BuildingSpec[] = [
  // Slot 0 — N — visual-creation (pineapple-house)
  { id: 'visual-creation',    model: '/models/pineapple-house-opt1-ktx.glb?v=3',                    posX: ringPos(0)[0],  posZ: ringPos(0)[1]  },
  // Slot 1 — NNE — code-development (chum-bucket)
  { id: 'code-development',   model: '/models/chum-bucket-v2-opt1-ktx.glb?v=4',                     posX: ringPos(1)[0],  posZ: ringPos(1)[1]  },
  // Slot 2 — ENE — mcp-tool-use (krusty-krab)
  { id: 'mcp-tool-use',       model: '/models/krusty-krab-v2-opt1-ktx.glb?v=4',                     posX: ringPos(2)[0],  posZ: ringPos(2)[1]  },
  // Slot 3 — E — messaging-channels (sandy-treedome) — DISABLED for spike
  // 2026-05-24: source GLB is a 1.1M-tri Draco vertex-color tree, 22× the rest
  // of the scene combined. User will replace with a lower-poly variant later.
  // Until then, spike runs with 11 buildings to measure meshlet path without
  // this single outlier dragging the average.
  // { id: 'messaging-channels', model: '/models/sandy-treedome-v3-opt1.glb?v=2',                  posX: ringPos(3)[0],  posZ: ringPos(3)[1]  },
  // Slot 4 — ESE — api-integrations (salty-spitoon)
  { id: 'api-integrations',   model: '/models/salty-spitoon-opt1-ktx.glb?v=3',                      posX: ringPos(4)[0],  posZ: ringPos(4)[1]  },
  // Slot 5 — SSE — app-publishing (boating-school)
  { id: 'app-publishing',     model: '/models/boating-school-opt1-ktx.glb?v=3',                     posX: ringPos(5)[0],  posZ: ringPos(5)[1]  },
  // Slot 6 — S — cron-automation (patty-building)
  { id: 'cron-automation',    model: '/models/patty-building-opt1-ktx.glb?v=3',                     posX: ringPos(6)[0],  posZ: ringPos(6)[1]  },
  // Slot 7 — SSW — deployment-ops (lighthouse)
  { id: 'deployment-ops',     model: '/models/building-lighthouse-opt1-ktx.glb?v=3',                posX: ringPos(7)[0],  posZ: ringPos(7)[1]  },
  // Slot 8 — WSW — claw-arcade
  { id: 'claw-arcade',        model: '/models/arcade/claw-arcade-exterior-opt1-ktx.glb?v=4',        posX: ringPos(8)[0],  posZ: ringPos(8)[1]  },
  // Slot 9 — W — cove
  { id: 'cove',               model: '/models/cove/cove-exterior-opt1-ktx.glb?v=4',                 posX: ringPos(9)[0],  posZ: ringPos(9)[1]  },
  // Slot 10 — WNW — agent-security (patricks-rock)
  { id: 'agent-security',     model: '/models/patricks-rock-v2-opt1-ktx.glb?v=5',                   posX: ringPos(10)[0], posZ: ringPos(10)[1] },
  // Slot 11 — NNW — memory-rag (squidward-house)
  { id: 'memory-rag',         model: '/models/squidward-house-opt1-ktx.glb?v=5',                    posX: ringPos(11)[0], posZ: ringPos(11)[1] },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoadedBuilding {
  spec: BuildingSpec;
  /** Per-GLB merged BufferGeometry — internal GLB transforms already baked, but NOT the ring-position translation. */
  geometry: THREE.BufferGeometry;
  /** World-space translation matrix for this building's ring slot. mergeGeometriesToMeshletAsset bakes this into positions. */
  worldMatrix: THREE.Matrix4;
  /** Triangle count of this building's source geometry — for HUD diagnostics. */
  triCount: number;
}

interface BuildingStatus {
  id: string;
  /** 'pending' | 'loaded' | 'error' */
  status: 'pending' | 'loaded' | 'error';
  tris: number;
  /** Number of LOD levels generated (1 = no LOD, just full detail). */
  lodCount: number;
  /** Triangle count of the coarsest LOD (for expected-savings display). */
  coarsestLodTris: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Walk the GLTF scene and collect ALL mesh geometries, merging them into one
 * BufferGeometry (position + optional uv only — the rasterizer only needs those).
 *
 * This is a conservative approach: it does not apply per-mesh transforms from
 * the scene graph (those transforms affect visual position but not tri count),
 * and it does not strip ground planes or decorative meshes (out of scope for
 * the spike). The goal is tri count measurement and FPS, not visual correctness.
 *
 * Returns null if the scene has no Mesh geometry at all.
 */
function collectAndMergeGeometries(root: THREE.Object3D): THREE.BufferGeometry | null {
  // Gather all mesh geometries. We apply each mesh's world matrix to the
  // position attribute so the final merged geometry occupies the right world
  // space (needed for bounding-sphere correctness in the meshlet chunker).
  const posArrays: Float32Array[] = [];
  const uvArrays: (Float32Array | null)[] = [];
  const indexArrays: (Uint32Array | Uint16Array | null)[] = [];
  const vertexOffsets: number[] = [];

  let totalVertices = 0;

  root.updateMatrixWorld(true);

  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const geo = mesh.geometry;
    if (!geo) return;

    const posAttr = geo.attributes['position'] as THREE.BufferAttribute | undefined;
    if (!posAttr) return;

    const count = posAttr.count;

    // Copy positions, applying the mesh's world matrix so bounding spheres
    // inside the meshlet chunker are in world space.
    const pos = new Float32Array(count * 3);
    const worldMat = mesh.matrixWorld;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      tmp.fromBufferAttribute(posAttr, i);
      tmp.applyMatrix4(worldMat);
      pos[i * 3 + 0] = tmp.x;
      pos[i * 3 + 1] = tmp.y;
      pos[i * 3 + 2] = tmp.z;
    }

    const uvAttr = geo.attributes['uv'] as THREE.BufferAttribute | undefined;
    let uvData: Float32Array | null = null;
    if (uvAttr) {
      uvData = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        uvData[i * 2 + 0] = uvAttr.getX(i);
        uvData[i * 2 + 1] = uvAttr.getY(i);
      }
    }

    vertexOffsets.push(totalVertices);
    totalVertices += count;
    posArrays.push(pos);
    uvArrays.push(uvData);

    if (geo.index) {
      indexArrays.push(geo.index.array as Uint32Array | Uint16Array);
    } else {
      indexArrays.push(null);
    }
  });

  if (totalVertices === 0) return null;

  // Merge into a single BufferGeometry.
  // Build merged position array.
  const mergedPos = new Float32Array(totalVertices * 3);
  let posWriteOffset = 0;
  for (const p of posArrays) {
    mergedPos.set(p, posWriteOffset);
    posWriteOffset += p.length;
  }

  // Build merged uv array (fill zeros for sub-meshes without UVs).
  const mergedUv = new Float32Array(totalVertices * 2);
  let uvWriteOffset = 0;
  for (let i = 0; i < uvArrays.length; i++) {
    const u = uvArrays[i];
    if (u) {
      mergedUv.set(u, uvWriteOffset);
    }
    // Advance by the number of UVs for this sub-mesh (whether or not it had UVs).
    const subVertCount = posArrays[i].length / 3;
    uvWriteOffset += subVertCount * 2;
  }

  // Build merged index array (offset indices by their sub-mesh vertex base).
  const indexParts: number[] = [];
  for (let i = 0; i < indexArrays.length; i++) {
    const idxArr = indexArrays[i];
    const base = vertexOffsets[i];
    const vCount = posArrays[i].length / 3;
    if (idxArr) {
      for (let j = 0; j < idxArr.length; j++) {
        indexParts.push(idxArr[j] + base);
      }
    } else {
      // Non-indexed: sequential indices.
      for (let j = 0; j < vCount; j++) {
        indexParts.push(base + j);
      }
    }
  }

  const mergedGeo = new THREE.BufferGeometry();
  mergedGeo.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  mergedGeo.setAttribute('uv', new THREE.BufferAttribute(mergedUv, 2));
  if (indexParts.length > 0) {
    mergedGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(indexParts), 1));
  }

  return mergedGeo;
}

// ---------------------------------------------------------------------------
// Load all 12 buildings in parallel
// ---------------------------------------------------------------------------

function loadAllBuildings(
  onProgress: (update: BuildingStatus) => void,
): Promise<LoadedBuilding[]> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const ktx2 = new KTX2Loader().setTranscoderPath('/basis/');
  ktx2.detectSupport({
    isWebGPURenderer: true,
    hasFeature: (name: string) =>
      name === 'texture-compression-bc' ||
      name === 'texture-compression-s3tc' ||
      name === 'texture-compression-etc2',
  } as any);
  loader.setKTX2Loader(ktx2);
  // Two buildings (visual-creation, messaging-channels) use KHR_draco_mesh_compression.
  // Without this they ERR out at load with "no DRACOLoader instance provided".
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  loader.setDRACOLoader(draco);

  const promises = BUILDINGS.map((spec): Promise<LoadedBuilding | null> => {
    return new Promise((resolve) => {
      loader.load(
        spec.model,
        async (gltf) => {
          try {
            const mergedGeo = collectAndMergeGeometries(gltf.scene);
            if (!mergedGeo) {
              onProgress({ id: spec.id, status: 'error', tris: 0, lodCount: 0, coarsestLodTris: 0, error: 'No geometry found' });
              resolve(null);
              return;
            }

            // Compute per-building scale to bring the GLB up to the same world
            // size /game uses (BUILDING_TARGET_HEIGHT = 1000wu max-dim). Without
            // this step buildings stay at native GLB scale (~5-10wu each) and
            // are sub-pixel from any sane camera. Matches the logic in
            // apps/web/src/lib/three/arena-buildings.tsx computeBuildingScale.
            const BUILDING_TARGET_HEIGHT = 1000;
            mergedGeo.computeBoundingBox();
            const bbox = mergedGeo.boundingBox!;
            const maxDim = Math.max(
              bbox.max.x - bbox.min.x,
              bbox.max.y - bbox.min.y,
              bbox.max.z - bbox.min.z,
            );
            const buildingScale = maxDim > 0.001 ? BUILDING_TARGET_HEIGHT / maxDim : 1;
            // Anchor the building so its bottom centre sits on the ring slot.
            const centreX = (bbox.min.x + bbox.max.x) / 2;
            const centreZ = (bbox.min.z + bbox.max.z) / 2;
            const minY = bbox.min.y;

            // worldMatrix = translate(slot) × scale(s) × translate(-centre, -minY, -centre)
            // Applies scale AROUND the bottom-centre anchor, then places at ring pos.
            const worldMatrix = new THREE.Matrix4()
              .makeTranslation(spec.posX, 0, spec.posZ)
              .multiply(new THREE.Matrix4().makeScale(buildingScale, buildingScale, buildingScale))
              .multiply(new THREE.Matrix4().makeTranslation(-centreX, -minY, -centreZ));

            const triCount = mergedGeo.index ? mergedGeo.index.count / 3 : mergedGeo.attributes.position.count / 3;

            onProgress({
              id: spec.id,
              status: 'loaded',
              tris: triCount,
              lodCount: 0, // LOD count is now global to the merged asset, not per-building
              coarsestLodTris: 0,
            });
            resolve({ spec, geometry: mergedGeo, worldMatrix, triCount });
          } catch (err) {
            onProgress({ id: spec.id, status: 'error', tris: 0, lodCount: 0, coarsestLodTris: 0, error: String(err) });
            resolve(null);
          }
        },
        undefined,
        (err) => {
          onProgress({ id: spec.id, status: 'error', tris: 0, error: String(err) });
          resolve(null);
        },
      );
    });
  });

  return Promise.all(promises).then((results) =>
    results.filter((r): r is LoadedBuilding => r !== null),
  );
}

// ---------------------------------------------------------------------------
// BareAll12Canvas — non-R3F canvas + manual rAF loop.
//
// We bailed on R3F (Canvas + useFrame + useThree) because the only known way
// to suppress R3F's end-of-frame renderer.render() call was to overwrite
// (renderer as any).render = () => {}, but that ALSO no-ops the rasterizer's
// own this.renderer.render(this.hwScene, camera) and (quadMesh as any).render(
// this.renderer) calls — killing all output.
//
// Bare path mirrors /preview/meshlet-spike-bare verbatim. Confirmed working
// architecture: 145 FPS with a lighthouse visible.
// ---------------------------------------------------------------------------

interface BareAll12CanvasProps {
  buildings: LoadedBuilding[];
  onFps: (fps: number) => void;
  onPixelProbe: (msg: string) => void;
  onMergedReady: (asset: MergedMeshletAsset) => void;
  onStatus: (status: string) => void;
}

function BareAll12Canvas({ buildings, onFps, onPixelProbe, onMergedReady, onStatus }: BareAll12CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current || buildings.length === 0) return;

    const canvas = canvasRef.current;
    let disposed = false;
    let rafId = 0;
    let renderer: THREE.WebGPURenderer | null = null;
    let rasterizer: NaniteRasterizer | null = null;
    let camera: THREE.PerspectiveCamera | null = null;

    (async () => {
      onStatus('Sizing canvas…');
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);

      onStatus('Creating WebGPURenderer…');
      renderer = new THREE.WebGPURenderer({
        canvas,
        antialias: false,
        forceWebGL: false,
      });
      (renderer as any).setPixelRatio(dpr);
      await renderer.init();
      renderer.setSize(rect.width, rect.height, false);
      if (disposed) return;

      onStatus('Building merged asset…');
      const mergedAsset = await mergeGeometriesToMeshletAsset(
        buildings.map((b, idx) => ({
          geometry: b.geometry,
          worldMatrix: b.worldMatrix,
          sourceId: idx,
        })),
      );
      if (disposed) return;
      onMergedReady(mergedAsset);

      onStatus('Constructing NaniteRasterizer…');
      // instanceBoundingRadius covers the world-space extent of the ring
      // (R=4160 + ~50wu per building → 5000 is safe).
      // pixelErrorThreshold=0 forces every cluster to render at LOD 0 (full
      // detail). With merged assets the per-instance LOD cascade picks ONE
      // level for everything — at game distance that's LOD 6 = 277 tris across
      // 11 buildings = nearly invisible. Forcing LOD 0 renders all 68k tris
      // so every building is clearly visible. Real Nanite uses per-cluster
      // LOD selection which is the proper fix; tracked as task #33.
      rasterizer = new NaniteRasterizer(renderer, mergedAsset, {
        instanceCount: 1,
        staticInstanceData: new Float32Array([0, 0, 0, 1]),
        // Default 16 — large tris fall through to HW fallback. Was bumped to
        // 4096 for the diagnostic that uncovered the TRIANGLE_INDEX_BITS=14
        // truncation bug in the HW path (fixed in nanite-rasterizer.ts with
        // 14→18 bit widening). Now we measure FPS + visibility with HW path
        // active again — should be 167 FPS AND all walls visible.
        maxRasterSize: 16,
        instanceBoundingRadius: 5000,
        pixelErrorThreshold: 0,
      });
      await rasterizer.init();
      if (disposed) return;

      // Bird's-eye camera framing the whole 11-building ring. Higher than the
      // /game default so all 11 ring slots are clearly in frame. Each building
      // is 1000wu tall; ring radius 4160wu; this camera sits 8000wu above and
      // back, giving each building ~80-150px on a 1080p viewport.
      camera = new THREE.PerspectiveCamera(50, rect.width / rect.height, 10, 30000);
      camera.position.set(0, 5000, 7500);
      camera.lookAt(0, 500, 0);
      camera.updateMatrixWorld();

      onStatus('Running render loop…');

      let frames = 0;
      let lastFpsT = performance.now();
      let lastPixelT = performance.now();

      const tick = async () => {
        if (disposed || !renderer || !rasterizer || !camera) return;
        try {
          await rasterizer.render(camera, canvas.width / dpr, canvas.height / dpr);
        } catch (err) {
          console.error('[meshlet-all-12 bare] render error:', err);
        }

        frames++;
        const now = performance.now();
        if (now - lastFpsT >= 1000) {
          onFps(Math.round((frames * 1000) / (now - lastFpsT)));
          frames = 0;
          lastFpsT = now;
        }
        if (now - lastPixelT >= 2000) {
          lastPixelT = now;
          try {
            const probe = document.createElement('canvas');
            probe.width = canvas.width; probe.height = canvas.height;
            const ctx = probe.getContext('2d');
            if (ctx) {
              ctx.drawImage(canvas, 0, 0);
              const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              let coloured = 0, nonZero = 0, sampled = 0;
              const step = Math.max(1, Math.floor((d.length/4) / 5000));
              for (let i = 0; i < d.length; i += 4 * step) {
                sampled++;
                if (d[i] || d[i+1] || d[i+2] || d[i+3]) nonZero++;
                if (d[i] > 4 || d[i+1] > 4 || d[i+2] > 4) coloured++;
              }
              onPixelProbe(`${coloured}/${sampled} colored (${(coloured/sampled*100).toFixed(1)}%) · ${nonZero} any`);
            }
          } catch (e) {
            onPixelProbe('probe failed: ' + (e as Error).message);
          }
        }

        rafId = requestAnimationFrame(tick);
      };
      tick();
    })().catch((err) => {
      console.error('[meshlet-all-12 bare] init failed:', err);
      onStatus('FAILED: ' + String(err?.message ?? err));
    });

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rasterizer?.dispose();
      try { (renderer as any)?.dispose?.(); } catch {}
    };
  }, [buildings, onFps, onPixelProbe, onMergedReady, onStatus]);

  return <canvas ref={canvasRef} style={styles.canvas} />;
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function MeshletSpikeAll12Page() {
  const [webGpuAbsent] = useState<boolean>(() => {
    if (typeof navigator === 'undefined') return false;
    return !('gpu' in navigator);
  });

  // Loading state per building.
  const [buildingStatuses, setBuildingStatuses] = useState<Map<string, BuildingStatus>>(
    () => new Map(BUILDINGS.map((b) => [b.id, { id: b.id, status: 'pending', tris: 0, lodCount: 0, coarsestLodTris: 0 }])),
  );
  const [loadedBuildings, setLoadedBuildings] = useState<LoadedBuilding[]>([]);
  const [loadComplete, setLoadComplete] = useState(false);
  const [fps, setFps] = useState(0);
  const [pixelProbe, setPixelProbe] = useState<string>('—');
  const [mergedAsset, setMergedAsset] = useState<MergedMeshletAsset | null>(null);

  const totalTris = Array.from(buildingStatuses.values()).reduce((s, b) => s + b.tris, 0);
  const loadedCount = Array.from(buildingStatuses.values()).filter((b) => b.status === 'loaded').length;
  const errorCount = Array.from(buildingStatuses.values()).filter((b) => b.status === 'error').length;

  // Stats now come from the merged asset (post-LOD), not the per-building progress entries.
  const mergedTotalTris = mergedAsset?.triangleCount ?? 0;
  const mergedCoarsestTris = mergedAsset
    ? (mergedAsset.lodTriCounts[mergedAsset.lodCount - 1] ?? mergedAsset.triangleCount)
    : 0;
  const mergedLodCount = mergedAsset?.lodCount ?? 0;
  const mergedReductionPct = mergedTotalTris > 0
    ? Math.round((1 - mergedCoarsestTris / mergedTotalTris) * 100)
    : 0;

  useEffect(() => {
    if (webGpuAbsent) return;

    const onProgress = (update: BuildingStatus) => {
      setBuildingStatuses((prev) => {
        const next = new Map(prev);
        next.set(update.id, update);
        return next;
      });
    };

    loadAllBuildings(onProgress).then((buildings) => {
      setLoadedBuildings(buildings);
      setLoadComplete(true);
    });
  }, [webGpuAbsent]);

  // Dispose source BufferGeometries on unmount / reload.
  useEffect(() => {
    return () => {
      loadedBuildings.forEach((b) => b.geometry.dispose());
    };
  }, [loadedBuildings]);

  const [status, setStatus] = useState<string>('Initialising…');

  const handleFps = useCallback((f: number) => setFps(f), []);
  const handlePixelProbe = useCallback((m: string) => setPixelProbe(m), []);
  const handleMergedReady = useCallback((a: MergedMeshletAsset) => setMergedAsset(a), []);
  const handleStatus = useCallback((s: string) => setStatus(s), []);

  // --- WebGPU absent ---
  if (webGpuAbsent) {
    return (
      <div style={styles.errorPage}>
        <div style={styles.errorBox}>
          <div style={styles.errorTitle}>WebGPU Not Available</div>
          <div style={styles.errorBody}>
            This spike requires WebGPU. Enable in chrome://flags or use Chrome 113+.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      {/* BARE canvas — no R3F. Owns its own WebGPURenderer + rAF loop.
          R3F kept overwriting renderer.render to bypass its end-of-frame render
          which ALSO killed the rasterizer's internal renderer.render(hwScene)
          and quadMesh.render(renderer) calls. Bare path matches the proven
          /preview/meshlet-spike-bare architecture (145 FPS, visible mesh). */}
      {loadComplete && loadedBuildings.length > 0 && (
        <BareAll12Canvas
          buildings={loadedBuildings}
          onFps={handleFps}
          onPixelProbe={handlePixelProbe}
          onMergedReady={handleMergedReady}
          onStatus={handleStatus}
        />
      )}

      {/* FPS + stats overlay — plain HTML DOM, no drei Text (Iris Xe rule). */}
      <div style={styles.overlay}>
        <div style={styles.overlayTitle}>Meshlet Spike — All 12</div>

        <div style={styles.overlayRow}>
          <span style={styles.overlayLabel}>FPS</span>
          <span style={{
            ...styles.overlayValue,
            color: fps >= 60 ? '#4ade80' : fps >= 30 ? '#facc15' : '#f87171',
          }}>
            {loadComplete ? fps : '—'}
          </span>
        </div>

        <div style={styles.overlayRow}>
          <span style={styles.overlayLabel}>Pixel probe</span>
          <span style={{ ...styles.overlayValue, color: pixelProbe.startsWith('0/') ? '#f87171' : '#4ade80' }}>
            {pixelProbe}
          </span>
        </div>

        <div style={styles.overlayRow}>
          <span style={styles.overlayLabel}>Source tris (sum)</span>
          <span style={styles.overlayValue}>{totalTris.toLocaleString()}</span>
        </div>

        {mergedAsset && (
          <>
            <div style={styles.overlayRow}>
              <span style={styles.overlayLabel}>Merged LOD 0 tris</span>
              <span style={styles.overlayValue}>{mergedTotalTris.toLocaleString()}</span>
            </div>
            <div style={styles.overlayRow}>
              <span style={styles.overlayLabel}>Merged coarsest tris</span>
              <span style={{ ...styles.overlayValue, color: '#60a5fa' }}>
                {mergedCoarsestTris.toLocaleString()}
              </span>
            </div>
            <div style={styles.overlayRow}>
              <span style={styles.overlayLabel}>Merged LOD count</span>
              <span style={styles.overlayValue}>
                {mergedLodCount} ({mergedReductionPct}% reduction)
              </span>
            </div>
            <div style={styles.overlayRow}>
              <span style={styles.overlayLabel}>Total chunks</span>
              <span style={styles.overlayValue}>{mergedAsset.totalChunks.toLocaleString()}</span>
            </div>
          </>
        )}

        <div style={styles.overlayRow}>
          <span style={styles.overlayLabel}>Rasterizer</span>
          <span style={{ ...styles.overlayValue, color: mergedAsset ? '#4ade80' : '#facc15' }}>
            {mergedAsset ? 'merged-asset ready' : 'building merged asset…'}
          </span>
        </div>

        <div style={styles.overlayRow}>
          <span style={styles.overlayLabel}>Buildings loaded</span>
          <span style={styles.overlayValue}>
            {loadComplete ? loadedBuildings.length : loadedCount} / {BUILDINGS.length}
          </span>
        </div>

        {errorCount > 0 && (
          <div style={{ ...styles.overlayRow, color: '#f87171', marginTop: 4, fontSize: 11 }}>
            {errorCount} building(s) failed to load
          </div>
        )}

        {!loadComplete && (
          <div style={{ ...styles.overlayRow, marginTop: 8, color: '#facc15' }}>
            Loading geometry… ({loadedCount}/{BUILDINGS.length})
          </div>
        )}

        {/* Per-building breakdown — shows tri count per GLB */}
        <div style={styles.separator} />
        {BUILDINGS.map((b) => {
          const status = buildingStatuses.get(b.id);
          return (
            <div key={b.id} style={styles.buildingRow}>
              <span style={styles.buildingId}>{b.id.replace(/-/g, '‑')}</span>
              <span style={{
                fontSize: 10,
                color: status?.status === 'loaded'
                  ? '#a3e635'
                  : status?.status === 'error'
                  ? '#f87171'
                  : '#6b7280',
              }}>
                {status?.status === 'loaded'
                  ? status.tris.toLocaleString()
                  : status?.status === 'error'
                  ? 'ERR'
                  : '...'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Static styles (no Tailwind — plain CSS-in-JS preview page)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'fixed',
    inset: 0,
    background: '#080c10',
  },
  canvas: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
  },
  overlay: {
    position: 'absolute',
    top: 12,
    left: 12,
    padding: '10px 14px',
    background: 'rgba(0,0,0,0.80)',
    color: '#e5e7eb',
    font: '12px/1.5 "Courier New", monospace',
    borderRadius: 8,
    backdropFilter: 'blur(4px)',
    minWidth: 240,
    maxWidth: 280,
    pointerEvents: 'none',
  },
  overlayTitle: {
    fontWeight: 700,
    fontSize: 14,
    marginBottom: 8,
    letterSpacing: '0.02em',
    color: '#ffffff',
  },
  overlayRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 2,
  },
  overlayLabel: {
    opacity: 0.65,
    fontSize: 11,
  },
  overlayValue: {
    fontWeight: 600,
    color: '#4ade80',
    fontSize: 11,
  },
  separator: {
    height: 1,
    background: 'rgba(255,255,255,0.1)',
    margin: '8px 0',
  },
  buildingRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    marginBottom: 1,
  },
  buildingId: {
    fontSize: 9,
    color: '#9ca3af',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 140,
  },
  errorPage: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#080c10',
    color: '#fff',
  },
  errorBox: {
    maxWidth: 480,
    padding: 32,
    background: '#1a1a1a',
    borderRadius: 12,
    border: '1px solid #333',
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: 700,
    marginBottom: 12,
    color: '#f87171',
  },
  errorBody: {
    fontSize: 14,
    lineHeight: 1.6,
    color: '#d1d5db',
  },
};
