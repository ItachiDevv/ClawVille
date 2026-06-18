'use client';

/**
 * land-parcels.tsx — PREMIUM rework — renders 180 land parcels as for-sale lots.
 *
 * Visual scheme (2026-06-17 rework):
 *   • Tier-colored GROUND PAD  — flat PlaneGeometry slightly above sand, low roughness,
 *     slight emissive tint.  Merged per tier.
 *   • Corner posts + top rail  — 4 BoxGeometry corner posts + 4 BoxGeometry top rails per
 *     parcel, tier-colored, merged together WITH the pad into one mesh per tier.
 *   • Upgraded FOR-SALE sign   — 256×320 CanvasTexture atlas (5 rows × 64px, one row per tier).
 *     Per-parcel sign plank UVs are adjusted at geometry-build time to point at the correct
 *     tier row. One draw call for all 180 sign planks (MeshBasicMaterial + atlas).
 *     Sign posts: single merged mesh, warm brown.
 *
 * Draw calls: 5 (pad+border per tier) + 1 (sign posts) + 1 (sign planks) = 7.
 * Note: 16 starter showroom lots (SHOWROOM_PARCEL_IDS) skip the FOR-SALE sign
 * post+plank — they receive a FOR RENT sign from land-showroom.tsx instead. So
 * the merged sign post/plank meshes contain (180 − 16) = 164 entries each.
 * Draw call count stays at 7 (sign meshes are still present, just smaller).
 *
 * Iris Xe / WebGPU constraints:
 *   - NO drei Text / Billboard (hard crash on Iris Xe)
 *   - NO InstancedMesh + ShaderMaterial (silent WebGPU crash)
 *   - NO per-frame new Vector3() / Matrix4() — all scratch mats are module-scope
 *   - Sign text baked into a single CanvasTexture atlas (per-tier rows), no text geo
 *   - All geometry uses MeshStandardMaterial or MeshBasicMaterial — NO ShaderMaterial
 *
 * Culling: each merged mesh has matrixAutoUpdate=false + tight computeBoundingBox/Sphere.
 * Cleanup: all geometries, materials, and the atlas texture are disposed on unmount.
 */

import { useMemo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAND_PARCELS, SHOWROOM_PARCEL_IDS } from '@clawville/shared';
import type { ParcelSlot } from '@clawville/shared';
import type { LandTier } from '@clawville/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sand floor Y — matches arena-terrain.tsx */
const FLOOR_Y = -2;

/** Ground pad Y (slightly above floor to avoid z-fighting with sand) */
const PAD_Y = FLOOR_Y + 0.9;

/** Ground pad roughness — low = slightly polished/premium look */
const PAD_ROUGHNESS = 0.28;

/** Slight emissive intensity on pads so they read under deep fog */
const PAD_EMISSIVE_INTENSITY = 0.12;

/** Pad inset fraction relative to parcel size (0.9 = small margin around edge) */
const PAD_INSET = 0.88;

/** Corner post dimensions (wu) */
const POST_W  = 5.5;   // square cross-section
const POST_H  = 38;    // total height above floor
const POST_Y  = FLOOR_Y + POST_H * 0.5;  // post center Y

/** Top rail dimensions (wu) */
const RAIL_H         = 5;   // rail thickness / height
const RAIL_THICKNESS = 4;   // rail depth
const RAIL_Y         = FLOOR_Y + POST_H - RAIL_H * 0.5; // sits at top of posts

/** Sign post dimensions (wu) */
const SIGN_POST_W = 4;
const SIGN_POST_H = 52;
const SIGN_POST_Y = FLOOR_Y + SIGN_POST_H * 0.5;

/** Sign plank dimensions (wu) */
const PLANK_W = 68;
const PLANK_H = 28;
const PLANK_D = 2.5;
const PLANK_Y = FLOOR_Y + SIGN_POST_H - PLANK_H * 0.6;

/** Sign radial offset: place sign at parcel edge facing origin */
const SIGN_RADIAL_OFFSET = 0.40; // fraction of parcel half-size

/** Sign atlas — 5 tier rows, each 64px tall, 256px wide */
const ATLAS_W    = 256;
const ATLAS_ROW  = 64;
const ATLAS_H    = ATLAS_ROW * 5; // 320px

// ---------------------------------------------------------------------------
// Tier visual scheme
// ---------------------------------------------------------------------------

/** Pad + border color per tier */
const TIER_COLORS: Record<LandTier, number> = {
  founder: 0xf5c842, // gold
  a:       0x7ecef4, // sky blue
  b:       0x9fc975, // sage green
  c:       0xc49a6c, // tan
  starter: 0xa0a0a0, // light grey
};

/** Emissive color per tier (dim tint matching the pad color, helps readability at far fog) */
const TIER_EMISSIVE: Record<LandTier, number> = {
  founder: 0x4a3a00,
  a:       0x003a5c,
  b:       0x203c00,
  c:       0x3a2000,
  starter: 0x1a1a1a,
};

/** Tier order used for atlas row assignment (row 0 = first) */
const TIER_ROW_INDEX: Record<LandTier, number> = {
  founder: 0,
  a:       1,
  b:       2,
  c:       3,
  starter: 4,
};

/** Tier glyphs for sign atlas */
const TIER_GLYPHS: Record<LandTier, string> = {
  founder: '★',
  a:       'A',
  b:       'B',
  c:       'C',
  starter: 'S',
};

/** Tier accent hex strings for sign canvas rendering */
const TIER_HEX: Record<LandTier, string> = {
  founder: '#f5c842',
  a:       '#7ecef4',
  b:       '#9fc975',
  c:       '#c49a6c',
  starter: '#a0a0a0',
};

const TIERS_ORDER: LandTier[] = ['founder', 'a', 'b', 'c', 'starter'];

// ---------------------------------------------------------------------------
// Module-scope scratch objects (ZERO per-frame / per-build allocations)
// ---------------------------------------------------------------------------
const _m4 = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();

// ---------------------------------------------------------------------------
// Sign atlas texture (one per component mount, disposed on unmount)
// ---------------------------------------------------------------------------

/**
 * Build a 256×320 CanvasTexture.
 * 5 rows of 64px, one per tier.  Each row has:
 *   - tier-accent border top + bottom (6px)
 *   - glyph left side (36px column)
 *   - "FOR SALE" text right side
 */
function buildSignAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d')!;

  // Shared dark background for all rows
  ctx.fillStyle = '#0a1520';
  ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);

  for (const tier of TIERS_ORDER) {
    const row   = TIER_ROW_INDEX[tier];
    const y0    = row * ATLAS_ROW;
    const accentHex = TIER_HEX[tier];
    const glyph = TIER_GLYPHS[tier];

    // Row background slightly lighter than pure black
    ctx.fillStyle = '#0e1d2e';
    ctx.fillRect(0, y0, ATLAS_W, ATLAS_ROW);

    // Accent border — top 5px
    ctx.fillStyle = accentHex;
    ctx.fillRect(0, y0, ATLAS_W, 5);
    // Accent border — bottom 5px
    ctx.fillRect(0, y0 + ATLAS_ROW - 5, ATLAS_W, 5);
    // Accent border — left 5px (full row height)
    ctx.fillRect(0, y0 + 5, 5, ATLAS_ROW - 10);

    // Glyph column (left panel, 46px wide)
    ctx.fillStyle = accentHex;
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, 28, y0 + ATLAS_ROW * 0.5);

    // Vertical separator
    ctx.fillStyle = accentHex;
    ctx.fillRect(52, y0 + 8, 2, ATLAS_ROW - 16);

    // "FOR SALE" main text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 17px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('FOR SALE', 60, y0 + ATLAS_ROW * 0.44);

    // Tier label sub-text
    ctx.fillStyle = accentHex;
    ctx.font = '11px sans-serif';
    ctx.fillText(tier === 'founder' ? "FOUNDERS' ROW" :
                 tier === 'a'       ? 'A-TIER CREST'  :
                 tier === 'b'       ? 'B-TIER WARD'   :
                 tier === 'c'       ? 'C-TIER WARD'   :
                                     'STARTER COVE',
                 60, y0 + ATLAS_ROW * 0.72);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// UV helpers for atlas-mapped sign planks
// ---------------------------------------------------------------------------

/**
 * After applying a world-space transform to a PlaneGeometry (sign plank),
 * we need to remap the UVs from [0,1]×[0,1] to the correct tier row in the atlas.
 * Row `rowIdx` spans V in [rowIdx/5, (rowIdx+1)/5].
 */
function remapUVsToAtlasRow(geo: THREE.BufferGeometry, rowIndex: number): void {
  const uvAttr = geo.attributes.uv as THREE.BufferAttribute;
  if (!uvAttr) return;
  const vMin = rowIndex / 5;
  const vMax = (rowIndex + 1) / 5;
  for (let i = 0; i < uvAttr.count; i++) {
    const v = uvAttr.getY(i);
    // Remap original [0,1] V to [vMin, vMax]
    uvAttr.setY(i, vMin + v * (vMax - vMin));
  }
  uvAttr.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------

/**
 * Build the full visual for one parcel: ground pad + 4 corner posts + 4 top rails.
 * All geometry is baked into world-space coordinates and returned as a single
 * merged BufferGeometry ready to be merged with other same-tier parcels.
 */
function buildParcelBodyGeo(parcel: ParcelSlot): THREE.BufferGeometry {
  const halfSize = parcel.size * 0.5;
  const padHalf  = parcel.size * PAD_INSET * 0.5;

  const geos: THREE.BufferGeometry[] = [];

  // ----- Ground pad (PlaneGeometry, rotated flat) -----
  const padGeo = new THREE.PlaneGeometry(parcel.size * PAD_INSET, parcel.size * PAD_INSET, 1, 1);
  // PlaneGeometry faces +Z by default, rotate to face +Y (lie flat on floor)
  _m4.makeRotationX(-Math.PI * 0.5);
  _m4b.makeTranslation(parcel.cx, PAD_Y, parcel.cz);
  _m4b.multiply(_m4);
  padGeo.applyMatrix4(_m4b);
  geos.push(padGeo);

  // ----- 4 corner posts -----
  //  NW, NE, SE, SW corners (in parcel local space)
  const cornerOffsets: Array<[number, number]> = [
    [-padHalf, -padHalf],
    [ padHalf, -padHalf],
    [ padHalf,  padHalf],
    [-padHalf,  padHalf],
  ];
  for (const [dx, dz] of cornerOffsets) {
    const postGeo = new THREE.BoxGeometry(POST_W, POST_H, POST_W);
    _m4.makeTranslation(parcel.cx + dx, POST_Y, parcel.cz + dz);
    postGeo.applyMatrix4(_m4);
    geos.push(postGeo);
  }

  // ----- 4 top rails (connecting corners) -----
  // North rail: connects NW-NE (along X axis, at z = -padHalf)
  // South rail: connects SW-SE (along X axis, at z = +padHalf)
  // West rail:  connects NW-SW (along Z axis, at x = -padHalf)
  // East rail:  connects NE-SE (along Z axis, at x = +padHalf)
  const railSpan = padHalf * 2 - POST_W; // inner span between posts

  // North & South rails (along X)
  for (const rz of [-padHalf, padHalf]) {
    const railGeo = new THREE.BoxGeometry(railSpan, RAIL_H, RAIL_THICKNESS);
    _m4.makeTranslation(parcel.cx, RAIL_Y, parcel.cz + rz);
    railGeo.applyMatrix4(_m4);
    geos.push(railGeo);
  }

  // West & East rails (along Z)
  for (const rx of [-padHalf, padHalf]) {
    const railGeo = new THREE.BoxGeometry(RAIL_THICKNESS, RAIL_H, railSpan);
    _m4.makeTranslation(parcel.cx + rx, RAIL_Y, parcel.cz);
    railGeo.applyMatrix4(_m4);
    geos.push(railGeo);
  }

  const merged = mergeGeometries(geos, false)!;
  for (const g of geos) g.dispose();
  return merged;
}

/**
 * Build a sign post geometry baked into world space.
 */
function buildSignPostGeo(signX: number, signZ: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(SIGN_POST_W, SIGN_POST_H, SIGN_POST_W);
  _m4.makeTranslation(signX, SIGN_POST_Y, signZ);
  geo.applyMatrix4(_m4);
  return geo;
}

/**
 * Build a sign plank geometry baked into world space, with UVs remapped
 * to the correct tier row of the atlas.
 * The plank faces world origin (inward) via atan2(-cx,-cz).
 */
function buildSignPlankGeo(parcel: ParcelSlot, signX: number, signZ: number): THREE.BufferGeometry {
  // PlaneGeometry (single flat quad) for the sign face — sharp rendering, no depth.
  // Use a thin BoxGeometry to get a visible 3D plank.
  const geo = new THREE.BoxGeometry(PLANK_W, PLANK_H, PLANK_D);

  // Rotate to face world origin (inward)
  const angle = Math.atan2(-parcel.cx, -parcel.cz);
  _m4.makeRotationY(angle);
  _m4b.makeTranslation(signX, PLANK_Y, signZ);
  _m4b.multiply(_m4);
  geo.applyMatrix4(_m4b);

  // Remap UVs to the tier's atlas row
  // BoxGeometry face UVs: the front face (+Z before rotation) is the one we want.
  // All 6 faces get remapped — only the 2 large faces matter visually.
  remapUVsToAtlasRow(geo, TIER_ROW_INDEX[parcel.tier]);

  return geo;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LandParcels() {
  const groupRef = useRef<THREE.Group>(null);

  /**
   * Build all geometry and materials ONCE at mount (useMemo with empty dep array).
   * LAND_PARCELS is a frozen constant — recomputing on every re-render is wasteful.
   *
   * Result: 5 body meshes (pad+posts+rails per tier) + 1 post mesh + 1 plank mesh.
   * = 7 draw calls total.
   */
  const { bodyMeshes, signPostMesh, signPlankMesh, ownedMaterials } = useMemo(() => {

    // ---- Per-tier materials ----
    const tierMats = new Map<LandTier, THREE.MeshStandardMaterial>();
    for (const tier of TIERS_ORDER) {
      const color = TIER_COLORS[tier];
      tierMats.set(tier, new THREE.MeshStandardMaterial({
        color:             color,
        emissive:          new THREE.Color(TIER_EMISSIVE[tier]),
        emissiveIntensity: PAD_EMISSIVE_INTENSITY,
        roughness:         PAD_ROUGHNESS,
        metalness:         0.0,
        side:              THREE.FrontSide,
      }));
    }

    // ---- Body geometry — per tier ----
    const bodyGeosByTier = new Map<LandTier, THREE.BufferGeometry[]>();
    for (const tier of TIERS_ORDER) bodyGeosByTier.set(tier, []);

    for (const parcel of LAND_PARCELS) {
      bodyGeosByTier.get(parcel.tier)!.push(buildParcelBodyGeo(parcel));
    }

    const bodyMeshes: THREE.Mesh[] = [];
    for (const tier of TIERS_ORDER) {
      const geos = bodyGeosByTier.get(tier)!;
      if (geos.length === 0) continue;

      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;

      merged.computeBoundingBox();
      merged.computeBoundingSphere();

      const mat  = tierMats.get(tier)!;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name             = `land-body-${tier}`;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.frustumCulled    = true;
      bodyMeshes.push(mesh);
    }

    // ---- Sign post geometries — all tiers share one brown material ----
    const signPostMat = new THREE.MeshStandardMaterial({
      color:    0x6b4c1e,   // warm dark wood
      roughness: 0.92,
      metalness: 0.0,
    });

    const postGeos: THREE.BufferGeometry[] = [];
    const plankGeos: THREE.BufferGeometry[] = [];

    for (const parcel of LAND_PARCELS) {
      // Showroom lots get a FOR RENT sign (land-showroom.tsx) instead of FOR SALE.
      // Skip the FOR-SALE sign post+plank here so they don't stack visually.
      // The lot FRAME (pad + corner posts + top rails) is intentionally left intact —
      // the showroom building sits inside the frame, which still reads as a parcel border.
      if (SHOWROOM_PARCEL_IDS.has(parcel.id)) continue;

      // Position sign at the parcel face toward world origin
      const angle   = Math.atan2(-parcel.cx, -parcel.cz);
      const offset  = (parcel.size * 0.5) * SIGN_RADIAL_OFFSET;
      const signX   = parcel.cx + Math.sin(angle) * offset;
      const signZ   = parcel.cz + Math.cos(angle) * offset;

      postGeos.push(buildSignPostGeo(signX, signZ));
      plankGeos.push(buildSignPlankGeo(parcel, signX, signZ));
    }

    // Merged sign posts
    let signPostMesh: THREE.Mesh | null = null;
    const mergedPosts = mergeGeometries(postGeos, false);
    for (const g of postGeos) g.dispose();
    if (mergedPosts) {
      mergedPosts.computeBoundingBox();
      mergedPosts.computeBoundingSphere();
      signPostMesh              = new THREE.Mesh(mergedPosts, signPostMat);
      signPostMesh.name         = 'land-sign-posts';
      signPostMesh.matrixAutoUpdate = false;
      signPostMesh.updateMatrix();
      signPostMesh.frustumCulled = true;
    }

    // Merged sign planks — shared atlas texture
    const atlasTex    = buildSignAtlas();
    const signPlankMat = new THREE.MeshBasicMaterial({
      map:  atlasTex,
      side: THREE.DoubleSide, // visible from both sides when orbiting
    });

    let signPlankMesh: THREE.Mesh | null = null;
    const mergedPlanks = mergeGeometries(plankGeos, false);
    for (const g of plankGeos) g.dispose();
    if (mergedPlanks) {
      mergedPlanks.computeBoundingBox();
      mergedPlanks.computeBoundingSphere();
      signPlankMesh              = new THREE.Mesh(mergedPlanks, signPlankMat);
      signPlankMesh.name         = 'land-sign-planks';
      signPlankMesh.matrixAutoUpdate = false;
      signPlankMesh.updateMatrix();
      signPlankMesh.frustumCulled = true;
    }

    // Collect all owned materials for dispose on unmount
    const ownedMaterials: THREE.Material[] = [
      ...Array.from(tierMats.values()),
      signPostMat,
      signPlankMat,
    ];

    return { bodyMeshes, signPostMesh, signPlankMesh, ownedMaterials };
  }, []); // LAND_PARCELS is a frozen constant — only run once

  // Attach meshes to the R3F group imperatively
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    for (const m of bodyMeshes) group.add(m);
    if (signPostMesh)  group.add(signPostMesh);
    if (signPlankMesh) group.add(signPlankMesh);

    return () => {
      // ---- Teardown: dispose every owned resource ----
      for (const m of bodyMeshes) {
        m.geometry.dispose();
        group.remove(m);
      }
      if (signPostMesh) {
        signPostMesh.geometry.dispose();
        group.remove(signPostMesh);
      }
      if (signPlankMesh) {
        signPlankMesh.geometry.dispose();
        group.remove(signPlankMesh);
      }
      for (const mat of ownedMaterials) {
        // Dispose any texture maps owned by this material
        if ('map' in mat && (mat as THREE.MeshBasicMaterial).map) {
          (mat as THREE.MeshBasicMaterial).map!.dispose();
        }
        mat.dispose();
      }
    };
  }, [bodyMeshes, signPostMesh, signPlankMesh, ownedMaterials]);

  return <group ref={groupRef} name="land-parcels" />;
}
