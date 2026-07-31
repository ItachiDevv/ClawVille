import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS,
  REMOTE_PRESENCE_INTERVAL_MS,
  createWorldStreamMachineState,
  decide,
  type WorldStreamMachineInput,
  type WorldStreamMachineState,
} from './world-stream-machine';

function tick(
  state: WorldStreamMachineState,
  overrides: Partial<Extract<WorldStreamMachineInput, { type: 'TICK' }>> = {},
) {
  return decide(state, {
    type: 'TICK',
    now: 0,
    policy: 'remote',
    hasSession: false,
    canUpload: true,
    hasFrozenPosition: false,
    recoveryInFlight: false,
    poseChanged: false,
    activeActivity: 'idle',
    documentHidden: false,
    ...overrides,
  });
}

describe('world stream machine', () => {
  test('cold cove does not join or upload', () => {
    const decision = tick(createWorldStreamMachineState());
    expect(decision.actions).toEqual([]);
    expect(decision.nextState.everActive).toBe(false);
  });

  test('the first active flip bootstraps once', () => {
    const first = tick(createWorldStreamMachineState(), { policy: 'active' });
    expect(first.actions).toEqual(['RESET_ACTIVE_POSITION', 'BOOTSTRAP']);
    expect(first.nextState.everActive).toBe(true);
    expect(first.nextState.bootstrapInFlight).toBe(true);

    const second = tick(first.nextState, { policy: 'active', now: 200 });
    expect(second.actions).toEqual([]);
  });

  test('remote presence is limited to one upload per ten seconds', () => {
    let state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active' as const,
    };
    const first = tick(state, {
      hasSession: true,
      hasFrozenPosition: true,
      now: 1_000,
    });
    expect(first.actions).toEqual(['UPLOAD_REMOTE']);

    const early = tick(first.nextState, {
      hasSession: true,
      hasFrozenPosition: true,
      now: 1_000 + REMOTE_PRESENCE_INTERVAL_MS - 1,
    });
    expect(early.actions).toEqual([]);

    const due = tick(early.nextState, {
      hasSession: true,
      hasFrozenPosition: true,
      now: 1_000 + REMOTE_PRESENCE_INTERVAL_MS,
    });
    expect(due.actions).toEqual(['UPLOAD_REMOTE']);
  });

  test('remote to active resets position before deriving the active upload', () => {
    const state = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'remote' as const,
    };
    const decision = tick(state, {
      policy: 'active',
      hasSession: true,
      hasFrozenPosition: true,
    });
    expect(decision.actions).toEqual([
      'RESET_ACTIVE_POSITION',
      'UPLOAD_ACTIVE',
    ]);
  });

  test('still active presence is silent until each idle keepalive boundary', () => {
    let state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
    };

    const first = tick(state, {
      policy: 'active',
      hasSession: true,
      now: 0,
    });
    expect(first.actions).toEqual([]);

    const early = tick(first.nextState, {
      policy: 'active',
      hasSession: true,
      now: ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS - 1,
    });
    expect(early.actions).toEqual([]);

    const due = tick(early.nextState, {
      policy: 'active',
      hasSession: true,
      now: ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS,
    });
    expect(due.actions).toEqual(['UPLOAD_ACTIVE']);

    const nextEarly = tick(due.nextState, {
      policy: 'active',
      hasSession: true,
      now: ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS * 2 - 1,
    });
    expect(nextEarly.actions).toEqual([]);

    const nextDue = tick(nextEarly.nextState, {
      policy: 'active',
      hasSession: true,
      now: ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS * 2,
    });
    expect(nextDue.actions).toEqual(['UPLOAD_ACTIVE']);
  });

  test('movement emits on the first changed tick and each sustained changed tick', () => {
    let state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
    };

    const first = tick(state, {
      policy: 'active',
      hasSession: true,
      poseChanged: true,
      activeActivity: 'walking',
    });
    expect(first.actions).toEqual(['UPLOAD_ACTIVE']);

    const sustained = tick(first.nextState, {
      policy: 'active',
      hasSession: true,
      now: 200,
      poseChanged: true,
      activeActivity: 'walking',
    });
    expect(sustained.actions).toEqual(['UPLOAD_ACTIVE']);
  });

  test('movement stop emits one terminal idle sample then stays silent', () => {
    const moving = tick(
      {
        ...createWorldStreamMachineState(),
        everActive: true,
        previousPolicy: 'active',
      },
      {
        policy: 'active',
        hasSession: true,
        poseChanged: true,
        activeActivity: 'walking',
      },
    );

    const stopped = tick(moving.nextState, {
      policy: 'active',
      hasSession: true,
      now: 200,
      activeActivity: 'idle',
    });
    expect(stopped.actions).toEqual(['UPLOAD_ACTIVE']);

    const stillStopped = tick(stopped.nextState, {
      policy: 'active',
      hasSession: true,
      now: 400,
      activeActivity: 'idle',
    });
    expect(stillStopped.actions).toEqual([]);
  });

  test('heading-only pose changes and activity transitions emit', () => {
    const headingOnly = tick(
      {
        ...createWorldStreamMachineState(),
        everActive: true,
        previousPolicy: 'active',
      },
      {
        policy: 'active',
        hasSession: true,
        poseChanged: true,
        activeActivity: 'idle',
      },
    );
    expect(headingOnly.actions).toEqual(['UPLOAD_ACTIVE']);

    const activityTransition = tick(headingOnly.nextState, {
      policy: 'active',
      hasSession: true,
      now: 200,
      poseChanged: false,
      activeActivity: 'walking',
    });
    expect(activityTransition.actions).toEqual(['UPLOAD_ACTIVE']);
  });

  test('409 recovery is spaced, capped, and suspends uploads', () => {
    let state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active' as const,
    };
    state = decide(state, { type: 'POSITION_409', now: 1_000 }).nextState;

    for (let attempt = 0; attempt < 3; attempt++) {
      const recovery = tick(state, {
        policy: 'active',
        hasSession: true,
        hasFrozenPosition: true,
        now: state.nextRecoveryAt,
      });
      expect(recovery.actions).toEqual(['RECOVER']);
      state = decide(recovery.nextState, {
        type: 'RECOVERY_FAILED',
        now: state.nextRecoveryAt,
      }).nextState;
      expect(state.nextRecoveryAt).toBeGreaterThanOrEqual(
        (attempt === 0 ? 1_000 : 0) + 20_000,
      );
    }

    const exhausted = tick(state, {
      policy: 'active',
      hasSession: true,
      hasFrozenPosition: true,
      now: Number.MAX_SAFE_INTEGER,
    });
    expect(exhausted.actions).toEqual([]);
    expect(exhausted.nextState.uploadsSuspended).toBe(true);
  });

  test('supersession is terminal', () => {
    const terminal = decide(createWorldStreamMachineState(), {
      type: 'SUPERSEDED',
      now: 1,
    }).nextState;
    const later = tick(terminal, {
      policy: 'active',
      hasSession: true,
      hasFrozenPosition: true,
      now: Number.MAX_SAFE_INTEGER,
    });
    expect(later.actions).toEqual([]);
    expect(later.nextState).toBe(terminal);
  });
});

describe('world stream transport machine', () => {
  test('the default machine never opens a socket', () => {
    let state = createWorldStreamMachineState();
    for (let index = 0; index < 20; index++) {
      const decision = tick(state, { now: index * 200 });
      expect(decision.actions).not.toContain('OPEN_SOCKET');
      state = decision.nextState;
    }
    expect(state.transport).toBe('http');
  });

  test('an advertised join adopts ws and schedules exactly one socket', () => {
    const joined = decide(createWorldStreamMachineState(), {
      type: 'BOOTSTRAP_OK',
      now: 1,
      wsAdvertised: true,
    });
    expect(joined.nextState.transport).toBe('ws');

    const opening = tick(joined.nextState, {
      now: 1,
      hasSession: true,
    });
    expect(opening.actions).toEqual(['OPEN_SOCKET']);
    expect(opening.nextState.socketGeneration).toBe(1);

    const waiting = tick(opening.nextState, {
      now: 201,
      hasSession: true,
    });
    expect(waiting.actions).toEqual([]);
  });

  test('an unadvertised join pins http and closes any socket', () => {
    const state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      transport: 'ws',
      wsAdvertised: true,
      socketPhase: 'open',
      socketGeneration: 1,
    };
    const recovered = decide(state, {
      type: 'RECOVERY_OK',
      now: 10,
      wsAdvertised: false,
    });
    expect(recovered.actions).toEqual(['CLOSE_SOCKET']);
    expect(recovered.nextState).toMatchObject({
      transport: 'http',
      socketPhase: 'retiring',
      wsAdvertised: false,
    });
  });

  test('no upload is emitted while the ws socket is not open', () => {
    const state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
      transport: 'ws',
      wsAdvertised: true,
      socketPhase: 'connecting',
      socketGeneration: 1,
      nextActiveIdleAt: 123,
      lastSentActiveActivity: 'idle',
    };
    const decision = tick(state, {
      now: 10,
      policy: 'active',
      hasSession: true,
      poseChanged: true,
      activeActivity: 'walking',
    });
    expect(decision.actions).toEqual([]);
    expect(decision.nextState.nextActiveIdleAt).toBe(123);
    expect(decision.nextState.lastSentActiveActivity).toBe('idle');
    expect(decision.nextState.pendingActiveResync).toBe(true);
  });

  test('nothing is emitted while a socket is retiring, in either transport', () => {
    const state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
      transport: 'http',
      socketPhase: 'retiring',
      socketPhaseSince: 1,
    };
    const decision = tick(state, {
      now: 500,
      policy: 'active',
      hasSession: true,
      poseChanged: true,
      activeActivity: 'walking',
    });
    expect(decision.actions).toEqual([]);
    expect(decision.nextState.pendingActiveResync).toBe(true);
  });

  test('a retiring socket is force-idled after the retire timeout', () => {
    const state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      socketPhase: 'retiring',
      socketPhaseSince: 10,
      socketConnectFailures: 2,
      socketDropStreak: 1,
    };
    const decision = tick(state, {
      now: 1_010,
      hasSession: true,
    });
    expect(decision.nextState.socketPhase).toBe('idle');
    expect(decision.nextState.socketConnectFailures).toBe(2);
    expect(decision.nextState.socketDropStreak).toBe(1);
  });

  test('the first tick after a confirmed open resyncs the pose', () => {
    const connecting: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
      transport: 'ws',
      wsAdvertised: true,
      socketPhase: 'connecting',
      socketGeneration: 1,
    };
    const opened = decide(connecting, {
      type: 'SOCKET_OPENED',
      now: 10,
      generation: 1,
    });
    expect(opened.actions).toEqual([]);

    const resync = tick(opened.nextState, {
      now: 10,
      policy: 'active',
      hasSession: true,
    });
    expect(resync.actions).toEqual(['UPLOAD_ACTIVE']);

    const quiet = tick(resync.nextState, {
      now: 210,
      policy: 'active',
      hasSession: true,
    });
    expect(quiet.actions).toEqual([]);
  });

  test('stale-generation socket signals are ignored', () => {
    const state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      transport: 'ws',
      wsAdvertised: true,
      socketPhase: 'connecting',
      socketGeneration: 2,
    };
    const inputs: WorldStreamMachineInput[] = [
      { type: 'SOCKET_OPENED', now: 1, generation: 1 },
      { type: 'SOCKET_CLOSED', now: 1, generation: 1 },
      {
        type: 'TRANSPORT_LOSS',
        now: 1,
        generation: 1,
        reason: 'membership_lost',
      },
      {
        type: 'TRANSPORT_STAND_DOWN',
        now: 1,
        generation: 1,
        reason: 'socket_replaced',
      },
    ];
    for (const input of inputs) {
      expect(decide(state, input).nextState).toBe(state);
    }
  });

  test('a control frame and its close cannot start two rejoins', () => {
    const state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
      transport: 'ws',
      wsAdvertised: true,
      socketPhase: 'open',
      socketGeneration: 1,
    };
    const lost = decide(state, {
      type: 'TRANSPORT_LOSS',
      now: 10,
      generation: 1,
      reason: 'membership_lost',
    });
    const closed = decide(lost.nextState, {
      type: 'SOCKET_CLOSED',
      now: 11,
      generation: 1,
    });
    expect(closed.actions).toEqual([]);
    expect(closed.nextState.recoveryAttempts).toBe(0);
    const recovery = tick(closed.nextState, {
      now: 11,
      policy: 'active',
      hasSession: true,
    });
    expect(recovery.actions).toEqual(['RECOVER']);
  });

  test('4409 arriving before the frame is equally deduped', () => {
    const state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
      transport: 'ws',
      wsAdvertised: true,
      socketPhase: 'open',
      socketGeneration: 1,
    };
    const closed = decide(state, {
      type: 'SOCKET_CLOSED',
      now: 10,
      generation: 1,
    });
    const lost = decide(closed.nextState, {
      type: 'TRANSPORT_LOSS',
      now: 11,
      generation: 1,
      reason: 'membership_lost',
    });
    const recovery = tick(lost.nextState, {
      now: 11,
      policy: 'active',
      hasSession: true,
    });
    expect(recovery.actions).toEqual(['RECOVER']);
    expect(lost.nextState.recoveryAttempts).toBe(0);
  });

  test('a connect timeout counts exactly once', () => {
    const state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      transport: 'ws',
      wsAdvertised: true,
      socketPhase: 'connecting',
      socketPhaseSince: 10,
      socketGeneration: 1,
    };
    const timedOut = tick(state, {
      now: 5_010,
      hasSession: true,
    });
    expect(timedOut.actions).toEqual(['CLOSE_SOCKET']);
    expect(timedOut.nextState.socketConnectFailures).toBe(1);
    const closed = decide(timedOut.nextState, {
      type: 'SOCKET_CLOSED',
      now: 5_011,
      generation: 1,
    });
    expect(closed.nextState.socketConnectFailures).toBe(1);
  });

  test('three unconfirmed sockets fall back to http without a rejoin', () => {
    let state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
      transport: 'ws',
      wsAdvertised: true,
    };
    for (let generation = 1; generation <= 3; generation++) {
      state = {
        ...state,
        socketPhase: 'connecting',
        socketGeneration: generation,
      };
      state = decide(state, {
        type: 'SOCKET_CLOSED',
        now: generation * 1_000,
        generation,
      }).nextState;
    }
    expect(state).toMatchObject({
      transport: 'http',
      httpFallbackTripped: true,
      uploadsSuspended: false,
      recoveryAttempts: 0,
    });
    const upload = tick(state, {
      now: 3_001,
      policy: 'active',
      hasSession: true,
      poseChanged: true,
    });
    expect(upload.actions).toEqual(['UPLOAD_ACTIVE']);
  });

  test('three confirmed drops fall back to http and never spend a join', () => {
    let state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
      transport: 'ws',
      wsAdvertised: true,
    };
    for (let generation = 1; generation <= 3; generation++) {
      state = {
        ...state,
        socketPhase: 'open',
        socketGeneration: generation,
      };
      state = decide(state, {
        type: 'SOCKET_CLOSED',
        now: generation * 1_000,
        generation,
      }).nextState;
    }
    expect(state.httpFallbackTripped).toBe(true);
    expect(state.uploadsSuspended).toBe(false);
    const later = tick(state, {
      now: Number.MAX_SAFE_INTEGER,
      policy: 'active',
      hasSession: true,
    });
    expect(later.actions).not.toContain('RECOVER');
  });

  test('socket_replaced latches http with no probe', () => {
    const state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      transport: 'ws',
      wsAdvertised: true,
      socketPhase: 'open',
      socketGeneration: 1,
    };
    let stoodDown = decide(state, {
      type: 'TRANSPORT_STAND_DOWN',
      now: 10,
      generation: 1,
      reason: 'socket_replaced',
    }).nextState;
    expect(stoodDown).toMatchObject({
      wsAdvertised: false,
      httpFallbackTripped: false,
      superseded: false,
      uploadsSuspended: false,
    });
    stoodDown = decide(stoodDown, {
      type: 'SOCKET_CLOSED',
      now: 11,
      generation: 1,
    }).nextState;
    for (const now of [60_000, 120_000, 600_000]) {
      const decision = tick(stoodDown, { now, hasSession: true });
      expect(decision.actions).not.toContain('OPEN_SOCKET');
      stoodDown = decision.nextState;
    }
  });

  test('bad_frame and flood latch identically', () => {
    for (const reason of ['bad_frame', 'flood'] as const) {
      const state: WorldStreamMachineState = {
        ...createWorldStreamMachineState(),
        transport: 'ws',
        wsAdvertised: true,
        socketPhase: 'open',
        socketGeneration: 1,
      };
      const decision = decide(state, {
        type: 'TRANSPORT_STAND_DOWN',
        now: 1,
        generation: 1,
        reason,
      });
      expect(decision.nextState).toMatchObject({
        transport: 'http',
        wsAdvertised: false,
        httpFallbackTripped: false,
        uploadsSuspended: false,
      });
    }
  });

  test('only a later join re-enables ws after a stand-down', () => {
    const state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      transport: 'ws',
      wsAdvertised: true,
      socketPhase: 'open',
      socketGeneration: 1,
    };
    const stoodDown = decide(state, {
      type: 'TRANSPORT_STAND_DOWN',
      now: 1,
      generation: 1,
      reason: 'socket_replaced',
    });
    const retired = decide(stoodDown.nextState, {
      type: 'SOCKET_CLOSED',
      now: 2,
      generation: 1,
    });
    const rejoined = decide(retired.nextState, {
      type: 'RECOVERY_OK',
      now: 3,
      wsAdvertised: true,
    });
    const opening = tick(rejoined.nextState, {
      now: 3,
      hasSession: true,
    });
    expect(opening.actions).toEqual(['OPEN_SOCKET']);
  });

  test('a hidden tab defers recovery and socket opens but not uploads', () => {
    const suspended: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      uploadsSuspended: true,
    };
    const hidden = tick(suspended, {
      now: 100_000,
      hasSession: true,
      documentHidden: true,
    });
    expect(hidden.actions).toEqual([]);
    const visible = tick(hidden.nextState, {
      now: 100_000,
      hasSession: true,
      documentHidden: false,
    });
    expect(visible.actions).toEqual(['RECOVER']);

    const uploadState: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
      nextActiveIdleAt: 1,
      lastSentActiveActivity: 'idle',
    };
    const upload = tick(uploadState, {
      now: 1,
      policy: 'active',
      hasSession: true,
      documentHidden: true,
    });
    expect(upload.actions).toEqual(['UPLOAD_ACTIVE']);
  });

  test('explore and autonomous close an open socket exactly once', () => {
    for (const mode of ['explore', 'autonomous']) {
      const state: WorldStreamMachineState = {
        ...createWorldStreamMachineState(),
        transport: 'ws',
        wsAdvertised: true,
        socketPhase: 'open',
        socketGeneration: 1,
        socketDropStreak: 2,
      };
      const closing = tick(state, {
        now: 1,
        hasSession: true,
        canUpload: false,
      });
      expect(closing.actions).toEqual(['CLOSE_SOCKET']);
      expect(closing.nextState).toMatchObject({
        socketPhase: 'retiring',
        socketDropStreak: 0,
      });
      const repeated = tick(closing.nextState, {
        now: 200,
        hasSession: true,
        canUpload: false,
      });
      expect(repeated.actions).toEqual([]);
      const retired = decide(repeated.nextState, {
        type: 'SOCKET_CLOSED',
        now: 201,
        generation: 1,
      });
      const reopening = tick(retired.nextState, {
        now: 201,
        hasSession: true,
        canUpload: true,
      });
      expect(reopening.actions).toEqual(['OPEN_SOCKET']);
      expect(mode).toBeTruthy();
    }
  });

  test('the transport epoch is strictly monotonic', () => {
    let state = createWorldStreamMachineState();
    const epochs = [state.transportEpoch];
    const capture = (next: WorldStreamMachineState) => {
      expect(next.transportEpoch).toBeGreaterThan(epochs.at(-1) ?? -1);
      epochs.push(next.transportEpoch);
      state = next;
    };

    capture(
      decide(state, {
        type: 'BOOTSTRAP_OK',
        now: 1,
        wsAdvertised: true,
      }).nextState,
    );
    state = {
      ...state,
      socketPhase: 'open',
      socketGeneration: 1,
    };
    capture(
      decide(state, {
        type: 'TRANSPORT_STAND_DOWN',
        now: 2,
        generation: 1,
        reason: 'socket_replaced',
      }).nextState,
    );
    state = { ...state, socketPhase: 'idle' };
    capture(
      decide(state, {
        type: 'RECOVERY_OK',
        now: 3,
        wsAdvertised: true,
      }).nextState,
    );
    capture(
      decide(state, {
        type: 'POSITION_409',
        now: 4,
      }).nextState,
    );
    capture(
      decide(state, {
        type: 'RECOVERY_OK',
        now: 5,
        wsAdvertised: false,
      }).nextState,
    );
    capture(decide(state, { type: 'SESSION_RESET', now: 6 }).nextState);
    capture(decide(state, { type: 'SUPERSEDED', now: 7 }).nextState);
  });
});
