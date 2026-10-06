/**
 * Mounted check of the seabed decoration gate (Codex E3 SHOULD-FIX 2026-10-06):
 * (a) with the gate OFF, ArenaTerrain makes no demand and no fetch for any of
 *     the 12 decoration GLB paths;
 * (b) on -> off cycles (the adaptive governor toggling tier 0/1) dispose every
 *     merged decoration geometry, so GPU memory cannot grow per toggle, and
 *     never dispose the shared GLB materials (land-ring-decorations reuses them).
 *
 * Real R3F root (fake renderer, frameloop 'never') like
 * cove-figure-model-load.test.tsx. Three stand-ins only: the optional GLB hook
 * (records each demanded path, returns a one-box scene per path), the
 * decorative release (released), and the warm attachment (pass-through).
 * Runs in its own process (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Fragment, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import * as THREE from 'three/webgpu';
import { DECO_TYPES } from './arena-terrain-decorations';

const DECO_PATHS = new Set(DECO_TYPES.map((t) => t.model));

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'Event', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const threeCjs = require('three') as typeof import('three');

/** Paths demanded through the optional GLB hook, in call order. */
const demands: string[] = [];
/** Fetches whose URL contains a decoration path. */
const decoFetches: string[] = [];

// One cached scene per path, like the R3F loader cache: the SAME material
// objects come back on every mount, so a material dispose would be visible.
const cache = new Map<string, { scene: THREE.Group; material: THREE.MeshStandardMaterial }>();
const materialDisposes = new Map<string, number>();
function cachedGltf(path: string) {
  let entry = cache.get(path);
  if (!entry) {
    const material = new THREE.MeshStandardMaterial();
    const original = material.dispose.bind(material);
    material.dispose = () => {
      materialDisposes.set(path, (materialDisposes.get(path) ?? 0) + 1);
      original();
    };
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), material));
    entry = { scene, material };
    cache.set(path, entry);
  }
  return { scene: entry.scene };
}

mock.module('./use-gltf-ktx2', () => ({
  useOptionalGLTFWithKTX2: (path: string) => {
    demands.push(path);
    return cachedGltf(path);
  },
  useGLTFWithKTX2: (path: string) => {
    demands.push(path);
    return cachedGltf(path);
  },
}));
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
let ArenaTerrain: (props: { showDecorations: boolean }) => ReactNode;

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
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if ([...DECO_PATHS].some((p) => url.includes(p.split('?')[0]))) decoFetches.push(url);
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  r3f = await import('@react-three/fiber');
  r3f.extend(threeCjs as never);
  ArenaTerrain = (await import('./arena-terrain')).default as never;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
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

async function waitFor(ready: () => boolean, what: string, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await r3f.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  await r3f.act(async () => {
    await Promise.resolve();
  });
}

function meshes(scene: THREE.Object3D, name?: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (name === undefined || o.name === name)) out.push(o as THREE.Mesh);
  });
  return out;
}

describe('ArenaTerrain decoration gate, mounted', () => {
  test(
    'off: no decoration demand or fetch; on -> off cycles dispose every merged geometry',
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
      const render = async (showDecorations: boolean) => {
        await r3f.act(async () => {
          store = root.render(createElement(ArenaTerrain, { showDecorations }));
        });
      };
      const decoMeshes = () => meshes(store.getState().scene, 'arena-terrain-decoration');

      // (a) Gate OFF: the sand floor mounts, nothing decoration-related is demanded.
      await render(false);
      await waitFor(() => meshes(store.getState().scene).length > 0, 'sand floor mounted');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(decoMeshes().length).toBe(0);
      expect(demands.filter((p) => DECO_PATHS.has(p))).toEqual([]);
      expect(decoFetches).toEqual([]);

      // (b) Three on -> off cycles.
      const disposed = new Map<string, number>();
      const seen = new Set<string>();
      for (let cycle = 0; cycle < 3; cycle++) {
        await render(true);
        await waitFor(() => decoMeshes().length > 0, `cycle ${cycle}: decorations mounted`);
        const geos = decoMeshes().map((m) => m.geometry);
        // Every mount builds NEW merged geometry (no stale one reused).
        for (const g of geos) {
          expect(seen.has(g.uuid)).toBe(false);
          seen.add(g.uuid);
          const original = g.dispose.bind(g);
          g.dispose = () => {
            disposed.set(g.uuid, (disposed.get(g.uuid) ?? 0) + 1);
            original();
          };
        }
        // Each mount demands all 12 paths (and only through the hook).
        expect(new Set(demands.filter((p) => DECO_PATHS.has(p)))).toEqual(DECO_PATHS);

        await render(false);
        await waitFor(() => decoMeshes().length === 0, `cycle ${cycle}: decorations unmounted`);
        for (const g of geos) expect(disposed.get(g.uuid) ?? 0).toBeGreaterThanOrEqual(1);
      }
      // Live merged geometry after the last OFF: zero (created == disposed).
      expect(seen.size).toBeGreaterThan(0);
      expect([...seen].filter((id) => !disposed.has(id))).toEqual([]);
      // The shared GLB materials survive every cycle.
      expect([...materialDisposes.values()].reduce((a, b) => a + b, 0)).toBe(0);
      expect(decoFetches).toEqual([]);

      await r3f.act(async () => root.unmount());
    },
    20_000,
  );
});
