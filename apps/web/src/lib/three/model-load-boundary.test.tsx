/**
 * ModelLoadBoundary through REAL loaders (useVRMInstance, useGLTFWithKTX2)
 * with a mocked fetch. The root's onCaughtError is R3F's (a reportError-style
 * window "error" event).
 *
 * - a figure whose model fails renders null; siblings render; nothing reaches
 *   the outer boundary; one console.error per (url, original error).
 * - B2: a non-model error (render bug) goes to the OUTER boundary.
 * - B3: the duplicate-report cancel is one-shot; a later report of the same
 *   error object is not cancelled.
 * - B1: after the network recovers, a remount / resetKey change loads again
 *   (GLB: R3F cache cleared; VRM: rejected entry evicted).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Component, Suspense, act, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'ErrorEvent', 'ProgressEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;

let createRoot: typeof import('react-dom/client').createRoot;
let useVRMInstance: typeof import('./vrm-loader').useVRMInstance;
let useGLTFWithKTX2: typeof import('./use-gltf-ktx2').useGLTFWithKTX2;
let ModelLoadBoundary: typeof import('./model-load-boundary').ModelLoadBoundary;
let ModelLoadError: typeof import('./model-load-error').ModelLoadError;

const VALID_GLTF = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'figure-root' }] });
type Reply = number | 'valid';
const plans = new Map<string, Reply[]>();
const requests = new Map<string, number>();

beforeAll(async () => {
  for (const name of globalNames) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value =
      name === 'IS_REACT_ACT_ENVIRONMENT'
        ? true
        : name === 'window'
          ? testWindow
          : (testWindow as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  // Default reply 404 (final at once, never retried) keeps the tests fast.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.set(url, (requests.get(url) ?? 0) + 1);
    const reply = plans.get(url)?.shift() ?? 404;
    if (reply === 'valid') return new Response(new TextEncoder().encode(VALID_GLTF), { status: 200 });
    return new Response('missing', { status: reply });
  }) as typeof fetch;
  ({ createRoot } = await import('react-dom/client'));
  ({ useVRMInstance } = await import('./vrm-loader'));
  ({ useGLTFWithKTX2 } = await import('./use-gltf-ktx2'));
  ({ ModelLoadBoundary } = await import('./model-load-boundary'));
  ({ ModelLoadError } = await import('./model-load-error'));
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await testWindow.happyDOM.close();
});

/** Outer boundary that must never see a figure's MODEL error. */
class OuterBoundary extends Component<{ onCatch: (error: unknown) => void; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onCatch(error);
  }
  render() {
    return this.state.failed ? createElement('b', { id: 'outer-failed' }) : (this.props.children ?? null);
  }
}

function VrmFigure({ path, id }: { path: string; id: string }) {
  useVRMInstance(path, id);
  return createElement('span', { 'data-figure': id });
}

function GlbFigure({ path }: { path: string }) {
  const gltf = useGLTFWithKTX2(path);
  return createElement('span', { 'data-glb': gltf.scene.getObjectByName('figure-root') ? 'ok' : 'empty' });
}

type HappyErrorEvent = InstanceType<typeof testWindow.ErrorEvent>;

/** R3F's reconciler root: onCaughtError = reportError (a window "error" event). */
function r3fLikeRoot(container: Element, reported: HappyErrorEvent[]): Root {
  return createRoot(container, {
    onCaughtError: (error: unknown) => {
      const event = new testWindow.ErrorEvent('error', {
        error: error as Error,
        message: String((error as Error)?.message ?? error),
        cancelable: true,
      });
      testWindow.dispatchEvent(event);
      reported.push(event);
    },
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function captureConsoleError() {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  return { logged, restore: () => (console.error = original) };
}

function newContainer(): Element {
  const container = testWindow.document.createElement('div') as unknown as Element;
  testWindow.document.body.appendChild(container as never);
  return container;
}

const skippedLines = (logged: unknown[][]) =>
  logged.filter((args) => String(args[0]).startsWith('[3D] figure skipped'));

describe('ModelLoadBoundary', () => {
  test('a figure whose VRM rejects renders null; siblings render; one console.error; nothing reaches the outer boundary', async () => {
    const path = 'http://localhost/avatars/mlb-missing.vrm';
    const container = newContainer();
    const reported: HappyErrorEvent[] = [];
    const outer: unknown[] = [];
    const root = r3fLikeRoot(container, reported);
    const cap = captureConsoleError();
    try {
      await act(async () => {
        root.render(
          createElement(
            OuterBoundary,
            { onCatch: (e) => outer.push(e) },
            createElement(
              ModelLoadBoundary,
              { assetUrl: path, label: 'wanderer:a', resetKey: 'a' },
              createElement(Suspense, { fallback: null }, createElement(VrmFigure, { path, id: 'npc-a' })),
            ),
            // A second figure, SAME missing VRM, same failed request: one line.
            createElement(
              ModelLoadBoundary,
              { assetUrl: path, label: 'wanderer:b', resetKey: 'b' },
              createElement(Suspense, { fallback: null }, createElement(VrmFigure, { path, id: 'npc-b' })),
            ),
            createElement('i', { id: 'sibling' }),
          ),
        );
      });
      await settle();
    } finally {
      cap.restore();
    }

    expect(container.querySelector('#sibling')).not.toBeNull();
    expect(container.querySelector('#outer-failed')).toBeNull();
    expect(container.querySelectorAll('[data-figure]').length).toBe(0);
    expect(outer).toEqual([]);
    const skipped = skippedLines(cap.logged);
    expect(skipped.length).toBe(1);
    expect(String(skipped[0][0])).toContain(path);
    expect(String(skipped[0][0])).toContain('(fetch)');
    expect(String((skipped[0][1] as Error).message)).toContain('failed: 404');
    expect(cap.logged.length).toBe(1);
    expect(reported.length).toBe(2);
    expect(reported.every((event) => event.defaultPrevented)).toBe(true);
    await act(async () => root.unmount());
  });

  test('B2: a render bug in a figure is NOT a model failure: it reaches the outer boundary, no "[3D]" line', async () => {
    function Buggy(): never {
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    }
    const container = newContainer();
    const outer: unknown[] = [];
    const root = r3fLikeRoot(container, []);
    const cap = captureConsoleError();
    try {
      await act(async () => {
        root.render(
          createElement(
            OuterBoundary,
            { onCatch: (e) => outer.push(e) },
            createElement(ModelLoadBoundary, { assetUrl: '/models/x.glb', label: 'remote:bug', resetKey: 'k' }, createElement(Buggy)),
          ),
        );
      });
    } finally {
      cap.restore();
    }
    expect(container.querySelector('#outer-failed')).not.toBeNull();
    expect(outer.length).toBe(1);
    expect((outer[0] as Error).message).toContain("reading 'x'");
    expect(skippedLines(cap.logged).length).toBe(0);
    await act(async () => root.unmount());
  });

  test('B2: dedupe is per (url, original error): a later, different failure of the same URL logs again', async () => {
    const url = '/models/dedupe.glb';
    let original: unknown = new TypeError('Failed to fetch');
    function Failing(): never {
      throw new ModelLoadError({ url, phase: 'fetch', original, message: `Could not load ${url}: x` });
    }
    const container = newContainer();
    const root = r3fLikeRoot(container, []);
    const cap = captureConsoleError();
    try {
      const tree = (resetKey: string) =>
        createElement(ModelLoadBoundary, { assetUrl: url, label: 'wanderer:d', resetKey }, createElement(Failing));
      await act(async () => root.render(tree('1')));
      await act(async () => root.render(tree('2'))); // same original error: no new line
      original = Object.assign(new Error('fetch for "x" responded with 503'), { response: { status: 503 } });
      await act(async () => root.render(tree('3'))); // a different error: new line
    } finally {
      cap.restore();
    }
    const skipped = skippedLines(cap.logged);
    expect(skipped.length).toBe(2);
    expect(String(skipped[0][0])).toContain('TypeError: Failed to fetch');
    expect(String(skipped[1][0])).toContain('responded with 503');
    await act(async () => root.unmount());
  });

  test('B3: the cancel is one-shot: a later report of the SAME error object outside the boundary is not cancelled', async () => {
    const url = '/models/one-shot.glb';
    const shared = new ModelLoadError({ url, phase: 'fetch', original: new TypeError('Failed to fetch'), message: `Could not load ${url}: x` });
    function Failing(): never {
      throw shared;
    }
    const container = newContainer();
    const reported: HappyErrorEvent[] = [];
    const root = r3fLikeRoot(container, reported);
    const cap = captureConsoleError();
    try {
      await act(async () => {
        root.render(createElement(ModelLoadBoundary, { assetUrl: url, label: 'wanderer:s', resetKey: 's' }, createElement(Failing)));
      });
    } finally {
      cap.restore();
    }
    expect(reported.length).toBe(1);
    expect(reported[0].defaultPrevented).toBe(true);

    const later = new testWindow.ErrorEvent('error', { error: shared as unknown as Error, cancelable: true });
    testWindow.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    await act(async () => root.unmount());
  });

  test('an error the boundary never handled is not cancelled', () => {
    const event = new testWindow.ErrorEvent('error', { error: new Error('other'), cancelable: true });
    testWindow.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test('B1: a GLB figure that failed loads after the network recovers (resetKey change clears the R3F cache)', async () => {
    const url = 'http://localhost/models/mlb-recover.glb?v=4';
    plans.set(url, [404, 'valid']);
    const container = newContainer();
    const root = r3fLikeRoot(container, []);
    const cap = captureConsoleError();
    try {
      const tree = (resetKey: string) =>
        createElement(
          ModelLoadBoundary,
          { assetUrl: url, label: 'remote:glb', resetKey },
          createElement(Suspense, { fallback: null }, createElement(GlbFigure, { path: url })),
        );
      await act(async () => root.render(tree('first')));
      await settle();
      expect(container.querySelector('[data-glb]')).toBeNull();
      expect(requests.get(url)).toBe(1);

      await act(async () => root.render(tree('retry')));
      await settle();
    } finally {
      cap.restore();
    }
    expect(requests.get(url)).toBe(2);
    expect(container.querySelector('[data-glb="ok"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  test('B1: a VRM figure remount requests again instead of rethrowing the cached rejection', async () => {
    const path = 'http://localhost/avatars/mlb-remount.vrm';
    const container = newContainer();
    const root = r3fLikeRoot(container, []);
    const cap = captureConsoleError();
    try {
      const tree = (resetKey: string) =>
        createElement(
          ModelLoadBoundary,
          { assetUrl: path, label: 'wanderer:r', resetKey },
          createElement(Suspense, { fallback: null }, createElement(VrmFigure, { path, id: 'npc-r' })),
        );
      await act(async () => root.render(tree('1')));
      await settle();
      expect(requests.get(path)).toBe(1);
      await act(async () => root.render(tree('2')));
      await settle();
    } finally {
      cap.restore();
    }
    expect(requests.get(path)).toBe(2);
    await act(async () => root.unmount());
  });

  test('changing resetKey clears the failure and remounts the figure', async () => {
    let loadFails = true;
    function Flaky() {
      if (loadFails) {
        throw new ModelLoadError({ url: '/models/flaky.glb', phase: 'fetch', original: new TypeError('Failed to fetch'), message: 'x' });
      }
      return createElement('span', { id: 'flaky-ok' });
    }
    const container = newContainer();
    const root = r3fLikeRoot(container, []);
    const cap = captureConsoleError();
    try {
      const tree = (resetKey: string) =>
        createElement(ModelLoadBoundary, { assetUrl: '/models/flaky.glb', label: 'remote:x', resetKey }, createElement(Flaky));
      await act(async () => root.render(tree('species-1')));
      expect(container.querySelector('#flaky-ok')).toBeNull();
      loadFails = false;
      await act(async () => root.render(tree('species-1')));
      expect(container.querySelector('#flaky-ok')).toBeNull(); // same key: stays skipped, no loop
      await act(async () => root.render(tree('species-2')));
      expect(container.querySelector('#flaky-ok')).not.toBeNull();
    } finally {
      cap.restore();
    }
    await act(async () => root.unmount());
  });
});
