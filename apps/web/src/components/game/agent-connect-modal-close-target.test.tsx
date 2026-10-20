import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

// The connect modal's close "×" measured 10x28 px on staging (2026-10-20).
// Repo rule: touch tap targets >= 44px. The button now carries a 44x44
// minimum box (min-w-11 min-h-11) on every device.

mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, back() {}, refresh() {} }),
  usePathname: () => '/game',
  useSearchParams: () => new URLSearchParams(),
}));

const testWindow = new Window({ url: 'http://localhost/game', width: 1280, height: 800 });
const domNames = ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installed = ['window', 'document', 'navigator', 'localStorage', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...domNames] as const;
let previous = new Map<PropertyKey, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

let createRoot: typeof import('react-dom/client').createRoot;
let AgentConnectModal: typeof import('./agent-connect-modal').default;
let useGameStore: typeof import('@/stores/game').useGameStore;

let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;

beforeAll(async () => {
  previous = new Map(installed.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  define('window', testWindow);
  define('document', testWindow.document);
  define('navigator', testWindow.navigator);
  define('localStorage', testWindow.localStorage);
  for (const name of domNames) define(name, testWindow[name as keyof typeof testWindow]);
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define('fetch', async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }));

  ({ createRoot } = await import('react-dom/client'));
  ({ useGameStore } = await import('@/stores/game'));
  ({ default: AgentConnectModal } = await import('./agent-connect-modal'));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
  useGameStore.getState().setAgentConnectModalOpen(false);
});

afterAll(() => {
  testWindow.localStorage.clear();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  testWindow.close();
});

async function mountOpenModal(intent: 'connect' | 'login'): Promise<HTMLButtonElement> {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnMount: false } },
  });
  client.setQueryData(['avatar'], { avatar: null });
  client.setQueryData(['auth-me'], null);
  useGameStore.getState().setAgentConnectModalOpen(true, intent);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const queryClient = client;
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client: queryClient }, createElement(AgentConnectModal)));
  });
  const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close connect modal"]');
  if (!close) throw new Error('close button did not render');
  return close;
}

describe('AgentConnectModal close button tap target', () => {
  for (const intent of ['connect', 'login'] as const) {
    test(`has a 44x44 minimum box on the ${intent} surface`, async () => {
      const close = await mountOpenModal(intent);
      const classes = close.className.split(/\s+/);
      expect(classes).toContain('min-w-11');
      expect(classes).toContain('min-h-11');
      expect(close.textContent).toBe('×');
    });
  }

  test('a click on it still closes the modal', async () => {
    const close = await mountOpenModal('connect');
    expect(useGameStore.getState().agentConnectModalOpen).toBe(true);
    await act(async () => close.click());
    expect(useGameStore.getState().agentConnectModalOpen).toBe(false);
  });
});
