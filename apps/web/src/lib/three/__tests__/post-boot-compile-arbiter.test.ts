// post-boot-compile-arbiter.test.ts — R3-2 follow-up (founder fix order
// 2026-09-07): the seven cosmetic/activity compileAsync call sites route
// through chainPostBootCompile. Contract under test: FIFO membership,
// poisoned-renderer bypass (pre-chain AND in-chain TOCTOU), cancellation,
// timeout-poisons-before-release, rejection-poisons, and success leaves the
// renderer clean.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetBootCompileChainForTests,
  chainBootCompile,
  chainPostBootCompile,
  holdPostBootCompiles,
  isRendererCompileTimedOut,
  markRendererCompileTimedOut,
} from '../boot-core-compile';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  __resetBootCompileChainForTests();
});

describe('chainPostBootCompile', () => {
  test('a successful compile reports compiled and does not poison the renderer', async () => {
    const gl = {};
    let calls = 0;
    const outcome = await chainPostBootCompile({
      gl,
      compile: async () => {
        calls += 1;
      },
      label: 'test',
    });
    expect(outcome).toBe('compiled');
    expect(calls).toBe(1);
    expect(isRendererCompileTimedOut(gl)).toBe(false);
  });

  test('a poisoned renderer bypasses without invoking compile', async () => {
    const gl = {};
    markRendererCompileTimedOut(gl);
    let calls = 0;
    const outcome = await chainPostBootCompile({
      gl,
      compile: async () => {
        calls += 1;
      },
      label: 'test',
    });
    expect(outcome).toBe('bypassed');
    expect(calls).toBe(0);
  });

  test('in-chain TOCTOU recheck: poisoning while queued bypasses the dispatch', async () => {
    const gl = {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Occupy the FIFO, then poison the renderer while the post-boot task waits.
    const head = chainBootCompile(async () => {
      await gate;
    });
    let calls = 0;
    const pending = chainPostBootCompile({
      gl,
      compile: async () => {
        calls += 1;
      },
      label: 'test',
    });
    markRendererCompileTimedOut(gl);
    release();
    await head;
    expect(await pending).toBe('bypassed');
    expect(calls).toBe(0);
  });

  test('in-chain cancellation check: an unmounted caller skips the dispatch', async () => {
    const gl = {};
    let cancelled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const head = chainBootCompile(async () => {
      await gate;
    });
    let calls = 0;
    const pending = chainPostBootCompile({
      gl,
      compile: async () => {
        calls += 1;
      },
      label: 'test',
      isCancelled: () => cancelled,
    });
    cancelled = true;
    release();
    await head;
    expect(await pending).toBe('cancelled');
    expect(calls).toBe(0);
  });

  test('a rejection poisons the renderer and reports failed', async () => {
    const gl = {};
    const outcome = await chainPostBootCompile({
      gl,
      compile: async () => {
        throw new Error('front exploded');
      },
      label: 'test',
    });
    expect(outcome).toBe('failed');
    expect(isRendererCompileTimedOut(gl)).toBe(true);
  });

  test('a timeout poisons the renderer BEFORE the chain releases', async () => {
    const gl = {};
    let hangResolve!: () => void;
    // Queue the hung task AND its successor BEFORE the timeout fires — the
    // successor sits in the FIFO behind the hung one, so it dispatches at
    // the exact moment the chain releases. An implementation that poisoned
    // AFTER release would dispatch the successor's compile and fail this
    // test (arbiter review, blocking issue 2).
    let successorDispatched = false;
    const first = chainPostBootCompile({
      gl,
      compile: () =>
        new Promise<void>((resolve) => {
          hangResolve = resolve;
        }),
      label: 'test',
      timeoutMs: 5,
    });
    const second = chainPostBootCompile({
      gl,
      compile: async () => {
        successorDispatched = true;
      },
      label: 'test',
    });
    expect(await first).toBe('timed_out');
    expect(isRendererCompileTimedOut(gl)).toBe(true);
    expect(await second).toBe('bypassed');
    expect(successorDispatched).toBe(false);
    hangResolve();
  });

  test('a boot-priority hold defers admission until release', async () => {
    const gl = {};
    const release = holdPostBootCompiles();
    let dispatched = false;
    const pending = chainPostBootCompile({
      gl,
      compile: async () => {
        dispatched = true;
      },
      label: 'test',
    });
    // Held: the task must not dispatch while the boot window is open.
    await tick();
    expect(dispatched).toBe(false);
    release();
    expect(await pending).toBe('compiled');
    expect(dispatched).toBe(true);
    // Idempotent release — a second call is a no-op.
    release();
  });

  test('an expired hold admits deferred tasks without an explicit release', async () => {
    const gl = {};
    holdPostBootCompiles(5); // auto-expiry backstop
    const pending = chainPostBootCompile({
      gl,
      compile: async () => {},
      label: 'test',
    });
    expect(await pending).toBe('compiled');
  });

  test('a held post-boot task stays OUTSIDE the FIFO (boot tasks run through it)', async () => {
    const gl = {};
    const release = holdPostBootCompiles();
    let postBootRan = false;
    const pending = chainPostBootCompile({
      gl,
      compile: async () => {
        postBootRan = true;
      },
      label: 'test',
    });
    await tick();
    // While held, the chain must be FREE: a boot task queued now completes
    // even though the post-boot task is still deferred.
    let bootRan = false;
    await chainBootCompile(async () => {
      bootRan = true;
    });
    expect(bootRan).toBe(true);
    expect(postBootRan).toBe(false);
    release();
    expect(await pending).toBe('compiled');
  });

  test('a hold installed AFTER admission makes the chained task yield and re-defer (late-hold race)', async () => {
    const gl = {};
    let gateRelease!: () => void;
    const gate = new Promise<void>((resolve) => {
      gateRelease = resolve;
    });
    // Occupy the FIFO so the post-boot task is admitted (no hold yet) but
    // waits IN the chain...
    const head = chainBootCompile(async () => {
      await gate;
    });
    let dispatched = false;
    const pending = chainPostBootCompile({
      gl,
      compile: async () => {
        dispatched = true;
      },
      label: 'test',
    });
    await tick();
    // ...then a boot window opens BEFORE the chain reaches it.
    const release = holdPostBootCompiles();
    gateRelease();
    await head;
    await tick();
    // The task must have yielded its slot, not compiled under the hold.
    expect(dispatched).toBe(false);
    release();
    expect(await pending).toBe('compiled');
    expect(dispatched).toBe(true);
  });

  test('runs strictly serially with boot-lane tasks through the shared FIFO', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const work = async (name: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(name);
      await tick();
      inFlight -= 1;
    };
    const a = chainBootCompile(() => work('boot-1'));
    const b = chainPostBootCompile({
      gl: {},
      compile: () => work('post-boot'),
      label: 'test',
    });
    const c = chainBootCompile(() => work('boot-2'));
    await Promise.all([a, b, c]);
    // Post-boot admission yields a microtask (the boot-priority hold gate),
    // so boot tasks queued in the same turn may order ahead of it — that is
    // the DESIRED priority direction. The invariant under test is strict
    // serial width 1 and no lost task, not a fixed interleaving.
    expect([...order].sort()).toEqual(['boot-1', 'boot-2', 'post-boot']);
    expect(order.indexOf('boot-1')).toBe(0);
    expect(peak).toBe(1);
  });

  test('a poisoned renderer does not block a DIFFERENT renderer', async () => {
    const poisoned = {};
    const healthy = {};
    markRendererCompileTimedOut(poisoned);
    let calls = 0;
    const outcome = await chainPostBootCompile({
      gl: healthy,
      compile: async () => {
        calls += 1;
      },
      label: 'test',
    });
    expect(outcome).toBe('compiled');
    expect(calls).toBe(1);
  });
});
