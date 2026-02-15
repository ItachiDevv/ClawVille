'use client';

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Billboard } from '@react-three/drei';
import * as THREE from 'three';
import { useGameStore } from '@/stores/game';
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
const SPEED = 200; // pixels per second (matches 2D game loop)
const PET_HEIGHT = 6;
const BOB_SPEED = 5;
const BOB_AMPLITUDE = 0.3;
const DIAGONAL_FACTOR = Math.SQRT1_2;

// Species -> body color (fallback)
const SPECIES_COLORS: Record<string, number> = {
  cat: 0xffa726,
  dragon: 0x66bb6a,
  fox: 0xff7043,
  owl: 0x8d6e63,
  wolf: 0x78909c,
  bunny: 0xf48fb1,
  phoenix: 0xef5350,
  turtle: 0x4db6ac,
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
  const bodyRef = useRef<THREE.Mesh>(null);
  const rotRef = useRef(0);

  attachKeyListeners();

  const bodyColor = useMemo(() => {
    const species = useGameStore.getState().petSpecies;
    const petColor = useGameStore.getState().petColor;
    const base = SPECIES_COLORS[species] ?? 0xffa726;
    const tint = COLOR_TINTS[petColor] ?? 0xffffff;
    // Blend base with color tint
    const c = new THREE.Color(base);
    c.lerp(new THREE.Color(tint), 0.4);
    return c;
  }, []);

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

    // Normalize diagonal
    if (vx !== 0 && vy !== 0) {
      vx *= DIAGONAL_FACTOR;
      vy *= DIAGONAL_FACTOR;
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
  });

  const species = useGameStore((s) => s.petSpecies);

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      {/* Body - capsule */}
      <mesh ref={bodyRef} position={[0, PET_HEIGHT / 2 + 1, 0]} castShadow>
        <capsuleGeometry args={[2, PET_HEIGHT, 8, 16]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </mesh>

      {/* Eyes */}
      <mesh position={[0.8, PET_HEIGHT - 0.5, 1.8]}>
        <sphereGeometry args={[0.6, 8, 8]} />
        <meshBasicMaterial color={0xffffff} />
      </mesh>
      <mesh position={[-0.8, PET_HEIGHT - 0.5, 1.8]}>
        <sphereGeometry args={[0.6, 8, 8]} />
        <meshBasicMaterial color={0xffffff} />
      </mesh>
      {/* Pupils */}
      <mesh position={[0.8, PET_HEIGHT - 0.5, 2.3]}>
        <sphereGeometry args={[0.3, 8, 8]} />
        <meshBasicMaterial color={0x111111} />
      </mesh>
      <mesh position={[-0.8, PET_HEIGHT - 0.5, 2.3]}>
        <sphereGeometry args={[0.3, 8, 8]} />
        <meshBasicMaterial color={0x111111} />
      </mesh>

      {/* Ears (like cat/fox) */}
      <mesh position={[1.2, PET_HEIGHT + 2, 0]} rotation={[0, 0, 0.3]}>
        <coneGeometry args={[1, 2.5, 4]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </mesh>
      <mesh position={[-1.2, PET_HEIGHT + 2, 0]} rotation={[0, 0, -0.3]}>
        <coneGeometry args={[1, 2.5, 4]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </mesh>

      {/* Shadow */}
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[3, 16]} />
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
