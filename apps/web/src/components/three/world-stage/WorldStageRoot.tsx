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
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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
  type WorldStageHref,
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
import {
  ACTIVITY_SCENE_ID,
  COVE_SCENE_ID,
  KELP_SCENE_ID,
  NAV_NONCE_PARAM,
  WORLD_SCENE_ID,
  canonicalStageUrl,
  parseNavNonce,
  roomKeyFromPathname,
  sceneIdForPathname,
  stageDestinationKey,
  stagePathnameFromHref,
} from './stage-scene-id';
import {
  acceptNavigationIntent,
  classifyNavLanding,
  getNavigationIntent,
  nextNavNonce,
  pushIssue,
  readStageNavigationLineage,
  retireStaleIssues,
  settleIssue,
} from './stage-navigation-lineage-store';

const OUTGOING_OVERLAY_COMMIT_TIMEOUT_MS = 10_000;
interface StageCommitOptions {
  readonly history?: 'auto' | 'push' | 'replace';
  readonly countTowardStageHistory?: boolean;
}
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
const LazyStageHostedActivityScene = lazy(
  () => import('./StageHostedActivityScene'),
);
const LazyStageActivityRouteHost = lazy(
  () => import('./StageActivityRouteHost'),
);

export function WorldStageRoot({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [stageReady, setStageReady] = useState(false);
  const [coveSceneEmpty, setCoveSceneEmpty] = useState(false);
  const [kelpRuntimeCrashKey, setKelpRuntimeCrashKey] =
    useState<string | null>(null);
  const [activityRuntimeCrashKey, setActivityRuntimeCrashKey] =
    useState<string | null>(null);
  const [displayedChildren, setDisplayedChildren] =
    useState<ReactNode>(children);
  const [displayedPathname, setDisplayedPathname] = useState(pathname);
  const displayedPathRef = useRef(pathname);
  const openedMidpointRef = useRef<{
    requestId: number;
    destinationKey: string;
  } | null>(null);
  const pendingDestinationKeyRef = useRef<string | null>(null);
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
  const activityGeneration = useStageStore(
    (state) => state.scenes[ACTIVITY_SCENE_ID]?.generation ?? 0,
  );
  const recoveryCount = useStageStore(
    (state) => state.recovery.count,
  );
  const outgoingOverlay = useStageStore(
    (state) => state.outgoingOverlay,
  );
  const rendererFailure = useSyncExternalStore(
    subscribeStageRendererFailure,
    getStageRendererFailure,
    getStageRendererFailureServerSnapshot,
  );
  const kelpResetKey = `${kelpGeneration}:${recoveryCount}`;
  const activityResetKey = `${activityGeneration}:${recoveryCount}`;
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
      openedMidpointRef.current = null;
      pendingDestinationKeyRef.current = null;
      pendingRouteChildrenRef.current = null;
      const overlay = useStageStore.getState().outgoingOverlay;
      if (overlay) {
        useStageStore.getState().clearOutgoingOverlay(overlay.requestId);
      }
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

  const commitStageNavigation = useCallback(
    (
      navigation: WorldStageNavigationRequest,
      options: StageCommitOptions = {},
    ) => {
      acceptNavigationIntent(navigation.to);
      const { id } = nextNavNonce();
      const target = new URL(navigation.to, window.location.origin);
      target.searchParams.set(NAV_NONCE_PARAM, id);
      const issuedHref = `${target.pathname}${target.search}${target.hash}`;
      retireStaleIssues();
      pushIssue({
        id,
        destinationKey: stageDestinationKey(target.pathname) ?? '',
        href: canonicalStageUrl(navigation.to),
        issuedAt: Date.now(),
        status: 'in-flight',
      });

      navigation.onMidway?.();
      const method =
        options.history === undefined || options.history === 'auto'
          ? decideStageNavigationHistoryMethod(
              committedStageNavigationsRef.current,
            )
          : options.history;
      if (options.countTowardStageHistory !== false) {
        committedStageNavigationsRef.current += 1;
      }
      if (method === 'push') {
        router.push(issuedHref);
      } else {
        router.replace(issuedHref);
      }
    },
    [router],
  );

  const repairUrlToCurrentIntent = useCallback((): boolean => {
    const intent = getNavigationIntent();
    if (!intent) return false;
    if (
      canonicalStageUrl(intent.href) ===
      canonicalStageUrl(window.location.href)
    ) {
      return false;
    }
    commitStageNavigation(
      { to: intent.href as WorldStageHref },
      { history: 'replace', countTowardStageHistory: false },
    );
    return true;
  }, [commitStageNavigation]);

  useEffect(() => {
    if (!stageReady) return;
    retireStaleIssues();
    const landing = classifyNavLanding(
      parseNavNonce(window.location.search),
    );
    if (landing.kind === 'issued-stale') {
      repairUrlToCurrentIntent();
      return;
    }
    if (landing.kind === 'issued-live') {
      settleIssue(landing.issue.id);
    }

    const sceneId = sceneIdForPathname(pathname);
    if (!sceneId) return;
    const destinationKey = stageDestinationKey(pathname);
    if (!destinationKey) return;
    const state = useStageStore.getState();
    const pathAlreadyDisplayed = displayedPathRef.current === pathname;
    const midpoint = openedMidpointRef.current;
    const phase = state.transition?.phase;
    const installNow =
      pathAlreadyDisplayed ||
      (midpoint !== null &&
        midpoint.destinationKey === destinationKey &&
        ((state.pendingRequest?.requestId === midpoint.requestId &&
          (phase === 'awaiting' || phase === 'fadingIn')) ||
          (state.pendingRequest === null &&
            state.activeScene === sceneId)));

    if (installNow) {
      displayedPathRef.current = pathname;
      pendingRouteChildrenRef.current = null;
      setDisplayedChildren(children);
      setDisplayedPathname(pathname);
    } else {
      pendingRouteChildrenRef.current = {
        pathname,
        children,
      };
    }

    const pendingMatchesDestination =
      state.pendingRequest !== null &&
      state.pendingRequest.sceneId === sceneId &&
      pendingDestinationKeyRef.current === destinationKey;
    const restingOnDestination =
      state.pendingRequest === null &&
      state.activeScene === sceneId &&
      pathAlreadyDisplayed;

    if (!pendingMatchesDestination && !restingOnDestination) {
      if (sceneId === ACTIVITY_SCENE_ID) {
        const roomKey = roomKeyFromPathname(pathname);
        if (roomKey) state.setActivityTarget({ roomKey });
      } else {
        state.clearActivityTarget();
      }
      acceptNavigationIntent(
        `${pathname}${window.location.search}${window.location.hash}`,
      );
      pendingDestinationKeyRef.current = destinationKey;
      openedMidpointRef.current = null;
      navigationRef.current = null;
      requestStageScene(sceneId);
    }
  }, [
    children,
    pathname,
    repairUrlToCurrentIntent,
    searchParams,
    stageReady,
  ]);

  useEffect(() => {
    const state = useStageStore.getState();
    const overlay = state.outgoingOverlay;
    if (overlay && overlay.pathname !== displayedPathname) {
      state.clearOutgoingOverlay(overlay.requestId);
    }
  }, [displayedPathname]);

  useEffect(() => {
    if (!stageReady || coldInitIssuedRef.current) return;
    const target = new URLSearchParams(window.location.search).get(
      'stageColdInit',
    );
    if (
      !target ||
      sceneIdForPathname(stagePathnameFromHref(target)) === null
    ) {
      return;
    }
    const navigationTarget = target as WorldStageHref;
    coldInitIssuedRef.current = true;
    const probeWindow = window as typeof window & {
      __WORLD_STAGE_COLD_INIT__?: {
        accepted: boolean;
        target: WorldStageHref;
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

  useEffect(() => {
    if (!stageReady) return;
    return installWorldStageNavigationHandler((navigation) => {
      const targetPathname = stagePathnameFromHref(navigation.to);
      const sceneId = sceneIdForPathname(targetPathname);
      const targetDestinationKey = stageDestinationKey(targetPathname);
      if (!sceneId || !targetDestinationKey) return false;
      const state = useStageStore.getState();
      if (sceneId === ACTIVITY_SCENE_ID) {
        const roomKey = roomKeyFromPathname(targetPathname);
        if (!roomKey) return false;
        state.setActivityTarget({ roomKey });
      }
      const ownership = decideStageNavigationOwnership({
        targetSceneId: sceneId,
        targetDestinationKey,
        pendingDestinationKey: pendingDestinationKeyRef.current,
        pendingRequest: state.pendingRequest,
        transitionPhase: state.transition?.phase ?? null,
      });

      if (ownership === 'EXECUTE_NOW') {
        acceptNavigationIntent(navigation.to);
        commitStageNavigation(navigation);
        return true;
      }

      if (ownership === 'ADOPT' && state.pendingRequest) {
        acceptNavigationIntent(navigation.to);
        navigationRef.current = {
          requestId: state.pendingRequest.requestId,
          navigation,
        };
        return true;
      }

      acceptNavigationIntent(navigation.to);
      pendingDestinationKeyRef.current = targetDestinationKey;
      openedMidpointRef.current = null;
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

  useEffect(() => {
    if (!outgoingOverlay || outgoingOverlay.status !== 'holding') return;
    const requestId = outgoingOverlay.requestId;
    const timer = window.setTimeout(() => {
      const state = useStageStore.getState();
      state.markOutgoingOverlayTimedOut(requestId);
      console.warn('[world-stage] outgoing activity overlay commit timed out', {
        requestId,
        href: outgoingOverlay.href,
      });
    }, OUTGOING_OVERLAY_COMMIT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [outgoingOverlay]);

  const handleTransitionOpaque = useCallback(
    (request: StageRequest) => {
      openedMidpointRef.current = {
        requestId: request.requestId,
        destinationKey:
          pendingDestinationKeyRef.current ?? request.sceneId,
      };
      const pendingRoute = pendingRouteChildrenRef.current;
      if (
        pendingRoute &&
        sceneIdForPathname(pendingRoute.pathname) === request.sceneId &&
        stageDestinationKey(pendingRoute.pathname) ===
          pendingDestinationKeyRef.current
      ) {
        pendingRouteChildrenRef.current = null;
        displayedPathRef.current = pendingRoute.pathname;
        setDisplayedChildren(pendingRoute.children);
        setDisplayedPathname(pendingRoute.pathname);
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
      const outgoingPathname = displayedPathRef.current;
      const outgoingSceneId = sceneIdForPathname(outgoingPathname);
      if (
        outgoingSceneId === ACTIVITY_SCENE_ID &&
        request.sceneId !== outgoingSceneId
      ) {
        useStageStore.getState().setOutgoingOverlay({
          pathname: outgoingPathname,
          href: taken.navigation.to,
          requestId: request.requestId,
        });
      }
      commitStageNavigation(taken.navigation);
    },
    [commitStageNavigation],
  );

  useEffect(() => {
    if (!stageReady) return;
    if (process.env.NEXT_PUBLIC_ENABLE_STAGE_PROBE !== '1') return;
    const probeWindow = window as typeof window & {
      __WORLD_STAGE_PROBE__?: {
        request: (sceneId: string) => void;
        navigate?: (to: WorldStageHref) => boolean;
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
          committedStageNavigations:
            committedStageNavigationsRef.current,
          navigationLineage: readStageNavigationLineage(),
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

  const handleActivityRuntimeCrash = useCallback(
    (error: unknown, componentStack: string | null) => {
      console.error(
        '[activity] stage slot runtime crash:',
        error,
        componentStack ?? '',
      );
      const state = useStageStore.getState();
      const request = state.pendingRequest;
      if (request?.sceneId === ACTIVITY_SCENE_ID) {
        state.ackReady(ACTIVITY_SCENE_ID, request.generation);
      }
      setActivityRuntimeCrashKey(activityResetKey);
    },
    [activityResetKey],
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
      {
        sceneId: ACTIVITY_SCENE_ID,
        overlayOpaque: true,
        camera: {
          fov: 60,
          near: 1,
          far: 34_000,
          position: [0, 260, -360],
        },
        appearance: {
          background: 0x0c1a2e,
          fog: undefined,
          shadows: false,
        },
        capabilities: {
          move: false,
          sprint: false,
          jump: false,
          verticalSwim: false,
          emotes: false,
          interact: false,
          clickPath: false,
          cameraOrbitKeys: false,
        },
        content: (
          <Suspense fallback={null}>
            <StageSlotErrorBoundary
              resetKey={activityResetKey}
              onRuntimeError={handleActivityRuntimeCrash}
            >
              <LazyStageHostedActivityScene />
            </StageSlotErrorBoundary>
          </Suspense>
        ),
      },
    ],
    [
      activityResetKey,
      handleActivityRuntimeCrash,
      handleKelpRuntimeCrash,
      kelpResetKey,
    ],
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
        {stageReady &&
        sceneIdForPathname(displayedPathname) === ACTIVITY_SCENE_ID ? (
          <Suspense fallback={null}>
            <LazyStageActivityRouteHost pathname={displayedPathname} />
          </Suspense>
        ) : stageReady ? (
          displayedChildren
        ) : null}
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
      {activityRuntimeCrashKey === activityResetKey && (
        <div
          role="alert"
          className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(6,16,32,0.94)] p-6"
        >
          <div className="max-w-xl text-center font-mono text-cyan-100">
            <p className="mb-5 text-base font-bold leading-relaxed">
              The activity stage hit a runtime error. Reload the page to retry.
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
      <StageTransition
        timeoutMs={45_000}
        onOpaque={handleTransitionOpaque}
      />
    </div>
  );
}
