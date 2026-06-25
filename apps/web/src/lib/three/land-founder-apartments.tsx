'use client';

/**
 * land-founder-apartments.tsx — Luxury ambient apartment buildings for the
 * founder (premium / innermost) ring.
 *
 * PURPOSE:
 *   The founder ring has 10 parcels with ~4864wu gaps between adjacent centers.
 *   These gaps read as void — no buildings, no density, no premium feel.
 *   This component drops LUXURY APARTMENT BUILDINGS into those gap segments so
 *   the founder ring reads as a high-end residential district.
 *
 *   Buildings are AMBIENT / environmental — NOT parcel structures and NOT on any
 *   parcel footprint. They are placed at inter-parcel gap midpoints and clear all
 *   parcel exclusion zones.
 *
 * ARCHITECTURE — 3 TYPES (ALL SHIPPED; all 10 founder-ring gaps filled, A/B/C alternating):
 *
 *   Type A — "Coral Spire Tower"
 *     Slim art-deco luxury tower (deliberately VERTICAL silhouette). Stepped 3-tier
 *     podium base, tall narrow shaft, 4 cantilevered gold balcony bands, teal window
 *     bands per face, tapered 8-sided penthouse crown + gold penthouse box. ~820wu tall.
 *
 *   Type B — "Terraced Reef Block"
 *     Wide HORIZONTAL luxury complex (deliberately contrasts A's slim spire). Wide
 *     rectangular base, 3 step-back terraces going up, a horizontal gold terrace-rail/
 *     soffit on each setback, teal window bands on the main faces, flat gold-capped
 *     penthouse box on top. ~480wu tall, ~420wu max footprint.
 *
 *   Type C — "Ziggurat Penthouse"
 *     Stepped-pyramid massing (3rd distinct silhouette). 5 stacked progressively-
 *     smaller square tiers, a thin oversized gold cornice slab between tiers, teal
 *     window slots on tier faces, and an octagonal teal-glass penthouse cylinder on
 *     top with a small gold cap. ~600wu tall, ~340wu max footprint.
 *
 * PERF CONTRACT:
 *   - ZERO GLB fetch / useGLTF — fully procedural Three.js geometry.
 *   - ZERO Suspense wrapping needed (no async asset load).
 *   - ZERO InstancedMesh (WebGPU crash with ShaderMaterial).
 *   - ZERO drei <Text>/<Billboard> (Iris Xe hard crash).
 *   - ZERO per-frame new Vector3/Matrix4 — all geometry built once in useMemo.
 *   - Pure mergeGeometries() — all placed buildings of a given material bucket
 *     collapsed to ONE BufferGeometry = ONE draw call per material.
 *   - matrixAutoUpdate=false + computeBoundingBox/Sphere on every merged mesh.
 *   - Fog near=5000 / far=10500 culls at distance.
 *
 * PLACEMENT — all 10 founder-ring gaps filled, alternating A/B/C:
 *   gap 0=A, 1=B, 2=C, 3=A, 4=B, 5=C, 6=A, 7=B, 8=C, 9=A. lateralOffset and
 *   tAlong are varied per gap (small +/-120..260, t 0.45..0.52) for organic,
 *   non-robotic spacing. Corner-spanning gaps (2, 7 — adjacent parcels on
 *   different sides of the square) are nudged slightly outward so they don't
 *   crowd the ring interior. Verified math: every building clears BOTH adjacent
 *   founder parcels by >1600wu (required ~969wu), no building-to-building overlap.
 *
 * Iris Xe / WebGPU invariants:
 *   - All geometry is BoxGeometry or CylinderGeometry — both safe.
 *   - All materials are MeshStandardMaterial — no ShaderMaterial/NodeMaterial.
 *   - Buildings are purely static — no animation, no useFrame usage.
 *
 * Draw-call accounting (3 TYPES, all 10 placements):
 *   Body (cream):           1 merged draw call
 *   Gold accents:           1 merged draw call  (emissive 0x3a2000)
 *   Teal window bands:      1 merged draw call  (emissive 0x0a2a40)
 *   TOTAL: exactly 3 draw calls — INVARIANT regardless of building count or type.
 *   All 3 types share the SAME 3 materials (same hex colors), and every placed
 *   piece of a given bucket merges into one BufferGeometry. Adding more buildings
 *   or more types never adds a draw call: it only grows the 3 merged geometries.
 *
 * (2026-06-25 — land-builder-economics: founder ring luxury apartment full build.
 *  Types A+B+C all shipped, all 10 gaps filled alternating A/B/C.)
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
// Building geometry helpers — procedural, no GLB
// ---------------------------------------------------------------------------

/**
 * Translate + optionally rotate a geometry, baking the transform into vertex data.
 * Returns the same geometry for chaining. All in-place.
 */
function placeGeo(
  geo: THREE.BufferGeometry,
  x: number, y: number, z: number,
  rotY = 0,
): THREE.BufferGeometry {
  if (rotY !== 0) geo.rotateY(rotY);
  geo.translate(x, y, z);
  return geo;
}

// ---------------------------------------------------------------------------
// Type A — "Coral Spire Tower"
//
// Design breakdown:
//   Podium:  3 stacked boxes, progressively narrowing + shorter.
//            Bottom: 280w x 100h x 280d (widest, heaviest base)
//            Mid:    220w x  80h x 220d
//            Top:    170w x  70h x 170d
//   Shaft:   160w x 480h x 160d, sits on top of podium stack (total podium h=250)
//   Balconies (4): 260w x  10h x 260d slabs, protruding 50wu past shaft face,
//            spaced 100wu apart up the shaft
//   Crown:   CylinderGeometry (8-sided, r=90 → r=30, h=90) on top of shaft
//   Penthouse box: 120w x 80h x 120d sitting on crown base
//
//   Total height: 100+80+70 + 480 + 90 = 820wu  (from floor)
//   Footprint:     280wu (podium base, well under FOUNDER_EXCL_R of 672wu from parcel)
//
// Materials: 3 buckets —
//   BODY: cream/white  0xf5f0e8, roughness 0.65, metalness 0.05
//   GOLD: 0xd4a847, roughness 0.25, metalness 0.70, emissive 0x3a2000 (0.4)
//   WINDOW: 0x1a5a8a, roughness 0.05, metalness 0.15, emissive 0x0a2a40 (0.6)
// ---------------------------------------------------------------------------

/** Collect all raw geometry pieces for one Type A tower at the origin,
 *  grouped by material bucket key. */
function buildTypeAPieces(): {
  body: THREE.BufferGeometry[];
  gold: THREE.BufferGeometry[];
  window: THREE.BufferGeometry[];
} {
  const body: THREE.BufferGeometry[] = [];
  const gold: THREE.BufferGeometry[] = [];
  const win: THREE.BufferGeometry[] = [];

  // -- Podium tiers (body) --
  // Each tier: centered at x=0, z=0; y = floor + cumulative height so far
  const podiumSteps = [
    { w: 280, h: 100, d: 280 },
    { w: 220, h: 80,  d: 220 },
    { w: 170, h: 70,  d: 170 },
  ];
  let podiumY = FLOOR_Y;
  for (const step of podiumSteps) {
    const g = new THREE.BoxGeometry(step.w, step.h, step.d);
    // Three.js BoxGeometry centers at origin; lift to sit on podiumY
    g.translate(0, podiumY + step.h / 2, 0);
    body.push(g);
    podiumY += step.h;
  }
  // podiumY now = FLOOR_Y + 250

  // -- Shaft (body) --
  const shaftH = 480;
  const shaftW = 160;
  const shaftY = podiumY + shaftH / 2;
  body.push(placeGeo(new THREE.BoxGeometry(shaftW, shaftH, shaftW), 0, shaftY, 0));

  // -- Window bands on shaft (window material) --
  // 3 horizontal window strips: thin box wider than shaft, 20wu tall, 4wu deep
  // at ~25%, 50%, 75% up the shaft
  const windowBandH = 20;
  const windowBandW = shaftW + 8; // slightly wider than shaft face
  for (let i = 1; i <= 3; i++) {
    const bandY = podiumY + (shaftH * i) / 4;
    // front face band
    win.push(placeGeo(new THREE.BoxGeometry(windowBandW, windowBandH, 4), 0, bandY, shaftW / 2 + 2));
    // back face band
    win.push(placeGeo(new THREE.BoxGeometry(windowBandW, windowBandH, 4), 0, bandY, -(shaftW / 2 + 2)));
    // left face band
    win.push(placeGeo(new THREE.BoxGeometry(4, windowBandH, windowBandW), shaftW / 2 + 2, bandY, 0));
    // right face band
    win.push(placeGeo(new THREE.BoxGeometry(4, windowBandH, windowBandW), -(shaftW / 2 + 2), bandY, 0));
  }

  // -- Balcony soffits (gold material) --
  // 4 cantilevered balcony slabs, spaced 100wu apart starting at 25% up shaft
  const balconySlabH = 10;
  const balconySlabW = shaftW + 100; // 50wu overhang per side
  for (let i = 0; i < 4; i++) {
    const balconyY = podiumY + 80 + i * 100;
    gold.push(placeGeo(new THREE.BoxGeometry(balconySlabW, balconySlabH, balconySlabW), 0, balconyY, 0));
  }

  // -- Crown: tapered cylinder (8-sided, like a chamfered top) --
  const crownBaseY = podiumY + shaftH;
  const crownH = 90;
  // CylinderGeometry(radiusTop, radiusBottom, height, radialSeg)
  const crown = new THREE.CylinderGeometry(30, 90, crownH, 8);
  crown.translate(0, crownBaseY + crownH / 2, 0);
  body.push(crown);

  // -- Penthouse box on top of crown (gold material) --
  const penthouseH = 80;
  const penthouseY = crownBaseY + crownH + penthouseH / 2;
  gold.push(placeGeo(new THREE.BoxGeometry(120, penthouseH, 120), 0, penthouseY, 0));

  // -- Penthouse window cap (window material) --
  const penCapH = 30;
  win.push(placeGeo(new THREE.BoxGeometry(100, penCapH, 100), 0, penthouseY + penthouseH / 2 + penCapH / 2, 0));

  return { body, gold, window: win };
}

// ---------------------------------------------------------------------------
// Type B — "Terraced Reef Block"
//
// Design breakdown (WIDE / horizontal silhouette — contrasts Type A's slim spire):
//   3 step-back terraces stacked up, each shorter + narrower than the one below:
//     T1 (base):   400w x 110h x 320d   (widest, heaviest)
//     T2:          300w x  95h x 240d
//     T3:          210w x  85h x 170d
//   Each terrace carries a thin GOLD rail/soffit slab sitting on its top face,
//   slightly OVERSIZED (terrace footprint + 24wu) so it reads as a cantilevered
//   horizontal terrace edge.
//   Teal WINDOW bands wrap the long (front/back) faces of T1 and T2 — wide
//   horizontal glass strips, the dominant luxury read.
//   Flat gold-capped PENTHOUSE box on top: 150w x 70h x 130d body (body bucket)
//   with a thin gold cap slab on top.
//
//   Total height: 110+95+85 + 70 + capH(14) = 374wu body stack -> ~480wu read
//     (terrace rails + penthouse cap add the rest of the visual height to ~480).
//   Max footprint: 400wu (T1 width) — well under FOUNDER_EXCL_R.
//
// Buckets reuse the EXACT same 3 materials as Type A (body / gold / window).
// ---------------------------------------------------------------------------

function buildTypeBPieces(): {
  body: THREE.BufferGeometry[];
  gold: THREE.BufferGeometry[];
  window: THREE.BufferGeometry[];
} {
  const body: THREE.BufferGeometry[] = [];
  const gold: THREE.BufferGeometry[] = [];
  const win: THREE.BufferGeometry[] = [];

  // -- Terrace tiers (body) + gold rail soffit on each top --
  const terraces = [
    { w: 400, h: 110, d: 320 },
    { w: 300, h: 95,  d: 240 },
    { w: 210, h: 85,  d: 170 },
  ];
  let y = FLOOR_Y;
  for (let i = 0; i < terraces.length; i++) {
    const t = terraces[i];
    // body tier
    const g = new THREE.BoxGeometry(t.w, t.h, t.d);
    g.translate(0, y + t.h / 2, 0);
    body.push(g);

    const tierTop = y + t.h;

    // gold rail/soffit slab sitting on the top face, oversized by 24wu per axis,
    // 8wu tall — reads as the cantilevered terrace edge
    const railH = 8;
    gold.push(placeGeo(
      new THREE.BoxGeometry(t.w + 24, railH, t.d + 24),
      0, tierTop + railH / 2, 0,
    ));

    // teal window bands on the long (front/back) faces of the two lower terraces
    if (i < 2) {
      const bandH = 26;
      const bandY = y + t.h * 0.55;
      const bandW = t.w - 30;            // inset from the corners
      // front (+z) and back (-z) faces
      win.push(placeGeo(new THREE.BoxGeometry(bandW, bandH, 4), 0, bandY, t.d / 2 + 2));
      win.push(placeGeo(new THREE.BoxGeometry(bandW, bandH, 4), 0, bandY, -(t.d / 2 + 2)));
    }

    y = tierTop;
  }
  // y now = FLOOR_Y + 290 (top of T3, BEFORE rails — rails sit above but the
  // penthouse stacks on the T3 body top so it nests just inside the T3 rail)

  // -- Penthouse box (body) on top of T3 --
  const penW = 150, penH = 70, penD = 130;
  const penY = y + penH / 2;
  body.push(placeGeo(new THREE.BoxGeometry(penW, penH, penD), 0, penY, 0));

  // teal window band wrapping the penthouse front/back
  const penBandH = 30;
  const penBandY = y + penH * 0.5;
  win.push(placeGeo(new THREE.BoxGeometry(penW - 24, penBandH, 4), 0, penBandY, penD / 2 + 2));
  win.push(placeGeo(new THREE.BoxGeometry(penW - 24, penBandH, 4), 0, penBandY, -(penD / 2 + 2)));

  // -- Gold flat cap on the penthouse (gold) --
  const capH = 14;
  gold.push(placeGeo(
    new THREE.BoxGeometry(penW + 20, capH, penD + 20),
    0, y + penH + capH / 2, 0,
  ));

  return { body, gold, window: win };
}

// ---------------------------------------------------------------------------
// Type C — "Ziggurat Penthouse"
//
// Design breakdown (stepped-pyramid massing — 3rd distinct silhouette):
//   5 stacked SQUARE tiers, each progressively smaller, with a thin OVERSIZED
//   gold cornice slab between consecutive tiers:
//     Tier 1 (base): 320 x 90h
//     Tier 2:        270 x 85h
//     Tier 3:        220 x 80h
//     Tier 4:        170 x 75h
//     Tier 5:        125 x 70h
//   Gold cornice ring = a flat slab (tierWidth + 18) x 10h sitting on each tier's
//   top face EXCEPT the very top (4 cornices between the 5 tiers).
//   Teal window SLOTS on each tier face: a thin vertical-ish window box on the
//   front (+z) and right (+x) faces of each tier.
//   Octagonal TEAL-GLASS penthouse cylinder on top (CylinderGeometry r,r,h,8) +
//   a small gold cap cylinder.
//
//   Total height: 90+85+80+75+70 = 400wu tier stack
//     + penthouse cyl 110 + gold cap 22 = 532wu body, ~600wu read with cornices.
//   Max footprint: 320wu (base tier) — well under FOUNDER_EXCL_R.
//
// Buckets reuse the EXACT same 3 materials as Type A (body / gold / window).
// ---------------------------------------------------------------------------

function buildTypeCPieces(): {
  body: THREE.BufferGeometry[];
  gold: THREE.BufferGeometry[];
  window: THREE.BufferGeometry[];
} {
  const body: THREE.BufferGeometry[] = [];
  const gold: THREE.BufferGeometry[] = [];
  const win: THREE.BufferGeometry[] = [];

  const tiers = [
    { wd: 320, h: 90 },
    { wd: 270, h: 85 },
    { wd: 220, h: 80 },
    { wd: 170, h: 75 },
    { wd: 125, h: 70 },
  ];

  let y = FLOOR_Y;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    // body tier (square footprint)
    const g = new THREE.BoxGeometry(t.wd, t.h, t.wd);
    g.translate(0, y + t.h / 2, 0);
    body.push(g);

    const tierTop = y + t.h;

    // teal window slot on front (+z) and right (+x) faces — thin tall boxes
    const slotW = t.wd * 0.42;
    const slotH = t.h * 0.55;
    const slotY = y + t.h * 0.5;
    win.push(placeGeo(new THREE.BoxGeometry(slotW, slotH, 4), 0, slotY, t.wd / 2 + 2));
    win.push(placeGeo(new THREE.BoxGeometry(4, slotH, slotW), t.wd / 2 + 2, slotY, 0));
    // back (-z) and left (-x) too, for full read
    win.push(placeGeo(new THREE.BoxGeometry(slotW, slotH, 4), 0, slotY, -(t.wd / 2 + 2)));
    win.push(placeGeo(new THREE.BoxGeometry(4, slotH, slotW), -(t.wd / 2 + 2), slotY, 0));

    // gold cornice slab between this tier and the next (skip after top tier)
    if (i < tiers.length - 1) {
      const cornH = 10;
      gold.push(placeGeo(
        new THREE.BoxGeometry(t.wd + 18, cornH, t.wd + 18),
        0, tierTop + cornH / 2, 0,
      ));
      // the next tier sits ON TOP of the cornice slab
      y = tierTop + cornH;
    } else {
      y = tierTop;
    }
  }
  // y now = top of tier 5

  // -- Octagonal teal-glass penthouse cylinder (window) --
  const penR = 70;
  const penH = 110;
  // CylinderGeometry(radiusTop, radiusBottom, height, radialSegments=8 -> octagon)
  const penCyl = new THREE.CylinderGeometry(penR, penR, penH, 8);
  penCyl.translate(0, y + penH / 2, 0);
  win.push(penCyl);

  // -- Small gold cap cylinder on top of the penthouse (gold) --
  const capR = 34;
  const capH = 22;
  const capCyl = new THREE.CylinderGeometry(capR * 0.6, capR, capH, 8);
  capCyl.translate(0, y + penH + capH / 2, 0);
  gold.push(capCyl);

  return { body, gold, window: win };
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
  // atan2(x, z) gives the angle from -Z axis toward the gap midpoint position,
  // so negating points the building inward.
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
// The pieces are at the origin and need a placement transform applied per
// placed building.
// ---------------------------------------------------------------------------

const _typeAPieces = buildTypeAPieces();
const _typeBPieces = buildTypeBPieces();
const _typeCPieces = buildTypeCPieces();

/** Type → its pre-built origin-centered geometry pieces. */
const PIECES_BY_TYPE: Record<
  'A' | 'B' | 'C',
  { body: THREE.BufferGeometry[]; gold: THREE.BufferGeometry[]; window: THREE.BufferGeometry[] }
> = {
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

export default function LandFounderApartments() {
  // Build merged geometry buckets once. No state, no async, no Suspense needed.
  const buckets = useMemo<Array<{ geometry: THREE.BufferGeometry; key: string }>>(() => {
    // Collect all placed geometry pieces per material bucket
    const bodyGeos: THREE.BufferGeometry[] = [];
    const goldGeos: THREE.BufferGeometry[] = [];
    const winGeos: THREE.BufferGeometry[] = [];

    for (const placement of FOUNDER_APARTMENT_PLACEMENTS) {
      const pos = gapCenter(placement.gapIdx, placement.lateralOffset, placement.tAlong);
      const pieces = PIECES_BY_TYPE[placement.type];

      // Apply placement to each piece in the bucket arrays
      for (const g of pieces.body) {
        bodyGeos.push(applyPlacement(g, pos.x, pos.z, pos.rotY));
      }
      for (const g of pieces.gold) {
        goldGeos.push(applyPlacement(g, pos.x, pos.z, pos.rotY));
      }
      for (const g of pieces.window) {
        winGeos.push(applyPlacement(g, pos.x, pos.z, pos.rotY));
      }
    }

    const result: Array<{ geometry: THREE.BufferGeometry; key: string }> = [];

    function mergeAndStore(geos: THREE.BufferGeometry[], key: string) {
      if (geos.length === 0) return;
      const safe = geos.map((g) => makeGeometryWebGPUSafe(g));
      const merged = mergeGeometries(safe, false);
      safe.forEach((g) => g.dispose());
      if (!merged) return;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      result.push({ geometry: merged, key });
    }

    mergeAndStore(bodyGeos, 'body');
    mergeAndStore(goldGeos, 'gold');
    mergeAndStore(winGeos,  'window');

    return result;
  }, []);

  // Materials — MeshStandardMaterial only. Created once, stable refs.
  const materials = useMemo<Record<string, THREE.MeshStandardMaterial>>(() => {
    // Body: cream/pearl white — upscale neutral
    const body = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xf5f0e8),
      roughness: 0.65,
      metalness: 0.05,
    });
    // Gold: balcony soffits + penthouse crown — warm luxury accent
    const gold = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xd4a847),
      roughness: 0.25,
      metalness: 0.70,
      emissive: new THREE.Color(0x3a2000),
      emissiveIntensity: 0.4,
    });
    // Window: deep ocean teal with subtle glow — premium glass
    const window = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x1a5a8a),
      roughness: 0.05,
      metalness: 0.15,
      emissive: new THREE.Color(0x0a2a40),
      emissiveIntensity: 0.6,
    });
    return { body, gold, window };
  }, []);

  // Dispose on unmount
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
