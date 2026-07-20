import { useTransitionStore } from '@/components/transitions/SceneTransition';
import { useGameStore } from '@/stores/game';
import { KELP_FOREST_PORTAL_WORLD_CENTER } from '@clawville/shared';

const KELP_FOREST_PORTAL_ARM_DISTANCE_WU = 120;

let kelpForestWalkInArmed = false;
let kelpForestTransitionInFlight = false;

/** Arm only after the player is clear of the portal plane's jitter zone. */
export function armKelpForestWalkIn(playerWorldZ: number): boolean {
  if (
    !kelpForestWalkInArmed
    && Math.abs(playerWorldZ - KELP_FOREST_PORTAL_WORLD_CENTER.z)
      > KELP_FOREST_PORTAL_ARM_DISTANCE_WU
  ) {
    kelpForestWalkInArmed = true;
  }
  return kelpForestWalkInArmed;
}

export function isKelpForestWalkInArmed(): boolean {
  return kelpForestWalkInArmed;
}

/** A fresh world mount starts disarmed and clears any prior route flight. */
export function resetKelpForestWalkInLatch(): void {
  kelpForestWalkInArmed = false;
  kelpForestTransitionInFlight = false;
}

export function triggerKelpForestWalkIn(): void {
  const transition = useTransitionStore.getState();
  if (kelpForestTransitionInFlight || transition.active || transition.pending !== null) return;

  kelpForestWalkInArmed = false;
  kelpForestTransitionInFlight = true;
  useGameStore.getState().clearClickPath();
  transition.triggerTransition({ to: '/kelp' });
}
