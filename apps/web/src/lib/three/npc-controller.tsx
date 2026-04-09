'use client';

/**
 * NpcController — WASD possession of a single NPC in 'npc' control mode.
 *
 * Rendered inside the R3F Canvas (SceneContents). When controlMode === 'npc'
 * and possessedNpcId is set, every frame this reads WASD key state and calls
 * npcStore.moveNpc() to update the possessed NPC's position + direction.
 *
 * Speed: 200 units/sec — matches player-pet.tsx SPEED constant.
 * Direction: same mapping as player-pet (w=up, s=down, a=left, d=right in 2D game-space).
 * Bounds: clamped to [16, MAP_WIDTH-16] × [16, MAP_HEIGHT-16].
 *
 * The wander tick in npc.ts already skips the possessed NPC, so there is no
 * race between player input and autonomous movement.
 */

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGameStore } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import type { NpcSpriteState } from '@/stores/npc';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

const SPEED = 200; // units/sec — matches player-pet.tsx

// Map pixel bounds (mirror player-pet clamp)
const X_MIN = 16;
const X_MAX = MAP_WIDTH - 16;
const Y_MIN = 16;
const Y_MAX = MAP_HEIGHT - 16;

// Module-level key state — same pattern as player-pet.tsx, avoids closure allocs
interface NpcKeyState {
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
}

const _keys: NpcKeyState = { w: false, a: false, s: false, d: false };
let _listenersAttached = false;

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
  // Dominant axis determines direction — same logic as player-pet.tsx
  if (Math.abs(vx) >= Math.abs(vy)) {
    return vx > 0 ? 'right' : 'left';
  }
  return vy > 0 ? 'down' : 'up';
}

export default function NpcController() {
  // Track whether we've attached key listeners inside the component lifecycle
  const attachedRef = useRef(false);

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

    // Build velocity vector from current key state
    let vx = 0;
    let vy = 0;
    if (_keys.w) vy -= 1;
    if (_keys.s) vy += 1;
    if (_keys.a) vx -= 1;
    if (_keys.d) vx += 1;

    // Normalize diagonal movement
    if (vx !== 0 && vy !== 0) {
      const len = Math.sqrt(vx * vx + vy * vy);
      vx /= len;
      vy /= len;
    }

    const dir = directionFromVelocity(vx, vy);

    // No input — just ensure direction is idle (don't move, don't write state every frame)
    if (vx === 0 && vy === 0) {
      // Only update direction to idle if npc is currently moving — avoids churning state
      const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
      if (npc && npc.direction !== 'idle') {
        useNpcStore.getState().moveNpc(possessedNpcId, npc.x, npc.y, 'idle');
      }
      return;
    }

    // Find current position
    const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
    if (!npc) return;

    const newX = Math.max(X_MIN, Math.min(X_MAX, npc.x + vx * SPEED * delta));
    const newY = Math.max(Y_MIN, Math.min(Y_MAX, npc.y + vy * SPEED * delta));

    useNpcStore.getState().moveNpc(possessedNpcId, newX, newY, dir);
  });

  // This component has no visual output — it's a pure controller
  return null;
}
