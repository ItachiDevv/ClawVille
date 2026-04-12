'use client';

/**
 * NpcController — WASD possession of a single NPC in 'npc' control mode.
 *
 * Camera-relative: W = forward from camera's perspective, S = back, A/D strafe.
 * Smooth facing angle via atan2 (no cardinal snapping → no spinning).
 * Building collision: slides along building walls, can't walk through.
 */

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameStore, type GameState } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import type { NpcSpriteState } from '@/stores/npc';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';

const SPEED = 200; // units/sec — matches player-avatar.tsx
const COLLISION_PAD = 12; // pixels of padding around buildings for collision

// Map pixel bounds (mirror player-avatar clamp)
const X_MIN = 16;
const X_MAX = MAP_WIDTH - 16;
const Y_MIN = 16;
const Y_MAX = MAP_HEIGHT - 16;

// Module-level key state — same pattern as player-avatar.tsx, avoids closure allocs
interface NpcKeyState {
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
}

const _keys: NpcKeyState = { w: false, a: false, s: false, d: false };
let _listenersAttached = false;

// Scratch vectors — allocated once, reused every frame
const _camForward = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

// Pre-compute building collision rects in pixel space (with padding)
const buildingRects = buildingZones.map((z) => ({
  id: z.id,
  x1: z.x * TILE_SIZE - COLLISION_PAD,
  y1: z.y * TILE_SIZE - COLLISION_PAD,
  x2: (z.x + z.width) * TILE_SIZE + COLLISION_PAD,
  y2: (z.y + z.height) * TILE_SIZE + COLLISION_PAD,
}));

function isInsideBuilding(px: number, py: number): boolean {
  for (const r of buildingRects) {
    if (px >= r.x1 && px <= r.x2 && py >= r.y1 && py <= r.y2) return true;
  }
  return false;
}

function attachNpcKeyListeners() {
  if (_listenersAttached) return;
  _listenersAttached = true;
  const onDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase() as keyof NpcKeyState;
    if (k in _keys) _keys[k] = true;
  };
  const onUp = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase() as keyof NpcKeyState;
    if (k in _keys) _keys[k] = false;
  };
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
}

function directionFromVelocity(vx: number, vy: number): NpcSpriteState['direction'] {
  if (vx === 0 && vy === 0) return 'idle';
  if (Math.abs(vx) >= Math.abs(vy)) {
    return vx > 0 ? 'right' : 'left';
  }
  return vy > 0 ? 'down' : 'up';
}

export default function NpcController() {
  const attachedRef = useRef(false);
  const { camera } = useThree();

  useEffect(() => {
    if (!attachedRef.current) {
      attachNpcKeyListeners();
      attachedRef.current = true;
    }
  }, []);

  useFrame((_, delta) => {
    const { controlMode, possessedNpcId } = useGameStore.getState();

    // Only active in npc mode with a possessed target
    if (controlMode !== 'npc' || !possessedNpcId) return;

    // Check joystick input first (mobile), then WASD (keyboard)
    let vx = 0;
    let vy = 0;

    const { joystickVelocity } = useGameStore.getState() as GameState;
    if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
      // Screen-relative joystick: up=vy<0, right=vx>0
      vx = joystickVelocity.x;
      vy = joystickVelocity.y;
    } else {
      // Raw WASD input → camera-relative
      let inputFwd = 0;
      let inputRight = 0;
      if (_keys.w) inputFwd += 1;
      if (_keys.s) inputFwd -= 1;
      if (_keys.a) inputRight -= 1;
      if (_keys.d) inputRight += 1;

      if (inputFwd === 0 && inputRight === 0) {
        // No input — set idle (keep last facingAngle so lobster doesn't snap)
        const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
        if (npc && npc.direction !== 'idle') {
          useNpcStore.getState().moveNpc(possessedNpcId, npc.x, npc.y, 'idle', npc.facingAngle);
        }
        return;
      }

      // Normalize diagonal
      if (inputFwd !== 0 && inputRight !== 0) {
        const len = Math.sqrt(inputFwd * inputFwd + inputRight * inputRight);
        inputFwd /= len;
        inputRight /= len;
      }

      // Camera-relative movement: project camera forward onto XZ ground plane
      camera.getWorldDirection(_camForward);
      _camForward.y = 0;
      _camForward.normalize();

      // Right vector: cross forward with world up
      _camRight.crossVectors(_camForward, _worldUp).normalize();

      // World-space velocity (XZ plane)
      vx = _camForward.x * inputFwd + _camRight.x * inputRight;
      vy = _camForward.z * inputFwd + _camRight.z * inputRight;
    }

    // No movement after transform — set idle
    if (vx === 0 && vy === 0) {
      const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
      if (npc && npc.direction !== 'idle') {
        useNpcStore.getState().moveNpc(possessedNpcId, npc.x, npc.y, 'idle', npc.facingAngle);
      }
      return;
    }

    // Lobster GLB faces +Z natively → θ = atan2(worldVx, worldVz)
    const facingAngle = Math.atan2(vx, vy);

    const dir = directionFromVelocity(vx, vy);

    // Find current position
    const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
    if (!npc) return;

    // Compute desired position
    let newX = Math.max(X_MIN, Math.min(X_MAX, npc.x + vx * SPEED * delta));
    let newY = Math.max(Y_MIN, Math.min(Y_MAX, npc.y + vy * SPEED * delta));

    // Building collision — slide along walls (check axes independently)
    if (isInsideBuilding(newX, newY)) {
      // Try X-only movement
      const xOnly = isInsideBuilding(newX, npc.y);
      // Try Y-only movement
      const yOnly = isInsideBuilding(npc.x, newY);

      if (xOnly && yOnly) {
        // Both axes blocked — don't move
        newX = npc.x;
        newY = npc.y;
      } else if (xOnly) {
        // X blocked, slide along Y
        newX = npc.x;
      } else if (yOnly) {
        // Y blocked, slide along X
        newY = npc.y;
      }
      // else: neither axis alone is blocked, allow movement (corner case)
    }

    useNpcStore.getState().moveNpc(possessedNpcId, newX, newY, dir, facingAngle);
  });

  return null;
}
