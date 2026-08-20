import { beforeEach, describe, expect, test } from 'bun:test';
import {
  resetStageWarmupEntriesForTests,
  waitForStageSlotCompile,
  warmStageSlotRenderer,
} from './stage-warmup-entry-manager';
import { __resetBootCompileChainForTests } from '@/lib/three/boot-core-compile';

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
  // The stage compiles chain through the renderer-wide boot-compile FIFO
  // and share its poison registry — reset both between tests.
  __resetBootCompileChainForTests();
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

  test('[fix-NF4] rejected compile heals exactly once, in-chain — never a second directWarm outside', async () => {
    const gl = {};
    let directWarmCalls = 0;
    const result = await warmStageSlotRenderer({
      slotId: 'cove',
      gl,
      warmedRenderer: null,
      compile: async () => {
        throw new Error('front poisoned');
      },
      directWarm: async () => {
        directWarmCalls += 1;
      },
      isCurrent: () => true,
    });
    expect(result.status).toBe('completed');
    expect(directWarmCalls).toBe(1);
  });

  test('[fix-NF4/R5-1] a heal that itself rejects poisons the renderer even when the error observer THROWS — later compiles on it are refused', async () => {
    const gl = {};
    let laterCompileCalls = 0;
    await warmStageSlotRenderer({
      slotId: 'cove',
      gl,
      warmedRenderer: null,
      compile: async () => {
        throw new Error('front poisoned');
      },
      directWarm: async () => {
        throw new Error('heal failed too');
      },
      // [fix-R5-1] a hostile observer must not skip the poison write.
      onDirectWarmRejected: () => {
        throw new Error('observer throws');
      },
      isCurrent: () => true,
    });
    // A later warm on the SAME renderer must skip its compile entirely.
    await warmStageSlotRenderer({
      slotId: 'kelp',
      gl,
      warmedRenderer: null,
      compile: async () => {
        laterCompileCalls += 1;
      },
      directWarm: async () => {},
      isCurrent: () => true,
    });
    expect(laterCompileCalls).toBe(0);
  });

  test('[fix-NF1] a queued compile rechecks poison IN-CHAIN — a predecessor timeout on the same renderer bypasses it', async () => {
    const gl = {};
    const hung = deferred<void>();
    let secondCompileCalls = 0;
    // Both calls start concurrently: the second passes the enqueue-time
    // check (nothing poisoned yet) and queues behind the first in the FIFO.
    const first = warmStageSlotRenderer({
      slotId: 'cove',
      gl,
      warmedRenderer: null,
      compile: () => hung.promise, // never settles within the 1ms timeout
      directWarm: async () => {},
      isCurrent: () => true,
      timeoutMs: 1,
    });
    const second = warmStageSlotRenderer({
      slotId: 'kelp',
      gl,
      warmedRenderer: null,
      compile: async () => {
        secondCompileCalls += 1;
      },
      directWarm: async () => {},
      isCurrent: () => true,
    });
    await Promise.all([first, second]);
    // The first timed out and poisoned the renderer BEFORE the chain
    // released; the second's in-chain recheck must refuse to dispatch.
    expect(secondCompileCalls).toBe(0);
    hung.resolve();
  });
});
