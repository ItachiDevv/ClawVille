'use client';

/**
 * land-parcels.tsx — 3-category FOR-SALE sign system on ALL 180 land plots.
 *
 * Visual scheme (2026-06-18 rework):
 *   • Tier-colored GROUND PAD  — flat PlaneGeometry slightly above sand, low roughness,
 *     slight emissive tint.  Merged per tier.  UNCHANGED from previous version.
 *   • Corner posts + top rail  — 4 BoxGeometry corner posts + 4 BoxGeometry top rails
 *     per parcel, tier-colored, merged together WITH the pad into one mesh per tier.
 *     UNCHANGED from previous version.
 *   • FOR-SALE sign system     — REPLACED. Three sign categories (regular / premium /
 *     premium-partner) each with a dedicated CanvasTexture, size config, and merged
 *     mesh.  Signs now render on ALL 180 plots (showroom lots included — the showroom
 *     layer's sign was removed from land-showroom.tsx, so there is no visual conflict).
 *
 * Sign categories (getLandSignCategory from land-signage.ts):
 *   regular        — basic sign.  Plank 68×28wu, post h=52.  Single-line "FOR SALE".
 *   premium        — ~1.35× bigger.  Plank 92×38wu, post h=64.  Gold double-border,
 *                    "FOR SALE" + "PREMIUM" subtitle.  Founder + A tiers.
 *   premium-partner — ~1.7× bigger.  Plank 116×48wu, post h=76.  Cyan/platinum ornate
 *                    border+topper, "FOR SALE" + "PARTNER" subtitle.  Curated subset of
 *                    premium plots (see land-signage.ts PREMIUM_PARTNER_PARCEL_IDS).
 *
 * Draw calls: 5 (pad+border per tier) + 3 (plank per category) + 3 (post per category) = 11.
 * (Was 7.  New +4 from splitting 1 post+1 plank into 3 post+3 plank.)
 *
 * Iris Xe / WebGPU constraints:
 *   - NO drei Text / Billboard (hard crash on Iris Xe)
 *   - NO InstancedMesh + ShaderMaterial (silent WebGPU crash)
 *   - NO per-frame new Vector3() / Matrix4() — all scratch mats are module-scope
 *   - Sign text baked into CanvasTextures (one per category), no text geo
 *   - All geometry uses MeshStandardMaterial or MeshBasicMaterial — NO ShaderMaterial
 *
 * Culling: each merged mesh has matrixAutoUpdate=false + tight computeBoundingBox/Sphere.
 * Cleanup: all geometries, materials, and canvas textures are disposed on unmount.
 */

import { useMemo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAND_PARCELS } from '@clawville/shared';
import { getLandSignCategory } from '@clawville/shared';
import type { ParcelSlot } from '@clawville/shared';
import type { LandTier } from '@clawville/shared';
import type { LandSignCategory } from '@clawville/shared';

// ---------------------------------------------------------------------------
// Constants — body frame (UNCHANGED)
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

// ---------------------------------------------------------------------------
// Constants — sign system (NEW 3-category)
// ---------------------------------------------------------------------------

/**
 * Size config per sign category.
 * Post: warm-brown BoxGeometry.  Plank: CanvasTexture BoxGeometry.
 * All dimensions in wu.
 */
interface SignSizeConfig {
  plankW: number;
  plankH: number;
  plankD: number;
  postW:  number;
  postH:  number;
}

// Scaled ~4.3× (2026-06-18) for the big-plot 2-ring layout — plots are now
// ~1088-1216wu and buildings ~530-940wu, so the old ~70-116wu signs read as
// specks. These post-heights (220-320wu) put a readable plank at ~1/3-1/2 a
// building's height, on par with the structures.
const SIGN_SIZES: Record<LandSignCategory, SignSizeConfig> = {
  'regular':         { plankW: 290, plankH: 120, plankD: 9,  postW: 16, postH: 220 },
  'premium':         { plankW: 380, plankH: 158, plankD: 11, postW: 20, postH: 270 },
  'premium-partner': { plankW: 480, plankH: 200, plankD: 13, postW: 24, postH: 320 },
};

/** Sign radial offset: place sign near the parcel's town-facing front edge, in
 *  FRONT of any building (which sits at the plot center). 0.82 → ~0.41×size from
 *  center (the front edge is at 0.5×size), so a big sign clears a big building. */
const SIGN_RADIAL_OFFSET = 0.82; // fraction of parcel half-size

// ---------------------------------------------------------------------------
// Tier visual scheme (UNCHANGED)
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

const TIERS_ORDER: LandTier[] = ['founder', 'a', 'b', 'c', 'starter'];

// ---------------------------------------------------------------------------
// Module-scope scratch objects (ZERO per-frame / per-build allocations)
// ---------------------------------------------------------------------------

const _m4  = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();

// ---------------------------------------------------------------------------
// Sign CanvasTexture builders (one per category)
// ---------------------------------------------------------------------------

/**
 * Build a CanvasTexture for the 'regular' sign.
 * 256×64 canvas.  Dark background, thin tan/grey border, "FOR SALE" centered in white.
 */
function buildRegularSignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = '#0a1520';
  ctx.fillRect(0, 0, 256, 64);

  // Thin single border (tan/grey tone)
  ctx.strokeStyle = '#c9b48a';
  ctx.lineWidth = 3;
  ctx.strokeRect(3, 3, 250, 58);

  // "FOR SALE" centered
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('FOR SALE', 128, 32);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build a CanvasTexture for the 'premium' sign.
 * 256×64 canvas.  Gold double border with corner accent ticks.
 * "FOR SALE" (white) + "PREMIUM" gold subtitle.
 */
function buildPremiumSignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const GOLD = '#ffd54a';

  // Background
  ctx.fillStyle = '#0a1520';
  ctx.fillRect(0, 0, 256, 64);

  // Outer border
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, 252, 60);

  // Inner border (inset by 5px)
  ctx.lineWidth = 1.5;
  ctx.strokeRect(7, 7, 242, 50);

  // Corner accent ticks (small filled squares at outer corners)
  const TICK = 5;
  ctx.fillStyle = GOLD;
  [[2, 2], [251 - TICK, 2], [2, 57 - TICK], [251 - TICK, 57 - TICK]].forEach(([x, y]) => {
    ctx.fillRect(x, y, TICK, TICK);
  });

  // "FOR SALE" (white, upper half)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 19px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('FOR SALE', 128, 34);

  // "PREMIUM" subtitle (gold, lower)
  ctx.fillStyle = GOLD;
  ctx.font = 'bold 12px monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('PREMIUM', 128, 52);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build a CanvasTexture for the 'premium-partner' sign.
 * 256×80 canvas (extra height for the filled topper bar).
 * Cyan/platinum ornate double border, filled topper bar, "FOR SALE" + "PARTNER" subtitle.
 */
function buildPremiumPartnerSignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = 256;
  canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  const CYAN = '#9fe9ff';

  // Background
  ctx.fillStyle = '#0a1520';
  ctx.fillRect(0, 0, 256, 80);

  // Filled topper bar across the full top (10px)
  ctx.fillStyle = CYAN;
  ctx.fillRect(0, 0, 256, 10);

  // Thick outer border below topper
  ctx.strokeStyle = CYAN;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 12, 252, 66);

  // Inner border (inset)
  ctx.lineWidth = 1.5;
  ctx.strokeRect(8, 18, 240, 54);

  // Corner accents (outer corners of inner border, filled squares)
  const TICK = 6;
  ctx.fillStyle = CYAN;
  [[8, 18], [242 - TICK, 18], [8, 66 - TICK], [242 - TICK, 66 - TICK]].forEach(([x, y]) => {
    ctx.fillRect(x, y, TICK, TICK);
  });

  // Small decorative dots between corner accents along horizontal edges
  const dotY1 = 20;
  const dotY2 = 77;
  for (let dotX = 40; dotX < 220; dotX += 28) {
    ctx.beginPath();
    ctx.arc(dotX, dotY1, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let dotX = 40; dotX < 220; dotX += 28) {
    ctx.beginPath();
    ctx.arc(dotX, dotY2, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // "FOR SALE" (white)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('FOR SALE', 128, 47);

  // "PARTNER" subtitle (cyan)
  ctx.fillStyle = CYAN;
  ctx.font = 'bold 13px monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('PARTNER', 128, 65);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Geometry builders (UNCHANGED for body; new per-category for signs)
// ---------------------------------------------------------------------------

/**
 * Build the full visual for one parcel: ground pad + 4 corner posts + 4 top rails.
 * All geometry is baked into world-space coordinates and returned as a single
 * merged BufferGeometry ready to be merged with other same-tier parcels.
 * UNCHANGED from previous implementation.
 */
function buildParcelBodyGeo(parcel: ParcelSlot): THREE.BufferGeometry {
  const padHalf = parcel.size * PAD_INSET * 0.5;

  const geos: THREE.BufferGeometry[] = [];

  // ----- Ground pad (PlaneGeometry, rotated flat) -----
  const padGeo = new THREE.PlaneGeometry(parcel.size * PAD_INSET, parcel.size * PAD_INSET, 1, 1);
  _m4.makeRotationX(-Math.PI * 0.5);
  _m4b.makeTranslation(parcel.cx, PAD_Y, parcel.cz);
  _m4b.multiply(_m4);
  padGeo.applyMatrix4(_m4b);
  geos.push(padGeo);

  // ----- 4 corner posts -----
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
 * Compute the sign position for a parcel (shared by post + plank builders).
 * Sign is offset toward world origin along the parcel-to-origin radial direction.
 */
function signPosition(parcel: ParcelSlot): { signX: number; signZ: number; angle: number } {
  const angle  = Math.atan2(-parcel.cx, -parcel.cz);
  const offset = (parcel.size * 0.5) * SIGN_RADIAL_OFFSET;
  return {
    signX: parcel.cx + Math.sin(angle) * offset,
    signZ: parcel.cz + Math.cos(angle) * offset,
    angle,
  };
}

/**
 * Build a sign post geometry baked into world space for a given category.
 */
function buildSignPostGeo(
  signX: number,
  signZ: number,
  cfg: SignSizeConfig,
): THREE.BufferGeometry {
  const postY = FLOOR_Y + cfg.postH * 0.5;
  const geo = new THREE.BoxGeometry(cfg.postW, cfg.postH, cfg.postW);
  _m4.makeTranslation(signX, postY, signZ);
  geo.applyMatrix4(_m4);
  return geo;
}

/**
 * Build a sign plank geometry baked into world space for a given category.
 * The plank uses default BoxGeometry UVs [0,1] — each category has its own
 * single-cell texture so NO atlas UV remapping is needed.
 * The plank is rotated to face world origin (inward).
 */
function buildSignPlankGeo(
  parcel: ParcelSlot,
  signX: number,
  signZ: number,
  angle: number,
  cfg: SignSizeConfig,
): THREE.BufferGeometry {
  const plankY = FLOOR_Y + cfg.postH - cfg.plankH * 0.6;
  const geo = new THREE.BoxGeometry(cfg.plankW, cfg.plankH, cfg.plankD);
  _m4.makeRotationY(angle);
  _m4b.makeTranslation(signX, plankY, signZ);
  _m4b.multiply(_m4);
  geo.applyMatrix4(_m4b);
  // Default BoxGeometry UVs cover [0,1]×[0,1] — correct for a single-cell texture.
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
   * Result:
   *   5 body meshes  (pad+posts+rails per tier)
   *   3 post meshes  (one per sign category — warm brown MeshStandardMaterial)
   *   3 plank meshes (one per sign category — CanvasTexture MeshBasicMaterial)
   * = 11 draw calls total.
   */
  const { bodyMeshes, signMeshes, ownedMaterials } = useMemo(() => {

    // ── Per-tier body materials ──────────────────────────────────────────────
    const tierMats = new Map<LandTier, THREE.MeshStandardMaterial>();
    for (const tier of TIERS_ORDER) {
      tierMats.set(tier, new THREE.MeshStandardMaterial({
        color:             TIER_COLORS[tier],
        emissive:          new THREE.Color(TIER_EMISSIVE[tier]),
        emissiveIntensity: PAD_EMISSIVE_INTENSITY,
        roughness:         PAD_ROUGHNESS,
        metalness:         0.0,
        side:              THREE.FrontSide,
      }));
    }

    // ── Body geometry — per tier ─────────────────────────────────────────────
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

    // ── Sign materials — one post mat (shared warm brown) + one plank mat per category ──

    // Shared post material — all categories use the same warm-brown wood color.
    const signPostMat = new THREE.MeshStandardMaterial({
      color:     0x6b4c1e,
      roughness: 0.92,
      metalness: 0.0,
    });

    const regularTex        = buildRegularSignTexture();
    const premiumTex        = buildPremiumSignTexture();
    const premiumPartnerTex = buildPremiumPartnerSignTexture();

    const signPlankMats: Record<LandSignCategory, THREE.MeshBasicMaterial> = {
      'regular':         new THREE.MeshBasicMaterial({ map: regularTex,        side: THREE.DoubleSide }),
      'premium':         new THREE.MeshBasicMaterial({ map: premiumTex,        side: THREE.DoubleSide }),
      'premium-partner': new THREE.MeshBasicMaterial({ map: premiumPartnerTex, side: THREE.DoubleSide }),
    };

    // ── Sign geometry — collect per category, then merge ────────────────────
    const SIGN_CATEGORIES: LandSignCategory[] = ['regular', 'premium', 'premium-partner'];

    const postGeosByCategory  = new Map<LandSignCategory, THREE.BufferGeometry[]>();
    const plankGeosByCategory = new Map<LandSignCategory, THREE.BufferGeometry[]>();
    for (const cat of SIGN_CATEGORIES) {
      postGeosByCategory.set(cat, []);
      plankGeosByCategory.set(cat, []);
    }

    // Signs render on ALL 180 plots (showroom lots included — land-showroom.tsx
    // no longer renders its own sign, so there is zero visual conflict).
    for (const parcel of LAND_PARCELS) {
      const cat  = getLandSignCategory(parcel);
      const cfg  = SIGN_SIZES[cat];
      const { signX, signZ, angle } = signPosition(parcel);

      postGeosByCategory.get(cat)!.push(buildSignPostGeo(signX, signZ, cfg));
      plankGeosByCategory.get(cat)!.push(buildSignPlankGeo(parcel, signX, signZ, angle, cfg));
    }

    // Merge and create meshes for each category
    const signMeshes: THREE.Mesh[] = [];

    for (const cat of SIGN_CATEGORIES) {
      // --- Post mesh ---
      const postGeos = postGeosByCategory.get(cat)!;
      const mergedPosts = mergeGeometries(postGeos, false);
      for (const g of postGeos) g.dispose();
      if (mergedPosts) {
        mergedPosts.computeBoundingBox();
        mergedPosts.computeBoundingSphere();
        const postMesh              = new THREE.Mesh(mergedPosts, signPostMat);
        postMesh.name               = `land-sign-post-${cat}`;
        postMesh.matrixAutoUpdate   = false;
        postMesh.updateMatrix();
        postMesh.frustumCulled      = true;
        signMeshes.push(postMesh);
      }

      // --- Plank mesh ---
      const plankGeos = plankGeosByCategory.get(cat)!;
      const mergedPlanks = mergeGeometries(plankGeos, false);
      for (const g of plankGeos) g.dispose();
      if (mergedPlanks) {
        mergedPlanks.computeBoundingBox();
        mergedPlanks.computeBoundingSphere();
        const plankMesh              = new THREE.Mesh(mergedPlanks, signPlankMats[cat]);
        plankMesh.name               = `land-sign-plank-${cat}`;
        plankMesh.matrixAutoUpdate   = false;
        plankMesh.updateMatrix();
        plankMesh.frustumCulled      = true;
        signMeshes.push(plankMesh);
      }
    }

    // Collect all owned materials for dispose on unmount.
    // Textures are owned by the MeshBasicMaterial maps — dispose via material.
    const ownedMaterials: THREE.Material[] = [
      ...Array.from(tierMats.values()),
      signPostMat,
      ...Object.values(signPlankMats),
    ];

    return { bodyMeshes, signMeshes, ownedMaterials };
  }, []); // LAND_PARCELS + LAND_SIGNAGE are frozen constants — only run once

  // Attach meshes to the R3F group imperatively
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    for (const m of bodyMeshes) group.add(m);
    for (const m of signMeshes)  group.add(m);

    return () => {
      // ── Teardown: dispose every owned resource ───────────────────────────
      for (const m of bodyMeshes) {
        m.geometry.dispose();
        group.remove(m);
      }
      for (const m of signMeshes) {
        m.geometry.dispose();
        group.remove(m);
      }
      for (const mat of ownedMaterials) {
        // Dispose any texture map owned by this material (CanvasTextures).
        if ('map' in mat && (mat as THREE.MeshBasicMaterial).map) {
          (mat as THREE.MeshBasicMaterial).map!.dispose();
        }
        mat.dispose();
      }
    };
  }, [bodyMeshes, signMeshes, ownedMaterials]);

  return <group ref={groupRef} name="land-parcels" />;
}
