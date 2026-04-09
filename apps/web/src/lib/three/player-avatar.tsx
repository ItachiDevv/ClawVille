'use client';

import { useRef, useMemo, Suspense } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useGameStore } from '@/stores/game';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
} from '@/lib/pixi/tilemap-data';
import { applyWalkAnimation, applyIdleAnimation } from '@/lib/three/procedural-animation';
import { LobsterAnimator } from '@/lib/three/lobster-animations';
import { discoverLobsterParts } from '@/lib/three/lobster-parts';

// ---------------------------------------------------------------------------
// GLB-based player avatar — lobster.glb model = 1-2 draw calls
// Original had 46 meshes built from primitives
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const SPEED = 200;
const BOB_SPEED = 5;
const BOB_AMPLITUDE = 0.3;
const AVATAR_SCALE = 10;

const COLOR_TINTS: Record<string, number> = {
  blue: 0x42a5f5, red: 0xef5350, green: 0x66bb6a, yellow: 0xffee58,
  purple: 0xab47bc, orange: 0xffa726, pink: 0xf48fb1, white: 0xeeeeee,
  black: 0x424242, brown: 0x8d6e63,
};

// Lobster GLB faces -Z in local space, so add PI to flip it forward
const DIR_ROTATION: Record<string, number> = {
  down: Math.PI, left: -Math.PI / 2, up: 0, right: Math.PI / 2, idle: Math.PI,
};

const pixelZones = buildingZones.map((z) => ({
  id: z.id,
  x: z.x * TILE_SIZE, y: z.y * TILE_SIZE,
  width: z.width * TILE_SIZE, height: z.height * TILE_SIZE,
}));

interface KeyState {
  w: boolean; a: boolean; s: boolean; d: boolean;
  arrowup: boolean; arrowdown: boolean; arrowleft: boolean; arrowright: boolean;
  e: boolean; escape: boolean;
}

const keyState: KeyState = {
  w: false, a: false, s: false, d: false,
  arrowup: false, arrowdown: false, arrowleft: false, arrowright: false,
  e: false, escape: false,
};
let keyListenersAttached = false;
let lastEState = false;
let lastEscState = false;

function attachKeyListeners() {
  if (keyListenersAttached) return;
  keyListenersAttached = true;
  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase() as keyof KeyState;
    if (key in keyState) keyState[key] = true;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase() as keyof KeyState;
    if (key in keyState) keyState[key] = false;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}

function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

// Preload
useGLTF.preload('/models/lobster.glb');

import { TERRAIN_LAYER } from '@/lib/three/arena-terrain';

// Shared raycaster — only hits layer 1 (terrain)
const _petRaycaster = new THREE.Raycaster();
_petRaycaster.layers.set(TERRAIN_LAYER);
const _petRayOrigin = new THREE.Vector3();
const _petRayDir = new THREE.Vector3(0, -1, 0);

function getTerrainY(x: number, z: number, scene: THREE.Scene): number {
  _petRayOrigin.set(x, 200, z);
  _petRaycaster.set(_petRayOrigin, _petRayDir);
  _petRaycaster.layers.set(TERRAIN_LAYER);
  _petRaycaster.far = 400;
  const intersects = _petRaycaster.intersectObjects(scene.children, true);
  if (intersects.length > 0) return intersects[0].point.y;
  return -15; // fallback
}

function PlayerPetInner() {
  const groupRef = useRef<THREE.Group>(null);
  const animGroupRef = useRef<THREE.Group>(null);
  const rotRef = useRef(0);
  const terrainYRef = useRef(0);
  const { scene: threeScene } = useThree();

  attachKeyListeners();

  const { scene } = useGLTF('/models/lobster.glb');

  const { cloned, animator } = useMemo(() => {
    const c = scene.clone(true);
    const avatarColor = useGameStore.getState().avatarColor;
    const tint = new THREE.Color(COLOR_TINTS[avatarColor] ?? 0xffffff);
    c.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.material) {
          const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
          mat.color.lerp(tint, 0.3);
          mat.emissive = tint;
          mat.emissiveIntensity = 0.1;
          mesh.material = mat;
        }
      }
    });
    // Discover body parts and create skeletal animator
    const parts = discoverLobsterParts(c);
    const anim = new LobsterAnimator(parts);
    return { cloned: c, animator: anim };
  }, [scene]);

  useFrame((state, delta) => {
    const store = useGameStore.getState();
    if (store.movementFrozen) {
      const escNow = keyState.escape;
      if (escNow && !lastEscState && store.chatOpen) store.exitBuilding();
      lastEscState = escNow;
      return;
    }
    lastEscState = keyState.escape;

    const eNow = keyState.e;
    if (eNow && !lastEState && store.nearLocation) {
      store.enterBuilding(store.nearLocation);
      lastEState = eNow;
      return;
    }
    lastEState = eNow;

    let vx = 0, vy = 0;
    // Only WASD drives avatar movement — arrow keys rotate the camera (ArrowKeyRotationController)
    if (keyState.w) vy = -1;
    if (keyState.s) vy = 1;
    if (keyState.a) vx = -1;
    if (keyState.d) vx = 1;

    const { joystickVelocity } = store;
    if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
      vx = joystickVelocity.x;
      vy = joystickVelocity.y;
    }

    const hasInput = vx !== 0 || vy !== 0;
    if (hasInput && store.clickPath) store.clearClickPath();

    if (!hasInput && store.clickPath && store.clickPath.length > 0) {
      const waypoint = store.clickPath[store.clickPathIndex];
      if (waypoint) {
        const dx = waypoint.x - store.avatarPosition.x;
        const dy = waypoint.y - store.avatarPosition.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 6) {
          if (store.clickPathIndex >= store.clickPath.length - 1) {
            const target = store.clickPathTarget;
            store.clearClickPath();
            if (target && store.nearLocation === target) { store.enterBuilding(target); return; }
          } else { store.advanceClickPath(); }
        } else { vx = dx / dist; vy = dy / dist; }
      }
    }

    if (vx !== 0 && vy !== 0) {
      const len = Math.sqrt(vx * vx + vy * vy);
      if (len > 1) { vx /= len; vy /= len; }
    }

    let dir = 'idle';
    if (vx !== 0 || vy !== 0) {
      dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : (vy > 0 ? 'down' : 'up');
    }
    store.setMovementDirection(dir as any);

    if (vx !== 0 || vy !== 0) {
      let newX = store.avatarPosition.x + vx * SPEED * delta;
      let newY = store.avatarPosition.y + vy * SPEED * delta;
      newX = Math.max(16, Math.min(MAP_WIDTH - 16, newX));
      newY = Math.max(16, Math.min(MAP_HEIGHT - 16, newY));
      store.setPetPosition(newX, newY);

      let nearZone: string | null = null;
      for (const zone of pixelZones) {
        if (newX >= zone.x && newX <= zone.x + zone.width && newY >= zone.y && newY <= zone.y + zone.height) {
          nearZone = zone.id; break;
        }
      }
      if (nearZone !== store.nearLocation) store.setNearLocation(nearZone);
    }

    const group = groupRef.current;
    if (!group) return;
    const [wx, , wz] = mapToWorld(store.avatarPosition.x, store.avatarPosition.y);
    group.position.x = wx;
    group.position.z = wz;

    const isMoving = dir !== 'idle';
    const elapsed = state.clock.elapsedTime;
    // Raycast terrain height (every 3rd frame)
    const frame = Math.floor(Date.now() / 50);
    if (frame % 3 === 0) {
      const ty = getTerrainY(group.position.x, group.position.z, threeScene);
      terrainYRef.current += (ty - terrainYRef.current) * 0.3;
    }
    const bob = isMoving ? Math.abs(Math.sin(elapsed * BOB_SPEED)) * BOB_AMPLITUDE : Math.sin(elapsed * 2) * 0.15;
    group.position.y = terrainYRef.current + 2 + bob;

    const targetRot = DIR_ROTATION[dir] ?? 0;
    rotRef.current += (targetRot - rotRef.current) * 0.15;
    group.rotation.y = rotRef.current;

    // Skeletal animation — individual body parts (claws, legs, tail)
    const suggestedAnim = isMoving ? 'walk' : 'idle';
    animator.update(Math.min(delta, 0.1), elapsed, suggestedAnim as any, dir);

    // Procedural animation (squash/stretch/tilt) on inner group
    const animGroup = animGroupRef.current;
    if (animGroup) {
      const animStateData = {
        group: animGroup,
        isMoving,
        elapsed,
        delta: Math.min(delta, 0.1),
        direction: dir,
        seed: 0, // Player always seed 0
      };
      if (isMoving) {
        applyWalkAnimation(animStateData);
      } else {
        applyIdleAnimation(animStateData);
      }
    }
  });

  return (
    <group ref={groupRef}>
      <group ref={animGroupRef}>
        <primitive object={cloned} scale={AVATAR_SCALE} />
      </group>
    </group>
  );
}

export default function PlayerAvatar() {
  return (
    <Suspense fallback={null}>
      <PlayerPetInner />
    </Suspense>
  );
}
