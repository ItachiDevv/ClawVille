// web-load T6: the deferred compile must not run as a continuation of an idle
// callback. Per the WICG scheduling spec a requestIdleCallback callback runs
// with a BACKGROUND scheduling state, and every `await` registered in a chain
// that started there keeps it. The warm job started in the queue's idle
// callback, so three r185's `scheduler.yield()` inside compileAsync became a
// background task and, on a saturated main thread, never resumed (Nori's
// compile hit the 20 s escape and poisoned the renderer).
//
// The fake event loop below models one task at a time: a task runs with a
// priority, then its microtask checkpoint drains under the SAME priority,
// then the next task runs. It records the priority current at the moment
// compileAsync is called. This is an approximation of the spec rule (state
// follows the registering context); for the base module both give
// 'background', because the whole job started in an idle callback. No fake
// timers: tasks are pumped by hand.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import {
  __resetBootCompileChainForTests,
  isRendererCompileTimedOut,
} from './boot-core-compile';
import {
  DEFERRED_WARM_COMPILE_TIMEOUT_MS,
  createDeferredWarmQueue,
  warmDeferredObject,
  type DeferredWarmRenderer,
} from './deferred-warm';

type Priority = 'background' | 'user-visible' | 'user-blocking';
type FakeTask = {
  kind: 'idle' | 'postTask' | 'yield';
  priority: Priority;
  run: () => void;
};

function createFakeEventLoop() {
  const tasks: FakeTask[] = [];
  let current: Priority | null = null;
  // The signal of the postTask callback running right now (spec: a yield()
  // called inside the task inherits it).
  let currentSignal: AbortSignal | undefined;
  let idleHandle = 0;
  const cancelledIdle = new Set<number>();
  const postTaskPriorities: string[] = [];

  const window = {
    requestIdleCallback: (cb: (deadline: IdleDeadline) => void) => {
      idleHandle += 1;
      const handle = idleHandle;
      tasks.push({
        kind: 'idle',
        priority: 'background',
        run: () => {
          if (cancelledIdle.has(handle)) return;
          // Saturated main thread: every idle callback fires by its timeout.
          cb({ didTimeout: true, timeRemaining: () => 0 } as IdleDeadline);
        },
      });
      return handle;
    },
    cancelIdleCallback: (handle: number) => {
      cancelledIdle.add(handle);
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };

  // Every posted task's signal, so tests can assert an abort.
  const postTaskSignals: Array<AbortSignal | undefined> = [];
  const scheduler = {
    postTask: (
      callback: () => unknown,
      options?: { priority?: Priority; signal?: AbortSignal },
    ) => {
      const priority = options?.priority ?? 'user-visible';
      const signal = options?.signal;
      postTaskPriorities.push(priority);
      postTaskSignals.push(signal);
      return new Promise<unknown>((resolve, reject) => {
        const task: FakeTask = {
          kind: 'postTask',
          priority,
          run: () => {
            currentSignal = signal;
            try {
              resolve(callback());
            } catch (error) {
              reject(error);
            } finally {
              currentSignal = undefined;
            }
          },
        };
        // Spec behaviour: an aborted task leaves the queue and its promise
        // rejects with an AbortError.
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            const index = tasks.indexOf(task);
            if (index >= 0) tasks.splice(index, 1);
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
        tasks.push(task);
      });
    },
  };

  /** A scheduler.yield() continuation that inherited `signal`: aborting the
   * signal rejects the pending yield with an AbortError (spec behaviour). */
  const yieldWith = (signal: AbortSignal | undefined) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      const task: FakeTask = { kind: 'yield', priority: 'user-visible', run: () => resolve() };
      signal?.addEventListener(
        'abort',
        () => {
          const index = tasks.indexOf(task);
          if (index >= 0) tasks.splice(index, 1);
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
      tasks.push(task);
    });

  const drainMicrotasks = async () => {
    for (let i = 0; i < 60; i += 1) await Promise.resolve();
  };

  /** Runs ONE task and its microtask checkpoint under the task priority. */
  const runOne = async (): Promise<FakeTask | undefined> => {
    const task = tasks.shift();
    if (!task) return undefined;
    current = task.priority;
    task.run();
    await drainMicrotasks();
    current = null;
    return task;
  };

  const runUntil = async (done: () => boolean, maxTasks = 50) => {
    for (let i = 0; i < maxTasks && !done(); i += 1) {
      if (!(await runOne())) await drainMicrotasks();
    }
  };

  return {
    window,
    scheduler,
    tasks,
    postTaskPriorities,
    postTaskSignals,
    currentPriority: () => current,
    currentSignal: () => currentSignal,
    yieldWith,
    runOne,
    runUntil,
  };
}

function makeTexturedObject() {
  const object = new THREE.Group();
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  object.add(mesh);
  object.visible = false;
  const scene = new THREE.Scene();
  scene.add(object);
  const dispose = () => {
    mesh.geometry.dispose();
    material.dispose();
    texture.dispose();
  };
  return { object, scene, dispose };
}

const g = globalThis as Record<string, unknown>;
let savedWindow: unknown;
let savedScheduler: unknown;
let savedSetTimeout: typeof globalThis.setTimeout;

beforeEach(() => {
  savedWindow = g.window;
  savedScheduler = g.scheduler;
  savedSetTimeout = globalThis.setTimeout;
  __resetBootCompileChainForTests();
});

afterEach(() => {
  if (savedWindow === undefined) delete g.window;
  else g.window = savedWindow;
  if (savedScheduler === undefined) delete g.scheduler;
  else g.scheduler = savedScheduler;
  globalThis.setTimeout = savedSetTimeout;
  __resetBootCompileChainForTests();
});

describe('deferred warm task priority (web-load T6)', () => {
  test('compileAsync starts in a user-visible task, never inside an idle-callback task', async () => {
    const loop = createFakeEventLoop();
    g.window = loop.window;
    g.scheduler = loop.scheduler;

    const camera = new THREE.PerspectiveCamera();
    const { object, scene, dispose } = makeTexturedObject();
    const compilePriorities: Array<Priority | null> = [];
    let releaseCompile: (() => void) | undefined;
    const renderer: DeferredWarmRenderer = {
      initialized: true,
      initTexture: () => {},
      compileAsync: async () => {
        compilePriorities.push(loop.currentPriority());
        await new Promise<void>((resolve) => {
          releaseCompile = resolve;
        });
      },
      render: () => {},
    };

    // The real chain: the queue starts the job from an idle callback, the
    // job's texture upload resolves inside another idle callback.
    const queue = createDeferredWarmQueue();
    let result: string | undefined;
    queue.enqueue({
      warm: async (isCancelled) => {
        result = await warmDeferredObject({
          renderer,
          scene,
          camera,
          object,
          isCancelled,
          label: 'npc:town-guide',
        });
      },
    });

    await loop.runUntil(() => compilePriorities.length > 0);

    expect(compilePriorities).toEqual(['user-visible']);
    expect(loop.postTaskPriorities).toContain('user-visible');
    // The compile capture saw the hidden root as renderable, then restored it.
    expect(object.visible).toBe(false);

    releaseCompile?.();
    await loop.runUntil(() => result !== undefined);
    expect(result).toBe('warmed');
    expect(isRendererCompileTimedOut(renderer)).toBe(false);
    dispose();
  });

  test('one job at a time; the next job starts in a user-visible task, not a new idle callback', async () => {
    const loop = createFakeEventLoop();
    g.window = loop.window;
    g.scheduler = loop.scheduler;

    const queue = createDeferredWarmQueue();
    let active = 0;
    let maxActive = 0;
    const startedIn: Array<FakeTask['kind'] | null> = [];
    const releases: Array<() => void> = [];
    let lastKind: FakeTask['kind'] | null = null;
    const finished: string[] = [];

    const add = (name: string) =>
      queue.enqueue({
        warm: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          startedIn.push(lastKind);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          finished.push(name);
        },
      });
    add('nori');
    add('cron-automation');
    add('app-publishing');

    const pump = async () => {
      const task = loop.tasks[0];
      lastKind = task?.kind ?? null;
      await loop.runOne();
    };

    await pump(); // first job: idle-callback start (queue was idle)
    expect(startedIn).toEqual(['idle']);
    expect(active).toBe(1);
    expect(loop.tasks).toHaveLength(0); // nothing else scheduled while active

    for (let i = 1; i < 3; i += 1) {
      releases[i - 1]!();
      for (let j = 0; j < 60; j += 1) await Promise.resolve();
      expect(loop.tasks.map((t) => `${t.kind}:${t.priority}`)).toEqual([
        'postTask:user-visible',
      ]);
      await pump();
    }
    releases[2]!();
    for (let j = 0; j < 60; j += 1) await Promise.resolve();

    expect(startedIn).toEqual(['idle', 'postTask', 'postTask']);
    expect(maxActive).toBe(1);
    expect(finished).toEqual(['nori', 'cron-automation', 'app-publishing']);
    expect(loop.tasks).toHaveLength(0);
  });


  // Shared fixture for the 20 s escape tests: captures the compile escape
  // timer (fired by hand), returns a renderer whose compileAsync behaviour
  // the test chooses.
  function setupEscapeFixture(loop: ReturnType<typeof createFakeEventLoop>) {
    g.window = loop.window;
    g.scheduler = loop.scheduler;
    const escapes: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      if (ms === DEFERRED_WARM_COMPILE_TIMEOUT_MS) {
        escapes.push(handler);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, ms);
    }) as typeof globalThis.setTimeout;

    const camera = new THREE.PerspectiveCamera();
    const scene = new THREE.Scene();
    const makeObject = () => {
      const object = new THREE.Group();
      object.visible = false;
      scene.add(object);
      return object;
    };
    const compiled: THREE.Object3D[] = [];
    let hang = false;
    const renders: string[] = [];
    const renderer: DeferredWarmRenderer = {
      initialized: true,
      initTexture: () => {},
      compileAsync: (root) => {
        compiled.push(root);
        return hang ? new Promise<void>(() => {}) : Promise.resolve();
      },
      render: () => {
        renders.push('render');
      },
      getScissor: (target) => target.set(0, 0, 1, 1),
      getScissorTest: () => false,
      setScissor: () => {},
      setScissorTest: () => {},
    };
    return {
      escapes,
      camera,
      scene,
      makeObject,
      compiled,
      renders,
      renderer,
      setHang: (value: boolean) => {
        hang = value;
      },
    };
  }

  test('escape BEFORE the compile task ran: renderer NOT poisoned, the late task does not compile, the next job compiles', async () => {
    const loop = createFakeEventLoop();
    const fx = setupEscapeFixture(loop);

    const first = fx.makeObject();
    const warming = warmDeferredObject({
      renderer: fx.renderer,
      scene: fx.scene,
      camera: fx.camera,
      object: first,
      isCancelled: () => false,
      label: 'npc:town-guide',
    });
    for (let j = 0; j < 60; j += 1) await Promise.resolve();
    expect(loop.tasks.map((t) => t.kind)).toEqual(['postTask']);
    expect(fx.escapes).toHaveLength(1);

    fx.escapes[0]!();
    expect(await warming).toBe('failopen');
    // No compile ran, so the renderer must stay usable.
    expect(isRendererCompileTimedOut(fx.renderer)).toBe(false);
    expect(fx.compiled).toHaveLength(0);
    // This job still fails open through the zero-scissor direct warm.
    expect(fx.renders).toEqual(['render']);

    // The NEXT job compiles normally (the original symptom: it did not).
    const second = fx.makeObject();
    const next = warmDeferredObject({
      renderer: fx.renderer,
      scene: fx.scene,
      camera: fx.camera,
      object: second,
      isCancelled: () => false,
      label: 'building:cove',
    });
    await loop.runUntil(() => fx.compiled.length > 0);
    expect(await next).toBe('warmed');
    // The first job's late task ran first and did NOT compile `first`.
    expect(fx.compiled).toEqual([second]);
    expect(loop.tasks).toHaveLength(0);
    // No AbortSignal is ever handed to postTask (it would become the
    // signal three's yields inherit).
    expect(loop.postTaskSignals.every((signal) => signal === undefined)).toBe(true);
  });

  test('escape AFTER the compile started still poisons the renderer (orphan tail)', async () => {
    const loop = createFakeEventLoop();
    const fx = setupEscapeFixture(loop);
    fx.setHang(true);

    const warming = warmDeferredObject({
      renderer: fx.renderer,
      scene: fx.scene,
      camera: fx.camera,
      object: fx.makeObject(),
      isCancelled: () => false,
      label: 'npc:town-guide',
    });
    await loop.runUntil(() => fx.compiled.length > 0);
    expect(fx.compiled).toHaveLength(1);

    fx.escapes[0]!();
    expect(await warming).toBe('failopen');
    expect(isRendererCompileTimedOut(fx.renderer)).toBe(true);

    // A later job skips compile on the poisoned renderer.
    fx.setHang(false);
    const later = await warmDeferredObject({
      renderer: fx.renderer,
      scene: fx.scene,
      camera: fx.camera,
      object: fx.makeObject(),
      isCancelled: () => false,
      label: 'building:cove',
    });
    expect(later).toBe('failopen');
    expect(fx.compiled).toHaveLength(1);
  });

  test('cancelling the job BEFORE its compile task runs: the task does not compile and holds no abortable signal', async () => {
    const loop = createFakeEventLoop();
    const fx = setupEscapeFixture(loop);

    const queue = createDeferredWarmQueue();
    let result: string | undefined;
    const cancel = queue.enqueue({
      warm: async (isCancelled) => {
        result = await warmDeferredObject({
          renderer: fx.renderer,
          scene: fx.scene,
          camera: fx.camera,
          object: fx.makeObject(),
          isCancelled,
          label: 'building:mcp-tool-use',
        });
      },
    });

    // Run the queue's idle start; the job then posts its compile task.
    await loop.runUntil(() => loop.tasks.some((t) => t.kind === 'postTask'));
    expect(loop.postTaskSignals).toEqual([undefined]);

    cancel();
    await loop.runUntil(() => result !== undefined);
    expect(result).toBe('failopen');
    expect(fx.compiled).toHaveLength(0);
    expect(fx.renders).toHaveLength(0); // cancelled: no recovery render
    expect(isRendererCompileTimedOut(fx.renderer)).toBe(false);
  });

  test('cancelling the job DURING its compile lets the compile finish; the next job waits for it', async () => {
    const loop = createFakeEventLoop();
    g.window = loop.window;
    g.scheduler = loop.scheduler;

    const camera = new THREE.PerspectiveCamera();
    const scene = new THREE.Scene();
    const makeObject = (name: string) => {
      const object = new THREE.Group();
      object.name = name;
      object.visible = false;
      scene.add(object);
      return object;
    };
    // compileAsync modelled on three r185: yields (scheduler.yield, which
    // inherits the running postTask's signal) between pipeline stages.
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const log: string[] = [];
    const renderer: DeferredWarmRenderer = {
      initialized: true,
      initTexture: () => {},
      compileAsync: async (root) => {
        const inherited = loop.currentSignal();
        log.push(`start:${root.name}`);
        try {
          await loop.yieldWith(inherited);
          if (root.name === 'nori') await gate;
          await loop.yieldWith(inherited);
          log.push(`end:${root.name}`);
        } catch (error) {
          log.push(`rejected:${root.name}:${(error as Error).name}`);
          throw error;
        }
      },
      render: () => {
        log.push('render');
      },
      getScissor: (target) => target.set(0, 0, 1, 1),
      getScissorTest: () => false,
      setScissor: () => {},
      setScissorTest: () => {},
    };

    const queue = createDeferredWarmQueue();
    const results: string[] = [];
    const add = (name: string) =>
      queue.enqueue({
        warm: async (isCancelled) => {
          results.push(
            `${name}:${await warmDeferredObject({
              renderer,
              scene,
              camera,
              object: makeObject(name),
              isCancelled,
              label: name,
            })}`,
          );
        },
      });
    const cancelNori = add('nori');
    add('cove');

    await loop.runUntil(() => log.includes('start:nori'));
    // Cancel while the compile is mid-flight with a yield pending.
    expect(loop.tasks.map((t) => t.kind)).toEqual(['yield']);
    cancelNori();
    // Pump everything that is runnable while the compile waits on the gate.
    for (let i = 0; i < 10; i += 1) await loop.runOne();

    // Not aborted, and the next job has NOT started its compile.
    expect(log).toEqual(['start:nori']);

    releaseGate!();
    await loop.runUntil(() => log.includes('end:cove'));

    expect(log).toEqual(['start:nori', 'end:nori', 'start:cove', 'end:cove']);
    expect(log.some((entry) => entry.startsWith('rejected'))).toBe(false);
    expect(results).toEqual(['nori:warmed', 'cove:warmed']);
    expect(isRendererCompileTimedOut(renderer)).toBe(false);
  });
});
