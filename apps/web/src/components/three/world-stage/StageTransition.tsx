'use client';

import { useEffect } from 'react';
import { useStageStore, type StageRequest } from './stage-store';

interface StageTransitionProps {
  fadeDurationMs?: number;
  timeoutMs?: number;
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
  timeoutMs = 20_000,
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

  useEffect(() => {
    if (!pendingRequest) return;
    const request = pendingRequest;

    const activateTimer = window.setTimeout(() => {
      const state = useStageStore.getState();
      if (state.pendingRequest?.requestId !== request.requestId) return;
      state.activateScene(request);
      state.setTransitionPhase(request.requestId, 'awaiting');
    }, fadeDurationMs);

    const timeoutTimer = window.setTimeout(() => {
      const state = useStageStore.getState();
      if (state.pendingRequest?.requestId !== request.requestId) return;
      state.failTransition(
        request,
        `Scene "${request.sceneId}" did not become ready within ${Math.round(timeoutMs / 1000)} seconds. Choose a scene to retry.`,
      );
    }, timeoutMs);

    return () => {
      window.clearTimeout(activateTimer);
      window.clearTimeout(timeoutTimer);
    };
  }, [fadeDurationMs, pendingRequest, timeoutMs]);

  useEffect(() => {
    if (
      !pendingRequest ||
      transition?.phase !== 'awaiting' ||
      transition.requestId !== pendingRequest.requestId ||
      requestedStatus !== 'ready' ||
      !matchesRequest(cameraInstalled, pendingRequest) ||
      !matchesRequest(firstControlledFrame, pendingRequest)
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
      className="absolute inset-0 z-20 flex items-center justify-center bg-[#02070d] px-6 text-center"
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
        </div>
      ) : phase !== 'idle' && phase !== 'fadingIn' ? (
        <div className="text-sm font-medium tracking-[0.24em] text-cyan-100/80">
          {phase === 'awaiting' ? 'WARMING SCENE' : 'SWITCHING SCENE'}
        </div>
      ) : null}
    </div>
  );
}
