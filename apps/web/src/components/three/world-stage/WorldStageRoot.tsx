'use client';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  readStageBackend,
  readStageCameraPoses,
  WorldStageCanvas,
  type WorldStageScene,
} from './WorldStageCanvas';
import { StageTransition } from './StageTransition';
import {
  requestStageScene,
  resetStageStore,
  type StageRequest,
  useStageStore,
} from './stage-store';
import {
  readStageFrameInvocations,
  resetStageFrameDiagnostics,
} from './use-scene-frame';
import {
  installWorldStageNavigationHandler,
  requestWorldStageNavigation,
  type WorldStageNavigationRequest,
} from './stage-navigation';

const WORLD_SCENE_ID = 'world';
const COVE_SCENE_ID = 'cove';
const LazyStageHostedWorldScene = lazy(
  () => import('./StageHostedWorldScene'),
);
const LazyStageHostedCoveScene = lazy(
  () => import('./StageHostedCoveScene'),
);

function sceneIdForPathname(pathname: string): string | null {
  if (pathname === '/game') return WORLD_SCENE_ID;
  if (pathname === '/cove') return COVE_SCENE_ID;
  return null;
}

export function WorldStageRoot({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [stageReady, setStageReady] = useState(false);
  const [coveSceneEmpty, setCoveSceneEmpty] = useState(false);
  const [displayedChildren, setDisplayedChildren] =
    useState<ReactNode>(children);
  const displayedPathRef = useRef(pathname);
  const pendingRouteChildrenRef = useRef<{
    pathname: string;
    children: ReactNode;
  } | null>(null);
  const navigationRef = useRef<{
    requestId: number;
    navigation: WorldStageNavigationRequest;
  } | null>(null);

  useEffect(() => {
    resetStageStore();
    resetStageFrameDiagnostics();
    setStageReady(true);
  }, []);

  useEffect(() => {
    if (!stageReady) return;
    const sceneId = sceneIdForPathname(pathname);
    if (!sceneId) return;
    const state = useStageStore.getState();
    const pathAlreadyDisplayed = displayedPathRef.current === pathname;
    const destinationAlreadyOpaque =
      state.activeScene === sceneId &&
      (state.transition?.phase === 'awaiting' ||
        state.transition?.phase === 'fadingIn' ||
        state.transition?.phase === 'idle');

    if (pathAlreadyDisplayed || destinationAlreadyOpaque) {
      displayedPathRef.current = pathname;
      pendingRouteChildrenRef.current = null;
      setDisplayedChildren(children);
    } else {
      // A browser back/forward traversal swaps App Router children before the
      // stage has faded out. Hold the previously displayed page until the
      // destination request reaches the opaque midpoint.
      pendingRouteChildrenRef.current = { pathname, children };
    }

    if (
      state.pendingRequest?.sceneId !== sceneId &&
      !(state.pendingRequest === null && state.activeScene === sceneId)
    ) {
      requestStageScene(sceneId);
    }
  }, [children, pathname, stageReady]);

  useEffect(() => {
    if (!stageReady) return;
    return installWorldStageNavigationHandler((navigation) => {
      const sceneId = sceneIdForPathname(navigation.to);
      if (!sceneId) return false;
      const state = useStageStore.getState();
      if (
        state.pendingRequest !== null ||
        state.transition?.phase === 'error'
      ) {
        return true;
      }
      requestStageScene(sceneId);
      const request = useStageStore.getState().pendingRequest;
      if (!request || request.sceneId !== sceneId) return false;
      navigationRef.current = {
        requestId: request.requestId,
        navigation,
      };
      return true;
    });
  }, [stageReady]);

  const handleTransitionOpaque = useCallback(
    (request: StageRequest) => {
      const pendingRoute = pendingRouteChildrenRef.current;
      if (
        pendingRoute &&
        sceneIdForPathname(pendingRoute.pathname) === request.sceneId
      ) {
        pendingRouteChildrenRef.current = null;
        displayedPathRef.current = pendingRoute.pathname;
        setDisplayedChildren(pendingRoute.children);
      }
      const pendingNavigation = navigationRef.current;
      if (
        !pendingNavigation ||
        pendingNavigation.requestId !== request.requestId
      ) {
        return;
      }
      navigationRef.current = null;
      pendingNavigation.navigation.onMidway?.();
      router.push(pendingNavigation.navigation.to);
    },
    [router],
  );

  useEffect(() => {
    if (!stageReady) return;
    const probeWindow = window as typeof window & {
      __WORLD_STAGE_PROBE__?: {
        request: (sceneId: string) => void;
        navigate?: (to: '/game' | '/cove') => boolean;
        snapshot: () => Record<string, unknown>;
      };
    };
    probeWindow.__WORLD_STAGE_PROBE__ = {
      request: requestStageScene,
      navigate: (to) => {
        return requestWorldStageNavigation({ to });
      },
      snapshot: () => {
        const state = useStageStore.getState();
        return {
          pathname: window.location.pathname,
          activeScene: state.activeScene,
          transitionPhase: state.transition?.phase ?? 'idle',
          transitionError: state.transition?.error ?? null,
          canvasMountCount: state.canvasMountCount,
          listenerCount: state.windowListenerCount,
          listenerUnderflowCount: state.listenerUnderflowCount,
          recoveryCount: state.recovery.count,
          lastRecoveryReason: state.recovery.lastReason,
          backend: readStageBackend(),
          frames: readStageFrameInvocations(),
          cameras: readStageCameraPoses(),
          slots: state.scenes,
          transitionErrors: [...state.transitionErrors],
        };
      },
    };
    return () => {
      delete probeWindow.__WORLD_STAGE_PROBE__;
    };
  }, [router, stageReady]);

  const scenes = useMemo<readonly WorldStageScene[]>(
    () => [
      {
        sceneId: WORLD_SCENE_ID,
        camera: {
          fov: 50,
          near: 1,
          far: 11_500,
          position: [0, 600, 1_300],
        },
        appearance: {
          background: 0x0a2a4a,
          fog: {
            color: 0x0e3458,
            near: 5_000,
            far: 10_500,
          },
          shadows: true,
        },
        content: (
          <Suspense fallback={null}>
            <LazyStageHostedWorldScene />
          </Suspense>
        ),
      },
      {
        sceneId: COVE_SCENE_ID,
        camera: {
          fov: 65,
          near: 1,
          far: 2_000,
          position: [0, 55, 400],
          lookAt: [0, 70, -411],
        },
        appearance: {
          background: 0x0a0015,
          fog: {
            color: 0x0a0015,
            near: 4_000,
            far: 10_000,
          },
          shadows: false,
        },
        content: (
          <Suspense fallback={null}>
            <LazyStageHostedCoveScene
              onSceneEmpty={() => setCoveSceneEmpty(true)}
            />
          </Suspense>
        ),
      },
    ],
    [],
  );

  return (
    <div className="world-stage-root relative h-screen w-full overflow-hidden">
      {stageReady && (
        <div className="absolute inset-0 z-0">
          <WorldStageCanvas
            scenes={scenes}
            transitionTimeoutMs={45_000}
            pauseOnCreate
            renderTransitionOverlay={false}
            onTransitionOpaque={handleTransitionOpaque}
          />
        </div>
      )}
      <div className="world-stage-page-layer pointer-events-none absolute inset-0 z-10">
        {stageReady ? displayedChildren : null}
      </div>
      {coveSceneEmpty && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[rgba(10,0,21,0.85)]">
          <div className="rounded-lg border border-fuchsia-500 bg-black/60 px-8 py-6 text-center font-mono text-base text-fuchsia-300">
            Cove interior failed to load — please refresh
          </div>
        </div>
      )}
      <StageTransition
        timeoutMs={45_000}
        onOpaque={handleTransitionOpaque}
      />
    </div>
  );
}
