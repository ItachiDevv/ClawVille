'use client';

import { BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME, BRAINCHAIN_OFFICE_GUIDE_APPROACH_GAME, isBrainchainOfficeDoorWorld, isBrainchainOfficeGuideWorld } from '@clawville/shared';
import { requestWorldStageNavigation } from '@/components/three/world-stage/stage-navigation';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { findPath } from '@/lib/pixi/client-pathfinding';
import { useNpcStore } from '@/stores/npc';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

export const BRAINCHAIN_GUIDE_NEAR_ID = 'brainchain-office-guide';

/** Explicit activation only. Crossing the prompt never enters automatically. */
export function openBrainchainOffice(guide = false): boolean {
  const store = useGameStore.getState();
  const npc = store.controlMode === 'npc' ? useNpcStore.getState().npcs.find((candidate) => candidate.id === store.possessedNpcId) : undefined;
  const wx = (npc?.x ?? avatarPositionRef.x) - MAP_WIDTH / 2;
  const wz = (npc?.y ?? avatarPositionRef.y) - MAP_HEIGHT / 2;
  if (store.movementFrozen) return false;
  if (store.controlMode !== 'explore' && !(guide ? isBrainchainOfficeGuideWorld(wx, wz) : isBrainchainOfficeDoorWorld(wx, wz))) return false;
  store.clearClickPath();
  return requestWorldStageNavigation({ to: guide ? '/brainchain#office-guide-heading' : '/brainchain' });
}

export function approachBrainchainOffice(guide = false): void {
  const store = useGameStore.getState();
  if (store.movementFrozen) return;
  if (openBrainchainOffice(guide)) return;
  const target = guide ? BRAINCHAIN_OFFICE_GUIDE_APPROACH_GAME : BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME;
  const npc = store.controlMode === 'npc' ? useNpcStore.getState().npcs.find((candidate) => candidate.id === store.possessedNpcId) : undefined;
  const path = findPath(npc?.x ?? avatarPositionRef.x, npc?.y ?? avatarPositionRef.y, target.x, target.y);
  if (path.length) store.setClickPath(path, guide ? BRAINCHAIN_GUIDE_NEAR_ID : 'brainchain-office');
}
