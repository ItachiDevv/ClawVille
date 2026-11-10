'use client';

import { requestWorldStageNavigation } from '@/components/three/world-stage/stage-navigation';
import { useGameStore } from '@/stores/game';

/**
 * Founder decision 2026-11-10: the BrainChain Office is the ring building
 * `api-integrations` (it replaced the Salty Spitoon). The id stays so quests,
 * pathfinding and building tools keep working.
 */
export const BRAINCHAIN_OFFICE_BUILDING_ID = 'api-integrations';

/**
 * Explicit activation only (the Office button in the building portal). Opens
 * the `/brainchain` page when the player is at the Office building: its portal
 * is open, its resident is in range, or the viewer is in Explore mode.
 */
export function openBrainchainOffice(): boolean {
  const store = useGameStore.getState();
  const fromPortal = store.currentPortalBuildingId === BRAINCHAIN_OFFICE_BUILDING_ID;
  if (!fromPortal && store.movementFrozen) return false;
  if (!fromPortal && store.controlMode !== 'explore' && store.nearLocation !== BRAINCHAIN_OFFICE_BUILDING_ID) return false;
  store.clearClickPath();
  if (!requestWorldStageNavigation({ to: '/brainchain' })) return false;
  if (fromPortal) store.closeBuildingPortal();
  return true;
}
