'use client';

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Billboard } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { useGameStore } from '@/stores/game';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
} from '@/lib/pixi/tilemap-data';
import { LobsterAnimator, type LobsterRefs, resolveAnimState } from '@/lib/three/lobster-animations';

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

// Avatar color -> tint
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
// PlayerAvatar component
// ---------------------------------------------------------------------------
export default function PlayerAvatar() {
  const groupRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Mesh>(null);
  const rotRef = useRef(0);

  // Animation refs
  const leftClawRef = useRef<THREE.Group>(null);
  const rightClawRef = useRef<THREE.Group>(null);
  const tailSeg0Ref = useRef<THREE.Mesh>(null);
  const tailSeg1Ref = useRef<THREE.Mesh>(null);
  const tailSeg2Ref = useRef<THREE.Mesh>(null);
  const tailFanRef = useRef<THREE.Mesh>(null);
  const legRefs = useRef<(THREE.Mesh | null)[]>([null, null, null, null, null, null]);
  const eyeStalkRefs = useRef<(THREE.Group | null)[]>([null, null]);
  const antennaRefs = useRef<(THREE.Mesh | null)[]>([null, null]);
  const animatorRef = useRef<LobsterAnimator | null>(null);

  attachKeyListeners();

  const bodyColor = useMemo(() => {
    const species = useGameStore.getState().avatarSpecies;
    const avatarColor = useGameStore.getState().avatarColor;
    const base = SPECIES_COLORS[species] ?? 0xffa726;
    const tint = COLOR_TINTS[avatarColor] ?? 0xffffff;
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

    const hasKeyboardInput = vx !== 0 || vy !== 0;

    // Keyboard/joystick input cancels click-to-move
    if (hasKeyboardInput && store.clickPath) {
      store.clearClickPath();
    }

    // Click-to-move path following
    if (!hasKeyboardInput && store.clickPath && store.clickPath.length > 0) {
      const waypoint = store.clickPath[store.clickPathIndex];
      if (waypoint) {
        const dx = waypoint.x - store.avatarPosition.x;
        const dy = waypoint.y - store.avatarPosition.y;
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
      let newX = store.avatarPosition.x + vx * SPEED * delta;
      let newY = store.avatarPosition.y + vy * SPEED * delta;
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

    const [wx, , wz] = mapToWorld(store.avatarPosition.x, store.avatarPosition.y);
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

    // Procedural animation
    if (!animatorRef.current) {
      const refs: LobsterRefs = {
        body: bodyRef.current,
        leftClaw: leftClawRef.current,
        rightClaw: rightClawRef.current,
        tailSegments: [tailSeg0Ref.current, tailSeg1Ref.current, tailSeg2Ref.current],
        tailFan: tailFanRef.current,
        legs: legRefs.current,
        eyeStalks: eyeStalkRefs.current,
        antennae: antennaRefs.current,
      };
      animatorRef.current = new LobsterAnimator(refs);
    }
    const animState = resolveAnimState({
      isDead: false,
      inCombat: false,
      combatAction: null,
      direction: dir,
      inConversation: false,
    });
    animatorRef.current.update(delta, elapsed, animState, dir);
  });

  const species = useGameStore((s) => s.avatarSpecies);

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      {/* Lobster body — elongated ellipsoid */}
      <mesh ref={bodyRef} position={[0, 3, 0]} castShadow scale={[1, 0.7, 1.4]}>
        <capsuleGeometry args={[2, 4, 8, 16]} />
        <meshStandardMaterial color={bodyColor} roughness={0.6} />
      </mesh>

      {/* Carapace (upper shell) */}
      <mesh position={[0, 4.5, -1]} castShadow>
        <sphereGeometry args={[2.5, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
        <meshStandardMaterial color={bodyColor} roughness={0.5} />
      </mesh>

      {/* Tail segments */}
      <mesh ref={tailSeg0Ref} position={[0, 2.5, -3]} castShadow scale={[1, 0.5, 1]}>
        <boxGeometry args={[3, 1.2, 1.8]} />
        <meshStandardMaterial color={bodyColor} roughness={0.65} />
      </mesh>
      <mesh ref={tailSeg1Ref} position={[0, 2.1, -4.8]} castShadow scale={[0.85, 0.5, 1]}>
        <boxGeometry args={[2.5, 1.2, 1.8]} />
        <meshStandardMaterial color={bodyColor} roughness={0.65} />
      </mesh>
      <mesh ref={tailSeg2Ref} position={[0, 1.7, -6.6]} castShadow scale={[0.7, 0.5, 1]}>
        <boxGeometry args={[2, 1.2, 1.8]} />
        <meshStandardMaterial color={bodyColor} roughness={0.65} />
      </mesh>
      {/* Tail fan */}
      <mesh ref={tailFanRef} position={[0, 1.8, -7.5]} rotation={[0.3, 0, 0]}>
        <coneGeometry args={[2, 2.5, 6]} />
        <meshStandardMaterial color={bodyColor} roughness={0.6} />
      </mesh>

      {/* Eyes on stalks */}
      <group ref={(el) => { eyeStalkRefs.current[0] = el; }} position={[-1.4, 5, 2.5]}>
        <mesh position={[0, 0.6, 0]}>
          <cylinderGeometry args={[0.2, 0.25, 1.5, 6]} />
          <meshStandardMaterial color={bodyColor} roughness={0.7} />
        </mesh>
        <mesh position={[0, 1.5, 0]}>
          <sphereGeometry args={[0.5, 8, 8]} />
          <meshBasicMaterial color={0xffffff} />
        </mesh>
        <mesh position={[-0.1, 1.5, 0.4]}>
          <sphereGeometry args={[0.25, 8, 8]} />
          <meshBasicMaterial color={0x111111} />
        </mesh>
      </group>
      <group ref={(el) => { eyeStalkRefs.current[1] = el; }} position={[1.4, 5, 2.5]}>
        <mesh position={[0, 0.6, 0]}>
          <cylinderGeometry args={[0.2, 0.25, 1.5, 6]} />
          <meshStandardMaterial color={bodyColor} roughness={0.7} />
        </mesh>
        <mesh position={[0, 1.5, 0]}>
          <sphereGeometry args={[0.5, 8, 8]} />
          <meshBasicMaterial color={0xffffff} />
        </mesh>
        <mesh position={[0.1, 1.5, 0.4]}>
          <sphereGeometry args={[0.25, 8, 8]} />
          <meshBasicMaterial color={0x111111} />
        </mesh>
      </group>

      {/* Antennae */}
      <mesh ref={(el) => { antennaRefs.current[0] = el; }} position={[-0.8, 5.2, 3]} rotation={[-0.5, -0.3, -0.4]}>
        <cylinderGeometry args={[0.08, 0.12, 5, 4]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </mesh>
      <mesh ref={(el) => { antennaRefs.current[1] = el; }} position={[0.8, 5.2, 3]} rotation={[-0.5, 0.3, 0.4]}>
        <cylinderGeometry args={[0.08, 0.12, 5, 4]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </mesh>

      {/* Claws (left and right) */}
      <group ref={leftClawRef} position={[-3.5, 2.5, 1.5]}>
        <mesh position={[-0.5, 0, 0]} rotation={[0, 0, -0.3]}>
          <cylinderGeometry args={[0.4, 0.5, 2.5, 6]} />
          <meshStandardMaterial color={bodyColor} roughness={0.6} />
        </mesh>
        <mesh position={[-1.2, -0.3, 0.8]} rotation={[0.3, -0.2, -0.5]}>
          <boxGeometry args={[1.8, 0.6, 1]} />
          <meshStandardMaterial color={bodyColor} roughness={0.55} />
        </mesh>
        <mesh position={[-1.2, 0.3, 0.8]} rotation={[-0.2, -0.2, -0.5]}>
          <boxGeometry args={[1.5, 0.5, 0.8]} />
          <meshStandardMaterial color={bodyColor} roughness={0.55} />
        </mesh>
      </group>
      <group ref={rightClawRef} position={[3.5, 2.5, 1.5]}>
        <mesh position={[0.5, 0, 0]} rotation={[0, 0, 0.3]}>
          <cylinderGeometry args={[0.4, 0.5, 2.5, 6]} />
          <meshStandardMaterial color={bodyColor} roughness={0.6} />
        </mesh>
        <mesh position={[1.2, -0.3, 0.8]} rotation={[0.3, 0.2, 0.5]}>
          <boxGeometry args={[1.8, 0.6, 1]} />
          <meshStandardMaterial color={bodyColor} roughness={0.55} />
        </mesh>
        <mesh position={[1.2, 0.3, 0.8]} rotation={[-0.2, 0.2, 0.5]}>
          <boxGeometry args={[1.5, 0.5, 0.8]} />
          <meshStandardMaterial color={bodyColor} roughness={0.55} />
        </mesh>
      </group>

      {/* Legs (3 pairs) — left side (indices 0-2), right side (indices 3-5) */}
      {[
        { side: -1, idx: 0, i: 0 },
        { side: -1, idx: 1, i: 1 },
        { side: -1, idx: 2, i: 2 },
        { side: 1, idx: 3, i: 0 },
        { side: 1, idx: 4, i: 1 },
        { side: 1, idx: 5, i: 2 },
      ].map(({ side, idx, i }) => (
        <mesh
          key={`leg-${idx}`}
          ref={(el) => { legRefs.current[idx] = el; }}
          position={[side * 2.2, 1, -0.5 - i * 1.5]}
          rotation={[0, 0, side * 0.6]}
        >
          <cylinderGeometry args={[0.15, 0.2, 2.5, 4]} />
          <meshStandardMaterial color={bodyColor} roughness={0.7} />
        </mesh>
      ))}

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
