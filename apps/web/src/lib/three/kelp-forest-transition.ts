import { useTransitionStore } from '@/components/transitions/SceneTransition';
import { useGameStore } from '@/stores/game';

let kelpForestTransitionInFlight = false;

/** A fresh world mount clears any prior route flight. */
export function resetKelpForestWalkInLatch(): void {
  kelpForestTransitionInFlight = false;
}

export function triggerKelpForestWalkIn(): void {
  const transition = useTransitionStore.getState();
  if (kelpForestTransitionInFlight || transition.active || transition.pending !== null) return;

  kelpForestTransitionInFlight = true;
  useGameStore.getState().clearClickPath();
  transition.triggerTransition({ to: '/kelp' });
}
