import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { FLOOR_ARENA_HOUSE_AGENTS } from '@clawville/shared';

import {
  FLOOR_ARENA_HOUSE_BOARD_POLL_MS,
  fetchFloorArenaHouseBoard,
  floorArenaHouseBoardKey,
  floorArenaHouseBoardQueryOptions,
  readHouseBoard,
  useFloorArenaHouseBoard,
} from '@/hooks/use-floor-arena-house-board';
import { FloorArenaApiError } from '@/hooks/use-floor-arena';

// P15 T1: the web hook of GET /api/floor/arena/house-board (plan §1). Failing-first tests.
// Same DOM harness as use-floor-arena.test.tsx: bun has no global DOM, so the happy-dom
// window is installed and torn down around the render.
const testWindow = new Window({ url: 'http://localhost/trading-floor' });
const globalNames = ['Node', 'Element', 'HTMLElement', 'Event', 'MutationObserver'] as const;
const installedNames = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...globalNames] as const;
let createRoot: typeof import('react-dom/client').createRoot;
let root: Root | null = null;
let container: HTMLElement | null = null;
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
const clients = new Set<QueryClient>();

let calls: Array<{ method: string; url: string }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

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

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function newClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  clients.add(client);
  return client;
}

function agentWire(id: string, overrides: Record<string, unknown> = {}) {
  const house = FLOOR_ARENA_HOUSE_AGENTS.find((agent) => agent.id === id);
  const window = { realisedUsd: 7.77, trades: 17, wins: 7, losses: 10, deaths: 0, openPositions: 2, lastTradeAt: null };
  return {
    id,
    name: house?.name ?? 'Somebody',
    templateId: house?.templateId ?? 'genesis',
    mode: 'paper',
    status: 'active',
    paramsVersion: 1,
    exits: { tpMult: 1.1, stopMult: null, maxHoldS: 900 },
    stats: { all: window, last24h: window, contest: window },
    scan: { at: '2026-10-02T11:58:00.000Z', evaluated: 412, passed: 3, held: 2, topSkip: [{ code: 'liq', count: 300 }] },
    watching: { at: '2026-10-02T11:59:00.000Z', symbol: 'BONK' },
    open: [{ symbol: 'WIF', openedAt: '2026-10-02T11:50:00.000Z', sizeUsd: 20, lastMarkMult: 1.04 }],
    ...overrides,
  };
}

function boardWire(agents: unknown[]) {
  return {
    version: 1,
    agents,
    contest: { startsAt: '2026-09-30T22:00:00Z', endsAt: '2026-10-05T03:59:59Z' },
    generatedAt: '2026-10-02T12:00:00.000Z',
  };
}

beforeAll(async () => {
  installDom();
  ({ createRoot } = await import('react-dom/client'));
});

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: boardWire(FLOOR_ARENA_HOUSE_AGENTS.map((house) => agentWire(house.id))) };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(input) });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    },
  });
});

afterEach(async () => {
  await act(async () => {
    for (const client of clients) {
      await client.cancelQueries();
      client.clear();
    }
    clients.clear();
  });
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('house-board query contract', () => {
  test("key ['floor-arena','house-board'], 15 s poll, no background refetch", () => {
    expect(floorArenaHouseBoardKey).toEqual(['floor-arena', 'house-board']);
    expect(FLOOR_ARENA_HOUSE_BOARD_POLL_MS).toBe(15_000);
    const options = floorArenaHouseBoardQueryOptions();
    expect(options.queryKey).toEqual(['floor-arena', 'house-board']);
    expect(options.refetchInterval).toBe(15_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  test('the hook registers that key with the 15 s poll and no background refetch', async () => {
    const client = newClient();
    function Probe() {
      useFloorArenaHouseBoard(true);
      return null;
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
      await Promise.resolve();
    });
    await flush();
    const query = client.getQueryCache().find({ queryKey: ['floor-arena', 'house-board'] });
    expect(query).toBeDefined();
    const observer = query!.observers[0]!;
    expect(observer.options.refetchInterval).toBe(15_000);
    expect(observer.options.refetchIntervalInBackground).toBe(false);
    expect(calls.map((call) => call.url)).toEqual(['/api/floor/arena/house-board']);
    expect(query!.state.data).toBeDefined();
  });

  test('disabled: no fetch', async () => {
    const client = newClient();
    function Probe() {
      useFloorArenaHouseBoard(false);
      return null;
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
      await Promise.resolve();
    });
    await flush();
    expect(calls).toEqual([]);
  });
});

describe('house-board fetch and reader', () => {
  test('GET /api/floor/arena/house-board, five agents in house order', async () => {
    const view = await fetchFloorArenaHouseBoard();
    expect(calls).toEqual([{ method: 'GET', url: '/api/floor/arena/house-board' }]);
    expect(view.agents.map((agent) => agent.id)).toEqual(FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.id));
    const genesis = view.agents[0]!;
    expect(genesis.mode).toBe('paper');
    expect(genesis.exits).toEqual({ tpMult: 1.1, stopMult: null, maxHoldS: 900 });
    expect(genesis.stats.contest.realisedUsd).toBe(7.77);
    expect(genesis.scan).toEqual({ at: '2026-10-02T11:58:00.000Z', evaluated: 412, passed: 3, held: 2, topSkip: [{ code: 'liq', count: 300 }] });
    expect(genesis.watching).toEqual({ at: '2026-10-02T11:59:00.000Z', symbol: 'BONK', masked: false });
    expect(genesis.open).toEqual([{ symbol: 'WIF', openedAt: '2026-10-02T11:50:00.000Z', sizeUsd: 20, lastMarkMult: 1.04, masked: false }]);
    expect(view.contest).toEqual({ startsAt: '2026-09-30T22:00:00Z', endsAt: '2026-10-05T03:59:59Z' });
    expect(view.generatedAt).toBe('2026-10-02T12:00:00.000Z');
  });

  test('a refusal throws FloorArenaApiError with the status and the code', async () => {
    reply = { status: 429, body: { error: 'Too many requests.', code: 'rate_limited' } };
    let caught: unknown = null;
    try {
      await fetchFloorArenaHouseBoard();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FloorArenaApiError);
    expect((caught as FloorArenaApiError).status).toBe(429);
    expect((caught as FloorArenaApiError).code).toBe('rate_limited');
  });

  test('a missing or unreadable agent keeps its column with nulls, never zeros and never a guessed mode', () => {
    const view = readHouseBoard(boardWire([
      agentWire('house:runner', { mode: 'turbo', status: 'sleeping', paramsVersion: '2', exits: null }),
      agentWire('house:genesis', {
        stats: { all: { realisedUsd: 'abc' } },
        scan: { at: 5, evaluated: 1 },
        watching: { at: '2026-10-02T11:59:00.000Z', symbol: '***', masked: true },
        open: [{ symbol: '***', masked: true, openedAt: '2026-10-02T11:50:00.000Z', sizeUsd: 'x', lastMarkMult: null }, 'junk'],
      }),
      agentWire('house:somebody-else'),
    ]));
    expect(view.agents.map((agent) => agent.id)).toEqual(FLOOR_ARENA_HOUSE_AGENTS.map((house) => house.id));
    const [genesis, runner, dip] = view.agents;
    expect(genesis!.stats.all.realisedUsd).toBeNull();
    expect(genesis!.stats.last24h.trades).toBeNull();
    expect(genesis!.scan).toBeNull();
    expect(genesis!.watching).toEqual({ at: '2026-10-02T11:59:00.000Z', symbol: '***', masked: true });
    expect(genesis!.open).toEqual([{ symbol: '***', openedAt: '2026-10-02T11:50:00.000Z', sizeUsd: null, lastMarkMult: null, masked: true }]);
    expect(runner!.mode).toBeNull();
    expect(runner!.status).toBeNull();
    expect(runner!.paramsVersion).toBe(2);
    expect(runner!.exits).toBeNull();
    expect(dip!.name).toBe('Dip Hunter');
    expect(dip!.templateId).toBe('dip-hunter');
    expect(dip!.mode).toBeNull();
    expect(dip!.status).toBeNull();
    expect(dip!.paramsVersion).toBeNull();
    expect(dip!.exits).toBeNull();
    expect(dip!.stats.contest.realisedUsd).toBeNull();
    expect(dip!.scan).toBeNull();
    expect(dip!.watching).toBeNull();
    expect(dip!.open).toEqual([]);
  });

  test('an unreadable body still gives five null columns', () => {
    const view = readHouseBoard({});
    expect(view.agents).toHaveLength(5);
    expect(view.agents.every((agent) => agent.mode === null && agent.open.length === 0)).toBe(true);
    expect(view.contest).toEqual({ startsAt: null, endsAt: null });
    expect(view.generatedAt).toBeNull();
  });
});
