'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useNpcStore, PLAYER_NPC_ID } from '@/stores/npc';
import { usePlayerStore } from '@/stores/players';
import { useLodStore } from '@/stores/lod';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

/**
 * Iris Xe full-skeleton VRM/GLB cap for wandering entities (excludes the 10
 * always-rendered building residents and the local player avatar). Anything
 * beyond this count flips to the proxy mesh. 14 is the proven baseline cast.
 */
const FULL_CAP = 14;

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

interface Candidate {
  id: string;
  x: number;
  y: number;
  distSq: number;
}

const _candidates: Candidate[] = [];

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
      useLodStore.getState().setFullSet(new Set());
      tierHistoryRef.current.clear();
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

    _candidates.length = 0;

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
      _candidates.push({ id: n.id, x: wx, y: wz, distSq });
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
      _candidates.push({ id: p.sessionId, x: wx, y: wz, distSq });
    }

    _candidates.sort((a, b) => a.distSq - b.distSq);

    // Provisional tier assignment from sort.
    // Then apply hysteresis: if an entity is flipping, only allow the flip
    // when HYSTERESIS_MS has elapsed since its last flip. Otherwise hold
    // the previous tier.
    const fullSet = new Set<string>();

    // First pass: walk candidates in sort order, assign provisional tier
    // (top FULL_CAP = full; rest = proxy), and apply hysteresis.
    for (let i = 0; i < _candidates.length; i++) {
      const c = _candidates[i];
      const provisional: 'full' | 'proxy' = i < FULL_CAP ? 'full' : 'proxy';
      const prev = history.get(c.id);
      let effective: 'full' | 'proxy';
      if (!prev) {
        // First sighting — accept provisional and stamp the timestamp.
        effective = provisional;
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
      if (effective === 'full') fullSet.add(c.id);
    }

    // GC tier history entries for entities that disappeared from the candidate
    // pool (left the room, died, despawned). Lazy — only when the map grows
    // past a small threshold so we don't pay this every frame.
    if (history.size > 64) {
      const seen = new Set(_candidates.map((c) => c.id));
      for (const id of history.keys()) {
        if (!seen.has(id)) history.delete(id);
      }
    }

    // Write to the store — setFullSet bails out cheaply when membership is
    // unchanged (size match + every member present). Renderers subscribing
    // via `useLodStore((s) => s.fullSet.has(id))` re-render at most once
    // per per-entity tier flip.
    useLodStore.getState().setFullSet(fullSet);
  });

  return null;
}
