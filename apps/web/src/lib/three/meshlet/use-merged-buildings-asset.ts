// @ts-nocheck
/**
 * useMergedBuildingsAsset — loads all 11 ClawVille building GLBs in parallel,
 * scales each to BUILDING_TARGET_HEIGHT (1000 wu) anchored at bottom-centre on
 * its ring slot, and merges them into ONE MergedMeshletAsset for the rasterizer.
 *
 * Extracted from /preview/meshlet-spike-all-12 page so it can be re-used by
 * both that preview page AND the /game integration (Phase B). Replaces the
 * inline loadAllBuildings + collectAndMergeGeometries + per-building scale
 * logic that lived in the preview page.
 */
'use client';

import { useEffect, useState } from 'react';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import {
  mergeGeometriesToMeshletAsset,
  type MergedMeshletAsset,
} from '@/lib/three/experimental/nanite-rasterizer';
import {
  MESHLET_BUILDINGS,
  BUILDING_TARGET_HEIGHT,
  type BuildingSpec,
} from './buildings-manifest';

export interface BuildingLoadStatus {
  id: string;
  status: 'pending' | 'loaded' | 'error';
  tris: number;
  error?: string;
}

export interface UseMergedBuildingsAssetReturn {
  /** Final merged asset — null until all buildings loaded + merged. */
  asset: MergedMeshletAsset | null;
  /** Per-building load state, keyed by spec.id. */
  perBuildingStatus: Map<string, BuildingLoadStatus>;
  /** Global state machine. */
  state: 'loading' | 'merging' | 'ready' | 'error';
  /** True once all GLBs downloaded (before merge step). */
  allLoaded: boolean;
  /** First fatal error (if any). */
  error: string | null;
  /** Total triangle count across all source geometries (sum). */
  totalSourceTris: number;
}

/**
 * Walk a GLTF scene and merge all mesh geometries into ONE BufferGeometry.
 * Applies each mesh's world matrix to positions so the merged geo is in GLB
 * world space (independent of sub-mesh transforms).
 */
function collectAndMergeGeometries(root: THREE.Object3D): THREE.BufferGeometry | null {
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
    const pos = new Float32Array(count * 3);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      tmp.fromBufferAttribute(posAttr, i);
      tmp.applyMatrix4(mesh.matrixWorld);
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
    indexArrays.push(geo.index ? (geo.index.array as Uint32Array | Uint16Array) : null);
  });

  if (totalVertices === 0) return null;

  const mergedPos = new Float32Array(totalVertices * 3);
  let posWriteOffset = 0;
  for (const p of posArrays) { mergedPos.set(p, posWriteOffset); posWriteOffset += p.length; }

  const mergedUv = new Float32Array(totalVertices * 2);
  let uvWriteOffset = 0;
  for (let i = 0; i < uvArrays.length; i++) {
    const u = uvArrays[i];
    if (u) mergedUv.set(u, uvWriteOffset);
    uvWriteOffset += (posArrays[i].length / 3) * 2;
  }

  const indexParts: number[] = [];
  for (let i = 0; i < indexArrays.length; i++) {
    const idxArr = indexArrays[i];
    const base = vertexOffsets[i];
    const vCount = posArrays[i].length / 3;
    if (idxArr) {
      for (let j = 0; j < idxArr.length; j++) indexParts.push(idxArr[j] + base);
    } else {
      for (let j = 0; j < vCount; j++) indexParts.push(base + j);
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

interface LoadedBuildingGeo {
  spec: BuildingSpec;
  geometry: THREE.BufferGeometry;
  worldMatrix: THREE.Matrix4;
  triCount: number;
  /** Per-building diffuse colour extracted from the first mesh's material. RGB in [0,1]. Defaults to white. */
  color: [number, number, number];
  /**
   * Raw RGBA pixels for the LARGEST mesh's diffuse texture, downsampled to
   * TEXTURE_ARRAY_LAYER_SIZE × TEXTURE_ARRAY_LAYER_SIZE. Null when no diffuse
   * was extractable — caller fills the layer with `color` instead so
   * materialMode=1 still produces something other than magenta.
   */
  textureLayer: Uint8Array | null;
}

/**
 * Fixed size for every layer in the per-source DataArrayTexture. Every
 * building's diffuse is downscaled to this resolution at load time so all
 * layers share dimensions (a hard WebGPU/DataArrayTexture requirement).
 *
 * 512 was picked as a balance between:
 *   - visual fidelity at game viewing distance (buildings are 1000wu tall,
 *     screen-projection is at most ~200px tall, so 512 has headroom)
 *   - GPU upload cost (11 layers × 512×512 × 4 bytes = ~11.5 MB)
 *   - mipmap headroom (log2(512) = 9 mip levels available)
 *
 * Bump to 1024 if buildings look mushy on close approach.
 */
const TEXTURE_ARRAY_LAYER_SIZE = 512;

/**
 * Sample a diffuse texture's central region and return the average RGB.
 * Returns null if the image isn't drawable (e.g. compressed texture format).
 */
function sampleTextureAverage(tex: THREE.Texture | null | undefined): [number, number, number] | null {
  if (!tex) return null;
  const img = (tex as any).image as HTMLImageElement | ImageBitmap | HTMLCanvasElement | null;
  if (!img) return null;
  const w = (img as any).width;
  const h = (img as any).height;
  if (!w || !h) return null;
  try {
    const c = document.createElement('canvas');
    // Downsample for speed — 32×32 is enough for an average tint.
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img as any, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Skip nearly-transparent pixels (alpha < 32) — they're likely cutouts.
      if (data[i + 3] < 32) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    if (n === 0) return null;
    return [r / n / 255, g / n / 255, b / n / 255];
  } catch {
    // drawImage can throw for unloadable images (KTX2, etc.) or CORS.
    return null;
  }
}

/**
 * Render a Texture's image to a TEXTURE_ARRAY_LAYER_SIZE-square canvas and
 * return RGBA bytes. Returns null if the image isn't drawable (compressed
 * format, CORS, not-yet-loaded image). PNG/JPEG/WebP all draw fine.
 */
function rasterizeTextureToLayer(tex: THREE.Texture | null | undefined): Uint8Array | null {
  if (!tex) return null;
  const img = (tex as any).image as
    | HTMLImageElement
    | ImageBitmap
    | HTMLCanvasElement
    | null;
  if (!img) return null;
  const w = (img as any).width;
  const h = (img as any).height;
  if (!w || !h) return null;
  try {
    const c = document.createElement('canvas');
    c.width = TEXTURE_ARRAY_LAYER_SIZE;
    c.height = TEXTURE_ARRAY_LAYER_SIZE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    // Flip Y to convert from glTF UV convention (origin bottom-left) to
    // canvas2d convention (origin top-left). The rasterizer samples
    // texture(arrayTex, uv) without any flipY metadata baked into the
    // DataArrayTexture, so we do the flip at upload time.
    ctx.save();
    ctx.scale(1, -1);
    ctx.drawImage(
      img as any,
      0,
      -TEXTURE_ARRAY_LAYER_SIZE,
      TEXTURE_ARRAY_LAYER_SIZE,
      TEXTURE_ARRAY_LAYER_SIZE,
    );
    ctx.restore();
    const data = ctx.getImageData(0, 0, TEXTURE_ARRAY_LAYER_SIZE, TEXTURE_ARRAY_LAYER_SIZE).data;
    return new Uint8Array(data.buffer.slice(0));
  } catch {
    return null;
  }
}

/**
 * Find the diffuse texture belonging to the LARGEST mesh (by vertex count) in
 * the GLB scene. We use vertex count as a proxy for "this is the dominant
 * mesh whose texture best represents the building." krusty-krab has 20 sub-
 * meshes with 20 distinct textures; picking the largest one's diffuse is a
 * compromise that produces sensible output for the common case.
 *
 * Returns null when no mesh has a sampleable diffuse texture.
 */
function pickLargestMeshDiffuse(root: THREE.Object3D): THREE.Texture | null {
  let bestTex: THREE.Texture | null = null;
  let bestVerts = -1;
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const geo = mesh.geometry;
    const posAttr = geo?.attributes?.['position'] as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    const verts = posAttr.count;
    if (verts <= bestVerts) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!mat) return;
    const map = (mat as any).map as THREE.Texture | undefined;
    if (!map) return;
    bestTex = map;
    bestVerts = verts;
  });
  return bestTex;
}

/**
 * Walk the GLTF scene, find the first mesh's material, return a representative
 * RGB color. Priority order:
 *   1. material.map (diffuse texture) → average centre 32×32 pixel
 *   2. material.color (THREE.Color) → use directly
 *   3. fallback white (1,1,1)
 * Most ClawVille GLBs are PBR (material.color is white, color lives in map).
 */
function extractDiffuseColor(root: THREE.Object3D): [number, number, number] {
  let result: [number, number, number] = [1, 1, 1];
  let found = false;
  root.traverse((obj) => {
    if (found) return;
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!mat) return;

    // Try diffuse texture average first.
    const map = (mat as any).map as THREE.Texture | undefined;
    const sampled = sampleTextureAverage(map);
    if (sampled) {
      result = sampled;
      found = true;
      return;
    }

    // Fallback to material.color if no map (or map not drawable).
    const col = (mat as any).color as THREE.Color | undefined;
    if (col && typeof col.r === 'number') {
      // If the color is pure white AND there was a map we couldn't sample,
      // keep looking — next mesh's material might have a usable colour.
      const isWhite = col.r > 0.95 && col.g > 0.95 && col.b > 0.95;
      if (!isWhite || !map) {
        result = [col.r, col.g, col.b];
        found = true;
      }
    }
  });
  return result;
}

export function useMergedBuildingsAsset(): UseMergedBuildingsAssetReturn {
  const [asset, setAsset] = useState<MergedMeshletAsset | null>(null);
  const [perBuildingStatus, setPerBuildingStatus] = useState<Map<string, BuildingLoadStatus>>(
    () => new Map(MESHLET_BUILDINGS.map((b) => [b.id, { id: b.id, status: 'pending', tris: 0 }])),
  );
  const [state, setState] = useState<'loading' | 'merging' | 'ready' | 'error'>('loading');
  const [allLoaded, setAllLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalSourceTris, setTotalSourceTris] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const loadedGeos: LoadedBuildingGeo[] = [];

    const updateStatus = (s: BuildingLoadStatus) => {
      if (cancelled) return;
      setPerBuildingStatus((prev) => {
        const next = new Map(prev);
        next.set(s.id, s);
        return next;
      });
    };

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    loader.setDRACOLoader(draco);

    (async () => {
      try {
        const loadPromises = MESHLET_BUILDINGS.map((spec) => {
          return new Promise<LoadedBuildingGeo | null>((resolve) => {
            loader.load(
              spec.model,
              async (gltf) => {
                if (cancelled) return resolve(null);
                try {
                  const mergedGeo = collectAndMergeGeometries(gltf.scene);
                  if (!mergedGeo) {
                    updateStatus({ id: spec.id, status: 'error', tris: 0, error: 'No geometry' });
                    return resolve(null);
                  }
                  mergedGeo.computeBoundingBox();
                  const bbox = mergedGeo.boundingBox!;
                  const maxDim = Math.max(
                    bbox.max.x - bbox.min.x,
                    bbox.max.y - bbox.min.y,
                    bbox.max.z - bbox.min.z,
                  );
                  const buildingScale = maxDim > 0.001 ? BUILDING_TARGET_HEIGHT / maxDim : 1;
                  const centreX = (bbox.min.x + bbox.max.x) / 2;
                  const centreZ = (bbox.min.z + bbox.max.z) / 2;
                  const minY = bbox.min.y;
                  const worldMatrix = new THREE.Matrix4()
                    .makeTranslation(spec.posX, 0, spec.posZ)
                    .multiply(new THREE.Matrix4().makeScale(buildingScale, buildingScale, buildingScale))
                    .multiply(new THREE.Matrix4().makeTranslation(-centreX, -minY, -centreZ));
                  const triCount = mergedGeo.index
                    ? mergedGeo.index.count / 3
                    : mergedGeo.attributes.position.count / 3;
                  // Try real texture/material color first; if it returns the
                  // default white sentinel (which happens for KTX2 textures and
                  // PBR materials whose color is white), use the building's
                  // hand-curated fallbackColor instead.
                  const extracted = extractDiffuseColor(gltf.scene);
                  const isPureWhite = extracted[0] > 0.95 && extracted[1] > 0.95 && extracted[2] > 0.95;
                  const color: [number, number, number] = isPureWhite ? spec.fallbackColor : extracted;
                  // Extract the LARGEST mesh's diffuse texture as a 512×512
                  // RGBA layer for the rasterizer's materialMode=1 sampler.
                  // Null when the texture isn't drawable — caller fills the
                  // layer with solid `color` instead of crashing.
                  const dominantDiffuse = pickLargestMeshDiffuse(gltf.scene);
                  const textureLayer = rasterizeTextureToLayer(dominantDiffuse);
                  console.log(
                    '[meshlet-tex]', spec.id,
                    'color=', color.map((v) => v.toFixed(2)).join(','),
                    'tex=', textureLayer ? `${TEXTURE_ARRAY_LAYER_SIZE}^2 RGBA` : 'fallback-solid',
                  );
                  updateStatus({ id: spec.id, status: 'loaded', tris: triCount });
                  resolve({ spec, geometry: mergedGeo, worldMatrix, triCount, color, textureLayer });
                } catch (err) {
                  updateStatus({ id: spec.id, status: 'error', tris: 0, error: String(err) });
                  resolve(null);
                }
              },
              undefined,
              (err) => {
                updateStatus({ id: spec.id, status: 'error', tris: 0, error: String(err) });
                resolve(null);
              },
            );
          });
        });

        const results = await Promise.all(loadPromises);
        if (cancelled) return;
        const valid = results.filter((r): r is LoadedBuildingGeo => r !== null);
        loadedGeos.push(...valid);
        if (valid.length === 0) {
          setError('No buildings loaded');
          setState('error');
          return;
        }
        setAllLoaded(true);
        setTotalSourceTris(valid.reduce((s, g) => s + g.triCount, 0));
        setState('merging');

        const merged = await mergeGeometriesToMeshletAsset(
          valid.map((g, idx) => ({
            geometry: g.geometry,
            worldMatrix: g.worldMatrix,
            sourceId: idx,
            color: g.color,
          })),
        );
        if (cancelled) return;

        // Build the per-source DataArrayTexture for materialMode=1 sampling.
        // One layer per source mesh. Buildings whose largest mesh had no
        // sampleable diffuse get a solid-color layer (their fallbackColor)
        // so the shader still produces meaningful output instead of magenta.
        const N = valid.length;
        const layerBytes = TEXTURE_ARRAY_LAYER_SIZE * TEXTURE_ARRAY_LAYER_SIZE * 4;
        const flat = new Uint8Array(N * layerBytes);
        let solidLayers = 0;
        for (let i = 0; i < N; i++) {
          const g = valid[i];
          const offset = i * layerBytes;
          if (g.textureLayer && g.textureLayer.length === layerBytes) {
            flat.set(g.textureLayer, offset);
          } else {
            solidLayers++;
            const r = Math.round(g.color[0] * 255);
            const gC = Math.round(g.color[1] * 255);
            const b = Math.round(g.color[2] * 255);
            for (let p = 0; p < layerBytes; p += 4) {
              flat[offset + p + 0] = r;
              flat[offset + p + 1] = gC;
              flat[offset + p + 2] = b;
              flat[offset + p + 3] = 255;
            }
          }
        }
        const arrayTex = new THREE.DataArrayTexture(
          flat,
          TEXTURE_ARRAY_LAYER_SIZE,
          TEXTURE_ARRAY_LAYER_SIZE,
          N,
        );
        arrayTex.format = THREE.RGBAFormat;
        arrayTex.type = THREE.UnsignedByteType;
        arrayTex.minFilter = THREE.LinearMipmapLinearFilter;
        arrayTex.magFilter = THREE.LinearFilter;
        arrayTex.wrapS = THREE.RepeatWrapping;
        arrayTex.wrapT = THREE.RepeatWrapping;
        arrayTex.generateMipmaps = true;
        arrayTex.needsUpdate = true;
        (merged as any).textureArray = arrayTex;
        console.log(
          '[useMergedBuildingsAsset] textureArray ready —',
          N, 'layers @', TEXTURE_ARRAY_LAYER_SIZE, '×', TEXTURE_ARRAY_LAYER_SIZE,
          `(${(N * layerBytes / 1024 / 1024).toFixed(1)} MB)`,
          solidLayers > 0 ? `(${solidLayers} solid-color fallback)` : '',
        );

        setAsset(merged);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        console.error('[useMergedBuildingsAsset] load failed:', err);
        setError(String((err as Error)?.message ?? err));
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
      // Dispose source geometries on unmount/reload — the merged asset owns
      // its own typed arrays so it's safe to dispose the sources.
      for (const g of loadedGeos) {
        try { g.geometry.dispose(); } catch {}
      }
    };
  }, []);

  return { asset, perBuildingStatus, state, allLoaded, error, totalSourceTris };
}
