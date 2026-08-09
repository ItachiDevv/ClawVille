/**
 * land-salvage-nodes.ts — client-side seabed salvage node topology.
 *
 * TEMP STAND-IN (P7b render lane, land-salvage-web worktree, 2026-08-09).
 * The design (`gamification-pass-2026-08-09.md` §2.7) makes `SALVAGE_NODES` a
 * VERSIONED SHARED constant owned by the backend lane (`packages/shared`),
 * imported by the renderer, the claim service AND the hosted target service —
 * "KIT_CHUNKS is client-local" is explicitly called out as the thing this is
 * NOT supposed to be. It had not landed in `packages/shared` at the time this
 * file was written (`grep -r SALVAGE_NODES packages/shared` — no match), and
 * `packages/shared` is outside this lane's file boundary.
 *
 * RECONCILE AT MERGE: once `SALVAGE_NODES` exists in `@clawville/shared`,
 * delete this file's `SALVAGE_NODES` export and the generator below, and
 * import the real constant instead. Keep this file's `SalvageNodeSlot`
 * shape and the `salvage-node-NN` id scheme (zero-padded, 01-48) — every
 * OTHER export here (`SALVAGE_INTERACT_RADIUS_WU`, `findNearestSalvageNode`,
 * `SALVAGE_NODE_LOOKS`) is render-layer-owned and stays regardless of where
 * the node list itself comes from, mirroring how `land-kit-assets.ts` stays
 * web-owned beside the shared `KIT_PIECE_RENDER` manifest.
 *
 * THE BIGGEST RECONCILE RISK: the (x, z) position per node id below is
 * INVENTED by this lane's deterministic scatter, not sourced from the
 * backend. If the real `SALVAGE_NODES` constant places `salvage-node-01`
 * somewhere else, the visual prop and the server's claim target disagree
 * until this file is deleted in favor of the shared import. The `id` scheme
 * is chosen to make that swap a one-line change, not a rewrite.
 */

import * as THREE from 'three';
import { MAP_WIDTH, MAP_HEIGHT, buildingZones, TILE_SIZE } from '@/lib/pixi/tilemap-data';
import { LAND_PARCELS } from '@clawville/shared';

/** Matches the design's 48-node count (§2.2). */
export const SALVAGE_NODE_COUNT = 48;

/**
 * Player must be within this radius (wu) of a node's position to see the
 * gather prompt / attempt a claim. The design's signed-approach-token issue
 * range is "≤ 260 wu" (§2.5) — kept comfortably inside that so the client
 * never shows a prompt the server would refuse purely for being a few wu
 * over its own bound.
 */
export const SALVAGE_INTERACT_RADIUS_WU = 220;
const SALVAGE_INTERACT_RADIUS_SQ = SALVAGE_INTERACT_RADIUS_WU * SALVAGE_INTERACT_RADIUS_WU;

export type SalvageNodeLook = 'shells' | 'driftwood' | 'coral';
export const SALVAGE_NODE_LOOKS: readonly SalvageNodeLook[] = ['shells', 'driftwood', 'coral'];

export interface SalvageNodeSlot {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Cosmetic only — yield is per-claim random (§2.2 HMAC mod 3 + 1), never per-node. */
  readonly look: SalvageNodeLook;
  /** Per-node facing so a cluster doesn't look copy-pasted. */
  readonly yaw: number;
}

// ---------------------------------------------------------------------------
// Deterministic scatter — same exclusion technique as merged-seaweed.tsx
// (building zones + parcel footprints), seeded so node positions are STABLE
// across reloads without persisting anything server-side. If two runs of
// this module ever disagree, every claim target moves — the seed and the
// algorithm below MUST NOT change once real players can see nodes.
// ---------------------------------------------------------------------------

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const HALF_MW = MAP_WIDTH / 2;
const HALF_MH = MAP_HEIGHT / 2;

const BUILDING_ZONES = buildingZones.map((z) => ({
  cx: -HALF_MW + (z.x + z.width / 2) * TILE_SIZE,
  cz: -HALF_MH + (z.y + z.height / 2) * TILE_SIZE,
  radius: Math.max(z.width, z.height) * TILE_SIZE * 2.0,
}));

const PARCEL_ZONES = LAND_PARCELS.map((p) => ({
  cx: p.cx,
  cz: p.cz,
  radius: (p.size / 2) * Math.SQRT2 + 0.8 * TILE_SIZE,
}));

function isExcluded(x: number, z: number): boolean {
  for (const b of BUILDING_ZONES) {
    const dx = x - b.cx;
    const dz = z - b.cz;
    if (dx * dx + dz * dz < b.radius * b.radius) return true;
  }
  for (const p of PARCEL_ZONES) {
    const dx = x - p.cx;
    const dz = z - p.cz;
    if (dx * dx + dz * dz < p.radius * p.radius) return true;
  }
  return false;
}

function generateSalvageNodes(): readonly SalvageNodeSlot[] {
  const rng = seededRandom(48271);
  const nodes: SalvageNodeSlot[] = [];
  // Open-sea band: inside the map edge but leaving margin, spread across the
  // whole play area (not just outside the land rings) — the seabed is the
  // theme for the WHOLE world, not just its rim.
  const spawnHalf = Math.min(HALF_MW, HALF_MH) * 0.94;
  const MIN_NODE_SPACING = 340;
  const MIN_NODE_SPACING_SQ = MIN_NODE_SPACING * MIN_NODE_SPACING;

  let guard = 0;
  while (nodes.length < SALVAGE_NODE_COUNT && guard < 20000) {
    guard++;
    const x = (rng() * 2 - 1) * spawnHalf;
    const z = (rng() * 2 - 1) * spawnHalf;
    if (isExcluded(x, z)) continue;
    let tooClose = false;
    for (const existing of nodes) {
      const dx = x - existing.x;
      const dz = z - existing.z;
      if (dx * dx + dz * dz < MIN_NODE_SPACING_SQ) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    const look = SALVAGE_NODE_LOOKS[nodes.length % SALVAGE_NODE_LOOKS.length]!;
    nodes.push({
      id: `salvage-node-${String(nodes.length + 1).padStart(2, '0')}`,
      x,
      z,
      look,
      yaw: rng() * Math.PI * 2,
    });
  }

  return nodes;
}

export const SALVAGE_NODES: readonly SalvageNodeSlot[] = generateSalvageNodes();

const SALVAGE_NODE_BY_ID = new Map<string, SalvageNodeSlot>(
  SALVAGE_NODES.map((node) => [node.id, node]),
);

export function getSalvageNodeById(id: string): SalvageNodeSlot | null {
  return SALVAGE_NODE_BY_ID.get(id) ?? null;
}

/**
 * O(48) nearest-node scan — trivial at 5 Hz (LandProximityTracker's cadence).
 * Returns null when nothing is within `SALVAGE_INTERACT_RADIUS_WU`.
 */
export function findNearestSalvageNode(x: number, z: number): SalvageNodeSlot | null {
  let nearest: SalvageNodeSlot | null = null;
  let nearestDistSq = SALVAGE_INTERACT_RADIUS_SQ;
  for (const node of SALVAGE_NODES) {
    const dx = x - node.x;
    const dz = z - node.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearest = node;
    }
  }
  return nearest;
}

/** Node's world position at seabed height, for render + camera-distance checks. */
export function salvageNodeWorldPosition(node: SalvageNodeSlot, floorY: number): THREE.Vector3 {
  return new THREE.Vector3(node.x, floorY, node.z);
}
