import { describe, expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import {
  createDeferredWarmQueue,
  warmDeferredObject,
  type DeferredWarmRenderer,
  type DeferredWarmQueueSchedule,
  type DeferredWarmState,
} from './deferred-warm';

function createManualScheduler() {
  const callbacks: Array<{ active: boolean; run: () => void }> = [];
  const schedule: DeferredWarmQueueSchedule = (run) => {
    const entry = { active: true, run };
    callbacks.push(entry);
    return () => {
      entry.active = false;
    };
  };
  const flushOne = () => {
    let entry = callbacks.shift();
    while (entry && !entry.active) entry = callbacks.shift();
    entry?.run();
  };
  const pending = () => callbacks.filter((entry) => entry.active).length;
  return { schedule, flushOne, pending };
}

async function flushPromiseChain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('deferred warm queue', () => {
  test('drains ascending priority and preserves FIFO ties', async () => {
    const scheduler = createManualScheduler();
    const queue = createDeferredWarmQueue(scheduler.schedule);
    const fired: string[] = [];
    const add = (name: string, priority: number) => {
      queue.enqueue({
        priority,
        warm: async () => {
          fired.push(name);
        },
      });
    };

    add('far', 9000);
    add('bulk', Number.POSITIVE_INFINITY);
    add('near', 100);
    add('near2', 100);
    for (let i = 0; i < 4; i += 1) {
      scheduler.flushOne();
      await flushPromiseChain();
    }

    expect(fired).toEqual(['near', 'near2', 'far', 'bulk']);
  });

  test('never overlaps active warm functions', async () => {
    const scheduler = createManualScheduler();
    const queue = createDeferredWarmQueue(scheduler.schedule);
    let active = 0;
    let maxActive = 0;
    let releaseFirst: (() => void) | undefined;

    queue.enqueue({
      warm: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        active -= 1;
      },
    });
    queue.enqueue({
      warm: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
      },
    });

    scheduler.flushOne();
    await flushPromiseChain();
    expect(active).toBe(1);
    expect(scheduler.pending()).toBe(0);

    releaseFirst?.();
    await flushPromiseChain();
    expect(scheduler.pending()).toBe(1);
    scheduler.flushOne();
    await flushPromiseChain();

    expect(maxActive).toBe(1);
    expect(active).toBe(0);
  });

  test('state machine fails open when an injected warm rejects', async () => {
    const scheduler = createManualScheduler();
    const queue = createDeferredWarmQueue(scheduler.schedule);
    const states: DeferredWarmState[] = [];
    const errors: unknown[] = [];

    queue.enqueue({
      warm: async () => {
        throw new Error('fake compile rejection');
      },
      onStateChange: (state) => states.push(state),
      onError: (error) => errors.push(error),
    });
    expect(states).toEqual(['queued']);

    scheduler.flushOne();
    await flushPromiseChain();

    expect(states).toEqual(['queued', 'warming', 'ready']);
    expect(errors).toHaveLength(1);
  });

  test('queued cancellation removes a job before its warm starts', async () => {
    const scheduler = createManualScheduler();
    const queue = createDeferredWarmQueue(scheduler.schedule);
    const states: DeferredWarmState[] = [];
    let calls = 0;
    const cancel = queue.enqueue({
      warm: async () => {
        calls += 1;
      },
      onStateChange: (state) => states.push(state),
    });

    cancel();
    scheduler.flushOne();
    await flushPromiseChain();

    expect(states).toEqual(['queued', 'cancelled']);
    expect(calls).toBe(0);
  });

  test('active cancellation is visible to the injected warm function', async () => {
    const scheduler = createManualScheduler();
    const queue = createDeferredWarmQueue(scheduler.schedule);
    const states: DeferredWarmState[] = [];
    let readCancelled: (() => boolean) | undefined;
    let releaseWarm: (() => void) | undefined;
    const cancel = queue.enqueue({
      warm: async (isCancelled) => {
        readCancelled = isCancelled;
        await new Promise<void>((resolve) => {
          releaseWarm = resolve;
        });
      },
      onStateChange: (state) => states.push(state),
    });

    scheduler.flushOne();
    await flushPromiseChain();
    cancel();
    expect(readCancelled?.()).toBe(true);
    releaseWarm?.();
    await flushPromiseChain();

    expect(states).toEqual(['queued', 'warming', 'cancelled']);
  });
});

describe('deferred object warm state', () => {
  test('captures hidden content for compile and restores it before attach', async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const object = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial(),
    );
    object.visible = false;
    object.add(mesh);
    scene.add(object);
    let releaseCompile: (() => void) | undefined;
    const observed: string[] = [];
    const renderer: DeferredWarmRenderer = {
      initialized: true,
      initTexture: () => {},
      compileAsync: async (root) => {
        observed.push(`compile:${root.visible}:${mesh.frustumCulled}`);
        await new Promise<void>((resolve) => {
          releaseCompile = resolve;
        });
      },
      render: () => {
        observed.push(`render:${object.visible}:${mesh.frustumCulled}`);
      },
      getScissor: (target) => target.set(4, 5, 6, 7),
      getScissorTest: () => false,
      setScissor: (x, y, width, height) => {
        observed.push(`scissor:${x}:${y}:${width}:${height}`);
      },
      setScissorTest: (enabled) => {
        observed.push(`scissor-test:${enabled}`);
      },
    };

    const warming = warmDeferredObject({
      renderer,
      scene,
      camera,
      object,
      isCancelled: () => false,
      label: 'fake-object',
    });
    await flushPromiseChain();

    expect(observed).toContain('compile:true:false');
    expect(object.visible).toBe(false);
    expect(mesh.frustumCulled).toBe(false);

    releaseCompile?.();
    await warming;

    // Successful compileAsync SKIPS the zero-scissor direct warm entirely —
    // an extra renderer.render() during live presentation is the WebGPU
    // one-frame clear-clobber mechanism (blue-flash class); after compile the
    // pipelines are already built.
    expect(observed).not.toContain('scissor:0:0:0:0');
    expect(observed.filter((entry) => entry.startsWith('render:'))).toEqual([]);
    expect(object.visible).toBe(false);
    expect(mesh.frustumCulled).toBe(true);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });

  test('direct warm runs as the FALLBACK when compileAsync is unavailable', async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const object = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
    );
    object.add(mesh);
    object.visible = false;
    const observed: string[] = [];
    const renderer = {
      // no compileAsync at all → fallback path
      render: () => {
        observed.push(`render:${object.visible}:${mesh.frustumCulled}`);
      },
      getScissor: (target: THREE.Vector4) => target.set(4, 5, 6, 7),
      getScissorTest: () => false,
      setScissor: (x: number, y: number, w: number, h: number) => {
        observed.push(`scissor:${x}:${y}:${w}:${h}`);
      },
      setScissorTest: (enabled: boolean) => {
        observed.push(`scissor-test:${enabled}`);
      },
    };
    await warmDeferredObject({
      renderer,
      scene,
      camera,
      object,
      isCancelled: () => false,
      label: 'fallback-object',
    });
    expect(observed).toContain('scissor:0:0:0:0');
    expect(observed).toContain('render:true:false');
    expect(observed).toContain('scissor:4:5:6:7');
    expect(object.visible).toBe(false);
    expect(mesh.frustumCulled).toBe(true);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });
});
