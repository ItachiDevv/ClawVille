import type {
  StageRequest,
  StageTransitionPhase,
} from './stage-store';

export type StageNavigationOwnership =
  | 'ADOPT'
  | 'EXECUTE_NOW'
  | 'SUPERSEDE';

export function decideStageNavigationOwnership(input: {
  targetSceneId: string;
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
  if (input.transitionPhase === 'fadingOut') {
    return 'ADOPT';
  }
  return 'EXECUTE_NOW';
}
