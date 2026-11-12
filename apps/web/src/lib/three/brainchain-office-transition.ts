'use client';

import { requestWorldStageNavigation } from '@/components/three/world-stage/stage-navigation';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { useNpcStore, PLAYER_NPC_ID } from '@/stores/npc';
import { useActivityStore } from '@/stores/activity';
import { useTransitionStore } from '@/components/transitions/SceneTransition';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { isInsideOfficeVortex, OFFICE_EXIT_WORLD, OFFICE_YAW, setOfficeReturnFacing } from './brainchain-office-door';
import { isWorldInputBlocked } from './world-input-guard';

/**
 * Founder decision 2026-11-10: the BrainChain Office is the ring building
 * `api-integrations` (it replaced the Salty Spitoon). The id stays so quests,
 * pathfinding and building tools keep working.
 */
export const BRAINCHAIN_OFFICE_BUILDING_ID = 'api-integrations';

/**
 * Portal-button or guarded local walk-in activation. Opens
 * the `/brainchain` page when the player is at the Office building: its portal
 * is open, its resident is in range, or the viewer is in Explore mode.
 */
export function openBrainchainOffice(source: 'button' | 'walk-in' = 'button'): boolean {
  const store = useGameStore.getState();
  const walkIn = source === 'walk-in';
  if (walkIn && (!canWalkIntoBrainchainOffice() || !isInsideOfficeVortex(avatarPositionRef.x - MAP_WIDTH / 2, avatarPositionRef.y - MAP_HEIGHT / 2))) return false;
  const fromPortal = store.currentPortalBuildingId === BRAINCHAIN_OFFICE_BUILDING_ID;
  if (!fromPortal && store.movementFrozen) return false;
  if (!walkIn && !fromPortal && store.controlMode !== 'explore' && store.nearLocation !== BRAINCHAIN_OFFICE_BUILDING_ID) return false;
  store.clearClickPath();
  if (!requestWorldStageNavigation({ to: '/brainchain' })) return false;
  if (fromPortal) store.closeBuildingPortal();
  return true;
}

/** Match the Cove's human-driven modes, and exclude all modal/activity owners. */
export function canWalkIntoBrainchainOffice(): boolean {
  const s = useGameStore.getState();
  return (s.controlMode === 'player' || s.controlMode === 'npc')
    && !s.avatarIsAutonomous && !s.movementFrozen && !s.warpTarget
    && !s.currentPortalBuildingId && !s.activityLobbyId && !useActivityStore.getState().roomId
    && !s.chatOpen && !s.guideChatOpen && !s.menuOpen && !s.settingsModalOpen
    && !s.walletLinkModalOpen && !s.cosmeticDrawerOpen && !s.locationConfigModalOpen
    && !s.inventoryOpen && !s.shopOpen && !s.activityFeedOpen && !s.agentConnectModalOpen
    && !s.skillBuilderOpen && !s.landOfficeOpen && !s.worldMapOpen && !s.questBoardOpen
    && !s.bountyBoardOpen && !s.exchangeOpen && !s.tradingFloorOpen && !s.leaderboardOpen
    && !s.arenaSettingsOpen && !useTransitionStore.getState().active && !isWorldInputBlocked()
    && (typeof window === 'undefined' || window.location.pathname === '/game');
}

/** Same midpoint/expiry/refusal placement as the Cove exit. Outside the trigger. */
export function placeAtBrainchainOfficeExit(): void {
  const x = MAP_WIDTH / 2 + OFFICE_EXIT_WORLD.x, y = MAP_HEIGHT / 2 + OFFICE_EXIT_WORLD.z;
  avatarPositionRef.x = x; avatarPositionRef.y = y;
  const s = useGameStore.getState(); s.clearClickPath();
  // Placement must bypass the 100 ms movement-write throttle.
  useGameStore.setState({ avatarPosition: { x, y } });
  useNpcStore.getState().placePlayerNpc(x, y);
  const bodyId = s.controlMode === 'npc' ? (s.possessedNpcId ?? PLAYER_NPC_ID) : PLAYER_NPC_ID;
  const npc = useNpcStore.getState().npcs.find((item) => item.id === bodyId);
  if (npc) {
    npc.x = x; npc.y = y; npc.prevX = x; npc.prevY = y;
    npc.direction = 'idle'; npc.isRunning = false; npc.facingAngle = OFFICE_YAW;
  }
  setOfficeReturnFacing();
}
