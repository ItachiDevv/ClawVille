import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

// The quest tracker's reward sweep ran on mount for EVERY visitor. A logged-out
// visitor probed the serverOnly `on-the-board` quest (no prerequisites) and got
// one 401 per /game load (prod, 2026-10-01). The sweep now runs only for a
// resolved non-guest account, and again when one signs in later.

const testWindow = new Window({ url: 'http://localhost/game', width: 1280, height: 800 });
const domNames = ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installed = ['window', 'document', 'navigator', 'localStorage', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...domNames] as const;
let previous = new Map<PropertyKey, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

// The quest store binds its persist storage ONCE, when the module first loads,
// and bun shares that module with any later test file in the same process
// (quest-restore.test.ts reads its own localStorage shim). So the store gets a
// forwarder: the happy-dom storage while this file runs, then whatever
// `globalThis.localStorage` is at call time.
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

type ApiModule = typeof import('@/lib/api');
type QuestStoreModule = typeof import('@/stores/quest');

let createRoot: typeof import('react-dom/client').createRoot;
let QuestTracker: typeof import('./quest-tracker').default;
let api: ApiModule['api'];
let useQuestStore: QuestStoreModule['useQuestStore'];
let originalApi: Partial<Record<'me' | 'claimTutorialQuest' | 'getTutorialQuestClaims' | 'getMyAvatar', unknown>> = {};
const originalWarn = console.warn;

let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;
/** Ordered log of the quest calls: `restore` or `claim:<questId>`. */
let calls: string[] = [];
let fetched: string[] = [];
/** The status the mocked claim route answers with. */
let claimStatus = 401;
let meImpl: () => Promise<unknown> = () => Promise.resolve(null);

const claims = () => calls.filter((call) => call.startsWith('claim:'));

beforeAll(async () => {
  previous = new Map(installed.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  define('window', testWindow);
  define('document', testWindow.document);
  define('navigator', testWindow.navigator);
  define('localStorage', forwardingStorage);
  for (const name of domNames) define(name, testWindow[name as keyof typeof testWindow]);
  define('IS_REACT_ACT_ENVIRONMENT', true);
  // Belt: any request that slips past the api mocks below is recorded.
  define('fetch', async (input: RequestInfo | URL) => {
    fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  });
  // The store logs every rejected claim; keep the test output readable.
  console.warn = () => {};

  ({ createRoot } = await import('react-dom/client'));
  ({ api } = await import('@/lib/api'));
  ({ useQuestStore } = await import('@/stores/quest'));
  ({ default: QuestTracker } = await import('./quest-tracker'));

  const mutableApi = api as unknown as Record<string, unknown>;
  originalApi = {
    me: mutableApi.me,
    claimTutorialQuest: mutableApi.claimTutorialQuest,
    getTutorialQuestClaims: mutableApi.getTutorialQuestClaims,
    getMyAvatar: mutableApi.getMyAvatar,
  };
  mutableApi.me = () => meImpl();
  mutableApi.getMyAvatar = async () => ({ avatar: null });
  // honoRequest throws on every non-2xx; mirror that shape.
  mutableApi.claimTutorialQuest = async (questId: string) => {
    calls.push(`claim:${questId}`);
    throw Object.assign(new Error(`HTTP ${claimStatus}`), { status: claimStatus });
  };
  mutableApi.getTutorialQuestClaims = async () => {
    calls.push('restore');
    return { ok: true, userId: useQuestStore.getState().ownerUserId, claims: [] };
  };
});

beforeEach(() => {
  calls = [];
  fetched = [];
  claimStatus = 401;
  meImpl = () => Promise.resolve(null);
  testWindow.localStorage.clear();
  useQuestStore.setState({ ownerUserId: null, serverClaimed: {} });
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
  console.warn = originalWarn;
  // Hand the shared store back clean: default state, no sync dedup marker.
  useQuestStore.getState().resetQuestStore();
  testWindow.localStorage.clear();
  storageTarget = null;
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  testWindow.close();
});

/** Lets the async restore-then-sweep chain run to the end. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** Mounts the tracker. `seed` primes the query cache; omit `auth-me` to leave it loading. */
async function mount(seed: (queryClient: QueryClient) => void): Promise<QueryClient> {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnMount: false } },
  });
  client.setQueryData(['avatar'], { avatar: null });
  seed(client);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const queryClient = client;
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client: queryClient }, createElement(QuestTracker)));
  });
  await settle();
  return queryClient;
}

async function setAuthMe(queryClient: QueryClient, value: unknown): Promise<void> {
  await act(async () => {
    queryClient.setQueryData(['auth-me'], value);
  });
  await settle();
}

describe('QuestTracker reward sweep runs only for a viewer who can claim', () => {
  test('a logged-out visitor (auth-me null) sends no tutorial claim', async () => {
    await mount((queryClient) => queryClient.setQueryData(['auth-me'], null));
    expect(claims()).toEqual([]);
    expect(fetched.filter((url) => url.includes('/api/quests/tutorial/'))).toEqual([]);
  });

  test('a guest-tier account sends no tutorial claim', async () => {
    claimStatus = 403;
    await mount((queryClient) => queryClient.setQueryData(['auth-me'], { user: { id: 'guest-1', isGuest: true } }));
    expect(claims()).toEqual([]);
  });

  test('a signed-in account restores first, then sweeps once, and sweeps again after a new sign-in', async () => {
    claimStatus = 400; // engagement_required: terminal, the sweep moves on
    useQuestStore.getState().setQuestOwner('acc-1');
    const queryClient = await mount((qc) => qc.setQueryData(['auth-me'], { user: { id: 'acc-1', isGuest: false } }));
    expect(claims()).toContain('claim:on-the-board');
    expect(calls[0]).toBe('restore');
    const firstSweep = claims().length;

    // A refetch of the same account (a new object, same id) is not a new sweep.
    await setAuthMe(queryClient, { user: { id: 'acc-1', isGuest: false } });
    expect(claims()).toHaveLength(firstSweep);

    // Signed out, then signed in again: that is a new sign-in.
    await setAuthMe(queryClient, null);
    expect(claims()).toHaveLength(firstSweep);
    await setAuthMe(queryClient, { user: { id: 'acc-1', isGuest: false } });
    expect(claims()).toHaveLength(firstSweep * 2);
  });

  test('a visitor who signs in after mount gets the sweep then', async () => {
    claimStatus = 400;
    const queryClient = await mount((qc) => qc.setQueryData(['auth-me'], null));
    expect(claims()).toEqual([]);

    await setAuthMe(queryClient, { user: { id: 'acc-2', isGuest: false } });
    expect(claims()).toContain('claim:on-the-board');
  });

  test('no sweep while auth-me loads or fails; one sweep when it resolves to an account', async () => {
    claimStatus = 400;
    let resolveMe: (value: unknown) => void = () => {};
    meImpl = () => new Promise((resolve) => { resolveMe = resolve; });
    const queryClient = await mount(() => {});
    expect(claims()).toEqual([]);

    await act(async () => resolveMe({ user: { id: 'acc-3', isGuest: false } }));
    await settle();
    expect(claims()).toContain('claim:on-the-board');
    const afterResolve = claims().length;

    // A transient refetch failure keeps the cached account: no second sweep.
    meImpl = () => Promise.reject(new Error('network'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['auth-me'] }).catch(() => {});
    });
    await settle();
    expect(claims()).toHaveLength(afterResolve);
  });

  test('a transient auth-me error with no cached payload does not sweep', async () => {
    meImpl = () => Promise.reject(new Error('network'));
    await mount(() => {});
    expect(claims()).toEqual([]);
  });
});
