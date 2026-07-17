'use client';

/**
 * land-structures.tsx — STAGE 2 in-world render scaffold for placed land
 * structures (homes + shops).
 *
 * A parcel's data already renders as a for-sale lot (land-parcels.tsx, 7 draws).
 * THIS layer draws the BUILDING a player has placed on their parcel — today as a
 * clean low-poly primitive fallback, and (once Stage-1 sources the GLBs) as the
 * real model. The swap to final GLBs happens AFTER the founder picks a style;
 * until then the primitive covers the absence so the world is never empty.
 *
 * Data flow:
 *   useLandStore.structures (Map<parcelId, PlacedStructure>)
 *     ← setStructures(list)   ← Land Office modal edits (existing wire, not ours)
 *     ← setStructures(...)    ← THIS layer's self-hydration via api.getMyLand()
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
 *   - GLB clones + cloned materials disposed on unmount; GLB-cache originals are
 *     never disposed (shared across consumers).
 *
 * Robustness — the primitive ALWAYS wins on a missing/failed GLB:
 *   drei useGLTF REJECTS (not just suspends) when a file 404s. A bare
 *   <Suspense fallback> only catches the PENDING promise, NOT the rejection — a
 *   404 would bubble an error up the tree. So each GLB-backed structure is
 *   wrapped in BOTH:
 *     - a <Suspense fallback={<PrimitiveStructure/>}>  (covers the PENDING load)
 *     - a <GLBErrorBoundary fallback={<PrimitiveStructure/>}> (covers the THROW
 *       on a missing/failed GLB — the TODO-SWAP default paths point at files
 *       Stage-1 may not have shipped yet, so this is the live path today).
 *   Result: with the TODO-SWAP paths pointing at non-existent files, every
 *   placed structure renders a primitive. No hole, no crash.
 *
 * Draw budget: one player owns at most MAX_PARCELS_PER_AVATAR (5) parcels, so the
 * realistic worst case is 5 VISIBLE owned structures. Primitive = ~3 draws each
 * (body + roof + door); a GLB = however many the model has (small, low-poly
 * homes/shops). Tiny budget. Far parcels are distance-culled.
 */

import { useMemo, useEffect, useRef, useState, Suspense, Component } from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { LAND_PARCELS, MAX_PARCELS_PER_AVATAR } from '@clawville/shared';
import type { ParcelSlot } from '@clawville/shared';
import { api } from '@/lib/api';
import { useAvatar } from '@/hooks/use-avatar';
import { useLandStore, type PlacedStructure } from '@/stores/land';
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
 * the for-sale frame/pad reading around it. parcel.size is 192wu (founder) or
 * 224wu (all others), so level-1 footprint ≈ 119wu / 139wu.
 */
const FOOTPRINT_FRACTION = 0.62;

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
 * is consistent with the rest of the world. Worst case ≤5 owned structures, so
 * the per-frame .visible toggle cost is trivial.
 */
const CULL_DIST = 14000;
const CULL_DIST_SQ = CULL_DIST * CULL_DIST;

// ---------------------------------------------------------------------------
// catalogKey → GLB path map (the 12 SKUs)
// ---------------------------------------------------------------------------

/**
 * DEFAULT style chosen by the founder in Stage-1. ALL home-* keys map to one
 * home.glb, ALL shop-* keys map to one shop.glb of the default style. The
 * upgrade ladder (level) is expressed by SCALE here, not by swapping GLBs — a
 * deliberate Stage-2 simplification (the catalog's per-level GLB swap is future
 * work).
 *
 * TODO-SWAP: the default style is whatever Stage-1 ships under
 *   /models/land-structures/<style>/home.glb  +  shop.glb
 * Stage-1 may NOT have shipped these files yet when this renders — the primitive
 * fallback (Suspense + error boundary) covers the absence. Once the founder
 * picks a style, update DEFAULT_STYLE below (and/or per-key entries) to the real
 * paths and bust the browser cache with a ?v=N suffix per the asset-cache-bust
 * rule (3dStructure.md §6f rule 9).
 */
const DEFAULT_STYLE = 'coastal-cottage';
const DEFAULT_HOME_GLB = `/models/land-structures/${DEFAULT_STYLE}/home.glb`;
const DEFAULT_SHOP_GLB = `/models/land-structures/${DEFAULT_STYLE}/shop.glb`;

/**
 * Resolve a catalogKey to its GLB path. EXHAUSTIVE over the 12 catalog keys via a
 * guaranteed default branch: a `home-*` key → home.glb, a `shop-*` key → shop.glb,
 * anything else → home.glb (defensive — no key is ever unmapped). When per-style /
 * per-SKU GLBs land, replace this with an explicit Record over all 12 keys.
 */
function catalogKeyToGlbPath(catalogKey: string, structureType: 'home' | 'shop'): string {
  if (structureType === 'shop' || catalogKey.startsWith('shop-')) return DEFAULT_SHOP_GLB;
  return DEFAULT_HOME_GLB;
}

// ---------------------------------------------------------------------------
// Module-scope scratch (ZERO per-frame allocations — Iris Xe rule)
// ---------------------------------------------------------------------------
const _camPos = new THREE.Vector3();
const _bbox = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

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

  // Clone the cached scene + materials (shared cache — mutate the clone, never
  // the original; clone materials to avoid cross-consumer purple in a second
  // renderer context). Normalize to footprint via max(X,Y,Z), ground so feet sit
  // on FLOOR_Y, then apply the level ramp.
  const { cloned, scale, groundOffset } = useMemo(() => {
    const c = scene.clone(true);
    makeObject3DWebGPUSafe(c);

    // Clone materials so this consumer owns its own material instances.
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

    // Measure bbox (max-dim normalization, memory: building-maxdim-normalization).
    c.updateMatrixWorld(true);
    _bbox.setFromObject(c);
    _bbox.getSize(_size);
    _bbox.getCenter(_center);
    const maxDim = Math.max(_size.x, _size.y, _size.z);
    const targetFootprint = parcel.size * FOOTPRINT_FRACTION;
    const baseScale = maxDim > 0.001 ? targetFootprint / maxDim : 1;
    const finalScale = baseScale * levelScale(structure.level);

    // Ground: subtract bbox.min.y * scale so the model floor lands on FLOOR_Y
    // (memory: building-glb-pivot-offset-far-from-scene-origin).
    const ground = -_bbox.min.y * finalScale;

    return { cloned: c, scale: finalScale, groundOffset: ground };
  }, [scene, parcel.size, parcel.cx, parcel.cz, structure.level]);

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

  // Dispose ONLY the cloned MATERIALS on unmount (we explicitly .clone()'d them
  // above, so disposing them is correct and frees their GPU pipelines).
  //
  // NEVER dispose geometry: `scene.clone(true)` does NOT deep-copy BufferGeometry —
  // `Mesh.copy()` does `this.geometry = source.geometry` (a REFERENCE copy), so the
  // clone's geometry IS the useGLTF-cache original, shared with every other consumer
  // of this GLB (all `home-*` structures resolve to ONE home.glb; the preview route;
  // a re-mount on level upgrade). Disposing it would hand a disposed GPU buffer to
  // those still-mounted siblings → blank/black models mid-session. This matches the
  // authoritative rule in player-avatar.tsx (~L808) and memory
  // `useGLTF-scene-mutation-clone-first`. Textures are likewise NOT disposed —
  // `material.clone()` shares texture references with the cache.
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
// StructureSlot — one placed structure: distance-culled wrapper around the
// GLB (with primitive fallback on pending/error).
// ---------------------------------------------------------------------------

function StructureSlot({ parcel, structure }: { parcel: ParcelSlot; structure: PlacedStructure }) {
  const outerRef = useRef<THREE.Group>(null);
  const path = catalogKeyToGlbPath(structure.catalogKey, structure.structureType);

  // Distance cull — toggle .visible by SQUARED distance from camera. Zero allocs.
  useFrame(({ camera }) => {
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
          <GLBStructure parcel={parcel} structure={structure} path={path} />
        </Suspense>
      </GLBErrorBoundary>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Self-hydration — fetch the signed-in owner's placed structures so they appear
// in-world WITHOUT opening any modal. Best-effort, never throws, never blocks.
// ---------------------------------------------------------------------------

function StructureHydrator() {
  const setStructures = useLandStore((s) => s.setStructures);
  // Only fetch once an authed avatar resolved — useAvatar returns null for
  // guests/logged-out (its queryFn swallows the 401), so gating here stops
  // the unconditional GET /api/land/me from 401-spamming the console on
  // every logged-out load.
  const { data: avatar } = useAvatar();

  useEffect(() => {
    if (!avatar) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getMyLand();
        if (cancelled) return;
        // Resolve each structure's parcelId (DB UUID) → parcelCode using the
        // parcels in the SAME /me payload. parcelCode (= LAND_PARCELS[i].id) is
        // the join key the 3D render uses; the structure DTO carries ONLY the
        // UUID (no parcelCode field), so without this map the join falls back to
        // the UUID and never matches → owned buildings never render. (Fixer:
        // the orchestrator closed this gap after the render+state diffs landed.)
        const uuidToParcelCode = new Map<string, string>();
        for (const p of res.parcels) uuidToParcelCode.set(p.id, p.parcelCode);
        setStructures(
          res.structures.map((s) => ({
            parcelId:      s.parcelId,
            parcelCode:    uuidToParcelCode.get(s.parcelId) ?? s.parcelId,
            catalogKey:    s.catalogKey,
            structureType: s.structureType,
            level:         s.level,
          })),
        );
      } catch {
        // Guest / unauthenticated / network failure — silently no-op. The owner
        // simply sees no structures of their own; other players' structures
        // would require the modal wire we don't touch (see report).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setStructures, avatar]);

  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LandStructures() {
  // Narrow selector — only re-render when the structures Map identity changes.
  const structures = useLandStore((s) => s.structures);

  // parcelId → ParcelSlot lookup, built once (LAND_PARCELS is frozen).
  const parcelById = useMemo(() => {
    const m = new Map<string, ParcelSlot>();
    for (const p of LAND_PARCELS) m.set(p.id, p);
    return m;
  }, []);

  // Resolve placed structures to (parcel, structure) render pairs. Cap at
  // MAX_PARCELS_PER_AVATAR for safety — one owner can never have more, and this
  // guards against a malformed hydration list bloating the scene.
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
      if (out.length >= MAX_PARCELS_PER_AVATAR) break;
    }
    return out;
  }, [structures, parcelById]);

  return (
    <>
      <StructureHydrator />
      {slots.map(({ parcel, structure }) => (
        <StructureSlot key={parcel.id} parcel={parcel} structure={structure} />
      ))}
    </>
  );
}
