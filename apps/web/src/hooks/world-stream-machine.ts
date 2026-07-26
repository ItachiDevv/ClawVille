export type WorldPresencePolicy = 'active' | 'remote';

export const WORLD_STREAM_TICK_MS = 200;
export const REMOTE_PRESENCE_INTERVAL_MS = 10_000;

const MAX_BOOTSTRAP_ATTEMPTS = 20;
const BOOTSTRAP_RETRY_BASE_MS = 3_000;
const BOOTSTRAP_RETRY_MAX_MS = 60_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_RETRY_BASE_MS = 20_000;
const RECOVERY_RETRY_MAX_MS = 60_000;

export interface WorldStreamMachineState {
  everActive: boolean;
  previousPolicy: WorldPresencePolicy;
  nextRemoteAt: number;
  bootstrapInFlight: boolean;
  bootstrapAttempts: number;
  bootstrapRetryAt: number;
  recoveryAttempts: number;
  nextRecoveryAt: number;
  uploadsSuspended: boolean;
  superseded: boolean;
}

export type WorldStreamMachineAction =
  | 'BOOTSTRAP'
  | 'RESET_ACTIVE_POSITION'
  | 'UPLOAD_ACTIVE'
  | 'UPLOAD_REMOTE'
  | 'RECOVER';

export type WorldStreamMachineInput =
  | {
      type: 'TICK';
      now: number;
      policy: WorldPresencePolicy;
      hasSession: boolean;
      canUpload: boolean;
      hasFrozenPosition: boolean;
      recoveryInFlight: boolean;
    }
  | { type: 'BOOTSTRAP_OK'; now: number }
  | { type: 'BOOTSTRAP_FAILED'; now: number }
  | { type: 'POSITION_409'; now: number }
  | { type: 'RECOVERY_OK'; now: number }
  | { type: 'RECOVERY_FAILED'; now: number }
  | { type: 'SUPERSEDED'; now: number };

export interface WorldStreamMachineDecision {
  actions: WorldStreamMachineAction[];
  nextState: WorldStreamMachineState;
}

export function createWorldStreamMachineState(): WorldStreamMachineState {
  return {
    everActive: false,
    previousPolicy: 'remote',
    nextRemoteAt: 0,
    bootstrapInFlight: false,
    bootstrapAttempts: 0,
    bootstrapRetryAt: 0,
    recoveryAttempts: 0,
    nextRecoveryAt: 0,
    uploadsSuspended: false,
    superseded: false,
  };
}

function exponentialDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  return Math.min(baseMs * Math.pow(2, Math.max(0, attempt - 1)), maxMs);
}

export function decide(
  state: WorldStreamMachineState,
  input: WorldStreamMachineInput,
): WorldStreamMachineDecision {
  if (state.superseded) {
    return { actions: [], nextState: state };
  }

  const nextState = { ...state };
  const actions: WorldStreamMachineAction[] = [];

  switch (input.type) {
    case 'TICK': {
      if (input.policy === 'active') {
        nextState.everActive = true;
        if (state.previousPolicy === 'remote') {
          actions.push('RESET_ACTIVE_POSITION');
        }
      }
      nextState.previousPolicy = input.policy;

      if (
        !input.hasSession &&
        nextState.everActive &&
        !state.bootstrapInFlight &&
        state.bootstrapAttempts < MAX_BOOTSTRAP_ATTEMPTS &&
        input.now >= state.bootstrapRetryAt
      ) {
        nextState.bootstrapInFlight = true;
        actions.push('BOOTSTRAP');
        return { actions, nextState };
      }

      if (!input.hasSession) {
        return { actions, nextState };
      }

      if (state.uploadsSuspended) {
        if (
          !input.recoveryInFlight &&
          state.recoveryAttempts < MAX_RECOVERY_ATTEMPTS &&
          input.now >= state.nextRecoveryAt
        ) {
          actions.push('RECOVER');
        }
        return { actions, nextState };
      }

      if (!input.canUpload) {
        return { actions, nextState };
      }

      if (input.policy === 'active') {
        actions.push('UPLOAD_ACTIVE');
      } else if (
        input.hasFrozenPosition &&
        input.now >= state.nextRemoteAt
      ) {
        nextState.nextRemoteAt = input.now + REMOTE_PRESENCE_INTERVAL_MS;
        actions.push('UPLOAD_REMOTE');
      }
      return { actions, nextState };
    }

    case 'BOOTSTRAP_OK':
      nextState.bootstrapInFlight = false;
      nextState.bootstrapAttempts = 0;
      nextState.bootstrapRetryAt = 0;
      return { actions, nextState };

    case 'BOOTSTRAP_FAILED': {
      const attempt = state.bootstrapAttempts + 1;
      nextState.bootstrapInFlight = false;
      nextState.bootstrapAttempts = attempt;
      nextState.bootstrapRetryAt =
        input.now +
        exponentialDelay(attempt, BOOTSTRAP_RETRY_BASE_MS, BOOTSTRAP_RETRY_MAX_MS);
      return { actions, nextState };
    }

    case 'POSITION_409':
      if (!state.uploadsSuspended) {
        nextState.uploadsSuspended = true;
        nextState.recoveryAttempts = 0;
        nextState.nextRecoveryAt = input.now;
      }
      return { actions, nextState };

    case 'RECOVERY_OK':
      nextState.uploadsSuspended = false;
      nextState.recoveryAttempts = 0;
      nextState.nextRecoveryAt = 0;
      return { actions, nextState };

    case 'RECOVERY_FAILED': {
      if (!state.uploadsSuspended) {
        return { actions, nextState };
      }
      const attempt = state.recoveryAttempts + 1;
      nextState.recoveryAttempts = attempt;
      nextState.nextRecoveryAt =
        input.now +
        exponentialDelay(attempt, RECOVERY_RETRY_BASE_MS, RECOVERY_RETRY_MAX_MS);
      return { actions, nextState };
    }

    case 'SUPERSEDED':
      nextState.bootstrapInFlight = false;
      nextState.uploadsSuspended = true;
      nextState.superseded = true;
      return { actions, nextState };
  }
}
