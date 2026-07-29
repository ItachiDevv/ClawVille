'use client';

/**
 * JumpTicker — zero-render R3F component that runs the jump physics tick.
 *
 * Mounted ONCE at the top of SceneContents in World3DCanvas.tsx, BEFORE
 * FPSFollowCamera, ArenaNpcs, NpcController, and PlayerAvatar.
 *
 * Stage frame callbacks run in ascending priority order. Player controllers
 * subscribe at -100 and this ticker remains at the default priority 0, so the
 * controller dispatches first and JumpTicker advances physics afterward.
 *
 * The SPACE keyboard listener is attached on mount via attachJumpListeners()
 * (idempotent — safe to call multiple times across hot reloads).
 */

import { useEffect } from 'react';
import {
  useSceneActive,
  useSceneFrame,
} from '@/components/three/world-stage/use-scene-frame';
import { useGameStore } from '@/stores/game';
import { attachJumpListeners, updateJump } from '@/lib/three/jump-state';

export default function JumpTicker() {
  const sceneActive = useSceneActive();
  useEffect(() => {
    if (!sceneActive) return;
    return attachJumpListeners();
  }, [sceneActive]);

  useSceneFrame((_, delta) => {
    const { controlMode, movementFrozen } = useGameStore.getState();
    // enterBuilding() calls resetJump() synchronously before setting movementFrozen=true,
    // so we can early-return here without leaving the avatar stranded airborne.
    if (movementFrozen) return;
    // Only tick jump physics for modes that have a user-controllable avatar.
    // explore = no avatar, autonomous = engine-driven.
    if (controlMode === 'player' || controlMode === 'npc') {
      updateJump(delta);
    }
  });

  return null;
}
