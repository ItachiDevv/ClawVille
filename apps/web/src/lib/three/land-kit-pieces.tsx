'use client';

/**
 * land-kit-pieces.tsx — public in-world render layer for placed kit pieces.
 *
 * Deliberate approved divergence from design §2.3: that design's three
 * vertex-coloured material buckets assumed untextured primitives. The shipped
 * GLBs have authored textures, so this layer merges per (fixed chunk, pieceKey)
 * and shares that piece's cache-owned authored material. It does not build a
 * texture atlas and never emits one draw per placed piece.
 *
 * Twelve fixed ring×quadrant chunks stay resident. Their geometry rebuilds only
 * when that chunk's piece-content revision changes; walking updates only chunk
 * group visibility. Merged geometries are layer-owned and disposed, while
 * useGLTF cache materials/textures are shared and never disposed here.
 */

import {
  Component,
  Suspense,
  memo,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  KIT_CATALOG,
  KIT_PIECE_KEYS,
  LAND_PARCELS,
  type KitPieceKey,
  type ParcelSlot,
} from '@clawville/shared';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import { api } from '@/lib/api';
import { LAND_PIECES_REFRESH_EVENT } from '@/lib/land-query-keys';
import {
  KIT_CELL,
  KIT_FLOOR_Y,
  KIT_HEIGHT_CAP_FRACTION,
  KIT_LARGE_FOOTPRINT_FRACTION,
  KIT_STACK_UNIT_WU,
  LAND_KIT_ASSET_PATHS,
  fitKitPieceToCell,
  kitGridToWorld,
} from '@/lib/three/land-kit-assets';
import { extendLoaderWithMeshopt } from '@/lib/three/meshopt-loader-setup';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { useLandStore, type PlacedPiece } from '@/stores/land';

// ---------------------------------------------------------------------------
// Fixed 12-chunk partition (3 populated rings × 4 origin-sign quadrants)
// ---------------------------------------------------------------------------

const KIT_CHUNK_VIEW_DISTANCE = 5_000;
const KIT_CHUNK_VIEW_DISTANCE_SQ =
  KIT_CHUNK_VIEW_DISTANCE * KIT_CHUNK_VIEW_DISTANCE;
const MAX_VISIBLE_CHUNKS = 4;

const KIT_RINGS = ['founder', 'starter', 'c'] as const;
const KIT_QUADRANTS = [
  'x-neg-z-neg',
  'x-pos-z-neg',
  'x-pos-z-pos',
  'x-neg-z-pos',
] as const;
type KitRing = (typeof KIT_RINGS)[number];
type KitQuadrant = (typeof KIT_QUADRANTS)[number];

interface KitChunkDefinition {
  id: string;
  ring: KitRing;
  quadrant: KitQuadrant;
  parcels: readonly ParcelSlot[];
  sphere: THREE.Sphere;
}

function quadrantForParcel(parcel: ParcelSlot): KitQuadrant {
  if (parcel.cx >= 0) return parcel.cz >= 0 ? 'x-pos-z-pos' : 'x-pos-z-neg';
  return parcel.cz >= 0 ? 'x-neg-z-pos' : 'x-neg-z-neg';
}

function chunkBoundingSphere(parcels: readonly ParcelSlot[]): THREE.Sphere {
  if (parcels.length === 0) return new THREE.Sphere();

  const bounds = new THREE.Box3();
  for (const parcel of parcels) {
    // A square large piece at 45° can reach this far beyond its cell center;
    // pad the nominal parcel edge so coarse chunk culling cannot clip it.
    const pieceOverhang =
      (KIT_CELL(parcel.size) * KIT_LARGE_FOOTPRINT_FRACTION * Math.SQRT2) / 2;
    const half = parcel.size * 0.5 + pieceOverhang;
    const maxPieceY =
      KIT_FLOOR_Y +
      KIT_STACK_UNIT_WU * 2 +
      KIT_CELL(parcel.size) * KIT_HEIGHT_CAP_FRACTION;
    bounds.expandByPoint(
      new THREE.Vector3(parcel.cx - half, KIT_FLOOR_Y, parcel.cz - half),
    );
    bounds.expandByPoint(
      new THREE.Vector3(parcel.cx + half, maxPieceY, parcel.cz + half),
    );
  }
  return bounds.getBoundingSphere(new THREE.Sphere());
}

const KIT_CHUNKS: readonly KitChunkDefinition[] = KIT_RINGS.flatMap((ring) =>
  KIT_QUADRANTS.map((quadrant) => {
    const parcels = LAND_PARCELS.filter(
      (parcel) =>
        parcel.tier === ring && quadrantForParcel(parcel) === quadrant,
    );
    return {
      id: `${ring}:${quadrant}`,
      ring,
      quadrant,
      parcels,
      sphere: chunkBoundingSphere(parcels),
    };
  }),
);

const CHUNK_INDEX_BY_PARCEL_CODE = new Map<string, number>();
const PARCEL_BY_CODE = new Map<string, ParcelSlot>();
for (let chunkIndex = 0; chunkIndex < KIT_CHUNKS.length; chunkIndex++) {
  for (const parcel of KIT_CHUNKS[chunkIndex]!.parcels) {
    CHUNK_INDEX_BY_PARCEL_CODE.set(parcel.id, chunkIndex);
    PARCEL_BY_CODE.set(parcel.id, parcel);
  }
}

const KIT_PIECE_KEY_SET = new Set<string>(KIT_PIECE_KEYS);

// ---------------------------------------------------------------------------
// Store snapshot → deterministic per-chunk content revisions
// ---------------------------------------------------------------------------

interface RenderPiece extends PlacedPiece {
  pieceKey: KitPieceKey;
  parcel: ParcelSlot;
}

interface KitChunkSnapshot {
  revision: string;
  byPieceKey: ReadonlyMap<KitPieceKey, readonly RenderPiece[]>;
}

function compareRenderPieces(a: RenderPiece, b: RenderPiece): number {
  return (
    a.parcelCode.localeCompare(b.parcelCode) ||
    a.pieceKey.localeCompare(b.pieceKey) ||
    a.gridX - b.gridX ||
    a.gridY - b.gridY ||
    a.stackLevel - b.stackLevel ||
    a.rotationStep - b.rotationStep
  );
}

function buildChunkSnapshots(
  pieces: ReadonlyMap<string, readonly PlacedPiece[]>,
): readonly KitChunkSnapshot[] {
  const rowsByChunk = KIT_CHUNKS.map(() => [] as RenderPiece[]);
  for (const [parcelCode, parcelPieces] of pieces) {
    const chunkIndex = CHUNK_INDEX_BY_PARCEL_CODE.get(parcelCode);
    const parcel = PARCEL_BY_CODE.get(parcelCode);
    if (chunkIndex === undefined || !parcel) continue;
    for (const piece of parcelPieces) {
      if (!KIT_PIECE_KEY_SET.has(piece.pieceKey)) continue;
      rowsByChunk[chunkIndex]!.push({
        ...piece,
        pieceKey: piece.pieceKey as KitPieceKey,
        parcel,
      });
    }
  }

  return rowsByChunk.map((rows) => {
    rows.sort(compareRenderPieces);
    const byPieceKey = new Map<KitPieceKey, RenderPiece[]>();
    for (const row of rows) {
      const keyedRows = byPieceKey.get(row.pieceKey);
      if (keyedRows) keyedRows.push(row);
      else byPieceKey.set(row.pieceKey, [row]);
    }
    return {
      revision: rows
        .map((row) =>
          [
            row.parcelCode,
            row.pieceKey,
            row.gridX,
            row.gridY,
            row.rotationStep,
            row.stackLevel,
          ].join(':'),
        )
        .join('|'),
      byPieceKey,
    };
  });
}

// ---------------------------------------------------------------------------
// Baseline stats probe (FEATURE_GATE: land_kit_lv4_lv5_render_capacity)
// ---------------------------------------------------------------------------

export interface LandKitRendererStats {
  chunksResident: number;
  mergedMeshes: number;
  trianglesBaked: number;
}

type LandKitProbeWindow = Window & {
  __WORLD_STAGE_PROBE__?: unknown;
  __LAND_KIT_STATS__?: LandKitRendererStats;
};

const RESIDENT_MERGE_STATS = new Map<
  string,
  { chunkId: string; triangles: number }
>();

function publishLandKitStats(): void {
  if (typeof window === 'undefined') return;
  const probeWindow = window as LandKitProbeWindow;
  if (!probeWindow.__WORLD_STAGE_PROBE__) return;

  const chunks = new Set<string>();
  let trianglesBaked = 0;
  for (const stat of RESIDENT_MERGE_STATS.values()) {
    chunks.add(stat.chunkId);
    trianglesBaked += stat.triangles;
  }
  probeWindow.__LAND_KIT_STATS__ = {
    chunksResident: chunks.size,
    mergedMeshes: RESIDENT_MERGE_STATS.size,
    trianglesBaked,
  };
}

// ---------------------------------------------------------------------------
// GLB source resolution — one cache-owned material + one owned source geometry
// ---------------------------------------------------------------------------

export interface KitPieceSourceGeometry {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
}

export function resolvePieceSource(
  scene: THREE.Group,
  pieceKey: KitPieceKey,
): KitPieceSourceGeometry {
  const cloned = scene.clone(true);
  makeObject3DWebGPUSafe(cloned);
  cloned.updateMatrixWorld(true);

  const parts: THREE.BufferGeometry[] = [];
  let material: THREE.Material | null = null;
  let sourceGeometry: THREE.BufferGeometry | null = null;
  try {
    cloned.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (
        (mesh as THREE.SkinnedMesh).isSkinnedMesh ||
        (mesh as THREE.InstancedMesh).isInstancedMesh
      ) {
        throw new Error(
          `Unsupported animated/instanced land-kit mesh: ${pieceKey}`,
        );
      }
      const meshMaterials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      if (meshMaterials.length !== 1 || !meshMaterials[0]) {
        throw new Error(
          `Land-kit GLB must have one authored material: ${pieceKey}`,
        );
      }
      if (material && material !== meshMaterials[0]) {
        throw new Error(`Land-kit GLB material drift: ${pieceKey}`);
      }
      material = meshMaterials[0];
      const geometry = mesh.geometry.clone();
      geometry.applyMatrix4(mesh.matrixWorld);
      parts.push(geometry);
    });

    if (!material || parts.length === 0) {
      throw new Error(`Land-kit GLB has no renderable mesh: ${pieceKey}`);
    }
    if (parts.length === 1) {
      sourceGeometry = parts.pop()!;
    } else {
      sourceGeometry = mergeGeometries(parts, false);
      if (!sourceGeometry)
        throw new Error(`Land-kit source merge failed: ${pieceKey}`);
    }
    sourceGeometry.computeBoundingBox();
    sourceGeometry.computeBoundingSphere();
    const box = sourceGeometry.boundingBox;
    if (!box) throw new Error(`Land-kit GLB has no bounds: ${pieceKey}`);

    return {
      geometry: sourceGeometry,
      material,
      bounds: {
        minX: box.min.x,
        maxX: box.max.x,
        minY: box.min.y,
        maxY: box.max.y,
        minZ: box.min.z,
        maxZ: box.max.z,
      },
    };
  } catch (error) {
    sourceGeometry?.dispose();
    throw error;
  } finally {
    for (const part of parts) part.dispose();
  }
}

// ---------------------------------------------------------------------------
// One merged mesh per (chunk, pieceKey)
// ---------------------------------------------------------------------------

interface ChunkPieceBatchProps {
  chunk: KitChunkDefinition;
  chunkGroup: THREE.Group;
  pieceKey: KitPieceKey;
  snapshot: KitChunkSnapshot;
  source: KitPieceSourceGeometry;
}

function ChunkPieceBatch({
  chunk,
  chunkGroup,
  pieceKey,
  snapshot,
  source,
}: ChunkPieceBatchProps) {
  const mesh = useMemo(() => {
    const rows = snapshot.byPieceKey.get(pieceKey) ?? [];
    const transformed: THREE.BufferGeometry[] = [];
    let merged: THREE.BufferGeometry | null = null;
    try {
      const placementMatrix = new THREE.Matrix4();
      const localOffsetMatrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);

      for (const row of rows) {
        const world = kitGridToWorld(row.parcel, row);
        const fit = fitKitPieceToCell(pieceKey, row.parcel.size, source.bounds);
        position.set(world.worldX, world.worldY, world.worldZ);
        scale.setScalar(fit.scale);
        rotation.setFromAxisAngle(up, world.yaw);
        placementMatrix.compose(position, rotation, scale);
        localOffsetMatrix.makeTranslation(
          fit.offsetX,
          fit.offsetY,
          fit.offsetZ,
        );
        placementMatrix.multiply(localOffsetMatrix);

        const geometry = source.geometry.clone();
        geometry.applyMatrix4(placementMatrix);
        transformed.push(geometry);
      }

      merged = mergeGeometries(transformed, false);
      if (!merged)
        throw new Error(`Land-kit chunk merge failed: ${chunk.id}/${pieceKey}`);
      const mergedMesh = new THREE.Mesh(merged, source.material);
      mergedMesh.name = `land-kit:${chunk.id}:${pieceKey}`;
      mergedMesh.matrixAutoUpdate = false;
      mergedMesh.updateMatrix();
      mergedMesh.frustumCulled = true;
      makeObject3DWebGPUSafe(mergedMesh);
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      return mergedMesh;
    } catch (error) {
      merged?.dispose();
      throw error;
    } finally {
      for (const geometry of transformed) geometry.dispose();
    }
  }, [chunk.id, pieceKey, snapshot, source]);

  useEffect(() => {
    const statKey = `${chunk.id}:${pieceKey}`;
    const positionCount = mesh.geometry.getAttribute('position')?.count ?? 0;
    const triangles = Math.floor(
      (mesh.geometry.getIndex()?.count ?? positionCount) / 3,
    );
    chunkGroup.add(mesh);
    RESIDENT_MERGE_STATS.set(statKey, { chunkId: chunk.id, triangles });
    publishLandKitStats();

    return () => {
      chunkGroup.remove(mesh);
      RESIDENT_MERGE_STATS.delete(statKey);
      mesh.geometry.dispose();
      publishLandKitStats();
    };
  }, [chunk.id, chunkGroup, mesh, pieceKey]);

  return null;
}

const MemoChunkPieceBatch = memo(
  ChunkPieceBatch,
  (previous, next) =>
    previous.chunk === next.chunk &&
    previous.chunkGroup === next.chunkGroup &&
    previous.pieceKey === next.pieceKey &&
    previous.source === next.source &&
    previous.snapshot.revision === next.snapshot.revision,
);

function KitPieceSource({
  chunkGroups,
  pieceKey,
  snapshots,
}: {
  chunkGroups: readonly THREE.Group[];
  pieceKey: KitPieceKey;
  snapshots: readonly KitChunkSnapshot[];
}) {
  const { scene } = useGLTF(
    LAND_KIT_ASSET_PATHS[pieceKey],
    undefined,
    undefined,
    extendLoaderWithMeshopt,
  );
  const source = useMemo(
    () => resolvePieceSource(scene, pieceKey),
    [pieceKey, scene],
  );

  useEffect(
    () => () => {
      source.geometry.dispose();
    },
    [source],
  );

  return (
    <>
      {snapshots.map((snapshot, chunkIndex) =>
        snapshot.byPieceKey.has(pieceKey) ? (
          <MemoChunkPieceBatch
            key={KIT_CHUNKS[chunkIndex]!.id}
            chunk={KIT_CHUNKS[chunkIndex]!}
            chunkGroup={chunkGroups[chunkIndex]!}
            pieceKey={pieceKey}
            snapshot={snapshot}
            source={source}
          />
        ) : null,
      )}
    </>
  );
}

/**
 * Exported for the yard editor's GhostPiece: a resolvePieceSource() throw or a
 * rejected GLB fetch must never escape past this — the main world scene has no
 * StageSlotErrorBoundary of its own, so an uncaught render throw here would
 * reach StageCanvasErrorBoundary and kill the whole 3D view.
 */
export class KitPieceSourceErrorBoundary extends Component<
  { children: ReactNode },
  { errored: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { errored: false };
  }

  static getDerivedStateFromError(): { errored: boolean } {
    return { errored: true };
  }

  render() {
    return this.state.errored ? null : this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Public feed hydration (60s poll + explicit editor refresh event)
// ---------------------------------------------------------------------------

function publicPiecesMatchStore(
  freshPieces: readonly PlacedPiece[],
  storedPieces: ReadonlyMap<string, readonly PlacedPiece[]>,
): boolean {
  let storedCount = 0;
  for (const parcelPieces of storedPieces.values()) storedCount += parcelPieces.length;
  if (storedCount !== freshPieces.length) return false;

  for (const fresh of freshPieces) {
    const match = storedPieces.get(fresh.parcelCode)?.some(
      (stored) =>
        stored.pieceKey === fresh.pieceKey
        && stored.gridX === fresh.gridX
        && stored.gridY === fresh.gridY
        && stored.rotationStep === fresh.rotationStep
        && stored.stackLevel === fresh.stackLevel,
    );
    if (!match) return false;
  }
  return true;
}

function KitPieceHydrator() {
  const setPieces = useLandStore((state) => state.setPieces);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let requestVersion = 0;

    const hydrate = async (fresh = false): Promise<void> => {
      const version = ++requestVersion;
      const publicPieces = await api.getPublicLandPieces(fresh).catch(() => null);
      if (cancelled || version !== requestVersion) return;
      if (
        publicPieces !== null
        && (fresh || !publicPiecesMatchStore(publicPieces, useLandStore.getState().pieces))
      ) {
        setPieces(publicPieces);
      }

      if (!cancelled) {
        if (pollTimer !== null) clearTimeout(pollTimer);
        pollTimer = setTimeout(() => {
          void hydrate();
        }, 60_000);
      }
    };

    const refreshNow = () => {
      if (pollTimer !== null) clearTimeout(pollTimer);
      void hydrate(true);
    };

    void hydrate();
    window.addEventListener(LAND_PIECES_REFRESH_EVENT, refreshNow);
    return () => {
      cancelled = true;
      window.removeEventListener(LAND_PIECES_REFRESH_EVENT, refreshNow);
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [setPieces]);

  return null;
}

// ---------------------------------------------------------------------------
// Per-frame chunk visibility — fixed 12-loop, zero allocations
// ---------------------------------------------------------------------------

const _kitCameraPosition = new THREE.Vector3();
const _kitViewProjection = new THREE.Matrix4();
const _kitFrustum = new THREE.Frustum();
const _kitChunkDistances = new Float64Array(KIT_CHUNKS.length);
const _kitChunkSelected = new Uint8Array(KIT_CHUNKS.length);

function createChunkGroups(): readonly THREE.Group[] {
  return KIT_CHUNKS.map((chunk) => {
    const group = new THREE.Group();
    group.name = `land-kit-chunk:${chunk.id}`;
    group.visible = false;
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    return group;
  });
}

export default function LandKitPieces() {
  const pieces = useLandStore((state) => state.pieces);
  const snapshots = useMemo(() => buildChunkSnapshots(pieces), [pieces]);
  const chunkGroups = useMemo(createChunkGroups, []);
  const activePieceKeys = useMemo(() => {
    const active = new Set<KitPieceKey>();
    for (const snapshot of snapshots) {
      for (const pieceKey of snapshot.byPieceKey.keys()) active.add(pieceKey);
    }
    return KIT_PIECE_KEYS.filter((pieceKey) => active.has(pieceKey));
  }, [snapshots]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_ENABLE_STAGE_PROBE !== '1') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const waitForStageProbe = () => {
      if ((window as LandKitProbeWindow).__WORLD_STAGE_PROBE__) {
        publishLandKitStats();
        return;
      }
      timer = setTimeout(waitForStageProbe, 250);
    };
    waitForStageProbe();
    return () => {
      if (timer !== null) clearTimeout(timer);
      delete (window as LandKitProbeWindow).__LAND_KIT_STATS__;
    };
  }, []);

  useSceneFrame(({ camera }) => {
    camera.getWorldPosition(_kitCameraPosition);
    _kitViewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    _kitFrustum.setFromProjectionMatrix(
      _kitViewProjection,
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    _kitChunkSelected.fill(0);

    for (let index = 0; index < KIT_CHUNKS.length; index++) {
      const group = chunkGroups[index]!;
      group.visible = false;
      if (group.children.length === 0) {
        _kitChunkDistances[index] = Number.POSITIVE_INFINITY;
        continue;
      }
      const sphere = KIT_CHUNKS[index]!.sphere;
      const center = sphere.center;
      const dx = _kitCameraPosition.x - center.x;
      const dy = _kitCameraPosition.y - center.y;
      const dz = _kitCameraPosition.z - center.z;
      const distance = dx * dx + dy * dy + dz * dz;
      _kitChunkDistances[index] =
        distance < KIT_CHUNK_VIEW_DISTANCE_SQ
        && _kitFrustum.intersectsSphere(sphere)
          ? distance
          : Number.POSITIVE_INFINITY;
    }

    for (
      let residentRank = 0;
      residentRank < MAX_VISIBLE_CHUNKS;
      residentRank++
    ) {
      let nearestIndex = -1;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < KIT_CHUNKS.length; index++) {
        if (_kitChunkSelected[index] !== 0) continue;
        const distance = _kitChunkDistances[index]!;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      }
      if (nearestIndex < 0 || !Number.isFinite(nearestDistance)) break;
      _kitChunkSelected[nearestIndex] = 1;
      chunkGroups[nearestIndex]!.visible = true;
    }
  });

  return (
    <>
      <KitPieceHydrator />
      {chunkGroups.map((group, index) => (
        <primitive key={KIT_CHUNKS[index]!.id} object={group} />
      ))}
      {activePieceKeys.map((pieceKey) => (
        <KitPieceSourceErrorBoundary key={pieceKey}>
          <Suspense fallback={null}>
            <KitPieceSource
              chunkGroups={chunkGroups}
              pieceKey={pieceKey}
              snapshots={snapshots}
            />
          </Suspense>
        </KitPieceSourceErrorBoundary>
      ))}
    </>
  );
}
