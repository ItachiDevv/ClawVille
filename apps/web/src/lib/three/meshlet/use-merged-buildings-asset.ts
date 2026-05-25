// @ts-nocheck
/**
 * useMergedBuildingsAsset — loads all ClawVille building GLBs, scales each to
 * BUILDING_TARGET_HEIGHT anchored at bottom-centre on its ring slot, then
 * merges every renderable sub-mesh into ONE MergedMeshletAsset.
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
import { buildSubMeshAtlas, canDrawTextureToCanvas } from './build-buildings-atlas';

export interface BuildingLoadStatus {
  id: string;
  status: 'pending' | 'loaded' | 'error';
  tris: number;
  error?: string;
}

export interface UseMergedBuildingsAssetReturn {
  asset: MergedMeshletAsset | null;
  perBuildingStatus: Map<string, BuildingLoadStatus>;
  state: 'loading' | 'merging' | 'ready' | 'error';
  allLoaded: boolean;
  error: string | null;
  totalSourceTris: number;
}

interface LoadedSubMesh {
  id: string;
  buildingId: string;
  subMeshName: string;
  geometry: THREE.BufferGeometry;
  worldMatrix: THREE.Matrix4;
  triCount: number;
  diffuse: THREE.Texture;
  materialName: string;
}

function materialAt(material: THREE.Material | THREE.Material[], index: number): THREE.Material | null {
  if (Array.isArray(material)) return material[index] ?? material[0] ?? null;
  return material ?? null;
}

function materialMap(material: THREE.Material | null): THREE.Texture | null {
  return ((material as any)?.map as THREE.Texture | undefined) ?? null;
}

function dumpMeshletSubMeshesOnce(subMeshes: LoadedSubMesh[]) {
  if ((globalThis as any).__meshletSubMeshDumped) return;
  (globalThis as any).__meshletSubMeshDumped = true;

  const dump = subMeshes.map((sub) => {
    const m = sub.worldMatrix.elements;
    const img = ((sub.diffuse as any)?.image ?? (sub.diffuse as any)?.source?.data) as any;
    const posAttr = sub.geometry.attributes['position'] as THREE.BufferAttribute | undefined;
    return {
      buildingId: sub.buildingId,
      subMeshName: sub.subMeshName,
      vertexCount: posAttr?.count ?? 0,
      triCount: sub.triCount,
      worldMatrixFirstRow: [m[0], m[4], m[8], m[12]],
      hasDiffuseMap: true,
      diffuseImageSrc: img?.src ?? '(canvas/bitmap/null)',
      diffuseImageWidth: img?.width ?? null,
      diffuseImageHeight: img?.height ?? null,
      materialName: sub.materialName,
    };
  });
  (globalThis as any).__meshletDump = dump;
  console.log('[meshlet-dump]', dump);
}

function geometryTriCount(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? geometry.index.count / 3
    : (geometry.attributes.position?.count ?? 0) / 3;
}

function computeSceneGeometryBox(root: THREE.Object3D): THREE.Box3 | null {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  let found = false;

  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const posAttr = mesh.geometry?.attributes?.['position'] as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    for (let i = 0; i < posAttr.count; i++) {
      tmp.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      box.expandByPoint(tmp);
      found = true;
    }
  });

  return found ? box : null;
}

function buildBuildingWorldMatrix(spec: BuildingSpec, sceneBox: THREE.Box3): THREE.Matrix4 {
  const maxDim = Math.max(
    sceneBox.max.x - sceneBox.min.x,
    sceneBox.max.y - sceneBox.min.y,
    sceneBox.max.z - sceneBox.min.z,
  );
  const buildingScale = maxDim > 0.001 ? BUILDING_TARGET_HEIGHT / maxDim : 1;
  const centreX = (sceneBox.min.x + sceneBox.max.x) / 2;
  const centreZ = (sceneBox.min.z + sceneBox.max.z) / 2;
  const minY = sceneBox.min.y;

  return new THREE.Matrix4()
    .makeTranslation(spec.posX, 0, spec.posZ)
    .multiply(new THREE.Matrix4().makeScale(buildingScale, buildingScale, buildingScale))
    .multiply(new THREE.Matrix4().makeTranslation(-centreX, -minY, -centreZ));
}

function copyFullGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const posAttr = source.attributes['position'] as THREE.BufferAttribute | undefined;
  if (!posAttr) return null;

  const pos = new Float32Array(posAttr.count * 3);
  for (let i = 0; i < posAttr.count; i++) {
    pos[i * 3 + 0] = posAttr.getX(i);
    pos[i * 3 + 1] = posAttr.getY(i);
    pos[i * 3 + 2] = posAttr.getZ(i);
  }

  const uvAttr = source.attributes['uv'] as THREE.BufferAttribute | undefined;
  const uv = new Float32Array(posAttr.count * 2);
  if (uvAttr) {
    for (let i = 0; i < posAttr.count; i++) {
      uv[i * 2 + 0] = uvAttr.getX(i);
      uv[i * 2 + 1] = uvAttr.getY(i);
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  if (source.index) {
    const src = source.index.array;
    const index = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i++) index[i] = src[i];
    out.setIndex(new THREE.BufferAttribute(index, 1));
  }

  return out;
}

function copyGeometryGroup(source: THREE.BufferGeometry, group: { start: number; count: number }): THREE.BufferGeometry | null {
  const posAttr = source.attributes['position'] as THREE.BufferAttribute | undefined;
  if (!posAttr || group.count <= 0) return null;

  const uvAttr = source.attributes['uv'] as THREE.BufferAttribute | undefined;
  const srcIndex = source.index?.array as ArrayLike<number> | undefined;
  const vertexCount = group.count;
  const pos = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);

  for (let i = 0; i < vertexCount; i++) {
    const srcVertex = srcIndex ? srcIndex[group.start + i] : group.start + i;
    pos[i * 3 + 0] = posAttr.getX(srcVertex);
    pos[i * 3 + 1] = posAttr.getY(srcVertex);
    pos[i * 3 + 2] = posAttr.getZ(srcVertex);
    if (uvAttr) {
      uv[i * 2 + 0] = uvAttr.getX(srcVertex);
      uv[i * 2 + 1] = uvAttr.getY(srcVertex);
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

function collectBuildingSubMeshes(spec: BuildingSpec, root: THREE.Object3D): LoadedSubMesh[] {
  const sceneBox = computeSceneGeometryBox(root);
  if (!sceneBox) return [];

  const buildingWorldMatrix = buildBuildingWorldMatrix(spec, sceneBox);
  const subMeshes: LoadedSubMesh[] = [];
  let meshOrdinal = 0;

  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const sourceGeo = mesh.geometry;
    if (!sourceGeo?.attributes?.['position'] || !mesh.material) return;

    const meshWorldMatrix = buildingWorldMatrix.clone().multiply(mesh.matrixWorld);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = Array.isArray(mesh.material) && sourceGeo.groups?.length > 0
      ? sourceGeo.groups
      : null;

    if (groups) {
      for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
        const group = groups[groupIdx];
        const material = materialAt(materials, group.materialIndex ?? 0);
        const diffuse = materialMap(material);
        if (!canDrawTextureToCanvas(diffuse)) continue;
        const geometry = copyGeometryGroup(sourceGeo, group);
        if (!geometry) continue;
        const triCount = geometryTriCount(geometry);
        if (triCount <= 0) {
          geometry.dispose();
          continue;
        }
        const nodeName = mesh.name || `mesh-${meshOrdinal}`;
        subMeshes.push({
          id: `${spec.id}/${nodeName}/mat-${group.materialIndex ?? groupIdx}`,
          buildingId: spec.id,
          subMeshName: nodeName,
          geometry,
          worldMatrix: meshWorldMatrix.clone(),
          triCount,
          diffuse,
          materialName: material?.name ?? '',
        });
      }
    } else {
      const material = materialAt(materials, 0);
      const diffuse = materialMap(material);
      if (!canDrawTextureToCanvas(diffuse)) return;
      const geometry = copyFullGeometry(sourceGeo);
      if (!geometry) return;
      const triCount = geometryTriCount(geometry);
      if (triCount <= 0) {
        geometry.dispose();
        return;
      }
      const nodeName = mesh.name || `mesh-${meshOrdinal}`;
      subMeshes.push({
        id: `${spec.id}/${nodeName}`,
        buildingId: spec.id,
        subMeshName: nodeName,
        geometry,
        worldMatrix: meshWorldMatrix.clone(),
        triCount,
        diffuse,
        materialName: material?.name ?? '',
      });
    }

    meshOrdinal++;
  });

  return subMeshes;
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
    const loadedSubMeshes: LoadedSubMesh[] = [];

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
          return new Promise<LoadedSubMesh[]>((resolve) => {
            loader.load(
              spec.model,
              (gltf) => {
                if (cancelled) return resolve([]);
                try {
                  const subMeshes = collectBuildingSubMeshes(spec, gltf.scene);
                  const triCount = subMeshes.reduce((sum, sub) => sum + sub.triCount, 0);
                  if (subMeshes.length === 0) {
                    updateStatus({ id: spec.id, status: 'error', tris: 0, error: 'No geometry' });
                    return resolve([]);
                  }
                  updateStatus({ id: spec.id, status: 'loaded', tris: triCount });
                  console.log('[meshlet-submeshes]', spec.id, `${subMeshes.length} sub-meshes`, `${triCount} tris`);
                  resolve(subMeshes);
                } catch (err) {
                  updateStatus({ id: spec.id, status: 'error', tris: 0, error: String(err) });
                  resolve([]);
                }
              },
              undefined,
              (err) => {
                updateStatus({ id: spec.id, status: 'error', tris: 0, error: String(err) });
                resolve([]);
              },
            );
          });
        });

        const results = await Promise.all(loadPromises);
        if (cancelled) return;
        const valid = results.flat().filter((sub) => canDrawTextureToCanvas(sub.diffuse));
        loadedSubMeshes.push(...valid);
        dumpMeshletSubMeshesOnce(valid);
        if (valid.length === 0) {
          setError('No buildings loaded');
          setState('error');
          return;
        }

        setAllLoaded(true);
        setTotalSourceTris(valid.reduce((s, g) => s + g.triCount, 0));
        setState('merging');

        const atlasResult = buildSubMeshAtlas(
          valid.map((sub) => ({
            id: sub.id,
            geometry: sub.geometry,
            diffuse: sub.diffuse,
          })),
        );
        console.log(
          '[useMergedBuildingsAsset] atlas built —',
          `${atlasResult.slotCount}/${atlasResult.capacity} slots`,
          `${atlasResult.uniqueTextureCount} textures`,
        );

        const atlasSubMeshIds = new Set(atlasResult.perSubMesh.map((sub) => sub.id));
        const atlasValid = valid.filter((sub) => atlasSubMeshIds.has(sub.id));
        if (atlasValid.length === 0) {
          setError('No buildings loaded');
          setState('error');
          return;
        }

        const merged = await mergeGeometriesToMeshletAsset(
          atlasValid.map((sub, idx) => ({
            geometry: sub.geometry,
            worldMatrix: sub.worldMatrix,
            sourceId: idx,
          })),
        );
        if (cancelled) return;
        (merged as any).atlasTexture = atlasResult.texture;

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
      for (const sub of loadedSubMeshes) {
        try { sub.geometry.dispose(); } catch {}
      }
    };
  }, []);

  return { asset, perBuildingStatus, state, allLoaded, error, totalSourceTris };
}
