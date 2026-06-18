'use client';

/**
 * land-showroom.tsx — Decorative "kinda set up" showroom layer (2026-06-18).
 *
 * Renders ~15 model buildings on outer starter-tier lots, each with a "FOR RENT"
 * sign, so the empty for-sale world reads as populated and advertises the
 * buy-and-fix-up path to visitors.
 *
 * Data source: LAND_SHOWROOM (deterministic constant, no RNG, no clock).
 *
 * Hide-when-owned: each group's .visible toggles false when that parcel's
 * status === 'owned' in the land store, so a real buyer's structure cleanly
 * takes over (land-structures.tsx renders the real building; this showroom
 * entry disappears).
 *
 * Distance cull: same CULL_DIST=14000wu as land-structures.tsx. All per-frame
 * work uses module-scope scratch Vector3 — ZERO per-frame allocations.
 *
 * FOR RENT sign — Iris-Xe-safe:
 *   - ONE shared 256×64 CanvasTexture ("FOR RENT" + "CLAWVILLE ESTATES").
 *   - ONE shared MeshBasicMaterial (plank faces).
 *   - ONE shared MeshStandardMaterial warm-brown (post).
 *   - Each lot: small BoxGeometry plank + BoxGeometry post, positioned/rotated
 *     identically to the for-sale sign math in land-parcels.tsx.
 *   - NO drei <Text>/<Billboard> — hard crash on Iris Xe.
 *
 * Building GLBs: reuse the /models/land-structures/<style>/<type>.glb paths.
 *   - GLB clone + material-clone pattern mirrors land-structures.tsx exactly.
 *   - Suspense + GLBErrorBoundary fallback (PrimitiveStructure) on every slot.
 *   - Dispose ONLY cloned materials on unmount; never dispose shared geometry/textures.
 *
 * Draw budget: ~15 buildings (GLB or primitive fallback) + ~15 sign posts
 *   (BoxGeometry) + ~15 sign planks (BoxGeometry) = ~45 extra objects, all
 *   distance-culled. Negligible compared to the existing 180-parcel layer.
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
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { LAND_PARCELS, LAND_SHOWROOM } from '@clawville/shared';
import type { ParcelSlot } from '@clawville/shared';
import type { ShowroomEntry, ShowroomSignLabel } from '@clawville/shared';
import { useLandStore, getParcelStatus } from '@/stores/land';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { extendLoaderWithMeshopt } from '@/lib/three/meshopt-loader-setup';

// ---------------------------------------------------------------------------
// Constants (mirrored from land-structures.tsx — keep in sync)
// ---------------------------------------------------------------------------

/** Sand floor Y — matches arena-terrain.tsx + land-parcels.tsx. */
const FLOOR_Y = -2;

/** Target footprint fraction (same as land-structures.tsx). */
const FOOTPRINT_FRACTION = 0.62;

/** Level → scale ramp — same formula as land-structures.tsx. */
const LEVEL_SCALE_MIN = 0.78;
const LEVEL_SCALE_MAX = 1.25;
function levelScale(level: number): number {
  const lv = Math.max(1, Math.min(5, level || 1));
  return LEVEL_SCALE_MIN + (lv - 1) * ((LEVEL_SCALE_MAX - LEVEL_SCALE_MIN) / 4);
}

/**
 * Distance cull (squared). Generous 14000wu — outer starters reach ~12309wu
 * from origin at worst, so 14000 guarantees no on-screen structure is culled.
 * Consistent with land-structures.tsx CULL_DIST.
 */
const CULL_DIST = 14000;
const CULL_DIST_SQ = CULL_DIST * CULL_DIST;

// ---------------------------------------------------------------------------
// Sign constants (copied from land-parcels.tsx so geometry aligns exactly)
// ---------------------------------------------------------------------------

const SIGN_POST_W = 4;
const SIGN_POST_H = 52;
const SIGN_POST_Y = FLOOR_Y + SIGN_POST_H * 0.5;

const PLANK_W = 68;
const PLANK_H = 28;
const PLANK_D = 2.5;
const PLANK_Y = FLOOR_Y + SIGN_POST_H - PLANK_H * 0.6;

/** Fraction of parcel half-size — matches SIGN_RADIAL_OFFSET in land-parcels.tsx. */
const SIGN_RADIAL_OFFSET = 0.40;

// ---------------------------------------------------------------------------
// Module-scope scratch — ZERO per-frame allocations
// ---------------------------------------------------------------------------

const _camPos = new THREE.Vector3();
const _bbox = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();

// ---------------------------------------------------------------------------
// Sign CanvasTextures + shared materials (ref-counted module singletons; one
// set per LandShowroom mount, disposed on unmount). Two 256×64 cells:
//   - 'rent'    : amber "FOR RENT" / "CLAWVILLE ESTATES" (starter showcase)
//   - 'premium' : gold  "PREMIUM"  / "FOUNDERS' ROW"     (founder showcase)
// ---------------------------------------------------------------------------

function buildSignTexture(label: ShowroomSignLabel): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  const accent   = label === 'premium' ? '#ffd54a' : '#f5a623';
  const title    = label === 'premium' ? 'PREMIUM' : 'FOR RENT';
  const subtitle = label === 'premium' ? "FOUNDERS' ROW" : 'CLAWVILLE ESTATES';

  // Background
  ctx.fillStyle = '#0a1520';
  ctx.fillRect(0, 0, 256, 64);

  // Accent borders
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 256, 5);   // top
  ctx.fillRect(0, 59, 256, 5);  // bottom
  ctx.fillRect(0, 5, 5, 54);    // left
  ctx.fillRect(251, 5, 5, 54);  // right

  // Title
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, 128, 34);

  // Subtitle
  ctx.fillStyle = accent;
  ctx.font = '11px sans-serif';
  ctx.fillText(subtitle, 128, 52);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

interface SignMaterials {
  rentPlankMat: THREE.MeshBasicMaterial;
  premiumPlankMat: THREE.MeshBasicMaterial;
  postMat: THREE.MeshStandardMaterial;
}

let _signMats: SignMaterials | null = null;
let _signTextures: THREE.CanvasTexture[] = [];
let _signMatRefCount = 0;

function acquireSignMaterials(): SignMaterials {
  _signMatRefCount++;
  if (_signMats) return _signMats;

  const rentTex    = buildSignTexture('rent');
  const premiumTex = buildSignTexture('premium');
  _signTextures = [rentTex, premiumTex];
  _signMats = {
    rentPlankMat:    new THREE.MeshBasicMaterial({ map: rentTex,    side: THREE.DoubleSide }),
    premiumPlankMat: new THREE.MeshBasicMaterial({ map: premiumTex, side: THREE.DoubleSide }),
    postMat: new THREE.MeshStandardMaterial({
      color: 0x6b4c1e,  // warm dark wood — matches land-parcels.tsx sign posts
      roughness: 0.92,
      metalness: 0.0,
    }),
  };
  return _signMats;
}

function releaseSignMaterials(): void {
  _signMatRefCount--;
  if (_signMatRefCount <= 0) {
    if (_signMats) {
      _signMats.rentPlankMat.dispose();
      _signMats.premiumPlankMat.dispose();
      _signMats.postMat.dispose();
      _signMats = null;
    }
    for (const t of _signTextures) t.dispose();
    _signTextures = [];
    _signMatRefCount = 0;
  }
}

// ---------------------------------------------------------------------------
// GLB path resolver (same convention as land-structures.tsx)
// ---------------------------------------------------------------------------

function showroomGlbPath(style: ShowroomEntry['style'], structureType: ShowroomEntry['structureType']): string {
  return `/models/land-structures/${style}/${structureType}.glb`;
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
const HOME_BODY_MAT  = new THREE.MeshStandardMaterial({ color: 0xddb892, roughness: 0.85, metalness: 0.0 });
const HOME_ROOF_MAT  = new THREE.MeshStandardMaterial({ color: 0x9c4f2e, roughness: 0.80, metalness: 0.0 });
const SHOP_BODY_MAT  = new THREE.MeshStandardMaterial({ color: 0x8fb8c9, roughness: 0.80, metalness: 0.0 });
const SHOP_ROOF_MAT  = new THREE.MeshStandardMaterial({ color: 0x2e6c8c, roughness: 0.78, metalness: 0.0 });
const DOOR_MAT       = new THREE.MeshStandardMaterial({ color: 0x4a3422, roughness: 0.90, metalness: 0.0 });

// ---------------------------------------------------------------------------
// GLBErrorBoundary — renders fallback when a GLB 404s (same pattern as land-structures.tsx)
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
    return { errored: true };
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
  const isShop = entry.structureType === 'shop';
  const bodyMat = isShop ? SHOP_BODY_MAT : HOME_BODY_MAT;
  const roofMat = isShop ? SHOP_ROOF_MAT : HOME_ROOF_MAT;

  const targetFootprint = parcel.size * FOOTPRINT_FRACTION;
  const baseScale = targetFootprint / PRIM_MAX_DIM;
  const scale = baseScale * levelScale(entry.level);

  const groupRef = useRef<THREE.Group>(null);
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.traverse((o) => {
      o.matrixAutoUpdate = false;
      o.updateMatrix();
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
  const groupRef = useRef<THREE.Group>(null);

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

    // Normalize to footprint via max(X,Y,Z) bbox + ground so feet sit on FLOOR_Y.
    c.updateMatrixWorld(true);
    _bbox.setFromObject(c);
    _bbox.getSize(_size);
    _bbox.getCenter(_center);
    const maxDim = Math.max(_size.x, _size.y, _size.z);
    const targetFootprint = parcel.size * FOOTPRINT_FRACTION;
    const baseScale = maxDim > 0.001 ? targetFootprint / maxDim : 1;
    const finalScale = baseScale * levelScale(entry.level);

    // Ground: subtract bbox.min.y * scale so model floor lands on FLOOR_Y.
    const ground = -_bbox.min.y * finalScale;

    return { cloned: c, scale: finalScale, groundOffset: ground };
  }, [scene, parcel.size, entry.level]);

  // Lock static transforms after scale/ground apply.
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
// ShowroomSign — one sign per showroom slot (FOR RENT or PREMIUM plank material)
// ---------------------------------------------------------------------------

function ShowroomSign({
  parcel,
  plankMat,
  postMat,
}: {
  parcel: ParcelSlot;
  plankMat: THREE.MeshBasicMaterial;
  postMat: THREE.MeshStandardMaterial;
}) {
  const { postMesh, plankMesh } = useMemo(() => {
    // Sign placement: identical to land-parcels.tsx sign math.
    const angle  = Math.atan2(-parcel.cx, -parcel.cz);
    const offset = (parcel.size * 0.5) * SIGN_RADIAL_OFFSET;
    const signX  = parcel.cx + Math.sin(angle) * offset;
    const signZ  = parcel.cz + Math.cos(angle) * offset;

    // Sign post (BoxGeometry — no UV remapping needed for solid material)
    const postGeo = new THREE.BoxGeometry(SIGN_POST_W, SIGN_POST_H, SIGN_POST_W);
    _m4.makeTranslation(signX, SIGN_POST_Y, signZ);
    postGeo.applyMatrix4(_m4);
    postGeo.computeBoundingBox();
    postGeo.computeBoundingSphere();

    const pm = new THREE.Mesh(postGeo, postMat);
    pm.name            = `showroom-sign-post-${parcel.id}`;
    pm.matrixAutoUpdate = false;
    pm.updateMatrix();
    pm.frustumCulled   = true;

    // Sign plank (BoxGeometry with FOR RENT CanvasTexture — default UVs [0,1] are fine
    // because we have a single-cell texture, not an atlas with row remapping).
    const plankGeo = new THREE.BoxGeometry(PLANK_W, PLANK_H, PLANK_D);
    _m4.makeRotationY(angle);
    _m4b.makeTranslation(signX, PLANK_Y, signZ);
    _m4b.multiply(_m4);
    plankGeo.applyMatrix4(_m4b);
    plankGeo.computeBoundingBox();
    plankGeo.computeBoundingSphere();

    const pkm = new THREE.Mesh(plankGeo, plankMat);
    pkm.name            = `showroom-sign-plank-${parcel.id}`;
    pkm.matrixAutoUpdate = false;
    pkm.updateMatrix();
    pkm.frustumCulled   = true;

    return { postMesh: pm, plankMesh: pkm };
  }, [parcel, plankMat, postMat]);

  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.add(postMesh);
    g.add(plankMesh);
    return () => {
      // Dispose OUR geometry instances (not the shared material/texture).
      postMesh.geometry.dispose();
      plankMesh.geometry.dispose();
      g.remove(postMesh);
      g.remove(plankMesh);
    };
  }, [postMesh, plankMesh]);

  return <group ref={groupRef} />;
}

// ---------------------------------------------------------------------------
// ShowroomSlot — one lot: distance-cull + hide-when-owned + building + sign
// ---------------------------------------------------------------------------

function ShowroomSlot({
  parcel,
  entry,
  signMats,
}: {
  parcel: ParcelSlot;
  entry: ShowroomEntry;
  signMats: SignMaterials;
}) {
  const outerRef = useRef<THREE.Group>(null);
  const path = showroomGlbPath(entry.style, entry.structureType);
  // Pick the sign plank by the entry's label: gold PREMIUM on Founders' Row,
  // amber FOR RENT on the starter showcase (default).
  const plankMat = entry.signLabel === 'premium' ? signMats.premiumPlankMat : signMats.rentPlankMat;

  // Read store once at render-level for the hide-when-owned initial state.
  // The actual per-frame update handles the toggle efficiently.
  const parcels = useLandStore((s) => s.parcels);

  // useFrame: distance cull + hide-when-owned, zero allocs.
  useFrame(({ camera }) => {
    const g = outerRef.current;
    if (!g) return;

    camera.getWorldPosition(_camPos);
    const dx = _camPos.x - parcel.cx;
    const dz = _camPos.z - parcel.cz;
    const distSq = dx * dx + dz * dz;

    // Hide when: (1) owned — real structure takes over; (2) too far away.
    const owned = getParcelStatus(parcels, parcel.id) === 'owned';
    const visible = !owned && distSq <= CULL_DIST_SQ;
    if (g.visible !== visible) g.visible = visible;
  });

  const primitive = <PrimitiveShowroomStructure parcel={parcel} entry={entry} />;

  return (
    <group ref={outerRef}>
      {/* Building — GLB with primitive fallback */}
      <GLBErrorBoundary fallback={primitive}>
        <Suspense fallback={primitive}>
          <GLBShowroomStructure parcel={parcel} entry={entry} path={path} />
        </Suspense>
      </GLBErrorBoundary>

      {/* FOR RENT / PREMIUM sign */}
      <ShowroomSign parcel={parcel} plankMat={plankMat} postMat={signMats.postMat} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// LandShowroom — root component
// ---------------------------------------------------------------------------

export default function LandShowroom() {
  // Acquire shared sign materials + FOR RENT / PREMIUM textures for this mount.
  // Released on unmount (ref-counted so multiple mounts are safe, though there
  // should only ever be one in World3DCanvas).
  const signMats = useMemo(() => acquireSignMaterials(), []);
  useEffect(() => {
    return () => { releaseSignMaterials(); };
  }, []);

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

  return (
    <>
      {slots.map(({ parcel, entry }) => (
        <ShowroomSlot
          key={parcel.id}
          parcel={parcel}
          entry={entry}
          signMats={signMats}
        />
      ))}
    </>
  );
}
