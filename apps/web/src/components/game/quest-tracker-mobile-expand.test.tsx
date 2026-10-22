import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

// First-visit auto-expand must be DESKTOP-only (staging, 2026-10-20). A phone
// that mounted the tracker with the tour already dismissed (the reload after an
// agent connect) opened it EXPANDED, and the list sat under the bottom "Talk to
// Nori" pill. Cause: `useIsMobile()` starts false and sets the real value in a
// layout effect; the tracker's passive effect from the FIRST commit still ran
// with the captured `false` before the re-render, so `check()` auto-expanded.

const testWindow = new Window({ url: 'http://localhost/game', width: 1280, height: 800 });
const domNames = ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installed = ['window', 'document', 'navigator', 'localStorage', 'fetch', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT', ...domNames] as const;
let previous = new Map<PropertyKey, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

// Same forwarder as quest-tracker-claim-gate.test.tsx: the quest store binds
// its persist storage once per process, and bun shares that module across
// test files, so it must reach whichever file's storage is live at call time.
let storageTarget: Storage | null = testWindow.localStorage;
const target = (): Storage => storageTarget ?? globalThis.localStorage;
const forwardingStorage = {
  getItem: (key: string) => target().getItem(key),
  setItem: (key: string, value: string) => target().setItem(key, value),
  removeItem: (key: string) => target().removeItem(key),
  clear: () => target().clear(),
  key: (index: number) => target().key(index),
  get length() {
    return target().length;
  },
} as Storage;

const TUTORIAL_KEY = 'clawville-tutorial-seen';
const QUEST_INTRO_KEY = 'clawville-quest-intro-seen';

type ApiModule = typeof import('@/lib/api');

let createRoot: typeof import('react-dom/client').createRoot;
let QuestTracker: typeof import('./quest-tracker').default;
let api: ApiModule['api'];
let originalApi: Partial<Record<'me' | 'getMyAvatar', unknown>> = {};
const originalMatchMedia = testWindow.matchMedia.bind(testWindow);

let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;

/** Sets the four signals `useIsMobile()` reads to a desktop or a phone. */
function setTouch(touch: boolean): void {
  Object.defineProperty(testWindow.navigator, 'maxTouchPoints', { configurable: true, get: () => (touch ? 5 : 0) });
  (testWindow as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => {
    if (query !== '(pointer: coarse)') return originalMatchMedia(query);
    return { matches: touch, media: query, addEventListener() {}, removeEventListener() {} };
  };
  if (!touch) Reflect.deleteProperty(testWindow, 'ontouchstart');
}

beforeAll(async () => {
  previous = new Map(installed.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  define('window', testWindow);
  define('document', testWindow.document);
  define('navigator', testWindow.navigator);
  define('localStorage', forwardingStorage);
  for (const name of domNames) define(name, testWindow[name as keyof typeof testWindow]);
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define('fetch', async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }));
  // The desktop placement measures the minimap and status bar; none render here.
  define('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });

  ({ createRoot } = await import('react-dom/client'));
  ({ api } = await import('@/lib/api'));
  ({ default: QuestTracker } = await import('./quest-tracker'));

  const mutableApi = api as unknown as Record<string, unknown>;
  originalApi = { me: mutableApi.me, getMyAvatar: mutableApi.getMyAvatar };
  mutableApi.me = async () => null;
  mutableApi.getMyAvatar = async () => ({ avatar: null });
});

beforeEach(() => {
  testWindow.localStorage.clear();
  testWindow.sessionStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
  Reflect.deleteProperty(testWindow.navigator, 'maxTouchPoints');
  (testWindow as unknown as { matchMedia: typeof originalMatchMedia }).matchMedia = originalMatchMedia;
});

afterAll(() => {
  Object.assign(api as unknown as Record<string, unknown>, originalApi);
  testWindow.localStorage.clear();
  testWindow.sessionStorage.clear();
  storageTarget = null;
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  testWindow.close();
});

/** Mounts a logged-out tracker whose tour is already dismissed (the reload case). */
async function mountTourDismissed(): Promise<HTMLButtonElement> {
  testWindow.localStorage.setItem(TUTORIAL_KEY, 'true');
  expect(testWindow.localStorage.getItem(QUEST_INTRO_KEY)).toBeNull();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnMount: false } },
  });
  client.setQueryData(['avatar'], { avatar: null });
  client.setQueryData(['auth-me'], null);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const queryClient = client;
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client: queryClient }, createElement(QuestTracker)));
  });
  const header = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (!header) throw new Error('quest tracker header did not render');
  return header;
}

/** The touch placement's wrapper (the top-centre pill), or undefined on desktop. */
function touchWrapper(): HTMLElement | undefined {
  return Array.from(container?.querySelectorAll('div') ?? []).find((el) => el.className.includes('top-[7.75rem]'));
}

/** True when the touch placement is the one rendered. */
function touchPlacement(): boolean {
  return touchWrapper() !== undefined;
}

describe('QuestTracker first-visit auto-expand is decided by the live touch check', () => {
  test('a touch device mounting with the tour dismissed stays collapsed', async () => {
    setTouch(true);
    const header = await mountTourDismissed();
    // The touch placement rendered (the top-centre pill, not the left column).
    expect(touchPlacement()).toBe(true);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    // The intro still counts as shown, so a later poll cannot expand it either.
    expect(testWindow.localStorage.getItem(QUEST_INTRO_KEY)).toBe('true');
  });

  test('the expanded touch tracker stacks above the bottom-centre pill (z 45); collapsed it does not', async () => {
    setTouch(true);
    const header = await mountTourDismissed();
    const classes = () => touchWrapper()?.className.split(/\s+/) ?? [];
    expect(classes()).toContain('z-40');
    expect(classes()).not.toContain('z-[46]');

    await act(async () => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(classes()).toContain('z-[46]');
    expect(classes()).not.toContain('z-40');

    await act(async () => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(classes()).toContain('z-40');
    expect(classes()).not.toContain('z-[46]');
  });

  test('a desktop mounting with the tour dismissed still auto-expands', async () => {
    setTouch(false);
    const header = await mountTourDismissed();
    expect(touchPlacement()).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });
});
