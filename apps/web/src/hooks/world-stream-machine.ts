export type WorldPresencePolicy = 'active' | 'remote';
export type ActivePresenceActivity = 'idle' | 'walking';
export type WorldPresenceTransport = 'ws' | 'http';
export type WorldSocketPhase = 'idle' | 'connecting' | 'open' | 'retiring';
export type WorldTransportLossReason = 'membership_lost';
export type WorldTransportStandDownReason =
  | 'socket_replaced'
  | 'bad_frame'
  | 'flood'
  | 'transport_disabled';

export const WORLD_STREAM_TICK_MS = 200;
export const ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS = 10_000;
export const REMOTE_PRESENCE_INTERVAL_MS = 10_000;
export const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
export const SOCKET_RETIRE_TIMEOUT_MS = 1_000;
export const SOCKET_REOPEN_BASE_MS = 1_000;
export const SOCKET_REOPEN_MAX_MS = 15_000;
export const FALLBACK_PROBE_INTERVAL_MS = 60_000;

const MAX_BOOTSTRAP_ATTEMPTS = 20;
const BOOTSTRAP_RETRY_BASE_MS = 3_000;
const BOOTSTRAP_RETRY_MAX_MS = 60_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_RETRY_BASE_MS = 20_000;
const RECOVERY_RETRY_MAX_MS = 60_000;
const MAX_BARE_SOCKET_REOPENS = 2;
const MAX_SOCKET_CONNECT_FAILURES = 3;

export interface WorldStreamMachineState {
  everActive: boolean;
  previousPolicy: WorldPresencePolicy;
  nextActiveIdleAt: number | null;
  lastSentActiveActivity: ActivePresenceActivity | null;
  nextRemoteAt: number;
  bootstrapInFlight: boolean;
  bootstrapAttempts: number;
  bootstrapRetryAt: number;
  recoveryAttempts: number;
  nextRecoveryAt: number;
  uploadsSuspended: boolean;
  superseded: boolean;
  wsAdvertised: boolean;
  httpFallbackTripped: boolean;
  transport: WorldPresenceTransport;
  transportEpoch: number;
  socketPhase: WorldSocketPhase;
  socketPhaseSince: number;
  socketGeneration: number;
  consumedSignalGeneration: number | null;
  socketConnectFailures: number;
  socketDropStreak: number;
  nextSocketOpenAt: number;
  pendingActiveResync: boolean;
}

export type WorldStreamMachineAction =
  | 'BOOTSTRAP'
  | 'RESET_ACTIVE_POSITION'
  | 'UPLOAD_ACTIVE'
  | 'UPLOAD_REMOTE'
  | 'RECOVER'
  | 'OPEN_SOCKET'
  | 'CLOSE_SOCKET';

export type WorldStreamMachineInput =
  | {
      type: 'TICK';
      now: number;
      policy: WorldPresencePolicy;
      hasSession: boolean;
      canUpload: boolean;
      hasFrozenPosition: boolean;
      recoveryInFlight: boolean;
      poseChanged: boolean;
      activeActivity: ActivePresenceActivity;
      documentHidden: boolean;
    }
  | { type: 'BOOTSTRAP_OK'; now: number; wsAdvertised: boolean }
  | { type: 'BOOTSTRAP_FAILED'; now: number }
  | { type: 'POSITION_409'; now: number }
  | { type: 'RECOVERY_OK'; now: number; wsAdvertised: boolean }
  | { type: 'RECOVERY_FAILED'; now: number }
  | { type: 'SUPERSEDED'; now: number }
  | { type: 'SOCKET_OPENED'; now: number; generation: number }
  | { type: 'SOCKET_CLOSED'; now: number; generation: number }
  | {
      type: 'TRANSPORT_LOSS';
      now: number;
      generation: number;
      reason: WorldTransportLossReason;
    }
  | {
      type: 'TRANSPORT_STAND_DOWN';
      now: number;
      generation: number;
      reason: WorldTransportStandDownReason;
    }
  | { type: 'SESSION_RESET'; now: number };

export interface WorldStreamMachineDecision {
  actions: WorldStreamMachineAction[];
  nextState: WorldStreamMachineState;
}

export function createWorldStreamMachineState(): WorldStreamMachineState {
  return {
    everActive: false,
    previousPolicy: 'remote',
    nextActiveIdleAt: null,
    lastSentActiveActivity: null,
    nextRemoteAt: 0,
    bootstrapInFlight: false,
    bootstrapAttempts: 0,
    bootstrapRetryAt: 0,
    recoveryAttempts: 0,
    nextRecoveryAt: 0,
    uploadsSuspended: false,
    superseded: false,
    wsAdvertised: false,
    httpFallbackTripped: false,
    transport: 'http',
    transportEpoch: 0,
    socketPhase: 'idle',
    socketPhaseSince: 0,
    socketGeneration: 0,
    consumedSignalGeneration: null,
    socketConnectFailures: 0,
    socketDropStreak: 0,
    nextSocketOpenAt: 0,
    pendingActiveResync: false,
  };
}

function exponentialDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  return Math.min(baseMs * Math.pow(2, Math.max(0, attempt - 1)), maxMs);
}

function bumpEpoch(nextState: WorldStreamMachineState): void {
  nextState.transportEpoch += 1;
}

function setPhase(
  nextState: WorldStreamMachineState,
  phase: WorldSocketPhase,
  now: number,
): void {
  nextState.socketPhase = phase;
  nextState.socketPhaseSince = now;
}

function applyMembershipLoss(
  nextState: WorldStreamMachineState,
  now: number,
): void {
  if (!nextState.uploadsSuspended) {
    nextState.uploadsSuspended = true;
    nextState.recoveryAttempts = 0;
    nextState.nextRecoveryAt = now;
    bumpEpoch(nextState);
  }
}

function applyHttpFallback(
  nextState: WorldStreamMachineState,
  now: number,
): void {
  if (nextState.transport !== 'http') bumpEpoch(nextState);
  nextState.transport = 'http';
  nextState.httpFallbackTripped = true;
  nextState.socketConnectFailures = 0;
  nextState.socketDropStreak = 0;
  nextState.nextSocketOpenAt = now + FALLBACK_PROBE_INTERVAL_MS;
  nextState.pendingActiveResync = true;
}

function applyStandDown(
  nextState: WorldStreamMachineState,
  now: number,
): void {
  if (nextState.transport !== 'http') bumpEpoch(nextState);
  nextState.transport = 'http';
  nextState.wsAdvertised = false;
  nextState.httpFallbackTripped = false;
  nextState.socketConnectFailures = 0;
  nextState.socketDropStreak = 0;
  nextState.nextSocketOpenAt = 0;
  nextState.pendingActiveResync = true;
}

function applyUnconfirmedSocketFailure(
  nextState: WorldStreamMachineState,
  now: number,
): void {
  nextState.socketConnectFailures += 1;
  if (nextState.socketConnectFailures >= MAX_SOCKET_CONNECT_FAILURES) {
    applyHttpFallback(nextState, now);
    return;
  }
  nextState.nextSocketOpenAt =
    now +
    exponentialDelay(
      nextState.socketConnectFailures,
      SOCKET_REOPEN_BASE_MS,
      SOCKET_REOPEN_MAX_MS,
    );
}

function applyConfirmedSocketDrop(
  nextState: WorldStreamMachineState,
  now: number,
): void {
  nextState.socketConnectFailures = 0;
  nextState.socketDropStreak += 1;
  if (nextState.socketDropStreak > MAX_BARE_SOCKET_REOPENS) {
    applyHttpFallback(nextState, now);
    return;
  }
  nextState.nextSocketOpenAt =
    now +
    exponentialDelay(
      nextState.socketDropStreak,
      SOCKET_REOPEN_BASE_MS,
      SOCKET_REOPEN_MAX_MS,
    );
}

function applyTransportPolicy(
  nextState: WorldStreamMachineState,
  actions: WorldStreamMachineAction[],
  wsAdvertised: boolean,
  now: number,
): void {
  if (
    nextState.socketPhase === 'connecting' ||
    nextState.socketPhase === 'open'
  ) {
    actions.push('CLOSE_SOCKET');
    setPhase(nextState, 'retiring', now);
  }
  nextState.wsAdvertised = wsAdvertised;
  if (!wsAdvertised) {
    if (nextState.transport !== 'http') bumpEpoch(nextState);
    nextState.transport = 'http';
    nextState.httpFallbackTripped = false;
    return;
  }
  nextState.nextSocketOpenAt = now;
  if (nextState.httpFallbackTripped) return;
  if (nextState.transport !== 'ws') {
    bumpEpoch(nextState);
    nextState.transport = 'ws';
  }
}

export function decide(
  state: WorldStreamMachineState,
  input: WorldStreamMachineInput,
): WorldStreamMachineDecision {
  if (state.superseded) {
    return { actions: [], nextState: state };
  }

  let nextState = { ...state };
  const actions: WorldStreamMachineAction[] = [];

  switch (input.type) {
    case 'TICK': {
      const becameActive =
        input.policy === 'active' && state.previousPolicy === 'remote';
      if (input.policy === 'active') {
        nextState.everActive = true;
        if (becameActive) {
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
          !input.documentHidden &&
          !input.recoveryInFlight &&
          state.recoveryAttempts < MAX_RECOVERY_ATTEMPTS &&
          input.now >= state.nextRecoveryAt
        ) {
          actions.push('RECOVER');
        }
        return { actions, nextState };
      }

      if (!input.canUpload) {
        if (
          nextState.socketPhase === 'connecting' ||
          nextState.socketPhase === 'open'
        ) {
          actions.push('CLOSE_SOCKET');
          setPhase(nextState, 'retiring', input.now);
          nextState.socketDropStreak = 0;
          nextState.socketConnectFailures = 0;
        }
        return { actions, nextState };
      }

      if (
        nextState.socketPhase === 'retiring' &&
        input.now - nextState.socketPhaseSince >= SOCKET_RETIRE_TIMEOUT_MS
      ) {
        setPhase(nextState, 'idle', input.now);
      }

      if (
        nextState.socketPhase === 'connecting' &&
        input.now - nextState.socketPhaseSince >= SOCKET_CONNECT_TIMEOUT_MS
      ) {
        actions.push('CLOSE_SOCKET');
        setPhase(nextState, 'retiring', input.now);
        applyUnconfirmedSocketFailure(nextState, input.now);
      }

      if (
        nextState.wsAdvertised &&
        !input.documentHidden &&
        nextState.socketPhase === 'idle' &&
        input.now >= nextState.nextSocketOpenAt
      ) {
        setPhase(nextState, 'connecting', input.now);
        nextState.socketGeneration += 1;
        actions.push('OPEN_SOCKET');
      }

      if (
        nextState.socketPhase === 'retiring' ||
        (nextState.transport === 'ws' && nextState.socketPhase !== 'open')
      ) {
        if (input.policy === 'active') {
          nextState.pendingActiveResync = true;
        }
        return { actions, nextState };
      }

      if (input.policy === 'active') {
        if (state.nextActiveIdleAt === null) {
          nextState.nextActiveIdleAt =
            input.now + ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS;
        }
        const activityChanged =
          state.lastSentActiveActivity !== null &&
          state.lastSentActiveActivity !== input.activeActivity;
        const idleKeepaliveDue =
          input.activeActivity === 'idle' &&
          nextState.nextActiveIdleAt !== null &&
          input.now >= nextState.nextActiveIdleAt;

        if (
          (becameActive && input.hasFrozenPosition) ||
          input.poseChanged ||
          activityChanged ||
          idleKeepaliveDue ||
          state.pendingActiveResync
        ) {
          nextState.nextActiveIdleAt =
            input.now + ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS;
          nextState.lastSentActiveActivity = input.activeActivity;
          nextState.pendingActiveResync = false;
          actions.push('UPLOAD_ACTIVE');
        }
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
      nextState.pendingActiveResync = true;
      applyTransportPolicy(
        nextState,
        actions,
        input.wsAdvertised,
        input.now,
      );
      return { actions, nextState };

    case 'BOOTSTRAP_FAILED': {
      const attempt = state.bootstrapAttempts + 1;
      nextState.bootstrapInFlight = false;
      nextState.bootstrapAttempts = attempt;
      nextState.bootstrapRetryAt =
        input.now +
        exponentialDelay(
          attempt,
          BOOTSTRAP_RETRY_BASE_MS,
          BOOTSTRAP_RETRY_MAX_MS,
        );
      return { actions, nextState };
    }

    case 'POSITION_409':
      applyMembershipLoss(nextState, input.now);
      return { actions, nextState };

    case 'RECOVERY_OK':
      nextState.uploadsSuspended = false;
      nextState.recoveryAttempts = 0;
      nextState.nextRecoveryAt = 0;
      nextState.pendingActiveResync = true;
      nextState.nextRemoteAt = input.now;
      bumpEpoch(nextState);
      applyTransportPolicy(
        nextState,
        actions,
        input.wsAdvertised,
        input.now,
      );
      return { actions, nextState };

    case 'RECOVERY_FAILED': {
      if (!state.uploadsSuspended) {
        return { actions, nextState };
      }
      const attempt = state.recoveryAttempts + 1;
      nextState.recoveryAttempts = attempt;
      nextState.nextRecoveryAt =
        input.now +
        exponentialDelay(
          attempt,
          RECOVERY_RETRY_BASE_MS,
          RECOVERY_RETRY_MAX_MS,
        );
      return { actions, nextState };
    }

    case 'SUPERSEDED':
      nextState.bootstrapInFlight = false;
      nextState.uploadsSuspended = true;
      nextState.superseded = true;
      bumpEpoch(nextState);
      if (
        state.socketPhase === 'connecting' ||
        state.socketPhase === 'open'
      ) {
        actions.push('CLOSE_SOCKET');
        setPhase(nextState, 'retiring', input.now);
      }
      return { actions, nextState };

    case 'SOCKET_OPENED':
      if (
        input.generation !== state.socketGeneration ||
        state.socketPhase !== 'connecting'
      ) {
        return { actions: [], nextState: state };
      }
      setPhase(nextState, 'open', input.now);
      nextState.socketConnectFailures = 0;
      nextState.consumedSignalGeneration = null;
      nextState.httpFallbackTripped = false;
      nextState.nextRemoteAt = input.now;
      nextState.pendingActiveResync = true;
      if (nextState.transport !== 'ws') {
        bumpEpoch(nextState);
        nextState.transport = 'ws';
      }
      return { actions, nextState };

    case 'SOCKET_CLOSED': {
      if (input.generation !== state.socketGeneration) {
        return { actions: [], nextState: state };
      }
      if (state.socketPhase === 'retiring') {
        setPhase(nextState, 'idle', input.now);
        return { actions, nextState };
      }
      if (state.consumedSignalGeneration === input.generation) {
        setPhase(nextState, 'idle', input.now);
        return { actions, nextState };
      }
      const wasConfirmed = state.socketPhase === 'open';
      setPhase(nextState, 'idle', input.now);
      if (wasConfirmed) {
        applyConfirmedSocketDrop(nextState, input.now);
      } else {
        applyUnconfirmedSocketFailure(nextState, input.now);
      }
      return { actions, nextState };
    }

    case 'TRANSPORT_LOSS':
      if (
        input.generation !== state.socketGeneration ||
        state.consumedSignalGeneration === input.generation
      ) {
        return { actions: [], nextState: state };
      }
      nextState.consumedSignalGeneration = input.generation;
      if (
        state.socketPhase === 'connecting' ||
        state.socketPhase === 'open'
      ) {
        actions.push('CLOSE_SOCKET');
        setPhase(nextState, 'retiring', input.now);
      }
      applyMembershipLoss(nextState, input.now);
      return { actions, nextState };

    case 'TRANSPORT_STAND_DOWN':
      if (
        input.generation !== state.socketGeneration ||
        state.consumedSignalGeneration === input.generation
      ) {
        return { actions: [], nextState: state };
      }
      nextState.consumedSignalGeneration = input.generation;
      if (
        state.socketPhase === 'connecting' ||
        state.socketPhase === 'open'
      ) {
        actions.push('CLOSE_SOCKET');
        setPhase(nextState, 'retiring', input.now);
      }
      applyStandDown(nextState, input.now);
      return { actions, nextState };

    case 'SESSION_RESET':
      if (
        state.socketPhase === 'connecting' ||
        state.socketPhase === 'open'
      ) {
        actions.push('CLOSE_SOCKET');
      }
      nextState = {
        ...createWorldStreamMachineState(),
        everActive: state.everActive,
        previousPolicy: state.previousPolicy,
        superseded: state.superseded,
        transportEpoch: state.transportEpoch + 1,
        socketGeneration: state.socketGeneration,
        pendingActiveResync: true,
      };
      setPhase(nextState, 'idle', input.now);
      return { actions, nextState };
  }
}
