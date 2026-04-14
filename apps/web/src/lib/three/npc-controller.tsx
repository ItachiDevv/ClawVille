'use client';

/**
 * NpcController — WASD / joystick control of a possessed NPC in 'npc' mode.
 *
 * ALL input (keyboard + joystick) is camera-relative:
 *   - Push joystick up / press W → move in the direction the camera faces
 *   - Push joystick right / press D → strafe right from camera's perspective
 *
 * This works correctly regardless of camera rotation / orbit angle.
 * No building collision — just map bounds. Keeps movement simple and predictable.
 */

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameStore, type GameState } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import type { NpcSpriteState } from '@/stores/npc';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

const SPEED = 200; // pixels/sec

// Map pixel bounds
const X_MIN = 16;
const X_MAX = MAP_WIDTH - 16;
const Y_MIN = 16;
const Y_MAX = MAP_HEIGHT - 16;

// Module-level key state — avoids closure allocs
interface NpcKeyState { w: boolean; a: boolean; s: boolean; d: boolean; }
const _keys: NpcKeyState = { w: false, a: false, s: false, d: false };
let _listenersAttached = false;

// Scratch vectors — allocated once, reused every frame
const _camForward = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

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

    // ---- Unified input: joystick + WASD → camera-relative ----
    let inputFwd = 0;
    let inputRight = 0;

    const { joystickVelocity } = useGameStore.getState() as GameState;
    if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
      // Joystick: x = screen-right, y < 0 = screen-up
      inputRight = joystickVelocity.x;
      inputFwd = -joystickVelocity.y; // screen-up → camera forward
    } else {
      if (_keys.w) inputFwd += 1;
      if (_keys.s) inputFwd -= 1;
      if (_keys.a) inputRight -= 1;
      if (_keys.d) inputRight += 1;
    }

    // Normalize diagonal so you don't move faster diagonally
    if (inputFwd !== 0 && inputRight !== 0) {
      const len = Math.sqrt(inputFwd * inputFwd + inputRight * inputRight);
      inputFwd /= len;
      inputRight /= len;
    }

    // No input → set idle (keep last facingAngle so model doesn't snap)
    if (inputFwd === 0 && inputRight === 0) {
      const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
      if (npc && npc.direction !== 'idle') {
        useNpcStore.getState().moveNpc(possessedNpcId, npc.x, npc.y, 'idle', npc.facingAngle);
      }
      return;
    }

    // ---- Camera-relative transform ----
    camera.getWorldDirection(_camForward);
    _camForward.y = 0;
    const fwdLen = _camForward.length();
    if (fwdLen < 0.001) return; // Camera nearly vertical — skip
    _camForward.divideScalar(fwdLen);

    _camRight.crossVectors(_camForward, _worldUp).normalize();

    // World-space velocity (XZ plane)
    const worldVx = _camForward.x * inputFwd + _camRight.x * inputRight;
    const worldVz = _camForward.z * inputFwd + _camRight.z * inputRight;

    // Facing angle for -Z-facing model: atan2(-worldX, -worldZ)
    const facingAngle = Math.atan2(-worldVx, -worldVz);

    // Cardinal direction for sprite system
    const dir = directionFromVelocity(worldVx, worldVz);

    // Find NPC
    const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
    if (!npc) return;

    // Position update — map bounds only, no building collision
    // worldX maps to pixelX, worldZ maps to pixelY (same scale, different offset)
    const newX = Math.max(X_MIN, Math.min(X_MAX, npc.x + worldVx * SPEED * delta));
    const newY = Math.max(Y_MIN, Math.min(Y_MAX, npc.y + worldVz * SPEED * delta));

    useNpcStore.getState().moveNpc(possessedNpcId, newX, newY, dir, facingAngle);
  });

  return null;
}
