'use client';

import { useRef, useMemo } from 'react';
import { useSceneFrame } from '@/components/three/world-stage/use-scene-frame';
import * as THREE from 'three';
import { useGameStore } from '@/stores/game';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Click-to-move INPUT removed 2026-06-21 (controls-rework).
//
// The invisible ground-click raycast plane that walked the avatar to an
// arbitrary clicked point was removed per founder direction: desktop movement
// is WASD (camera look = mouse-drag + arrow keys), mobile movement is the left
// joystick. Clicking the 3D ground no longer moves the avatar.
//
// Preserved, because they do NOT depend on this plane:
//   - Town-center click targets (bazaar → cosmetics, quest pavilion →
//     quests/bounties) keep their OWN onClick handlers
//     (bazaar-stall.tsx / quest-bounty-pavilion.tsx).
//   - The cove keeps its building/tunnel click + the walk-in flow.
//   - World-Map / minimap fast-travel + warp drive the avatar via clickPath
//     PROGRAMMATICALLY (store.setClickPath) — player-avatar.tsx still consumes
//     clickPath, so those keep working.
//
// This component now ONLY renders the path visuals (route dots + a pulsing
// destination marker) for whatever clickPath is set programmatically.
// ---------------------------------------------------------------------------
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const PATH_DOT_Y = 1.2; // slightly above ground
const DOT_RADIUS = 1.8;
const DOT_SEGMENTS = 8;
const DEST_PULSE_MIN = 2.5;
const DEST_PULSE_MAX = 4.5;
const DEST_PULSE_SPEED = 4;
const MAX_DOTS = 60; // cap rendered dots for performance

// Module-scope scratch — avoid per-frame allocations in useFrame hot paths
const _toWorldScratch = new THREE.Vector3();
const _dotMatrix = new THREE.Matrix4();
const _dotRotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

/** Convert pixel coords to Three.js world coords — writes into scratch, caller must copy immediately */
function toWorld(px: number, py: number): THREE.Vector3 {
  return _toWorldScratch.set(px - HALF_W, PATH_DOT_Y, py - HALF_H);
}

// ---------------------------------------------------------------------------
// Path dots — small cyan circles along the route
// ---------------------------------------------------------------------------
function PathDots() {
  const dotsRef = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => new THREE.CircleGeometry(DOT_RADIUS, DOT_SEGMENTS), []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0x00e5ff,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }),
    []
  );

  useSceneFrame(() => {
    const mesh = dotsRef.current;
    if (!mesh) return;

    const store = useGameStore.getState();
    const { clickPath, clickPathIndex } = store;

    if (!clickPath || clickPath.length === 0) {
      mesh.count = 0;
      return;
    }

    // Only show dots from current index onward. Slice D drive-by (RULE 6,
    // Codex [F5]): index arithmetic instead of the old per-frame
    // `slice()` + dots-array allocations — this runs every frame while a
    // click-path is active on the Iris Xe floor.
    const remainingCount = clickPath.length - clickPathIndex;
    if (remainingCount <= 0) {
      mesh.count = 0;
      return;
    }
    // Thin out if too many — take every Nth dot; the final waypoint is
    // always included via the last slot below.
    const step = remainingCount > MAX_DOTS ? Math.ceil(remainingCount / MAX_DOTS) : 1;
    const thinned = Math.ceil(remainingCount / step);
    mesh.count = Math.min(thinned, MAX_DOTS);

    for (let i = 0; i < mesh.count; i++) {
      // Last slot pins to the final waypoint (the old push-final behavior).
      const remainingIndex =
        i === mesh.count - 1 ? remainingCount - 1 : i * step;
      const wp = clickPath[clickPathIndex + remainingIndex];
      // PERF: toWorld() writes into _toWorldScratch (module scope, no alloc).
      // tempMatrix and _dotRotation are also module-scope — no per-dot allocation.
      const worldPos = toWorld(wp.x, wp.y);
      _dotMatrix.makeTranslation(worldPos.x, worldPos.y, worldPos.z);
      _dotMatrix.multiply(_dotRotation);
      mesh.setMatrixAt(i, _dotMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={dotsRef} args={[geometry, material, MAX_DOTS]} frustumCulled={false}>
      <circleGeometry args={[DOT_RADIUS, DOT_SEGMENTS]} />
      <meshBasicMaterial color={0x00e5ff} transparent opacity={0.6} depthWrite={false} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Destination marker — pulsing ring at the click target
// ---------------------------------------------------------------------------
function DestinationMarker() {
  const ringRef = useRef<THREE.Mesh>(null);

  useSceneFrame((state) => {
    const mesh = ringRef.current;
    if (!mesh) return;

    const store = useGameStore.getState();
    const { clickPath } = store;

    if (!clickPath || clickPath.length === 0) {
      mesh.visible = false;
      return;
    }

    const dest = clickPath[clickPath.length - 1];
    const worldPos = toWorld(dest.x, dest.y);

    mesh.visible = true;
    mesh.position.set(worldPos.x, PATH_DOT_Y + 0.1, worldPos.z);

    // Pulse scale
    const t = state.clock.elapsedTime;
    const scale = DEST_PULSE_MIN + (DEST_PULSE_MAX - DEST_PULSE_MIN) * (0.5 + 0.5 * Math.sin(t * DEST_PULSE_SPEED));
    mesh.scale.set(scale, scale, 1);

    // Fade opacity
    const opacity = 0.4 + 0.3 * Math.sin(t * DEST_PULSE_SPEED);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = opacity;
  });

  return (
    <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
      <ringGeometry args={[0.8, 1.0, 24]} />
      <meshBasicMaterial color={0x00e5ff} transparent opacity={0.5} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Main ClickToMove component — path visuals only (ground-click input removed)
// ---------------------------------------------------------------------------
export default function ClickToMove() {
  return (
    <>
      <PathDots />
      <DestinationMarker />
    </>
  );
}
