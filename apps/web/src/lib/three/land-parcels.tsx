'use client';

/**
 * land-parcels.tsx — renders 176 land parcels as for-sale lots.
 *
 * Each parcel shows:
 *   • Low fence (a thin rectangular box frame) — one merged BufferGeometry
 *     per-tier per rail (inner/outer/left/right) shared material
 *   • "For Sale" sign — a small post + plank quad per parcel
 *
 * Draw call budget: ≤ 25 calls across all 176 parcels.
 *   - Fence geometry: 5 tier×2 ring-halves → merged per tier = 5 meshes (fences)
 *   - Sign post geometry: all 176 merged into 1 mesh (shared MeshStandardMaterial)
 *   - Sign plank geometry: all 176 merged into 1 mesh (shared MeshBasicMaterial baked canvas atlas)
 *   TOTAL: 7 draw calls. Well within budget.
 *
 * Iris Xe / WebGPU constraints:
 *   - NO drei Text / Billboard (hard crash on Iris Xe)
 *   - NO InstancedMesh + ShaderMaterial (silent WebGPU crash)
 *   - NO per-frame new Vector3() / new Matrix4() — all scratch vecs module-scope
 *   - Sign text baked into a single canvas CanvasTexture atlas (solid texture, no text geo)
 *   - Fence = merged BufferGeometry (MeshStandardMaterial, NO ShaderMaterial)
 *   - Signs = merged BufferGeometry (MeshBasicMaterial with atlas texture)
 *
 * Culling: each merged group has matrixAutoUpdate=false + tight computeBoundingBox/Sphere
 * so Three.js frustum-culls them correctly. Parcels beyond fog.far (13 500 wu) are
 * outside the camera.far (14 000 wu) clipping plane anyway — no extra work needed.
 *
 * Cleanup: all geometries and materials owned by this component are disposed on unmount.
 */

import { useMemo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAND_PARCELS } from '@clawville/shared';
import type { ParcelSlot } from '@clawville/shared';
import type { LandTier } from '@clawville/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sand floor Y — matches arena-terrain.tsx */
const FLOOR_Y = -2;

/** Fence height above the floor (wu) */
const FENCE_HEIGHT = 28;

/** Fence rail thickness (wu) */
const FENCE_THICKNESS = 4;

/** Fraction of parcel size occupied by fence (inset slightly so neighbours
 *  don't visually clip). 0.92 leaves ~8% gap on each edge. */
const FENCE_INSET = 0.92;

/** Sign post dimensions (wu) */
const POST_WIDTH = 4;
const POST_HEIGHT = 48;
const POST_DEPTH = 4;

/** Sign plank dimensions (wu) */
const PLANK_WIDTH = 60;
const PLANK_HEIGHT = 24;
const PLANK_DEPTH = 2;

/** Plank Y above floor */
const PLANK_Y = FLOOR_Y + POST_HEIGHT - PLANK_HEIGHT * 0.5;
/** Post base Y */
const POST_Y = FLOOR_Y + POST_HEIGHT * 0.5;

/** Sign offset from parcel center — places it on the parcel edge facing the world center */
const SIGN_RADIAL_OFFSET = 0.38; // fraction of parcel half-size toward origin

// ---------------------------------------------------------------------------
// Tier visual scheme — fence color per tier
// ---------------------------------------------------------------------------

/** Fence material color per tier. Shared MeshStandardMaterial instances per tier. */
const TIER_FENCE_COLORS: Record<LandTier, number> = {
  founder: 0xf5c842, // gold
  a:       0x7ecef4, // sky blue
  b:       0x9fc975, // sage green
  c:       0xc49a6c, // tan
  starter: 0xa0a0a0, // light grey
};

// ---------------------------------------------------------------------------
// Module-scope scratch objects (zero per-frame allocations)
// ---------------------------------------------------------------------------
const _mat4 = new THREE.Matrix4();

// ---------------------------------------------------------------------------
// "For Sale" sign atlas texture
// ---------------------------------------------------------------------------

/** Build a single 128×32 CanvasTexture with "FOR SALE" text on a white board.
 *  Used by all 176 sign planks — baked-texture approach instead of drei Text. */
function buildSignAtlasTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;

  // Board background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 32);

  // Cyan border stripe at top + bottom
  ctx.fillStyle = '#00ccff';
  ctx.fillRect(0, 0, 128, 3);
  ctx.fillRect(0, 29, 128, 3);

  // "FOR SALE" text
  ctx.fillStyle = '#003366';
  ctx.font      = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('FOR SALE', 64, 16);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------

/** Build one fence frame (4 rails) geometry for a single parcel,
 *  baked into world space via the transform matrix. */
function buildFenceGeoForParcel(parcel: ParcelSlot, outMatrix: THREE.Matrix4): THREE.BufferGeometry {
  const half = (parcel.size * FENCE_INSET) * 0.5;
  const geos: THREE.BufferGeometry[] = [];

  // 4 rails: north (−Z), south (+Z), west (−X), east (+X)
  // Each rail is a BoxGeometry placed relative to parcel center.
  const railDefs: Array<{ x: number; z: number; w: number; d: number }> = [
    // north rail
    { x: 0,     z: -half, w: parcel.size * FENCE_INSET, d: FENCE_THICKNESS },
    // south rail
    { x: 0,     z:  half, w: parcel.size * FENCE_INSET, d: FENCE_THICKNESS },
    // west rail
    { x: -half, z: 0,     w: FENCE_THICKNESS, d: parcel.size * FENCE_INSET },
    // east rail
    { x:  half, z: 0,     w: FENCE_THICKNESS, d: parcel.size * FENCE_INSET },
  ];

  for (const rail of railDefs) {
    const geo = new THREE.BoxGeometry(rail.w, FENCE_HEIGHT, rail.d);
    // Position rail relative to parcel center (parcel.cx, 0, parcel.cz)
    // then bake via world matrix
    _mat4.copy(outMatrix).multiply(
      new THREE.Matrix4().makeTranslation(
        rail.x,
        FLOOR_Y + FENCE_HEIGHT * 0.5,
        rail.z,
      )
    );
    geo.applyMatrix4(_mat4);
    geos.push(geo);
  }

  const merged = mergeGeometries(geos, false)!;
  for (const g of geos) g.dispose();
  return merged;
}

/** Build the sign post geometry for a single parcel, baked into world space. */
function buildSignPostGeo(parcel: ParcelSlot, signX: number, signZ: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(POST_WIDTH, POST_HEIGHT, POST_DEPTH);
  geo.applyMatrix4(
    new THREE.Matrix4().makeTranslation(signX, POST_Y, signZ)
  );
  return geo;
}

/** Build the sign plank geometry for a single parcel, baked into world space.
 *  The plank faces the world origin (rotated to look inward). */
function buildSignPlankGeo(parcel: ParcelSlot, signX: number, signZ: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(PLANK_WIDTH, PLANK_HEIGHT, PLANK_DEPTH);
  // Rotate plank to face origin
  const angle = Math.atan2(-parcel.cx, -parcel.cz); // face inward
  const rot = new THREE.Matrix4().makeRotationY(angle);
  const trans = new THREE.Matrix4().makeTranslation(signX, PLANK_Y, signZ);
  geo.applyMatrix4(trans.multiply(rot));
  return geo;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LandParcels() {
  const groupRef = useRef<THREE.Group>(null);

  // Build all geometries and materials once at mount.
  // Each tier gets its own fence material; posts and planks share one material each.
  const { fenceMeshes, postMesh, plankMesh, ownedMaterials } = useMemo(() => {
    // --- Fence meshes (5 tiers × 1 merged BufferGeometry each) ---
    // Group parcel geos by tier, merge per tier, create one Mesh per tier.

    const fenceGeosByTier = new Map<LandTier, THREE.BufferGeometry[]>();
    const tierMatByTier   = new Map<LandTier, THREE.MeshStandardMaterial>();

    // Pre-build per-tier materials
    for (const parcel of LAND_PARCELS) {
      if (!fenceGeosByTier.has(parcel.tier)) {
        fenceGeosByTier.set(parcel.tier, []);
        tierMatByTier.set(parcel.tier, new THREE.MeshStandardMaterial({
          color: TIER_FENCE_COLORS[parcel.tier],
          roughness: 0.7,
          metalness: 0.0,
        }));
      }
    }

    // Build fence geometry per parcel
    for (const parcel of LAND_PARCELS) {
      // Translate matrix to world position of parcel center
      const worldMatrix = new THREE.Matrix4().makeTranslation(parcel.cx, 0, parcel.cz);
      const fenceGeo = buildFenceGeoForParcel(parcel, worldMatrix);
      fenceGeosByTier.get(parcel.tier)!.push(fenceGeo);
    }

    // Merge per tier → one mesh per tier
    const fenceMeshes: THREE.Mesh[] = [];
    for (const [tier, geos] of fenceGeosByTier) {
      if (geos.length === 0) continue;
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const mat  = tierMatByTier.get(tier)!;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name             = `land-fence-${tier}`;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.frustumCulled    = true;
      fenceMeshes.push(mesh);
    }

    // --- Sign geometries — merged once for all 176 parcels ---
    const postGeos:  THREE.BufferGeometry[] = [];
    const plankGeos: THREE.BufferGeometry[] = [];

    for (const parcel of LAND_PARCELS) {
      // Place sign on the parcel edge facing world origin
      const angle   = Math.atan2(-parcel.cx, -parcel.cz);
      const offset  = (parcel.size * 0.5) * SIGN_RADIAL_OFFSET;
      const signX   = parcel.cx + Math.sin(angle) * offset;
      const signZ   = parcel.cz + Math.cos(angle) * offset;

      postGeos.push(buildSignPostGeo(parcel, signX, signZ));
      plankGeos.push(buildSignPlankGeo(parcel, signX, signZ));
    }

    // Post mesh
    const postMatl     = new THREE.MeshStandardMaterial({ color: 0x8b6914, roughness: 0.9 });
    const mergedPosts  = mergeGeometries(postGeos, false);
    for (const g of postGeos) g.dispose();
    let postMesh: THREE.Mesh | null = null;
    if (mergedPosts) {
      mergedPosts.computeBoundingBox();
      mergedPosts.computeBoundingSphere();
      postMesh              = new THREE.Mesh(mergedPosts, postMatl);
      postMesh.name         = 'land-sign-posts';
      postMesh.matrixAutoUpdate = false;
      postMesh.updateMatrix();
      postMesh.frustumCulled = true;
    }

    // Plank mesh — atlas texture
    const signTex    = buildSignAtlasTexture();
    const plankMatl  = new THREE.MeshBasicMaterial({ map: signTex });
    const mergedPlanks = mergeGeometries(plankGeos, false);
    for (const g of plankGeos) g.dispose();
    let plankMesh: THREE.Mesh | null = null;
    if (mergedPlanks) {
      mergedPlanks.computeBoundingBox();
      mergedPlanks.computeBoundingSphere();
      plankMesh              = new THREE.Mesh(mergedPlanks, plankMatl);
      plankMesh.name         = 'land-sign-planks';
      plankMesh.matrixAutoUpdate = false;
      plankMesh.updateMatrix();
      plankMesh.frustumCulled = true;
    }

    // Collect all materials for dispose on unmount
    const ownedMaterials: THREE.Material[] = [
      ...Array.from(tierMatByTier.values()),
      postMatl,
      plankMatl,
    ];

    return { fenceMeshes, postMesh, plankMesh, ownedMaterials };
  }, []); // only run once — LAND_PARCELS is a frozen constant

  // Attach meshes to the group (which R3F renders) when ready
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    for (const m of fenceMeshes) group.add(m);
    if (postMesh)  group.add(postMesh);
    if (plankMesh) group.add(plankMesh);

    return () => {
      // Teardown — dispose all owned resources
      for (const m of fenceMeshes) {
        m.geometry.dispose();
        group.remove(m);
      }
      if (postMesh) {
        postMesh.geometry.dispose();
        group.remove(postMesh);
      }
      if (plankMesh) {
        plankMesh.geometry.dispose();
        group.remove(plankMesh);
      }
      for (const mat of ownedMaterials) {
        if ('map' in mat && (mat as THREE.MeshBasicMaterial).map) {
          (mat as THREE.MeshBasicMaterial).map!.dispose();
        }
        mat.dispose();
      }
    };
  }, [fenceMeshes, postMesh, plankMesh, ownedMaterials]);

  return <group ref={groupRef} name="land-parcels" />;
}
