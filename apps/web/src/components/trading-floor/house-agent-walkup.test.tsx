import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';

import { useFloorArenaUi } from '@/stores/floor-arena-ui';
import { useGameStore } from '@/stores/game';
import {
  HOUSE_AGENT_PENDING_TEMPLATE_KEY,
  houseAgentWalkupAnchor,
  setHouseAgentWalkup,
  useHouseAgentWalkupPanel,
} from '@/stores/house-agent-walkup';

// P15 T5: the walk-up pop-up (ops/house-traders/arena-review/P15_PLAN_2026-10-02.md
// §3 Placement, Content, Button flow, Keyboard and touch; §6 T5 tests). The
// detection (T4) is replaced here by direct setHouseAgentWalkup calls and
// writes to houseAgentWalkupAnchor, exactly as T4 will make them.
//
// Same DOM harness as arena-section-auth.test.tsx: bun has no global DOM, so the
// happy-dom window is installed before the component modules load.

const testWindow = new Window({ url: 'http://localhost/trading-floor', width: 1366, height: 768 });
const globalNames = ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installedNames = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...globalNames] as const;
let createRoot: typeof import('react-dom/client').createRoot;
let HouseAgentWalkup: typeof import('./house-agent-walkup').default;
let FloorArenaSection: typeof import('@/components/game/trading-floor/arena/arena-section').FloorArenaSection;
let useIsGuest: typeof import('@/hooks/use-is-guest').useIsGuest;
let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
let requests: string[] = [];

type Reply = { status: number; body: unknown };
let authReply: Reply = { status: 200, body: { user: { id: 'u1', isGuest: false } } };
let meReply: Reply = { status: 200, body: { agent: null } };
let boardReply: Reply = { status: 200, body: {} };

// A manual requestAnimationFrame, so a test can step the placement loop frame by frame.
const pendingFrames = new Map<number, (time: number) => void>();
let nextFrameId = 1;
/**
 * Frames the walk-up placement loop asked for. Other code asks for frames too
 * (fingerprintjs loads an iframe the moment auth-me runs), so count only the
 * panel's own callback, which the component names `houseAgentWalkupFrame`.
 */
function walkupFrames(): number {
  return [...pendingFrames.values()].filter((callback) => callback.name === 'houseAgentWalkupFrame').length;
}

function runFrame(): void {
  const batch = [...pendingFrames.values()];
  pendingFrames.clear();
  act(() => {
    for (const callback of batch) callback(0);
  });
}

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
  Object.defineProperty(testWindow, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: (time: number) => void) => {
      const id = nextFrameId++;
      pendingFrames.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(testWindow, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (id: number) => {
      pendingFrames.delete(id);
    },
  });
}

function restoreDom(): void {
  for (const [name, descriptor] of previousDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(testWindow, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(testWindow, 'innerHeight', { configurable: true, value: height });
}

// Built from its code point so this file never holds the character itself.
const EM_DASH = String.fromCharCode(0x2014);
const count = (suffix: string) => requests.filter((url) => url.endsWith(suffix)).length;

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

async function render(...children: ReactElement[]): Promise<HTMLElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client: client! }, ...children));
  });
  // Let the auth-me answer land inside act.
  await settle(20);
  return container;
}

async function walkUp(index: number, eAvailable = false): Promise<void> {
  await act(async () => {
    setHouseAgentWalkup(index, eAvailable);
  });
  // Let GET /me and the house-board answer land inside act.
  await settle(20);
}

const panel = (): HTMLElement | null => document.querySelector('[data-testid="house-agent-walkup"]');
const byTestId = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error('nothing to click');
  await act(async () => {
    (element as HTMLElement).click();
  });
}

function stats(realisedUsd: number, wins: number, losses: number) {
  return { realisedUsd, trades: wins + losses, wins, losses, deaths: 0, openPositions: 1, lastTradeAt: null };
}

function boardBody(overrides: Record<string, unknown> = {}, contest = { startsAt: '2000-01-01T00:00:00Z', endsAt: '2999-01-01T00:00:00Z' }) {
  return {
    version: 1,
    agents: FLOOR_ARENA_TEMPLATES.map((template, index) => ({
      id: template.houseAgentId,
      name: template.displayName,
      templateId: template.id,
      mode: 'paper',
      status: 'active',
      paramsVersion: 1,
      exits: { tpMult: 1.1, stopMult: null, maxHoldS: 900 },
      stats: { all: stats(1, 1, 1), last24h: stats(-2.5, 3, 4), contest: stats(7.77, 7, 10) },
      scan: null,
      watching: null,
      open: index === 0 ? [{ symbol: 'BONK', openedAt: '2026-10-01T00:00:00Z', sizeUsd: 20, lastMarkMult: 1.04 }] : [],
      ...(index === 0 ? overrides : {}),
    })),
    contest,
    generatedAt: '2026-10-01T00:00:00Z',
  };
}

const AGENT_ROW = {
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
};

function meWithAgent() {
  return {
    agent: AGENT_ROW,
    paymentAddress: null,
    provision: { state: 'ready', error: null },
    wallet: null,
    addons: [],
    stats: null,
    latestReport: null,
  };
}

/** The floor tab's wiring for the Exchange section: isGuest from useIsGuest(). */
function SectionHarness() {
  const isGuest = useIsGuest();
  return createElement(FloorArenaSection, { active: true, isGuest, onGuestBlocked: () => undefined });
}

beforeAll(async () => {
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ default: HouseAgentWalkup } = await import('./house-agent-walkup'));
  ({ FloorArenaSection } = await import('@/components/game/trading-floor/arena/arena-section'));
  ({ useIsGuest } = await import('@/hooks/use-is-guest'));
});

beforeEach(() => {
  requests = [];
  pendingFrames.clear();
  setViewport(1366, 768);
  testWindow.sessionStorage.clear();
  authReply = { status: 200, body: { user: { id: 'u1', isGuest: false } } };
  meReply = { status: 200, body: { agent: null } };
  boardReply = { status: 200, body: boardBody() };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string) => {
      const url = String(input);
      requests.push(url);
      const json = (reply: Reply) =>
        new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/api/auth/me')) return json(authReply);
      if (url.endsWith('/api/floor/arena/me')) return json(meReply);
      if (url.endsWith('/api/floor/arena/house-board')) return json(boardReply);
      if (url.includes('/leaderboard')) return json({ status: 200, body: { rows: [] } });
      if (url.includes('/templates')) return json({ status: 200, body: { houseAgents: [] } });
      if (url.includes('/addons')) return json({ status: 200, body: { addons: [], paymentsEnabled: false } });
      if (url.includes('/events')) return json({ status: 200, body: { events: [] } });
      return json({ status: 200, body: {} });
    },
  });
  houseAgentWalkupAnchor.x = 400;
  houseAgentWalkupAnchor.y = 380;
  houseAgentWalkupAnchor.onScreen = true;
  setHouseAgentWalkup(-1, false);
  useHouseAgentWalkupPanel.setState({ dismissedIndex: -1, viewer: 'unknown', pendingTemplateId: null });
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
});

afterEach(async () => {
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

describe('visibility', () => {
  test('nothing renders and no frame loop runs while no agent is in reach', async () => {
    await render(createElement(HouseAgentWalkup));
    await settle(30);
    expect(panel()).toBeNull();
    expect(walkupFrames()).toBe(0);
    // No house-board poll and no GET /me for a closed pop-up.
    expect(count('/api/floor/arena/house-board')).toBe(0);
    expect(count('/api/floor/arena/me')).toBe(0);
  });

  test('walking up shows the panel and starts ONE frame loop; walking away stops it', async () => {
    await render(createElement(HouseAgentWalkup));
    await walkUp(0);
    expect(panel()).not.toBeNull();
    expect(walkupFrames()).toBe(1);
    await walkUp(-1);
    expect(panel()).toBeNull();
    expect(walkupFrames()).toBe(0);
  });

  test('hidden while the Exchange panel is open', async () => {
    await render(createElement(HouseAgentWalkup));
    await walkUp(2);
    expect(panel()).not.toBeNull();
    await act(async () => {
      useGameStore.getState().openTradingFloor();
    });
    expect(panel()).toBeNull();
    expect(walkupFrames()).toBe(0);
    await act(async () => {
      useGameStore.getState().closeExchange();
    });
    expect(panel()).not.toBeNull();
  });

  test('the close button hides it until the player leaves the radius and comes back', async () => {
    await render(createElement(HouseAgentWalkup));
    await walkUp(1, true);
    await click(byTestId('house-agent-walkup-close'));
    expect(panel()).toBeNull();
    await walkUp(1, false);
    expect(panel()).toBeNull();
    await walkUp(-1);
    await walkUp(1);
    expect(panel()).not.toBeNull();
  });
});

describe('content', () => {
  test('name, mode pill, status, tagline, one live line, thesis, risk and the TEMPLATE exit rule', async () => {
    await render(createElement(HouseAgentWalkup));
    await walkUp(0);
    await waitFor(() => (panel()?.textContent ?? '').includes('Contest'), 'the live line');
    const text = panel()!.textContent ?? '';
    const genesis = FLOOR_ARENA_TEMPLATES[0]!;
    expect(text).toContain('Genesis');
    expect(text).toContain('PAPER');
    expect(text).toContain('Active');
    expect(text).toContain(genesis.tagline);
    expect(text).toContain(genesis.thesis);
    expect(text).toContain(genesis.risk);
    // Live line: the contest window while the contest runs.
    expect(text).toContain('+$7.77');
    expect(text).toContain('7 wins');
    expect(text).toContain('10 losses');
    expect(text).toContain('1 open trade');
    // The template's exit rule (what the player gets), not the house agent's live params.
    expect(text).toContain('TP 1.10x sells 100%');
    expect(text).toContain('Max hold 15 min');
    expect(text).not.toContain('changed its rules');
  });

  test('outside the contest window the live line uses the last 24 hours', async () => {
    boardReply = { status: 200, body: boardBody({}, { startsAt: '2000-01-01T00:00:00Z', endsAt: '2000-01-02T00:00:00Z' }) };
    await render(createElement(HouseAgentWalkup));
    await walkUp(0);
    await waitFor(() => (panel()?.textContent ?? '').includes('Last 24 h'), 'the 24 h live line');
    expect(panel()!.textContent).toContain('-$2.50');
    // The staging build rendered "+$32.49realised" (2026-10-02 film QC): the space must be explicit.
    expect(panel()!.textContent).toContain('-$2.50 realised P&L');
  });

  test('a LIVE house agent shows LIVE, not PAPER', async () => {
    boardReply = { status: 200, body: boardBody({ mode: 'live', status: 'paused' }) };
    await render(createElement(HouseAgentWalkup));
    await walkUp(0);
    await waitFor(() => (panel()?.textContent ?? '').includes('LIVE'), 'the live pill');
    expect(panel()!.textContent).not.toContain('PAPER');
    expect(panel()!.textContent).toContain('Paused');
  });

  test('paramsVersion > 1 adds the "changed its rules" line', async () => {
    boardReply = { status: 200, body: boardBody({ paramsVersion: 3 }) };
    await render(createElement(HouseAgentWalkup));
    await walkUp(0);
    await waitFor(() => (panel()?.textContent ?? '').includes('changed its rules'), 'the rules note');
    expect(panel()!.textContent).toContain(
      'This house agent changed its rules since launch. You start from the template rules.',
    );
  });

  test('the template copy shows before the live data, and a failed read says so', async () => {
    boardReply = { status: 503, body: { error: 'unavailable' } };
    await render(createElement(HouseAgentWalkup));
    await walkUp(4);
    expect(panel()!.textContent).toContain(FLOOR_ARENA_TEMPLATES[4]!.tagline);
    await waitFor(() => (panel()?.textContent ?? '').includes('not available'), 'the unavailable line');
  });

  test('desktop hint "or press E" only when E reaches this rung', async () => {
    await render(createElement(HouseAgentWalkup));
    await walkUp(0, false);
    expect(panel()!.textContent).not.toContain('or press E');
    await walkUp(0, true);
    expect(panel()!.textContent).toContain('or press E');
  });

  test('no "or press E" on a touch device (the USE button is the equivalent)', async () => {
    setViewport(744, 1133);
    await render(createElement(HouseAgentWalkup));
    await walkUp(0, true);
    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).not.toContain('or press E');
  });

  test('every button is at least 44 px; the close button is 44 x 44', async () => {
    await render(createElement(HouseAgentWalkup));
    await walkUp(0, true);
    const buttons = [...panel()!.querySelectorAll('button')] as HTMLElement[];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const button of buttons) {
      const height = parseFloat(button.style.minHeight || button.style.height || '0');
      expect(height).toBeGreaterThanOrEqual(44);
    }
    const close = byTestId('house-agent-walkup-close')!;
    expect(parseFloat(close.style.width || close.style.minWidth)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(close.style.height || close.style.minHeight)).toBeGreaterThanOrEqual(44);
  });

  test('no em dash in the copy or the source', async () => {
    boardReply = { status: 200, body: boardBody({ paramsVersion: 2 }) };
    await render(createElement(HouseAgentWalkup));
    for (let index = 0; index < FLOOR_ARENA_TEMPLATES.length; index += 1) {
      await walkUp(index, true);
      await settle(20);
      expect(panel()!.textContent).not.toContain(EM_DASH);
    }
    for (const file of [
      join(import.meta.dir, 'house-agent-walkup.tsx'),
      join(import.meta.dir, 'house-agent-walkup-placement.ts'),
      join(import.meta.dir, '..', '..', 'stores', 'house-agent-walkup.ts'),
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain(EM_DASH);
    }
  });
});

describe('phone width < 600: compact card', () => {
  test('docks at top 72 centred, with thesis and risk behind "Details"', async () => {
    setViewport(390, 844);
    await render(createElement(HouseAgentWalkup));
    await walkUp(1);
    const runner = FLOOR_ARENA_TEMPLATES[1]!;
    const text = () => panel()!.textContent ?? '';
    expect(text()).toContain(runner.tagline);
    expect(text()).not.toContain(runner.thesis);
    expect(text()).not.toContain(runner.risk);
    const details = byTestId('house-agent-walkup-details')!;
    expect(details.getAttribute('aria-expanded')).toBe('false');
    await click(details);
    expect(text()).toContain(runner.thesis);
    expect(text()).toContain(runner.risk);
    expect(byTestId('house-agent-walkup-details')!.getAttribute('aria-expanded')).toBe('true');
    const width = Math.min(390 * 0.92, 360);
    expect(panel()!.style.width).toBe(`${Math.round(width)}px`);
    expect(panel()!.style.transform).toBe(`translate3d(${Math.round((390 - width) / 2)}px, 72px, 0px)`);
  });
});

describe('placement loop', () => {
  test('positions beside the anchor and rewrites transform only on a move of 0.5 px or more', async () => {
    await render(createElement(HouseAgentWalkup));
    await walkUp(0);
    const element = panel()!;
    // happy-dom has no layout, so the panel height reads 0: top = anchor y.
    expect(element.style.transform).toBe('translate3d(428px, 380px, 0px)');
    expect(element.style.width).toBe('320px');
    element.style.transform = 'translate3d(1px, 1px, 0px)';
    houseAgentWalkupAnchor.x = 400.3;
    runFrame();
    expect(element.style.transform).toBe('translate3d(1px, 1px, 0px)');
    houseAgentWalkupAnchor.x = 400.7;
    runFrame();
    expect(element.style.transform).toBe('translate3d(429px, 380px, 0px)');
    // The loop keeps going while open.
    expect(walkupFrames()).toBe(1);
  });

  test('an off-screen anchor docks the panel at the nearest side edge', async () => {
    await render(createElement(HouseAgentWalkup));
    houseAgentWalkupAnchor.onScreen = false;
    houseAgentWalkupAnchor.x = 1200;
    await walkUp(3);
    expect(panel()!.style.transform).toBe(`translate3d(${1366 - 16 - 320}px, ${768 / 2}px, 0px)`);
  });
});

describe('button flow', () => {
  test('"Choose this trading style" opens the existing launch with the template preselected', async () => {
    await render(createElement(HouseAgentWalkup));
    await walkUp(2);
    await waitFor(() => count('/api/floor/arena/me') > 0, 'GET /me');
    await settle(20);
    const primary = byTestId('house-agent-walkup-primary')!;
    expect(primary.textContent).toContain('Choose this trading style');
    await click(primary);
    expect(useFloorArenaUi.getState()).toMatchObject({ panel: 'launch', launchTemplateId: 'dip-hunter' });
    expect(useGameStore.getState()).toMatchObject({ exchangeOpen: true, exchangeTab: 'floor' });
    // A viewer who can own a trader leaves no pending key behind.
    expect(testWindow.sessionStorage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY)).toBeNull();
    // And the pop-up gives way to the Exchange panel.
    expect(panel()).toBeNull();
  });

  test('"Watch its trades" opens that house agent\'s profile', async () => {
    await render(createElement(HouseAgentWalkup));
    await walkUp(3);
    await click(byTestId('house-agent-walkup-watch'));
    expect(useFloorArenaUi.getState()).toMatchObject({ panel: 'profile', profileAgentId: 'house:midcap-climber' });
    expect(useGameStore.getState()).toMatchObject({ exchangeOpen: true, exchangeTab: 'floor' });
  });

  test('a viewer with a trader sees "Open my trader" and "One trader per account."', async () => {
    meReply = { status: 200, body: meWithAgent() };
    await render(createElement(HouseAgentWalkup));
    await walkUp(0);
    await waitFor(() => (byTestId('house-agent-walkup-primary')?.textContent ?? '').includes('Open my trader'), 'the owner button');
    expect(panel()!.textContent).toContain('One trader per account.');
    expect(panel()!.textContent).not.toContain('Choose this trading style');
    await click(byTestId('house-agent-walkup-primary'));
    expect(useFloorArenaUi.getState().panel).toBe('desk');
    expect(useGameStore.getState()).toMatchObject({ exchangeOpen: true, exchangeTab: 'floor' });
  });

  test('guest: the same call shows the sign-up card, the choice is kept, and the launch reopens ONCE after sign-up at step 2', async () => {
    authReply = { status: 401, body: { error: 'Unauthorized' } };
    await render(createElement(HouseAgentWalkup), createElement(SectionHarness));
    await walkUp(1);
    await waitFor(() => useHouseAgentWalkupPanel.getState().viewer === 'cannot-own', 'the guest verdict');
    // A guest never asks for GET /me (it can only answer 401).
    expect(count('/api/floor/arena/me')).toBe(0);
    await click(byTestId('house-agent-walkup-primary'));
    expect(useFloorArenaUi.getState()).toMatchObject({ panel: 'launch', launchTemplateId: 'runner' });
    await waitFor(() => byTestId('arena-launch-guest') !== null, 'the existing sign-up card');
    const stored = JSON.parse(testWindow.sessionStorage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY) ?? 'null') as {
      templateId: string;
      at: number;
    } | null;
    expect(stored?.templateId).toBe('runner');

    // Sign-up: clearIdentityState runs resetIdentity (which drops launchTemplateId)
    // and resets the query cache; the player is now a real account with no trader.
    await act(async () => {
      useGameStore.getState().closeExchange();
      useFloorArenaUi.getState().resetIdentity();
    });
    await walkUp(-1);
    expect(useFloorArenaUi.getState().launchTemplateId).toBeNull();
    let launches = 0;
    const unsubscribe = useGameStore.subscribe((state, previous) => {
      if (state.exchangeOpen && !previous.exchangeOpen) launches += 1;
    });
    authReply = { status: 200, body: { user: { id: 'u2', isGuest: false } } };
    meReply = { status: 200, body: { agent: null } };
    await act(async () => {
      await client!.resetQueries();
    });
    await waitFor(() => useGameStore.getState().exchangeOpen, 'the launch to reopen');
    expect(useFloorArenaUi.getState()).toMatchObject({ panel: 'launch', launchTemplateId: 'runner' });
    expect(testWindow.sessionStorage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY)).toBeNull();
    // LaunchTrader starts at step 2 with that template.
    await waitFor(() => (container?.textContent ?? '').includes('Starting from Runner.'), 'step 2 of the launch');

    // ONCE: closing the panel and further GET /me answers never reopen it.
    await act(async () => {
      useGameStore.getState().closeExchange();
    });
    await act(async () => {
      await client!.refetchQueries();
    });
    await settle(50);
    unsubscribe();
    expect(launches).toBe(1);
    expect(useGameStore.getState().exchangeOpen).toBe(false);
  });

  test('a stored choice resumes on the next visit for a real account with no trader, then is gone', async () => {
    testWindow.sessionStorage.setItem(
      HOUSE_AGENT_PENDING_TEMPLATE_KEY,
      JSON.stringify({ templateId: 'midcap-climber', at: Date.now() - 60_000 }),
    );
    await render(createElement(HouseAgentWalkup));
    await waitFor(() => useGameStore.getState().exchangeOpen, 'the resumed launch');
    expect(useFloorArenaUi.getState()).toMatchObject({ panel: 'launch', launchTemplateId: 'midcap-climber' });
    expect(testWindow.sessionStorage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY)).toBeNull();
  });

  test('a stored choice is dropped, not opened, for an account that already has a trader', async () => {
    meReply = { status: 200, body: meWithAgent() };
    testWindow.sessionStorage.setItem(
      HOUSE_AGENT_PENDING_TEMPLATE_KEY,
      JSON.stringify({ templateId: 'genesis', at: Date.now() - 60_000 }),
    );
    await render(createElement(HouseAgentWalkup));
    await waitFor(() => testWindow.sessionStorage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY) === null, 'the key to clear');
    await settle(30);
    expect(useGameStore.getState().exchangeOpen).toBe(false);
  });

  test('an expired stored choice never opens anything', async () => {
    testWindow.sessionStorage.setItem(
      HOUSE_AGENT_PENDING_TEMPLATE_KEY,
      JSON.stringify({ templateId: 'genesis', at: Date.now() - 31 * 60_000 }),
    );
    await render(createElement(HouseAgentWalkup));
    await settle(80);
    expect(useGameStore.getState().exchangeOpen).toBe(false);
    expect(testWindow.sessionStorage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY)).toBeNull();
  });

  // Plan §3 / §9: NOT VERIFIED what GET /me returns for a logged-in account with
  // no active avatar. Read from code: requireAuthOrAgentSession throws 403
  // "Active avatar required" for that account, and the arena section counts a
  // 403 as "cannot own", so a REAL account sees the guest sign-up card. This
  // pins the CURRENT behaviour (reported to the lead; not this task's files).
  test('current behaviour: a real account whose GET /me is 403 (no avatar) is treated like a guest', async () => {
    meReply = { status: 403, body: { error: 'Active avatar required' } };
    await render(createElement(HouseAgentWalkup), createElement(SectionHarness));
    await walkUp(0);
    await waitFor(() => useHouseAgentWalkupPanel.getState().viewer === 'cannot-own', 'the 403 verdict');
    await click(byTestId('house-agent-walkup-primary'));
    expect(useFloorArenaUi.getState()).toMatchObject({ panel: 'launch', launchTemplateId: 'genesis' });
    expect(testWindow.sessionStorage.getItem(HOUSE_AGENT_PENDING_TEMPLATE_KEY)).not.toBeNull();
    await waitFor(() => byTestId('arena-launch-guest') !== null, 'the sign-up card');
  });
});
