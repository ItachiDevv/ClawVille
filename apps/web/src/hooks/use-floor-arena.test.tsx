import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';

import {
  FLOOR_ARENA_DESK_PANEL_DELAY_MS,
  floorArenaErrorCopy,
  floorArenaKeys,
  floorArenaProvisionInProgress,
  flushFloorArenaSeatWritesForTest,
  mergeFloorArenaEvents,
  readEvent,
  readLeaderboardRow,
  readMe,
  readProfile,
  readReport,
  readTunerCheck,
  reportTradingFloorSeat,
  resetFloorArenaSeatSyncForTest,
  useFloorArenaEvents,
  useFloorArenaMe,
  useFloorArenaMyEvents,
  type FloorArenaEventView,
} from '@/hooks/use-floor-arena';
import { ApiError } from '@/lib/api';
import { useFloorArenaUi } from '@/stores/floor-arena-ui';
import { useGameStore } from '@/stores/game';

// Same DOM harness as use-trading-floor-hooks.test.tsx: bun has no global DOM,
// so the happy-dom window is installed and torn down around the renders.
const testWindow = new Window({ url: 'http://localhost/trading-floor' });
const globalNames = ['Node', 'Element', 'HTMLElement', 'Event', 'MutationObserver'] as const;
const installedNames = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...globalNames] as const;
let createRoot: typeof import('react-dom/client').createRoot;
let root: Root | null = null;
let container: HTMLElement | null = null;
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
const clients = new Set<QueryClient>();

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[] = [];
type Responder = (call: Call) => { status: number; body: unknown };
let responder: Responder = () => ({ status: 200, body: {} });

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
  // Query results reach observers through react-query's timer-batched notify,
  // so each round drains a macrotask as well as the microtasks.
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

async function mount(client: QueryClient, node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, node));
    await Promise.resolve();
  });
}

const VALID_PARAMS = FLOOR_ARENA_TEMPLATES[0]!.params;

function agentBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'My Genesis',
    kind: 'user',
    templateId: 'genesis',
    params: VALID_PARAMS,
    paramsVersion: 3,
    mode: 'paper',
    status: 'active',
    seated: false,
    seatIndex: null,
    stats: { realisedUsd: '1.25', trades: 4, wins: 3, losses: 1, openPositions: 1, lastTradeAt: null },
    paymentAddress: null,
    provisionState: 'ready',
    provisionError: null,
    addons: [],
    autoApplySuggestions: false,
    ...overrides,
  };
}

function resetStores(): void {
  useFloorArenaUi.setState({
    panel: 'overview',
    profileAgentId: null,
    launchTemplateId: null,
    localSeatIndex: -1,
    myAgent: 'unknown',
    seatWriteVersion: 0,
    launched: null,
  });
  useGameStore.setState({ exchangeOpen: false, exchangeTab: 'browse' });
  resetFloorArenaSeatSyncForTest();
}

beforeAll(async () => {
  installDom();
  ({ createRoot } = await import('react-dom/client'));
});

beforeEach(() => {
  calls = [];
  responder = () => ({ status: 200, body: {} });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const reply = responder(call);
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  resetStores();
});

afterEach(async () => {
  await flushFloorArenaSeatWritesForTest();
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
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  resetStores();
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('Floor arena wire readers', () => {
  test('numeric strings from Postgres numeric columns count; unreadable money stays null, never 0', () => {
    const row = readLeaderboardRow({
      rank: 1,
      agentId: 'house:genesis',
      name: 'Genesis',
      kind: 'house',
      templateId: 'genesis',
      realisedUsd: '-3.40',
      trades: '7',
      wins: 2,
      losses: 4,
      deaths: 1,
      openPositions: 1,
      lastTradeAt: null,
      eligible: false,
    });
    expect(row?.realisedUsd).toBe(-3.4);
    expect(row?.deaths).toBe(1);
    expect(row?.losses).toBe(4);
    expect(row?.trades).toBe(7);
    expect(row?.kind).toBe('house');
    expect(readLeaderboardRow({ agentId: 'x', realisedUsd: 'abc' })?.realisedUsd).toBeNull();
    expect(readLeaderboardRow({ agentId: 'x' })?.realisedUsd).toBeNull();
    // A count the route did not send stays unknown (the wall prints "-"), and
    // rank 0 is not a place.
    const bare = readLeaderboardRow({ agentId: 'x', rank: 0 });
    expect([bare?.rank, bare?.trades, bare?.wins, bare?.losses, bare?.deaths, bare?.openPositions]).toEqual([
      null, null, null, null, null, null,
    ]);
    expect(readLeaderboardRow({ name: 'no id' })).toBeNull();
  });

  test('auth refusals with a numeric code still get plain copy by status', () => {
    expect(floorArenaErrorCopy(new ApiError('Unauthorized', 401, 401))).toBe('Your session ended. Sign in again.');
    expect(floorArenaErrorCopy(new ApiError('Forbidden', 403, 403))).toContain('cannot run an arena trader');
    expect(floorArenaErrorCopy(new ApiError('Reserved', 400, 'name_reserved'))).toBe(
      'That name belongs to a house trader. Type another name for your trader.',
    );
    expect(floorArenaErrorCopy(new ApiError('No letter', 400, 'name_needs_letter'))).toBe(
      'Use at least one letter, so the name does not look like a number.',
    );
    expect(floorArenaErrorCopy(new ApiError('Not allowed', 400, 'name_not_allowed'))).toBe(
      'This name is not allowed. Type another name for your trader.',
    );
    expect(floorArenaErrorCopy(new ApiError('Guests cannot', 403, 'guest_not_allowed'))).toBe(
      'Create a free account to run an arena trader.',
    );
  });

  test('an event id may arrive as a number or a string; an unknown type is kept as other', () => {
    expect(readEvent({ id: 12, type: 'entry', summary: 'Bought BONK', at: '2026-09-30T20:00:00Z' })?.id).toBe('12');
    expect(readEvent({ id: '13', type: 'exit', summary: 'Sold', data: { pnlUsd: '2.5' } })?.pnlUsd).toBe(2.5);
    expect(readEvent({ id: 14, type: 'mystery', summary: 'x' })?.type).toBe('other');
    expect(readEvent({ type: 'entry', summary: 'no id' })).toBeNull();
  });

  test('stats read losses from the route and keep a missing count unknown', () => {
    const view = readMe({
      agent: agentBody(),
      stats: {
        all: { realisedUsd: 1.5, trades: 5, wins: 2, losses: 2, deaths: 0, openPositions: 1, lastTradeAt: null },
        contest: { realisedUsd: 0, trades: 0, wins: 0, losses: 0, deaths: 0, openPositions: 0, lastTradeAt: null },
      },
    });
    // 5 trades, 2 wins, 2 losses: one break-even close is in neither.
    expect(view.agent?.stats.all.losses).toBe(2);
    expect(view.agent?.stats.contest.trades).toBe(0);
    expect(view.agent?.stats.last24h.trades).toBeNull();
    expect(view.agent?.stats.last24h.realisedUsd).toBeNull();
  });

  test('a public profile of a player agent with the private fields left out still reads', () => {
    const profile = readProfile({
      agent: {
        id: 'agent-9',
        kind: 'user',
        name: 'Someone',
        templateId: 'runner',
        params: VALID_PARAMS,
        paramsVersion: 2,
        mode: 'paper',
        status: 'active',
        seated: true,
        seatIndex: 4,
      },
      stats: { all: { realisedUsd: -1, trades: 1, wins: 0, losses: 1, deaths: 0, openPositions: 0, lastTradeAt: null } },
      openPositions: [],
      closedPositions: [],
      paramChanges: [],
    });
    expect(profile).not.toBeNull();
    expect(profile?.latestReport).toBeNull();
    expect(profile?.agent.paymentAddress).toBeNull();
    expect(profile?.agent.provisionState).toBe('none');
    expect(profile?.stats.all.losses).toBe(1);
  });

  test("provisioning in progress includes 'creating', which the route now sends while a process holds the claim", () => {
    expect(readMe({ agent: agentBody(), provision: { state: 'creating', error: null } }).agent?.provisionState).toBe('creating');
    expect(floorArenaProvisionInProgress('creating')).toBe(true);
    expect(floorArenaProvisionInProgress('pending')).toBe(true);
    expect(floorArenaProvisionInProgress('ready')).toBe(false);
    expect(floorArenaProvisionInProgress('failed')).toBe(false);
  });

  test('stored rules that fail the shared validator read as null, not as a guess', () => {
    const view = readMe({ agent: agentBody({ params: { filters: {} } }) });
    expect(view.agent?.params).toBeNull();
    expect(readMe({ agent: agentBody() }).agent?.params).toEqual(VALID_PARAMS);
    expect(readMe({ agent: null }).agent).toBeNull();
  });

  test('a report reads its suggestion and observations; an unknown suggestion state reads as none', () => {
    const report = readReport({
      id: 'r1',
      summary: 'Two wins, one loss.',
      observations: ['Most skips were liquidity.', 7],
      suggestion: { path: 'exits.max_hold_s', from: 900, to: 1200, reason: 'Winners needed more time.' },
      suggestionState: 'pending',
    });
    expect(report?.observations).toEqual(['Most skips were liquidity.']);
    expect(report?.suggestion?.to).toBe(1200);
    expect(report?.suggestionState).toBe('pending');
    expect(readReport({ id: 'r2', suggestionState: 'weird' })?.suggestionState).toBe('none');
  });

  test('a report reads stats.suggestionCheck.tuner when present and null when absent (D33)', () => {
    const present = readReport({
      id: 'r3',
      suggestionState: 'none',
      stats: {
        suggestionCheck: {
          llm: 'ok',
          tuner: {
            decision: 'changed',
            reason: 'changed',
            n: '24',
            needed: 20,
            best: { path: 'filters.chg5m_max', from: 25, to: 12.5, kept: { n: 12 }, excluded: { n: 12 }, edge: 0.4 },
            p: 0.03,
          },
        },
      },
    });
    expect(present?.tuner).toEqual({
      decision: 'changed',
      reason: 'changed',
      n: 24,
      needed: 20,
      best: { path: 'filters.chg5m_max', from: 25, to: 12.5, edge: 0.4 },
      p: 0.03,
      checkpoint: null,
      alpha: null,
    });
    // Old reports: no stats, no suggestionCheck, or no tuner field.
    expect(readReport({ id: 'r4', suggestionState: 'none' })?.tuner).toBeNull();
    expect(readReport({ id: 'r5', stats: { observations: [] } })?.tuner).toBeNull();
    expect(readReport({ id: 'r6', stats: { suggestionCheck: { llm: 'skipped' } } })?.tuner).toBeNull();
    // An unknown decision or reason reads as no line; a best with no path reads as null.
    expect(readTunerCheck({ decision: 'maybe', reason: 'changed' })).toBeNull();
    expect(readTunerCheck({ decision: 'none', reason: 'mystery' })).toBeNull();
    expect(readTunerCheck({ decision: 'none', reason: 'no_candidate', best: { from: 1 } })).toEqual({
      decision: 'none', reason: 'no_candidate', n: null, needed: null, best: null, p: null, checkpoint: null, alpha: null,
    });
  });

  test('the checkpoint contract: waiting_checkpoint and budget_spent read, with checkpoint, alpha and best.edge', () => {
    // A look between checkpoints: no test ran, `needed` is the next checkpoint.
    expect(
      readTunerCheck({ decision: 'none', reason: 'waiting_checkpoint', n: 27, needed: 40, best: null, p: null, checkpoint: null, alpha: null }),
    ).toEqual({ decision: 'none', reason: 'waiting_checkpoint', n: 27, needed: 40, best: null, p: null, checkpoint: null, alpha: null });
    // Every checkpoint used: `needed` is null and still reads as a line.
    expect(readTunerCheck({ decision: 'none', reason: 'budget_spent', n: 812, needed: null, best: null, p: null })).toEqual({
      decision: 'none', reason: 'budget_spent', n: 812, needed: null, best: null, p: null, checkpoint: null, alpha: null,
    });
    // A tested look keeps the checkpoint, its alpha and the edge; numeric strings read as numbers.
    expect(
      readTunerCheck({
        decision: 'none',
        reason: 'not_significant',
        n: '40',
        needed: 80,
        best: { path: 'filters.liq_min', from: 5000, to: 8000, kept: 22, excluded: 18, edge: '0.0215' },
        p: 0.004,
        checkpoint: '40',
        alpha: 0.01,
      }),
    ).toEqual({
      decision: 'none',
      reason: 'not_significant',
      n: 40,
      needed: 80,
      best: { path: 'filters.liq_min', from: 5000, to: 8000, edge: 0.0215 },
      p: 0.004,
      checkpoint: 40,
      alpha: 0.01,
    });
    // Absent or junk checkpoint, alpha and edge read as null, never as 0.
    expect(
      readTunerCheck({
        decision: 'changed', reason: 'changed', n: 20, needed: 20,
        best: { path: 'filters.liq_min', from: 5000, to: 8000 }, p: 0.002, checkpoint: 'soon', alpha: {},
      }),
    ).toEqual({
      decision: 'changed', reason: 'changed', n: 20, needed: 20,
      best: { path: 'filters.liq_min', from: 5000, to: 8000, edge: null }, p: 0.002, checkpoint: null, alpha: null,
    });
    // Unknown values still read as no line.
    expect(readTunerCheck({ decision: 'none', reason: 'waiting_for_godot', needed: 40 })).toBeNull();
    expect(readTunerCheck({ decision: 'skipped', reason: 'budget_spent' })).toBeNull();
    // Through readReport, as the report panel reads it.
    expect(
      readReport({ id: 'r7', stats: { suggestionCheck: { tuner: { decision: 'none', reason: 'budget_spent', n: 900, needed: null } } } })?.tuner?.reason,
    ).toBe('budget_spent');
  });

  test('merging keeps newest first, drops duplicates, caps the list, and reuses the array when nothing is new', () => {
    const event = (id: number): FloorArenaEventView => readEvent({ id, type: 'scan', summary: `e${id}` })!;
    const previous = [event(5), event(4), event(3)];
    expect(mergeFloorArenaEvents(previous, [])).toBe(previous);
    expect(mergeFloorArenaEvents(previous, [event(4)])).toBe(previous);
    const merged = mergeFloorArenaEvents(previous, [event(7), event(6), event(5)], 4);
    expect(merged.map((row) => row.id)).toEqual(['7', '6', '5', '4']);
  });
});

describe('Seat sync from the 3D room', () => {
  test('a sit opens My trader on the Trading Floor tab once the avatar is in the chair, and before GET /me answers writes nothing', async () => {
    jest.useFakeTimers();
    reportTradingFloorSeat(2);
    await flushFloorArenaSeatWritesForTest();
    // Not at once: the open panel freezes the controller that seats the avatar.
    expect(useGameStore.getState().exchangeOpen).toBe(false);
    jest.advanceTimersByTime(FLOOR_ARENA_DESK_PANEL_DELAY_MS);
    jest.useRealTimers();
    expect(useGameStore.getState().exchangeOpen).toBe(true);
    expect(useGameStore.getState().exchangeTab).toBe('floor');
    expect(useFloorArenaUi.getState().panel).toBe('desk');
    expect(useFloorArenaUi.getState().localSeatIndex).toBe(2);
    expect(calls).toEqual([]);
  });

  test('with a known agent, sit then stand reach the server in that order', async () => {
    useFloorArenaUi.setState({ myAgent: 'present' });
    reportTradingFloorSeat(4);
    reportTradingFloorSeat(-1);
    await flushFloorArenaSeatWritesForTest();
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['POST', '/api/floor/arena/me/seat', { seated: true, seatIndex: 4 }],
      ['POST', '/api/floor/arena/me/seat', { seated: false }],
    ]);
    expect(useFloorArenaUi.getState().seatWriteVersion).toBe(2);
  });

  test('standing up before the delay cancels the panel', () => {
    jest.useFakeTimers();
    reportTradingFloorSeat(5);
    reportTradingFloorSeat(-1);
    jest.advanceTimersByTime(FLOOR_ARENA_DESK_PANEL_DELAY_MS * 2);
    jest.useRealTimers();
    expect(useGameStore.getState().exchangeOpen).toBe(false);
  });

  test('the same seat reported twice writes once, and a stand does not reopen the panel', async () => {
    useFloorArenaUi.setState({ myAgent: 'present' });
    reportTradingFloorSeat(1);
    reportTradingFloorSeat(1);
    await flushFloorArenaSeatWritesForTest();
    expect(calls).toHaveLength(1);
    useGameStore.setState({ exchangeOpen: false });
    reportTradingFloorSeat(-1);
    await flushFloorArenaSeatWritesForTest();
    expect(useGameStore.getState().exchangeOpen).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test('a player with no agent is not written for again after the first refusal', async () => {
    useFloorArenaUi.setState({ myAgent: 'present' });
    responder = () => ({ status: 404, body: { error: 'No arena agent', code: 'no_agent' } });
    reportTradingFloorSeat(0);
    await flushFloorArenaSeatWritesForTest();
    expect(useFloorArenaUi.getState().myAgent).toBe('none');
    reportTradingFloorSeat(-1);
    reportTradingFloorSeat(3);
    await flushFloorArenaSeatWritesForTest();
    expect(calls).toHaveLength(1);
  });
});

function MeProbe() {
  useFloorArenaMe(true);
  return null;
}

describe('GET /me reconciles the seat', () => {
  test('a player already sitting when GET /me first answers gets the desk written once', async () => {
    reportTradingFloorSeat(3);
    responder = (call) =>
      call.url.endsWith('/me') ? { status: 200, body: { agent: agentBody({ seated: false }) } } : { status: 200, body: {} };
    await mount(newClient(), createElement(MeProbe));
    await flush();
    await flushFloorArenaSeatWritesForTest();
    const seatWrites = calls.filter((call) => call.url.endsWith('/me/seat'));
    expect(seatWrites.map((call) => call.body)).toEqual([{ seated: true, seatIndex: 3 }]);
    expect(useFloorArenaUi.getState().myAgent).toBe('present');
  });

  test('a desk the server holds with no local sitter is left alone (the agent keeps its desk, spec D7)', async () => {
    responder = () => ({ status: 200, body: { agent: agentBody({ seated: true, seatIndex: 1 }) } });
    await mount(newClient(), createElement(MeProbe));
    await flush();
    await flushFloorArenaSeatWritesForTest();
    expect(calls.filter((call) => call.url.endsWith('/me/seat'))).toEqual([]);
  });

  test('a guest or anonymous answer marks the viewer as unable to own an agent', async () => {
    responder = () => ({ status: 403, body: { error: 'Guests cannot', code: 'guest_not_allowed' } });
    await mount(newClient(), createElement(MeProbe));
    await flush();
    expect(useFloorArenaUi.getState().myAgent).toBe('none');
  });
});

function EventsProbe({ onData }: { onData: (rows: FloorArenaEventView[] | undefined) => void }) {
  const query = useFloorArenaEvents('agent-1', true);
  onData(query.data);
  return null;
}

function MyEventsProbe() {
  useFloorArenaMyEvents('agent-1', true);
  return null;
}

describe('Decision stream cursor', () => {
  test("the owner's full stream reads GET /me/events, not the public route", async () => {
    responder = () => ({ status: 200, body: { events: [{ id: 3, type: 'skip', summary: 'Too little liquidity' }] } });
    await mount(newClient(), createElement(MyEventsProbe));
    await flush();
    expect(calls[0]?.url).toBe('/api/floor/arena/me/events?limit=100');
  });

  test('the first poll has no cursor; the next asks only for events after the newest one and merges them', async () => {
    let latest: FloorArenaEventView[] | undefined;
    let page = 0;
    responder = () => {
      page += 1;
      return page === 1
        ? { status: 200, body: { events: [{ id: 12, type: 'entry', summary: 'b' }, { id: 11, type: 'skip', summary: 'a' }] } }
        : { status: 200, body: { events: [{ id: 13, type: 'exit', summary: 'c', data: { pnlUsd: -1 } }] } };
    };
    const client = newClient();
    await mount(client, createElement(EventsProbe, { onData: (rows) => { latest = rows; } }));
    await flush();
    expect(calls[0]?.url).toBe('/api/floor/arena/agents/agent-1/events?limit=100');
    expect(latest?.map((row) => row.id)).toEqual(['12', '11']);

    await act(async () => {
      await client.refetchQueries({ queryKey: floorArenaKeys.events('agent-1') });
    });
    await flush();
    expect(calls[1]?.url).toBe('/api/floor/arena/agents/agent-1/events?after=12&limit=100');
    expect(latest?.map((row) => row.id)).toEqual(['13', '12', '11']);
  });
});
