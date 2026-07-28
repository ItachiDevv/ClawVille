import type {
  StageSceneStatus,
  StageTransitionPhase,
} from './stage-store';

export type WatchdogVerdict = 'none' | 'silent-retry' | 'fail-card';
export type WatchdogFailureReason =
  | 'chain-max'
  | 'attempt-max'
  | 'hard-stall'
  | 'soft-stall';

export interface WatchdogConfig {
  tickMs: number;
  softTimeoutMs: number;
  stallWindowMs: number;
  hardCeilingMs: number;
  attemptMaxMs: number;
  chainMaxMs: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  tickMs: 5_000,
  softTimeoutMs: 45_000,
  stallWindowMs: 30_000,
  hardCeilingMs: 90_000,
  attemptMaxMs: 150_000,
  chainMaxMs: 240_000,
};

export interface WatchdogSample {
  stageEpoch: number;
  requestId: number | null;
  retryOfRequestId?: number;
  sceneKind: 'world' | 'cove';
  transitionPhase: StageTransitionPhase;
  terminal: boolean;
  readiness: {
    slotReady: boolean;
    cameraInstalled: boolean;
    firstControlledFrame: boolean;
  };
  slotStatus: StageSceneStatus | undefined;
  recoveryCount: number;
  loadProgress: number | null;
  uploadTotal: number;
  uploadDone: number;
  canvasReady: boolean;
  texturesReady: boolean;
  hidden: boolean;
  visibleDeltaMs: number;
}

export interface WatchdogState {
  stageEpoch: number;
  chainRootRequestId: number;
  currentRequestId: number;
  chainElapsedMs: number;
  attemptElapsedMs: number;
  lastAnyActivityMs: number;
  lastGenuineActivityMs: number;
  uploadDoneHighWater: number;
  canvasSeen: boolean;
  texturesSeen: boolean;
  attemptIndex: number;
  terminalVerdict: WatchdogVerdict;
  failureReason: WatchdogFailureReason | null;
  lastLoadProgress: number | null;
  lastSlotStatus: StageSceneStatus | undefined;
  lastRecoveryCount: number;
}

export interface WatchdogDecision {
  state: WatchdogState | null;
  verdict: WatchdogVerdict;
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function initialState(sample: WatchdogSample): WatchdogState {
  if (sample.requestId === null) {
    throw new Error('Cannot initialize a watchdog without a request');
  }
  return {
    stageEpoch: sample.stageEpoch,
    chainRootRequestId: sample.requestId,
    currentRequestId: sample.requestId,
    chainElapsedMs: 0,
    attemptElapsedMs: 0,
    lastAnyActivityMs: 0,
    lastGenuineActivityMs: 0,
    uploadDoneHighWater:
      sample.uploadTotal > 0 && Number.isFinite(sample.uploadDone)
        ? Math.max(0, sample.uploadDone)
        : 0,
    canvasSeen: sample.canvasReady,
    texturesSeen: sample.texturesReady,
    attemptIndex: 0,
    terminalVerdict: 'none',
    failureReason: null,
    lastLoadProgress: finiteOrNull(sample.loadProgress),
    lastSlotStatus: sample.slotStatus,
    lastRecoveryCount: sample.recoveryCount,
  };
}

function continueChain(
  state: WatchdogState,
  sample: WatchdogSample,
): WatchdogState {
  if (sample.requestId === null) {
    throw new Error('Cannot continue a watchdog without a request');
  }
  return {
    ...state,
    currentRequestId: sample.requestId,
    attemptElapsedMs: 0,
    lastAnyActivityMs: 0,
    lastGenuineActivityMs: 0,
    uploadDoneHighWater:
      sample.uploadTotal > 0 && Number.isFinite(sample.uploadDone)
        ? Math.max(0, sample.uploadDone)
        : 0,
    canvasSeen: sample.canvasReady,
    texturesSeen: sample.texturesReady,
    attemptIndex: state.attemptIndex + 1,
    terminalVerdict: 'none',
    failureReason: null,
    lastLoadProgress: finiteOrNull(sample.loadProgress),
    lastSlotStatus: sample.slotStatus,
    lastRecoveryCount: sample.recoveryCount,
  };
}

function requestFailure(
  state: WatchdogState,
  reason: WatchdogFailureReason,
  config: WatchdogConfig,
): WatchdogDecision {
  const verdict: WatchdogVerdict =
    state.attemptIndex === 0 && state.chainElapsedMs < config.chainMaxMs
      ? 'silent-retry'
      : 'fail-card';
  return {
    state: {
      ...state,
      terminalVerdict: verdict,
      failureReason: reason,
    },
    verdict,
  };
}

export function reduceWatchdog(
  state: WatchdogState | null,
  sample: WatchdogSample,
  config: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG,
): WatchdogDecision {
  if (sample.transitionPhase === 'idle' || sample.requestId === null) {
    return { state: null, verdict: 'none' };
  }

  let next: WatchdogState;
  if (
    !state ||
    state.stageEpoch !== sample.stageEpoch
  ) {
    next = initialState(sample);
  } else if (state.currentRequestId === sample.requestId) {
    next = { ...state };
  } else if (sample.retryOfRequestId === state.currentRequestId) {
    next = continueChain(state, sample);
  } else {
    next = initialState(sample);
  }

  if (next.terminalVerdict !== 'none') {
    return { state: next, verdict: 'none' };
  }

  const readinessSatisfied =
    sample.readiness.slotReady &&
    sample.readiness.cameraInstalled &&
    sample.readiness.firstControlledFrame;
  if (
    sample.terminal ||
    sample.transitionPhase === 'error' ||
    sample.transitionPhase === 'fadingIn' ||
    readinessSatisfied
  ) {
    return {
      state:
        sample.terminal || sample.transitionPhase === 'error'
          ? {
              ...next,
              terminalVerdict: 'fail-card',
            }
          : next,
      verdict: 'none',
    };
  }

  if (sample.hidden) {
    return { state: next, verdict: 'none' };
  }

  const delta = Math.max(
    0,
    Math.min(sample.visibleDeltaMs, config.tickMs * 2),
  );
  next.chainElapsedMs += delta;
  next.attemptElapsedMs += delta;

  let genuineActivity = false;
  let anyActivity = false;
  if (sample.sceneKind === 'world') {
    if (
      sample.uploadTotal > 0 &&
      Number.isFinite(sample.uploadDone) &&
      sample.uploadDone > next.uploadDoneHighWater
    ) {
      next.uploadDoneHighWater = sample.uploadDone;
      genuineActivity = true;
    }
    if (!next.canvasSeen && sample.canvasReady) {
      next.canvasSeen = true;
      genuineActivity = true;
    }
    if (!next.texturesSeen && sample.texturesReady) {
      next.texturesSeen = true;
      genuineActivity = true;
    }
  }

  const loadProgress = finiteOrNull(sample.loadProgress);
  if (
    !Object.is(loadProgress, next.lastLoadProgress) ||
    sample.slotStatus !== next.lastSlotStatus ||
    sample.recoveryCount !== next.lastRecoveryCount
  ) {
    anyActivity = true;
  }
  next.lastLoadProgress = loadProgress;
  next.lastSlotStatus = sample.slotStatus;
  next.lastRecoveryCount = sample.recoveryCount;
  if (genuineActivity) {
    anyActivity = true;
    next.lastGenuineActivityMs = next.attemptElapsedMs;
  }
  if (anyActivity) {
    next.lastAnyActivityMs = next.attemptElapsedMs;
  }

  if (next.chainElapsedMs >= config.chainMaxMs) {
    return {
      state: {
        ...next,
        terminalVerdict: 'fail-card',
        failureReason: 'chain-max',
      },
      verdict: 'fail-card',
    };
  }

  const attemptStartedAt =
    next.chainElapsedMs - next.attemptElapsedMs;
  const effectiveAttemptBudget = Math.min(
    config.attemptMaxMs,
    config.chainMaxMs - attemptStartedAt,
  );
  if (next.attemptElapsedMs >= effectiveAttemptBudget) {
    return requestFailure(next, 'attempt-max', config);
  }

  const hardStalled =
    next.attemptElapsedMs - next.lastGenuineActivityMs >=
    config.stallWindowMs;
  if (
    next.attemptElapsedMs >= config.hardCeilingMs &&
    hardStalled
  ) {
    return requestFailure(next, 'hard-stall', config);
  }

  const softStalled =
    next.attemptElapsedMs - next.lastAnyActivityMs >=
    config.stallWindowMs;
  if (
    next.attemptElapsedMs >= config.softTimeoutMs &&
    softStalled
  ) {
    return requestFailure(next, 'soft-stall', config);
  }

  return { state: next, verdict: 'none' };
}
