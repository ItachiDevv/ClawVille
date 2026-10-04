/**
 * ModelLoadBoundary: a figure whose REAL useVRMInstance load rejects renders
 * nothing, its siblings keep rendering, nothing reaches an outer boundary,
 * and exactly ONE console.error names the URL. The root's onCaughtError is
 * R3F's (reportError-style window "error" event); the boundary cancels that
 * duplicate report for errors it handled.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Component, Suspense, act, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'ErrorEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;

let createRoot: typeof import('react-dom/client').createRoot;
let useVRMInstance: typeof import('./vrm-loader').useVRMInstance;
let ModelLoadBoundary: typeof import('./model-load-boundary').ModelLoadBoundary;

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
  // Every VRM request 404s: final at once (no retry), so the test is fast.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.set(url, (requests.get(url) ?? 0) + 1);
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  ({ createRoot } = await import('react-dom/client'));
  ({ useVRMInstance } = await import('./vrm-loader'));
  ({ ModelLoadBoundary } = await import('./model-load-boundary'));
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await testWindow.happyDOM.close();
});

/** Outer boundary that must never see a figure's error. */
class OuterBoundary extends Component<{ onCatch: () => void; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onCatch();
  }
  render() {
    return this.state.failed ? createElement('b', { id: 'outer-failed' }) : (this.props.children ?? null);
  }
}

function VrmFigure({ path, id }: { path: string; id: string }) {
  useVRMInstance(path, id);
  return createElement('span', { 'data-figure': id });
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
  for (let i = 0; i < 20; i += 1) {
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

describe('ModelLoadBoundary', () => {
  test('a figure whose VRM rejects renders null; siblings render; one console.error; nothing reaches the outer boundary', async () => {
    const path = 'http://localhost/avatars/mlb-missing.vrm';
    const container = testWindow.document.createElement('div') as unknown as Element;
    testWindow.document.body.appendChild(container as never);
    const reported: HappyErrorEvent[] = [];
    let outerCatches = 0;
    const root = r3fLikeRoot(container, reported);
    const cap = captureConsoleError();
    try {
      await act(async () => {
        root.render(
          createElement(
            OuterBoundary,
            { onCatch: () => (outerCatches += 1) },
            createElement(
              ModelLoadBoundary,
              { assetUrl: path, label: 'wanderer:a', resetKey: 'a' },
              createElement(Suspense, { fallback: null }, createElement(VrmFigure, { path, id: 'npc-a' })),
            ),
            // A second figure with the SAME missing VRM: still one log line.
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

    expect(requests.get(path)).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('#sibling')).not.toBeNull();
    expect(container.querySelector('#outer-failed')).toBeNull();
    expect(container.querySelectorAll('[data-figure]').length).toBe(0);
    expect(outerCatches).toBe(0);

    const skipped = cap.logged.filter((args) => String(args[0]).includes('[3D] figure skipped'));
    expect(skipped.length).toBe(1);
    expect(String(skipped[0][0])).toContain(path);
    expect(String((skipped[0][1] as Error).message)).toContain('failed: 404');
    expect(cap.logged.length).toBe(1);

    // The R3F-style duplicate report was cancelled for both handled errors.
    expect(reported.length).toBe(2);
    expect(reported.every((event) => event.defaultPrevented)).toBe(true);

    await act(async () => root.unmount());
  });

  test('changing resetKey clears the failure and remounts the figure (retry)', async () => {
    // Fails while `loadFails` is true (React re-renders once after a render
    // error, so a fail-once child would recover without the boundary).
    let loadFails = true;
    function Flaky() {
      if (loadFails) throw new Error('model load failed');
      return createElement('span', { id: 'flaky-ok' });
    }
    const container = testWindow.document.createElement('div') as unknown as Element;
    testWindow.document.body.appendChild(container as never);
    const root = r3fLikeRoot(container, []);
    const cap = captureConsoleError();
    try {
      const tree = (resetKey: string) =>
        createElement(ModelLoadBoundary, { assetUrl: '/models/flaky.glb', label: 'remote:x', resetKey }, createElement(Flaky));
      await act(async () => root.render(tree('species-1')));
      expect(container.querySelector('#flaky-ok')).toBeNull();
      loadFails = false; // the cache was cleared / the asset is back
      await act(async () => root.render(tree('species-1')));
      expect(container.querySelector('#flaky-ok')).toBeNull(); // same key: stays skipped, no loop
      await act(async () => root.render(tree('species-2')));
      expect(container.querySelector('#flaky-ok')).not.toBeNull();
    } finally {
      cap.restore();
    }
    await act(async () => root.unmount());
  });

  test('an error the boundary did not handle is not cancelled', () => {
    const event = new testWindow.ErrorEvent('error', { error: new Error('other'), cancelable: true });
    testWindow.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
