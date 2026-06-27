'use client';

/**
 * land-founder-apartments.tsx — Luxury ambient apartment buildings for the
 * founder (premium / innermost) ring.
 *
 * PURPOSE:
 *   The founder ring has 10 parcels with ~4864wu gaps between adjacent centers.
 *   These gaps read as void — no buildings, no density, no premium feel.
 *   This component drops LUXURY HIGH-RISE TOWERS into those gap segments so the
 *   founder ring reads as a high-end residential skyline.
 *
 *   Buildings are AMBIENT / environmental — NOT parcel structures and NOT on any
 *   parcel footprint. They are placed at inter-parcel gap midpoints and clear all
 *   parcel exclusion zones.
 *
 * SCALE ANCHOR (the load-bearing detail):
 *   A player character renders at VRM_AVATAR_TARGET_HEIGHT_WU = 270 world units
 *   tall. Every tower here is built so:
 *     - The whole silhouette reads TALL (4–7× character): A ≈ 1940wu, C ≈ 1180wu,
 *       B ≈ 1040wu — real luxury high-rises, not stubby mid-rise boxes.
 *     - Every rooftop crown / penthouse element is >= 1 character tall (>=270wu),
 *       so the capstone is architecturally significant, not a token cube.
 *   Scene fog far = 10500 / camera far = 11500 are FAR above these heights, and
 *   there is no atmosphere ceiling plane — several-thousand-wu towers are safe.
 *
 * ARCHITECTURE — 3 TYPES (ALL SHIPPED; all 10 founder-ring gaps filled, A/B/C alternating):
 *
 *   Type A — "Coral Spire Tower"  (~1940wu — SLENDER FLUTED SPIRE)
 *     A grand glass+gold lobby base, a fluted shaft wrapped in 8 vertical
 *     pilaster ribs per face with recessed glowing window ribbons between them,
 *     layered cornice ledges at three setbacks, a tapered art-deco crown, a glass
 *     observation penthouse (>=270wu), and a beacon mast with a glowing finial.
 *
 *   Type B — "Terraced Reef Block" (~1040wu — BROAD STEPPED LUXURY TERRACES)
 *     A wide stepped luxury complex contrasting A's slim spire. Grand lobby band,
 *     4 step-back terraces each with a gold cantilevered cornice + parapet rail,
 *     vertical pilasters articulating the long faces with continuous glass ribbons
 *     between, and a railed roof terrace carrying a glass penthouse box (>=270wu)
 *     with a beacon mast.
 *
 *   Type C — "Ziggurat Penthouse" (~1180wu — MONUMENTAL STEPPED ZIGGURAT)
 *     A monumental stepped pyramid. 6 progressively-smaller square tiers, each
 *     framed by a gold cornice ledge + corner pilaster buttresses + recessed glass
 *     window bays per face, crowned by a large octagonal glass observation cupola
 *     (>=270wu) with a gold ring and a spire finial + beacon.
 *
 * PERF CONTRACT:
 *   - ZERO GLB fetch / useGLTF — fully procedural Three.js geometry.
 *   - ZERO Suspense wrapping needed (no async asset load).
 *   - ZERO InstancedMesh (WebGPU crash with ShaderMaterial).
 *   - ZERO drei <Text>/<Billboard> (Iris Xe hard crash).
 *   - ZERO ShaderMaterial / NodeMaterial / TSL — MeshStandardMaterial only.
 *   - ZERO per-frame new Vector3/Matrix4 — all geometry built once in useMemo.
 *   - Only BoxGeometry + CylinderGeometry (both WebGPU/Iris-Xe safe).
 *   - Pure mergeGeometries() — all placed buildings of a given material bucket
 *     collapse to ONE BufferGeometry = ONE draw call per material.
 *   - matrixAutoUpdate=false + computeBoundingBox/Sphere on every merged mesh.
 *   - Fog near=5000 / far=10500 culls at distance.
 *
 * DRAW-CALL ACCOUNTING — 5 MATERIAL BUCKETS = 5 DRAW CALLS TOTAL (INVARIANT):
 *   body   (cream pearl   0xf5f0e8) : 1 merged draw call — main masses, shafts, tiers
 *   gold   (warm gold     0xd4a847) : 1 merged draw call — cornices, rails, crowns, finials
 *   window (deep teal     0x1a5a8a) : 1 merged draw call — base/penthouse glass, large panes
 *   dark   (charcoal navy 0x1c2733) : 1 merged draw call — pilaster shadows, frames, mullions
 *   glow   (lit amber     0xffd98a) : 1 merged draw call — emissive lit window ribbons + beacons
 *   TOTAL: exactly 5 draw calls — INVARIANT regardless of building count or type.
 *   All 3 types share the SAME 5 materials. Every placed piece of a given bucket
 *   merges into one BufferGeometry; adding more buildings or types never adds a
 *   draw call — it only grows the 5 merged geometries.
 *
 * VERTEX BUDGET:
 *   Box = 24 verts, Cylinder(...,8) ≈ 50 verts. Per-building piece counts are
 *   bounded (A ≈ 150, B ≈ 150, C ≈ 130 pieces). Across all 10 placements the
 *   merged bucket geometries total well under ~110k verts — trivially cheap for
 *   static merged geometry on Iris Xe (no per-frame work, frustum-culled by AABB).
 *
 * PLACEMENT — all 10 founder-ring gaps filled, alternating A/B/C:
 *   gap 0=A, 1=B, 2=C, 3=A, 4=B, 5=C, 6=A, 7=B, 8=C, 9=A. lateralOffset and
 *   tAlong are varied per gap for organic, non-robotic spacing. Verified math:
 *   every building clears BOTH adjacent founder parcels by >1600wu (required
 *   ~969wu), no building-to-building overlap. Max footprint <=450wu (< FOUNDER_EXCL_R 672wu).
 *
 * Iris Xe / WebGPU invariants:
 *   - All geometry is BoxGeometry or CylinderGeometry — both safe.
 *   - All materials are MeshStandardMaterial — no ShaderMaterial/NodeMaterial.
 *   - Buildings are purely static — no animation, no useFrame usage.
 *
 * (2026-06-26 — land-builder-economics: founder-ring luxury tower DETAIL REBUILD.
 *  All 3 types re-detailed (pilasters, recessed glass ribbons, layered cornices,
 *  grand lobby bands, significant glass-penthouse crowns >=270wu, beacon masts);
 *  heights pushed to real luxury-tower scale; material buckets grown 3 -> 5
 *  (added dark accent + emissive window-glow). Placement table unchanged.)
 */

import { useMemo, useEffect } from 'react';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeGeometryWebGPUSafe } from '@/lib/three/webgpu-geometry';

// ---------------------------------------------------------------------------
// World constants (match arena-terrain.tsx)
// ---------------------------------------------------------------------------

/** Sand floor Y. Buildings ground here. */
const FLOOR_Y = -2;

// ---------------------------------------------------------------------------
// Parcel ring geometry -- local re-computation (no dep on shared package).
// Keep in sync with land-parcels.ts TIER_CONFIG.founder and TILE_SIZE.
// ---------------------------------------------------------------------------

const TILE_SIZE = 32;
/** Founder ring half-side in tiles. */
const FOUNDER_H_TILES = 190;
/** Founder parcel footprint in tiles. */
const FOUNDER_FOOT_TILES = 38;
/** Founder ring half-side in world-units. */
const FOUNDER_H_WU = FOUNDER_H_TILES * TILE_SIZE; // 6080
/** Number of founder parcels. */
const FOUNDER_COUNT = 10;

/** Exclusion buffer around each parcel center (half-footprint + 2-tile gap). */
const FOUNDER_EXCL_R = (FOUNDER_FOOT_TILES / 2 + 2) * TILE_SIZE; // 672wu

function squarePerimeterPoint(s: number, h: number): { xt: number; zt: number } {
  const sideLen = 2 * h;
  const side = Math.floor(s / sideLen);
  const local = s - side * sideLen;
  switch (side) {
    case 0: return { xt: -h + local, zt: -h };
    case 1: return { xt: +h, zt: -h + local };
    case 2: return { xt: +h - local, zt: +h };
    case 3: return { xt: -h, zt: +h - local };
    default: return { xt: -h, zt: -h };
  }
}

interface ParcelPt { cx: number; cz: number; }

function buildFounderCenters(): ParcelPt[] {
  const h = FOUNDER_H_TILES;
  const perimeter = 8 * h;
  const step = perimeter / FOUNDER_COUNT;
  const pts: ParcelPt[] = [];
  for (let i = 0; i < FOUNDER_COUNT; i++) {
    const { xt, zt } = squarePerimeterPoint(i * step, h);
    pts.push({ cx: Math.round(xt * TILE_SIZE), cz: Math.round(zt * TILE_SIZE) });
  }
  return pts;
}

const FOUNDER_CENTERS: readonly ParcelPt[] = buildFounderCenters();

// ---------------------------------------------------------------------------
// Geometry bucket type — 5 material buckets shared by all 3 types.
// ---------------------------------------------------------------------------

type BucketKey = 'body' | 'gold' | 'window' | 'dark' | 'glow';

interface Pieces {
  body: THREE.BufferGeometry[];
  gold: THREE.BufferGeometry[];
  window: THREE.BufferGeometry[];
  dark: THREE.BufferGeometry[];
  glow: THREE.BufferGeometry[];
}

function emptyPieces(): Pieces {
  return { body: [], gold: [], window: [], dark: [], glow: [] };
}

// ---------------------------------------------------------------------------
// Low-level box helper — make a BoxGeometry centred at (cx, cy, cz).
// All transforms baked into vertex data (no node transforms).
// ---------------------------------------------------------------------------

function box(
  w: number, h: number, d: number,
  cx: number, cy: number, cz: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
  return g;
}

/** A vertical pilaster rib on a given face, full height of a span.
 *  faceSign +1 = +Z / -Z face (rib runs along X position list); we just place
 *  thin tall boxes protruding past the face. Caller controls geometry directly
 *  via box() — this is a thin convenience for a single rib. */
function rib(
  thick: number, height: number, depth: number,
  cx: number, cy: number, cz: number,
): THREE.BufferGeometry {
  return box(thick, height, depth, cx, cy, cz);
}

// ---------------------------------------------------------------------------
// Type A — "Coral Spire Tower" — slender fluted spire (~1460wu).
//
//   Lobby base   : grand 2-storey glass+gold entrance plinth.
//   Podium       : 2 stepped cornice ledges.
//   Shaft        : tall fluted shaft — 8 vertical pilaster ribs per face with
//                  recessed glowing glass ribbons between them; 3 cornice setbacks.
//   Crown        : tapered 8-sided art-deco crown.
//   Penthouse    : glass observation deck (>=270wu) + gold ring.
//   Mast         : beacon mast + glowing finial.
// ---------------------------------------------------------------------------

function buildTypeAPieces(): Pieces {
  const P = emptyPieces();
  let y = FLOOR_Y;

  // ---- Grand lobby base (2 storeys of glass + gold framing) ----
  const lobbyW = 230, lobbyH = 150, lobbyD = 230;
  // body shell (slightly inset corners read via the gold frame on top)
  P.body.push(box(lobbyW, lobbyH, lobbyD, 0, y + lobbyH / 2, 0));
  // full-height lobby glass on all 4 faces (the grand entrance read)
  const lgInset = 26;       // glass band inset from corners
  const lgH = lobbyH - 30;  // tall lobby glass
  const lgY = y + lobbyH / 2;
  const lgPaneW = lobbyW - lgInset * 2;
  P.window.push(box(lgPaneW, lgH, 5, 0, lgY, lobbyD / 2 + 3));
  P.window.push(box(lgPaneW, lgH, 5, 0, lgY, -(lobbyD / 2 + 3)));
  P.window.push(box(5, lgH, lgPaneW, lobbyW / 2 + 3, lgY, 0));
  P.window.push(box(5, lgH, lgPaneW, -(lobbyW / 2 + 3), lgY, 0));
  // dark vertical mullions splitting the lobby glass (4 per long face)
  for (let f = 0; f < 4; f++) {
    const ml = (f - 1.5) * (lgPaneW / 4);
    P.dark.push(box(7, lgH, 6, ml, lgY, lobbyD / 2 + 4));
    P.dark.push(box(7, lgH, 6, ml, lgY, -(lobbyD / 2 + 4)));
    P.dark.push(box(6, lgH, 7, lobbyW / 2 + 4, lgY, ml));
    P.dark.push(box(6, lgH, 7, -(lobbyW / 2 + 4), lgY, ml));
  }
  // gold base plinth skirt + gold lobby crown cornice
  P.gold.push(box(lobbyW + 30, 18, lobbyD + 30, 0, y + 9, 0));
  P.gold.push(box(lobbyW + 22, 22, lobbyD + 22, 0, y + lobbyH + 11, 0));
  y += lobbyH;

  // ---- Stepped podium (2 cornice ledges) ----
  const podSteps = [
    { w: 200, h: 60, d: 200 },
    { w: 178, h: 55, d: 178 },
  ];
  for (const s of podSteps) {
    P.body.push(box(s.w, s.h, s.d, 0, y + s.h / 2, 0));
    // gold cornice ledge on top, oversized for an overhang read
    P.gold.push(box(s.w + 20, 12, s.d + 20, 0, y + s.h + 6, 0));
    y += s.h + 12;
  }
  const podiumTopY = y; // shaft base

  // ---- Fluted shaft: 3 stacked spans, each with pilasters + glass ribbons ----
  const shaftW = 150;
  const spans = [
    { h: 360 },
    { h: 320 },
    { h: 280 },
  ];
  const ribsPerFace = 8;
  for (let si = 0; si < spans.length; si++) {
    const sp = spans[si];
    const spanY0 = y;
    const spanMidY = spanY0 + sp.h / 2;
    // span core (body)
    P.body.push(box(shaftW, sp.h, shaftW, 0, spanMidY, 0));

    // recessed glowing glass ribbon BEHIND the pilasters (continuous lit strip)
    const ribbonH = sp.h - 36;
    const ribbonY = spanMidY;
    P.glow.push(box(shaftW - 8, ribbonH, 4, 0, ribbonY, shaftW / 2 + 2));
    P.glow.push(box(shaftW - 8, ribbonH, 4, 0, ribbonY, -(shaftW / 2 + 2)));
    P.glow.push(box(4, ribbonH, shaftW - 8, shaftW / 2 + 2, ribbonY, 0));
    P.glow.push(box(4, ribbonH, shaftW - 8, -(shaftW / 2 + 2), ribbonY, 0));

    // 8 vertical pilaster ribs per face, protruding PAST the glass ribbon so the
    // glow reads as recessed light between fluted fins.
    const ribT = 10;        // rib thickness
    const ribProtrude = 12; // how far past the face
    const ribH = sp.h - 16;
    const usable = shaftW - 16;
    for (let r = 0; r < ribsPerFace; r++) {
      const t = r / (ribsPerFace - 1);
      const pos = -usable / 2 + t * usable;
      // +Z / -Z faces: ribs spread along X
      P.dark.push(rib(ribT, ribH, ribProtrude, pos, ribbonY, shaftW / 2 + ribProtrude / 2 + 2));
      P.dark.push(rib(ribT, ribH, ribProtrude, pos, ribbonY, -(shaftW / 2 + ribProtrude / 2 + 2)));
      // +X / -X faces: ribs spread along Z
      P.dark.push(rib(ribProtrude, ribH, ribT, shaftW / 2 + ribProtrude / 2 + 2, ribbonY, pos));
      P.dark.push(rib(ribProtrude, ribH, ribT, -(shaftW / 2 + ribProtrude / 2 + 2), ribbonY, pos));
    }

    // gold cornice setback between spans (and above the top span)
    P.gold.push(box(shaftW + 28, 16, shaftW + 28, 0, spanY0 + sp.h + 8, 0));
    y = spanY0 + sp.h + 16;
  }
  const shaftTopY = y;

  // ---- Tapered art-deco crown (8-sided) ----
  const crownH = 130;
  const crown = new THREE.CylinderGeometry(58, 92, crownH, 8);
  crown.translate(0, shaftTopY + crownH / 2, 0);
  P.body.push(crown);
  // gold ring band around the crown base
  const crownRing = new THREE.CylinderGeometry(96, 96, 16, 8);
  crownRing.translate(0, shaftTopY + 8, 0);
  P.gold.push(crownRing);
  y = shaftTopY + crownH;

  // ---- Glass observation penthouse (>=270wu element) ----
  // octagonal glass cylinder, 290wu (> 1 character = 270wu) + gold ring + cap.
  const penH = 290;
  const penCyl = new THREE.CylinderGeometry(64, 64, penH, 8);
  penCyl.translate(0, y + penH / 2, 0);
  P.window.push(penCyl);
  // glowing observation light band around the penthouse mid
  const penGlow = new THREE.CylinderGeometry(67, 67, 40, 8);
  penGlow.translate(0, y + penH * 0.5, 0);
  P.glow.push(penGlow);
  // gold ring at penthouse base + gold cap
  const penBaseRing = new THREE.CylinderGeometry(70, 70, 14, 8);
  penBaseRing.translate(0, y + 7, 0);
  P.gold.push(penBaseRing);
  const penCap = new THREE.CylinderGeometry(40, 66, 30, 8);
  penCap.translate(0, y + penH + 15, 0);
  P.gold.push(penCap);
  y += penH + 30;

  // ---- Beacon mast + glowing finial (architecturally significant topper) ----
  const mastH = 170;
  const mast = new THREE.CylinderGeometry(7, 12, mastH, 8);
  mast.translate(0, y + mastH / 2, 0);
  P.dark.push(mast);
  // glowing beacon sphere-ish (octagon cylinder) near the mast top
  const beacon = new THREE.CylinderGeometry(16, 16, 26, 8);
  beacon.translate(0, y + mastH * 0.62, 0);
  P.glow.push(beacon);
  // gold finial tip
  const finial = new THREE.CylinderGeometry(0.5, 9, 40, 8);
  finial.translate(0, y + mastH + 20, 0);
  P.gold.push(finial);
  // total A height ≈ lobby150 + podium ~234 + shaft ~1008 + crown130 + pen320 + mast190 ≈ 1940wu

  return P;
}

// ---------------------------------------------------------------------------
// Type B — "Terraced Reef Block" — broad stepped luxury terraces (~820wu).
//
//   Lobby band   : wide grand glass+gold entrance level.
//   Terraces     : 4 step-back terraces, each with a gold cantilevered cornice +
//                  dark parapet rail; vertical pilasters articulating the long
//                  faces with continuous glowing glass ribbons between them.
//   Roof terrace : railed roof deck carrying a glass penthouse box (>=270wu).
//   Mast         : beacon mast + glowing finial.
// ---------------------------------------------------------------------------

function buildTypeBPieces(): Pieces {
  const P = emptyPieces();
  let y = FLOOR_Y;

  // ---- Grand lobby band (wide glass entrance) ----
  const lbW = 440, lbH = 120, lbD = 360;
  P.body.push(box(lbW, lbH, lbD, 0, y + lbH / 2, 0));
  const lbGlassH = lbH - 26;
  const lbGY = y + lbH / 2;
  P.window.push(box(lbW - 48, lbGlassH, 5, 0, lbGY, lbD / 2 + 3));
  P.window.push(box(lbW - 48, lbGlassH, 5, 0, lbGY, -(lbD / 2 + 3)));
  P.window.push(box(5, lbGlassH, lbD - 48, lbW / 2 + 3, lbGY, 0));
  P.window.push(box(5, lbGlassH, lbD - 48, -(lbW / 2 + 3), lbGY, 0));
  // dark mullions across the long lobby faces
  for (let m = 0; m < 7; m++) {
    const mx = (m - 3) * ((lbW - 48) / 7);
    P.dark.push(box(8, lbGlassH, 6, mx, lbGY, lbD / 2 + 4));
    P.dark.push(box(8, lbGlassH, 6, mx, lbGY, -(lbD / 2 + 4)));
  }
  // gold plinth + lobby cornice
  P.gold.push(box(lbW + 30, 16, lbD + 30, 0, y + 8, 0));
  P.gold.push(box(lbW + 20, 20, lbD + 20, 0, y + lbH + 10, 0));
  y += lbH;

  // ---- 4 step-back terraces ----
  const terraces = [
    { w: 410, h: 130, d: 330 },
    { w: 340, h: 115, d: 270 },
    { w: 270, h: 100, d: 210 },
    { w: 200, h: 90,  d: 160 },
  ];
  const ribsPerLongFace = 9;
  for (let i = 0; i < terraces.length; i++) {
    const t = terraces[i];
    const ty0 = y;
    const tMidY = ty0 + t.h / 2;
    P.body.push(box(t.w, t.h, t.d, 0, tMidY, 0));

    // continuous glowing glass ribbon on the long (front/back) faces
    const ribbonH = t.h - 28;
    P.glow.push(box(t.w - 24, ribbonH, 4, 0, tMidY, t.d / 2 + 2));
    P.glow.push(box(t.w - 24, ribbonH, 4, 0, tMidY, -(t.d / 2 + 2)));
    // shorter side glass on the +X/-X faces
    P.window.push(box(4, ribbonH, t.d - 24, t.w / 2 + 2, tMidY, 0));
    P.window.push(box(4, ribbonH, t.d - 24, -(t.w / 2 + 2), tMidY, 0));

    // vertical pilasters articulating the long faces (kills the flat-box read)
    const ribT = 12, ribProt = 12, ribH = t.h - 14;
    const usable = t.w - 28;
    for (let r = 0; r < ribsPerLongFace; r++) {
      const rt = r / (ribsPerLongFace - 1);
      const px = -usable / 2 + rt * usable;
      P.dark.push(box(ribT, ribH, ribProt, px, tMidY, t.d / 2 + ribProt / 2 + 2));
      P.dark.push(box(ribT, ribH, ribProt, px, tMidY, -(t.d / 2 + ribProt / 2 + 2)));
    }
    // corner pilaster buttresses (all 4 corners) for a heavier luxury read
    const cw = t.w / 2 - 7, cd = t.d / 2 - 7;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      P.dark.push(box(18, t.h - 6, 18, sx * cw, tMidY, sz * cd));
    }

    const tierTop = ty0 + t.h;
    // gold cantilevered cornice slab (oversized overhang)
    P.gold.push(box(t.w + 28, 14, t.d + 28, 0, tierTop + 7, 0));
    // dark parapet rail sitting on the cornice
    P.dark.push(box(t.w + 24, 16, 8, 0, tierTop + 14 + 8, t.d / 2 + 12));
    P.dark.push(box(t.w + 24, 16, 8, 0, tierTop + 14 + 8, -(t.d / 2 + 12)));
    P.dark.push(box(8, 16, t.d + 24, t.w / 2 + 12, tierTop + 14 + 8, 0));
    P.dark.push(box(8, 16, t.d + 24, -(t.w / 2 + 12), tierTop + 14 + 8, 0));
    y = tierTop + 14;
  }
  const roofY = y;

  // ---- Railed roof terrace + glass penthouse box (>=270wu element) ----
  const penW = 180, penH = 290, penD = 150;
  const penY = roofY + penH / 2;
  P.body.push(box(penW, penH, penD, 0, penY, 0));
  // wrap-around glowing penthouse glass
  const pgH = penH - 30;
  P.glow.push(box(penW - 22, pgH, 4, 0, penY, penD / 2 + 2));
  P.glow.push(box(penW - 22, pgH, 4, 0, penY, -(penD / 2 + 2)));
  P.window.push(box(4, pgH, penD - 22, penW / 2 + 2, penY, 0));
  P.window.push(box(4, pgH, penD - 22, -(penW / 2 + 2), penY, 0));
  // dark corner posts on the penthouse
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    P.dark.push(box(12, penH, 12, sx * (penW / 2 - 5), penY, sz * (penD / 2 - 5)));
  }
  // gold cornice cap + base ring
  P.gold.push(box(penW + 26, 16, penD + 26, 0, roofY + penH + 8, 0));
  P.gold.push(box(penW + 14, 12, penD + 14, 0, roofY + 6, 0));
  y = roofY + penH + 16;

  // ---- Beacon mast + glowing finial ----
  const mastH = 110;
  const mast = new THREE.CylinderGeometry(6, 10, mastH, 8);
  mast.translate(0, y + mastH / 2, 0);
  P.dark.push(mast);
  const beacon = new THREE.CylinderGeometry(13, 13, 22, 8);
  beacon.translate(0, y + mastH * 0.6, 0);
  P.glow.push(beacon);
  const finial = new THREE.CylinderGeometry(0.5, 7, 30, 8);
  finial.translate(0, y + mastH + 15, 0);
  P.gold.push(finial);
  // total B height ≈ lobby120 + terraces ~491 + pen306 + mast125 ≈ 1040wu (max footprint ~434wu)

  return P;
}

// ---------------------------------------------------------------------------
// Type C — "Ziggurat Penthouse" — monumental stepped ziggurat (~1010wu).
//
//   Lobby base   : broad glass+gold ground level.
//   Tiers        : 6 progressively-smaller square tiers, each framed by a gold
//                  cornice ledge + corner pilaster buttresses + recessed glowing
//                  window bays per face.
//   Cupola       : large octagonal glass observation cupola (>=270wu) + gold ring.
//   Finial       : spire finial + beacon.
// ---------------------------------------------------------------------------

function buildTypeCPieces(): Pieces {
  const P = emptyPieces();
  let y = FLOOR_Y;

  // ---- Broad grand lobby base ----
  const baseW = 380, baseH = 110;
  P.body.push(box(baseW, baseH, baseW, 0, y + baseH / 2, 0));
  const blGH = baseH - 24, blGY = y + baseH / 2;
  for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    if (nz !== 0) P.window.push(box(baseW - 44, blGH, 5, 0, blGY, nz * (baseW / 2 + 3)));
    else P.window.push(box(5, blGH, baseW - 44, nx * (baseW / 2 + 3), blGY, 0));
  }
  P.gold.push(box(baseW + 28, 16, baseW + 28, 0, y + 8, 0));
  P.gold.push(box(baseW + 18, 18, baseW + 18, 0, y + baseH + 9, 0));
  y += baseH;

  // ---- 6 stepped square tiers ----
  const tiers = [
    { wd: 330, h: 95 },
    { wd: 290, h: 90 },
    { wd: 250, h: 85 },
    { wd: 210, h: 80 },
    { wd: 170, h: 75 },
    { wd: 130, h: 70 },
  ];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const ty0 = y;
    const tMidY = ty0 + t.h / 2;
    P.body.push(box(t.wd, t.h, t.wd, 0, tMidY, 0));

    // recessed glowing window bay on each of the 4 faces (continuous lit strip)
    const bayW = t.wd * 0.62, bayH = t.h - 26;
    P.glow.push(box(bayW, bayH, 4, 0, tMidY, t.wd / 2 + 2));
    P.glow.push(box(bayW, bayH, 4, 0, tMidY, -(t.wd / 2 + 2)));
    P.glow.push(box(4, bayH, bayW, t.wd / 2 + 2, tMidY, 0));
    P.glow.push(box(4, bayH, bayW, -(t.wd / 2 + 2), tMidY, 0));

    // corner pilaster buttresses + a dark frame around each window bay
    const cw = t.wd / 2 - 8;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      P.dark.push(box(20, t.h - 4, 20, sx * cw, tMidY, sz * cw));
    }
    // dark mullion splitting each window bay vertically
    P.dark.push(box(8, bayH, 6, 0, tMidY, t.wd / 2 + 3));
    P.dark.push(box(8, bayH, 6, 0, tMidY, -(t.wd / 2 + 3)));
    P.dark.push(box(6, bayH, 8, t.wd / 2 + 3, tMidY, 0));
    P.dark.push(box(6, bayH, 8, -(t.wd / 2 + 3), tMidY, 0));

    const tierTop = ty0 + t.h;
    // gold cornice ledge between tiers (oversized overhang); next tier stacks on it
    const cornH = 12;
    P.gold.push(box(t.wd + 22, cornH, t.wd + 22, 0, tierTop + cornH / 2, 0));
    y = tierTop + cornH;
  }
  const cupBaseY = y;

  // ---- Large octagonal glass observation cupola (>=270wu element) ----
  const cupH = 300;
  const cupR = 78;
  const cup = new THREE.CylinderGeometry(cupR, cupR, cupH, 8);
  cup.translate(0, cupBaseY + cupH / 2, 0);
  P.window.push(cup);
  // glowing observation band
  const cupGlow = new THREE.CylinderGeometry(cupR + 3, cupR + 3, 46, 8);
  cupGlow.translate(0, cupBaseY + cupH * 0.5, 0);
  P.glow.push(cupGlow);
  // gold base ring + tapered gold roof cap
  const cupRing = new THREE.CylinderGeometry(cupR + 6, cupR + 6, 16, 8);
  cupRing.translate(0, cupBaseY + 8, 0);
  P.gold.push(cupRing);
  const cupCap = new THREE.CylinderGeometry(28, cupR + 2, 50, 8);
  cupCap.translate(0, cupBaseY + cupH + 25, 0);
  P.gold.push(cupCap);
  y = cupBaseY + cupH + 50;

  // ---- Spire finial + beacon ----
  const spireH = 150;
  const spire = new THREE.CylinderGeometry(2, 14, spireH, 8);
  spire.translate(0, y + spireH / 2, 0);
  P.gold.push(spire);
  const beacon = new THREE.CylinderGeometry(15, 15, 24, 8);
  beacon.translate(0, y + 30, 0);
  P.glow.push(beacon);
  // total C height ≈ lobby110 + tiers ~567 + cupola350 + spire150 ≈ 1180wu (max footprint ~408wu)

  return P;
}

// ---------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------

/**
 * Compute the center of the gap between parcel[gapIdx] and parcel[gapIdx+1],
 * with a lateral offset perpendicular to the gap direction, and an optional
 * along-gap offset (t=0.5 is exact midpoint, range 0-1).
 */
function gapCenter(
  gapIdx: number,
  lateralOffset: number, // wu, + = outward from ring center
  t = 0.5,
): { x: number; z: number; rotY: number } {
  const a = FOUNDER_CENTERS[gapIdx % FOUNDER_COUNT];
  const b = FOUNDER_CENTERS[(gapIdx + 1) % FOUNDER_COUNT];
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const len = Math.sqrt(dx * dx + dz * dz);
  const nx = dz / len;  // normal (perpendicular, pointing outward from ring)
  const nz = -dx / len;

  const x = a.cx + dx * t + nx * lateralOffset;
  const z = a.cz + dz * t + nz * lateralOffset;

  // Face the building approximately inward (toward world origin from gap midpoint)
  const midX = a.cx + dx * 0.5;
  const midZ = a.cz + dz * 0.5;
  const rotY = Math.atan2(midX, midZ) + Math.PI; // face inward

  return { x, z, rotY };
}

/** Apply a full placement transform to a geometry (rotate + translate).
 *  Returns a new CLONE with baked transform. */
function applyPlacement(
  geo: THREE.BufferGeometry,
  x: number,
  z: number,
  rotY: number,
): THREE.BufferGeometry {
  const clone = geo.clone();
  if (rotY !== 0) clone.rotateY(rotY);
  clone.translate(x, 0, z);
  return clone;
}

// ---------------------------------------------------------------------------
// Module-scope geometry pieces (built once, shared across placements)
// ---------------------------------------------------------------------------

const _typeAPieces = buildTypeAPieces();
const _typeBPieces = buildTypeBPieces();
const _typeCPieces = buildTypeCPieces();

/** Type → its pre-built origin-centered geometry pieces. */
const PIECES_BY_TYPE: Record<'A' | 'B' | 'C', Pieces> = {
  A: _typeAPieces,
  B: _typeBPieces,
  C: _typeCPieces,
};

// ---------------------------------------------------------------------------
// Placement table — ALL 10 founder-ring gaps filled, alternating A/B/C.
// lateralOffset: positive = outside the ring frame line, negative = inside.
// tAlong: position along the gap (0.5 = midpoint). Offsets/t varied per gap for
// organic, non-robotic spacing. Math verified: every building clears BOTH
// adjacent founder parcels by >1600wu, no building-to-building overlap.
// Corner-spanning gaps (2, 7) nudged outward so they don't crowd ring interior.
// ---------------------------------------------------------------------------

interface ApartmentPlacement {
  type: 'A' | 'B' | 'C';
  gapIdx: number;
  lateralOffset: number;
  tAlong: number; // 0-1, position along the gap (0.5 = midpoint)
}

const FOUNDER_APARTMENT_PLACEMENTS: readonly ApartmentPlacement[] = [
  // gap 0 — north-west top edge (parcels 0→1)
  { type: 'A', gapIdx: 0, lateralOffset: 200, tAlong: 0.5 },
  // gap 1 — north-east top edge (parcels 1→2)
  { type: 'B', gapIdx: 1, lateralOffset: 160, tAlong: 0.5 },
  // gap 2 — top-right CORNER span (parcels 2→3) — nudged outward
  { type: 'C', gapIdx: 2, lateralOffset: 240, tAlong: 0.46 },
  // gap 3 — east edge upper (parcels 3→4) — placed inside the ring
  { type: 'A', gapIdx: 3, lateralOffset: -180, tAlong: 0.48 },
  // gap 4 — east edge lower (parcels 4→5)
  { type: 'B', gapIdx: 4, lateralOffset: 140, tAlong: 0.52 },
  // gap 5 — bottom-right CORNER span (parcels 5→6)
  { type: 'C', gapIdx: 5, lateralOffset: 220, tAlong: 0.5 },
  // gap 6 — south edge right (parcels 6→7)
  { type: 'A', gapIdx: 6, lateralOffset: 200, tAlong: 0.47 },
  // gap 7 — bottom-left CORNER span (parcels 7→8) — nudged outward
  { type: 'B', gapIdx: 7, lateralOffset: 220, tAlong: 0.52 },
  // gap 8 — west edge lower (parcels 8→9)
  { type: 'C', gapIdx: 8, lateralOffset: 180, tAlong: 0.5 },
  // gap 9 — west edge upper (parcels 9→0)
  { type: 'A', gapIdx: 9, lateralOffset: 160, tAlong: 0.45 },
];

// ---------------------------------------------------------------------------
// LandFounderApartments — pure procedural, no Suspense (no async asset load).
// All geometry built once in useMemo.
// ---------------------------------------------------------------------------

const BUCKET_KEYS: readonly BucketKey[] = ['body', 'gold', 'window', 'dark', 'glow'];

export default function LandFounderApartments() {
  // Build merged geometry buckets once. No state, no async, no Suspense needed.
  const buckets = useMemo<Array<{ geometry: THREE.BufferGeometry; key: BucketKey }>>(() => {
    // Collect all placed geometry pieces per material bucket
    const collected: Record<BucketKey, THREE.BufferGeometry[]> = {
      body: [], gold: [], window: [], dark: [], glow: [],
    };

    for (const placement of FOUNDER_APARTMENT_PLACEMENTS) {
      const pos = gapCenter(placement.gapIdx, placement.lateralOffset, placement.tAlong);
      const pieces = PIECES_BY_TYPE[placement.type];
      for (const k of BUCKET_KEYS) {
        for (const g of pieces[k]) {
          collected[k].push(applyPlacement(g, pos.x, pos.z, pos.rotY));
        }
      }
    }

    const result: Array<{ geometry: THREE.BufferGeometry; key: BucketKey }> = [];

    function mergeAndStore(geos: THREE.BufferGeometry[], key: BucketKey) {
      if (geos.length === 0) return;
      const safe = geos.map((g) => makeGeometryWebGPUSafe(g));
      const merged = mergeGeometries(safe, false);
      safe.forEach((g) => g.dispose());
      if (!merged) return;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      result.push({ geometry: merged, key });
    }

    for (const k of BUCKET_KEYS) mergeAndStore(collected[k], k);

    return result;
  }, []);

  // Materials — MeshStandardMaterial only. Created once, stable refs.
  const materials = useMemo<Record<BucketKey, THREE.MeshStandardMaterial>>(() => {
    // Body: cream/pearl white — upscale neutral mass
    const body = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xf5f0e8),
      roughness: 0.62,
      metalness: 0.05,
    });
    // Gold: cornices, rails, crowns, finials — warm luxury accent
    const gold = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xd4a847),
      roughness: 0.25,
      metalness: 0.70,
      emissive: new THREE.Color(0x3a2000),
      emissiveIntensity: 0.4,
    });
    // Window: deep ocean teal glass — large penthouse / lobby panes
    const window = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x1a5a8a),
      roughness: 0.05,
      metalness: 0.15,
      emissive: new THREE.Color(0x0a2a40),
      emissiveIntensity: 0.5,
    });
    // Dark accent: charcoal navy — pilaster fins, mullions, frames, parapets, masts.
    // The single biggest "less bland" win: definition + contrast against the cream.
    const dark = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x1c2733),
      roughness: 0.55,
      metalness: 0.30,
    });
    // Glow: warm lit window ribbons + beacons — "occupied luxury tower at night"
    // pop against the dark seafloor. Emissive-heavy.
    const glow = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xffd98a),
      roughness: 0.3,
      metalness: 0.0,
      emissive: new THREE.Color(0xffc862),
      emissiveIntensity: 1.6,
    });
    return { body, gold, window, dark, glow };
  }, []);

  // Dispose on unmount — extended to ALL 5 buckets.
  useEffect(() => {
    return () => {
      buckets.forEach(({ geometry }) => geometry.dispose());
      Object.values(materials).forEach((m) => m.dispose());
    };
  }, [buckets, materials]);

  return (
    <>
      {buckets.map(({ geometry, key }) => (
        <mesh
          key={key}
          geometry={geometry}
          material={materials[key]}
          // All transforms baked into vertex positions — matrix stays identity
          matrixAutoUpdate={false}
          // frustumCulled stays true (default) — tight AABB from computeBoundingBox()
          receiveShadow={false}
          castShadow={false}
        />
      ))}
    </>
  );
}
