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
import { findNearestCharacter } from '@/lib/three/character-positions';

const SPEED = 550; // pixels/sec — pass 2 2026-04-16: bumped 320→550 (user tested pass 1 at 320,
                   // still felt sluggish crossing ~2000-wu visible area; target 3-4s crossing time → 2000/550≈3.6s)

// Map pixel bounds
const X_MIN = 16;
const X_MAX = MAP_WIDTH - 16;
const Y_MIN = 16;
const Y_MAX = MAP_HEIGHT - 16;

// ---------------------------------------------------------------------------
// Debug overlay support — gated on window.__DEBUG_FACING (default true for this build)
// Toggle at runtime: window.__DEBUG_FACING = false
// Writes to window.__FACING_DEBUG each frame when possessed + debug is on.
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __DEBUG_FACING: boolean;
    __FACING_DEBUG: {
      inputFwd: number;
      inputRight: number;
      worldVx: number;
      worldVz: number;
      facingAngle: number;
      facingDeg: number;
      camFwdX: number;
      camFwdZ: number;
      direction: string;
      rotationY: number;    // filled by arena-npcs.tsx renderer
      rotationDeg: number;  // filled by arena-npcs.tsx renderer
    };
  }
}
if (typeof window !== 'undefined') {
  if (window.__DEBUG_FACING === undefined) window.__DEBUG_FACING = true;
  window.__FACING_DEBUG = window.__FACING_DEBUG ?? {
    inputFwd: 0, inputRight: 0, worldVx: 0, worldVz: 0,
    facingAngle: 0, facingDeg: 0, camFwdX: 0, camFwdZ: 0,
    direction: 'idle', rotationY: 0, rotationDeg: 0,
  };
}

// Module-level key state — avoids closure allocs
interface NpcKeyState { w: boolean; a: boolean; s: boolean; d: boolean; e: boolean; escape: boolean; }
const _keys: NpcKeyState = { w: false, a: false, s: false, d: false, e: false, escape: false };
let _listenersAttached = false;
let _lastEState = false;
let _lastEscState = false;

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
    const store = useGameStore.getState();
    const { controlMode, possessedNpcId } = store;

    // Only active in npc mode with a possessed target
    if (controlMode !== 'npc' || !possessedNpcId) return;

    // Handle Escape to exit building
    const escNow = _keys.escape;
    if (escNow && !_lastEscState && store.chatOpen) {
      store.exitBuilding();
    }
    _lastEscState = escNow;

    // If movement is frozen (inside a building), skip movement
    if (store.movementFrozen) return;

    // Handle E to enter building
    const eNow = _keys.e;
    if (eNow && !_lastEState && store.nearLocation) {
      store.enterBuilding(store.nearLocation);
      _lastEState = eNow;
      return;
    }
    _lastEState = eNow;

    // ---- Unified input: joystick + WASD → camera-relative ----
    let inputFwd = 0;
    let inputRight = 0;

    const { joystickVelocity } = store as GameState;
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

    // Character proximity check — replaces building-zone area check.
    // findNearestCharacter takes world-space primitives — zero allocation.
    // NPC pixel coords → world coords: worldX = npc.x - MAP_WIDTH/2, worldZ = npc.y - MAP_HEIGHT/2
    {
      const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
      if (npc) {
        const wx = npc.x - MAP_WIDTH  / 2;
        const wz = npc.y - MAP_HEIGHT / 2;
        const nearest = findNearestCharacter(wx, wz);
        const nearId = nearest ? nearest.buildingId : null;
        const nearName = nearest ? nearest.characterName : null;
        if (nearId !== store.nearLocation) store.setNearLocation(nearId);
        if (nearName !== store.nearCharacter) store.setNearCharacter(nearName);
      }
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

    // Facing angle for +X-facing model: atan2(-worldZ, worldX) — EMPIRICALLY VERIFIED 2026-04-16
    const facingAngle = Math.atan2(-worldVz, worldVx);

    // Debug instrumentation — write frame data to window.__FACING_DEBUG
    if (typeof window !== 'undefined' && window.__DEBUG_FACING && window.__FACING_DEBUG) {
      window.__FACING_DEBUG.inputFwd = +inputFwd.toFixed(3);
      window.__FACING_DEBUG.inputRight = +inputRight.toFixed(3);
      window.__FACING_DEBUG.worldVx = +worldVx.toFixed(4);
      window.__FACING_DEBUG.worldVz = +worldVz.toFixed(4);
      window.__FACING_DEBUG.camFwdX = +_camForward.x.toFixed(4);
      window.__FACING_DEBUG.camFwdZ = +_camForward.z.toFixed(4);
      window.__FACING_DEBUG.facingAngle = +facingAngle.toFixed(4);
      window.__FACING_DEBUG.facingDeg = +((facingAngle * 180) / Math.PI).toFixed(1);
    }

    // Cardinal direction for sprite system
    const dir = directionFromVelocity(worldVx, worldVz);

    // Find NPC
    const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
    if (!npc) return;

    // Position update — map bounds only, no building collision
    // worldX maps to pixelX, worldZ maps to pixelY (same scale, different offset)
    const newX = Math.max(X_MIN, Math.min(X_MAX, npc.x + worldVx * SPEED * delta));
    const newY = Math.max(Y_MIN, Math.min(Y_MAX, npc.y + worldVz * SPEED * delta));

    // Write direction to debug object (after dir is computed)
    if (typeof window !== 'undefined' && window.__DEBUG_FACING && window.__FACING_DEBUG) {
      window.__FACING_DEBUG.direction = dir;
    }

    useNpcStore.getState().moveNpc(possessedNpcId, newX, newY, dir, facingAngle);
  });

  return null;
}
