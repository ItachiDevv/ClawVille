// ---------------------------------------------------------------------------
// arena-terrain-decorations.ts — pure, deterministic seabed decoration scatter.
//
// No React, no renderer, no GLB loads: arena-terrain.tsx renders the entries
// this module returns, and arena-terrain-decorations.test.ts pins placement.
// ---------------------------------------------------------------------------

import {
  KELP_FOREST_PORTAL_PROMPT_RADIUS_WU,
  KELP_FOREST_PORTAL_WORLD_CENTER,
  LAND_PARCELS,
  SPAWN_PX,
  WORLD_CENTER_PX,
} from '@clawville/shared';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';
import { getAllColliders } from '@/lib/three/collision/world-colliders';
import {
  CHARACTER_POSITIONS,
  COVE_EXIT_WORLD_X,
  COVE_EXIT_WORLD_Z,
  TALK_RADIUS_WORLD,
} from '@/lib/three/character-positions';
import {
  TRADING_FLOOR_DOOR_WORLD,
  TRADING_FLOOR_PROMPT_RADIUS_WU,
} from '@/lib/three/trading-floor/trading-floor-location';

/** Seeded PRNG for deterministic terrain */
export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ---------------------------------------------------------------------------
// Procedural decoration placement in the visible 800-3800 wu band around the
// plaza. Seeded RNG = deterministic placement on every client. Keeps clear of
// buildings, building approach lanes, residents, entrances, the spawn point,
// town props and land parcels (founder rule 2026-10-06).
// ---------------------------------------------------------------------------
export interface DecoEntry {
  model: string;
  x: number;
  z: number;
  /** Target world max-dimension in wu (see DECO_TYPES). */
  size: number;
  rotY: number;
}

// Decoration models — minSize/maxSize are the TARGET world max-dimension in wu.
// arena-terrain.tsx divides by each GLB's measured native max-dimension, so a
// model renders at this size whatever unit its author used.
// 2026-10-06: the old table held raw scale factors (2-15) and assumed native
// sizes of ~5-10 units; the measured native max-dims are 0.43 (chest) to 86
// (crayfish), so props rendered 1-860 wu. Ranges = old scale range × 10 wu
// (the reference the old comment used: coral cap 15 → 150 wu), capped at the
// documented 150 wu. For scale: a VRM avatar is 179 wu tall.
export const DECO_TYPES = [
  // Coral — moderate presence
  { model: '/models/coral-reef1-ktx.glb?v=2', weight: 3, minSize: 40, maxSize: 150 },
  { model: '/models/coral-reef2-ktx.glb?v=2', weight: 3, minSize: 30, maxSize: 130 },
  { model: '/models/coral-reef3-ktx.glb?v=2', weight: 3, minSize: 30, maxSize: 120 },
  // Kelp — tall accent
  { model: '/models/kelp.glb',                weight: 3, minSize: 60, maxSize: 150 },
  // Shells — clusters of small to medium
  { model: '/models/building-shell-ktx.glb?v=2',    weight: 5, minSize: 20, maxSize: 120 },
  { model: '/models/building-seashell-ktx.glb?v=2', weight: 5, minSize: 20, maxSize: 120 },
  // Anchors — scattered singles
  { model: '/models/building-anchor.glb',     weight: 4, minSize: 30, maxSize: 140 },
  // Barrels — common ocean-floor clutter
  { model: '/models/building-barrel.glb',     weight: 4, minSize: 30, maxSize: 100 },
  // Chests — treasure accents
  { model: '/models/building-chest.glb',      weight: 4, minSize: 30, maxSize: 120 },
  // Lanterns — ambient props
  { model: '/models/building-lantern-ktx.glb?v=2', weight: 3, minSize: 40, maxSize: 120 },
  // Crayfish — scattered critters
  { model: '/models/crayfish-ktx.glb?v=2',    weight: 3, minSize: 30, maxSize: 100 },
  // Tower2 — distinctive small towers, rare
  { model: '/models/building-tower2.glb',     weight: 2, minSize: 40, maxSize: 140 },
  // Shipwrecks and submarines are FIXED LANDMARKS in arena-terrain.tsx (disabled).
];

/**
 * The seabed decorations follow the same switch as the other ground cover
 * (MergedSeaweed, the NE kelp forest): `showGroundCover` (the `groundCover`
 * perf flag, which the adaptive governor clears at tier 1) AND the device
 * profile's `ambientGroundCover` (false on phones and tablets). When false,
 * the decoration subtree is not mounted, so its 12 GLBs are not fetched.
 */
export function seabedDecorationsEnabled(
  showGroundCover: boolean,
  profile: { readonly ambientGroundCover: boolean },
): boolean {
  return showGroundCover && profile.ambientGroundCover;
}

/**
 * Uniform scale + world Y that render a model at `size` wu max-dimension with
 * its lowest point on the sand baseline. `nativeMaxDim` / `nativeMinY` come
 * from the GLB scene's world bounding box. Returns null for a degenerate box.
 */
export function decorationTransform(
  size: number,
  nativeMaxDim: number,
  nativeMinY: number,
  floorY = -2,
): { scale: number; y: number } | null {
  if (!(nativeMaxDim > 0) || !Number.isFinite(nativeMaxDim) || !Number.isFinite(nativeMinY)) return null;
  const scale = size / nativeMaxDim;
  return { scale, y: floorY - nativeMinY * scale };
}

// Building exclusion circles (world coords) — radius 2 × zone side (896 wu) around
// each building centre. The collider and lane checks below are the tighter rules.
const HALF_MW = MAP_WIDTH / 2;
const HALF_MH = MAP_HEIGHT / 2;
// Derive exclusion zones from canonical tilemap-data buildingZones (single source of truth)
const BUILDING_ZONES = buildingZones.map(z => ({
  cx: -HALF_MW + (z.x + z.width / 2) * TILE_SIZE,
  cz: -HALF_MH + (z.y + z.height / 2) * TILE_SIZE,
  radius: Math.max(z.width, z.height) * TILE_SIZE * 2.0,
}));

export function isNearBuilding(x: number, z: number): boolean {
  for (const b of BUILDING_ZONES) {
    const dx = x - b.cx;
    const dz = z - b.cz;
    if (dx * dx + dz * dz < b.radius * b.radius) return true;
  }
  return false;
}

// Village centre = world origin (centre tile 352 of the 704-tile grid).
const VILLAGE_CX = 0;
const VILLAGE_CZ = 0;
// No decorations within this radius — keeps the immediate town plaza clear.
// Phase 6.2 (2026-05-18): reduced from 1500 to 800. Inside 800 wu stays clear for
// the NPC/guide/stall cluster; the town-prop colliders below keep the stalls and
// the pavilion (r 1200-1300 wu) clear too.
export const DECO_INNER_EXCLUSION_R = 800;

// Hard outer distance cap. 3800 wu keeps every prop inside the fog-free zone
// (fog.near 5000 wu) and inside the building ring (R 4160 wu; collider inner
// edges reach r ~3200 wu, kept clear by the collider check).
export const DECO_OUTER_R = 3800;

/** Gap kept around every collider AABB: largest prop half-size (~75 wu) + a walk gap. */
export const DECO_COLLIDER_CLEARANCE = 200;

/** Half-width of the walk lane from the plaza to each building (and its door). */
export const DECO_LANE_HALF_WIDTH = 400;

// Every building's unit direction from the plaza + distance (lane geometry).
const BUILDING_LANES = BUILDING_ZONES.map((b) => {
  const len = Math.hypot(b.cx, b.cz);
  return { ux: b.cx / len, uz: b.cz / len, len };
});

// Circles kept clear around the entrances' prompt bands.
const ENTRANCE_CLEARINGS: ReadonlyArray<{ x: number; z: number; r: number }> = [
  {
    x: KELP_FOREST_PORTAL_WORLD_CENTER.x,
    z: KELP_FOREST_PORTAL_WORLD_CENTER.z,
    r: KELP_FOREST_PORTAL_PROMPT_RADIUS_WU,
  },
  { x: TRADING_FLOOR_DOOR_WORLD.x, z: TRADING_FLOOR_DOOR_WORLD.z, r: TRADING_FLOOR_PROMPT_RADIUS_WU },
  // Cove tunnel mouth: the prompt band runs x -3640..-3180, |z| <= 150; the
  // exit spawn sits at x -3150. 500 wu around the exit covers the whole band.
  { x: COVE_EXIT_WORLD_X, z: COVE_EXIT_WORLD_Z, r: 500 },
];

const SPAWN_WORLD_X = SPAWN_PX.x - WORLD_CENTER_PX.x;
const SPAWN_WORLD_Z = SPAWN_PX.y - WORLD_CENTER_PX.y;

function insideBox(
  x: number,
  z: number,
  cx: number,
  cz: number,
  halfX: number,
  halfZ: number,
): boolean {
  return Math.abs(x - cx) < halfX && Math.abs(z - cz) < halfZ;
}

/**
 * True when a decoration may stand at (x, z): inside the visible band and clear
 * of buildings, approach lanes, residents, entrances, spawn, town props and
 * land parcels. Pure; runs only at module load.
 */
export function isDecorationSiteClear(x: number, z: number): boolean {
  const dcx = x - VILLAGE_CX;
  const dcz = z - VILLAGE_CZ;
  const rSq = dcx * dcx + dcz * dcz;
  if (rSq < DECO_INNER_EXCLUSION_R * DECO_INNER_EXCLUSION_R) return false;
  if (rSq > DECO_OUTER_R * DECO_OUTER_R) return false;
  if (Math.hypot(x - SPAWN_WORLD_X, z - SPAWN_WORLD_Z) < DECO_INNER_EXCLUSION_R) return false;
  if (isNearBuilding(x, z)) return false;

  const pad = DECO_COLLIDER_CLEARANCE;
  for (const c of getAllColliders()) {
    if (insideBox(x, z, c.centerX, c.centerZ, c.halfX + pad, c.halfZ + pad)) return false;
  }
  for (const p of LAND_PARCELS) {
    const half = p.size / 2 + pad;
    if (insideBox(x, z, p.cx, p.cz, half, half)) return false;
  }
  for (const lane of BUILDING_LANES) {
    const t = x * lane.ux + z * lane.uz;
    if (t <= 0 || t >= lane.len) continue;
    if (Math.abs(x * lane.uz - z * lane.ux) < DECO_LANE_HALF_WIDTH) return false;
  }
  const residentR = TALK_RADIUS_WORLD + pad;
  for (const r of Object.values(CHARACTER_POSITIONS)) {
    if (Math.hypot(x - r.worldX, z - r.worldZ) < residentR) return false;
  }
  for (const e of ENTRANCE_CLEARINGS) {
    if (Math.hypot(x - e.x, z - e.z) < e.r + pad) return false;
  }
  return true;
}

/** Generate all decorations with cluster-based organic scatter.
 *
 *  Algorithm (mirrors the merged-seaweed multivariant pattern):
 *  1. Place N_CLUSTERS cluster centres in the visible band: polar sample,
 *     radius area-uniform in [inner + CLUSTER_RADIUS, outer - CLUSTER_RADIUS],
 *     angle uniform; a centre is redrawn until its site is clear.
 *  2. For each decoration attempt, pick a random cluster centre.
 *  3. Sample distance from that centre using a triangular distribution
 *     (rng() + rng()) * CLUSTER_RADIUS — biases placements toward the centre,
 *     producing Gaussian-like falloff without an actual Gaussian.
 *  4. Reject the sample unless isDecorationSiteClear() and the spacing rule pass.
 *
 *  2026-10-06: the centres used to spread over ±MAP_WIDTH*0.7 (±15770 wu since
 *  the world grew to 22528 wu on 2026-06-15), so no sample reached the band and
 *  the scatter rendered 0 props. Deriving the centres from the band fixes that
 *  for any future map size.
 */
export function generateDecorations(): DecoEntry[] {
  const rng = seededRandom(12345);
  const totalWeight = DECO_TYPES.reduce((s, d) => s + d.weight, 0);
  const entries: DecoEntry[] = [];
  // Update WorldContent.md §5 when you change.
  const TARGET_COUNT = 60;

  // ---- Cluster centres ----
  const N_CLUSTERS     = 12;
  const CLUSTER_RADIUS = 280; // world-space units; controls patch spread
  const R_MIN_SQ = (DECO_INNER_EXCLUSION_R + CLUSTER_RADIUS) ** 2;
  const R_MAX_SQ = (DECO_OUTER_R - CLUSTER_RADIUS) ** 2;
  const clusters: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < N_CLUSTERS; i++) {
    for (let tries = 0; tries < 200; tries++) {
      const r = Math.sqrt(R_MIN_SQ + rng() * (R_MAX_SQ - R_MIN_SQ));
      const a = rng() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!isDecorationSiteClear(x, z)) continue;
      clusters.push({ x, z });
      break;
    }
  }
  if (clusters.length === 0) return entries;

  // Pick a model based on weighted random
  function pickModel() {
    let r = rng() * totalWeight;
    for (const dt of DECO_TYPES) {
      r -= dt.weight;
      if (r <= 0) return dt;
    }
    return DECO_TYPES[0];
  }

  // Minimum spacing between decorations — tighter than before for denser look
  const MIN_SPACING_SQ = 35 * 35;

  let attempts = 0;
  while (entries.length < TARGET_COUNT && attempts < 1200) {
    attempts++;

    // Pick a random cluster centre
    const cluster = clusters[Math.floor(rng() * clusters.length)];

    // Triangular distribution for distance: (rng()+rng()) biases toward 0
    const dist  = (rng() + rng()) * CLUSTER_RADIUS;
    const angle = rng() * Math.PI * 2;
    const x = cluster.x + Math.cos(angle) * dist;
    const z = cluster.z + Math.sin(angle) * dist;

    if (!isDecorationSiteClear(x, z)) continue;

    // Minimum spacing check
    const tooClose = entries.some(e => {
      const dx = e.x - x;
      const dz = e.z - z;
      return dx * dx + dz * dz < MIN_SPACING_SQ;
    });
    if (tooClose) continue;

    const dt   = pickModel();
    const size = dt.minSize + rng() * (dt.maxSize - dt.minSize);
    entries.push({ model: dt.model, x, z, size, rotY: rng() * Math.PI * 2 });
  }

  return entries;
}
