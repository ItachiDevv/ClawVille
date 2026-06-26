'use client';

/**
 * land-parcels.tsx — 3-category FOR-SALE sign system on AVAILABLE land plots only.
 *
 * Visual scheme (2026-06-22 reactivity rework):
 *   • Tier-colored GROUND PAD  — flat PlaneGeometry slightly above sand, low roughness,
 *     slight emissive tint.  Merged per tier.  STATIC (always visible on all 180 plots).
 *   • Corner posts + top rail  — 4 BoxGeometry corner posts + 4 BoxGeometry top rails
 *     per parcel, tier-colored, merged together WITH the pad into one mesh per tier.
 *     STATIC (always visible — decorative frame).
 *   • FOR-SALE sign system     — Three sign categories (regular / premium /
 *     premium-partner) each with a dedicated CanvasTexture, size config, and merged
 *     mesh.  Signs render ONLY on parcels whose status === 'available' in useLandStore.
 *     Sign meshes REBUILD when the available-parcel set changes (dispose old geo,
 *     build new merged geo from current available set, identity-guard on change).
 *
 * Click bridge (2026-06-22):
 *   LandParcelSignHitboxes (exported from this module) renders invisible JSX meshes at
 *   each available sign position. R3F onClick → openLandOffice(parcelCode). Mobile tap
 *   works via R3F's pointer-event handling. Zero extra draw calls (invisible meshes are
 *   not rendered by the GPU — Three.js skips .visible=false objects in the render pass).
 *
 * Sign categories (getLandSignCategory from land-signage.ts):
 *   regular        — clean-slate sign.  Plank 290×120wu.  Slate ground, beveled inset
 *                    frame, bold "FOR SALE" + "LAND PARCEL" subtitle.  Texture 1024×424.
 *   premium        — ~1.35× bigger.  Plank 380×158wu.  Gold double-border + corner studs,
 *                    "FOR SALE" + "PREMIUM" subtitle.  Founder + A tiers.  Texture 1024×426.
 *   premium-partner — ~1.7× bigger.  Plank 480×200wu.  Cyan/platinum ornate border + topper
 *                    band, "FOR SALE" + "PARTNER" subtitle.  Curated subset of premium plots
 *                    (see land-signage.ts PREMIUM_PARTNER_PARCEL_IDS).  Texture 1024×426.
 *
 * Sign textures (2026-06-26 polish): each canvas matches its plank's W:H aspect
 * (no horizontal squish) at ~1024px on the long edge (was 256×64 ≈ 0.5px/wu and
 * 4:1 → squished), characterful display fonts (Arial Black/Impact + Georgia, no
 * external load), anisotropy=8 + mipmaps + sRGB.  Only 3 sign textures total
 * (one per CATEGORY, shared across all parcels) so ~1024px each is cheap VRAM.
 *
 * Sign post (2026-06-26 fix): the post now rises from the floor and STOPS at the
 * plank's bottom edge (+ a small mount overlap), so it never crosses the plank's
 * CENTERED text.  postH' = cfg.postH - 0.98*cfg.plankH (see buildSignPostGeo).
 *
 * Draw calls: 5 (pad+border per tier) + up to 3 (plank per category) + up to 3 (post per
 * category) = up to 11 when all 180 parcels are available. Drops as parcels are bought.
 *
 * Iris Xe / WebGPU constraints:
 *   - NO drei Text / Billboard (hard crash on Iris Xe)
 *   - NO InstancedMesh + ShaderMaterial (silent WebGPU crash)
 *   - NO per-frame new Vector3() / Matrix4() — all scratch mats are module-scope
 *   - Sign text baked into CanvasTextures (one per category), no text geo
 *   - All geometry uses MeshStandardMaterial or MeshBasicMaterial — NO ShaderMaterial
 *
 * Culling: each merged mesh has matrixAutoUpdate=false + tight computeBoundingBox/Sphere.
 * Cleanup: all geometries, materials, and canvas textures are disposed on unmount +
 *          on every sign-set rebuild (old sign geo disposed before new geo is created).
 */

import { useMemo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAND_PARCELS } from '@clawville/shared';
import { getLandSignCategory } from '@clawville/shared';
import type { ParcelSlot } from '@clawville/shared';
import type { LandTier } from '@clawville/shared';
import type { LandSignCategory } from '@clawville/shared';
import { useLandStore, getParcelStatus } from '@/stores/land';
import { useGameStore } from '@/stores/game';

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
// Constants — sign system (3-category)
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

/** Hitbox half-sizes per category for invisible click targets (generous for tap). */
const HITBOX_HALF: Record<LandSignCategory, { hw: number; hh: number; hd: number }> = {
  'regular':         { hw: 180, hh: 130, hd: 40 },
  'premium':         { hw: 230, hh: 170, hd: 50 },
  'premium-partner': { hw: 280, hh: 215, hd: 60 },
};

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
// Sign CanvasTexture builders (one per category) — called ONCE at module init
// ---------------------------------------------------------------------------

/**
 * Texture resolution + aspect — each canvas now MATCHES its plank's W:H aspect
 * so the baked art is never horizontally squished, and is ~1024px on the long
 * edge so the lettering is crisp at plot scale (vs the old 256×64 ≈ 0.5px/wu).
 *
 *   regular         plank 290×120 (2.417:1) → 1024×424
 *   premium         plank 380×158 (2.405:1) → 1024×426
 *   premium-partner plank 480×200 (2.400:1) → 1024×426
 */
const REG_W = 1024, REG_H = 424;
const PREM_W = 1024, PREM_H = 426;
const PART_W = 1024, PART_H = 426;

/** Finish every sign texture identically: sRGB, anisotropy, mipmaps for distance. */
function finishSignTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace   = THREE.SRGBColorSpace;
  tex.anisotropy   = 8;        // crisp at grazing angles / distance
  tex.generateMipmaps = true;  // (default) smooth minification far away
  tex.needsUpdate  = true;
  return tex;
}

/**
 * Build a CanvasTexture for the 'regular' sign — clean slate plank.
 * Charcoal-slate ground, beveled inset frame, big bold "FOR SALE" headline
 * over a smaller tan "LAND PARCEL" subtitle (proper hierarchy).
 */
function buildRegularSignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = REG_W;
  canvas.height = REG_H;
  const ctx = canvas.getContext('2d')!;
  const TAN = '#d8c39a';

  // Slate ground (subtle vertical gradient for depth)
  const bg = ctx.createLinearGradient(0, 0, 0, REG_H);
  bg.addColorStop(0, '#16222e');
  bg.addColorStop(1, '#0a1219');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, REG_W, REG_H);

  // Beveled inset frame: dark drop edge under a light tan stroke (carved look)
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 18;
  ctx.strokeRect(30, 30, REG_W - 60, REG_H - 60);
  ctx.strokeStyle = TAN;
  ctx.lineWidth = 8;
  ctx.strokeRect(26, 26, REG_W - 52, REG_H - 52);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Headline — bold condensed display face (canvas-safe, no external load)
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 188px "Arial Black", Impact, sans-serif';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;
  ctx.fillText('FOR SALE', REG_W / 2, REG_H * 0.42);
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Subtitle — smaller, letter-spaced via wider tracking text
  ctx.fillStyle = TAN;
  ctx.font = 'bold 62px "Trebuchet MS", sans-serif';
  ctx.fillText('L A N D   P A R C E L', REG_W / 2, REG_H * 0.78);

  return finishSignTexture(canvas);
}

/**
 * Build a CanvasTexture for the 'premium' sign — gold double border + "PREMIUM".
 * Founder + a-tier lots. Gold serif headline edge, gold double frame with corner
 * studs, white "FOR SALE" headline over a gold "PREMIUM" subtitle.
 */
function buildPremiumSignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = PREM_W;
  canvas.height = PREM_H;
  const ctx = canvas.getContext('2d')!;
  const GOLD  = '#ffd24a';
  const GOLD2 = '#9c6b12';

  // Rich navy ground
  const bg = ctx.createLinearGradient(0, 0, 0, PREM_H);
  bg.addColorStop(0, '#142133');
  bg.addColorStop(1, '#080d18');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, PREM_W, PREM_H);

  // Gold double frame
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 12;
  ctx.strokeRect(24, 24, PREM_W - 48, PREM_H - 48);
  ctx.strokeStyle = GOLD2;
  ctx.lineWidth = 4;
  ctx.strokeRect(46, 46, PREM_W - 92, PREM_H - 92);

  // Corner studs (filled gold squares on the outer frame)
  const STUD = 26;
  ctx.fillStyle = GOLD;
  ([[24, 24], [PREM_W - 24 - STUD, 24], [24, PREM_H - 24 - STUD], [PREM_W - 24 - STUD, PREM_H - 24 - STUD]] as Array<[number, number]>)
    .forEach(([x, y]) => ctx.fillRect(x, y, STUD, STUD));

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Headline (white) — bold display, gold drop for richness
  ctx.fillStyle = '#fff7e0';
  ctx.font = '800 170px "Arial Black", Impact, sans-serif';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;
  ctx.fillText('FOR SALE', PREM_W / 2, PREM_H * 0.40);
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Subtitle (gold) — smaller serif, tracked
  ctx.fillStyle = GOLD;
  ctx.font = 'bold 74px Georgia, serif';
  ctx.fillText('P R E M I U M', PREM_W / 2, PREM_H * 0.76);

  return finishSignTexture(canvas);
}

/**
 * Build a CanvasTexture for the 'premium-partner' sign — cyan/platinum ornate.
 * Curated partner lots. Filled cyan topper band, platinum/cyan double frame with
 * corner studs + edge dots, white "FOR SALE" headline over a cyan "PARTNER" subtitle.
 */
function buildPremiumPartnerSignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = PART_W;
  canvas.height = PART_H;
  const ctx = canvas.getContext('2d')!;
  const CYAN = '#7fe6ff';
  const PLAT = '#cfe7ef';

  // Deep teal-navy ground
  const bg = ctx.createLinearGradient(0, 0, 0, PART_H);
  bg.addColorStop(0, '#0d2733');
  bg.addColorStop(1, '#06121a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, PART_W, PART_H);

  // Filled cyan topper band across the top
  ctx.fillStyle = CYAN;
  ctx.fillRect(0, 0, PART_W, 44);

  // Platinum + cyan double frame (below the band)
  ctx.strokeStyle = CYAN;
  ctx.lineWidth = 14;
  ctx.strokeRect(24, 60, PART_W - 48, PART_H - 84);
  ctx.strokeStyle = PLAT;
  ctx.lineWidth = 4;
  ctx.strokeRect(46, 82, PART_W - 92, PART_H - 128);

  // Corner studs on the inner frame
  const STUD = 24;
  ctx.fillStyle = CYAN;
  ([[46, 82], [PART_W - 46 - STUD, 82], [46, PART_H - 46 - STUD], [PART_W - 46 - STUD, PART_H - 46 - STUD]] as Array<[number, number]>)
    .forEach(([x, y]) => ctx.fillRect(x, y, STUD, STUD));

  // Decorative dots along the topper band
  ctx.fillStyle = '#06121a';
  for (let dotX = 80; dotX < PART_W - 60; dotX += 88) {
    ctx.beginPath();
    ctx.arc(dotX, 22, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Headline (white) — bold display
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 162px "Arial Black", Impact, sans-serif';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;
  ctx.fillText('FOR SALE', PART_W / 2, PART_H * 0.46);
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Subtitle (cyan) — tracked serif
  ctx.fillStyle = CYAN;
  ctx.font = 'bold 78px Georgia, serif';
  ctx.fillText('P A R T N E R', PART_W / 2, PART_H * 0.80);

  return finishSignTexture(canvas);
}

// ---------------------------------------------------------------------------
// Geometry builders (UNCHANGED for body; per-category for signs)
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
 * Compute the sign position for a parcel (shared by post + plank builders and hitbox).
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
 *
 * The post rises from the floor and STOPS at the bottom edge of the plank
 * (with a tiny mount overlap), so it never crosses the plank's CENTERED text.
 *
 *   plankY      = FLOOR_Y + cfg.postH - cfg.plankH*0.6   (text center, unchanged)
 *   plankBottom = plankY - cfg.plankH*0.5 = FLOOR_Y + cfg.postH - 1.1*cfg.plankH
 *   postTop     = plankBottom + 0.12*cfg.plankH (small overlap to mount the sign)
 *             ⇒ postH' = cfg.postH - 0.98*cfg.plankH
 *
 * Per-category clearance (post top vs text center, FLOOR_Y=-2):
 *   regular         postH'≈102.4  top≈100.4  textY=146    → 45.6wu clear
 *   premium         postH'≈115.2  top≈113.2  textY≈173.2  → 60.0wu clear
 *   premium-partner postH'=124    top=122    textY=198    → 76.0wu clear
 */
function buildSignPostGeo(
  signX: number,
  signZ: number,
  cfg: SignSizeConfig,
): THREE.BufferGeometry {
  // Post rises from the floor to the plank bottom + a small mount overlap.
  const postH = cfg.postH - cfg.plankH * 0.98;
  const postY = FLOOR_Y + postH * 0.5;
  const geo = new THREE.BoxGeometry(cfg.postW, postH, cfg.postW);
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
// Static materials — created ONCE per module lifetime, shared across rebuilds.
// Textures and materials are disposed on component UNMOUNT, not on rebuild.
// ---------------------------------------------------------------------------

interface StaticSignMaterials {
  signPostMat:    THREE.MeshStandardMaterial;
  signPlankMats:  Record<LandSignCategory, THREE.MeshBasicMaterial>;
  textures:       THREE.CanvasTexture[];
}

function buildStaticSignMaterials(): StaticSignMaterials {
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

  return {
    signPostMat,
    signPlankMats,
    textures: [regularTex, premiumTex, premiumPartnerTex],
  };
}

// ---------------------------------------------------------------------------
// Sign mesh builder — builds merged sign meshes for a subset of available parcels
// ---------------------------------------------------------------------------

const SIGN_CATEGORIES: LandSignCategory[] = ['regular', 'premium', 'premium-partner'];

/**
 * Build the 6 sign meshes (3 post + 3 plank) for a given set of available parcels.
 * Returns the meshes and a dispose function for their geometries only (materials
 * are shared statics; textures owned by the caller's StaticSignMaterials).
 */
function buildSignMeshes(
  availableParcels: ParcelSlot[],
  signPostMat: THREE.MeshStandardMaterial,
  signPlankMats: Record<LandSignCategory, THREE.MeshBasicMaterial>,
): THREE.Mesh[] {
  if (availableParcels.length === 0) return [];

  const postGeosByCategory  = new Map<LandSignCategory, THREE.BufferGeometry[]>();
  const plankGeosByCategory = new Map<LandSignCategory, THREE.BufferGeometry[]>();
  for (const cat of SIGN_CATEGORIES) {
    postGeosByCategory.set(cat, []);
    plankGeosByCategory.set(cat, []);
  }

  for (const parcel of availableParcels) {
    const cat  = getLandSignCategory(parcel);
    const cfg  = SIGN_SIZES[cat];
    const { signX, signZ, angle } = signPosition(parcel);

    postGeosByCategory.get(cat)!.push(buildSignPostGeo(signX, signZ, cfg));
    plankGeosByCategory.get(cat)!.push(buildSignPlankGeo(parcel, signX, signZ, angle, cfg));
  }

  const signMeshes: THREE.Mesh[] = [];

  for (const cat of SIGN_CATEGORIES) {
    // --- Post mesh ---
    const postGeos = postGeosByCategory.get(cat)!;
    if (postGeos.length > 0) {
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
    } else {
      for (const g of postGeos) g.dispose();
    }

    // --- Plank mesh ---
    const plankGeos = plankGeosByCategory.get(cat)!;
    if (plankGeos.length > 0) {
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
    } else {
      for (const g of plankGeos) g.dispose();
    }
  }

  return signMeshes;
}

// ---------------------------------------------------------------------------
// Derive a stable identity key for the available set (for change detection)
// ---------------------------------------------------------------------------

/**
 * Build a string key representing the current available-parcel set.
 * We use a sorted join of parcelIds. This runs at most once per store
 * change (not per frame) and the parcel count is ≤180, so it's cheap.
 */
function availableSetKey(parcels: Map<string, { status: string }>): string {
  const available: string[] = [];
  for (const p of LAND_PARCELS) {
    const status = parcels.get(p.id)?.status ?? 'available';
    if (status === 'available') available.push(p.id);
  }
  // Sorted for determinism (Map iteration order is insertion-order but
  // store updates could re-insert in any order after setParcels).
  available.sort();
  return available.join(',');
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LandParcels() {
  const groupRef = useRef<THREE.Group>(null);

  // ── Static body meshes (pads + posts + rails per tier) — built ONCE ──────
  const { bodyMeshes, bodyMaterials } = useMemo(() => {
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

    return { bodyMeshes, bodyMaterials: [...tierMats.values()] };
  }, []); // LAND_PARCELS is frozen — body never changes

  // ── Static sign materials — built ONCE, reused across every sign rebuild ──
  const staticSignMats = useMemo(() => buildStaticSignMaterials(), []);

  // ── Reactive sign meshes — subscribe to parcels store ─────────────────────
  // useLandStore returns the Map reference. A new Map identity on every
  // setParcels() call triggers this hook. We derive the available set and
  // identity-guard so rebuild only fires when WHICH parcels are available
  // actually changes.
  const parcels = useLandStore((s) => s.parcels);

  // Ref to hold current sign meshes + the last key we built them from.
  const signMeshesRef = useRef<THREE.Mesh[]>([]);
  const lastKeyRef    = useRef<string>('');

  // Recompute sign meshes whenever parcels changes (store update triggers re-render).
  // This runs synchronously after render (useEffect), not during render, so it's safe
  // to imperatively add/remove from the group.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    // Derive the new available set key. Only rebuild if it changed.
    const newKey = availableSetKey(parcels);
    if (newKey === lastKeyRef.current) return;
    lastKeyRef.current = newKey;

    // Remove + dispose old sign meshes from the group.
    for (const m of signMeshesRef.current) {
      group.remove(m);
      m.geometry.dispose();
    }

    // Build new sign meshes for available parcels only.
    const availableParcels = LAND_PARCELS.filter(
      (p) => (parcels.get(p.id)?.status ?? 'available') === 'available',
    );
    const newSignMeshes = buildSignMeshes(
      availableParcels,
      staticSignMats.signPostMat,
      staticSignMats.signPlankMats,
    );
    for (const m of newSignMeshes) group.add(m);
    signMeshesRef.current = newSignMeshes;
  }, [parcels, staticSignMats]);

  // ── Attach body meshes to R3F group (once) ────────────────────────────────
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    for (const m of bodyMeshes) group.add(m);
    return () => {
      for (const m of bodyMeshes) {
        m.geometry.dispose();
        group.remove(m);
      }
      for (const mat of bodyMaterials) mat.dispose();
    };
  }, [bodyMeshes, bodyMaterials]);

  // ── Full unmount teardown — dispose sign meshes + shared sign materials ────
  useEffect(() => {
    return () => {
      const group = groupRef.current;
      if (group) {
        for (const m of signMeshesRef.current) {
          m.geometry.dispose();
          group.remove(m);
        }
      }
      signMeshesRef.current = [];
      lastKeyRef.current = '';

      // Dispose shared sign materials + textures.
      for (const tex of staticSignMats.textures) tex.dispose();
      staticSignMats.signPostMat.dispose();
      for (const mat of Object.values(staticSignMats.signPlankMats)) mat.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run only on unmount

  return <group ref={groupRef} name="land-parcels" />;
}

// ---------------------------------------------------------------------------
// LandParcelSignHitboxes — invisible JSX click targets for available signs
// ---------------------------------------------------------------------------

/**
 * Renders one invisible BoxMesh per available-for-sale sign.
 * R3F's pointer-event system handles onClick / onPointerDown for mouse + touch.
 * Clicking (or tapping on mobile) calls openLandOffice(parcelCode) which opens
 * the Land Office modal focused on that parcel.
 *
 * Iris Xe safe:
 *   - invisible=true → Three.js skips this mesh in the render pass (no draw call).
 *   - MeshBasicMaterial (transparent) — no ShaderMaterial.
 *   - No per-frame allocations; the hitbox list rebuilds on store change (rare).
 */

// Shared transparent material for all hitboxes (never disposed — module-level singleton).
const _hitboxMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });

export function LandParcelSignHitboxes() {
  const parcels = useLandStore((s) => s.parcels);
  // land-state-impl extends openLandOffice to accept an optional parcelCode.
  // Cast to the extended signature so the click bridge compiles before the
  // store type is updated. The runtime value is the same action — the store
  // update and this call site are coordinated via the frozen contract.
  const openLandOffice = useGameStore((s) => s.openLandOffice) as (parcelCode?: string) => void;

  // Derive the list of available parcel hitbox specs. Memoized on parcels identity.
  const hitboxes = useMemo(() => {
    return LAND_PARCELS
      .filter((p) => (parcels.get(p.id)?.status ?? 'available') === 'available')
      .map((p) => {
        const cat = getLandSignCategory(p);
        const cfg = SIGN_SIZES[cat];
        const hb  = HITBOX_HALF[cat];
        const { signX, signZ } = signPosition(p);
        const plankY = FLOOR_Y + cfg.postH - cfg.plankH * 0.6;
        return {
          parcelCode: p.id,
          x:          signX,
          y:          plankY,
          z:          signZ,
          hw:         hb.hw,
          hh:         hb.hh,
          hd:         hb.hd,
        };
      });
  }, [parcels]);

  return (
    <>
      {hitboxes.map((hb) => (
        <mesh
          key={hb.parcelCode}
          position={[hb.x, hb.y, hb.z]}
          visible={false}
          material={_hitboxMat}
          onClick={(e) => {
            e.stopPropagation();
            openLandOffice(hb.parcelCode);
          }}
        >
          <boxGeometry args={[hb.hw * 2, hb.hh * 2, hb.hd * 2]} />
        </mesh>
      ))}
    </>
  );
}
