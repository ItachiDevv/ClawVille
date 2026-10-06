/**
 * Warm-read parity for the 11 seabed decoration GLBs (web-load T8).
 *
 * Why: staging 1342805d, CPU 4x: the 11 decoration GLBs returned 200 by
 * 40-42 s, yet 0 decoration meshes mounted in the 90 s after load while a
 * Suspense retry lane stayed pending 76-96 s. The decoration boundary was the
 * last non-critical member still revealing through a Suspense RETRY, and the
 * 5 Hz world-stream SyncLane renders discard retry work (the T7 starvation,
 * gotchas/suspense-retry-lane-starvation-sync-store-updates.md).
 *
 * The fix applies the T7 pattern: after its stagger release,
 * UnderwaterDecorations resolves every decoration cache entry OUTSIDE React
 * (warmSuspenseRead + readGLTFWithKTX2, the same drei call as the render's
 * useOptionalGLTFWithKTX2) and mounts MergedDecorationsInner only after, so
 * its first render reads resolved entries and never suspends.
 *
 * This test mounts the REAL ArenaTerrain with drei's useGLTF wrapped by a
 * recorder (path, draco, meshopt, extender, warm-or-render, threw). The
 * recorder emulates the suspend-react cache by path: the first read throws a
 * thenable, later reads return the cached GLTF, and one path FAILS (its later
 * reads throw R3F's cached `Could not load <path>: ...` Error). It asserts,
 * for each of the 11 paths:
 *   - a warm read ran outside render before the first render read;
 *   - 0 render reads suspended;
 *   - every read used the identical (draco, meshopt, extender);
 * and that the failed optional GLB is still skipped with exactly one
 * console.error while the other 10 models merge.
 * Runs in its own process (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Fragment, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import { DECO_TYPES } from './arena-terrain-decorations';

const DECO_PATHS = [...new Set(DECO_TYPES.map((t) => t.model))].sort();
const FAILING_PATH = DECO_PATHS.find((p) => p.includes('crayfish'))!;

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'Event', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const threeCjs = require('three') as typeof import('three');

type Read = {
  path: string;
  draco: unknown;
  meshopt: unknown;
  extender: unknown;
  inRender: boolean;
  /** The read threw a thenable (it suspended), not a cached Error. */
  suspended: boolean;
};
const reads: Read[] = [];

const cache = new Map<string, { scene: InstanceType<typeof threeCjs.Group> }>();
const failed = new Map<string, Error>();
const loading = new Map<string, Promise<void>>();
function cannedGltf(path: string) {
  let gltf = cache.get(path);
  if (!gltf) {
    const scene = new threeCjs.Group();
    scene.add(
      new threeCjs.Mesh(new threeCjs.BoxGeometry(1, 2, 1), new threeCjs.MeshStandardMaterial()),
    );
    gltf = { scene };
    cache.set(path, gltf);
  }
  return gltf;
}

/** drei's own defaults: an undefined flag means `true`. */
const flag = (value: unknown) => (value === undefined ? true : value);

function recordingUseGLTF(path: string, draco?: unknown, meshopt?: unknown, extender?: unknown) {
  const read: Read = {
    path,
    draco: flag(draco),
    meshopt: flag(meshopt),
    extender,
    inRender: !(new Error().stack ?? '').includes('warmSuspenseRead'),
    suspended: false,
  };
  reads.push(read);
  const failure = failed.get(path);
  if (failure) {
    throw failure; // R3F rethrows the SAME cached Error on every read.
  }
  if (cache.has(path)) return cannedGltf(path);
  let pending = loading.get(path);
  if (!pending) {
    pending = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => {
      if (path === FAILING_PATH) failed.set(path, new Error(`Could not load ${path}: 404 test`));
      else cannedGltf(path);
    });
    loading.set(path, pending);
  }
  read.suspended = true;
  throw pending;
}

mock.module('./decorative-release', () => ({
  isDecorativeReleased: () => true,
  onDecorativeReleaseStaggered: (callback: () => void) => {
    callback();
    return () => undefined;
  },
}));
mock.module('./deferred-warm-attachment', () => ({
  DeferredWarmAttachment: ({ children }: { children: ReactNode | ((ready: boolean) => ReactNode) }) =>
    createElement(Fragment, null, typeof children === 'function' ? children(true) : children),
}));

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let ArenaTerrain: (props: { decorationsMounted: boolean; decorationsVisible: boolean }) => ReactNode;
const consoleErrors: string[] = [];
const originalConsoleError = console.error;

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
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  const realDrei = await import('@react-three/drei');
  mock.module('@react-three/drei', () => ({
    ...realDrei,
    useGLTF: Object.assign(recordingUseGLTF, {
      preload: () => undefined,
      clear: () => undefined,
      setDecoderPath: () => undefined,
    }),
  }));
  r3f = await import('@react-three/fiber');
  r3f.extend(threeCjs as never);
  ArenaTerrain = (await import('./arena-terrain')).default as never;
});

afterAll(async () => {
  console.error = originalConsoleError;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await testWindow.happyDOM.close();
});

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

async function waitFor(ready: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await r3f.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe('seabed decoration warm reads match the production render reads', () => {
  test(
    'all 11 paths warmed outside render with the render read\'s exact options; 0 render suspensions; a failed GLB is still skipped with one console.error',
    async () => {
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
        store = root.render(createElement(ArenaTerrain, { decorationsMounted: true, decorationsVisible: true }));
      });
      const decoMeshes = () => {
        let n = 0;
        store.getState().scene.traverse((o) => {
          if (o.name === 'arena-terrain-decoration') n += 1;
        });
        return n;
      };
      await waitFor(() => decoMeshes() > 0, 'merged decorations mounted');

      expect(DECO_PATHS.length).toBe(11);
      const problems: string[] = [];
      for (const path of DECO_PATHS) {
        const forPath = reads.filter((r) => r.path === path);
        const firstRender = forPath.findIndex((r) => r.inRender);
        if (firstRender === -1) {
          problems.push(`${path}: never read by a render`);
          continue;
        }
        const warmBefore = forPath.slice(0, firstRender).filter((r) => !r.inRender);
        if (warmBefore.length === 0) problems.push(`${path}: no warm read outside render before the first render read`);
        // Includes the failing path: its render reads must throw the cached
        // Error (skip), never a thenable (a Suspense retry).
        const suspended = forPath.filter((r) => r.inRender && r.suspended).length;
        if (suspended > 0) problems.push(`${path}: ${suspended} render read(s) suspended`);
        const options = new Set(forPath.map((r) => `${String(r.draco)}|${String(r.meshopt)}`));
        const extenders = new Set(forPath.map((r) => r.extender));
        if (options.size !== 1) problems.push(`${path}: loader flags differ ${[...options].join(' vs ')}`);
        if (extenders.size !== 1) problems.push(`${path}: ${extenders.size} different loader extenders`);
      }
      const warmOnly = [...new Set(reads.filter((r) => !r.inRender).map((r) => r.path))].filter(
        (p) => !DECO_PATHS.includes(p),
      );
      for (const p of warmOnly) problems.push(`${p}: warmed but never a decoration path`);
      expect(problems).toEqual([]);

      // Failed optional GLB: skipped (10 models merged) with exactly one console.error.
      const failLogs = consoleErrors.filter((m) => m.includes('optional model skipped') && m.includes(FAILING_PATH));
      expect(failLogs.length).toBe(1);
      expect(decoMeshes()).toBeGreaterThan(0);

      await r3f.act(async () => root.unmount());
    },
    30_000,
  );
});
