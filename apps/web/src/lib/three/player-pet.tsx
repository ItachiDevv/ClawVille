'use client';

import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Billboard, useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { useGameStore } from '@/stores/game';

useGLTF.preload('/models/lobster.glb');
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
} from '@/lib/pixi/tilemap-data';
// GLB model replaces the old procedural lobster + LobsterAnimator

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const SPEED = 200; // pixels per second (matches 2D game loop)
const PET_HEIGHT = 6;
const BOB_SPEED = 5;
const BOB_AMPLITUDE = 0.3;
const DIAGONAL_FACTOR = Math.SQRT1_2;

// Species -> lobster body color
const SPECIES_COLORS: Record<string, number> = {
  cat: 0xff6347,    // Reef Lobster — coral red
  dragon: 0x1a237e, // Abyssal Lobster — deep navy
  fox: 0xff8c00,    // Spiny Lobster — bright orange
  owl: 0x8d6e63,    // Hermit Lobster — brown shell
  wolf: 0xb71c1c,   // Crusher Lobster — dark crimson
  bunny: 0xff80ab,  // Bubble Lobster — pink
  phoenix: 0x00e676, // Mantis Lobster — neon green
  turtle: 0x455a64,  // Iron Lobster — gunmetal
};

// Pet color -> tint
const COLOR_TINTS: Record<string, number> = {
  blue: 0x42a5f5,
  red: 0xef5350,
  green: 0x66bb6a,
  yellow: 0xffee58,
  purple: 0xab47bc,
  orange: 0xffa726,
  pink: 0xf48fb1,
  white: 0xeeeeee,
  black: 0x424242,
  brown: 0x8d6e63,
};

// Direction -> Y rotation
const DIR_ROTATION: Record<string, number> = {
  down: 0,
  left: Math.PI / 2,
  up: Math.PI,
  right: -Math.PI / 2,
  idle: 0,
};

// Building zones in pixel coords for proximity detection
const pixelZones = buildingZones.map((z) => ({
  id: z.id,
  x: z.x * TILE_SIZE,
  y: z.y * TILE_SIZE,
  width: z.width * TILE_SIZE,
  height: z.height * TILE_SIZE,
}));

// ---------------------------------------------------------------------------
// Key state tracking
// ---------------------------------------------------------------------------
interface KeyState {
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
  arrowup: boolean;
  arrowdown: boolean;
  arrowleft: boolean;
  arrowright: boolean;
  e: boolean;
  escape: boolean;
}

const keyState: KeyState = {
  w: false,
  a: false,
  s: false,
  d: false,
  arrowup: false,
  arrowdown: false,
  arrowleft: false,
  arrowright: false,
  e: false,
  escape: false,
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

/** Convert map pixel coords to Three.js world coords */
function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

// ---------------------------------------------------------------------------
// PlayerPet component
// ---------------------------------------------------------------------------
export default function PlayerPet() {
  const groupRef = useRef<THREE.Group>(null);
  const rotRef = useRef(0);
  const { scene } = useGLTF('/models/lobster.glb');
  const clonedScene = useMemo(() => scene.clone(true), [scene]);

  attachKeyListeners();

  const bodyColor = useMemo(() => {
    const species = useGameStore.getState().petSpecies;
    const petColor = useGameStore.getState().petColor;
    const base = SPECIES_COLORS[species] ?? 0xffa726;
    const tint = COLOR_TINTS[petColor] ?? 0xffffff;
    const c = new THREE.Color(base);
    c.lerp(new THREE.Color(tint), 0.4);
    return c;
  }, []);

  // Apply species color to all model materials
  useEffect(() => {
    clonedScene.traverse((child: any) => {
      if (child.isMesh && child.material) {
        const mat = child.material.clone();
        mat.color = bodyColor.clone();
        child.material = mat;
        child.castShadow = true;
      }
    });
  }, [clonedScene, bodyColor]);

  useFrame((state, delta) => {
    const store = useGameStore.getState();
    if (store.movementFrozen) {
      // Handle Escape to exit building
      const escNow = keyState.escape;
      if (escNow && !lastEscState && store.chatOpen) {
        store.exitBuilding();
      }
      lastEscState = escNow;
      return;
    }
    lastEscState = keyState.escape;

    // Handle E to enter building
    const eNow = keyState.e;
    if (eNow && !lastEState && store.nearLocation) {
      store.enterBuilding(store.nearLocation);
      lastEState = eNow;
      return;
    }
    lastEState = eNow;

    // Movement input
    let vx = 0;
    let vy = 0;
    if (keyState.w || keyState.arrowup) vy = -1;
    if (keyState.s || keyState.arrowdown) vy = 1;
    if (keyState.a || keyState.arrowleft) vx = -1;
    if (keyState.d || keyState.arrowright) vx = 1;

    // Merge joystick
    const { joystickVelocity } = store;
    if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
      vx = joystickVelocity.x;
      vy = joystickVelocity.y;
    }

    const hasKeyboardInput = vx !== 0 || vy !== 0;

    // Keyboard/joystick input cancels click-to-move
    if (hasKeyboardInput && store.clickPath) {
      store.clearClickPath();
    }

    // Click-to-move path following
    if (!hasKeyboardInput && store.clickPath && store.clickPath.length > 0) {
      const waypoint = store.clickPath[store.clickPathIndex];
      if (waypoint) {
        const dx = waypoint.x - store.petPosition.x;
        const dy = waypoint.y - store.petPosition.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 6) {
          // Reached waypoint — advance or finish
          if (store.clickPathIndex >= store.clickPath.length - 1) {
            // Reached final destination
            const target = store.clickPathTarget;
            store.clearClickPath();
            // Auto-enter building if destination was inside one
            if (target && store.nearLocation === target) {
              store.enterBuilding(target);
              return;
            }
          } else {
            store.advanceClickPath();
          }
        } else {
          // Move toward waypoint
          vx = dx / dist;
          vy = dy / dist;
        }
      }
    }

    // Normalize diagonal
    if (vx !== 0 && vy !== 0) {
      const len = Math.sqrt(vx * vx + vy * vy);
      if (len > 1) {
        vx /= len;
        vy /= len;
      }
    }

    // Direction
    let dir = 'idle';
    if (vx !== 0 || vy !== 0) {
      if (Math.abs(vx) > Math.abs(vy)) {
        dir = vx > 0 ? 'right' : 'left';
      } else {
        dir = vy > 0 ? 'down' : 'up';
      }
    }
    store.setMovementDirection(dir as any);

    // Apply movement
    if (vx !== 0 || vy !== 0) {
      let newX = store.petPosition.x + vx * SPEED * delta;
      let newY = store.petPosition.y + vy * SPEED * delta;
      newX = Math.max(16, Math.min(MAP_WIDTH - 16, newX));
      newY = Math.max(16, Math.min(MAP_HEIGHT - 16, newY));
      store.setPetPosition(newX, newY);

      // Zone overlap detection
      let nearZone: string | null = null;
      for (const zone of pixelZones) {
        if (
          newX >= zone.x &&
          newX <= zone.x + zone.width &&
          newY >= zone.y &&
          newY <= zone.y + zone.height
        ) {
          nearZone = zone.id;
          break;
        }
      }
      if (nearZone !== store.nearLocation) {
        store.setNearLocation(nearZone);
      }
    }

    // Update 3D position
    const group = groupRef.current;
    if (!group) return;

    const [wx, , wz] = mapToWorld(store.petPosition.x, store.petPosition.y);
    group.position.x = wx;
    group.position.z = wz;

    // Walking bob
    const isMoving = dir !== 'idle';
    const elapsed = state.clock.elapsedTime;
    if (isMoving) {
      group.position.y = Math.abs(Math.sin(elapsed * BOB_SPEED)) * BOB_AMPLITUDE;
    } else {
      group.position.y = Math.sin(elapsed * 2) * 0.15;
    }

    // Rotation toward direction
    const targetRot = DIR_ROTATION[dir] ?? 0;
    rotRef.current += (targetRot - rotRef.current) * 0.15;
    group.rotation.y = rotRef.current;

    // Simple walk squash/stretch animation on the model group
    if (isMoving) {
      const walkCycle = Math.sin(elapsed * 8);
      group.scale.set(1, 1 + walkCycle * 0.03, 1);
    } else {
      // Idle breathing
      const breath = Math.sin(elapsed * 2) * 0.015;
      group.scale.set(1 + breath, 1, 1 + breath);
    }
  });

  const species = useGameStore((s) => s.petSpecies);

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      {/* GLB lobster model */}
      <group scale={0.35} position={[0, 0, 0]}>
        <primitive object={clonedScene} />
      </group>

      {/* Shadow */}
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[4, 16]} />
        <meshBasicMaterial color={0x000000} transparent opacity={0.2} />
      </mesh>

      {/* Name label */}
      <Billboard position={[0, PET_HEIGHT + 5, 0]}>
        <Text
          fontSize={3}
          color="white"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.3}
          outlineColor="#000000"
        >
          {species.charAt(0).toUpperCase() + species.slice(1)}
        </Text>
      </Billboard>
    </group>
  );
}
