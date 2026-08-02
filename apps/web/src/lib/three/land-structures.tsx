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
 *   - Per-structure geometry clones + one shared vertex-color material are
 *     disposed on unmount; useGLTF cache originals are never mutated/disposed.
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
 * Occupancy is currently ~8 structures. Each GLB keeps its authored mesh count
 * but shares one material; far parcels are distance-culled. P3 owns chunk merges.
 */

import { useMemo, useEffect, useRef, useState, Suspense, Component } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import { useGLTF } from '@react-three/drei';
import {
  LAND_PARCELS,
  DEFAULT_PALETTE_KEY,
  DEFAULT_SHELL_KEY,
  getPalettePreset,
  getShellCatalogEntry,
} from '@clawville/shared';
import type { ParcelSlot } from '@clawville/shared';
import { api } from '@/lib/api';
import { useAvatar } from '@/hooks/use-avatar';
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
 * Target footprint fraction relative to parcel.size. The structure is normalized
 * so its widest XZ dimension (at level 1) is ~62% of the parcel footprint, leaving
 * the for-sale frame/pad reading around it. Render-backed parcel sizes are
 * 1,216wu (founder) and 1,088wu (starter/c).
 */
const FOOTPRINT_FRACTION = 0.62;

/** Independent Y ceiling; tall shells shrink further without changing XZ math. */
const HEIGHT_CAP_FRACTION = 1.5;

/**
 * Level → scale multiplier. Lerp 0.78 (L1) → 1.25 (L5), linear:
 *   scale(level) = 0.78 + (clamp(level,1,5) - 1) * 0.1175
 * L1=0.78  L2=0.8975  L3=1.015  L4=1.1325  L5=1.25
 * A modest ramp so a maxed structure reads bigger without spilling off the parcel.
 */
const LEVEL_SCALE_MIN = 0.78;
const LEVEL_SCALE_MAX = 1.25;
function levelScale(level: number): number {
  const lv = Math.max(1, Math.min(5, level || 1));
  return LEVEL_SCALE_MIN + (lv - 1) * ((LEVEL_SCALE_MAX - LEVEL_SCALE_MIN) / 4);
}

/**
 * Distance cull (camera → structure), SQUARED. GENEROUS by design.
 *
 * Parcels reach a Chebyshev half-side of 8704wu (outer starter frame); a corner
 * parcel is therefore ~sqrt(8704² + 8704²) ≈ 12309wu from world origin. The
 * camera roams near world center but can be pushed outward, so the camera→
 * structure distance for a far corner parcel can exceed ~12300wu. To NEVER
 * vanish an on-screen structure (the classic too-tight-cull bug — far-spawned
 * objects never get a frame), we cull only beyond 14000wu. Building GLBs (ring
 * at 4160wu) are never culled at all, so this layer being visible out to 14000wu
 * is consistent with the rest of the world. Current occupancy is ~8 structures.
 */
const CULL_DIST = 14000;
const CULL_DIST_SQ = CULL_DIST * CULL_DIST;

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

/** Native max-dim of the primitive (for footprint normalization parity with GLBs). */
const PRIM_MAX_DIM = Math.max(PRIM_BODY_W, PRIM_BODY_H + PRIM_ROOF_H, PRIM_BODY_W);

// ---------------------------------------------------------------------------
// PrimitiveStructure — clean low-poly fallback (always renders)
// ---------------------------------------------------------------------------

function PrimitiveStructure({ parcel, structure }: { parcel: ParcelSlot; structure: PlacedStructure }) {
  const isShop = structure.structureType === 'shop';
  const bodyMat = isShop ? SHOP_BODY_MAT : HOME_BODY_MAT;
  const roofMat = isShop ? SHOP_ROOF_MAT : HOME_ROOF_MAT;

  // Normalize the primitive so its max-dim fits the target footprint at L1, then
  // apply the level ramp. Same math the GLB path uses, so primitive↔GLB swap is
  // visually consistent in size.
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
  { fallback: ReactNode; children: ReactNode },
  { errored: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { errored: false };
  }
  static getDerivedStateFromError(): { errored: boolean } {
    // A GLB load rejection (missing/failed file) bubbles here — show the primitive.
    return { errored: true };
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

/** Clone a cache-owned geometry and bake one palette swatch into vertex colors. */
function cloneTintedGeometry(
  source: THREE.BufferGeometry,
  paletteKey: string,
  swatchIndex: number,
): THREE.BufferGeometry {
  const geometry = source.clone();
  const preset = getPalettePreset(paletteKey) ?? getPalettePreset(DEFAULT_PALETTE_KEY)!;
  const tint = new THREE.Color(preset.swatches[swatchIndex % preset.swatches.length]);
  const position = geometry.getAttribute('position');
  const sourceColors = geometry.getAttribute('color');
  const colors = new Float32Array(position.count * 3);

  for (let index = 0; index < position.count; index++) {
    const offset = index * 3;
    colors[offset] = tint.r * (sourceColors?.getX(index) ?? 1);
    colors[offset + 1] = tint.g * (sourceColors?.getY(index) ?? 1);
    colors[offset + 2] = tint.b * (sourceColors?.getZ(index) ?? 1);
  }

  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function GLBStructure({
  parcel,
  structure,
  path,
  sharedMaterial,
}: {
  parcel: ParcelSlot;
  structure: PlacedStructure;
  path: string;
  sharedMaterial: THREE.MeshStandardMaterial;
}) {
  const { scene } = useGLTF(path, undefined, undefined, extendLoaderWithMeshopt);
  const groupRef = useRef<THREE.Group>(null);

  // Clone the cached scene graph, then replace each cache-owned geometry with an
  // owned vertex-colored clone and every source material with the shared one.
  const { cloned, scale, groundOffset, ownedGeometries } = useMemo(() => {
    const c = scene.clone(true);
    const geometries: THREE.BufferGeometry[] = [];
    let meshOrdinal = 0;
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.frustumCulled = true;
      const geometry = cloneTintedGeometry(m.geometry, structure.paletteKey, meshOrdinal++);
      geometries.push(geometry);
      m.geometry = geometry;
      m.material = sharedMaterial;
    });
    // WebGPU normalization now touches only owned clones, never useGLTF cache assets.
    makeObject3DWebGPUSafe(c);

    c.updateMatrixWorld(true);
    _bbox.setFromObject(c);
    _bbox.getSize(_size);
    const widestXZ = Math.max(_size.x, _size.z);
    const targetFootprint = parcel.size * FOOTPRINT_FRACTION;
    const footprintScale = widestXZ > 0.001 ? targetFootprint / widestXZ : 1;
    const heightCap = parcel.size * HEIGHT_CAP_FRACTION;
    const heightScale = _size.y > 0.001 ? heightCap / _size.y : footprintScale;
    // Apply level growth to the footprint candidate, then enforce the height
    // ceiling on the final result. A tall shell must never regrow past the cap.
    const finalScale = Math.min(
      footprintScale * levelScale(structure.level),
      heightScale,
    );

    // Ground: subtract bbox.min.y * scale so the model floor lands on FLOOR_Y
    // (memory: building-glb-pivot-offset-far-from-scene-origin).
    const ground = -_bbox.min.y * finalScale;

    return {
      cloned: c,
      scale: finalScale,
      groundOffset: ground,
      ownedGeometries: geometries,
    };
  }, [scene, parcel.size, structure.level, structure.paletteKey, sharedMaterial]);

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

  // These are deep geometry clones, so this consumer owns and disposes them.
  // Source useGLTF geometry/textures and materials are never disposed here.
  useEffect(() => {
    return () => { for (const geometry of ownedGeometries) geometry.dispose(); };
  }, [ownedGeometries]);

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
// StructureSlot — one placed structure: distance-culled wrapper around the
// GLB (with primitive fallback on pending/error).
// ---------------------------------------------------------------------------

function StructureSlot({
  parcel,
  structure,
  sharedMaterial,
}: {
  parcel: ParcelSlot;
  structure: PlacedStructure;
  sharedMaterial: THREE.MeshStandardMaterial;
}) {
  const outerRef = useRef<THREE.Group>(null);
  const path = shellKeyToGlbPath(structure.shellKey, structure.structureType);

  useEffect(() => {
    const group = outerRef.current;
    if (!group) return;
    group.matrixAutoUpdate = false;
    group.updateMatrix();
  }, []);

  // Distance cull — toggle .visible by SQUARED distance from camera. Zero allocs.
  useSceneFrame(({ camera }) => {
    const g = outerRef.current;
    if (!g) return;
    camera.getWorldPosition(_camPos);
    const dx = _camPos.x - parcel.cx;
    const dz = _camPos.z - parcel.cz;
    const distSq = dx * dx + dz * dz;
    const visible = distSq <= CULL_DIST_SQ;
    if (g.visible !== visible) g.visible = visible;
  });

  const primitive = <PrimitiveStructure parcel={parcel} structure={structure} />;

  return (
    <group ref={outerRef}>
      <GLBErrorBoundary fallback={primitive}>
        <Suspense fallback={primitive}>
          <GLBStructure
            parcel={parcel}
            structure={structure}
            path={path}
            sharedMaterial={sharedMaterial}
          />
        </Suspense>
      </GLBErrorBoundary>
    </group>
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

    const hydrate = async (): Promise<void> => {
      const version = ++requestVersion;
      const [publicStructures, owned] = await Promise.all([
        api.getPublicLandStructures().catch(() => null),
        avatar ? api.getMyLand().catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled || version !== requestVersion) return;

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
        if (owned !== null) {
          const uuidToParcelCode = new Map<string, string>();
          for (const parcel of owned.parcels) {
            uuidToParcelCode.set(parcel.id, parcel.parcelCode);
          }
          for (const structure of owned.structures) {
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
        pollTimer = setTimeout(hydrate, 60_000);
      }
    };

    const refreshNow = () => {
      if (pollTimer !== null) clearTimeout(pollTimer);
      void hydrate();
    };

    void hydrate();
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
  const sharedMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.04,
    }),
    [],
  );

  useEffect(() => () => sharedMaterial.dispose(), [sharedMaterial]);

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

  return (
    <>
      <StructureHydrator />
      {slots.map(({ parcel, structure }) => (
        <StructureSlot
          key={parcel.id}
          parcel={parcel}
          structure={structure}
          sharedMaterial={sharedMaterial}
        />
      ))}
    </>
  );
}
