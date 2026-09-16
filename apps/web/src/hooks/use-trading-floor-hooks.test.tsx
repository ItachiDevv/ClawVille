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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

import {
  getFloorClockDiagnosticsForTest,
  resetFloorClockForTest,
  useFloorConsumer,
  useFloorFeed,
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
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  resetFloorClockForTest();
  jest.useRealTimers();
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
