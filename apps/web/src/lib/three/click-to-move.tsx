'use client';

import { useRef, useMemo, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { useGameStore } from '@/stores/game';
import { findPath } from '@/lib/pixi/client-pathfinding';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const SPEED = 200; // px/s — matches player-avatar.tsx
const WAYPOINT_THRESHOLD = 6; // px — snap to next waypoint when this close
const PATH_DOT_Y = 1.2; // slightly above ground
const DOT_RADIUS = 1.8;
const DOT_SEGMENTS = 8;
const DEST_PULSE_MIN = 2.5;
const DEST_PULSE_MAX = 4.5;
const DEST_PULSE_SPEED = 4;
const MAX_DOTS = 60; // cap rendered dots for performance

// Building pixel zones for proximity detection (same as player-avatar)
const pixelZones = buildingZones.map((z) => ({
  id: z.id,
  x: z.x * TILE_SIZE,
  y: z.y * TILE_SIZE,
  width: z.width * TILE_SIZE,
  height: z.height * TILE_SIZE,
}));

/** Convert pixel coords to Three.js world coords */
function toWorld(px: number, py: number): THREE.Vector3 {
  return new THREE.Vector3(px - HALF_W, PATH_DOT_Y, py - HALF_H);
}

/** Convert Three.js world coords to pixel coords */
function toPixel(wx: number, wz: number): { x: number; y: number } {
  return { x: wx + HALF_W, y: wz + HALF_H };
}

// ---------------------------------------------------------------------------
// Ground click handler — invisible plane for raycasting
// ---------------------------------------------------------------------------
function ClickPlane() {
  const { camera, raycaster, pointer } = useThree();
  const planeRef = useRef<THREE.Mesh>(null);
  const groundPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const intersectPoint = useMemo(() => new THREE.Vector3(), []);

  const handleClick = useCallback(
    (e: THREE.Event & { stopPropagation?: () => void }) => {
      // Don't handle if movement is frozen (in building chat)
      const store = useGameStore.getState();
      if (store.movementFrozen) return;

      // Cast ray onto Y=0 plane
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.ray.intersectPlane(groundPlane, intersectPoint);
      if (!hit) return;

      const pixel = toPixel(hit.x, hit.z);

      // Clamp to map bounds
      pixel.x = Math.max(16, Math.min(MAP_WIDTH - 16, pixel.x));
      pixel.y = Math.max(16, Math.min(MAP_HEIGHT - 16, pixel.y));

      // Run A* from current position to click position
      const { avatarPosition } = store;
      const path = findPath(avatarPosition.x, avatarPosition.y, pixel.x, pixel.y);

      if (path.length > 0) {
        // Check if destination is inside a building zone
        const dest = path[path.length - 1];
        let targetBuilding: string | null = null;
        for (const zone of pixelZones) {
          if (
            dest.x >= zone.x &&
            dest.x <= zone.x + zone.width &&
            dest.y >= zone.y &&
            dest.y <= zone.y + zone.height
          ) {
            targetBuilding = zone.id;
            break;
          }
        }
        store.setClickPath(path, targetBuilding);
      }
    },
    [camera, raycaster, pointer, groundPlane, intersectPoint]
  );

  return (
    <mesh
      ref={planeRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.01, 0]}
      onClick={handleClick}
      visible={false}
    >
      <planeGeometry args={[MAP_WIDTH + 200, MAP_HEIGHT + 200]} />
      <meshBasicMaterial transparent opacity={0} />
    </mesh>
  );
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

  const tempMatrix = useMemo(() => new THREE.Matrix4(), []);

  useFrame(() => {
    const mesh = dotsRef.current;
    if (!mesh) return;

    const store = useGameStore.getState();
    const { clickPath, clickPathIndex } = store;

    if (!clickPath || clickPath.length === 0) {
      mesh.count = 0;
      return;
    }

    // Only show dots from current index onward
    const remaining = clickPath.slice(clickPathIndex);
    // Thin out if too many — take every Nth dot
    const step = remaining.length > MAX_DOTS ? Math.ceil(remaining.length / MAX_DOTS) : 1;
    const dots: { x: number; y: number }[] = [];
    for (let i = 0; i < remaining.length; i += step) {
      dots.push(remaining[i]);
    }
    // Always include final waypoint
    if (dots.length > 0 && dots[dots.length - 1] !== remaining[remaining.length - 1]) {
      dots.push(remaining[remaining.length - 1]);
    }

    mesh.count = Math.min(dots.length, MAX_DOTS);

    for (let i = 0; i < mesh.count; i++) {
      const wp = dots[i];
      const worldPos = toWorld(wp.x, wp.y);
      tempMatrix.makeTranslation(worldPos.x, worldPos.y, worldPos.z);
      // Rotate flat on ground
      const rot = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
      tempMatrix.multiply(rot);
      mesh.setMatrixAt(i, tempMatrix);
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

  useFrame((state) => {
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
// Main ClickToMove component
// ---------------------------------------------------------------------------
export default function ClickToMove() {
  return (
    <>
      <ClickPlane />
      <PathDots />
      <DestinationMarker />
    </>
  );
}
