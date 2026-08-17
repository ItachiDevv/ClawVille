'use client';

/**
 * land-structures.tsx — public in-world render layer for placed homes + shops.
 *
 * A parcel's data already renders as a for-sale lot (land-parcels.tsx, 7 draws).
 * THIS layer draws every ACTIVE building from the public structures feed, with
 * a low-poly primitive fallback while its selected shell GLB loads or fails.
 *
 * Data flow:
 *   useLandStore.structures (Map<parcelCode, PlacedStructure>)
 *     ← GET /api/land/structures/public (all active structures, 60s poll)
 *     ← GET /api/land/me overlay (owner's uncached/optimistic state)
 *
 * Per placed structure we render a building at the parcel's world center, sized
 * to fit INSIDE the footprint with margin (so the for-sale frame still reads
 * around it), grounded so feet sit on the sand floor (FLOOR_Y = -2), and scaled
 * by `level` (1..5).
 *
 * Iris Xe / WebGPU constraints honored:
 *   - NO drei <Text> / <Billboard>
 *   - NO InstancedMesh + ShaderMaterial
 *   - NO per-frame new Vector3()/Matrix4() — module-scope scratch only
 *   - Primitive fallback uses MeshStandardMaterial (NOT ShaderMaterial)
 *   - Per-mesh clones preserve authored PBR materials/textures, multiply one
 *     palette swatch into `.color`, and are disposed on structure unmount.
 *   - useGLTF cache geometry/textures are shared and never disposed here.
 *
 * Robustness — the primitive ALWAYS wins on a missing/failed GLB:
 *   drei useGLTF REJECTS (not just suspends) when a file 404s. A bare
 *   <Suspense fallback> only catches the PENDING promise, NOT the rejection — a
 *   404 would bubble an error up the tree. So each GLB-backed structure is
 *   wrapped in BOTH:
 *     - a <Suspense fallback={<PrimitiveStructure/>}>  (covers the PENDING load)
 *     - a <GLBErrorBoundary fallback={<PrimitiveStructure/>}> (covers the THROW
 *       on a missing/failed GLB).
 *
 * Occupancy is currently ~8 structures. At most the 48 structures nearest the
 * camera are mounted; the set refreshes as the player walks. P3 owns chunk merges.
 */

import { useMemo, useEffect, useRef, useState, Suspense, Component } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import { useGLTF } from '@react-three/drei';
import {
  LAND_PARCELS,
  DEFAULT_PALETTE_KEY,
  DEFAULT_SHELL_KEY,
  STRUCTURE_FOOTPRINT_FRACTION,
  STRUCTURE_HEIGHT_CAP_FRACTION,
  STRUCTURE_LEVEL_SCALE_MAX,
  getPalettePreset,
  getShellCatalogEntry,
  structureLevelScale,
} from '@clawville/shared';
import type { ParcelSlot } from '@clawville/shared';
import { api } from '@/lib/api';
import { useAvatar } from '@/hooks/use-avatar';
import { BOOT_STREAM_TIER_LAND } from '@/lib/three/decorative-release';
import { useBootStreamRelease } from '@/lib/three/use-boot-stream-release';
import {
  beginLandHydration,
  declareLandSlots,
  reportLandSlotFallback,
  reportLandSlotResolved,
} from '@/lib/three/land-boot-tracker';
import { useLandStore, type PlacedStructure } from '@/stores/land';
import { LAND_STRUCTURES_REFRESH_EVENT } from '@/lib/land-query-keys';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { extendLoaderWithMeshopt } from '@/lib/three/meshopt-loader-setup';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sand floor Y — matches arena-terrain.tsx + land-parcels.tsx (parcels sit here). */
const FLOOR_Y = -2;

/**
 * Structure world-scale contract — IMPORTED, no longer redeclared here.
 *
 * These numbers used to be private copies in this file and in
 * land-showroom.tsx (0.62 / 1.5 / 0.78→1.25). They moved to
 * `@clawville/shared` because the kit placement predicate subtracts
 * `shellEnvelopeHalfWu()` from every parcel and that reservation is derived
 * from exactly these values. A renderer-local copy would let the shell we DRAW
 * and the shell we RESERVE drift apart, which is how a paid kit piece ends up
 * inside a building.
 *
 * Q7 (2026-08-09) reweighted them: footprint 0.62 → 0.64, level ramp
 * 0.78→1.25 collapsed to 0.94→1.04. The flat ramp is deliberate — scale is not
 * the level signal, the shell swap and palette are — and the net effect is a
 * Lv1 shell at 558 wu (2.07× a 270 wu avatar) instead of 401 wu (1.49×).
 * Parcel sizes are now 1,216 wu (founder/starter) and 1,664 wu (c).
 */
const FOOTPRINT_FRACTION = STRUCTURE_FOOTPRINT_FRACTION;

/** Independent Y ceiling; tall shells shrink further without changing XZ math. */
const HEIGHT_CAP_FRACTION = STRUCTURE_HEIGHT_CAP_FRACTION;

const LEVEL_SCALE_MAX = STRUCTURE_LEVEL_SCALE_MAX;
const levelScale = structureLevelScale;

/** Hard mount budget; walking reselects the nearest set after meaningful movement. */
const MAX_MOUNTED_STRUCTURES = 48;
const MOUNT_RESELECT_DISTANCE = 512;
const MOUNT_RESELECT_DISTANCE_SQ = MOUNT_RESELECT_DISTANCE * MOUNT_RESELECT_DISTANCE;

// ---------------------------------------------------------------------------
// shellKey → verified GLB path
// ---------------------------------------------------------------------------

/** Explicit rolling-deploy fallback; the API also applies this fallback. */
const DEFAULT_HOME_GLB = getShellCatalogEntry('home', DEFAULT_SHELL_KEY)!.modelPath;
const DEFAULT_SHOP_GLB = getShellCatalogEntry('shop', DEFAULT_SHELL_KEY)!.modelPath;

/** Resolve only verified catalog entries, falling back by structure type. */
function shellKeyToGlbPath(shellKey: string, structureType: 'home' | 'shop'): string {
  return getShellCatalogEntry(structureType, shellKey)?.modelPath
    ?? (structureType === 'shop' ? DEFAULT_SHOP_GLB : DEFAULT_HOME_GLB);
}

// ---------------------------------------------------------------------------
// Module-scope scratch (ZERO per-frame allocations — Iris Xe rule)
// ---------------------------------------------------------------------------
const _camPos = new THREE.Vector3();
const _bbox = new THREE.Box3();
const _size = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Tier-agnostic primitive materials (shared module-scope; never disposed —
// owned by the module, not by any one mounted instance).
// ---------------------------------------------------------------------------

/** Home palette — warm cottage tones. Shop palette — cooler commercial tones. */
const HOME_BODY_MAT = new THREE.MeshStandardMaterial({ color: 0xddb892, roughness: 0.85, metalness: 0.0 });
const HOME_ROOF_MAT = new THREE.MeshStandardMaterial({ color: 0x9c4f2e, roughness: 0.8, metalness: 0.0 });
const SHOP_BODY_MAT = new THREE.MeshStandardMaterial({ color: 0x8fb8c9, roughness: 0.8, metalness: 0.0 });
const SHOP_ROOF_MAT = new THREE.MeshStandardMaterial({ color: 0x2e6c8c, roughness: 0.78, metalness: 0.0 });
const DOOR_MAT = new THREE.MeshStandardMaterial({ color: 0x4a3422, roughness: 0.9, metalness: 0.0 });

/**
 * Primitive body/roof/door geometries are authored in a UNIT-ISH local space and
 * scaled per-structure by the wrapper group. Body: a box ~1 wide × 1.1 tall ×
 * 1 deep, sitting with its FLOOR at local y=0 (so the wrapper just lifts to
 * FLOOR_Y). Roof: a 4-sided cone (pyramid) on top. Door: a thin slab on the
 * front (+Z) face. Module-scope singletons (shared, never disposed).
 */
const PRIM_BODY_H = 110;
const PRIM_BODY_W = 130;
const PRIM_ROOF_H = 70;
const PRIM_ROOF_R = 100;

const _primBodyGeo = new THREE.BoxGeometry(PRIM_BODY_W, PRIM_BODY_H, PRIM_BODY_W);
// Lift so the box floor is at local y=0 (BoxGeometry is centered at origin).
_primBodyGeo.translate(0, PRIM_BODY_H * 0.5, 0);
const _primRoofGeo = new THREE.ConeGeometry(PRIM_ROOF_R, PRIM_ROOF_H, 4);
// Cone apex up; base sits at top of body. Cone is centered, lift to body top + half roof.
_primRoofGeo.rotateY(Math.PI / 4); // align pyramid faces to the box
_primRoofGeo.translate(0, PRIM_BODY_H + PRIM_ROOF_H * 0.5, 0);
const _primDoorGeo = new THREE.BoxGeometry(PRIM_BODY_W * 0.32, PRIM_BODY_H * 0.55, 6);
_primDoorGeo.translate(0, PRIM_BODY_H * 0.275, PRIM_BODY_W * 0.5 + 1);

/** Native max-dim of the fallback primitive. */
const PRIM_MAX_DIM = Math.max(PRIM_BODY_W, PRIM_BODY_H + PRIM_ROOF_H, PRIM_BODY_W);

// ---------------------------------------------------------------------------
// PrimitiveStructure — clean low-poly fallback (always renders)
// ---------------------------------------------------------------------------

function PrimitiveStructure({ parcel, structure }: { parcel: ParcelSlot; structure: PlacedStructure }) {
  const isShop = structure.structureType === 'shop';
  const bodyMat = isShop ? SHOP_BODY_MAT : HOME_BODY_MAT;
  const roofMat = isShop ? SHOP_ROOF_MAT : HOME_ROOF_MAT;

  // Normalize the fallback's own max dimension to the footprint, then apply the
  // shared level ramp. Authored GLBs use independent XZ and height constraints.
  const targetFootprint = parcel.size * FOOTPRINT_FRACTION;
  const baseScale = targetFootprint / PRIM_MAX_DIM;
  const scale = baseScale * levelScale(structure.level);

  const groupRef = useRef<THREE.Group>(null);
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.traverse((o) => {
      o.matrixAutoUpdate = false;
      o.updateMatrix();
      const m = o as THREE.Mesh;
      if (m.isMesh) m.frustumCulled = true;
    });
    g.matrixAutoUpdate = false;
    g.updateMatrix();
  }, [scale]);

  return (
    <group ref={groupRef} position={[parcel.cx, FLOOR_Y, parcel.cz]} scale={scale}>
      <mesh geometry={_primBodyGeo} material={bodyMat} frustumCulled />
      <mesh geometry={_primRoofGeo} material={roofMat} frustumCulled />
      <mesh geometry={_primDoorGeo} material={DOOR_MAT} frustumCulled />
    </group>
  );
}

// ---------------------------------------------------------------------------
// GLBErrorBoundary — renders fallback when a GLB load throws (404 rejection)
// ---------------------------------------------------------------------------

class GLBErrorBoundary extends Component<
  { fallback: ReactNode; onErrored?: () => void; children: ReactNode },
  { errored: boolean }
> {
  constructor(props: { fallback: ReactNode; onErrored?: () => void; children: ReactNode }) {
    super(props);
    this.state = { errored: false };
  }
  static getDerivedStateFromError(): { errored: boolean } {
    // A GLB load rejection (missing/failed file) bubbles here — show the primitive.
    return { errored: true };
  }
  componentDidCatch(): void {
    // Slice D §4b [R3-F4]: fallback outcomes are measurement-counted.
    this.props.onErrored?.();
  }
  // Intentionally no componentDidCatch logging spam — a missing GLB during the
  // Stage-1→Stage-2 swap window is EXPECTED, not an error to surface.
  render() {
    return this.state.errored ? this.props.fallback : this.props.children;
  }
}

// ---------------------------------------------------------------------------
// GLBStructure — the real model (suspends while loading)
// ---------------------------------------------------------------------------

function GLBStructure({
  parcel,
  structure,
  path,
}: {
  parcel: ParcelSlot;
  structure: PlacedStructure;
  path: string;
}) {
  const { scene } = useGLTF(path, undefined, undefined, extendLoaderWithMeshopt);
  const groupRef = useRef<THREE.Group>(null);

  // Slice D §4b: slot RESOLVED from a commit effect (render-abandon-safe).
  useEffect(() => {
    reportLandSlotResolved('structures', parcel.id);
  }, [parcel.id]);

  // Clone the cached scene graph and each authored material. Geometry/textures
  // remain cache-shared; palette swatches multiply material color, preserving
  // authored maps, roughness, metalness, side, and all other PBR properties.
  const { cloned, scale, groundOffset, ownedMaterials } = useMemo(() => {
    const c = scene.clone(true);
    makeObject3DWebGPUSafe(c);

    const materials: THREE.Material[] = [];
    const preset = getPalettePreset(structure.paletteKey) ?? getPalettePreset(DEFAULT_PALETTE_KEY)!;
    let meshOrdinal = 0;
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.frustumCulled = true;
      const tint = new THREE.Color(preset.swatches[meshOrdinal++ % preset.swatches.length]);
      const cloneMaterial = (source: THREE.Material): THREE.Material => {
        const material = source.clone();
        const colored = material as THREE.Material & { color?: THREE.Color };
        if (colored.color instanceof THREE.Color) colored.color.multiply(tint);
        materials.push(material);
        return material;
      };
      m.material = Array.isArray(m.material)
        ? m.material.map(cloneMaterial)
        : cloneMaterial(m.material);
    });

    c.updateMatrixWorld(true);
    _bbox.setFromObject(c);
    _bbox.getSize(_size);
    const widestXZ = Math.max(_size.x, _size.z);
    const targetFootprint = parcel.size * FOOTPRINT_FRACTION;
    const footprintScale = widestXZ > 0.001 ? targetFootprint / widestXZ : 1;
    const heightCap = parcel.size * HEIGHT_CAP_FRACTION;
    const heightScale = _size.y > 0.001
      ? heightCap / _size.y
      : Number.POSITIVE_INFINITY;
    // Fit Lv5 to both constraints, then derive lower levels as fractions of
    // that capped scale so tall shells visibly progress without exceeding it.
    const fittedBaseScale = Math.min(footprintScale, heightScale / LEVEL_SCALE_MAX);
    const finalScale = fittedBaseScale * levelScale(structure.level);

    // Ground: subtract bbox.min.y * scale so the model floor lands on FLOOR_Y
    // (memory: building-glb-pivot-offset-far-from-scene-origin).
    const ground = -_bbox.min.y * finalScale;

    return {
      cloned: c,
      scale: finalScale,
      groundOffset: ground,
      ownedMaterials: materials,
    };
  }, [scene, parcel.size, structure.level, structure.paletteKey]);

  // Lock static transforms (matrixAutoUpdate=false) after the scale/ground apply.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.traverse((o) => {
      o.matrixAutoUpdate = false;
      o.updateMatrix();
    });
    g.matrixAutoUpdate = false;
    g.updateMatrix();
  }, [cloned, scale, groundOffset]);

  // Dispose only the per-mesh material clones. Their shared texture references
  // and the useGLTF cache geometries remain cache-owned.
  useEffect(() => {
    return () => { for (const material of ownedMaterials) material.dispose(); };
  }, [ownedMaterials]);

  return (
    <group
      ref={groupRef}
      position={[parcel.cx, FLOOR_Y + groundOffset, parcel.cz]}
      scale={scale}
    >
      <primitive object={cloned} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// StructureSlot — one mounted GLB with primitive fallback on pending/error.
// ---------------------------------------------------------------------------

function StructureSlot({
  parcel,
  structure,
}: {
  parcel: ParcelSlot;
  structure: PlacedStructure;
}) {
  const path = shellKeyToGlbPath(structure.shellKey, structure.structureType);

  const primitive = <PrimitiveStructure parcel={parcel} structure={structure} />;

  return (
    <GLBErrorBoundary
      fallback={primitive}
      onErrored={() => reportLandSlotFallback('structures', parcel.id)}
    >
      <Suspense fallback={primitive}>
        <GLBStructure parcel={parcel} structure={structure} path={path} />
      </Suspense>
    </GLBErrorBoundary>
  );
}

type StructureRenderSlot = { parcel: ParcelSlot; structure: PlacedStructure };

function selectNearestSlots(
  slots: readonly StructureRenderSlot[],
  cameraX: number,
  cameraZ: number,
): StructureRenderSlot[] {
  return [...slots]
    .sort((a, b) => {
      const adx = cameraX - a.parcel.cx;
      const adz = cameraZ - a.parcel.cz;
      const bdx = cameraX - b.parcel.cx;
      const bdz = cameraZ - b.parcel.cz;
      return (adx * adx + adz * adz) - (bdx * bdx + bdz * bdz)
        || a.parcel.id.localeCompare(b.parcel.id);
    })
    .slice(0, MAX_MOUNTED_STRUCTURES);
}

/** Hard mount gate that streams the nearest structures as the camera walks. */
function BoundedStructureSlots({ slots }: { slots: readonly StructureRenderSlot[] }) {
  const lastCameraPosition = useRef({ x: 0, z: 0 });
  const [mountedSlots, setMountedSlots] = useState(() => selectNearestSlots(slots, 0, 0));

  useEffect(() => {
    const { x, z } = lastCameraPosition.current;
    setMountedSlots(selectNearestSlots(slots, x, z));
  }, [slots]);

  // Slice D §4b [I1-F7]: declare the CURRENT expected slot ID SET (exact
  // identity — replacing N slots with N different slots must read as
  // unresolved until the new ids resolve).
  useEffect(() => {
    declareLandSlots('structures', mountedSlots.map((s) => s.parcel.id));
  }, [mountedSlots]);

  useSceneFrame(({ camera }) => {
    camera.getWorldPosition(_camPos);
    const dx = _camPos.x - lastCameraPosition.current.x;
    const dz = _camPos.z - lastCameraPosition.current.z;
    if (dx * dx + dz * dz < MOUNT_RESELECT_DISTANCE_SQ) return;
    lastCameraPosition.current.x = _camPos.x;
    lastCameraPosition.current.z = _camPos.z;
    setMountedSlots(selectNearestSlots(slots, _camPos.x, _camPos.z));
  });

  return (
    <>
      {mountedSlots.map(({ parcel, structure }) => (
        <StructureSlot key={parcel.id} parcel={parcel} structure={structure} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Public hydration — render every active structure, then overlay the owner's
// uncached DTOs so local mutations are never held behind the 60s public cache.
// ---------------------------------------------------------------------------

function StructureHydrator() {
  const setStructures = useLandStore((state) => state.setStructures);
  const { data: avatar } = useAvatar();

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let requestVersion = 0;
    let ownedOverlay: Awaited<ReturnType<typeof api.getMyLand>> | null = null;

    const hydrate = async (includeOwned: boolean): Promise<void> => {
      const version = ++requestVersion;
      // Slice D §4b [R3-F3][I1-F8]: TWO hydration generations — the public
      // list and the authenticated owner overlay are separate requests with
      // separate outcomes (a failed getMyLand() must count as dataFailed,
      // never ride the public request's success). Terminal BEFORE the
      // superseded/cancelled early-returns.
      const donePublic = beginLandHydration();
      const wantsOwned = includeOwned && !!avatar;
      const doneOwned = wantsOwned ? beginLandHydration() : null;
      const [publicStructures, ownedResult] = await Promise.all([
        api.getPublicLandStructures().catch(() => null),
        wantsOwned
          ? api.getMyLand().catch(() => null)
          : Promise.resolve(undefined),
      ]);
      donePublic(publicStructures !== null);
      doneOwned?.(ownedResult !== null && ownedResult !== undefined);
      if (cancelled || version !== requestVersion) return;
      if (ownedResult) ownedOverlay = ownedResult;

      if (publicStructures !== null) {
        const merged = new Map<string, PlacedStructure>();
        for (const structure of publicStructures) {
          merged.set(structure.parcelCode, {
            parcelId: structure.parcelCode,
            parcelCode: structure.parcelCode,
            catalogKey: `${structure.structureType}-public`,
            structureType: structure.structureType,
            level: structure.level,
            shellKey: structure.shellKey ?? DEFAULT_SHELL_KEY,
            paletteKey: structure.paletteKey ?? DEFAULT_PALETTE_KEY,
          });
        }

        // The uncached owner read overlays the 60s public snapshot, keeping the
        // signed-in player's just-completed/optimistic appearance fresh.
        if (ownedOverlay !== null) {
          const uuidToParcelCode = new Map<string, string>();
          for (const parcel of ownedOverlay.parcels) {
            uuidToParcelCode.set(parcel.id, parcel.parcelCode);
          }
          for (const structure of ownedOverlay.structures) {
            const parcelCode = uuidToParcelCode.get(structure.parcelId);
            if (!parcelCode) continue;
            merged.set(parcelCode, {
              parcelId: structure.parcelId,
              parcelCode,
              catalogKey: structure.catalogKey,
              structureType: structure.structureType,
              level: structure.level,
              shellKey: structure.shellKey ?? DEFAULT_SHELL_KEY,
              paletteKey: structure.paletteKey ?? DEFAULT_PALETTE_KEY,
            });
          }
        }
        setStructures([...merged.values()]);
      }

      if (!cancelled) {
        if (pollTimer !== null) clearTimeout(pollTimer);
        pollTimer = setTimeout(() => { void hydrate(false); }, 60_000);
      }
    };

    const refreshNow = () => {
      if (pollTimer !== null) clearTimeout(pollTimer);
      void hydrate(true);
    };

    void hydrate(true);
    window.addEventListener(LAND_STRUCTURES_REFRESH_EVENT, refreshNow);
    return () => {
      cancelled = true;
      window.removeEventListener(LAND_STRUCTURES_REFRESH_EVENT, refreshNow);
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [setStructures, avatar]);

  return null;
}

export default function LandStructures() {
  // Narrow selector — only re-render when the structures Map identity changes.
  const structures = useLandStore((s) => s.structures);

  // parcelCode → ParcelSlot lookup, built once (LAND_PARCELS is frozen).
  const parcelById = useMemo(() => {
    const m = new Map<string, ParcelSlot>();
    for (const p of LAND_PARCELS) m.set(p.id, p);
    return m;
  }, []);

  // Resolve every public structure to a render-backed parcel.
  //
  // JOIN BUG FIX (feat/land-world-parity): the old code keyed parcelById by
  // LAND_PARCELS[i].id (= the parcelCode, e.g. 'parcel-founder-00') but looked
  // up structure.parcelId (a DB UUID) — these never matched so owned structures
  // never rendered. The fix: prefer structure.parcelCode (provided by
  // land-state-impl in this branch) which IS the parcelCode, with a fallback to
  // structure.parcelId so pre-migration hydration data degrades gracefully
  // rather than crashing.
  const slots = useMemo(() => {
    const out: Array<{ parcel: ParcelSlot; structure: PlacedStructure }> = [];
    for (const structure of structures.values()) {
      // Use parcelCode (= LAND_PARCELS[i].id) as the join key.
      // Fall back to parcelId for hydration data from older API builds that
      // didn't include parcelCode in the response.
      const joinKey = (structure as PlacedStructure & { parcelCode?: string }).parcelCode
        ?? structure.parcelId;
      const parcel = parcelById.get(joinKey);
      if (!parcel) continue; // unknown key — skip rather than crash
      out.push({ parcel, structure });
    }
    return out;
  }, [structures, parcelById]);

  // Slice D §1: land streams post-boot-core — the DATA fetch stays at outer
  // mount (owned structures never hydrate late [F9 risk-4]); only the GLB
  // slot subtree defers to the land stream tier.
  const released = useBootStreamRelease(BOOT_STREAM_TIER_LAND + 1);
  return (
    <>
      <StructureHydrator />
      {released && <BoundedStructureSlots slots={slots} />}
    </>
  );
}
