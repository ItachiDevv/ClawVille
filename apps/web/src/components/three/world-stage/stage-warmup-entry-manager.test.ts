import { beforeEach, describe, expect, test } from 'bun:test';
import {
  resetStageWarmupEntriesForTests,
  waitForStageSlotCompile,
  warmStageSlotRenderer,
} from './stage-warmup-entry-manager';

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
  resetStageWarmupEntriesForTests();
});

describe('stage slot compile entry manager', () => {
  test('late resolve leaves a timed-out renderer tombstoned and bypasses later generations', async () => {
    const gl = {};
    const compile = deferred<void>();
    let compileCalls = 0;
    expect(
      await waitForStageSlotCompile(
        'cove',
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
      await waitForStageSlotCompile(
        'cove',
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
      await waitForStageSlotCompile('cove', gl, () => compile.promise, 1),
    ).toEqual({ kind: 'timed-out' });
    compile.reject(new Error('late rejection'));
    await compile.promise.catch(() => undefined);
    expect(
      await waitForStageSlotCompile(
        'cove',
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
    await waitForStageSlotCompile(
      'cove',
      gl,
      () => {
        compileCalls += 1;
        return never;
      },
      1,
    );
    expect(
      await waitForStageSlotCompile(
        'cove',
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
    const warming = warmStageSlotRenderer({
      slotId: 'cove',
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
    await waitForStageSlotCompile(
      'cove',
      firstRenderer,
      () => new Promise<void>(() => {}),
      1,
    );
    let replacementCompileCalls = 0;
    expect(
      await waitForStageSlotCompile(
        'cove',
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

  test('two slot ids on the same renderer keep independent compile entries', async () => {
    const gl = {};
    const coveCompile = deferred<void>();
    let kelpCompileCalls = 0;
    const coveWait = waitForStageSlotCompile(
      'cove',
      gl,
      () => coveCompile.promise,
      50,
    );
    expect(
      await waitForStageSlotCompile(
        'kelp',
        gl,
        async () => {
          kelpCompileCalls += 1;
        },
        50,
      ),
    ).toEqual({ kind: 'settled' });
    coveCompile.resolve();
    expect(await coveWait).toEqual({ kind: 'settled' });
    expect(kelpCompileCalls).toBe(1);
  });

  test('a timed-out slot entry does not tombstone another slot', async () => {
    const gl = {};
    await waitForStageSlotCompile(
      'cove',
      gl,
      () => new Promise<void>(() => {}),
      1,
    );
    let kelpCompileCalls = 0;
    expect(
      await waitForStageSlotCompile(
        'kelp',
        gl,
        async () => {
          kelpCompileCalls += 1;
        },
        20,
      ),
    ).toEqual({ kind: 'settled' });
    expect(kelpCompileCalls).toBe(1);
  });

  test('settling one slot does not clear another slot tombstone', async () => {
    const gl = {};
    await waitForStageSlotCompile(
      'cove',
      gl,
      () => new Promise<void>(() => {}),
      1,
    );
    await waitForStageSlotCompile('kelp', gl, async () => {}, 20);
    expect(
      await waitForStageSlotCompile(
        'cove',
        gl,
        async () => {
          throw new Error('must not run');
        },
        20,
      ),
    ).toEqual({ kind: 'bypassed' });
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
      const result = await warmStageSlotRenderer({
        slotId: 'cove',
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
