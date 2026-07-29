import { beforeEach, describe, expect, test } from 'bun:test';
import {
  resetCoveWarmupEntriesForTests,
  waitForCoveCompile,
  warmCoveRendererForGeneration,
} from './cove-warmup-entry-manager';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  resetCoveWarmupEntriesForTests();
});

describe('cove compile entry manager', () => {
  test('late resolve leaves a timed-out renderer tombstoned and bypasses later generations', async () => {
    const gl = {};
    const compile = deferred<void>();
    let compileCalls = 0;
    expect(
      await waitForCoveCompile(
        gl,
        () => {
          compileCalls += 1;
          return compile.promise;
        },
        1,
      ),
    ).toEqual({ kind: 'timed-out' });
    compile.resolve();
    await compile.promise;

    expect(
      await waitForCoveCompile(
        gl,
        () => {
          compileCalls += 1;
          return Promise.resolve();
        },
        1,
      ),
    ).toEqual({ kind: 'bypassed' });
    expect(compileCalls).toBe(1);
  });

  test('late rejection is handled and a timed-out renderer remains bypassed', async () => {
    const gl = {};
    const compile = deferred<void>();
    expect(
      await waitForCoveCompile(gl, () => compile.promise, 1),
    ).toEqual({ kind: 'timed-out' });
    compile.reject(new Error('late rejection'));
    await compile.promise.catch(() => undefined);
    expect(
      await waitForCoveCompile(
        gl,
        () => Promise.reject(new Error('must not run')),
        1,
      ),
    ).toEqual({ kind: 'bypassed' });
  });

  test('timeout bypass never reissues compile on the same renderer', async () => {
    const gl = {};
    let compileCalls = 0;
    const never = new Promise<void>(() => {});
    await waitForCoveCompile(
      gl,
      () => {
        compileCalls += 1;
        return never;
      },
      1,
    );
    expect(
      await waitForCoveCompile(
        gl,
        () => {
          compileCalls += 1;
          return Promise.resolve();
        },
        1,
      ),
    ).toEqual({ kind: 'bypassed' });
    expect(compileCalls).toBe(1);
  });

  test('supersession during compile wait skips the direct warm', async () => {
    const compile = deferred<void>();
    let current = true;
    let directWarmCalls = 0;
    const warming = warmCoveRendererForGeneration({
      gl: {},
      warmedRenderer: null,
      compile: () => compile.promise,
      directWarm: async () => {
        directWarmCalls += 1;
      },
      isCurrent: () => current,
    });
    current = false;
    compile.resolve();
    expect(await warming).toMatchObject({ status: 'superseded' });
    expect(directWarmCalls).toBe(0);
  });

  test('renderer replacement clears the prior tombstone', async () => {
    const firstRenderer = {};
    const secondRenderer = {};
    await waitForCoveCompile(
      firstRenderer,
      () => new Promise<void>(() => {}),
      1,
    );
    let replacementCompileCalls = 0;
    expect(
      await waitForCoveCompile(
        secondRenderer,
        () => {
          replacementCompileCalls += 1;
          return Promise.resolve();
        },
        10,
      ),
    ).toEqual({ kind: 'settled' });
    expect(replacementCompileCalls).toBe(1);
  });
});

describe('StageHostedCoveScene renderer-scoped warmup seam', () => {
  test('an in-place gl replacement warms once on each renderer', async () => {
    const firstRenderer = {};
    const replacementRenderer = {};
    let warmedRenderer: unknown | null = null;
    let compileCalls = 0;
    let directWarmCalls = 0;
    const warm = async (gl: unknown) => {
      const result = await warmCoveRendererForGeneration({
        gl,
        warmedRenderer,
        compile: async () => {
          compileCalls += 1;
        },
        directWarm: async () => {
          directWarmCalls += 1;
        },
        isCurrent: () => true,
      });
      warmedRenderer = result.warmedRenderer;
      return result;
    };

    expect((await warm(firstRenderer)).warmAttempted).toBe(true);
    expect((await warm(firstRenderer)).warmAttempted).toBe(false);
    expect((await warm(replacementRenderer)).warmAttempted).toBe(true);
    expect(compileCalls).toBe(2);
    expect(directWarmCalls).toBe(2);
  });
});
