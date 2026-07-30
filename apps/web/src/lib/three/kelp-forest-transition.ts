import { useTransitionStore } from '@/components/transitions/SceneTransition';
import {
  readWorldStageNavigationSnapshot,
  requestWorldStageNavigation,
} from '@/components/three/world-stage/stage-navigation';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { useGameStore } from '@/stores/game';
import { decideKelpWalkIn } from './kelp-walkin-guard';

let kelpForestTransitionInFlight = false;

/** A fresh world mount clears any prior route flight. */
export function resetKelpForestWalkInLatch(): void {
  kelpForestTransitionInFlight = false;
}

export function triggerKelpForestWalkIn(): void {
  const transition = useTransitionStore.getState();
  const stage = useStageStore.getState();
  const decision = decideKelpWalkIn({
    nowMs: Date.now(),
    legacyLatchArmed: kelpForestTransitionInFlight,
    nav: readWorldStageNavigationSnapshot(),
    stageActiveScene: stage.activeScene,
    stagePendingSceneId: stage.pendingRequest?.sceneId ?? null,
    stageTransitionPhase: stage.transition?.phase ?? null,
    legacyTransitionActive: transition.active,
    legacyTransitionPending: transition.pending !== null,
  });
  if (decision.releaseLegacyLatch) {
    kelpForestTransitionInFlight = false;
  }
  if (decision.kind === 'BLOCKED') return;
  useGameStore.getState().clearClickPath();
  const requested = requestWorldStageNavigation({
    to: '/kelp',
    onExpired: () => {
      if (
        typeof window === 'undefined' ||
        window.location.pathname !== '/game'
      ) {
        return;
      }
      kelpForestTransitionInFlight = true;
      useTransitionStore
        .getState()
        .triggerTransition({ to: '/kelp' });
    },
  });
  if (!requested) {
    kelpForestTransitionInFlight = true;
    useTransitionStore
      .getState()
      .triggerTransition({ to: '/kelp' });
  }
}
