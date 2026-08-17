'use client';

/**
 * land-showroom.tsx — Decorative "kinda set up" showroom layer (2026-06-18).
 *
 * Renders ~22 model buildings on showcase lots so the empty for-sale world
 * reads as populated and advertises the buy-and-fix-up path to visitors.
 *
 * Data source: LAND_SHOWROOM (deterministic constant, no RNG, no clock).
 *
 * Hide-when-owned: each group's .visible toggles false when that parcel's
 * status === 'owned' in the land store, so a real buyer's structure cleanly
 * takes over with zero visual conflict.
 *
 * Distance cull: CULL_DIST derived from LAND_PARCELS max extent + margin
 * (never a hardcoded literal — see the constant). All per-frame work uses
 * module-scope scratch Vector3 — ZERO per-frame allocations.
 *
 * FOR-SALE signs: The sign system was moved to land-parcels.tsx (2026-06-18
 * rework). land-parcels renders a 3-category sign (regular/premium/
 * premium-partner) on ALL 180 plots including showroom lots. The old
 * ShowroomSign component, buildSignTexture, SignMaterials helpers,
 * acquireSignMaterials, releaseSignMaterials and the module-scope
 * _signMats / _signTextures / _signMatRefCount globals that lived in this
 * file have all been deleted — there is no sign code here anymore.
 *
 * Building GLBs: reuse /models/land-structures/<style>/<type>.glb paths.
 *   - GLB clone + material-clone pattern mirrors land-structures.tsx exactly.
 *   - Suspense + GLBErrorBoundary fallback (PrimitiveStructure) on every slot.
 *   - Dispose ONLY cloned materials on unmount; never dispose shared geo/textures.
 *
 * Draw budget: ~22 buildings (GLB or primitive fallback), all distance-culled.
 * Negligible compared to the existing 180-parcel layer.
 *
 * Iris Xe / WebGPU constraints honored:
 *   - NO drei <Text> / <Billboard> (hard crash)
 *   - NO InstancedMesh + ShaderMaterial (silent WebGPU crash)
 *   - NO per-frame new Vector3()/Matrix4() — module-scope scratch only
 *   - MeshStandardMaterial / MeshBasicMaterial only — NO ShaderMaterial
 */

import { useMemo, useEffect, useRef, Suspense, Component } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import { useGLTF } from '@react-three/drei';
import {
  LAND_PARCELS,
  LAND_SHOWROOM,
  STRUCTURE_FOOTPRINT_FRACTION,
  STRUCTURE_HEIGHT_CAP_FRACTION,
  STRUCTURE_LEVEL_SCALE_MAX,
  structureLevelScale,
} from '@clawville/shared';
import type { ParcelSlot } from '@clawville/shared';
import type { ShowroomEntry } from '@clawville/shared';
import { useLandStore, getParcelStatus } from '@/stores/land';
import { BOOT_STREAM_TIER_LAND } from '@/lib/three/decorative-release';
import { useBootStreamRelease } from '@/lib/three/use-boot-stream-release';
import {
  declareLandSlots,
  reportLandSlotFallback,
  reportLandSlotResolved,
} from '@/lib/three/land-boot-tracker';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { extendLoaderWithMeshopt } from '@/lib/three/meshopt-loader-setup';

// ---------------------------------------------------------------------------
// Constants (mirrored from land-structures.tsx — keep in sync)
// ---------------------------------------------------------------------------

/** Sand floor Y — matches arena-terrain.tsx + land-parcels.tsx. */
const FLOOR_Y = -2;

/**
 * Footprint fraction and level ramp — imported from `@clawville/shared`, which
 * is the one place they may live. See the land-structures.tsx note: the kit
 * placement predicate derives its shell reservation from these, so a local copy
 * would let the drawn and reserved shells diverge.
 */
const FOOTPRINT_FRACTION = STRUCTURE_FOOTPRINT_FRACTION;
const HEIGHT_CAP_FRACTION = STRUCTURE_HEIGHT_CAP_FRACTION;
const LEVEL_SCALE_MAX = STRUCTURE_LEVEL_SCALE_MAX;
const levelScale = structureLevelScale;

/**
 * Distance cull (squared) — DERIVED from the actual parcel layout, never a
 * literal (2026-08-10). The old hardcoded 14000 was written for the 576-grid
 * world ("outer starters reach ~12309wu"); after the 704 grow + 52t plot
 * growth the outermost c-ring parcels reach ~13204wu from origin, past the
 * literal, so far showroom lots would pop out while still fog-visible.
 *
 * CULL_DIST = max parcel-center distance from origin + CULL_MARGIN. The margin
 * (1800wu) covers the parcel footprint half-diagonal (~1177wu at 1664wu plots)
 * plus slack; anything beyond fog.far=10500 / camera.far=11500 from the CAMERA
 * is invisible anyway, so a layout-derived bound on ORIGIN distance plus this
 * margin can never cull an on-screen structure.
 */
const MAX_PARCEL_CENTER_DIST = LAND_PARCELS.reduce(
  (m, p) => Math.max(m, Math.hypot(p.cx, p.cz)),
  0,
);
const CULL_MARGIN = 1800;
const CULL_DIST = MAX_PARCEL_CENTER_DIST + CULL_MARGIN;
const CULL_DIST_SQ = CULL_DIST * CULL_DIST;

// ---------------------------------------------------------------------------
// Module-scope scratch — ZERO per-frame allocations
// ---------------------------------------------------------------------------

const _camPos  = new THREE.Vector3();
const _bbox    = new THREE.Box3();
const _size    = new THREE.Vector3();

// ---------------------------------------------------------------------------
// GLB path resolver (same convention as land-structures.tsx)
// ---------------------------------------------------------------------------

// ?v=2 cache-bust (2026-06-18): tower-cand-3 was recolored brown→grey AFTER its
// first prod deploy, and Cloudflare edge-caches /models/*.glb ~1 week with no
// purge token (3dStructure.md §6f rule 9). The query forces a re-fetch of every
// showroom model (harmless one-time re-download for the unchanged ones).
function showroomGlbPath(
  style: ShowroomEntry['style'],
  structureType: ShowroomEntry['structureType'],
): string {
  return `/models/land-structures/${style}/${structureType}-mo.glb`;
}

// ---------------------------------------------------------------------------
// Primitive fallback geometries (module-scope singletons — never disposed)
// ---------------------------------------------------------------------------

const PRIM_BODY_H = 110;
const PRIM_BODY_W = 130;
const PRIM_ROOF_H = 70;
const PRIM_ROOF_R = 100;
const PRIM_MAX_DIM = Math.max(PRIM_BODY_W, PRIM_BODY_H + PRIM_ROOF_H, PRIM_BODY_W);

const _primBodyGeo = new THREE.BoxGeometry(PRIM_BODY_W, PRIM_BODY_H, PRIM_BODY_W);
_primBodyGeo.translate(0, PRIM_BODY_H * 0.5, 0);
const _primRoofGeo = new THREE.ConeGeometry(PRIM_ROOF_R, PRIM_ROOF_H, 4);
_primRoofGeo.rotateY(Math.PI / 4);
_primRoofGeo.translate(0, PRIM_BODY_H + PRIM_ROOF_H * 0.5, 0);
const _primDoorGeo = new THREE.BoxGeometry(PRIM_BODY_W * 0.32, PRIM_BODY_H * 0.55, 6);
_primDoorGeo.translate(0, PRIM_BODY_H * 0.275, PRIM_BODY_W * 0.5 + 1);

// Module-scope primitive materials (never disposed — shared globally)
const HOME_BODY_MAT = new THREE.MeshStandardMaterial({ color: 0xddb892, roughness: 0.85, metalness: 0.0 });
const HOME_ROOF_MAT = new THREE.MeshStandardMaterial({ color: 0x9c4f2e, roughness: 0.80, metalness: 0.0 });
const SHOP_BODY_MAT = new THREE.MeshStandardMaterial({ color: 0x8fb8c9, roughness: 0.80, metalness: 0.0 });
const SHOP_ROOF_MAT = new THREE.MeshStandardMaterial({ color: 0x2e6c8c, roughness: 0.78, metalness: 0.0 });
const DOOR_MAT      = new THREE.MeshStandardMaterial({ color: 0x4a3422, roughness: 0.90, metalness: 0.0 });

// ---------------------------------------------------------------------------
// GLBErrorBoundary — renders fallback when a GLB 404s (same pattern as land-structures.tsx)
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
    return { errored: true };
  }
  componentDidCatch(): void {
    // Slice D §4b [R3-F4]: fallback outcomes are measurement-counted.
    this.props.onErrored?.();
  }
  render() {
    return this.state.errored ? this.props.fallback : this.props.children;
  }
}

// ---------------------------------------------------------------------------
// PrimitiveShowroomStructure — always-renders fallback
// ---------------------------------------------------------------------------

function PrimitiveShowroomStructure({
  parcel,
  entry,
}: {
  parcel: ParcelSlot;
  entry: ShowroomEntry;
}) {
  const isShop  = entry.structureType === 'shop';
  const bodyMat = isShop ? SHOP_BODY_MAT : HOME_BODY_MAT;
  const roofMat = isShop ? SHOP_ROOF_MAT : HOME_ROOF_MAT;

  const targetFootprint = parcel.size * FOOTPRINT_FRACTION;
  const baseScale       = targetFootprint / PRIM_MAX_DIM;
  const scale           = baseScale * levelScale(entry.level);

  const groupRef = useRef<THREE.Group>(null);
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
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
// GLBShowroomStructure — real model (suspends while loading)
// ---------------------------------------------------------------------------

function GLBShowroomStructure({
  parcel,
  entry,
  path,
}: {
  parcel: ParcelSlot;
  entry: ShowroomEntry;
  path: string;
}) {
  const { scene } = useGLTF(path, undefined, undefined, extendLoaderWithMeshopt);
  const groupRef  = useRef<THREE.Group>(null);

  // Slice D §4b: slot RESOLVED from a commit effect (render-abandon-safe).
  useEffect(() => {
    reportLandSlotResolved('showroom', parcel.id);
  }, [parcel.id]);

  // Clone scene + materials (same pattern as land-structures.tsx GLBStructure).
  // NEVER dispose geometry or textures — they are shared with the GLB cache.
  const { cloned, scale, groundOffset } = useMemo(() => {
    const c = scene.clone(true);
    makeObject3DWebGPUSafe(c);

    const clonedMats: THREE.Material[] = [];
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.frustumCulled = true;
      if (Array.isArray(m.material)) {
        m.material = m.material.map((mat) => {
          const cm = mat.clone();
          clonedMats.push(cm);
          return cm;
        });
      } else if (m.material) {
        const cm = m.material.clone();
        clonedMats.push(cm);
        m.material = cm;
      }
    });
    c.userData.__clawClonedMats = clonedMats;

    // Fit formula UNIFIED with land-structures.tsx GLBStructure (2026-08-10):
    // widest-XZ drives the footprint fit, with an INDEPENDENT height cap, and
    // the Lv5 base is fitted to both constraints before the level ramp. The
    // old max(X,Y,Z) single-axis normalization here disagreed with the
    // in-world shell renderer for tall shells (height counted against the
    // footprint), so the showroom preview and the placed building could render
    // the same GLB at different sizes. Keep both sites IDENTICAL.
    c.updateMatrixWorld(true);
    _bbox.setFromObject(c);
    _bbox.getSize(_size);
    const widestXZ        = Math.max(_size.x, _size.z);
    const targetFP        = parcel.size * FOOTPRINT_FRACTION;
    const footprintScale  = widestXZ > 0.001 ? targetFP / widestXZ : 1;
    const heightCap       = parcel.size * HEIGHT_CAP_FRACTION;
    const heightScale     = _size.y > 0.001
      ? heightCap / _size.y
      : Number.POSITIVE_INFINITY;
    const fittedBaseScale = Math.min(footprintScale, heightScale / LEVEL_SCALE_MAX);
    const finalScale      = fittedBaseScale * levelScale(entry.level);

    // Ground: subtract bbox.min.y * scale so model floor lands on FLOOR_Y.
    const ground = -_bbox.min.y * finalScale;

    return { cloned: c, scale: finalScale, groundOffset: ground };
  }, [scene, parcel.size, entry.level]);

  // Lock static transforms after scale/ground apply.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    g.matrixAutoUpdate = false;
    g.updateMatrix();
  }, [cloned, scale, groundOffset]);

  // Dispose ONLY cloned materials on unmount.
  // NEVER dispose geometry/textures (shared with useGLTF cache + land-structures.tsx
  // which uses the same GLB path — disposing here would blank their consumers).
  useEffect(() => {
    return () => {
      const mats = cloned.userData.__clawClonedMats as THREE.Material[] | undefined;
      if (mats) for (const mat of mats) mat.dispose();
    };
  }, [cloned]);

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
// ShowroomSlot — one lot: distance-cull + hide-when-owned + building
// ---------------------------------------------------------------------------

function ShowroomSlot({
  parcel,
  entry,
}: {
  parcel: ParcelSlot;
  entry: ShowroomEntry;
}) {
  const outerRef = useRef<THREE.Group>(null);
  const path = showroomGlbPath(entry.style, entry.structureType);

  // useFrame: distance cull + hide-when-owned, zero allocs.
  // getState() reads the Zustand store imperatively (safe inside useFrame —
  // no hook call, no re-render subscription here).
  useSceneFrame(({ camera }) => {
    const g = outerRef.current;
    if (!g) return;

    camera.getWorldPosition(_camPos);
    const dx    = _camPos.x - parcel.cx;
    const dz    = _camPos.z - parcel.cz;
    const distSq = dx * dx + dz * dz;

    // Hide when: (1) owned — real structure takes over; (2) too far away.
    const latestParcels = useLandStore.getState().parcels;
    const owned   = getParcelStatus(latestParcels, parcel.id) === 'owned';
    const visible = !owned && distSq <= CULL_DIST_SQ;
    if (g.visible !== visible) g.visible = visible;
  });

  const primitive = <PrimitiveShowroomStructure parcel={parcel} entry={entry} />;

  return (
    <group ref={outerRef}>
      {/* Building — GLB with primitive fallback */}
      <GLBErrorBoundary
        fallback={primitive}
        onErrored={() => reportLandSlotFallback('showroom', parcel.id)}
      >
        <Suspense fallback={primitive}>
          <GLBShowroomStructure parcel={parcel} entry={entry} path={path} />
        </Suspense>
      </GLBErrorBoundary>
    </group>
  );
}

// ---------------------------------------------------------------------------
// LandShowroom — root component
// ---------------------------------------------------------------------------

export default function LandShowroom() {
  // Build parcel id → ParcelSlot lookup once (LAND_PARCELS is frozen).
  const parcelById = useMemo(() => {
    const m = new Map<string, ParcelSlot>();
    for (const p of LAND_PARCELS) m.set(p.id, p);
    return m;
  }, []);

  // Resolve showroom entries to (parcel, entry) render pairs.
  const slots = useMemo(() => {
    return LAND_SHOWROOM
      .map((entry) => ({ parcel: parcelById.get(entry.parcelId), entry }))
      .filter((x): x is { parcel: ParcelSlot; entry: ShowroomEntry } => x.parcel !== undefined);
  }, [parcelById]);

  // Slice D §1/§4b: showroom GLB demand defers to the land stream tier
  // (decorative outer-ring content); expected slots declared for the land
  // completion tracker.
  const released = useBootStreamRelease(BOOT_STREAM_TIER_LAND);
  useEffect(() => {
    declareLandSlots('showroom', released ? slots.length : 0);
  }, [released, slots.length]);
  if (!released) return null;
  return (
    <>
      {slots.map(({ parcel, entry }) => (
        <ShowroomSlot
          key={parcel.id}
          parcel={parcel}
          entry={entry}
        />
      ))}
    </>
  );
}
