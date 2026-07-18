import { useTransitionStore } from '@/components/transitions/SceneTransition';
import { useGameStore } from '@/stores/game';

export function triggerKelpForestWalkIn(): void {
  useGameStore.getState().clearClickPath();
  useTransitionStore.getState().triggerTransition({ to: '/kelp' });
}
