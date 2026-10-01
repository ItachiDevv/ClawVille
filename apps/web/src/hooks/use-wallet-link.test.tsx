import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

import { useWalletLink } from '@/hooks/use-wallet-link';

// Browser verify 2026-10-01 F1: a guest on the Trading Floor tab fired
// GET /api/wallet/link, the route answered 401, and the browser logged a red
// console error on every guest visit.

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'Node',
  'Element',
  'HTMLElement',
  'HTMLAnchorElement',
  'Event',
  'MouseEvent',
  'MutationObserver',
] as const;
const installedNames = [
  'window',
  'document',
  'navigator',
  'fetch',
  'IS_REACT_ACT_ENVIRONMENT',
  ...globalNames,
] as const;

let createRoot: typeof import('react-dom/client').createRoot;
let TradingFloorTab: typeof import('@/components/game/trading-floor/trading-floor-tab').TradingFloorTab;
let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient | null = null;
let fetched: string[] = [];
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

function rememberDom(): void {
  previousDescriptors = new Map(
    installedNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
}

function restoreDom(): void {
  for (const [name, descriptor] of previousDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

function installDom(): void {
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

function pathOf(url: string): string {
  return new URL(url, 'http://localhost').pathname;
}

function walletLinkReads(): number {
  return fetched.filter((url) => pathOf(url) === '/api/wallet/link').length;
}

// The three Trading Floor tab reads a guest or a logged-out visitor must not
// send (each answers them 401).
const OWN_READ_PATHS = ['/api/wallet/link', '/api/exchange/trades/mine', '/api/exchange/wallets/mine'] as const;
const OWN_READ_KEYS = [['wallet-link'], ['trading-floor', 'mine'], ['trading-floor', 'wallets']] as const;

function ownReads(): number {
  return fetched.filter((url) => (OWN_READ_PATHS as readonly string[]).includes(pathOf(url))).length;
}

// When true, GET /api/auth/me stays in flight until releaseAuthMe() runs.
let holdAuthMe = false;
let releaseAuthMe: (() => void) | null = null;
const SIGNED_IN = { user: { id: 'user-1', isGuest: false } };
const GUEST = { user: { id: 'guest-1', isGuest: true } };

function newClient(): QueryClient {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnMount: false },
      mutations: { retry: false },
    },
  });
  return queryClient;
}

async function render(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client: queryClient! }, node));
  });
}

async function tick(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

/** The request starts after an async header step, so wait (bounded) for it. */
async function waitForWalletLinkReads(count: number, budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (walletLinkReads() < count && Date.now() < deadline) await tick();
  for (let index = 0; index < 5; index += 1) await tick();
}

/**
 * The deterministic "never asked" signal: a disabled query never starts a
 * fetch, so its cache entry stays idle with no data and no error update.
 */
function expectWalletLinkNeverFetched(): void {
  const state = queryClient!.getQueryCache().find({ queryKey: ['wallet-link'] })?.state;
  expect(state?.fetchStatus ?? 'idle').toBe('idle');
  expect(state?.dataUpdateCount ?? 0).toBe(0);
  expect(state?.errorUpdateCount ?? 0).toBe(0);
  expect(walletLinkReads()).toBe(0);
}

function Probe({ enabled }: { enabled?: boolean }) {
  useWalletLink(enabled === undefined ? undefined : { enabled });
  return null;
}

function installFetch(): void {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      const path = pathOf(url);
      if (path === '/api/wallet/link') return json({ linked: false, walletPubkey: null, clv: null });
      if (path === '/api/exchange/trades/mine') return json({ trades: [] });
      if (path === '/api/exchange/wallets/mine') return json({ wallets: [] });
      if (path === '/api/auth/me') {
        if (holdAuthMe) await new Promise<void>((resolve) => { releaseAuthMe = resolve; });
        return json(SIGNED_IN);
      }
      return new Response(JSON.stringify({ error: 'not in this test' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

beforeAll(async () => {
  rememberDom();
  installDom();
  installFetch();
  ({ createRoot } = await import('react-dom/client'));
  ({ TradingFloorTab } = await import('@/components/game/trading-floor/trading-floor-tab'));
  // Warm the async header step once, so a later read is not still pending
  // when a "no read" test looks at the count.
  const { api } = await import('@/lib/api');
  await api.getWalletLink().catch(() => undefined);
});

beforeEach(() => {
  fetched = [];
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  queryClient?.clear();
  queryClient = null;
  holdAuthMe = false;
  releaseAuthMe?.();
  releaseAuthMe = null;
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('useWalletLink enabled option', () => {
  test('with no option the hook reads the linked wallet (every other caller is unchanged)', async () => {
    newClient();
    await render(createElement(Probe));
    await waitForWalletLinkReads(1);
    expect(walletLinkReads()).toBe(1);
  });

  test('enabled: false sends no request', async () => {
    newClient();
    await render(createElement(Probe, { enabled: false }));
    await waitForWalletLinkReads(1, 300);
    expectWalletLinkNeverFetched();
  });
});

/** What the tab reads that is not one of the three personal reads. */
function seedShared(client: QueryClient): void {
  client.setQueryData(['avatar'], { avatar: { walletAddress: null } });
  client.setQueryData(['trading-floor', 'feed', 25], {
    trades: [], generatedAt: new Date().toISOString(),
    observer: { enabled: true, stale: false, lastTickAt: null },
  });
  client.setQueryData(['trading-floor', 'house-traders'], []);
}

describe('Trading Floor tab: no wallet-link read for a guest (F1)', () => {
  function seed(client: QueryClient, auth: unknown): void {
    // Everything the tab reads except ['wallet-link'], so only the gate decides that read.
    seedShared(client);
    client.setQueryData(['auth-me'], auth);
    client.setQueryData(['trading-floor', 'wallets'], { wallets: [] });
    client.setQueryData(['trading-floor', 'mine'], { trades: [] });
  }

  test('a guest on the active tab sends no GET /api/wallet/link', async () => {
    seed(newClient(), GUEST);
    await render(createElement(TradingFloorTab, { active: true, isGuest: true, onGuestBlocked: () => {} }));
    await waitForWalletLinkReads(1, 300);
    expectWalletLinkNeverFetched();
  });

  test('a signed-in player on the active tab still reads the linked wallet once', async () => {
    seed(newClient(), SIGNED_IN);
    await render(createElement(TradingFloorTab, { active: true, isGuest: false, onGuestBlocked: () => {} }));
    await waitForWalletLinkReads(1);
    expect(walletLinkReads()).toBe(1);
  });

  test('an inactive tab sends no wallet-link read', async () => {
    seed(newClient(), SIGNED_IN);
    await render(createElement(TradingFloorTab, { active: false, isGuest: false, onGuestBlocked: () => {} }));
    await waitForWalletLinkReads(1, 300);
    expectWalletLinkNeverFetched();
  });
});

// useIsGuest() reads false while auth-me is still loading, so the tab fired
// all three personal reads in that window and each answered 401.
describe('Trading Floor tab: the three personal reads wait for auth-me', () => {
  async function waitForOwnReads(count: number, budgetMs = 3_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (ownReads() < count && Date.now() < deadline) await tick();
    for (let index = 0; index < 5; index += 1) await tick();
  }

  function expectNoOwnReads(): void {
    for (const queryKey of OWN_READ_KEYS) {
      const state = queryClient!.getQueryCache().find({ queryKey: [...queryKey] })?.state;
      expect(state?.fetchStatus ?? 'idle').toBe('idle');
      expect(state?.dataUpdateCount ?? 0).toBe(0);
      expect(state?.errorUpdateCount ?? 0).toBe(0);
    }
    expect(ownReads()).toBe(0);
  }

  function expectEachOwnReadOnce(): void {
    for (const path of OWN_READ_PATHS) {
      expect(fetched.filter((url) => pathOf(url) === path)).toHaveLength(1);
    }
  }

  test('while auth-me is loading the tab sends none of them; they start once it resolves to a player', async () => {
    holdAuthMe = true;
    seedShared(newClient());
    // isGuest is what useIsGuest() returns while auth-me loads: false.
    await render(createElement(TradingFloorTab, { active: true, isGuest: false, onGuestBlocked: () => {} }));
    await waitForOwnReads(1, 300);
    expect(queryClient!.getQueryState(['auth-me'])?.fetchStatus).toBe('fetching');
    expectNoOwnReads();
    expect(document.body.textContent).toContain('Loading verified trades...');

    await act(async () => { releaseAuthMe?.(); });
    await waitForOwnReads(OWN_READ_PATHS.length);
    expectEachOwnReadOnce();
  });

  test('a guest account (auth-me resolved, isGuest) sends none of them', async () => {
    const client = newClient();
    seedShared(client);
    client.setQueryData(['auth-me'], GUEST);
    await render(createElement(TradingFloorTab, { active: true, isGuest: true, onGuestBlocked: () => {} }));
    await waitForOwnReads(1, 300);
    expectNoOwnReads();
  });

  test('a logged-out visitor (auth-me null) sends none of them', async () => {
    const client = newClient();
    seedShared(client);
    client.setQueryData(['auth-me'], null);
    await render(createElement(TradingFloorTab, { active: true, isGuest: true, onGuestBlocked: () => {} }));
    await waitForOwnReads(1, 300);
    expectNoOwnReads();
  });

  test('a resolved signed-in player sends each of them once', async () => {
    const client = newClient();
    seedShared(client);
    client.setQueryData(['auth-me'], SIGNED_IN);
    await render(createElement(TradingFloorTab, { active: true, isGuest: false, onGuestBlocked: () => {} }));
    await waitForOwnReads(OWN_READ_PATHS.length);
    expectEachOwnReadOnce();
  });
});
