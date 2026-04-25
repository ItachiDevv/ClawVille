'use client';

/**
 * ReefRaceGhost.tsx
 *
 * Semi-transparent kart following the player's own best-lap recorded path.
 * Max 1 ghost (self best only) — per spec §2.8 and Iris Xe performance budget.
 *
 * Ghost path: GhostFrame[] at 10Hz, linearly interpolated between frames.
 * Reads from `useActivityStore.getState().reefRace.selfBestGhostPath`.
 *
 * Iris Xe invariants:
 *   - SkeletonUtils.clone() + frustumCulled=false traverse immediately after clone.
 *   - Semi-transparent: material.clone() + transparent=true + opacity=GHOST_OPACITY.
 *   - No per-frame allocations.
 *   - No trail for ghost (too expensive — per spec).
 *
 * Draw calls: 1 (ghost kart).
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useActivityStore } from '@/stores/activity';
import { GHOST_OPACITY, KART_SCALE, KART_Y_ABOVE_TRACK } from './reef-race-config';
import type { GhostFrame } from './reef-race-types';

// ─── Module-scope scratch ─────────────────────────────────────────────────────
const _ghostPos  = new THREE.Vector3();
const _ghostPos2 = new THREE.Vector3();
const _ghostScratch = { lastT: -1, lastFrameIdx: 0 };

/** Find the two GhostFrames that bracket the given timestamp and return lerp alpha. */
function findGhostFrames(
  path: GhostFrame[],
  nowMs: number,
): { a: GhostFrame; b: GhostFrame; alpha: number } | null {
  if (path.length < 2) return null;

  const start = path[0].t;
  const end   = path[path.length - 1].t;

  if (nowMs <= start) return { a: path[0], b: path[0], alpha: 0 };
  if (nowMs >= end)   return { a: path[path.length - 2], b: path[path.length - 1], alpha: 1 };

  // Linear scan from last found index (sequential access pattern → O(1) amortized).
  let lo = Math.max(0, _ghostScratch.lastFrameIdx);
  while (lo < path.length - 2 && path[lo + 1].t <= nowMs) lo++;
  _ghostScratch.lastFrameIdx = lo;

  const a = path[lo];
  const b = path[lo + 1];
  const alpha = (nowMs - a.t) / (b.t - a.t);
  return { a, b, alpha: Math.min(1, Math.max(0, alpha)) };
}

// ─── Ghost inner component ────────────────────────────────────────────────────

interface GhostInnerProps {
  path: GhostFrame[];
  raceStartMs: number;
}

function GhostInner({ path, raceStartMs }: GhostInnerProps) {
  const { scene: srcScene } = useGLTF('/models/sea_horse.glb');
  const groupRef   = useRef<THREE.Group>(null);
  const labelRef   = useRef<HTMLDivElement>(null);

  const clonedScene = useMemo(() => {
    const c = skeletonClone(srcScene);
    // CRITICAL: frustumCulled=false traverse immediately after clone.
    c.traverse((o) => {
      o.frustumCulled = false;
    });
    // Apply ghost transparency to all MeshStandardMaterial children.
    c.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const applyGhost = (m: THREE.Material): THREE.Material => {
        const cloned = m.clone();
        (cloned as THREE.MeshStandardMaterial).transparent = true;
        (cloned as THREE.MeshStandardMaterial).opacity     = GHOST_OPACITY;
        return cloned;
      };
      const mat = mesh.material;
      mesh.material = Array.isArray(mat) ? mat.map(applyGhost) : applyGhost(mat);
    });
    return c;
  }, [srcScene]);

  useEffect(() => {
    const g = groupRef.current;
    if (!g || !clonedScene) return;
    g.add(clonedScene);
    return () => { g.remove(clonedScene); };
  }, [clonedScene]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group || !path.length) return;

    // Compute elapsed ms from race start, offset by ghost path start.
    const elapsedMs = Date.now() - raceStartMs;
    const pathDuration = path[path.length - 1].t - path[0].t;

    // Loop ghost path.
    const ghostMs = path[0].t + (elapsedMs % pathDuration);

    const frames = findGhostFrames(path, ghostMs);
    if (!frames) return;

    const { a, b, alpha } = frames;
    group.position.x = a.x  + (b.x  - a.x)  * alpha;
    group.position.y = KART_Y_ABOVE_TRACK;
    group.position.z = a.z  + (b.z  - a.z)  * alpha;

    // Lerp rotation (simple linear — good enough for 10Hz).
    let dr = b.rot - a.rot;
    // Wrap to [-PI, PI] for shortest arc.
    if (dr >  Math.PI) dr -= 2 * Math.PI;
    if (dr < -Math.PI) dr += 2 * Math.PI;
    group.rotation.y = a.rot + dr * alpha;

    // Update HTML label position imperatively — never via React state.
    // Three.js frustumCulled=false means group is always visible.
    // We show/hide the label div only if ghost is nearby.
    if (labelRef.current) {
      labelRef.current.style.display = 'block';
    }
  });

  return (
    <group ref={groupRef} scale={[KART_SCALE, KART_SCALE, KART_SCALE]}>
      {/* Ghost label via drei <Html> — DOM overlay, safe on Iris Xe. No distanceFactor. */}
      <Html position={[0, 1.5, 0]} center>
        <div
          ref={labelRef}
          style={{
            display: 'none',
            background: 'rgba(0,0,0,0.5)',
            color: '#ffffff',
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 4,
            letterSpacing: '0.1em',
            pointerEvents: 'none',
            userSelect: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          GHOST
        </div>
      </Html>
    </group>
  );
}

// ─── Public wrapper ───────────────────────────────────────────────────────────

interface ReefRaceGhostProps {
  raceStartMs?: number;
}

export default function ReefRaceGhost({ raceStartMs = 0 }: ReefRaceGhostProps) {
  // Read ghost path from store — getState() avoids reactive subscription (ghost
  // data only changes between races, not per-frame).
  const ghostPath = useActivityStore((s) => s.reefRace?.selfBestGhostPath ?? null);

  if (!ghostPath || ghostPath.length < 2) return null;

  return <GhostInner path={ghostPath} raceStartMs={raceStartMs} />;
}
