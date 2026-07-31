import type {
  StageTransitionPhase,
} from '@/components/three/world-stage/stage-store';
import type {
  WorldStageNavigationSnapshot,
} from '@/components/three/world-stage/stage-navigation';

export interface KelpWalkInInput {
  readonly nowMs: number;
  readonly legacyLatchArmed: boolean;
  readonly nav: WorldStageNavigationSnapshot;
  readonly stageActiveScene: string | null;
  readonly stagePendingSceneId: string | null;
  readonly stageTransitionPhase: StageTransitionPhase | null;
  readonly legacyTransitionActive: boolean;
  readonly legacyTransitionPending: boolean;
}

export type KelpWalkInDecision = {
  readonly kind: 'BLOCKED' | 'PROCEED';
  readonly reason?: 'in-flight' | 'already-there';
  readonly releaseLegacyLatch: boolean;
};

export function decideKelpWalkIn(
  input: KelpWalkInInput,
): KelpWalkInDecision {
  if (
    input.legacyTransitionActive ||
    input.legacyTransitionPending
  ) {
    return {
      kind: 'BLOCKED',
      reason: 'in-flight',
      releaseLegacyLatch: false,
    };
  }

  const releaseLegacyLatch = input.legacyLatchArmed;
  const bufferedActive =
    input.nav.bufferedPathname !== null &&
    input.nav.bufferedExpiresAt !== null &&
    input.nav.bufferedExpiresAt > input.nowMs;

  if (bufferedActive && input.nav.bufferedPathname === '/kelp') {
    return {
      kind: 'BLOCKED',
      reason: 'in-flight',
      releaseLegacyLatch,
    };
  }

  if (bufferedActive && input.nav.bufferedPathname !== '/kelp') {
    return { kind: 'PROCEED', releaseLegacyLatch };
  }

  if (
    input.stagePendingSceneId === 'kelp' &&
    input.stageTransitionPhase === 'error'
  ) {
    return { kind: 'PROCEED', releaseLegacyLatch };
  }

  if (input.stagePendingSceneId === 'kelp') {
    return {
      kind: 'BLOCKED',
      reason: 'in-flight',
      releaseLegacyLatch,
    };
  }

  if (
    input.stageActiveScene === 'kelp' &&
    input.stagePendingSceneId === null
  ) {
    return {
      kind: 'BLOCKED',
      reason: 'already-there',
      releaseLegacyLatch,
    };
  }

  return { kind: 'PROCEED', releaseLegacyLatch };
}
