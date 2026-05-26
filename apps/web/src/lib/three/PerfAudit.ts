'use client';

import * as THREE from 'three';
import { getWorldLabelPerfStats } from '@/lib/three/world-labels-overlay';

export interface WorldPerfFlags {
  labels: boolean;
  npcs: boolean;
  shadows: boolean;
  postprocessing: boolean;
  waterFogParticles: boolean;
  staticWorldOnly: boolean;
  uiOverlay: boolean;
}

export const DEFAULT_WORLD_PERF_FLAGS: WorldPerfFlags = {
  labels: true,
  npcs: true,
  shadows: true,
  postprocessing: true,
  waterFogParticles: true,
  staticWorldOnly: false,
  uiOverlay: true,
};

export interface PerfObjectCost {
  uuid: string;
  name: string;
  path: string;
  chunk: string;
  draws: number;
  meshCount: number;
  visibleObjectCount: number;
  materialCount: number;
  textureCount: number;
  triangleCount: number;
  skinnedMeshCount: number;
}

export interface PerfChunkCost {
  name: string;
  draws: number;
  meshCount: number;
  visibleObjectCount: number;
  materialCount: number;
  textureCount: number;
  triangleCount: number;
  skinnedMeshCount: number;
}

export interface PerfSceneAudit {
  generatedAt: number;
  renderer: {
    backend: string;
    draws: number;
    triangles: number;
    frame: number;
    programsOrPipelines: number;
  };
  totals: PerfChunkCost & {
    labelCount: number;
    labelReactRendersPerSec: number;
  };
  chunks: PerfChunkCost[];
  topObjects: PerfObjectCost[];
}

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'lightMap',
  'envMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'transmissionMap',
  'thicknessMap',
  'specularMap',
  'specularColorMap',
] as const;

function addMaterial(materials: Set<THREE.Material>, material: THREE.Material | THREE.Material[] | undefined): void {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const mat of material) {
      if (mat) materials.add(mat);
    }
    return;
  }
  materials.add(material);
}

function collectTextures(material: THREE.Material | THREE.Material[] | undefined, textures: Set<THREE.Texture>): void {
  if (!material) return;
  const mats = Array.isArray(material) ? material : [material];
  for (const mat of mats) {
    if (!mat) continue;
    for (const slot of TEXTURE_SLOTS) {
      const tex = (mat as any)[slot];
      if (tex instanceof THREE.Texture) textures.add(tex);
    }
  }
}

function triangleCount(geometry: THREE.BufferGeometry | undefined): number {
  if (!geometry) return 0;
  const indexCount = geometry.index?.count;
  if (typeof indexCount === 'number') return Math.floor(indexCount / 3);
  const posCount = geometry.getAttribute('position')?.count;
  return typeof posCount === 'number' ? Math.floor(posCount / 3) : 0;
}

function estimatedDraws(mesh: THREE.Mesh): number {
  const material = mesh.material;
  const groups = mesh.geometry?.groups ?? [];
  if (groups.length > 0) return groups.length;
  if (Array.isArray(material)) return Math.max(1, material.filter(Boolean).length);
  return material ? 1 : 0;
}

function objectPath(obj: THREE.Object3D): string {
  const names: string[] = [];
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (cur.name) names.push(cur.name);
    cur = cur.parent;
  }
  return names.reverse().join(' / ') || obj.uuid;
}

function chunkNameFor(obj: THREE.Object3D): string {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    const chunk = cur.userData?.perfChunk;
    if (typeof chunk === 'string' && chunk.length > 0) return chunk;
    cur = cur.parent;
  }

  const top = obj.parent?.children.find((child) => child === obj);
  return top?.name || obj.name || 'unclassified';
}

function emptyChunk(name: string): PerfChunkCost {
  return {
    name,
    draws: 0,
    meshCount: 0,
    visibleObjectCount: 0,
    materialCount: 0,
    textureCount: 0,
    triangleCount: 0,
    skinnedMeshCount: 0,
  };
}

function addIntoChunk(chunk: PerfChunkCost, cost: PerfObjectCost): void {
  chunk.draws += cost.draws;
  chunk.meshCount += cost.meshCount;
  chunk.visibleObjectCount += cost.visibleObjectCount;
  chunk.triangleCount += cost.triangleCount;
  chunk.skinnedMeshCount += cost.skinnedMeshCount;
  // material/texture are assigned after set-based chunk aggregation.
}

export function auditThreeScene(scene: THREE.Scene, renderer: any): PerfSceneAudit {
  const byChunk = new Map<string, PerfChunkCost>();
  const chunkMaterials = new Map<string, Set<THREE.Material>>();
  const chunkTextures = new Map<string, Set<THREE.Texture>>();
  const totalMaterials = new Set<THREE.Material>();
  const totalTextures = new Set<THREE.Texture>();
  const topObjects: PerfObjectCost[] = [];

  let totalDraws = 0;
  let totalMeshes = 0;
  let totalVisibleObjects = 0;
  let totalTriangles = 0;
  let totalSkinned = 0;

  scene.updateMatrixWorld(false);

  scene.traverse((obj) => {
    if (!obj.visible) return;

    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    totalVisibleObjects++;

    const chunkName = chunkNameFor(mesh);
    let chunk = byChunk.get(chunkName);
    if (!chunk) {
      chunk = emptyChunk(chunkName);
      byChunk.set(chunkName, chunk);
      chunkMaterials.set(chunkName, new Set());
      chunkTextures.set(chunkName, new Set());
    }

    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    addMaterial(materials, mesh.material);
    collectTextures(mesh.material, textures);
    for (const mat of materials) {
      totalMaterials.add(mat);
      chunkMaterials.get(chunkName)?.add(mat);
    }
    for (const tex of textures) {
      totalTextures.add(tex);
      chunkTextures.get(chunkName)?.add(tex);
    }

    const draws = estimatedDraws(mesh);
    const tris = triangleCount(mesh.geometry);
    const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? 1 : 0;
    const cost: PerfObjectCost = {
      uuid: mesh.uuid,
      name: mesh.name || mesh.parent?.name || mesh.uuid,
      path: `${objectPath(mesh)} [${mesh.uuid.slice(0, 8)}]`,
      chunk: chunkName,
      draws,
      meshCount: 1,
      visibleObjectCount: 1,
      materialCount: materials.size,
      textureCount: textures.size,
      triangleCount: tris,
      skinnedMeshCount: skinned,
    };

    addIntoChunk(chunk, cost);
    totalDraws += draws;
    totalMeshes++;
    totalTriangles += tris;
    totalSkinned += skinned;
    topObjects.push(cost);
  });

  for (const [name, chunk] of byChunk) {
    chunk.materialCount = chunkMaterials.get(name)?.size ?? 0;
    chunk.textureCount = chunkTextures.get(name)?.size ?? 0;
  }

  topObjects.sort((a, b) => {
    const aScore = a.triangleCount + a.materialCount * 25_000 + a.draws * 50_000;
    const bScore = b.triangleCount + b.materialCount * 25_000 + b.draws * 50_000;
    return bScore - aScore;
  });

  const renderInfo = renderer?.info?.render;
  const labels = getWorldLabelPerfStats();

  return {
    generatedAt: performance.now(),
    renderer: {
      backend: renderer?.isWebGPURenderer ? 'WebGPU' : 'WebGL',
      draws: (renderInfo as any)?.drawCalls ?? renderInfo?.calls ?? 0,
      triangles: renderInfo?.triangles ?? 0,
      frame: renderer?.info?.render?.frame ?? renderer?.info?.frame ?? 0,
      programsOrPipelines:
        renderer?._pipelines?.caches?.size ??
        renderer?.info?.programs?.length ??
        0,
    },
    totals: {
      name: 'scene',
      draws: totalDraws,
      meshCount: totalMeshes,
      visibleObjectCount: totalVisibleObjects,
      materialCount: totalMaterials.size,
      textureCount: totalTextures.size,
      triangleCount: totalTriangles,
      skinnedMeshCount: totalSkinned,
      labelCount: labels.labelCount,
      labelReactRendersPerSec: labels.reactRendersPerSec,
    },
    chunks: Array.from(byChunk.values()).sort((a, b) => b.draws - a.draws),
    topObjects: topObjects.slice(0, 20),
  };
}

export function getCurrentPerfAudit(): PerfSceneAudit | null {
  if (typeof window === 'undefined') return null;
  const state = (window as any).__W3D;
  if (!state?.scene || !state?.gl) return null;
  return auditThreeScene(state.scene, state.gl);
}
