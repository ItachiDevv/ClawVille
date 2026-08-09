/**
 * land-salvage-nodes.ts — render-layer helpers over the FROZEN shared
 * `SALVAGE_NODES` topology (`@clawville/shared`, `packages/shared/src/
 * constants/land-salvage.ts`, P7a, backend lane commit `7eec61cd`).
 *
 * RECONCILED 2026-08-09: this file previously carried a client-local
 * deterministic scatter as a stand-in — DELETED now that the real,
 * server-authoritative 48-node topology (3 square rings: shallows/shelf/
 * deep) landed in `packages/shared`. Node positions, ids, caps and cooldown
 * all come from the shared package now; nothing here invents world state.
 */

import * as THREE from 'three';
import {
  SALVAGE_APPROACH_RANGE_WU,
  SALVAGE_NODES,
  getSalvageNode,
  type SalvageNode,
  type SalvageNodeBand,
} from '@clawville/shared';

export type SalvageNodeLook = 'shells' | 'driftwood' | 'coral';

/** Band → visual look. Thematic: nearer = simpler, farther = more exotic. */
const BAND_LOOK: Readonly<Record<SalvageNodeBand, SalvageNodeLook>> = {
  shallows: 'shells',
  shelf: 'driftwood',
  deep: 'coral',
};

export function salvageNodeLook(band: SalvageNodeBand): SalvageNodeLook {
  return BAND_LOOK[band];
}

/**
 * The affordance shows within a slightly TIGHTER radius than the server's
 * actual `SALVAGE_APPROACH_RANGE_WU` (260 wu) — a safety margin against the
 * avatar-position render read being a tick or two stale relative to what has
 * synced to the server, so the pill never invites a claim attempt the server
 * is about to refuse as `out_of_range` for a position that has already
 * moved on. The real approach POST always sends the live position and the
 * server is the sole authority on range; this only governs when the CLIENT
 * decides to show the prompt.
 */
export const SALVAGE_PROXIMITY_SHOW_RADIUS_WU = SALVAGE_APPROACH_RANGE_WU * 0.85;
const SALVAGE_PROXIMITY_SHOW_RADIUS_SQ =
  SALVAGE_PROXIMITY_SHOW_RADIUS_WU * SALVAGE_PROXIMITY_SHOW_RADIUS_WU;

export function getSalvageNodeById(id: string): SalvageNode | null {
  return getSalvageNode(id);
}

/** O(48) nearest-node scan — trivial at the 5 Hz LandProximityTracker cadence. */
export function findNearestSalvageNode(x: number, z: number): SalvageNode | null {
  let nearest: SalvageNode | null = null;
  let nearestDistSq = SALVAGE_PROXIMITY_SHOW_RADIUS_SQ;
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

/** Node's world position at seabed height, for render placement. */
export function salvageNodeWorldPosition(node: SalvageNode, floorY: number): THREE.Vector3 {
  return new THREE.Vector3(node.x, floorY, node.z);
}

/**
 * Shared, imperative, non-reactive read of the active body's CURRENT centered
 * world position — written by `LandProximityTracker` (World3DCanvas.tsx)
 * every tick it already runs (5 Hz), read by `SalvageGatherPill`'s approach
 * poll (~1 Hz). A plain mutable object rather than a zustand field for the
 * same reason `avatarPositionRef` (stores/game.ts) is: this is read at a
 * fixed low cadence by one consumer, not something that should fan out a
 * React re-render on every 5 Hz proximity tick.
 */
export const salvageApproachPositionRef = { x: 0, z: 0 };
