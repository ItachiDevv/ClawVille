import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

const testWindow = new Window({ url: 'http://localhost/leaderboard' });
const globalNames = ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installedNames = [
  'window',
  'document',
  'navigator',
  'fetch',
  'IS_REACT_ACT_ENVIRONMENT',
  ...globalNames,
] as const;
let createRoot: typeof import('react-dom/client').createRoot;
let LeaderboardPage: typeof import('./page').default;
let root: Root | null = null;
let container: HTMLElement | null = null;
let includeTrades = false;
let clawpumpOperated = false;
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
  Object.defineProperty(testWindow, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
}

function breakdown() {
  return {
    building_visits: 1,
    teacher_chats: 0,
    collaborations: 0,
    agent_connected: 0,
    skills_learned: 0,
    bounty_completed: 0,
    quests_completed: 0,
    activity_gold: 0,
    activity_silver: 0,
    activity_bronze: 0,
    activity_other: 0,
    ...(includeTrades
      ? { trades_verified: 2, trades_ansem: 1, trades_clv: 1, trades_base: 0 }
      : {}),
  };
}

function responseBody() {
  return {
    window: '7d',
    generatedAt: '2026-09-16T10:00:00.000Z',
    totalRanked: 4,
    agents: Array.from({ length: 4 }, (_, index) => ({
      rank: index + 1,
      agentId: `agent-${index + 1}`,
      avatarName: `Agent ${index + 1}`,
      walletAddress: null,
      score: 100 - index,
      breakdown: breakdown(),
      operatedByClawville: includeTrades && !clawpumpOperated && index === 0,
      operator: clawpumpOperated ? 'clawpump' : null,
    })),
  };
}

async function renderPage(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, createElement(LeaderboardPage)));
  });
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

beforeAll(async () => {
  rememberDom();
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  LeaderboardPage = (await import('./page')).default;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(JSON.stringify(responseBody()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  clawpumpOperated = false;
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('leaderboard Trader capability', () => {
  test('hides all trade UI when the payload omits the capability', async () => {
    includeTrades = false;
    const view = await renderPage();
    expect(view.textContent).toContain('Ranks 4');
    expect(view.textContent).not.toContain('Verified trading');
    expect(view.textContent).not.toContain('ClawVille-operated');
    expect(view.querySelectorAll('[data-trader-metric]')).toHaveLength(0);
  });

  test('shows ClawPump operation on podium and table rows', async () => {
    includeTrades = true;
    clawpumpOperated = true;
    const view = await renderPage();
    expect(view.textContent).toContain('ClawPump-operated');
    expect(view.textContent).not.toContain('ClawVille-operated');
    expect(view.querySelector('article')?.textContent).toContain('ClawPump-operated');
    expect(view.querySelector('li')?.textContent).toContain('ClawPump-operated');
  });

  test('shows Trader metrics and current operator disclosure when present', async () => {
    includeTrades = true;
    const view = await renderPage();
    expect(view.textContent).toContain('Ranks 4');
    expect(view.textContent).toContain('Verified trading');
    expect(view.textContent).toContain('Trader 2');
    expect(view.textContent).toContain('ClawVille-operated');
    expect(view.querySelectorAll('[data-trader-metric]').length).toBeGreaterThan(0);
  });
});
