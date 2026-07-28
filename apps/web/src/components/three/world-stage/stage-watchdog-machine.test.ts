import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_WATCHDOG_CONFIG,
  reduceWatchdog,
  type WatchdogConfig,
  type WatchdogSample,
  type WatchdogState,
} from './stage-watchdog-machine';

function sample(
  overrides: Partial<WatchdogSample> = {},
): WatchdogSample {
  return {
    stageEpoch: 1,
    requestId: 1,
    sceneKind: 'world',
    transitionPhase: 'awaiting',
    terminal: false,
    readiness: {
      slotReady: false,
      cameraInstalled: false,
      firstControlledFrame: false,
    },
    slotStatus: 'warming',
    recoveryCount: 0,
    loadProgress: 0,
    uploadTotal: 10,
    uploadDone: 0,
    canvasReady: false,
    texturesReady: false,
    hidden: false,
    visibleDeltaMs: 0,
    ...overrides,
  };
}

function seed(
  initial = sample(),
  config = DEFAULT_WATCHDOG_CONFIG,
): WatchdogState {
  const decision = reduceWatchdog(null, initial, config);
  if (!decision.state) throw new Error('watchdog did not initialize');
  return decision.state;
}

function step(
  state: WatchdogState,
  overrides: Partial<WatchdogSample>,
  config = DEFAULT_WATCHDOG_CONFIG,
) {
  return reduceWatchdog(
    state,
    sample({ requestId: state.currentRequestId, ...overrides }),
    config,
  );
}

describe('stage watchdog reducer', () => {
  test('upload crawling every ten seconds passes 90s and stops only at attempt-max', () => {
    let state = seed();
    for (let elapsed = 10_000; elapsed <= 140_000; elapsed += 10_000) {
      const decision = step(state, {
        visibleDeltaMs: 10_000,
        uploadDone: elapsed / 10_000,
        uploadTotal: 20,
      });
      expect(decision.verdict).toBe('none');
      state = decision.state!;
    }
    const decision = step(state, {
      visibleDeltaMs: 10_000,
      uploadDone: 15,
      uploadTotal: 20,
    });
    expect(decision.verdict).toBe('silent-retry');
    expect(decision.state?.failureReason).toBe('attempt-max');
  });

  test('upload frozen for the soft stall window retries', () => {
    let state = seed();
    for (let elapsed = 5_000; elapsed < 45_000; elapsed += 5_000) {
      const decision = step(state, { visibleDeltaMs: 5_000 });
      expect(decision.verdict).toBe('none');
      state = decision.state!;
    }
    const decision = step(state, { visibleDeltaMs: 5_000 });
    expect(decision.verdict).toBe('silent-retry');
    expect(decision.state?.failureReason).toBe('soft-stall');
  });

  test('noise-only churn reaches the hard verdict at 90s', () => {
    let state = seed();
    for (let elapsed = 5_000; elapsed < 90_000; elapsed += 5_000) {
      const decision = step(state, {
        visibleDeltaMs: 5_000,
        loadProgress: elapsed % 10_000 === 0 ? 0 : 0.5,
      });
      expect(decision.verdict).toBe('none');
      state = decision.state!;
    }
    const decision = step(state, {
      visibleDeltaMs: 5_000,
      loadProgress: 0.75,
    });
    expect(decision.verdict).toBe('silent-retry');
    expect(decision.state?.failureReason).toBe('hard-stall');
  });

  test('genuine activity at 65s defers 90s and hard-stalls once at 95s', () => {
    // Noise keeps the soft trigger deferred until the genuine mark at 65s;
    // after 65s everything goes silent (the R2 mixed case: genuine at 65s,
    // THEN silence — without pre-65s activity the soft stall correctly
    // fires at 45s, which is v3-parity, not this scenario).
    let state = seed();
    for (let elapsed = 5_000; elapsed <= 90_000; elapsed += 5_000) {
      const decision = step(state, {
        visibleDeltaMs: 5_000,
        loadProgress: elapsed < 65_000 ? elapsed / 200_000 : 0.325,
        uploadDone: elapsed >= 65_000 ? 1 : 0,
      });
      expect(decision.verdict).toBe('none');
      state = decision.state!;
    }
    const decision = step(state, {
      visibleDeltaMs: 5_000,
      loadProgress: 0.325,
      uploadDone: 1,
    });
    expect(decision.verdict).toBe('silent-retry');
    expect(decision.state?.failureReason).toBe('hard-stall');
    const later = step(decision.state!, {
      visibleDeltaMs: 5_000,
      uploadDone: 1,
    });
    expect(later.verdict).toBe('none');
  });

  test('bridge re-zero does not lower the upload high-water or count as genuine', () => {
    let state = seed(sample({ uploadTotal: 20, uploadDone: 10 }));
    state = step(state, {
      visibleDeltaMs: 5_000,
      uploadTotal: 20,
      uploadDone: 11,
    }).state!;
    expect(state.lastGenuineActivityMs).toBe(5_000);
    state = step(state, {
      visibleDeltaMs: 5_000,
      uploadTotal: 0,
      uploadDone: 0,
    }).state!;
    state = step(state, {
      visibleDeltaMs: 5_000,
      uploadTotal: 20,
      uploadDone: 1,
    }).state!;
    expect(state.uploadDoneHighWater).toBe(11);
    expect(state.lastGenuineActivityMs).toBe(5_000);
  });

  test('boolean readiness re-assertion produces only one genuine edge', () => {
    let state = seed();
    state = step(state, {
      visibleDeltaMs: 5_000,
      canvasReady: true,
    }).state!;
    expect(state.lastGenuineActivityMs).toBe(5_000);
    state = step(state, {
      visibleDeltaMs: 5_000,
      canvasReady: false,
    }).state!;
    state = step(state, {
      visibleDeltaMs: 5_000,
      canvasReady: true,
    }).state!;
    expect(state.lastGenuineActivityMs).toBe(5_000);
  });

  test('retry continuation preserves 200s chain clock and cards at 240s', () => {
    const config: WatchdogConfig = {
      ...DEFAULT_WATCHDOG_CONFIG,
      hardCeilingMs: 200_000,
      attemptMaxMs: 300_000,
    };
    let state = seed(sample({ uploadTotal: 1 }), config);
    for (let elapsed = 10_000; elapsed < 200_000; elapsed += 10_000) {
      const decision = step(
        state,
        {
          visibleDeltaMs: 10_000,
          uploadDone: Math.min(17, elapsed / 10_000),
          uploadTotal: 30,
        },
        config,
      );
      expect(decision.verdict).toBe('none');
      state = decision.state!;
    }
    const retryVerdict = step(
      state,
      {
        visibleDeltaMs: 10_000,
        uploadDone: 17,
        uploadTotal: 30,
      },
      config,
    );
    expect(retryVerdict.verdict).toBe('silent-retry');
    expect(retryVerdict.state?.chainElapsedMs).toBe(200_000);

    const continuation = reduceWatchdog(
      retryVerdict.state,
      sample({
        requestId: 2,
        retryOfRequestId: 1,
        uploadDone: 0,
        visibleDeltaMs: 0,
      }),
      config,
    );
    expect(continuation.state?.attemptIndex).toBe(1);
    expect(continuation.state?.chainElapsedMs).toBe(200_000);
    // The reducer clamps each tick's delta to 2× cadence (10s), so the
    // remaining 40s of chain budget is spent across four ticks, not one.
    let chainState = continuation.state!;
    for (const expectedChainMs of [210_000, 220_000, 230_000]) {
      const decision = step(
        chainState,
        { visibleDeltaMs: 10_000, requestId: 2 },
        config,
      );
      expect(decision.verdict).toBe('none');
      expect(decision.state?.chainElapsedMs).toBe(expectedChainMs);
      chainState = decision.state!;
    }
    const card = step(
      chainState,
      { visibleDeltaMs: 10_000, requestId: 2 },
      config,
    );
    expect(card.verdict).toBe('fail-card');
    expect(card.state?.failureReason).toBe('chain-max');
    expect(card.state?.chainElapsedMs).toBe(240_000);
  });

  test('chain-max fails immediately and cannot mint another retry', () => {
    const state = {
      ...seed(),
      chainElapsedMs: 235_000,
      attemptElapsedMs: 10_000,
    };
    const decision = step(state, { visibleDeltaMs: 5_000 });
    expect(decision.verdict).toBe('fail-card');
    expect(decision.state?.failureReason).toBe('chain-max');
  });

  test('terminal state returns none forever', () => {
    let state = seed();
    const terminal = step(state, { terminal: true });
    expect(terminal.verdict).toBe('none');
    state = terminal.state!;
    expect(step(state, { visibleDeltaMs: 90_000 }).verdict).toBe('none');
    expect(step(state, { visibleDeltaMs: 90_000 }).verdict).toBe('none');
  });

  test('an unrelated request identity starts a fresh chain', () => {
    const old = {
      ...seed(),
      chainElapsedMs: 80_000,
      attemptElapsedMs: 80_000,
    };
    const decision = reduceWatchdog(
      old,
      sample({
        requestId: 99,
        retryOfRequestId: 50,
        visibleDeltaMs: 5_000,
      }),
    );
    expect(decision.state?.chainRootRequestId).toBe(99);
    expect(decision.state?.currentRequestId).toBe(99);
    expect(decision.state?.chainElapsedMs).toBe(5_000);
    expect(decision.state?.attemptIndex).toBe(0);
  });

  test('readiness tuple satisfied on the ceiling tick wins without charging', () => {
    const state = {
      ...seed(),
      chainElapsedMs: 85_000,
      attemptElapsedMs: 85_000,
    };
    const decision = step(state, {
      visibleDeltaMs: 5_000,
      readiness: {
        slotReady: true,
        cameraInstalled: true,
        firstControlledFrame: true,
      },
    });
    expect(decision.verdict).toBe('none');
    expect(decision.state?.attemptElapsedMs).toBe(85_000);
  });

  test('hidden ticks charge no clocks or activity', () => {
    const state = seed();
    const decision = step(state, {
      hidden: true,
      visibleDeltaMs: 10_000,
      uploadDone: 5,
      canvasReady: true,
    });
    expect(decision.verdict).toBe('none');
    expect(decision.state?.chainElapsedMs).toBe(0);
    expect(decision.state?.attemptElapsedMs).toBe(0);
    expect(decision.state?.uploadDoneHighWater).toBe(0);
    expect(decision.state?.canvasSeen).toBe(false);
  });

  test('stage epoch change disambiguates reused request ids', () => {
    const old = {
      ...seed(),
      chainElapsedMs: 80_000,
      attemptElapsedMs: 80_000,
    };
    const decision = reduceWatchdog(
      old,
      sample({
        stageEpoch: 2,
        requestId: 1,
        visibleDeltaMs: 5_000,
      }),
    );
    expect(decision.state?.stageEpoch).toBe(2);
    expect(decision.state?.chainElapsedMs).toBe(5_000);
    expect(decision.state?.attemptIndex).toBe(0);
  });
});
