'use client';

/**
 * NpcController — WASD possession of a single NPC in 'npc' control mode.
 *
 * Rendered inside the R3F Canvas (SceneContents). When controlMode === 'npc'
 * and possessedNpcId is set, every frame this reads WASD key state and calls
 * npcStore.moveNpc() to update the possessed NPC's position + direction.
 *
 * Speed: 200 units/sec — matches player-avatar.tsx SPEED constant.
 * Direction: same mapping as player-avatar (w=up, s=down, a=left, d=right in 2D game-space).
 * Bounds: clamped to [16, MAP_WIDTH-16] × [16, MAP_HEIGHT-16].
 *
 * The wander tick in npc.ts already skips the possessed NPC, so there is no
 * race between player input and autonomous movement.
 */

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameStore } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import type { NpcSpriteState } from '@/stores/npc';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

const SPEED = 200; // units/sec — matches player-avatar.tsx

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
  // Dominant axis determines direction — same logic as player-avatar.tsx
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

    // Raw WASD input
    let inputFwd = 0;
    let inputRight = 0;
    if (_keys.w) inputFwd += 1;
    if (_keys.s) inputFwd -= 1;
    if (_keys.a) inputRight -= 1;
    if (_keys.d) inputRight += 1;

    // No input — set idle
    if (inputFwd === 0 && inputRight === 0) {
      const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
      if (npc && npc.direction !== 'idle') {
        useNpcStore.getState().moveNpc(possessedNpcId, npc.x, npc.y, 'idle');
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
    const worldVx = _camForward.x * inputFwd + _camRight.x * inputRight;
    const worldVz = _camForward.z * inputFwd + _camRight.z * inputRight;

    // Convert world deltas to game-space:
    //   game X = world X + HALF_W  → delta gameX = delta worldX
    //   game Y = world Z + HALF_H  → delta gameY = delta worldZ
    const vx = worldVx;
    const vy = worldVz;

    const dir = directionFromVelocity(vx, vy);

    // Find current position
    const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
    if (!npc) return;

    const newX = Math.max(X_MIN, Math.min(X_MAX, npc.x + vx * SPEED * delta));
    const newY = Math.max(Y_MIN, Math.min(Y_MAX, npc.y + vy * SPEED * delta));

    useNpcStore.getState().moveNpc(possessedNpcId, newX, newY, dir);
  });

  return null;
}
