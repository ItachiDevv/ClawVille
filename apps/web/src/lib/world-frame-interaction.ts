import { useGameStore } from '@/stores/game';
import { findNearestCharacter, isCoveProximate, isTradingFloorProximate, isKelpForestPortalProximate } from './three/character-positions';
import { NORI_WORLD_X, NORI_WORLD_Z, NORI_TALK_RADIUS_SQ } from './three/town-guide-position';
import { TRADING_FLOOR_NEAR_ID } from './three/trading-floor/trading-floor-location';
import { triggerCoveWalkIn, triggerTradingFloorWalkIn } from './three/venue-walk-in';
import { triggerKelpForestWalkIn } from './three/kelp-forest-transition';
export function readWorldProximity(x: number, z: number, includeWanderers = false) {
  const nearest = findNearestCharacter(x, z, includeWanderers ? undefined : null);
  return {
    nearLocation: nearest ? nearest.buildingId : isCoveProximate(x, z) ? 'cove'
      : isTradingFloorProximate(x, z) ? TRADING_FLOOR_NEAR_ID
      : isKelpForestPortalProximate(x, z) ? 'kelp-forest-portal' : null,
    nearCharacter: nearest?.characterName ?? null,
    nearGuide: (x - NORI_WORLD_X) ** 2 + (z - NORI_WORLD_Z) ** 2 < NORI_TALK_RADIUS_SQ,
  };
}
export function updateWorldProximity(x: number, z: number, includeWanderers = false): void {
  const proximity = readWorldProximity(x, z, includeWanderers), state = useGameStore.getState();
  if (state.nearLocation !== proximity.nearLocation) state.setNearLocation(proximity.nearLocation);
  if (state.nearCharacter !== proximity.nearCharacter) state.setNearCharacter(proximity.nearCharacter);
  if (state.nearGuide !== proximity.nearGuide) state.setNearGuide(proximity.nearGuide);
}
export function dispatchWorldInteraction(target?: string | null): boolean {
  const state = useGameStore.getState();
  if (target === undefined && state.nearGuide && !state.guideChatOpen && !state.chatOpen) { state.openGuideChat(); return true; }
  const location = target === undefined ? state.nearLocation : target;
  if (!location || location !== state.nearLocation) return false;
  if (location === 'cove') triggerCoveWalkIn();
  else if (location === TRADING_FLOOR_NEAR_ID) triggerTradingFloorWalkIn();
  else if (location === 'kelp-forest-portal') triggerKelpForestWalkIn();
  else state.enterBuilding(location);
  return true;
}
