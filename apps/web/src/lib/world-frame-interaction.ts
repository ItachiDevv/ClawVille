import { useGameStore } from '@/stores/game';
import { findNearestCharacter, isAtTradingFloorDoorFace, isCoveProximate, isTradingFloorProximate, isKelpForestPortalProximate } from './three/character-positions';
import { NORI_WORLD_X, NORI_WORLD_Z, NORI_TALK_RADIUS_SQ } from './three/town-guide-position';
import { TRADING_FLOOR_NEAR_ID } from './three/trading-floor/trading-floor-location';
import { triggerCoveWalkIn, triggerTradingFloorWalkIn } from './three/venue-walk-in';
import { triggerKelpForestWalkIn } from './three/kelp-forest-transition';
import { useTransitionStore } from '@/components/transitions/SceneTransition';
/** Walk-into-the-door auto-enter for the Trading Floor (founder report 2026-11-11).
 *  Fires once on reaching the door-face strip; re-arms only after the body
 *  leaves the door prompt band, so standing at the face or failing to cross
 *  (2D view toast) never repeats, and the exit spawn (outside the band) cannot
 *  loop. Human-driven bodies only, like the cove tunnel: autonomous agents and
 *  the explore camera are never pulled in. */
let tradingFloorAutoArmed = true;
export function resetTradingFloorAutoEnterForTests(): void { tradingFloorAutoArmed = true; }
export function stepTradingFloorAutoEnter(x: number, z: number): void {
  if (!isTradingFloorProximate(x, z)) { tradingFloorAutoArmed = true; return; }
  if (!tradingFloorAutoArmed || !isAtTradingFloorDoorFace(x, z)) return;
  const state = useGameStore.getState();
  if (state.controlMode !== 'player' && state.controlMode !== 'npc') return;
  if (state.movementFrozen || useTransitionStore.getState().active) return;
  tradingFloorAutoArmed = false;
  triggerTradingFloorWalkIn();
}
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
  stepTradingFloorAutoEnter(x, z);
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
