import {
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  clearStageRendererFailure,
  getStageRendererFailure,
  getStageRendererFailureServerSnapshot,
  reportStageRendererFailure,
  reportStageRendererRecoveryFailure,
  runStageRendererInitialization,
  subscribeStageRendererFailure,
} from './stage-renderer-status';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('stage renderer terminal status', () => {
  beforeEach(() => {
    clearStageRendererFailure();
  });

  test('successful initialization clears the external store', async () => {
    reportStageRendererFailure({
      webGPUError: new Error('old'),
      webGLError: null,
      phase: 'initial',
      route: '/game',
    });
    let notifications = 0;
    const unsubscribe = subscribeStageRendererFailure(() => {
      notifications += 1;
    });
    const renderer = {};
    expect(
      await runStageRendererInitialization({
        route: '/game',
        forceWebGL: false,
        initialize: async () => renderer,
      }),
    ).toEqual({ renderer, usedWebGL: false });
    expect(getStageRendererFailure()).toBeNull();
    expect(getStageRendererFailureServerSnapshot()).toBeNull();
    expect(notifications).toBe(1);
    unsubscribe();
  });

  test('dual initial rejection reports before rethrowing WebGL error', async () => {
    const webGPUError = new Error('webgpu');
    const webGLError = new Error('webgl');
    let attempts = 0;
    try {
      await runStageRendererInitialization({
        route: '/kelp',
        forceWebGL: false,
        initialize: async () => {
          attempts += 1;
          throw attempts === 1 ? webGPUError : webGLError;
        },
      });
      throw new Error('expected initialization to reject');
    } catch (error) {
      expect(error).toBe(webGLError);
      expect(getStageRendererFailure()).toEqual({
        webGPUError,
        webGLError,
        phase: 'initial',
        route: '/kelp',
      });
    }
  });

  test('forced WebGL rejection reports after one attempt', async () => {
    const webGLError = new Error('forced-webgl');
    let attempts = 0;
    try {
      await runStageRendererInitialization({
        route: '/game',
        forceWebGL: true,
        initialize: async () => {
          attempts += 1;
          throw webGLError;
        },
      });
      throw new Error('expected initialization to reject');
    } catch (error) {
      expect(error).toBe(webGLError);
      expect(attempts).toBe(1);
      expect(getStageRendererFailure()).toEqual({
        webGPUError: null,
        webGLError,
        phase: 'initial',
        route: '/game',
      });
    }
  });

  test('terminal recovery reports phase recovery', () => {
    const webGPUError = new Error('recreate');
    const webGLError = new Error('fallback');
    reportStageRendererRecoveryFailure({
      route: '/kelp',
      webGPUError,
      webGLError,
    });
    expect(getStageRendererFailure()).toEqual({
      route: '/kelp',
      webGPUError,
      webGLError,
      phase: 'recovery',
    });
  });

  test('initial failure keeps the route captured before the awaited init', async () => {
    let currentRoute = '/kelp';
    const capturedRoute = currentRoute;
    const gate = deferred<void>();
    const failure = new Error('late failure');
    const creation = runStageRendererInitialization({
      route: capturedRoute,
      forceWebGL: true,
      initialize: async () => {
        await gate.promise;
        throw failure;
      },
    });
    currentRoute = '/game';
    gate.resolve();
    await creation.catch(() => undefined);
    expect(currentRoute).toBe('/game');
    expect(getStageRendererFailure()?.route).toBe('/kelp');
  });

  test('recovery failure keeps its entry-time route after an await', async () => {
    let currentRoute = '/kelp';
    const capturedRoute = currentRoute;
    const gate = deferred<void>();
    const reporting = (async () => {
      await gate.promise;
      reportStageRendererRecoveryFailure({
        route: capturedRoute,
        webGPUError: new Error('recreate'),
        webGLError: new Error('fallback'),
      });
    })();
    currentRoute = '/game';
    gate.resolve();
    await reporting;
    expect(currentRoute).toBe('/game');
    expect(getStageRendererFailure()?.route).toBe('/kelp');
  });

  test('a kelp report remains attributed without a pending stage request', () => {
    reportStageRendererFailure({
      webGPUError: new Error('webgpu'),
      webGLError: new Error('webgl'),
      phase: 'initial',
      route: '/kelp',
    });
    expect(getStageRendererFailure()?.route).toBe('/kelp');
  });
});
