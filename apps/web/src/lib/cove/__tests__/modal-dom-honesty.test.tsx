import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { act, createElement, type ComponentType } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { QueryClient as QueryClientType } from '@tanstack/react-query';

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerCallback = () => void;
type TimerFunction = (
  callback: (...args: unknown[]) => void,
  delay?: number,
  ...args: unknown[]
) => TimerHandle;

const testWindow = new Window({ url: 'http://localhost/cove' });
const installedGlobals = [
  'Node',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLIFrameElement',
  'SVGElement',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
] as const;

let createRoot: typeof import('react-dom/client').createRoot;
let QueryClient: typeof import('@tanstack/react-query').QueryClient;
let QueryClientProvider: typeof import('@tanstack/react-query').QueryClientProvider;
let BlackjackModal: ComponentType;
let BaccaratModal: ComponentType;
let useCoveStore: typeof import('@/stores/cove').useCoveStore;
let useGameStore: typeof import('@/stores/game').useGameStore;
let mountedRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;
let queryClient: QueryClientType | null = null;
let originalFetch: typeof fetch;

function installDom(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: testWindow,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: testWindow.document,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: testWindow.navigator,
  });
  for (const name of installedGlobals) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: testWindow[name],
    });
  }
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: testWindow.getComputedStyle.bind(testWindow),
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: testWindow.requestAnimationFrame.bind(testWindow),
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: testWindow.cancelAnimationFrame.bind(testWindow),
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function shoe(game: 'blackjack' | 'baccarat') {
  return {
    id: `${game}-shoe`,
    userId: null,
    currency: 'clawtoken',
    serverSeedHash: 'a'.repeat(64),
    clientSeed: 'client-seed',
    ...(game === 'blackjack'
      ? { handCounter: 0, handsPlayed: 0, lastHandAt: null }
      : { coupCounter: 0, coupsPlayed: 0, lastCoupAt: null }),
    cursorCounter: 0,
    dealtCount: 0,
    startingBalance: '100',
    currentBalance: '100',
    totalBet: '0',
    totalPayout: '0',
    status: 'open',
    createdAt: '2026-07-28T00:00:00.000Z',
    closedAt: null,
    serverSeed: null,
  };
}

const BLACKJACK_SETTLED = {
  handId: 'blackjack-hand',
  shoeId: 'blackjack-shoe',
  handIndex: 1,
  status: 'settled',
  outcome: {
    kind: 'blackjack',
    playerHands: [{
      cards: [
        { suit: 'hearts', rank: 'A' },
        { suit: 'spades', rank: 'K' },
      ],
      total: 21,
      isSoft: true,
      isBust: false,
      isBlackjack: true,
      isDoubled: false,
      bet: '25',
      outcome: 'blackjack',
      payout: '62',
    }],
    dealer: {
      cards: [
        { suit: 'clubs', rank: 'A' },
        { suit: 'diamonds', rank: '9' },
      ],
      total: 20,
      isSoft: true,
      isBust: false,
      isBlackjack: false,
    },
    insurance: null,
    totalBet: '25',
    totalPayout: '62',
    net: '37',
    rake: '1',
    rakedPayout: '61',
    rakedNet: '36',
    cursorBefore: 0,
    cursorAfter: 4,
    dealtBefore: 0,
    dealtAfter: 4,
    nonce: 1,
    engineVersion: 'test',
  },
  balance: 136,
  totalBet: '25',
  totalPayout: '61',
  net: '36',
  dealtCount: 4,
  reshuffleSuggested: false,
  idempotencyReplay: false,
  dealtImmediately: true,
};

const BACCARAT_SETTLED = {
  coupId: 'baccarat-coup',
  shoeId: 'baccarat-shoe',
  coupIndex: 1,
  status: 'settled',
  outcome: {
    kind: 'baccarat',
    bet: 'banker',
    stake: '25',
    player: {
      cards: [
        { suit: 'hearts', rank: '4' },
        { suit: 'spades', rank: '3' },
        { suit: 'clubs', rank: '2' },
      ],
      total: 9,
      isNatural: false,
    },
    banker: {
      cards: [
        { suit: 'clubs', rank: '5' },
        { suit: 'diamonds', rank: '4' },
        { suit: 'hearts', rank: 'K' },
      ],
      total: 9,
      isNatural: false,
    },
    winner: 'banker',
    payout: '49',
    net: '24',
    commission: '1',
    cursorBefore: 0,
    cursorAfter: 6,
    dealtBefore: 0,
    dealtAfter: 6,
    nonce: 1,
    engineVersion: 'test',
  },
  balance: 124,
  totalBet: '25',
  totalPayout: '49',
  net: '24',
  dealtCount: 6,
  reshuffleSuggested: false,
  idempotencyReplay: false,
};

function captureRevealTimers(delays: readonly number[]) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const callOriginalSetTimeout = originalSetTimeout as unknown as TimerFunction;
  const captured = new Map<number, { callback: TimerCallback; delay: number }>();
  let nextHandle = 100_000;

  const interceptedSetTimeout: TimerFunction = (
    callback,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delays.includes(Number(delay))) {
      nextHandle += 1;
      captured.set(nextHandle, {
        callback: () => callback(...args),
        delay: Number(delay),
      });
      return nextHandle as unknown as TimerHandle;
    }
    return callOriginalSetTimeout(callback, delay, ...args);
  };
  globalThis.setTimeout = interceptedSetTimeout as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: TimerHandle) => {
    if (!captured.delete(handle as unknown as number)) {
      originalClearTimeout(handle);
    }
  }) as typeof clearTimeout;

  return {
    async run(delay: number): Promise<void> {
      const entry = [...captured.entries()].find(([, timer]) => timer.delay === delay);
      if (!entry) throw new Error(`No captured ${delay}ms reveal timer`);
      captured.delete(entry[0]);
      await act(async () => {
        entry[1].callback();
        await Promise.resolve();
      });
    },
    restore(): void {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      captured.clear();
    },
  };
}

async function flushWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountModal(Component: ComponentType): Promise<HTMLElement> {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(['avatar'], {
    avatar: { id: 'avatar-test', clawTokens: 100 },
  });
  queryClient.setQueryData(['auth-me'], null);
  mountedContainer = document.createElement('div');
  document.body.append(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  await act(async () => {
    mountedRoot?.render(createElement(
      QueryClientProvider,
      { client: queryClient! },
      createElement(Component),
    ));
    await Promise.resolve();
  });
  await flushWork();
  return mountedContainer;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button containing "${text}" was not mounted`);
  }
  return button;
}

beforeAll(async () => {
  installDom();
  process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000';
  originalFetch = globalThis.fetch;
  ({ createRoot } = await import('react-dom/client'));
  ({ QueryClient, QueryClientProvider } = await import('@tanstack/react-query'));
  ({ useCoveStore } = await import('@/stores/cove'));
  ({ useGameStore } = await import('@/stores/game'));
  BlackjackModal = (await import(
    '@/components/cove/blackjack/BlackjackModal'
  )).default;
  BaccaratModal = (await import(
    '@/components/cove/baccarat/BaccaratModal'
  )).default;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (mountedRoot) {
    await act(async () => mountedRoot?.unmount());
  }
  mountedContainer?.remove();
  queryClient?.clear();
  mountedRoot = null;
  mountedContainer = null;
  queryClient = null;
  useCoveStore.setState({
    blackjackOpen: false,
    baccaratOpen: false,
  });
});

afterAll(() => {
  testWindow.close();
});

describe('executed 2D modal DOM honesty', () => {
  test('blackjack conceals banner and balance and renders N+? until dealer reveal', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/session/current')) {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      if (url.pathname.endsWith('/session/open')) {
        return jsonResponse({ shoe: shoe('blackjack'), walletBalance: 100 });
      }
      if (url.pathname.endsWith('/hand/deal') && init?.method === 'POST') {
        return jsonResponse(BLACKJACK_SETTLED);
      }
      throw new Error(`Unexpected blackjack fetch: ${init?.method ?? 'GET'} ${url.pathname}`);
    }) as typeof fetch;
    useGameStore.setState({
      agentConnected: false,
      agentSessionId: null,
    });
    useCoveStore.setState({
      blackjackOpen: true,
      blackjackBet: 25,
      blackjackDisplayBalance: 100,
    });

    const container = await mountModal(BlackjackModal);
    const timers = captureRevealTimers([420, 550]);
    try {
      expect(container.querySelector('.bj2d-header')?.textContent).toContain('100 vCLAW');
      await act(async () => buttonByText(container, 'Deal (25 vCLAW)').click());
      await flushWork();

      expect(container.querySelector('[data-testid="bj-outcome-banner"]')).toBeNull();
      expect(container.querySelector('.bj2d-dealer')?.textContent).toContain('11+?');
      expect(container.querySelector('.bj2d-header')?.textContent).toContain('100 vCLAW');

      await timers.run(420);
      expect(container.querySelector('[data-testid="bj-outcome-banner"]')).toBeNull();
      expect(container.querySelector('.bj2d-dealer')?.textContent).toContain('20');
      expect(container.querySelector('.bj2d-dealer')?.textContent).not.toContain('+?');
      expect(container.querySelector('.bj2d-header')?.textContent).toContain('100 vCLAW');

      await timers.run(550);
      expect(container.querySelector('[data-testid="bj-outcome-banner"]')?.textContent)
        .toContain('BLACKJACK!');
      expect(container.querySelector('.bj2d-header')?.textContent).toContain('136 vCLAW');
    } finally {
      timers.restore();
    }
  });

  test('baccarat conceals banner and balance through the terminal-card commit', async () => {
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/session/current')) {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      if (url.pathname.endsWith('/session/open')) {
        return jsonResponse({ shoe: shoe('baccarat'), walletBalance: 100 });
      }
      if (url.pathname.endsWith('/coup') && init?.method === 'POST') {
        return jsonResponse(BACCARAT_SETTLED);
      }
      throw new Error(`Unexpected baccarat fetch: ${init?.method ?? 'GET'} ${url.pathname}`);
    }) as typeof fetch;
    useCoveStore.setState({
      baccaratOpen: true,
      baccaratBet: 25,
      baccaratDisplayBalance: 100,
    });

    const container = await mountModal(BaccaratModal);
    const timers = captureRevealTimers([120, 240]);
    try {
      expect(container.querySelector('.bac2d-header')?.textContent).toContain('100 vCLAW');
      await act(async () => buttonByText(container, 'Deal PLAYER (25 vCLAW)').click());
      await flushWork();

      expect(container.querySelector('[data-testid="bac-outcome-banner"]')).toBeNull();
      expect(container.querySelectorAll('.bac2d-hands [aria-label*=" of "]')).toHaveLength(1);
      expect([...container.querySelectorAll('.bac2d-hands > div')].map(
        (hand) => [...(hand.children[1]?.children ?? [])]
          .filter((child) => child.tagName === 'DIV').length,
      )).toEqual([2, 2]);
      expect(container.querySelector('.bac2d-header')?.textContent).toContain('100 vCLAW');

      await timers.run(240);
      await timers.run(240);
      await timers.run(240);
      await timers.run(240);
      await timers.run(240);
      expect(container.querySelectorAll('.bac2d-hands [aria-label*=" of "]')).toHaveLength(6);
      expect([...container.querySelectorAll('.bac2d-hands > div')].map(
        (hand) => [...(hand.children[1]?.children ?? [])]
          .filter((child) => child.tagName === 'DIV').length,
      )).toEqual([3, 3]);
      expect(container.querySelector('[data-testid="bac-outcome-banner"]')).toBeNull();
      expect(container.querySelector('.bac2d-header')?.textContent).toContain('100 vCLAW');

      await timers.run(120);
      expect(container.querySelector('[data-testid="bac-outcome-banner"]')?.textContent)
        .toContain('BANKER WINS');
      expect(container.querySelector('.bac2d-header')?.textContent).toContain('124 vCLAW');
    } finally {
      timers.restore();
    }
  });

  test('baccarat: Walk Away reachable from idle mid-shoe; Deal locks after the seed reveals', async () => {
    let closeCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/session/current')) {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      if (url.pathname.endsWith('/session/open')) {
        return jsonResponse({ shoe: shoe('baccarat'), walletBalance: 100 });
      }
      if (url.pathname.endsWith('/coup') && init?.method === 'POST') {
        return jsonResponse(BACCARAT_SETTLED);
      }
      if (url.pathname.endsWith('/session/close') && init?.method === 'POST') {
        closeCalls += 1;
        return jsonResponse({
          shoeId: 'baccarat-shoe',
          status: 'closed',
          serverSeed: 'b'.repeat(64),
          serverSeedHash: 'a'.repeat(64),
          clientSeed: 'client-seed',
          coupsPlayed: 1,
          totalBet: '25',
          totalPayout: '49',
          closedAt: '2026-08-20T00:00:00.000Z',
        });
      }
      throw new Error(`Unexpected baccarat fetch: ${init?.method ?? 'GET'} ${url.pathname}`);
    }) as typeof fetch;
    useCoveStore.setState({
      baccaratOpen: true,
      baccaratBet: 25,
      baccaratDisplayBalance: 100,
    });

    const container = await mountModal(BaccaratModal);
    // Real tier: the walk-away path branches on isRealTier (guest = plain
    // close, no shoe close / seed reveal). The harness default seeds auth-me
    // as null (guest), so promote to a logged-in user for this test.
    queryClient!.setQueryData(['auth-me'], { user: { id: 'user-test', isGuest: false } });
    await flushWork();
    // 1400 = the post-walk-away auto-close timer — captured so it can neither
    // fire for real between tests nor race the assertions below.
    const timers = captureRevealTimers([120, 240, 1400]);
    try {
      // Fresh no-shoe idle: no Walk Away (nothing to close).
      expect(
        [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Walk Away')),
      ).toBe(false);

      await act(async () => buttonByText(container, 'Deal PLAYER (25 vCLAW)').click());
      await flushWork();
      for (let index = 0; index < 5; index += 1) await timers.run(240);
      await timers.run(120); // settle

      // Back to idle mid-shoe: Walk Away must now be reachable (the old gate
      // rendered it only on phase==='settled', trapping idle players in the
      // shoe with no cash-out path short of dealing another coup).
      await act(async () => buttonByText(container, 'Next Coup').click());
      await flushWork();
      const walkAway = buttonByText(container, 'Walk Away');
      expect(walkAway.disabled).toBe(false);

      await act(async () => walkAway.click());
      await flushWork();
      expect(closeCalls).toBe(1);
      // Auto-close armed: Deal must be locked (an enabled Deal here would open
      // an orphaned shoe the pending close then skips) and Walk Away is gone.
      expect(buttonByText(container, 'Deal PLAYER (25 vCLAW)').disabled).toBe(true);
      expect(
        [...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Walk Away')),
      ).toBe(false);
    } finally {
      timers.restore();
    }
  });
});
