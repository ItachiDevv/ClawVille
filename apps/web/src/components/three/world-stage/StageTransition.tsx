'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  retryStageScene,
  useStageStore,
  type StageRequest,
} from './stage-store';
import { ACTIVITY_SCENE_ID } from './stage-scene-id';
import {
  DEFAULT_WATCHDOG_CONFIG,
  reduceWatchdog,
  type WatchdogConfig,
  type WatchdogSample,
  type WatchdogState,
} from './stage-watchdog-machine';

const STAGE_SCENE_KIND_BY_ID = {
  world: 'world',
  cove: 'cove',
  kelp: 'kelp',
  activity: 'activity',
} as const;

interface StageTransitionProps {
  fadeDurationMs?: number;
  timeoutMs?: number;
  watchdogConfig?: WatchdogConfig;
  onOpaque?: (request: StageRequest) => void;
}

function matchesRequest(
  ack: { sceneId: string; generation: number } | null,
  request: StageRequest,
): boolean {
  return (
    ack?.sceneId === request.sceneId &&
    ack.generation === request.generation
  );
}

export function StageTransition({
  fadeDurationMs = 250,
  timeoutMs = DEFAULT_WATCHDOG_CONFIG.softTimeoutMs,
  watchdogConfig,
  onOpaque,
}: StageTransitionProps) {
  const pendingRequest = useStageStore((state) => state.pendingRequest);
  const transition = useStageStore((state) => state.transition);
  const requestedStatus = useStageStore((state) => {
    const request = state.pendingRequest;
    return request ? state.scenes[request.sceneId]?.status : undefined;
  });
  const cameraInstalled = useStageStore(
    (state) => state.cameraInstalled,
  );
  const firstControlledFrame = useStageStore(
    (state) => state.firstControlledFrame,
  );
  const stageEpoch = useStageStore((state) => state.stageEpoch);
  const outgoingOverlay = useStageStore((state) => state.outgoingOverlay);
  const machineRef = useRef<WatchdogState | null>(null);
  const resolvedWatchdogConfig = useMemo<WatchdogConfig>(
    () =>
      watchdogConfig ?? {
        ...DEFAULT_WATCHDOG_CONFIG,
        softTimeoutMs: timeoutMs,
      },
    [timeoutMs, watchdogConfig],
  );

  useEffect(() => {
    if (!pendingRequest) return;
    const request = pendingRequest;
    const requestEpoch = stageEpoch;

    const activateTimer = window.setTimeout(() => {
      const state = useStageStore.getState();
      if (
        state.stageEpoch !== requestEpoch ||
        state.pendingRequest?.requestId !== request.requestId
      ) {
        return;
      }
      onOpaque?.(request);
      state.activateScene(request);
      state.setTransitionPhase(request.requestId, 'awaiting');
    }, fadeDurationMs);

    let lastTickAt = Date.now();
    const watchdog = window.setInterval(() => {
      const state = useStageStore.getState();
      const now = Date.now();
      const delta = Math.min(
        now - lastTickAt,
        resolvedWatchdogConfig.tickMs * 2,
      );
      lastTickAt = now;
      const current = state.pendingRequest;
      const bridge = window as typeof window & {
        __W3D_PROGRESS?: number;
        __W3D_TEXTURE_UPLOAD_TOTAL?: number;
        __W3D_TEXTURE_UPLOAD_DONE?: number;
        __W3D_CANVAS_READY?: boolean;
        __W3D_TEXTURES_READY?: boolean;
      };
      const slot = current ? state.scenes[current.sceneId] : undefined;
      const sample: WatchdogSample = {
        stageEpoch: state.stageEpoch,
        requestId: current?.requestId ?? null,
        retryOfRequestId: current?.retryOfRequestId,
        sceneKind:
          current?.sceneId &&
          current.sceneId in STAGE_SCENE_KIND_BY_ID
            ? STAGE_SCENE_KIND_BY_ID[
                current.sceneId as keyof typeof STAGE_SCENE_KIND_BY_ID
              ]
            : 'world',
        transitionPhase: state.transition?.phase ?? 'idle',
        terminal:
          state.transition?.phase === 'error' ||
          slot?.status === 'error',
        readiness: {
          slotReady:
            slot?.status === 'ready' &&
            slot.generation === current?.generation,
          cameraInstalled: current
            ? matchesRequest(state.cameraInstalled, current)
            : false,
          firstControlledFrame:
            current?.sceneId === ACTIVITY_SCENE_ID ||
            (current
              ? matchesRequest(state.firstControlledFrame, current)
              : false),
        },
        slotStatus: slot?.status,
        recoveryCount: state.recovery.count,
        loadProgress:
          typeof bridge.__W3D_PROGRESS === 'number'
            ? bridge.__W3D_PROGRESS
            : null,
        uploadTotal:
          typeof bridge.__W3D_TEXTURE_UPLOAD_TOTAL === 'number'
            ? bridge.__W3D_TEXTURE_UPLOAD_TOTAL
            : 0,
        uploadDone:
          typeof bridge.__W3D_TEXTURE_UPLOAD_DONE === 'number'
            ? bridge.__W3D_TEXTURE_UPLOAD_DONE
            : 0,
        canvasReady: bridge.__W3D_CANVAS_READY === true,
        texturesReady: bridge.__W3D_TEXTURES_READY === true,
        hidden: document.hidden,
        visibleDeltaMs: delta,
      };
      const decision = reduceWatchdog(
        machineRef.current,
        sample,
        resolvedWatchdogConfig,
      );
      machineRef.current = decision.state;
      if (decision.verdict === 'none' || !current) return;

      window.clearInterval(watchdog);
      if (decision.verdict === 'silent-retry') {
        retryStageScene(current);
        return;
      }
      state.failTransition(
        current,
        `Scene "${current.sceneId}" did not become ready within ${Math.round((decision.state?.attemptElapsedMs ?? 0) / 1000)} seconds. Choose a scene to retry.`,
      );
    }, resolvedWatchdogConfig.tickMs);

    return () => {
      window.clearTimeout(activateTimer);
      window.clearInterval(watchdog);
    };
  }, [
    fadeDurationMs,
    onOpaque,
    pendingRequest,
    resolvedWatchdogConfig,
    stageEpoch,
  ]);

  useEffect(() => {
    if (
      !pendingRequest ||
      transition?.phase === 'idle' ||
      machineRef.current?.stageEpoch !== stageEpoch
    ) {
      machineRef.current = null;
    }
  }, [pendingRequest, stageEpoch, transition?.phase]);

  useEffect(
    () => () => {
      machineRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (
      !pendingRequest ||
      transition?.phase !== 'awaiting' ||
      transition.requestId !== pendingRequest.requestId ||
      requestedStatus !== 'ready' ||
      !matchesRequest(cameraInstalled, pendingRequest) ||
      (pendingRequest.sceneId !== ACTIVITY_SCENE_ID &&
        !matchesRequest(firstControlledFrame, pendingRequest)) ||
      outgoingOverlay?.requestId === pendingRequest.requestId
    ) {
      return;
    }

    useStageStore
      .getState()
      .setTransitionPhase(pendingRequest.requestId, 'fadingIn');
  }, [
    cameraInstalled,
    firstControlledFrame,
    pendingRequest,
    outgoingOverlay,
    requestedStatus,
    transition,
  ]);

  useEffect(() => {
    if (
      !pendingRequest ||
      transition?.phase !== 'fadingIn' ||
      transition.requestId !== pendingRequest.requestId
    ) {
      return;
    }
    const request = pendingRequest;
    const completionTimer = window.setTimeout(() => {
      useStageStore.getState().completeTransition(request);
    }, fadeDurationMs);
    return () => window.clearTimeout(completionTimer);
  }, [fadeDurationMs, pendingRequest, transition]);

  const phase = transition?.phase ?? 'idle';
  const opaque =
    phase === 'fadingOut' ||
    phase === 'awaiting' ||
    phase === 'error';

  return (
    <div
      aria-live="polite"
      data-stage-transition={phase}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#02070d] px-6 text-center"
      style={{
        opacity: opaque ? 1 : 0,
        pointerEvents: phase === 'idle' ? 'none' : 'auto',
        transition: `opacity ${fadeDurationMs}ms ease`,
      }}
    >
      {phase === 'error' ? (
        <div className="max-w-lg rounded-xl border border-red-400/50 bg-red-950/70 p-5 text-sm text-red-100 shadow-2xl">
          <p className="font-semibold">World stage transition failed</p>
          <p className="mt-2 text-red-100/80">
            {transition?.error ?? 'The requested scene could not be shown.'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg border border-red-200/50 bg-red-100/10 px-4 py-2 font-semibold text-red-50 transition hover:bg-red-100/20"
          >
            Reload
          </button>
        </div>
      ) : phase !== 'idle' && phase !== 'fadingIn' ? (
        <div className="text-sm font-medium tracking-[0.24em] text-cyan-100/80">
          RIDING THE CURRENT…
        </div>
      ) : null}
    </div>
  );
}
