import type {
  StageRequest,
  StageTransitionPhase,
} from './stage-store';

export type StageNavigationOwnership =
  | 'ADOPT'
  | 'EXECUTE_NOW'
  | 'SUPERSEDE';

export type StageNavigationHistoryMethod = 'push' | 'replace';

export function decideStageNavigationHistoryMethod(
  committedStageNavigations: number,
): StageNavigationHistoryMethod {
  return committedStageNavigations < 2 ? 'push' : 'replace';
}

export function decideStageNavigationOwnership(input: {
  targetSceneId: string;
  targetDestinationKey?: string | null;
  pendingDestinationKey?: string | null;
  pendingRequest: StageRequest | null;
  transitionPhase: StageTransitionPhase | null;
}): StageNavigationOwnership {
  if (input.transitionPhase === 'error') {
    return 'SUPERSEDE';
  }
  if (!input.pendingRequest) {
    return 'SUPERSEDE';
  }
  if (input.pendingRequest.sceneId !== input.targetSceneId) {
    return 'SUPERSEDE';
  }
  if (
    input.targetDestinationKey != null &&
    input.pendingDestinationKey != null &&
    input.pendingDestinationKey !== input.targetDestinationKey
  ) {
    return 'SUPERSEDE';
  }
  if (input.transitionPhase === 'fadingOut') {
    return 'ADOPT';
  }
  return 'EXECUTE_NOW';
}
