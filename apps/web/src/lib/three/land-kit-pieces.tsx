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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOOT_STREAM_TIER_LAND } from '@/lib/three/decorative-release';
import { useBootStreamRelease } from '@/lib/three/use-boot-stream-release';
import {
  beginLandHydration,
  bumpLandRevision,
  declareLandSlots,
  reportLandSlotFallback,
  reportLandSlotResolved,
} from '@/lib/three/land-boot-tracker';
import {
  KIT_MAX_PIECE_FOOTPRINT_WU,
  KIT_MAX_STACK_HEIGHT_WU,
  KIT_PIECE_KEYS,
  KIT_PIECE_RENDER,
  LAND_PARCELS,
  resolveParcelPlacements,
  type KitPieceKey,
  type ParcelSlot,
  type StoredPlacement,
} from '@clawville/shared';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import { api } from '@/lib/api';
import { LAND_PIECES_REFRESH_EVENT } from '@/lib/land-query-keys';
import {
  KIT_FLOOR_Y,
  LAND_KIT_ASSET_PATHS,
  fitKitPieceToManifest,
  kitGridToWorld,
} from '@/lib/three/land-kit-assets';
import {
  EMPTY_DROP_SET,
  admitsChunk,
  computeChunkDrop,
  getSourcePricingRevision,
  priceKitSource,
  sameMembers,
  subscribeSourcePricing,
  triangleCostOf,
  type ParcelCost,
} from '@/lib/three/land-kit-admission';
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

// The §4.4 budgets and the whole drop decision live in `land-kit-admission.ts`,
// which imports neither React nor three so the feedback loop can be unit-tested.
export {
  KIT_SUBMITTED_TRIANGLE_BUDGET,
  KIT_VISIBLE_DRAW_BUDGET,
} from '@/lib/three/land-kit-admission';

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

/**
 * Widest a piece can reach past its anchor cell centre, in any advertised
 * rotation. Manifest-derived, and no longer parcel-size dependent — pieces are
 * now sized in absolute world units, not as a fraction of a grid cell.
 */
const KIT_PIECE_OVERHANG_WU = KIT_MAX_PIECE_FOOTPRINT_WU / 2;

/**
 * §4.4 budget (e): the tallest legal stack, 372 wu above the floor.
 *
 * The retired bound was `KIT_STACK_UNIT_WU × 2 + KIT_CELL × 2.2`, a
 * cell-relative model that both under-counted real piece heights and changed
 * with parcel size. `KIT_MAX_STACK_HEIGHT_WU` is computed from the manifest
 * (deck-plank 40 → deck-plank 40 → statue-anchor 292), so re-authoring a
 * support surface or a target height moves this frustum box with it.
 */
const KIT_CHUNK_CEILING_Y = KIT_FLOOR_Y + KIT_MAX_STACK_HEIGHT_WU;

function chunkBoundingSphere(parcels: readonly ParcelSlot[]): THREE.Sphere {
  if (parcels.length === 0) return new THREE.Sphere();

  const bounds = new THREE.Box3();
  for (const parcel of parcels) {
    // Pad the nominal parcel edge so coarse chunk culling cannot clip a piece
    // that legally overhangs its anchor cell.
    const half = parcel.size * 0.5 + KIT_PIECE_OVERHANG_WU;
    bounds.expandByPoint(
      new THREE.Vector3(parcel.cx - half, KIT_FLOOR_Y, parcel.cz - half),
    );
    bounds.expandByPoint(
      new THREE.Vector3(parcel.cx + half, KIT_CHUNK_CEILING_Y, parcel.cz + half),
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
  /** Parcel-local Y the piece's base rests at, resolved from its supporter. */
  baseYWu: number;
}

interface KitChunkSnapshot {
  revision: string;
  byPieceKey: ReadonlyMap<KitPieceKey, readonly RenderPiece[]>;
  /** Rendered rows per parcel, for the G-D nearest-yard-intact assertion. */
  countByParcel: ReadonlyMap<string, number>;
  /** Exact submitted triangles for this chunk once every source has loaded. */
  triangles: number;
  /** Which source-pricing generation `triangles` was costed against. */
  pricingRevision: number;
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

/**
 * The exact per-key triangle pricing that `triangles` below is built from lives
 * in `land-kit-admission.ts` — it is admission data, and keeping it beside the
 * decision it feeds is what makes the async-pricing path testable. A price
 * arriving late bumps `pricingRevision`, which this module subscribes to.
 *
 * A price change does NOT cause a re-merge: `revision` (the merge memo's key)
 * is derived from placement rows only, so a recompute updates `triangles` while
 * every `(chunk, pieceKey)` mesh is left alone.
 */

/**
 * `pricingRevision` is carried onto every snapshot rather than merely gating the
 * memo, so a snapshot states which pricing generation it was costed against and
 * a test can assert the recompute actually happened.
 */
export function buildChunkSnapshots(
  pieces: ReadonlyMap<string, readonly PlacedPiece[]>,
  droppedParcels: ReadonlySet<string>,
  pricingRevision: number,
): readonly KitChunkSnapshot[] {
  const rowsByChunk = KIT_CHUNKS.map(() => [] as RenderPiece[]);

  for (const [parcelCode, parcelPieces] of pieces) {
    const chunkIndex = CHUNK_INDEX_BY_PARCEL_CODE.get(parcelCode);
    const parcel = PARCEL_BY_CODE.get(parcelCode);
    if (chunkIndex === undefined || !parcel) continue;
    if (droppedParcels.has(parcelCode)) continue;

    // Q5 grandfathering lives here: `resolveParcelPlacements` NEVER drops a row.
    // A placement the current predicate would refuse still resolves, and a
    // stacked row whose supporter is gone renders visibly floating rather than
    // disappearing. The render layer is not a legality filter.
    const stored: StoredPlacement[] = [];
    for (const piece of parcelPieces) {
      if (!KIT_PIECE_KEY_SET.has(piece.pieceKey)) continue;
      stored.push({
        pieceRef: piece.id ?? `${parcelCode}:${piece.gridX}:${piece.gridY}:${piece.stackLevel}`,
        pieceKey: piece.pieceKey as KitPieceKey,
        gridX: piece.gridX,
        gridY: piece.gridY,
        rotationStep: piece.rotationStep,
        stackLevel: piece.stackLevel,
      });
    }

    const resolved = resolveParcelPlacements(stored, parcel.tier);
    const byRef = new Map(resolved.map((entry) => [entry.row.pieceRef, entry]));
    for (const row of stored) {
      const entry = byRef.get(row.pieceRef);
      if (!entry) continue;
      rowsByChunk[chunkIndex]!.push({
        ...row,
        parcelCode,
        pieceKey: row.pieceKey,
        parcel,
        baseYWu: entry.footprint.minY,
      });
    }
  }

  return rowsByChunk.map((rows) => {
    rows.sort(compareRenderPieces);
    const byPieceKey = new Map<KitPieceKey, RenderPiece[]>();
    const countByParcel = new Map<string, number>();
    let triangles = 0;
    for (const row of rows) {
      const keyedRows = byPieceKey.get(row.pieceKey);
      if (keyedRows) keyedRows.push(row);
      else byPieceKey.set(row.pieceKey, [row]);
      countByParcel.set(row.parcelCode, (countByParcel.get(row.parcelCode) ?? 0) + 1);
      triangles += triangleCostOf(row.pieceKey);
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
            row.baseYWu,
          ].join(':'),
        )
        .join('|'),
      byPieceKey,
      countByParcel,
      triangles,
      pricingRevision,
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
  /** Chunks currently admitted for draw (§4.4 nearest-first admission). */
  chunksVisible: number;
  /** Distinct (visible chunk, pieceKey) pairs — the §4.4 (d) draw budget. */
  visibleDraws: number;
  /** Triangles actually submitted by admitted chunks — the §4.4 (c) budget. */
  visibleTriangles: number;
  /** Tallest legal stack the frustum boxes account for — §4.4 (e), ≤ 372. */
  verticalBoundWu: number;
  /** Parcels the farthest-first drop removed. Empty with the shipping catalog. */
  droppedParcels: string[];
  /**
   * G-D retention assertion 1 — nearest yard intact:
   * `renderedPieceCount(nearestParcel) === persistedPieceCount(nearestParcel)`.
   * Null before any parcel is in range.
   */
  nearestYardIntact: boolean | null;
  /**
   * G-D retention assertion 2 — non-empty: whenever any parcel within view
   * distance has pieces, `visibleChunks ≥ 1 && renderedPieceCount > 0`.
   */
  nonEmpty: boolean;
  nearestParcelCode: string | null;
  nearestParcelRendered: number;
  nearestParcelPersisted: number;
}

type LandKitProbeWindow = Window & {
  __WORLD_STAGE_PROBE__?: unknown;
  __LAND_KIT_STATS__?: LandKitRendererStats;
};

const RESIDENT_MERGE_STATS = new Map<
  string,
  { chunkId: string; triangles: number }
>();

/** Live admission state, written by the frame loop and read by the probe. */
const ADMISSION_STATE: {
  chunksVisible: number;
  visibleDraws: number;
  visibleTriangles: number;
  droppedParcels: string[];
  nearestParcelCode: string | null;
  nearestParcelRendered: number;
  nearestParcelPersisted: number;
  anyParcelInRangeHasPieces: boolean;
  renderedPieceCount: number;
} = {
  chunksVisible: 0,
  visibleDraws: 0,
  visibleTriangles: 0,
  droppedParcels: [],
  nearestParcelCode: null,
  nearestParcelRendered: 0,
  nearestParcelPersisted: 0,
  anyParcelInRangeHasPieces: false,
  renderedPieceCount: 0,
};

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
    chunksVisible: ADMISSION_STATE.chunksVisible,
    visibleDraws: ADMISSION_STATE.visibleDraws,
    visibleTriangles: ADMISSION_STATE.visibleTriangles,
    verticalBoundWu: KIT_MAX_STACK_HEIGHT_WU,
    droppedParcels: [...ADMISSION_STATE.droppedParcels],
    nearestYardIntact:
      ADMISSION_STATE.nearestParcelCode === null
        ? null
        : ADMISSION_STATE.nearestParcelRendered === ADMISSION_STATE.nearestParcelPersisted,
    nonEmpty:
      !ADMISSION_STATE.anyParcelInRangeHasPieces
      || (ADMISSION_STATE.chunksVisible >= 1 && ADMISSION_STATE.renderedPieceCount > 0),
    nearestParcelCode: ADMISSION_STATE.nearestParcelCode,
    nearestParcelRendered: ADMISSION_STATE.nearestParcelRendered,
    nearestParcelPersisted: ADMISSION_STATE.nearestParcelPersisted,
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

      const fit = fitKitPieceToManifest(pieceKey, source.bounds);
      for (const row of rows) {
        // Absolute manifest height + supporter-derived base Y. Neither depends
        // on parcel size any more, so the same piece is the same size on every
        // tier and a stacked piece sits ON its supporter rather than 34 wu up.
        const world = kitGridToWorld(row.parcel, row, row.baseYWu);
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
  // Slice D §4b: source RESOLVED from a commit effect (render-abandon-safe).
  useEffect(() => {
    reportLandSlotResolved('kit', pieceKey);
  }, [pieceKey]);
  const source = useMemo(
    () => resolvePieceSource(scene, pieceKey),
    [pieceKey, scene],
  );

  // Price this piece for chunk admission the moment its geometry exists. This
  // runs in an effect, not the render body: `priceKitSource` notifies
  // subscribers, and notifying during render would be a state update inside
  // another component's render pass.
  useEffect(() => {
    const positionCount = source.geometry.getAttribute('position')?.count ?? 0;
    priceKitSource(
      pieceKey,
      Math.floor((source.geometry.getIndex()?.count ?? positionCount) / 3),
    );
  }, [pieceKey, source]);

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
  { children: ReactNode; onErrored?: () => void },
  { errored: boolean }
> {
  constructor(props: { children: ReactNode; onErrored?: () => void }) {
    super(props);
    this.state = { errored: false };
  }

  static getDerivedStateFromError(): { errored: boolean } {
    return { errored: true };
  }

  componentDidCatch(): void {
    // Slice D §4b [R3-F4]: fallback outcomes are measurement-counted.
    this.props.onErrored?.();
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
      // Slice D §4b [R3-F3]: hydration generation (terminal BEFORE the
      // superseded/cancelled early-returns).
      const done = beginLandHydration();
      const publicPieces = await api.getPublicLandPieces(fresh).catch(() => null);
      done(publicPieces !== null);
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

/**
 * The UNFILTERED cost of every parcel in one chunk, as `computeChunkDrop` needs
 * it. Built from the raw placed-piece map and the pricing store, never from the
 * already-filtered render snapshot: deciding from the filtered view is what let
 * a successful drop erase its own justification and oscillate every render.
 */
function chunkParcelCosts(
  chunkIndex: number,
  pieces: ReadonlyMap<string, readonly PlacedPiece[]>,
): ParcelCost[] {
  const costs: ParcelCost[] = [];
  for (const parcel of KIT_CHUNKS[chunkIndex]!.parcels) {
    const parcelPieces = pieces.get(parcel.id);
    if (!parcelPieces || parcelPieces.length === 0) continue;
    let triangles = 0;
    const pieceKeys = new Set<string>();
    for (const piece of parcelPieces) {
      if (!KIT_PIECE_KEY_SET.has(piece.pieceKey)) continue;
      triangles += triangleCostOf(piece.pieceKey);
      pieceKeys.add(piece.pieceKey);
    }
    if (pieceKeys.size === 0) continue;
    const dx = _kitCameraPosition.x - parcel.cx;
    const dz = _kitCameraPosition.z - parcel.cz;
    costs.push({
      parcelCode: parcel.id,
      triangles,
      pieceKeys: [...pieceKeys],
      distanceSq: dx * dx + dz * dz,
    });
  }
  return costs;
}

/**
 * Publish only when something the probe reports actually moved. The frame loop
 * runs at display rate; allocating a fresh stats object every frame would be a
 * GC source in the exact hot path the Iris Xe rules exist to protect.
 */
let _lastProbeSignature = '';
function publishLandKitStatsIfChanged(): void {
  if (typeof window === 'undefined') return;
  if (!(window as LandKitProbeWindow).__WORLD_STAGE_PROBE__) return;
  const signature = [
    ADMISSION_STATE.chunksVisible,
    ADMISSION_STATE.visibleDraws,
    ADMISSION_STATE.visibleTriangles,
    ADMISSION_STATE.nearestParcelCode ?? '',
    ADMISSION_STATE.nearestParcelRendered,
    ADMISSION_STATE.nearestParcelPersisted,
    ADMISSION_STATE.renderedPieceCount,
    ADMISSION_STATE.droppedParcels.length,
  ].join('|');
  if (signature === _lastProbeSignature) return;
  _lastProbeSignature = signature;
  publishLandKitStats();
}

export default function LandKitPieces() {
  const pieces = useLandStore((state) => state.pieces);
  /**
   * Parcels the §4.4 farthest-first drop has removed. React state rather than a
   * frame-local decision because dropping a parcel changes the MERGED geometry,
   * and re-merging every frame would defeat the budget it is protecting. It is
   * recomputed only when the drop SET actually changes, which with the shipping
   * catalog is never: the authored budget is 223,600 triangles against a
   * 250,000 ceiling, and a chunk's key count is capped at 30 against a 60 draw
   * budget, so the valve exists for a future catalog rather than for today.
   */
  const [droppedParcels, setDroppedParcels] = useState<ReadonlySet<string>>(EMPTY_DROP_SET);
  /**
   * Bumps once per piece key as its GLB resolves and its real triangle count
   * becomes known. Without this the admission budget would keep pricing a cold
   * region's pieces at 0 for the whole session.
   */
  const pricingRevision = useSyncExternalStore(
    subscribeSourcePricing,
    getSourcePricingRevision,
    getSourcePricingRevision,
  );
  const snapshots = useMemo(
    () => buildChunkSnapshots(pieces, droppedParcels, pricingRevision),
    [pieces, droppedParcels, pricingRevision],
  );
  const chunkGroups = useMemo(createChunkGroups, []);
  // Slice D §1/§4b: kit GLB demand defers to the land stream tier — the
  // hydrator + empty chunk groups stay (data path untouched); merged-chunk
  // content changes re-open the land quiet window [R3-F3].
  const kitStreamReleased = useBootStreamRelease(BOOT_STREAM_TIER_LAND + 2);
  useEffect(() => {
    bumpLandRevision();
  }, [snapshots]);

  /**
   * The data generation the current drop set was derived from. Membership is
   * re-derived ONLY when this changes; camera movement alone must never churn
   * it, or every flip would fail the per-`(chunk, pieceKey)` merge memo and
   * rebuild the chunk's geometry.
   */
  const dropBasisRef = useRef<{
    pieces: ReadonlyMap<string, readonly PlacedPiece[]> | null;
    pricingRevision: number;
    chunkIndex: number;
  }>({ pieces: null, pricingRevision: -1, chunkIndex: -1 });

  /** Persisted rows per parcel — the denominator of the nearest-yard assertion. */
  const persistedByParcel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [parcelCode, parcelPieces] of pieces) {
      let renderable = 0;
      for (const piece of parcelPieces) {
        if (KIT_PIECE_KEY_SET.has(piece.pieceKey)) renderable++;
      }
      if (renderable > 0) counts.set(parcelCode, renderable);
    }
    return counts;
  }, [pieces]);
  const activePieceKeys = useMemo(() => {
    const active = new Set<KitPieceKey>();
    for (const snapshot of snapshots) {
      for (const pieceKey of snapshot.byPieceKey.keys()) active.add(pieceKey);
    }
    return KIT_PIECE_KEYS.filter((pieceKey) => active.has(pieceKey));
  }, [snapshots]);

  // Slice D §4b: declare the CURRENT expected source set for the land
  // completion tracker (0 until the stream tier releases the demand).
  useEffect(() => {
    declareLandSlots('kit', kitStreamReleased ? activePieceKeys.length : 0);
  }, [kitStreamReleased, activePieceKeys]);

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

  /**
   * Fold the frame's admission result into the probe state, recompute the
   * nearest-parcel retention numbers, and re-evaluate the farthest-first parcel
   * drop. Allocation-free on the steady path: the only object it can build is a
   * new drop set, and that happens solely when the set actually changes.
   */
  const updateAdmissionState = useCallback(
    (chunksVisible: number, visibleDraws: number, visibleTriangles: number) => {
      ADMISSION_STATE.chunksVisible = chunksVisible;
      ADMISSION_STATE.visibleDraws = visibleDraws;
      ADMISSION_STATE.visibleTriangles = visibleTriangles;

      let nearestParcelCode: string | null = null;
      let nearestParcelDistance = Number.POSITIVE_INFINITY;
      let nearestChunkIndex = -1;
      let anyInRangeHasPieces = false;

      for (const parcel of LAND_PARCELS) {
        const persisted = persistedByParcel.get(parcel.id);
        if (persisted === undefined) continue;
        const dx = _kitCameraPosition.x - parcel.cx;
        const dz = _kitCameraPosition.z - parcel.cz;
        const distance = dx * dx + dz * dz;
        if (distance >= KIT_CHUNK_VIEW_DISTANCE_SQ) continue;
        anyInRangeHasPieces = true;
        if (distance < nearestParcelDistance) {
          nearestParcelDistance = distance;
          nearestParcelCode = parcel.id;
          nearestChunkIndex = CHUNK_INDEX_BY_PARCEL_CODE.get(parcel.id) ?? -1;
        }
      }

      let renderedPieceCount = 0;
      for (let index = 0; index < KIT_CHUNKS.length; index++) {
        if (_kitChunkSelected[index] !== 1) continue;
        for (const count of snapshots[index]!.countByParcel.values()) renderedPieceCount += count;
      }

      ADMISSION_STATE.anyParcelInRangeHasPieces = anyInRangeHasPieces;
      ADMISSION_STATE.renderedPieceCount = renderedPieceCount;
      ADMISSION_STATE.nearestParcelCode = nearestParcelCode;
      ADMISSION_STATE.nearestParcelPersisted =
        nearestParcelCode === null ? 0 : (persistedByParcel.get(nearestParcelCode) ?? 0);
      ADMISSION_STATE.nearestParcelRendered =
        nearestParcelCode === null || nearestChunkIndex < 0 || _kitChunkSelected[nearestChunkIndex] !== 1
          ? 0
          : (snapshots[nearestChunkIndex]!.countByParcel.get(nearestParcelCode) ?? 0);

      // Farthest-first parcel drop. Only a single chunk that busts a budget ON
      // ITS OWN can force this, because the chunk loop already skips any
      // further chunk that would not fit. The nearest parcel is never a
      // candidate — that is the retention floor, stated as code.
      //
      // Costs come from `chunkParcelCosts` (the raw piece map), never from
      // `snapshots` — the snapshot is already filtered by the current drop set,
      // so reading it would let a drop erase its own justification and flip
      // every render. `basisChanged` is what holds the set steady while the
      // camera moves; `computeChunkDrop` returns the previous set BY REFERENCE
      // when nothing should change, making this identity check exact.
      const basis = dropBasisRef.current;
      const basisChanged =
        basis.pieces !== pieces
        || basis.pricingRevision !== pricingRevision
        || basis.chunkIndex !== nearestChunkIndex;
      dropBasisRef.current = { pieces, pricingRevision, chunkIndex: nearestChunkIndex };

      const nextDrop =
        nearestChunkIndex < 0
          ? EMPTY_DROP_SET
          : computeChunkDrop({
              parcels: chunkParcelCosts(nearestChunkIndex, pieces),
              nearestParcelCode,
              previousDropped: droppedParcels,
              basisChanged,
            });
      if (nextDrop !== droppedParcels && !sameMembers(nextDrop, droppedParcels)) {
        ADMISSION_STATE.droppedParcels = [...nextDrop];
        setDroppedParcels(nextDrop);
      }

      publishLandKitStatsIfChanged();
    },
    [droppedParcels, persistedByParcel, pieces, pricingRevision, snapshots],
  );

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

    // §4.4 chunk admission — nearest-first, with the NEAREST chunk admitted
    // unconditionally as the retention floor. Every further chunk must fit
    // inside the global draw and triangle budgets. The floor is what makes the
    // G-D "nearest yard intact" assertion hold: the yard you are standing in
    // is never the thing a budget sacrifices.
    let admittedChunks = 0;
    let admittedDraws = 0;
    let admittedTriangles = 0;
    for (let rank = 0; rank < MAX_VISIBLE_CHUNKS; rank++) {
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

      const snapshot = snapshots[nearestIndex]!;
      const draws = snapshot.byPieceKey.size;
      if (
        !admitsChunk(
          rank,
          { draws, triangles: snapshot.triangles },
          { draws: admittedDraws, triangles: admittedTriangles },
        )
      ) {
        // Skipping rather than breaking: a nearer-but-heavy chunk must not hide
        // a further cheap one that still fits.
        _kitChunkSelected[nearestIndex] = 2;
        continue;
      }

      _kitChunkSelected[nearestIndex] = 1;
      chunkGroups[nearestIndex]!.visible = true;
      admittedChunks++;
      admittedDraws += draws;
      admittedTriangles += snapshot.triangles;
    }

    updateAdmissionState(admittedChunks, admittedDraws, admittedTriangles);
  });

  return (
    <>
      <KitPieceHydrator />
      {chunkGroups.map((group, index) => (
        <primitive key={KIT_CHUNKS[index]!.id} object={group} />
      ))}
      {kitStreamReleased &&
        activePieceKeys.map((pieceKey) => (
          <KitPieceSourceErrorBoundary
            key={pieceKey}
            onErrored={() => reportLandSlotFallback('kit', pieceKey)}
          >
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
