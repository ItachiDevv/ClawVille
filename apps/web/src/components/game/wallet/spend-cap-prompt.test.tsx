import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

// The spend-cap prompt is an early setup step: only a signed-in, non-guest human
// with unset caps sees it, never over the one-time backup modal, and never
// after "Set later" in the same browser session. Blocked storage must not throw.

const testWindow = new Window({ url: 'http://localhost/game', width: 1280, height: 800 });
const domNames = ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installed = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...domNames] as const;
let previous = new Map<PropertyKey, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

type Policy = { configured: boolean };
let createRoot: typeof import('react-dom/client').createRoot;
let SpendCapPrompt: typeof import('./spend-cap-prompt').default;
let readSessionFlag: typeof import('./spend-cap-prompt').readSessionFlag;
let FIRST_TIME_KEY: string;
let api: typeof import('@/lib/api').api;
let originalApi: Record<string, unknown> = {};
let me: unknown = null;
let policy: Policy = { configured: false };
let policyCalls = 0;

let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;

beforeAll(async () => {
  previous = new Map(installed.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  define('window', testWindow);
  define('document', testWindow.document);
  define('navigator', testWindow.navigator);
  for (const name of domNames) define(name, testWindow[name as keyof typeof testWindow]);
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define('fetch', async () => new Response('{}', { status: 404 }));
  ({ createRoot } = await import('react-dom/client'));
  ({ api } = await import('@/lib/api'));
  ({ FIRST_TIME_DISCLOSURE_STORAGE_KEY: FIRST_TIME_KEY } = await import('@/components/game/first-time-backup-modal'));
  ({ default: SpendCapPrompt, readSessionFlag } = await import('./spend-cap-prompt'));
  const mutableApi = api as unknown as Record<string, unknown>;
  originalApi = { me: mutableApi.me, getSpendPolicy: mutableApi.getSpendPolicy };
  mutableApi.me = async () => me;
  mutableApi.getSpendPolicy = async () => {
    policyCalls += 1;
    return {
      dailyCapUsdCents: policy.configured ? 100 : null,
      perCallCapUsdCents: policy.configured ? 10 : null,
      allowedVendors: [],
      configured: policy.configured,
      updatedAt: null,
    };
  };
});

beforeEach(() => {
  me = { user: { id: 'user-1', isGuest: false } };
  policy = { configured: false };
  policyCalls = 0;
  testWindow.sessionStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

afterAll(() => {
  Object.assign(api as unknown as Record<string, unknown>, originalApi);
  testWindow.sessionStorage.clear();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  testWindow.close();
});

async function mount(): Promise<void> {
  container = testWindow.document.createElement('div') as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client: client! }, createElement(SpendCapPrompt)));
  });
  // Two chained queries (auth-me, then the policy) resolve across macrotasks.
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const dialog = () => container?.querySelector('[role="dialog"]') ?? null;

describe('SpendCapPrompt', () => {
  test('shows for a signed-in human whose caps are not set', async () => {
    await mount();
    expect(dialog()).not.toBeNull();
    expect(container?.textContent).toContain("Set your agent's spend caps");
  });

  test('stays hidden for a guest and never asks for the policy', async () => {
    me = { user: { id: 'guest-1', isGuest: true } };
    await mount();
    expect(dialog()).toBeNull();
    expect(policyCalls).toBe(0);
  });

  test('stays hidden when signed out', async () => {
    me = null;
    await mount();
    expect(dialog()).toBeNull();
    expect(policyCalls).toBe(0);
  });

  test('stays hidden when the caps are set', async () => {
    policy = { configured: true };
    await mount();
    expect(dialog()).toBeNull();
  });

  test('waits while the one-time backup modal is pending', async () => {
    testWindow.sessionStorage.setItem(FIRST_TIME_KEY, '{}');
    await mount();
    expect(dialog()).toBeNull();
  });

  test('"Set later" hides it for the browser session', async () => {
    await mount();
    const later = [...(container?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Set later');
    expect(later).toBeDefined();
    await act(async () => {
      later!.dispatchEvent(new testWindow.MouseEvent('click', { bubbles: true }) as unknown as Event);
    });
    expect(dialog()).toBeNull();
    expect(testWindow.sessionStorage.getItem('clawville:spendCapPromptDismissed')).toBe('1');
  });
});

describe('readSessionFlag', () => {
  test('returns false when the sessionStorage getter throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(testWindow, 'sessionStorage');
    Object.defineProperty(testWindow, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(readSessionFlag('any')).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(testWindow, 'sessionStorage', descriptor);
      else Reflect.deleteProperty(testWindow, 'sessionStorage');
    }
  });
});
