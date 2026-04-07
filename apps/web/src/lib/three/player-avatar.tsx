'use client';

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameStore } from '@/stores/game';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GPU-SAFE player avatar — 5 meshes total (body + 2 eyes + 2 claws)
// Original had 46 meshes
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const SPEED = 200;
const BOB_SPEED = 5;
const BOB_AMPLITUDE = 0.3;

const SPECIES_COLORS: Record<string, number> = {
  cat: 0xff6347, dragon: 0x1a237e, fox: 0xff8c00, owl: 0x8d6e63,
  wolf: 0xb71c1c, bunny: 0xff80ab, phoenix: 0x00e676, turtle: 0x455a64,
};

const COLOR_TINTS: Record<string, number> = {
  blue: 0x42a5f5, red: 0xef5350, green: 0x66bb6a, yellow: 0xffee58,
  purple: 0xab47bc, orange: 0xffa726, pink: 0xf48fb1, white: 0xeeeeee,
  black: 0x424242, brown: 0x8d6e63,
};

const DIR_ROTATION: Record<string, number> = {
  down: 0, left: Math.PI / 2, up: Math.PI, right: -Math.PI / 2, idle: 0,
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

// Shared geometry
const bodyGeo = new THREE.CapsuleGeometry(2.5, 5, 6, 12);
const eyeGeo = new THREE.SphereGeometry(0.6, 6, 6);
const clawGeo = new THREE.BoxGeometry(1.5, 0.5, 0.8);

export default function PlayerAvatar() {
  const groupRef = useRef<THREE.Group>(null);
  const rotRef = useRef(0);

  attachKeyListeners();

  const bodyColor = useMemo(() => {
    const species = useGameStore.getState().avatarSpecies;
    const avatarColor = useGameStore.getState().avatarColor;
    const base = SPECIES_COLORS[species] ?? 0xffa726;
    const tint = COLOR_TINTS[avatarColor] ?? 0xffffff;
    const c = new THREE.Color(base);
    c.lerp(new THREE.Color(tint), 0.4);
    return c;
  }, []);

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
    if (keyState.w || keyState.arrowup) vy = -1;
    if (keyState.s || keyState.arrowdown) vy = 1;
    if (keyState.a || keyState.arrowleft) vx = -1;
    if (keyState.d || keyState.arrowright) vx = 1;

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
    group.position.y = isMoving ? Math.abs(Math.sin(elapsed * BOB_SPEED)) * BOB_AMPLITUDE : Math.sin(elapsed * 2) * 0.15;

    const targetRot = DIR_ROTATION[dir] ?? 0;
    rotRef.current += (targetRot - rotRef.current) * 0.15;
    group.rotation.y = rotRef.current;
  });

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      {/* Body — 1 mesh */}
      <mesh geometry={bodyGeo} position={[0, 3, 0]} castShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.6} />
      </mesh>

      {/* Eyes — 2 meshes */}
      <mesh geometry={eyeGeo} position={[-0.9, 5, 2]}>
        <meshBasicMaterial color={0xffffff} />
      </mesh>
      <mesh geometry={eyeGeo} position={[0.9, 5, 2]}>
        <meshBasicMaterial color={0xffffff} />
      </mesh>

      {/* Claws — 2 meshes */}
      <mesh geometry={clawGeo} position={[-3, 2, 1]}>
        <meshStandardMaterial color={bodyColor} roughness={0.55} />
      </mesh>
      <mesh geometry={clawGeo} position={[3, 2, 1]}>
        <meshStandardMaterial color={bodyColor} roughness={0.55} />
      </mesh>
    </group>
  );
}
