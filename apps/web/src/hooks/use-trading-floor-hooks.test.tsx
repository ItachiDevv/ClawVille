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
  FLOOR_FEED_POLL_MS,
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

// query-core snapshots isServer at module load, before beforeAll installs
// window; see "House trader polling" below. Tests that need a polling
// interval override it, and the shared afterEach puts this value back.
const ORIGINAL_IS_SERVER = environmentManager.isServer();
const restoreEnvironment = () =>
  environmentManager.setIsServer(() => ORIGINAL_IS_SERVER);

/**
 * THE CI FLAKE (2026-10-02..04, runs 36959793747, 36964280639, 37104931394,
 * 37191658763): bun 1.3.11 (pinned in gates.yml) compares the per-test and
 * per-hook timeout deadline, which is on the REAL monotonic clock (time since
 * boot), against the MOCKED clock while fake timers are on. The mocked clock
 * starts near 0 and `advanceTimersByTime` moves it. When a test advances past
 * `uptime + timeout`, bun declares a timeout the test never had, moves on, and
 * the abandoned body keeps running: overlapping act() scopes, a tree that is
 * never unmounted, fake timers left on. A fresh CI VM has a few minutes of
 * uptime, so the feed test (120 s of fake time) crossed it on some first
 * attempts; a workstation has days, so it never reproduced locally. Measured
 * under bun 1.3.11 on Linux: advance = uptime + 8 s fails 3 of 3 with the
 * default 5 s timeout and passes 3 of 3 with a timeout above the advance.
 * Upstream fix: oven-sh/bun#30599 / #33896.
 *
 * So every test that advances the fake clock declares a timeout ABOVE its own
 * total advance. The deadline is then `uptime + advance + margin`, which the
 * mocked clock cannot reach whatever the uptime is.
 */
function fakeClockTimeout(totalAdvanceMs: number): number {
  return totalAdvanceMs + 30_000;
}

/** Real event-loop turns (setImmediate is not faked by bun) until no query of
 *  this client is in flight. Bounded, so a stuck fetch fails loudly here. */
async function settleFetches(client: QueryClient): Promise<void> {
  for (let turn = 0; turn < 50 && client.isFetching() > 0; turn += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  expect(client.isFetching()).toBe(0);
}

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

/**
 * ONE teardown for every test, so it runs even when the test body throws.
 *
 * Real timers come back FIRST and synchronously, before any await: under fake
 * timers bun 1.3.11 measures this hook's own timeout against the mocked clock
 * (see fakeClockTimeout). Callbacks still parked on the fake heap never fire
 * after that; anything cancel/clear/unmount queues lands on the real heap and
 * the final setTimeout(0) drains it while window still exists.
 *
 * Focus and isServer are restored AFTER the unmount (no client is subscribed
 * any more, so the focus change cannot trigger a refetch) and in a finally, so
 * a failed unmount cannot leak `isServer: false` into the next test.
 */
afterEach(async () => {
  jest.useRealTimers();
  try {
    await act(async () => {
      for (const client of queryClients) {
        await client.cancelQueries();
        client.clear();
      }
    });
    if (root) await act(async () => root?.unmount());
  } finally {
    queryClients.clear();
    container?.remove();
    root = null;
    container = null;
    resetFloorClockForTest();
    focusManager.setFocused(undefined);
    restoreEnvironment();
  }
  // Query notifications use a timer, not only a promise microtask. Drain that
  // queue while window still exists, including callbacks queued before unmount.
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
});

afterAll(() => {
  restoreEnvironment();
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

  // A cold /trading-floor load never opens the world stream, so the poll is
  // the floor's only refresh there; with a live stream (/game) it stays off.
  // Teardown (real timers, unmount, focus, isServer) is the shared afterEach.
  test('the feed polls while the stream is not live and stops once it is', async () => {
    jest.useFakeTimers();
    focusManager.setFocused(true);
    // See "House trader polling" below: query-core snapshots isServer at
    // module load, before this harness installs window.
    environmentManager.setIsServer(() => false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    queryClients.add(client);
    await mount(createElement(QueryClientProvider, { client }, createElement(Feed)));
    await flush();
    // The interval tick dedupes into a fetch still in flight, so the first
    // read must have landed before the clock moves.
    await settleFetches(client);
    expect(fetchCount).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(FLOOR_FEED_POLL_MS + 100);
    });
    await flush();
    await settleFetches(client);
    expect(fetchCount).toBe(2);

    // The first live: no reconnect refetch (hasOpened only), and no poll.
    await act(async () => useWorldStreamStore.getState().setStreamState('live'));
    await flush();
    const whenLive = fetchCount;
    await act(async () => {
      jest.advanceTimersByTime(FLOOR_FEED_POLL_MS * 3);
    });
    await flush();
    expect(fetchCount).toBe(whenLive);
  }, fakeClockTimeout(FLOOR_FEED_POLL_MS + 100 + FLOOR_FEED_POLL_MS * 3));

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
  }, fakeClockTimeout(60_000));

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
  function houseTree(enabled = true) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    queryClients.add(client);
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
  // and is GLOBAL to the module, so the file-level afterEach AND afterAll
  // restore it (`restoreEnvironment`) — leaking `false` would make sibling
  // suites start polling.
  //
  // Teardown for these tests is the file-level afterEach: real timers first,
  // then cancel + clear + unmount inside act, then a real setTimeout(0) drain,
  // so no react-query notification lands after the file has finished (the old
  // `Cannot call describe() after the test run has completed`).

  test('an untouched FOCUSED surface keeps re-reading the route on the interval', async () => {
    jest.useFakeTimers();
    focusManager.setFocused(true);
    environmentManager.setIsServer(() => false);
    const { client, node } = houseTree();
    await mount(node);
    await flush();
    await settleFetches(client);
    expect(fetchCount).toBe(1);

    // Nothing happens here but time. No remount, no focus change, no
    // reconnect — the exact situation of a player standing in the room
    // watching the board, which fetched once and never again before the
    // interval landed.
    await act(async () => {
      jest.advanceTimersByTime(HOUSE_TRADERS_POLL_MS + 100);
    });
    await flush();
    await settleFetches(client);
    expect(fetchCount).toBe(2);

    await act(async () => {
      jest.advanceTimersByTime(HOUSE_TRADERS_POLL_MS + 100);
    });
    await flush();
    expect(fetchCount).toBe(3);
  }, fakeClockTimeout((HOUSE_TRADERS_POLL_MS + 100) * 2));

  // The other half of `refetchIntervalInBackground: false`, and it MEANS
  // something now: with `isServer` false the interval genuinely ticks, so an
  // unfocused tab not fetching is the background rule working rather than the
  // whole mechanism being inert. This assertion was deleted once for passing
  // vacuously; it is back because the vacuum is gone.
  test('a hidden tab stops polling', async () => {
    jest.useFakeTimers();
    focusManager.setFocused(false);
    environmentManager.setIsServer(() => false);
    const { node } = houseTree();
    await mount(node);
    await flush();
    const afterMount = fetchCount;
    await act(async () => {
      jest.advanceTimersByTime(HOUSE_TRADERS_POLL_MS * 4);
    });
    await flush();
    expect(fetchCount).toBe(afterMount);
  }, fakeClockTimeout(HOUSE_TRADERS_POLL_MS * 4));

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
  }, fakeClockTimeout(HOUSE_TRADERS_POLL_MS * 4));

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
