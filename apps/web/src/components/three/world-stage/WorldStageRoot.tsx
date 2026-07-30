'use client';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  readStageBackend,
  readStageCameraPoses,
  readStageRendererCounters,
  requestStageRendererRecovery,
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
  advanceWorldStageRoute,
  installWorldStageNavigationHandler,
  markWorldStageMounted,
  markWorldStageUnmounted,
  requestWorldStageNavigation,
  type WorldStageNavigationRequest,
} from './stage-navigation';
import {
  decideStageNavigationHistoryMethod,
  decideStageNavigationOwnership,
} from './stage-navigation-ownership';
import {
  rekeyParkedNavigationForRetry,
  takeParkedNavigationForOpaque,
} from './stage-navigation-lineage';
import {
  readStageResourceLedger,
  readStageSceneInventory,
} from './resource-ledger';
import { StageCanvasErrorBoundary } from './StageCanvasErrorBoundary';
import { StageSlotErrorBoundary } from './StageSlotErrorBoundary';
import {
  getStageRendererFailure,
  getStageRendererFailureServerSnapshot,
  subscribeStageRendererFailure,
} from './stage-renderer-status';
import {
  describeErrorForBeacon,
  reportKelpRenderFailure,
} from '@/lib/three/kelp-render-failure-beacon';

const WORLD_SCENE_ID = 'world';
const COVE_SCENE_ID = 'cove';
const KELP_SCENE_ID = 'kelp';
const LazyStageHostedWorldScene = lazy(
  () => import('./StageHostedWorldScene'),
);
const LazyStageHostedCoveScene = lazy(
  () => import('./StageHostedCoveScene'),
);
const LazyStageHostedKelpScene = lazy(() =>
  import('./StageHostedKelpScene').catch((error: unknown) => {
    console.error(
      '[KelpRealm] slot chunk failed to load:',
      error,
    );
    void import('@/lib/three/kelp-render-failure-beacon')
      .then(({ reportKelpRenderFailure, describeErrorForBeacon }) =>
        reportKelpRenderFailure(
          'chunk-load-failed',
          describeErrorForBeacon(error),
        ),
      )
      .catch(() => undefined);
    throw error;
  }),
);

function sceneIdForPathname(pathname: string): string | null {
  if (pathname === '/game') return WORLD_SCENE_ID;
  if (pathname === '/cove') return COVE_SCENE_ID;
  if (pathname === '/kelp') return KELP_SCENE_ID;
  return null;
}

export function WorldStageRoot({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [stageReady, setStageReady] = useState(false);
  const [coveSceneEmpty, setCoveSceneEmpty] = useState(false);
  const [kelpRuntimeCrashKey, setKelpRuntimeCrashKey] =
    useState<string | null>(null);
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
  const pendingRequestForLineage = useStageStore(
    (state) => state.pendingRequest,
  );
  const kelpGeneration = useStageStore(
    (state) => state.scenes[KELP_SCENE_ID]?.generation ?? 0,
  );
  const recoveryCount = useStageStore(
    (state) => state.recovery.count,
  );
  const rendererFailure = useSyncExternalStore(
    subscribeStageRendererFailure,
    getStageRendererFailure,
    getStageRendererFailureServerSnapshot,
  );
  const kelpResetKey = `${kelpGeneration}:${recoveryCount}`;
  const coldInitIssuedRef = useRef(false);
  const committedStageNavigationsRef = useRef(0);

  useEffect(() => {
    if (rendererFailure?.route !== '/kelp') return;
    reportKelpRenderFailure(
      'renderer-init-failed',
      `webgpu: ${describeErrorForBeacon(
        rendererFailure.webGPUError,
      )} | webgl: ${describeErrorForBeacon(
        rendererFailure.webGLError,
      )}`,
      'unknown',
    );
  }, [rendererFailure]);

  useEffect(() => {
    markWorldStageMounted();
    return () => {
      navigationRef.current = null;
      markWorldStageUnmounted();
    };
  }, []);

  useEffect(() => {
    advanceWorldStageRoute(pathname);
  }, [pathname]);

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
    if (!stageReady || coldInitIssuedRef.current) return;
    const target = new URLSearchParams(window.location.search).get(
      'stageColdInit',
    );
    if (
      target !== '/game' &&
      target !== '/cove' &&
      target !== '/kelp'
    ) {
      return;
    }
    const navigationTarget: '/game' | '/cove' | '/kelp' =
      target;
    coldInitIssuedRef.current = true;
    const probeWindow = window as typeof window & {
      __WORLD_STAGE_COLD_INIT__?: {
        accepted: boolean;
        target: '/game' | '/cove' | '/kelp';
        midwayCount: number;
      };
    };
    const coldInit = {
      accepted: false,
      target: navigationTarget,
      midwayCount: 0,
    };
    probeWindow.__WORLD_STAGE_COLD_INIT__ = coldInit;
    coldInit.accepted = requestWorldStageNavigation({
      to: navigationTarget,
      onMidway: () => {
        coldInit.midwayCount += 1;
      },
    });
  }, [stageReady]);

  const commitStageNavigation = useCallback(
    (navigation: WorldStageNavigationRequest) => {
      navigation.onMidway?.();
      const method = decideStageNavigationHistoryMethod(
        committedStageNavigationsRef.current,
      );
      committedStageNavigationsRef.current += 1;
      if (method === 'push') {
        router.push(navigation.to);
      } else {
        router.replace(navigation.to);
      }
    },
    [router],
  );

  useEffect(() => {
    if (!stageReady) return;
    return installWorldStageNavigationHandler((navigation) => {
      const sceneId = sceneIdForPathname(navigation.to);
      if (!sceneId) return false;
      const state = useStageStore.getState();
      const ownership = decideStageNavigationOwnership({
        targetSceneId: sceneId,
        pendingRequest: state.pendingRequest,
        transitionPhase: state.transition?.phase ?? null,
      });

      if (ownership === 'EXECUTE_NOW') {
        commitStageNavigation(navigation);
        return true;
      }

      if (ownership === 'ADOPT' && state.pendingRequest) {
        navigationRef.current = {
          requestId: state.pendingRequest.requestId,
          navigation,
        };
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
  }, [commitStageNavigation, stageReady]);

  useEffect(() => {
    const parked = navigationRef.current;
    const rekeyed = rekeyParkedNavigationForRetry(
      parked,
      pendingRequestForLineage,
    );
    if (rekeyed !== parked && navigationRef.current === parked) {
      navigationRef.current = rekeyed;
    }
  }, [pendingRequestForLineage]);

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
      const taken = takeParkedNavigationForOpaque(
        pendingNavigation,
        request,
      );
      if (!taken.navigation || navigationRef.current !== pendingNavigation) {
        return;
      }
      navigationRef.current = taken.remaining;
      commitStageNavigation(taken.navigation);
    },
    [commitStageNavigation],
  );

  useEffect(() => {
    if (!stageReady) return;
    const probeWindow = window as typeof window & {
      __WORLD_STAGE_PROBE__?: {
        request: (sceneId: string) => void;
        navigate?: (
          to: '/game' | '/cove' | '/kelp',
        ) => boolean;
        ledger: () => Record<string, unknown>;
        recover: (reason: string) => boolean;
        sceneInventory: () => Record<string, unknown>;
        snapshot: () => Record<string, unknown>;
      };
    };
    probeWindow.__WORLD_STAGE_PROBE__ = {
      request: requestStageScene,
      navigate: (to) => {
        return requestWorldStageNavigation({ to });
      },
      ledger: readStageResourceLedger,
      recover: requestStageRendererRecovery,
      sceneInventory: readStageSceneInventory,
      snapshot: () => {
        const state = useStageStore.getState();
        return {
          pathname: window.location.pathname,
          historyLength: window.history.length,
          activeScene: state.activeScene,
          transitionPhase: state.transition?.phase ?? 'idle',
          transitionError: state.transition?.error ?? null,
          canvasMountCount: state.canvasMountCount,
          listenerCount: state.windowListenerCount,
          listenerUnderflowCount: state.listenerUnderflowCount,
          recoveryCount: state.recovery.count,
          lastRecoveryReason: state.recovery.lastReason,
          backend: readStageBackend(),
          renderer: readStageRendererCounters(),
          coldInit:
            (
              window as typeof window & {
                __WORLD_STAGE_COLD_INIT__?: Record<string, unknown>;
              }
            ).__WORLD_STAGE_COLD_INIT__ ?? null,
          frames: readStageFrameInvocations(),
          cameras: readStageCameraPoses(),
          slots: state.scenes,
          kelp:
            (
              window as typeof window & {
                __KELP_STAGE_PROBE__?: {
                  snapshot?: () => Record<string, unknown>;
                };
              }
            ).__KELP_STAGE_PROBE__?.snapshot?.() ?? null,
          transitionErrors: [...state.transitionErrors],
        };
      },
    };
    return () => {
      delete probeWindow.__WORLD_STAGE_PROBE__;
    };
  }, [router, stageReady]);

  const handleKelpRuntimeCrash = useCallback(
    (error: unknown, componentStack: string | null) => {
      console.error(
        '[KelpRealm] stage slot runtime crash:',
        error,
        componentStack ?? '',
      );
      setKelpRuntimeCrashKey(kelpResetKey);
    },
    [kelpResetKey],
  );

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
      {
        sceneId: KELP_SCENE_ID,
        camera: {
          fov: 60,
          near: 1,
          far: 10_000,
          position: [0, 470, 1_460],
        },
        appearance: {
          background: 0x14586a,
          fog: {
            color: 0x14586a,
            near: 1_100,
            far: 3_200,
          },
          shadows: false,
        },
        capabilities: {
          jump: false,
          verticalSwim: false,
          sprint: false,
          emotes: false,
          interact: false,
          clickPath: false,
        },
        content: (
          <Suspense fallback={null}>
            <StageSlotErrorBoundary
              resetKey={kelpResetKey}
              onRuntimeError={handleKelpRuntimeCrash}
            >
              <LazyStageHostedKelpScene />
            </StageSlotErrorBoundary>
          </Suspense>
        ),
      },
    ],
    [handleKelpRuntimeCrash, kelpResetKey],
  );

  return (
    <div className="world-stage-root relative h-screen w-full overflow-hidden">
      {stageReady && (
        <div className="absolute inset-0 z-0">
          <StageCanvasErrorBoundary>
            <WorldStageCanvas
              scenes={scenes}
              transitionTimeoutMs={45_000}
              pauseOnCreate
              renderTransitionOverlay={false}
              onTransitionOpaque={handleTransitionOpaque}
            />
          </StageCanvasErrorBoundary>
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
      {rendererFailure && (
        <div
          role="alert"
          className="absolute inset-0 z-50 flex items-center justify-center bg-[#07131d] p-6"
        >
          <div className="max-w-xl text-center font-mono text-cyan-100">
            <p className="mb-5 text-base font-bold leading-relaxed">
              This browser couldn&apos;t start the 3D view. Try updating your
              browser or enabling hardware acceleration.
            </p>
            <button
              type="button"
              className="rounded-lg border border-cyan-300/70 bg-black/70 px-5 py-3 font-bold text-cyan-200"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      )}
      {kelpRuntimeCrashKey === kelpResetKey && (
        <div
          role="alert"
          className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(13,69,82,0.92)] p-6"
        >
          <div className="max-w-xl text-center font-mono text-[#c7fff4]">
            <p className="mb-5 text-base font-bold leading-relaxed">
              The kelp forest hit a runtime error. Retry the scene or reload
              the page.
            </p>
            <button
              type="button"
              className="rounded-lg border border-[#70ffe2]/70 bg-black/70 px-5 py-3 font-bold text-[#70ffe2]"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
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
