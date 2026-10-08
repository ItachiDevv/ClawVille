/**
 * Building residents (perf root `location-npcs`) commit WITHOUT a Suspense
 * retry (web-load T10-B).
 *
 * Why: T9 probe run N6 (local prod build, CPU 4x): the residents had 2
 * meshes at 114 s against 72 unthrottled. LocationNpc mounted NpcMesh right
 * after its stagger release, NpcMesh's useGLTF suspended, and the resident
 * could commit only in a Suspense RETRY lane. Retry lanes never expire in
 * react-reconciler 0.31 and the ~6/s SyncLane renders of the R3F root
 * discard their work (gotchas/suspense-retry-lane-starvation-sync-store-
 * updates.md). The fix applies the T7 pattern: after the release, LocationNpc
 * resolves the primary and companion GLB cache entries OUTSIDE React
 * (warmSuspenseRead + readLocationNpcModel, the same drei call as NpcMesh's
 * render read) and mounts NpcMesh only after, so its first render reads
 * resolved entries and never suspends.
 *
 * Mounts the REAL ArenaLocationNpcs (real LocationNpc, NpcMesh, scale
 * normalisation, SkeletonUtils clone) in a real R3F root (fake renderer,
 * frameloop 'never'). drei's useGLTF is wrapped by a recorder (path, draco,
 * meshopt, extender, warm-or-render, suspended) that emulates the
 * suspend-react cache by path: the first read throws a thenable, later reads
 * return the cached GLTF, a failed path rethrows R3F's ONE cached Error.
 * Stand-ins: decorative release (released), DeferredWarmAttachment
 * (pass-through), the device profile's resident stream radius (infinite, so
 * every resident is in range of the default camera).
 *
 * Asserts:
 *   (a) 0 render reads suspended (base: >= 1 per resident model);
 *   (b) for every resident model + companion in LOCATION_NPCS: a warm read
 *       outside render ran before the first render read, with the SAME path
 *       (drei key [GLTFLoader, path]), draco, meshopt and extender;
 *   (c) an unmount during the warm: no render read and no mount afterwards,
 *       no error;
 *   plus StrictMode, and a failed model: the warm resolves, the render
 *   throws a tagged ModelLoadError into that resident's ModelLoadBoundary,
 *   only that resident is skipped (one console.error, the cache entry
 *   cleared), its siblings render, and a canvas remount or a stream-out +
 *   stream-in warm-reads and loads it again (never a suspended render read).
 * Runs in its own process (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Component, Fragment, StrictMode, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type * as THREE from 'three';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'HTMLDivElement', 'Event', 'ErrorEvent', 'requestAnimationFrame', 'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const threeCjs = require('three') as typeof import('three');

// ---------------------------------------------------------------------------
// drei useGLTF recorder (suspend-react cache emulated by path)
// ---------------------------------------------------------------------------

type Read = {
  seq: number;
  path: string;
  draco: unknown;
  meshopt: unknown;
  extender: unknown;
  /** false = the read ran inside warmSuspenseRead (outside React). */
  inRender: boolean;
  /** The read threw a thenable (it suspended). */
  suspended: boolean;
  /** The read threw this Error (a cached load failure). */
  error: unknown;
};
let seq = 0;
const reads: Read[] = [];

type FakeGltf = { scene: InstanceType<typeof threeCjs.Group>; animations: unknown[] };
const cache = new Map<string, FakeGltf>();
const failed = new Map<string, Error>();
const loading = new Map<string, Promise<void>>();
const failingPaths = new Set<string>();
const loadStarts = new Map<string, number>();
/** Paths evicted through useGLTF.clear (ModelLoadError.clear()). */
const clears: string[] = [];
function clearPath(input: string | string[]): void {
  for (const p of typeof input === 'string' ? [input] : input) {
    clears.push(p);
    failed.delete(p);
    loading.delete(p);
    cache.delete(p);
  }
}
/** While set, every pending load waits for it (to unmount mid-warm). */
let loadGate: Promise<void> | null = null;

function cannedGltf(path: string): FakeGltf {
  let gltf = cache.get(path);
  if (!gltf) {
    const scene = new threeCjs.Group();
    scene.name = `fake-gltf:${path}`;
    scene.add(new threeCjs.Mesh(new threeCjs.BoxGeometry(1, 2, 1), new threeCjs.MeshStandardMaterial()));
    gltf = { scene, animations: [] };
    cache.set(path, gltf);
  }
  return gltf;
}

function recordingUseGLTF(path: string, draco?: unknown, meshopt?: unknown, extender?: unknown) {
  const read: Read = {
    seq: (seq += 1),
    path,
    draco,
    meshopt,
    extender,
    inRender: !(new Error().stack ?? '').includes('warmSuspenseRead'),
    suspended: false,
    error: undefined,
  };
  reads.push(read);
  const failure = failed.get(path);
  if (failure) {
    read.error = failure;
    throw failure; // R3F rethrows the SAME cached Error on every read.
  }
  const hit = cache.get(path);
  if (hit) return hit;
  let pending = loading.get(path);
  if (!pending) {
    const gate = loadGate;
    pending = new Promise<void>((resolve) => setTimeout(resolve, 3))
      .then(() => gate ?? undefined)
      .then(() => {
        if (failingPaths.has(path)) failed.set(path, new Error(`Could not load ${path}: 404 test`));
        else cannedGltf(path);
      });
    loading.set(path, pending);
    loadStarts.set(path, (loadStarts.get(path) ?? 0) + 1);
  }
  read.suspended = true;
  throw pending;
}

function resetCache(): void {
  reads.length = 0;
  cache.clear();
  failed.clear();
  loading.clear();
  failingPaths.clear();
  loadStarts.clear();
  clears.length = 0;
  loadGate = null;
  reported.length = 0;
  consoleErrors.length = 0;
}

mock.module('./deferred-warm-attachment', () => ({
  DeferredWarmAttachment: ({ children }: { children: ReactNode | ((ready: boolean) => ReactNode) }) =>
    createElement(Fragment, null, typeof children === 'function' ? children(true) : children),
}));

/** R3F 9 reports boundary-CAUGHT render errors through `reportError`
 * (captured at module load); installed before the R3F import, records. */
const reported: unknown[] = [];
const reportErrorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'reportError');
const consoleErrors: string[] = [];
const originalConsoleError = console.error;

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let ArenaLocationNpcs: () => ReactNode;
let LOCATION_NPCS: typeof import('./arena-location-npcs').LOCATION_NPCS;
let zoneIds: string[];

beforeAll(async () => {
  for (const name of globalNames) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value =
      name === 'IS_REACT_ACT_ENVIRONMENT'
        ? true
        : name === 'window'
          ? testWindow
          : name === 'requestAnimationFrame'
            ? (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number
            : name === 'cancelAnimationFrame'
              ? (id: number) => clearTimeout(id)
              : (testWindow as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'reportError', {
    value: (error: unknown) => {
      reported.push(error);
    },
    configurable: true,
    writable: true,
  });
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };

  const realRelease = await import('./decorative-release');
  mock.module('./decorative-release', () => ({
    ...realRelease,
    isDecorativeReleased: () => true,
    onDecorativeReleaseStaggered: (callback: () => void) => {
      callback();
      return () => undefined;
    },
  }));
  const realDevice = await import('./device-class');
  const profile = {
    ...realDevice.CURRENT_WORLD_DEVICE_PROFILE,
    // 1,000,000 wu in / 1,100,000 wu out: every resident is in range of the
    // default camera; moving the camera 10,000,000 wu away streams them out.
    residentMountDistSq: 1e12,
    residentUnmountDistSq: 1.21e12,
  };
  mock.module('./device-class', () => ({ ...realDevice, CURRENT_WORLD_DEVICE_PROFILE: profile }));
  const realDrei = await import('@react-three/drei');
  mock.module('@react-three/drei', () => ({
    ...realDrei,
    useGLTF: Object.assign(recordingUseGLTF, {
      preload: () => undefined,
      clear: clearPath,
      setDecoderPath: () => undefined,
    }),
  }));

  r3f = await import('@react-three/fiber');
  r3f.extend(threeCjs as never);
  const mod = await import('./arena-location-npcs');
  ArenaLocationNpcs = mod.default as unknown as () => ReactNode;
  LOCATION_NPCS = mod.LOCATION_NPCS;
  const { buildingZones } = await import('@/lib/pixi/tilemap-data');
  zoneIds = buildingZones.map((z) => z.id).filter((id) => LOCATION_NPCS[id] !== undefined);
});

afterAll(async () => {
  console.error = originalConsoleError;
  if (reportErrorDescriptor) Object.defineProperty(globalThis, 'reportError', reportErrorDescriptor);
  else delete (globalThis as Record<string, unknown>).reportError;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await testWindow.happyDOM.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRenderer(canvas: unknown) {
  return {
    domElement: canvas,
    shadowMap: { enabled: false, type: 0, needsUpdate: false },
    outputColorSpace: '',
    toneMapping: 0,
    render() {},
    setSize() {},
    setPixelRatio() {},
    getPixelRatio: () => 1,
    dispose() {},
  };
}

async function settle(ms: number): Promise<void> {
  await r3f.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(ready: () => boolean, what: string, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await settle(5);
  }
}

async function mount(element: ReactNode) {
  const canvas = testWindow.document.createElement('canvas');
  testWindow.document.body.appendChild(canvas);
  const root = r3f.createRoot(canvas as unknown as HTMLCanvasElement);
  await root.configure({
    gl: fakeRenderer(canvas) as never,
    size: { width: 320, height: 200, top: 0, left: 0 },
    frameloop: 'never',
  });
  let store!: ReturnType<typeof root.render>;
  await r3f.act(async () => {
    store = root.render(element);
  });
  const committed = (path: string) =>
    store.getState().scene.getObjectByName(`fake-gltf:${path}`) as THREE.Object3D | undefined;
  return { root, store, committed };
}

/** Every (zone, model) the registry renders: the primary and its companion. */
function residentModels(): { zoneId: string; model: string }[] {
  const out: { zoneId: string; model: string }[] = [];
  for (const zoneId of zoneIds) {
    const cfg = LOCATION_NPCS[zoneId]!;
    out.push({ zoneId, model: cfg.model });
    if (cfg.companion) out.push({ zoneId, model: cfg.companion.model });
  }
  return out;
}

/** Catches what ArenaLocationNpcs throws (stands in for the outer boundary). */
class OuterBoundary extends Component<{ children?: ReactNode; onError: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('building residents commit without a Suspense retry (web-load T10-B)', () => {
  test('every LOCATION_NPCS slot renders (all 10 zones exist in buildingZones)', () => {
    expect(Object.keys(LOCATION_NPCS).sort()).toEqual([...zoneIds].sort());
    expect(zoneIds.length).toBe(10);
  });

  test(
    '(a)+(b) every resident + companion: warm read first with the render read\'s exact args; 0 suspended render reads',
    async () => {
      resetCache();
      const { root, committed } = await mount(createElement(ArenaLocationNpcs));
      const models = residentModels();
      expect(models.length).toBe(12); // 10 residents + Gary + Karen
      await waitFor(() => models.every((m) => committed(m.model) !== undefined), 'every resident committed');

      // (a) the release render never suspended.
      const suspendedRenders = reads.filter((r) => r.inRender && r.suspended);
      expect(suspendedRenders.map((r) => r.path)).toEqual([]);

      // (b) parity: same drei cache key (path) and the same loader options.
      const problems: string[] = [];
      for (const { model } of models) {
        const forPath = reads.filter((r) => r.path === model);
        const firstRender = forPath.findIndex((r) => r.inRender);
        if (firstRender === -1) {
          problems.push(`${model}: never read by a render`);
          continue;
        }
        if (forPath.slice(0, firstRender).every((r) => r.inRender)) {
          problems.push(`${model}: no warm read outside render before the first render read`);
        }
        const options = new Set(forPath.map((r) => `${String(r.draco)}|${String(r.meshopt)}`));
        const extenders = new Set(forPath.map((r) => r.extender));
        if (options.size !== 1) problems.push(`${model}: loader flags differ ${[...options].join(' vs ')}`);
        if (extenders.size !== 1) problems.push(`${model}: ${extenders.size} different loader extenders`);
        if (typeof [...extenders][0] !== 'function') problems.push(`${model}: no loader extender`);
      }
      // No warm read for a path no resident renders.
      const known = new Set(models.map((m) => m.model));
      for (const r of reads) if (!known.has(r.path)) problems.push(`${r.path}: read but not a resident model`);
      expect(problems).toEqual([]);
      // One extender for the whole registry (the module constant).
      expect(new Set(reads.map((r) => r.extender)).size).toBe(1);
      expect(consoleErrors).toEqual([]);
      expect(reported).toEqual([]);
      await r3f.act(async () => root.unmount());
    },
    30_000,
  );

  test('StrictMode (effect setup/cleanup/setup): every resident commits, 0 suspended render reads', async () => {
    resetCache();
    const { root, committed } = await mount(createElement(StrictMode, null, createElement(ArenaLocationNpcs)));
    const models = residentModels();
    await waitFor(() => models.every((m) => committed(m.model) !== undefined), 'every StrictMode resident committed');
    expect(reads.filter((r) => r.inRender && r.suspended)).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(reported).toEqual([]);
    await r3f.act(async () => root.unmount());
  }, 30_000);

  test('(c) an unmount during the warm: no render read, no mount, no error afterwards', async () => {
    resetCache();
    let openGate: () => void = () => undefined;
    loadGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const models = residentModels();
    const { root, committed } = await mount(createElement(ArenaLocationNpcs));
    await waitFor(
      () => models.every((m) => reads.some((r) => r.path === m.model && !r.inRender)),
      'every resident model warm read started',
      3_000,
    );
    expect(reads.filter((r) => r.inRender)).toEqual([]);

    // The residents unmount while every load is held open.
    await r3f.act(async () => {
      root.render(null);
    });
    const readsAtUnmount = reads.length;
    openGate();
    loadGate = null;
    await settle(60);
    expect(reads.slice(readsAtUnmount).filter((r) => r.inRender)).toEqual([]);
    for (const { model } of models) expect(committed(model)).toBeUndefined();
    expect(consoleErrors).toEqual([]);
    expect(reported).toEqual([]);
    await r3f.act(async () => root.unmount());
  }, 20_000);

  test('a failed resident GLB: only that resident is skipped (one console.error), its siblings render', async () => {
    resetCache();
    const failing = LOCATION_NPCS['deployment-ops']!.model;
    failingPaths.add(failing);
    const caught: unknown[] = [];
    const models = residentModels();
    const { root, committed } = await mount(
      createElement(OuterBoundary, { onError: (e: unknown) => caught.push(e) }, createElement(ArenaLocationNpcs)),
    );
    await waitFor(
      () => caught.length > 0 || models.every((m) => m.model === failing || committed(m.model) !== undefined),
      'the siblings committed (or the failure escaped)',
    );
    await settle(30);
    // Nothing reached the outer boundary (before T10-B: the world was replaced).
    expect(caught).toEqual([]);
    for (const { model } of models) {
      if (model === failing) expect(committed(model)).toBeUndefined();
      else expect(committed(model)).toBeDefined();
    }
    const skips = consoleErrors.filter((m) => m.includes('figure skipped'));
    expect(skips.length).toBe(1);
    expect(skips[0]).toContain('resident:deployment-ops');
    expect(skips[0]).toContain(failing);
    // The warm ran first and resolved on the failure; no render read suspended.
    const forPath = reads.filter((r) => r.path === failing);
    expect(forPath.some((r) => !r.inRender)).toBe(true);
    expect(reads.filter((r) => r.inRender && r.suspended)).toEqual([]);
    // The boundary's clear() evicted the failed entry (retry on remount).
    expect(clears).toEqual([failing]);
    await r3f.act(async () => root.unmount());
  }, 20_000);

  test('a canvas remount after a failure warm-reads and loads the resident again', async () => {
    resetCache();
    const failing = LOCATION_NPCS['deployment-ops']!.model;
    failingPaths.add(failing);
    const { root, committed } = await mount(createElement(ArenaLocationNpcs));
    await waitFor(() => consoleErrors.some((m) => m.includes('figure skipped')), 'the failed resident was skipped');
    await r3f.act(async () => {
      root.render(null);
    });
    failingPaths.delete(failing);
    await r3f.act(async () => {
      root.render(createElement(ArenaLocationNpcs));
    });
    await waitFor(() => committed(failing) !== undefined, 'the resident committed after the remount');
    expect(loadStarts.get(failing)).toBe(2);
    expect(reads.filter((r) => r.inRender && r.suspended)).toEqual([]);
    await r3f.act(async () => root.unmount());
  }, 20_000);

  test('a stream-out + stream-in after a failure warm-reads again (no suspended render read)', async () => {
    resetCache();
    const failing = LOCATION_NPCS['deployment-ops']!.model;
    failingPaths.add(failing);
    const { root, store, committed } = await mount(createElement(ArenaLocationNpcs));
    await waitFor(() => consoleErrors.some((m) => m.includes('figure skipped')), 'the failed resident was skipped');
    failingPaths.delete(failing);
    const frames = async (n: number) => {
      for (let k = 0; k < n; k += 1) {
        await r3f.act(async () => {
          store.getState().advance(performance.now());
        });
      }
    };
    const camera = store.getState().camera;
    const sibling = LOCATION_NPCS['agent-security']!.model;
    expect(committed(sibling)).toBeDefined();
    camera.position.set(10_000_000, 0, 0);
    await frames(30); // the stream check runs every 12 frames
    expect(committed(sibling)).toBeUndefined();
    camera.position.set(0, 0, 5);
    await frames(30);
    await waitFor(() => committed(failing) !== undefined, 'the resident committed after the stream-in');
    expect(committed(sibling)).toBeDefined();
    expect(loadStarts.get(failing)).toBe(2);
    expect(reads.filter((r) => r.inRender && r.suspended)).toEqual([]);
    await r3f.act(async () => root.unmount());
  }, 20_000);
});
