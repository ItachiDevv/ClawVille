'use client';

import { useEffect, useRef } from 'react';
import {
  requestStageScene,
  useStageStore,
  type StageRequest,
} from './stage-store';

/** Watchdog cadence for the readiness deadline check. */
const WATCHDOG_TICK_MS = 5_000;
/**
 * Soft stall window: after the base deadline, a retry/failure additionally
 * requires this much time with ZERO observed activity. Activity can only
 * accelerate nothing — it never extends past the absolute ceiling below.
 * Field incident 2026-07-28: mobile users hit the blind 45 s card
 * mid-download returning to /game.
 */
const STALL_WINDOW_MS = 30_000;
/**
 * Absolute per-attempt ceiling in VISIBLE time. `__W3D_PROGRESS` only moves
 * when a whole file finishes (DefaultLoadingManager.onProgress fires from
 * itemEnd — Codex review finding 1), so one large GLB can look stalled for
 * its entire transfer; conversely unrelated manager noise must never
 * postpone the card forever (finding 2). Each attempt therefore gets a hard
 * ceiling regardless of activity: attempt 1 → silent retry, attempt 2 →
 * error card. Worst case to the card ≈ 2 × this (plus hidden time, which
 * pauses the clock).
 */
const ATTEMPT_CEILING_MS = 90_000;

/** Read the module-global loading progress (0..1) written by the
 *  DefaultLoadingManager wiring in asset-preload-manifest.ts. Read-only —
 *  absent (no loads started) reads as null. */
function readLoadProgress(): number | null {
  const value = (
    window as typeof window & { __W3D_PROGRESS?: number }
  ).__W3D_PROGRESS;
  return typeof value === 'number' ? value : null;
}

interface StageTransitionProps {
  fadeDurationMs?: number;
  timeoutMs?: number;
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
  timeoutMs = 20_000,
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

  // One silent auto-retry per scene before any error card. Cleared on every
  // successful completion. Covers the wedged-ack / mobile context-recovery
  // classes without the user ever seeing red.
  const autoRetriedScenesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!pendingRequest) return;
    const request = pendingRequest;

    const activateTimer = window.setTimeout(() => {
      const state = useStageStore.getState();
      if (state.pendingRequest?.requestId !== request.requestId) return;
      onOpaque?.(request);
      state.activateScene(request);
      state.setTransitionPhase(request.requestId, 'awaiting');
    }, fadeDurationMs);

    // Progress-aware readiness watchdog (replaces the former blind fixed
    // timer). Two triggers per attempt, measured in VISIBLE time only
    // (mobile background throttling must not burn the budget — Codex
    // review finding 4):
    //   soft: elapsed ≥ timeoutMs AND no activity for STALL_WINDOW_MS;
    //   hard: elapsed ≥ ATTEMPT_CEILING_MS regardless of activity.
    // Attempt 1 → ONE silent re-request (fresh generation); attempt 2 →
    // the error card. Activity = global asset-progress movement, slot
    // lifecycle change, or a renderer recovery — it defers the soft
    // trigger only, never the hard ceiling (finding 2).
    let visibleElapsedMs = 0;
    let lastTickAt = Date.now();
    let lastActivityElapsed = 0;
    let lastProgress = readLoadProgress();
    let lastStatus: string | undefined;
    let lastRecoveryCount: number | undefined;

    const watchdog = window.setInterval(() => {
      const state = useStageStore.getState();
      const now = Date.now();
      // Clamp the per-tick delta: background throttling suspends the
      // interval entirely, so the first tick after returning would
      // otherwise charge the WHOLE hidden gap to the visible clock
      // (review-2 finding 1). A clamped tick contributes at most 2× the
      // cadence no matter how long the tab slept.
      const delta = Math.min(now - lastTickAt, WATCHDOG_TICK_MS * 2);
      lastTickAt = now;

      if (
        state.pendingRequest?.requestId !== request.requestId ||
        state.transition?.phase === 'error' ||
        state.transition?.phase === 'fadingIn'
      ) {
        return;
      }
      if (document.hidden) return; // clock paused while backgrounded

      // Full readiness tuple already satisfied → the fadingIn promotion
      // effect is about to run; never retry/fail a ready request just
      // because the ceiling tick won the race (review-2 finding 2).
      if (
        state.scenes[request.sceneId]?.status === 'ready' &&
        matchesRequest(state.cameraInstalled, request) &&
        matchesRequest(state.firstControlledFrame, request)
      ) {
        return;
      }

      visibleElapsedMs += delta;

      const progress = readLoadProgress();
      const status = state.scenes[request.sceneId]?.status;
      const recoveries = state.recovery.count;
      if (
        (progress !== null &&
          Number.isFinite(progress) &&
          progress !== lastProgress) ||
        status !== lastStatus ||
        recoveries !== lastRecoveryCount
      ) {
        lastProgress = progress;
        lastStatus = status;
        lastRecoveryCount = recoveries;
        lastActivityElapsed = visibleElapsedMs;
        if (visibleElapsedMs < ATTEMPT_CEILING_MS) return;
      }

      const softStalled =
        visibleElapsedMs >= timeoutMs &&
        visibleElapsedMs - lastActivityElapsed >= STALL_WINDOW_MS;
      const hardCeiling = visibleElapsedMs >= ATTEMPT_CEILING_MS;
      if (!softStalled && !hardCeiling) return;

      window.clearInterval(watchdog);

      if (!autoRetriedScenesRef.current.has(request.sceneId)) {
        // First exhausted attempt: silently re-request the scene — the
        // overlay stays on WARMING SCENE, no error surfaced. Partially
        // cached assets make the second attempt strictly faster.
        autoRetriedScenesRef.current.add(request.sceneId);
        requestStageScene(request.sceneId);
        return;
      }

      state.failTransition(
        request,
        `Scene "${request.sceneId}" did not become ready within ${Math.round(visibleElapsedMs / 1000)} seconds. Choose a scene to retry.`,
      );
    }, WATCHDOG_TICK_MS);

    return () => {
      window.clearTimeout(activateTimer);
      window.clearInterval(watchdog);
    };
  }, [fadeDurationMs, onOpaque, pendingRequest, timeoutMs]);

  // Successful completion clears the auto-retry latch so a later slow spell
  // gets its own fresh silent retry.
  const phaseForLatch = transition?.phase ?? 'idle';
  useEffect(() => {
    if (phaseForLatch === 'idle') {
      autoRetriedScenesRef.current.clear();
    }
  }, [phaseForLatch]);

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
          {phase === 'awaiting' ? 'WARMING SCENE' : 'SWITCHING SCENE'}
        </div>
      ) : null}
    </div>
  );
}
