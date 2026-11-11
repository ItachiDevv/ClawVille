import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';
import { useGameStore } from '@/stores/game';
import { useFloorArenaUi } from '@/stores/floor-arena-ui';
import { FINGERPRINT_STORAGE_KEY } from '@/lib/fingerprint';
import { filterRuleChecks, statsForWindow } from './terminal-parts';
import { floorArenaKeys, readEvent, readStatsByWindow } from '@/hooks/use-floor-arena';

const dom = new Window({ url: 'http://localhost/game' });
let root: import('react-dom/client').Root | null = null;
let client: QueryClient;
let host: HTMLDivElement;
let guest = false;
let failedMe = false;
let refusedMe = 0;
let requests: string[] = [];
let history = false;
let Component: typeof import('./trading-floor-terminal').TradingFloorTerminal;
let createRoot: typeof import('react-dom/client').createRoot;
const originals = new Map<string, PropertyDescriptor | undefined>();
const agent = { id: 'owner-agent', name: 'Owner trader', templateId: FLOOR_ARENA_TEMPLATES[0]!.id, params: FLOOR_ARENA_TEMPLATES[0]!.params, paramsVersion: 1, status: 'active', kind: 'user', mode: 'paper' };

async function flush() { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
  await flush();
}
async function render() {
  root = createRoot(host);
  const router = { bfcacheId: 'terminal-test', back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch: async () => undefined };
  await act(async () => { root!.render(createElement(AppRouterContext.Provider, { value: router }, createElement(QueryClientProvider, { client }, createElement(Component)))); });
  await flush();
}

beforeAll(async () => {
  ({ createRoot } = await import('react-dom/client'));
  ({ TradingFloorTerminal: Component } = await import('./trading-floor-terminal'));
});
beforeEach(() => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, MutationObserver: dom.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  dom.localStorage.setItem(FINGERPRINT_STORAGE_KEY, '0123456789abcdef0123456789abcdef');
  guest = false; failedMe = false; refusedMe = 0; requests = []; history = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } } });
  host = document.createElement('div'); document.body.append(host);
  useFloorArenaUi.getState().resetIdentity();
  useGameStore.setState({ tradingFloorOpen: true });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    let body: unknown = {};
    if (url.includes('/auth/me')) body = { user: { id: guest ? 'guest' : 'owner', isGuest: guest } };
    else if (url.endsWith('/arena/me')) {
      if (refusedMe) return Response.json({ error: 'refused', code: 'guest_not_allowed' }, { status: refusedMe });
      if (failedMe) return Response.json({ error: 'unavailable' }, { status: 503 });
      body = { agent, stats: { contest: { realisedUsd: -9, trades: 4 }, last24h: { realisedUsd: 2, trades: 1 }, all: { realisedUsd: -7, trades: 5 } }, latestReport: null };
    } else if (url.includes('/events')) body = { events: [{ id: '1', type: 'skip', summary: 'Rule threshold failed', data: { reason: 'threshold' } }] };
    else if (url.includes('/trades?')) body = history ? { trades: [{ id: url.includes('before=') ? 'second' : 'first', mint: 'mint', symbol: url.includes('before=') ? 'SECOND' : 'FIRST', status: 'closed', pnlUsd: 3, closedAt: '2026-11-11T12:00:00Z' }], nextCursor: url.includes('before=') ? null : { before: '2026-11-11T12:00:00.123456Z', beforeId: '00000000-0000-4000-8000-000000000001' } } : { trades: [], nextCursor: null };
    else if (url.includes('/equity?')) body = { series: [], openPnlUsd: null, startAt: null };
    else if (url.includes('/agents/')) body = { agent: { ...agent, id: 'public-agent', name: 'Public trader' }, openPositions: [], closedPositions: [] };
    else if (url.includes('/leaderboard')) body = { rows: [{ agentId: 'public-agent', name: 'Public trader', rank: 1, realisedUsd: 3, trades: 2 }] };
    else if (url.includes('/house-traders')) body = { slots: [] };
    return Response.json(body);
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = null;
  await client.cancelQueries(); client.clear(); host.remove();
  for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  originals.clear();
});

describe('Trading Floor terminal', () => {
  test('phone equity uses a narrow viewBox and readable labels', async () => {
    const { EquityCurve } = await import('./terminal-history');
    const previousWidth = dom.innerWidth;
    dom.innerWidth = 390;
    try {
      root = createRoot(host);
      await act(async () => { root!.render(createElement(EquityCurve, { series: [{ closedAt: '2026-11-11T12:00:00.123456Z', equityUsd: 18 }] })); });
      await flush();
      expect(host.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 360 210');
      // Allow 80 px for terminal padding at the 390 px phone width.
      for (const label of host.querySelectorAll('svg text')) expect(Number(label.getAttribute('font-size')) * 310 / 360).toBeGreaterThanOrEqual(11);
    } finally { dom.innerWidth = previousWidth; }
  });
  test('owner navigates all six tabs with real data and separate public events', async () => {
    await render();
    expect(host.textContent).toContain('-$9.00');
    await click('24 hours'); expect(host.textContent).toContain('+$2.00');
    await click('Trades'); expect(host.textContent).toContain('Closed trades');
    await click('Decisions'); expect(host.textContent).toContain('Decisions: rule checks');
    expect(host.textContent).toContain('Rule threshold failed');
    await click('Strategy'); expect(host.textContent).toContain('Coins it looks at');
    await click('Reports'); expect(host.textContent).toContain('No report yet');
    await click('Other agents');
    const publicButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Public trader'))!;
    await act(async () => { publicButton.click(); }); await flush();
    expect(requests.some((url) => url.includes('/arena/me/events'))).toBe(true);
    expect(requests.some((url) => url.includes('/agents/public-agent/events'))).toBe(true);
    expect(host.textContent).toContain('Equity curve');
    expect(requests.some((url) => url.includes('/agents/public-agent/trades?'))).toBe(true);
    expect(requests.some((url) => url.includes('/agents/public-agent/equity?'))).toBe(true);
    await act(async () => useGameStore.getState().closeTradingFloor());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  test('owner history loads another cursor page and filters reset pagination', async () => {
    history = true;
    await render();
    expect(requests.some((url) => url.includes('/arena/me/equity?window=contest'))).toBe(true);
    expect(host.textContent).toContain('No closed trades in this window');
    await click('7 days');
    expect(requests.some((url) => url.includes('/arena/me/equity?window=7d'))).toBe(true);
    await click('Trades');
    expect(host.textContent).toContain('FIRST');
    const tradesQuery = client.getQueryCache().find({ queryKey: ['floor-arena', 'my-trades', agent.id, 'all', '', 50] })!;
    const interval = (tradesQuery.options as unknown as { refetchInterval: (query: typeof tradesQuery) => number | false }).refetchInterval;
    expect(interval(tradesQuery)).toBeGreaterThan(0);
    await click('Load more');
    expect(interval(tradesQuery)).toBe(false);
    expect(host.textContent).toContain('SECOND');
    expect(requests.some((url) => url.includes('before=2026-11-11T12%3A00%3A00.123456Z') && url.includes('beforeId='))).toBe(true);
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Trade outcome"]')!;
    await act(async () => { select.value = 'win'; select.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event); }); await flush();
    expect(requests.at(-1)).toContain('outcome=win');
    expect(requests.at(-1)).not.toContain('before=');
    expect(host.textContent).not.toContain('SECOND');
    const filteredQuery = client.getQueryCache().find({ queryKey: ['floor-arena', 'my-trades', agent.id, 'win', '', 50] })!;
    expect(interval(filteredQuery)).toBeGreaterThan(0);
    const reason = host.querySelector<HTMLSelectElement>('[aria-label="Trade exit reason"]')!;
    await act(async () => { reason.value = 'stop'; reason.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event); }); await flush();
    expect(requests.at(-1)).toContain('reason=stop');
  });
  test('guests see sign-in and public agents without owner requests', async () => {
    guest = true; await render();
    expect(host.textContent).toContain('Sign in to launch');
    await click('Other agents'); expect(host.textContent).toContain('Public trader');
    expect(requests.some((url) => url.includes('/arena/me'))).toBe(false);
  });
  test('owner failure is not an empty trader state', async () => {
    failedMe = true; await render();
    expect(host.textContent).toContain('Your trader could not be loaded');
    expect(host.textContent).not.toContain('Rule checks appear after you launch');
  });
  test.each([401, 403])('owner refusal %i hides cached private data and disables event reads', async (status) => {
    await render(); expect(host.textContent).toContain('Rule threshold failed');
    refusedMe = status;
    await act(async () => { await client.invalidateQueries({ queryKey: floorArenaKeys.me }); }); await flush();
    expect(host.textContent).not.toContain('Rule threshold failed');
    expect(host.textContent).not.toContain('Owner trader');
    const privateEvents = client.getQueryCache().find({ queryKey: floorArenaKeys.myEvents(agent.id) });
    expect(privateEvents?.isActive() ?? false).toBe(false);
  });
  test('closed terminal has no active arena queries', async () => {
    await render();
    await act(async () => useGameStore.getState().closeTradingFloor()); await flush();
    expect(client.getQueryCache().findAll({ queryKey: floorArenaKeys.all }).every((query) => !query.isActive())).toBe(true);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  test('nested sign-in Escape leaves the terminal open', async () => {
    guest = true; await render(); await click('Sign in or create account');
    expect(useGameStore.getState().exchangeEscapeOwnedByDialog).toBe(true);
    await act(async () => { window.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as KeyboardEvent); });
    await flush();
    expect(useGameStore.getState().exchangeEscapeOwnedByDialog).toBe(true);
    const { closeTradingFloorExchangeOnEscape } = await import('@/lib/three/trading-floor/trading-floor-interior');
    await act(async () => closeTradingFloorExchangeOnEscape());
    expect(useGameStore.getState().tradingFloorOpen).toBe(true);
    expect(host.querySelector('[data-testid="guest-upsell-panel"]')).toBeNull();
  });
  test('windows preserve missing numbers and rule filters preserve data', () => {
    const stats = readStatsByWindow({ contest: { realisedUsd: -3 }, last24h: { trades: 2 } });
    expect(statsForWindow(stats, '24h').realisedUsd).toBeNull();
    expect(statsForWindow(stats, 'contest').realisedUsd).toBe(-3);
    const event = readEvent({ id: '7', type: 'skip', data: { cause: 'liquidity' } })!;
    expect(filterRuleChecks([event], 'skip')[0]?.data).toEqual({ cause: 'liquidity' });
    expect(filterRuleChecks([event], 'entry')).toEqual([]);
  });
});
