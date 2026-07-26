'use client';

export interface WorldStageNavigationRequest {
  to: '/game' | '/cove';
  onMidway?: () => void;
}

type WorldStageNavigationHandler = (
  request: WorldStageNavigationRequest,
) => boolean;

let navigationHandler: WorldStageNavigationHandler | null = null;

export function installWorldStageNavigationHandler(
  handler: WorldStageNavigationHandler,
): () => void {
  navigationHandler = handler;
  return () => {
    if (navigationHandler === handler) {
      navigationHandler = null;
    }
  };
}

/**
 * Routes an in-group world crossing through the persistent stage.
 *
 * Returns false outside the `(world)` layout so legacy callers can fall back
 * to `SceneTransition` for route-isolated canvases.
 */
export function requestWorldStageNavigation(
  request: WorldStageNavigationRequest,
): boolean {
  return navigationHandler?.(request) ?? false;
}
