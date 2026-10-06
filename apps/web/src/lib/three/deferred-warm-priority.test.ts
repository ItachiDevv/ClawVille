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
type FakeTask = { kind: 'idle' | 'postTask'; priority: Priority; run: () => void };

function createFakeEventLoop() {
  const tasks: FakeTask[] = [];
  let current: Priority | null = null;
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

  const scheduler = {
    postTask: (callback: () => unknown, options?: { priority?: Priority }) => {
      const priority = options?.priority ?? 'user-visible';
      postTaskPriorities.push(priority);
      return new Promise<unknown>((resolve, reject) => {
        tasks.push({
          kind: 'postTask',
          priority,
          run: () => {
            try {
              resolve(callback());
            } catch (error) {
              reject(error);
            }
          },
        });
      });
    },
  };

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
    currentPriority: () => current,
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

  test('a compile front that has not started when the 20 s escape fires never starts later', async () => {
    const loop = createFakeEventLoop();
    g.window = loop.window;
    g.scheduler = loop.scheduler;

    // Capture only the compile escape timer; it is fired by hand.
    let fireEscape: (() => void) | undefined;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      if (ms === DEFERRED_WARM_COMPILE_TIMEOUT_MS) {
        fireEscape = handler;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, ms);
    }) as typeof globalThis.setTimeout;

    const camera = new THREE.PerspectiveCamera();
    const object = new THREE.Group();
    object.visible = false;
    const scene = new THREE.Scene();
    scene.add(object);
    let compileCalls = 0;
    const renderer: DeferredWarmRenderer = {
      initialized: true,
      initTexture: () => {},
      compileAsync: async () => {
        compileCalls += 1;
      },
      render: () => {},
      getScissor: (target) => target.set(0, 0, 1, 1),
      getScissorTest: () => false,
      setScissor: () => {},
      setScissorTest: () => {},
    };

    const warming = warmDeferredObject({
      renderer,
      scene,
      camera,
      object,
      isCancelled: () => false,
      label: 'building:cove',
    });
    for (let j = 0; j < 60; j += 1) await Promise.resolve();
    expect(loop.tasks.map((t) => t.kind)).toEqual(['postTask']);
    expect(fireEscape).toBeDefined();

    fireEscape!();
    expect(await warming).toBe('failopen');
    expect(isRendererCompileTimedOut(renderer)).toBe(true);

    await loop.runOne(); // the late front
    expect(compileCalls).toBe(0);
  });
});
