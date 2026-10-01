import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';

import { useFloorArenaUi } from '@/stores/floor-arena-ui';

// GET /api/floor/arena/me answers a guest or a logged-out visitor with 401 (a
// red console error). useIsGuest() reads false while auth-me is still loading,
// so the arena section waits for auth-me to resolve, like the floor tab does.
// The harness derives isGuest from useIsGuest(), as trading-floor-tab.tsx does.

const testWindow = new Window({ url: 'http://localhost/trading-floor' });
const globalNames = ['Node', 'Element', 'HTMLElement', 'HTMLAnchorElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installedNames = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...globalNames] as const;
let createRoot: typeof import('react-dom/client').createRoot;
let FloorArenaSection: typeof import('./arena-section').FloorArenaSection;
let useIsGuest: typeof import('@/hooks/use-is-guest').useIsGuest;
let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
let requests: string[] = [];
let meBody: Record<string, unknown> = { agent: null };
let resolveAuth: (status: number, body: unknown) => void = () => undefined;
let authAnswer: Promise<{ status: number; body: unknown }> = Promise.resolve({ status: 200, body: null });

function installDom(): void {
  previousDescriptors = new Map(installedNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: testWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: testWindow.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: testWindow.navigator });
  for (const name of globalNames) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: testWindow[name as keyof typeof testWindow],
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
}

function restoreDom(): void {
  for (const [name, descriptor] of previousDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

const arenaMeCalls = () => requests.filter((url) => url.endsWith('/api/floor/arena/me')).length;
const authMeCalls = () => requests.filter((url) => url.endsWith('/api/auth/me')).length;

async function settle(ms = 10): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 300; index += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The floor tab's wiring: isGuest from useIsGuest(), passed down. */
function Harness() {
  const isGuest = useIsGuest();
  return createElement(FloorArenaSection, { active: true, isGuest, onGuestBlocked: () => undefined });
}

async function render(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client: client! }, element));
  });
  return container;
}

beforeAll(async () => {
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ FloorArenaSection } = await import('./arena-section'));
  ({ useIsGuest } = await import('@/hooks/use-is-guest'));
});

beforeEach(() => {
  requests = [];
  meBody = { agent: null };
  authAnswer = new Promise((resolve) => {
    resolveAuth = (status, body) => resolve({ status, body });
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string) => {
      const url = String(input);
      requests.push(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/api/auth/me')) {
        const { status, body } = await authAnswer;
        return json(body, status);
      }
      if (url.endsWith('/api/floor/arena/me')) return json(meBody);
      if (url.includes('/leaderboard')) return json({ rows: [] });
      if (url.includes('/templates')) return json({ houseAgents: [] });
      if (url.includes('/addons')) return json({ addons: [], paymentsEnabled: false });
      if (url.includes('/events')) return json({ events: [] });
      return json({});
    },
  });
  useFloorArenaUi.setState({
    panel: 'overview',
    profileAgentId: null,
    launchTemplateId: null,
    localSeatIndex: -1,
    myAgent: 'unknown',
    seatWriteVersion: 0,
    launched: null,
  });
});

afterEach(async () => {
  // Never leave a fetch hanging into the next test.
  resolveAuth(401, { error: 'Unauthorized' });
  await act(async () => {
    await client?.cancelQueries();
    client?.clear();
  });
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  client = null;
  await settle(0);
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('Arena section: GET /me waits for resolved auth (no 401 for a guest)', () => {
  test('while auth-me loads there is no GET /me; a resolved player then gets exactly one', async () => {
    await render(createElement(Harness));
    await waitFor(() => authMeCalls() === 1, 'the auth-me request');
    await settle(50);
    expect(arenaMeCalls()).toBe(0);

    resolveAuth(200, { user: { id: 'u1', isGuest: false } });
    await waitFor(() => arenaMeCalls() > 0, 'GET /me after auth resolved');
    await settle(50);
    expect(arenaMeCalls()).toBe(1);
    expect(authMeCalls()).toBe(1);
  });

  test('a guest session never asks for GET /me, before or after auth-me resolves', async () => {
    await render(createElement(Harness));
    await waitFor(() => authMeCalls() === 1, 'the auth-me request');
    await settle(50);
    expect(arenaMeCalls()).toBe(0);

    resolveAuth(200, { user: { id: 'g1', isGuest: true } });
    await settle(100);
    expect(arenaMeCalls()).toBe(0);
  });

  test('a logged-out visitor (auth-me 401) never asks for GET /me', async () => {
    await render(createElement(Harness));
    await waitFor(() => authMeCalls() === 1, 'the auth-me request');
    resolveAuth(401, { error: 'Unauthorized' });
    await settle(100);
    expect(arenaMeCalls()).toBe(0);
  });

  test('a viewer already known as a guest asks for neither auth-me nor GET /me from this panel', async () => {
    await render(createElement(FloorArenaSection, { active: true, isGuest: true, onGuestBlocked: () => undefined }));
    await settle(100);
    expect(authMeCalls()).toBe(0);
    expect(arenaMeCalls()).toBe(0);
  });

  test('the desk panel shows the wait while auth loads, never the launch form, then the owner desk', async () => {
    meBody = {
      agent: {
        id: '11111111-2222-4333-8444-555555555555',
        kind: 'user',
        name: 'My Genesis',
        templateId: 'genesis',
        params: FLOOR_ARENA_TEMPLATES[0]!.params,
        paramsVersion: 1,
        mode: 'paper',
        status: 'active',
        seated: false,
        seatIndex: null,
        paymentAddress: null,
        provisionState: 'ready',
        addons: [],
        autoApplySuggestions: false,
      },
      paymentAddress: null,
      provision: { state: 'ready', error: null },
      wallet: null,
      addons: [],
      stats: null,
      latestReport: null,
    };
    useFloorArenaUi.setState({ panel: 'desk' });
    const host = await render(createElement(Harness));
    await waitFor(() => authMeCalls() === 1, 'the auth-me request');
    await settle(50);
    expect(host.textContent).toContain('Loading your arena trader...');
    expect(host.querySelector('[data-testid="arena-launch"]')).toBeNull();

    resolveAuth(200, { user: { id: 'u1', isGuest: false } });
    await waitFor(() => !(host.textContent ?? '').includes('Loading your arena trader...'), 'the desk to load');
    expect(arenaMeCalls()).toBe(1);
    expect(host.querySelector('[data-testid="arena-launch"]')).toBeNull();
    expect(host.textContent).toContain('My Genesis');
  });
});
