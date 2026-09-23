import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from 'bun:test';
import { StrictMode, act, createElement } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  environmentManager,
  focusManager,
} from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

import {
  HOUSE_TRADERS_POLL_MS,
  getFloorClockDiagnosticsForTest,
  resetFloorClockForTest,
  useFloorConsumer,
  useFloorFeed,
  useHouseTraders,
} from '@/hooks/use-trading-floor';
import { useTradeTickerStore } from '@/stores/trade-ticker';
import { useWorldStreamStore } from '@/stores/world-stream-state';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = ['Node', 'Element', 'HTMLElement', 'Event', 'MutationObserver'] as const;
const installedNames = [
  'window',
  'document',
  'navigator',
  'fetch',
  'IS_REACT_ACT_ENVIRONMENT',
  ...globalNames,
] as const;
let createRoot: typeof import('react-dom/client').createRoot;
let root: Root | null = null;
let container: HTMLElement | null = null;
let fetchCount = 0;
const queryClients = new Set<QueryClient>();
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

function Consumer({ visible = true }: { visible?: boolean }) {
  useFloorConsumer(visible);
  return null;
}

function Feed({ enabled = true }: { enabled?: boolean }) {
  useFloorFeed(enabled);
  return null;
}

function HouseTraders({ enabled = true }: { enabled?: boolean }) {
  useHouseTraders(enabled);
  return null;
}

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
    await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function feedTree(enabled = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  queryClients.add(client);
  return createElement(
    QueryClientProvider,
    { client },
    createElement(Feed, { enabled }),
  );
}

beforeAll(async () => {
  rememberDom();
  installDom();
  ({ createRoot } = await import('react-dom/client'));
});

beforeEach(() => {
  fetchCount = 0;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({
        trades: [],
        generatedAt: '2026-09-16T10:00:00.000Z',
        observer: { enabled: true, lastTickAt: null, stale: false },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  useWorldStreamStore.setState({ state: 'stopped', generation: 0, hasOpened: false });
  useTradeTickerStore.setState({ entries: [], seen: new Set(), dismissed: false, consumers: 0 });
  resetFloorClockForTest();
});

afterEach(async () => {
  await act(async () => {
    for (const client of queryClients) {
      await client.cancelQueries();
      client.clear();
    }
    queryClients.clear();
  });
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  resetFloorClockForTest();
  jest.useRealTimers();
  // Query notifications use a timer, not only a promise microtask. Drain that
  // queue while window still exists, including callbacks queued before unmount.
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('Trading Floor reconnect feed', () => {
  test('skips first live and refetches once after a synchronous recovery', async () => {
    await mount(feedTree());
    await flush();
    expect(fetchCount).toBe(1);

    await act(async () => useWorldStreamStore.getState().setStreamState('live'));
    await flush();
    expect(fetchCount).toBe(1);

    await act(async () => {
      useWorldStreamStore.getState().setStreamState('reconnecting');
      useWorldStreamStore.getState().setStreamState('live');
    });
    await flush();
    expect(fetchCount).toBe(2);
  });

  test('mount during reconnect refetches on the next live generation', async () => {
    useWorldStreamStore.getState().setStreamState('live');
    useWorldStreamStore.getState().setStreamState('reconnecting');
    await mount(feedTree());
    await flush();
    expect(fetchCount).toBe(1);

    await act(async () => useWorldStreamStore.getState().setStreamState('live'));
    await flush();
    expect(fetchCount).toBe(2);
  });

  test('disabled feed ignores reconnect generations', async () => {
    await mount(feedTree(false));
    await act(async () => {
      useWorldStreamStore.getState().setStreamState('live');
      useWorldStreamStore.getState().setStreamState('reconnecting');
      useWorldStreamStore.getState().setStreamState('live');
    });
    await flush();
    expect(fetchCount).toBe(0);
  });
});

describe('Trading Floor shared clock', () => {
  test('StrictMode setup and cleanup leaves one shared interval', async () => {
    jest.useFakeTimers();
    await mount(createElement(StrictMode, null, createElement(Consumer)));
    expect(getFloorClockDiagnosticsForTest()).toEqual({ subscribers: 1, intervalActive: true });
    expect(useTradeTickerStore.getState().consumers).toBe(1);
  });

  test('two consumers share one interval and the last unmount clears it', async () => {
    jest.useFakeTimers();
    await mount(createElement('div', null, createElement(Consumer), createElement(Consumer)));
    expect(getFloorClockDiagnosticsForTest()).toEqual({ subscribers: 2, intervalActive: true });
    expect(useTradeTickerStore.getState().consumers).toBe(2);
    await act(async () => root?.unmount());
    root = null;
    expect(getFloorClockDiagnosticsForTest()).toEqual({ subscribers: 0, intervalActive: false });
    expect(useTradeTickerStore.getState().consumers).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(getFloorClockDiagnosticsForTest().subscribers).toBe(0);
  });

  test('hiding the visible surface releases its consumer and clock', async () => {
    jest.useFakeTimers();
    await mount(createElement(Consumer));
    expect(getFloorClockDiagnosticsForTest().intervalActive).toBe(true);
    await act(async () => root?.render(createElement(Consumer, { visible: false })));
    expect(getFloorClockDiagnosticsForTest()).toEqual({ subscribers: 0, intervalActive: false });
    expect(useTradeTickerStore.getState().consumers).toBe(0);
  });
});

// THE POLL IS THE FEATURE. Without it this query fetched ONCE when the scene
// activated and never again: react-query refetches on mount, focus and
// reconnect, and a player standing in the Trading Floor watching the board
// triggers none of them, while `active` (from `useSceneActive()`) stays true
// the whole time so nothing remounts either. A risk pause could be merged
// server-side, the edge cache could drop to a second, and the open board would
// still show the snapshot it fetched on arrival. Found by tfs-audit.
describe('House trader polling', () => {
  /** Published to the teardown below, which has to drain THIS client before
   *  the fake timers come out. */
  let pollClient: QueryClient | null = null;

  function houseTree(enabled = true) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    queryClients.add(client);
    pollClient = client;
    return {
      client,
      node: createElement(
        QueryClientProvider,
        { client },
        createElement(HouseTraders, { enabled }),
      ),
    };
  }

  // WHY THE INTERVAL NEEDS `setIsServer`, and why that is test scaffolding
  // rather than a hole in the feature.
  //
  // query-core snapshots `var isServer = typeof window === "undefined"` at
  // MODULE LOAD (`utils.js:3`). Our harness does set `globalThis.window`, but
  // it does so in `beforeAll`, and the `import` at the top of this file has
  // already run by then — so the snapshot is `true` for the life of the
  // process. `QueryObserver.#updateRefetchInterval` returns on
  // `environmentManager.isServer()` at `queryObserver.js:211`, BEFORE it ever
  // reaches `setInterval`, and before the focus/background check on line 215.
  //
  // That single early return is why nothing I tried moved the needle: focus,
  // online, `refetchIntervalInBackground` and `gcTime` are all evaluated after
  // it, and my plain-`setInterval` control ticked because nothing gates it.
  // Diagnosed by tfs-audit and verified here against the installed package.
  //
  // A BROWSER HAS `window`, so `isServer` is false there and this gate does not
  // exist in production. The override restores the browser's answer; it does
  // not paper over a real condition. `setIsServer` is exported for exactly this
  // and is GLOBAL to the module, so it is restored in a `finally` AND an
  // `afterAll` — leaking `false` would make sibling suites start polling.
  const ORIGINAL_IS_SERVER = environmentManager.isServer();
  const restoreEnvironment = () =>
    environmentManager.setIsServer(() => ORIGINAL_IS_SERVER);

  /**
   * DRAIN BEFORE TEARING DOWN, and the ORDER is the whole fix.
   *
   * These tests install fake timers and then hand react-query a live interval.
   * The shared teardown unmounts and calls `useRealTimers()`, and if a
   * react-query notification is still queued at that moment it lands in an
   * unmounted tree after the file has finished, which bun surfaces as the
   * baffling `Cannot call describe() after the test run has completed`. It
   * reproduced 2 times in 12 before this hook existed, which is exactly the
   * cadence that gets a flake blamed on CI.
   *
   * So: cancel in flight work and clear the cache FIRST, so no observer is left
   * to notify; unmount SECOND, inside `act`, so React drains its own queue; and
   * only then let the real timers back in. `restoreEnvironment` runs last and
   * unconditionally, because `setIsServer` is global to the module and a leak
   * would make sibling files start polling.
   *
   * This hook runs BEFORE the file-level one (innermost first), so it finds the
   * root still mounted and leaves it null for the outer hook.
   */
  afterEach(async () => {
    if (pollClient) {
      const client = pollClient;
      await act(async () => {
        await client.cancelQueries();
        client.clear();
        await Promise.resolve();
      });
    }
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    pollClient = null;
    focusManager.setFocused(undefined);
    restoreEnvironment();
    jest.useRealTimers();
  });
  afterAll(restoreEnvironment);

  test('an untouched FOCUSED surface keeps re-reading the route on the interval', async () => {
    jest.useFakeTimers();
    focusManager.setFocused(true);
    environmentManager.setIsServer(() => false);
    try {
      const { node } = houseTree();
      await mount(node);
      await flush();
      expect(fetchCount).toBe(1);

      // Nothing happens here but time. No remount, no focus change, no
      // reconnect — the exact situation of a player standing in the room
      // watching the board, which fetched once and never again before the
      // interval landed.
      await act(async () => {
        jest.advanceTimersByTime(HOUSE_TRADERS_POLL_MS + 100);
      });
      await flush();
      expect(fetchCount).toBe(2);

      await act(async () => {
        jest.advanceTimersByTime(HOUSE_TRADERS_POLL_MS + 100);
      });
      await flush();
      expect(fetchCount).toBe(3);
    } finally {
      restoreEnvironment();
    }
  });

  // The other half of `refetchIntervalInBackground: false`, and it MEANS
  // something now: with `isServer` false the interval genuinely ticks, so an
  // unfocused tab not fetching is the background rule working rather than the
  // whole mechanism being inert. This assertion was deleted once for passing
  // vacuously; it is back because the vacuum is gone.
  test('a hidden tab stops polling', async () => {
    jest.useFakeTimers();
    focusManager.setFocused(false);
    environmentManager.setIsServer(() => false);
    try {
      const { node } = houseTree();
      await mount(node);
      await flush();
      const afterMount = fetchCount;
      await act(async () => {
        jest.advanceTimersByTime(HOUSE_TRADERS_POLL_MS * 4);
      });
      await flush();
      expect(fetchCount).toBe(afterMount);
    } finally {
      restoreEnvironment();
    }
  });

  test('a disabled surface does not fetch at all', async () => {
    jest.useFakeTimers();
    focusManager.setFocused(true);
    const { node } = houseTree(false);
    await mount(node);
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(HOUSE_TRADERS_POLL_MS * 4);
    });
    await flush();
    expect(fetchCount).toBe(0);
  });

  // The OPTIONS react-query actually received, read off the cache rather than
  // re-typed here. `staleTime` must not exceed the interval: a longer one
  // silently cancels the poll, because react-query serves the cached value and
  // the refetch becomes a no-op. And background polling stays off, so a hidden
  // tab costs nothing.
  test('the interval, the staleTime and the background rule are wired as intended', async () => {
    const { client, node } = houseTree();
    await mount(node);
    await flush();
    const entry = client
      .getQueryCache()
      .find({ queryKey: ['trading-floor', 'house-traders'] });
    const options = entry?.observers[0]?.options as
      | { refetchInterval?: number; staleTime?: number; refetchIntervalInBackground?: boolean }
      | undefined;
    expect(options?.refetchInterval).toBe(HOUSE_TRADERS_POLL_MS);
    expect(options?.staleTime).toBeLessThanOrEqual(HOUSE_TRADERS_POLL_MS);
    expect(options?.refetchIntervalInBackground).toBe(false);
  });
});
