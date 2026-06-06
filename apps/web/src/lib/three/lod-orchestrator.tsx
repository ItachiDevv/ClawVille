'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useNpcStore, PLAYER_NPC_ID } from '@/stores/npc';
import { usePlayerStore } from '@/stores/players';
import { useLodStore } from '@/stores/lod';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { detectLowEndGpuClass } from '@/lib/three/gpu-tier';

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

/**
 * Iris Xe full-skeleton VRM/GLB cap for wandering entities (excludes the 10
 * always-rendered building residents and the local player avatar). Anything
 * beyond this count flips to the proxy mesh. 14 is the proven baseline cast.
 */
const FULL_CAP = 14;
const LOW_END_FULL_CAP = 8;
const ACTIVE_FULL_CAP = detectLowEndGpuClass() ? LOW_END_FULL_CAP : FULL_CAP;

/**
 * Maximum game-pixel distance from the camera target at which an entity is
 * eligible for the full-VRM tier. Beyond this it goes straight to proxy
 * regardless of cap availability. 3500 wu covers the entire commons + the
 * inner building ring.
 */
const VISIBILITY_RADIUS_WU = 3500;
const VISIBILITY_RADIUS_SQ = VISIBILITY_RADIUS_WU * VISIBILITY_RADIUS_WU;

/**
 * Hysteresis window — once an entity has been demoted to proxy it cannot
 * promote back to full for this duration, and vice versa. Without this, an
 * entity sitting near the 14/15 tier boundary flickers every frame as the
 * sort order shuffles by sub-pixel distance changes. 500 ms is well above
 * the perceptual flicker threshold and short enough that "I walked closer"
 * still feels responsive.
 */
const HYSTERESIS_MS = 500;

/** Module-scope scratch — never allocated inside the per-frame loop. */
const _camPos = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _entitySphere = new THREE.Sphere(new THREE.Vector3(), 200);

/**
 * Candidate object pool — pre-allocated at module scope so the per-frame
 * useFrame can FILL existing entries (`.id = ...; .distSq = ...`) instead of
 * allocating object literals. Worst case is the entire room: 14 wanderers + 20
 * remote players = 34 entities. Pool size 64 leaves headroom for any future
 * roster bump without re-allocation.
 *
 * `_candidateCount` is the live slice length. The sort below operates on the
 * full pool but the hysteresis loop reads only `[0, _candidateCount)`.
 *
 * Pool slots not in the live slice keep their previous payload — that's
 * harmless because (a) we sort the full array but only iterate the prefix,
 * (b) the next frame overwrites positions 0..count-1 unconditionally.
 *
 * Actually we sort an Array slice — see _sortCandidates() below.
 */
interface Candidate {
  id: string;
  distSq: number;
}
const POOL_SIZE = 64;
const _candidatePool: Candidate[] = new Array(POOL_SIZE);
for (let i = 0; i < POOL_SIZE; i++) {
  _candidatePool[i] = { id: '', distSq: 0 };
}
let _candidateCount = 0;

/**
 * Module-scope sort comparator — hoisted so we don't allocate a new arrow
 * every frame. Sorts ascending by distSq (closest first).
 */
function _byDistSq(a: Candidate, b: Candidate): number {
  return a.distSq - b.distSq;
}

/**
 * Module-scope "seen" Set — used by the GC pass to test candidate membership
 * without allocating. Cleared at the start of each GC pass and re-filled from
 * the live candidate slice. Reusing this avoids the `new Set(_candidates.map(...))`
 * double allocation the audit flagged.
 */
const _seenIds = new Set<string>();

/**
 * Ping-pong full-set buffers. Each frame writes into the inactive Set, swaps,
 * and passes the active Set to `useLodStore.setFullSet`. The store's cheap
 * size+membership equality check bails out when membership is unchanged, so
 * the reference flip never propagates to renderers unless tiers actually
 * shifted. Zero per-frame `new Set()` allocation.
 *
 * Two buffers (not one) because Zustand readers may still hold a reference to
 * the previous frame's Set during their render pass — mutating it in-place
 * would risk an inconsistent read. Swapping between A and B gives consumers a
 * stable snapshot until the orchestrator's next write.
 */
const _fullSetA = new Set<string>();
const _fullSetB = new Set<string>();
let _useSetB = false;

/**
 * Distance-LOD orchestrator. Mounts inside the R3F Canvas tree. Runs every
 * frame:
 *
 *   1. Snapshot wandering NPCs (excluding the possessed PLAYER_NPC if in NPC
 *      mode — that one is rendered by the dedicated controller path) +
 *      remote players (excluding the local viewer).
 *   2. Filter to entities inside the camera frustum AND within
 *      VISIBILITY_RADIUS_WU game pixels of the camera (squared distance to
 *      avoid sqrt).
 *   3. Sort ascending by distSq.
 *   4. Top FULL_CAP → "full" tier. Rest → "proxy" tier.
 *   5. Apply hysteresis: entities flipping from full→proxy or proxy→full
 *      stick to their previous tier until HYSTERESIS_MS has elapsed since
 *      the last transition.
 *   6. Write the resulting full-tier Set to `useLodStore` if membership
 *      changed. Renderers (RemotePlayerEntry, ArenaNpcs) subscribe per-entity
 *      and only re-render when their own tier flips.
 *
 * Building residents are NEVER in the candidate pool — they're load-bearing
 * knowledge holders, render full at all times via ArenaLocationNpcs.
 */
export default function LodOrchestrator() {
  const { camera } = useThree();
  // Per-entity tier history — id → { tier, lastFlippedAt }. Mutated in place
  // across frames; cleared on unmount.
  const tierHistoryRef = useRef<Map<string, { tier: 'full' | 'proxy'; lastFlippedAt: number }>>(
    new Map(),
  );

  useEffect(() => {
    return () => {
      // Reset to empty set on unmount so a future remount starts clean.
      // One-off allocation on unmount is acceptable (vs. per-frame).
      useLodStore.getState().setFullSet(new Set());
      tierHistoryRef.current.clear();
      _fullSetA.clear();
      _fullSetB.clear();
      _seenIds.clear();
      _candidateCount = 0;
    };
  }, []);

  useFrame(() => {
    const npcs = useNpcStore.getState().npcs;
    const players = usePlayerStore.getState().players;
    const history = tierHistoryRef.current;
    const now = Date.now();

    _camPos.set(camera.position.x, camera.position.y, camera.position.z);
    _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreenMatrix);

    // Reset live slice — overwrites pool entries in place, no clear() needed.
    _candidateCount = 0;

    for (let i = 0; i < npcs.length; i++) {
      const n = npcs[i];
      // Skip the possessed-player NPC — its avatar is rendered through the
      // NpcController/avatar path and shouldn't compete for the LOD budget.
      if (n.id === PLAYER_NPC_ID) continue;
      const wx = n.x - HALF_W;
      const wz = n.y - HALF_H;
      const dx = wx - _camPos.x;
      const dz = wz - _camPos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > VISIBILITY_RADIUS_SQ) continue;
      // Frustum test using a 200wu sphere (covers head-to-toe humanoid bbox).
      _entitySphere.center.set(wx, _camPos.y, wz);
      if (!_frustum.intersectsSphere(_entitySphere)) continue;
      // Pool overflow guard — silently drop entities past POOL_SIZE. Worst
      // case (34 entities) is well under 64; logging here would spam on a
      // genuinely degenerate room. The dropped entities just don't get
      // tracked this frame, will be picked up next frame as the pool drains.
      if (_candidateCount >= POOL_SIZE) break;
      const slot = _candidatePool[_candidateCount++];
      slot.id = n.id;
      slot.distSq = distSq;
    }

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.isLocal) continue;
      const wx = p.x - HALF_W;
      const wz = p.y - HALF_H;
      const dx = wx - _camPos.x;
      const dz = wz - _camPos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > VISIBILITY_RADIUS_SQ) continue;
      _entitySphere.center.set(wx, _camPos.y, wz);
      if (!_frustum.intersectsSphere(_entitySphere)) continue;
      if (_candidateCount >= POOL_SIZE) break;
      const slot = _candidatePool[_candidateCount++];
      slot.id = p.id;
      slot.distSq = distSq;
    }

    // Tombstone stale pool slots so the sort doesn't shuffle their old distSq
    // values into the live range. Slots past _candidateCount get distSq =
    // +Infinity and id = '' — they fall to the tail of the sorted array,
    // leaving [0, _candidateCount) as the in-order live slice. Empty-id
    // tombstones are also a defensive guard: if [0, _candidateCount) ever
    // overruns (it shouldn't — _candidateCount is the exact pre-sort live
    // count), reads of `slot.id === ''` will fail the `history.get('')`
    // path harmlessly.
    for (let i = _candidateCount; i < POOL_SIZE; i++) {
      const slot = _candidatePool[i];
      slot.id = '';
      slot.distSq = Infinity;
    }

    // Sort the full pool with the module-scope comparator (no per-frame arrow
    // allocation). V8 TimSort is in-place + stable — no internal array
    // allocation. Sorting 64 entries (≤34 live + ≥30 tombstoned to +Infinity)
    // is < 200 comparisons worst case; trivial vs. the per-frame alloc cost
    // we're eliminating. After sort, [0, _candidateCount) is the live slice
    // ascending by distSq.
    _candidatePool.sort(_byDistSq);

    // Tier assignment + hysteresis. Walks the live slice in distance order.
    // Build the inactive Set ping-pong buffer.
    const next = _useSetB ? _fullSetA : _fullSetB;
    next.clear();

    for (let i = 0; i < _candidateCount; i++) {
      const c = _candidatePool[i];
      const provisional: 'full' | 'proxy' = i < ACTIVE_FULL_CAP ? 'full' : 'proxy';
      const prev = history.get(c.id);
      let effective: 'full' | 'proxy';
      if (!prev) {
        // First sighting — accept provisional and stamp the timestamp.
        effective = provisional;
        // Note: this `history.set` allocates a small `{tier, lastFlippedAt}`
        // object. It only fires on entity FIRST SIGHTING (not every frame),
        // so allocation cost is bounded by room turnover, not frame rate.
        // GC'd by the pass below when entities leave.
        history.set(c.id, { tier: provisional, lastFlippedAt: now });
      } else if (prev.tier === provisional) {
        effective = provisional;
      } else {
        // Tier wants to flip — only allow if hysteresis window elapsed.
        if (now - prev.lastFlippedAt >= HYSTERESIS_MS) {
          effective = provisional;
          prev.tier = provisional;
          prev.lastFlippedAt = now;
        } else {
          effective = prev.tier;
        }
      }
      if (effective === 'full') next.add(c.id);
    }

    // GC tier history entries for entities that disappeared from the candidate
    // pool (left the room, despawned). Reuse the module-scope `_seenIds` Set
    // — clear + fill from the live slice rather than `new Set(...map(...))`.
    // Worst case 64 entries × O(1) ops = 192 ops on the GC frame.
    if (history.size > 64) {
      _seenIds.clear();
      for (let i = 0; i < _candidateCount; i++) {
        _seenIds.add(_candidatePool[i].id);
      }
      for (const id of history.keys()) {
        if (!_seenIds.has(id)) history.delete(id);
      }
    }

    // Flip ping-pong buffer and publish. setFullSet's cheap size+membership
    // equality check inside the store bails out when membership is unchanged
    // — so consumers subscribed via `useLodStore((s) => s.fullSet.has(id))`
    // only re-render on actual tier flips.
    _useSetB = !_useSetB;
    useLodStore.getState().setFullSet(next);
  });

  return null;
}
