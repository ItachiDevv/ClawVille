/**
 * PRODUCTION warm-read parity for the 12 boot-critical members (web-load T7,
 * Codex E3 SHOULD-FIX 2026-10-06).
 *
 * The warm (`warmRead`, run OUTSIDE React at stage-B admission) only removes
 * the Suspense retry if it resolves the SAME cache entry the member's render
 * reads, AND it must load that entry with the SAME loader options, because
 * the render then accepts whatever the warm loaded. drei useGLTF keys the
 * R3F/suspend-react cache by [GLTFLoader, path] only (the extender is NOT in
 * the key; pinned by suspense-cache-warm.test.ts), so a different extender
 * or flag would load silently with the wrong loader setup.
 *
 * This test mounts the REAL production members (`ArenaBuildingsStreamed` for
 * the 11 buildings, `TownGuide` for Nori) in a real R3F root, with drei's
 * `useGLTF` wrapped by a recorder. Each call records (path, draco, meshopt,
 * extender) and whether it is a warm read (`warmSuspenseRead` on the call
 * stack, outside React) or a render read. The recorder emulates the suspend-react
 * cache by path: the first read of a path throws a thenable (loading), later
 * reads return the cached GLTF. For each of the 12 paths it asserts:
 *   - a warm read ran outside render, before any render read;
 *   - the render reads never suspended (0 thrown thenables in render);
 *   - every read of the path used the identical (draco, meshopt, extender).
 * A different path or extender in a warm reader fails it (mutations shown in
 * the T7 report). Runs in its own process (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Fragment, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';

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
  threw: boolean;
};
const reads: Read[] = [];

/** One canned GLTF per path, like the cache: the same object every read. */
const cache = new Map<string, { scene: InstanceType<typeof threeCjs.Group>; animations: never[] }>();
const loading = new Map<string, Promise<void>>();
function cannedGltf(path: string) {
  let gltf = cache.get(path);
  if (!gltf) {
    const scene = new threeCjs.Group();
    const mesh = new threeCjs.Mesh(
      new threeCjs.BoxGeometry(10, 20, 10),
      new threeCjs.MeshStandardMaterial(),
    );
    mesh.name = 'parity-mesh';
    scene.add(mesh);
    gltf = { scene, animations: [] };
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
    // A warm read runs inside warmSuspenseRead (outside React); every other
    // read here comes from a member's render.
    inRender: !(new Error().stack ?? '').includes('warmSuspenseRead'),
    threw: false,
  };
  reads.push(read);
  if (cache.has(path)) return cannedGltf(path);
  let pending = loading.get(path);
  if (!pending) {
    // Loading: resolves on a later macrotask, then the entry is cached.
    pending = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => {
      cannedGltf(path);
    });
    loading.set(path, pending);
  }
  read.threw = true;
  throw pending;
}

mock.module('./deferred-warm-attachment', () => ({
  DeferredWarmAttachment: ({ children }: { children: ReactNode | ((ready: boolean) => ReactNode) }) =>
    createElement(Fragment, null, typeof children === 'function' ? children(true) : children),
}));

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let ArenaBuildingsStreamed: (props: { fullDetail?: boolean }) => ReactNode;
let TownGuide: () => ReactNode;
let cohortIds: readonly string[];

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
  ({ ArenaBuildingsStreamed } = (await import('./arena-buildings')) as never);
  TownGuide = (await import('./town-guide')).default as never;
  const release = await import('./decorative-release');
  release.forceBootBuildingsStreamEligible('t7-parity-test');
  cohortIds = (await import('./boot-stream-cohort')).BOOT_STREAM_COHORT_IDS;
});

afterAll(async () => {
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

async function waitFor(ready: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await r3f.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe('boot-critical warm reads match the production render reads', () => {
  test(
    'all 12 members: warmed outside render with the render read\'s exact path + loader options; 0 render suspensions',
    async () => {
      const canvas = testWindow.document.createElement('canvas');
      testWindow.document.body.appendChild(canvas);
      const root = r3f.createRoot(canvas as unknown as HTMLCanvasElement);
      await root.configure({
        gl: fakeRenderer(canvas) as never,
        size: { width: 320, height: 200, top: 0, left: 0 },
        frameloop: 'never',
      });
      await r3f.act(async () => {
        root.render(
          createElement(
            Fragment,
            null,
            createElement(ArenaBuildingsStreamed, { fullDetail: true }),
            createElement(TownGuide),
          ),
        );
      });

      const required = cohortIds.filter((id) => id.startsWith('building:') || id === 'npc:town-guide');
      expect(required.length).toBe(12);
      const renderedPaths = () => new Set(reads.filter((r) => r.inRender).map((r) => r.path));
      // Stage B admits one member per idle tick; wait for all 12 render reads.
      await waitFor(() => renderedPaths().size >= 12, '12 members rendered their model');

      const paths = [...renderedPaths()].sort();
      expect(paths.length).toBe(12);
      expect(paths).toContain('/models/guide-rigged.glb');
      // The 11 buildings read their versioned BUILDING_MODELS paths.
      expect(paths.filter((p) => p !== '/models/guide-rigged.glb').length).toBe(11);

      const problems: string[] = [];
      for (const path of paths) {
        const forPath = reads.filter((r) => r.path === path);
        const firstRender = forPath.findIndex((r) => r.inRender);
        const warmBefore = forPath.slice(0, firstRender).filter((r) => !r.inRender);
        if (warmBefore.length === 0) problems.push(`${path}: no warm read outside render before the first render read`);
        const suspended = forPath.filter((r) => r.inRender && r.threw).length;
        if (suspended > 0) problems.push(`${path}: ${suspended} render read(s) suspended`);
        const options = new Set(forPath.map((r) => `${String(r.draco)}|${String(r.meshopt)}`));
        const extenders = new Set(forPath.map((r) => r.extender));
        if (options.size !== 1) problems.push(`${path}: loader flags differ ${[...options].join(' vs ')}`);
        if (extenders.size !== 1) problems.push(`${path}: ${extenders.size} different loader extenders`);
      }
      // A warm read of a path that no member renders = a path mismatch.
      const warmOnly = [...new Set(reads.filter((r) => !r.inRender).map((r) => r.path))].filter(
        (p) => !paths.includes(p),
      );
      for (const p of warmOnly) problems.push(`${p}: warmed but never read by a render (path mismatch)`);
      expect(problems).toEqual([]);

      await r3f.act(async () => root.unmount());
    },
    30_000,
  );
});
