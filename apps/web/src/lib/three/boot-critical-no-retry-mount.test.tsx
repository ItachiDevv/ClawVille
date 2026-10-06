/**
 * Mounted check (web-load T7): a boot-critical (reveal-required, stage-B)
 * member must commit its content WITHOUT a Suspense retry.
 *
 * Why: in react-reconciler 0.31 (R3F 9.5) a Suspense retry lane never
 * expires, renders time-sliced, and waits for the 300 ms reveal throttle.
 * The 5 Hz world-stream snapshots re-render the R3F root at SyncLane and
 * discard that retry work, so on a slow CPU the buildings stayed hidden for
 * > 100 s (staging ac36e4e1 runs A2/B2). With `warmRead`, the release hook
 * loads the model OUTSIDE React at admission and releases only after the
 * cache entry resolved, so the release render never suspends.
 *
 * Real R3F root (fake renderer, frameloop 'never'), the REAL release hook,
 * BootStreamedContent and decorative-release stage-B queue, and the REAL
 * R3F useLoader / suspend-react cache with a controllable loader. One
 * stand-in: the warm attachment (pass-through). Runs in its own process
 * (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Fragment, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type * as THREE from 'three';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'Event', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const threeCjs = require('three') as typeof import('three');

mock.module('./deferred-warm-attachment', () => ({
  DeferredWarmAttachment: ({ children }: { children: ReactNode | ((ready: boolean) => ReactNode) }) =>
    createElement(Fragment, null, typeof children === 'function' ? children(true) : children),
}));

type PendingLoad = { url: string; onLoad: (data: unknown) => void; onError: (error: unknown) => void };
const pendingLoads: PendingLoad[] = [];

/** A three-style loader whose loads the test settles by hand. */
class ControlledLoader {
  load(url: string, onLoad: (data: unknown) => void, _onProgress?: unknown, onError?: (error: unknown) => void): void {
    pendingLoads.push({ url, onLoad, onError: onError ?? (() => undefined) });
  }
}

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let BootStreamedContent: typeof import('./boot-streamed-content').BootStreamedContent;
let release: typeof import('./decorative-release');
let cohort: typeof import('./boot-stream-cohort');

/** Render attempts of the content that SUSPENDED (threw a thenable). Every
 * one means the content can only commit through a Suspense retry lane. */
let suspensions = 0;

/** R3F 9 reports boundary-CAUGHT render errors through `reportError`
 * (captured at module load), which Bun raises as an uncaught test error.
 * Installed before the R3F import; records instead. */
const reported: unknown[] = [];
const reportErrorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'reportError');

function readModel(url: string): unknown {
  return r3f.useLoader(ControlledLoader as never, url);
}

function Content({ url, name }: { url: string; name: string }) {
  try {
    readModel(url);
  } catch (thrown) {
    if (thrown && typeof (thrown as { then?: unknown }).then === 'function') suspensions += 1;
    throw thrown;
  }
  return createElement('mesh', { name });
}

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
  r3f = await import('@react-three/fiber');
  r3f.extend(threeCjs as never);
  ({ BootStreamedContent } = await import('./boot-streamed-content'));
  release = await import('./decorative-release');
  cohort = await import('./boot-stream-cohort');
  release.forceBootBuildingsStreamEligible('t7-test');
});

afterAll(async () => {
  if (reportErrorDescriptor) Object.defineProperty(globalThis, 'reportError', reportErrorDescriptor);
  else delete (globalThis as Record<string, unknown>).reportError;
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
}

async function mountMember(cohortId: string, url: string, name: string) {
  const canvas = testWindow.document.createElement('canvas');
  testWindow.document.body.appendChild(canvas);
  const root = r3f.createRoot(canvas as unknown as HTMLCanvasElement);
  await root.configure({
    gl: fakeRenderer(canvas) as never,
    size: { width: 320, height: 200, top: 0, left: 0 },
    frameloop: 'never',
  });
  const warmRead = () => readModel(url);
  let store!: ReturnType<typeof root.render>;
  await r3f.act(async () => {
    store = root.render(
      createElement(BootStreamedContent, {
        cohortId,
        priority: 0,
        revealRequired: true,
        warmRead,
        children: createElement(Content, { url, name }),
      }),
    );
  });
  const find = () => store.getState().scene.getObjectByName(name) as THREE.Object3D | undefined;
  return { root, find };
}

const loadFor = (url: string) => pendingLoads.find((p) => p.url === url);

describe('boot-critical member commits without a Suspense retry (T7)', () => {
  test(
    'admission loads outside React; the release render reads a resolved entry (0 suspensions)',
    async () => {
      suspensions = 0;
      const url = '/models/t7-guide.glb';
      const { root, find } = await mountMember('npc:town-guide', url, 't7-guide');

      // Stage-B admission (idle tick) starts the ONE load.
      await waitFor(() => loadFor(url) !== undefined, 'admission started the load');
      expect(find()).toBeUndefined();

      // The load resolves; in the SAME act the release flips and the content
      // commits, with no render that suspended.
      await r3f.act(async () => {
        loadFor(url)!.onLoad({});
        for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(suspensions).toBe(0);
      expect(find()).toBeDefined();
      expect(reported).toEqual([]);
      expect(pendingLoads.filter((p) => p.url === url).length).toBe(1);
      expect(
        typeof (globalThis.window as unknown as { __W3D_PHASES?: Record<string, unknown> }).__W3D_PHASES?.[
          'bgrParsed:npc:town-guide'
        ],
      ).toBe('number');
      expect(
        typeof (globalThis.window as unknown as { __W3D_PHASES?: Record<string, unknown> }).__W3D_PHASES?.[
          'bgrMounted:npc:town-guide'
        ],
      ).toBe('number');

      await r3f.act(async () => root.unmount());
    },
    20_000,
  );

  test(
    'a failed load releases and the render rethrows into the existing boundary (failed, 0 suspensions)',
    async () => {
      suspensions = 0;
      reported.length = 0;
      const url = '/models/t7-missing.glb';
      const failedBefore = cohort.getCohortCounts().failed;
      const warn = console.warn;
      console.warn = () => undefined; // StreamBoundary logs the drop.
      try {
        const { root, find } = await mountMember('building:cove', url, 't7-missing');
        await waitFor(() => loadFor(url) !== undefined, 'admission started the load');
        await r3f.act(async () => {
          loadFor(url)!.onError(new Error('404'));
          for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(suspensions).toBe(0);
        expect(find()).toBeUndefined();
        expect(cohort.getCohortCounts().failed).toBe(failedBefore + 1);
        // The boundary CAUGHT exactly the cached load error.
        expect(reported.map((e) => (e as Error).message)).toEqual([
          'Could not load /models/t7-missing.glb: 404',
        ]);
        await r3f.act(async () => root.unmount());
      } finally {
        console.warn = warn;
      }
    },
    20_000,
  );
});
