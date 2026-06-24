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
 * ARCHITECTURE — 3 TYPES (this file ships TYPE A only for first sign-off pass):
 *
 *   Type A — "Coral Spire Tower"
 *     Slim art-deco luxury tower. Stepped 3-tier podium base, tall narrow shaft,
 *     4 cantilevered balcony bands, tapered penthouse crown. ~700wu tall.
 *     Materials: cream body, gold balcony soffits (emissive), teal window bands (emissive).
 *
 *   Type B — "Terraced Reef Block" (future pass)
 *     Wide horizontal luxury complex. Wide rectangular base with 3 step-back
 *     terraces, horizontal terrace rail detail, flat-roof penthouse cap. ~480wu tall.
 *
 *   Type C — "Ziggurat Penthouse" (future pass)
 *     Stepped pyramid massing with 5 tiers, cornice ring details, octagonal glass
 *     penthouse on top. ~600wu tall.
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
 *   - Target draw-call delta: ~5-6 (3 material buckets x Type A; collapses
 *     further as Types B and C share the same gold + window material colors).
 *
 * PLACEMENT — Type A, 3 representative positions in the founder ring:
 *   Gap 0-1 (between parcels 0 and 1), gap 4-5, gap 7-8.
 *   This gives one on the north edge, one on the east, one on the south-west,
 *   covering all visible quadrants for the sign-off review.
 *   Full ring fill (all 10 gaps, all 3 types) follows after founder approval.
 *
 * Iris Xe / WebGPU invariants:
 *   - All geometry is BoxGeometry or CylinderGeometry — both safe.
 *   - All materials are MeshStandardMaterial — no ShaderMaterial/NodeMaterial.
 *   - Buildings are purely static — no animation, no useFrame usage.
 *
 * Draw-call accounting (Type A, 3 placements):
 *   Body (cream):           1 merged draw call
 *   Gold balcony soffits:   1 merged draw call  (emissive 0x3a2000)
 *   Teal window bands:      1 merged draw call  (emissive 0x0a2a40)
 *   TOTAL: 3 draw calls for 3 buildings. Sub-5 target met with headroom.
 *   When Types B/C added: same 3 material buckets (same hex colors) = still 3 draw calls.
 *   Adding per-type variant materials: at worst 3 types x 3 buckets = 9, well under 12-15.
 *
 * (2026-06-24 — land-builder-economics: founder ring luxury apartment pass P1.
 *  Type A only, 3 positions. Sign off before building Types B+C + full fill.)
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
const FOUNDER_EXCL_R = (FOUNDER_FOOT_TILES / 2 + 2) * TILE_SIZE; // 704wu

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
//   Footprint:     280wu (podium base, well under FOUNDER_EXCL_R of 704wu from parcel)
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

// ---------------------------------------------------------------------------
// Placement table — Type A, 3 representative positions in the founder ring.
// One north (gap 0), one east (gap 2), one south-west (gap 7).
// lateralOffset: positive = outside the ring frame line, negative = inside.
// Using small offsets to stagger the buildings slightly for visual variety.
// ---------------------------------------------------------------------------

interface ApartmentPlacement {
  type: 'A'; // Type B and C will be added in the next pass
  gapIdx: number;
  lateralOffset: number;
  tAlong: number; // 0-1, position along the gap (0.5 = midpoint)
}

const FOUNDER_APARTMENT_PLACEMENTS: readonly ApartmentPlacement[] = [
  // Gap 0: between parcels 0 (top-left corner) and 1 (top edge).
  // Placed slightly outside the ring frame.
  { type: 'A', gapIdx: 0, lateralOffset: 200, tAlong: 0.5 },
  // Gap 3: between parcels 3 (right edge) and 4 (right edge, going down).
  // Placed inside the ring (toward center).
  { type: 'A', gapIdx: 3, lateralOffset: -180, tAlong: 0.48 },
  // Gap 7: between parcels 7 (bottom-left area) and 8 (left edge).
  // Placed outside, slightly off-center along the gap.
  { type: 'A', gapIdx: 7, lateralOffset: 220, tAlong: 0.52 },
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

      // Apply placement to each piece in the bucket arrays
      for (const g of _typeAPieces.body) {
        bodyGeos.push(applyPlacement(g, pos.x, pos.z, pos.rotY));
      }
      for (const g of _typeAPieces.gold) {
        goldGeos.push(applyPlacement(g, pos.x, pos.z, pos.rotY));
      }
      for (const g of _typeAPieces.window) {
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
