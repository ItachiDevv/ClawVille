import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import { act, createElement } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PENDING_UNCONFIRMED_AFTER_MS } from './format';
import { floorStatusCopy } from './floor-tape';
import type { FloorDecision, FloorTrade, TapeEntry } from '@/stores/trade-ticker';
import type { TradingWallet } from '@/hooks/use-trading-floor';
import * as tokens from './tokens';

const originalTokens = { ...tokens };

function enableSelfServe(): void {
  mock.module('./tokens', () => ({ ...originalTokens, TRADING_SELF_SERVE_ENABLED: true }));
}

function reactProps(element: HTMLElement): {
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
} {
  const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'));
  expect(key).toBeDefined();
  return (element as unknown as Record<string, ReturnType<typeof reactProps>>)[key!]!;
}

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'Node',
  'Element',
  'HTMLElement',
  'HTMLAnchorElement',
  'Event',
  'MouseEvent',
  'MutationObserver',
] as const;
const installedNames = [
  'window',
  'document',
  'navigator',
  'IS_REACT_ACT_ENVIRONMENT',
  ...globalNames,
] as const;

let createRoot: typeof import('react-dom/client').createRoot;
let TapeRow: typeof import('./trade-row').TapeRow;
let TradingFloorTab: typeof import('./trading-floor-tab').TradingFloorTab;
let queryClient: QueryClient | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;
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

function trade(scored: boolean): FloorTrade {
  return {
    kind: 'trade',
    keys: ['t:signature'],
    signature: '1234567890123456789012345678901234567890123456789012345678901234',
    subject: { type: 'agent', id: 'agent-1', avatarName: 'Ralph' },
    wallet: null,
    inputMint: 'input-mint',
    outputMint: 'output-mint',
    notionalUsd: 25,
    dex: 'jupiter',
    blockTime: 1_789_000_000,
    multiplier: scored ? 2 : 1,
    multiplierTier: scored ? 'ansem' : 'base',
    decisionId: null,
    scored,
    unscoredReason: scored ? null : 'daily_cap',
    operatedByClawville: true,
  };
}

function decision(verdict: FloorDecision['verdict'], at: string): FloorDecision {
  return {
    kind: 'decision',
    keys: [`d:${verdict}`],
    decisionId: verdict,
    subject: { type: 'agent', id: 'agent-1', avatarName: 'Ralph' },
    verdict,
    reason: verdict === 'refused' ? 'cooldown_active' : null,
    inputMint: 'input-mint',
    outputMint: 'output-mint',
    requestedUsd: 25,
    operatedByClawville: true,
    at,
  };
}

async function renderRow(entry: TapeEntry, nowMs: number): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(TapeRow, { entry, density: 'panel', nowMs }));
  });
  return container;
}

async function renderTab({
  isGuest = false,
  wallets = [],
  onGuestBlocked = () => {},
}: {
  isGuest?: boolean;
  wallets?: TradingWallet[];
  onGuestBlocked?: () => void;
} = {}): Promise<HTMLElement> {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnMount: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(['avatar'], { avatar: { walletAddress: 'custodial-wallet' } });
  queryClient.setQueryData(['wallet-link'], { linked: true, walletPubkey: 'linked-wallet' });
  queryClient.setQueryData(['trading-floor', 'wallets'], { wallets });
  queryClient.setQueryData(['trading-floor', 'mine'], { trades: [] });
  queryClient.setQueryData(['trading-floor', 'feed', 25], {
    trades: [], generatedAt: new Date().toISOString(),
    observer: { enabled: true, stale: false, lastTickAt: null },
  });
  queryClient.setQueryData(['trading-floor', 'house-traders'], []);
  Object.defineProperty(testWindow, 'solana', {
    configurable: true,
    value: { connect: mock(() => Promise.resolve({ publicKey: { toString: () => 'signed-wallet' } })) },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client: queryClient! },
      createElement(TradingFloorTab, { active: true, isGuest, onGuestBlocked })));
  });
  return container;
}

function buttonWithLabel(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.startsWith(label));
  expect(button).toBeDefined();
  return button!;
}

function expectGated(control: HTMLButtonElement | HTMLInputElement): void {
  expect(control.disabled).toBe(true);
  expect(control.getAttribute('aria-disabled')).toBe('true');
  expect(control.title).toBe(tokens.TRADING_SELF_SERVE_WALLET_EXPLANATION);
  const expectedStyle = document.createElement('button').style;
  expectedStyle.color = tokens.FLOOR_TEXT.muted;
  expect(control.style.color).toBe(expectedStyle.color);
  expect(Number(control.style.opacity)).toBeLessThan(1);
  expect(reactProps(control).onClick).toBeUndefined();
}

beforeAll(async () => {
  rememberDom();
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ TapeRow } = await import('./trade-row'));
  ({ TradingFloorTab } = await import('./trading-floor-tab'));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  queryClient?.clear();
  queryClient = null;
  Reflect.deleteProperty(testWindow, 'solana');
  mock.module('./tokens', () => originalTokens);
});

afterAll(() => {
  mock.module('./tokens', () => originalTokens);
  restoreDom();
  testWindow.close();
});

describe('Trading Floor player self-service gate', () => {
  const bindingLabels = ['Use my linked wallet', 'Use my in-game wallet', 'Connect and sign'];

  test('disables all four trading actions and the signature input without reaching mutations', async () => {
    expect(tokens.TRADING_SELF_SERVE_ENABLED).toBe(false);
    const host = await renderTab();
    for (const label of [...bindingLabels, 'Verify trade']) {
      const control = buttonWithLabel(host, label);
      expectGated(control);
      expect(control.querySelector('small')?.textContent).toBe(tokens.TRADING_SELF_SERVE_COMING_SOON);
      await act(async () => { control.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    }
    const input = host.querySelector('input')!;
    expectGated(input);
    expect(reactProps(input).onChange).toBeUndefined();
    expect(input.closest('label')?.textContent).toContain(tokens.TRADING_SELF_SERVE_COMING_SOON);
    expect(queryClient!.getMutationCache().getAll()).toHaveLength(0);
    expect([...host.querySelectorAll('p')].filter(
      (paragraph) => paragraph.textContent === tokens.TRADING_SELF_SERVE_WALLET_EXPLANATION,
    )).toHaveLength(2);
  });

  test('disables the guest wallet variant and report action without the guest handler', async () => {
    const onGuestBlocked = mock(() => {});
    const host = await renderTab({ isGuest: true, onGuestBlocked });
    for (const label of ['Create a free account', 'Verify trade']) {
      const control = buttonWithLabel(host, label);
      expectGated(control);
      expect(control.textContent).toContain(tokens.TRADING_SELF_SERVE_COMING_SOON);
      await act(async () => { control.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    }
    expect(onGuestBlocked).not.toHaveBeenCalled();
    expect(queryClient!.getMutationCache().getAll()).toHaveLength(0);
  });

  test('removes the Jupiter destination while player trading is gated', async () => {
    const host = await renderTab();
    const control = buttonWithLabel(host, 'Open Jupiter');
    expectGated(control);
    expect(control.textContent).toContain(tokens.TRADING_SELF_SERVE_COMING_SOON);
    expect(control.getAttribute('href')).toBeNull();
    expect(host.querySelector('a[href="https://jup.ag/swap"]')).toBeNull();
  });

  test('one flag restores binds, signature entry, valid reports, and Jupiter', async () => {
    enableSelfServe();
    expect(tokens.TRADING_SELF_SERVE_ENABLED).toBe(true);
    const host = await renderTab();
    for (const label of bindingLabels) {
      const control = buttonWithLabel(host, label);
      expect(control.disabled).toBe(false);
      expect(control.getAttribute('aria-disabled')).toBe('false');
      expect(typeof reactProps(control).onClick).toBe('function');
      expect(control.style.opacity).toBe('1');
    }
    const input = host.querySelector('input')!;
    expect(input.disabled).toBe(false);
    expect(buttonWithLabel(host, 'Verify trade').disabled).toBe(true);
    await act(async () => { reactProps(input).onChange!({ target: { value: 's'.repeat(64) } }); });
    expect(buttonWithLabel(host, 'Verify trade').disabled).toBe(false);
    expect(typeof reactProps(buttonWithLabel(host, 'Verify trade')).onClick).toBe('function');
    expect(host.querySelector('a[href="https://jup.ag/swap"]')).not.toBeNull();
    expect(host.textContent).not.toContain(tokens.TRADING_SELF_SERVE_COMING_SOON);
  });

  test('the enabled flag preserves the five-wallet eligibility limit', async () => {
    enableSelfServe();
    const wallets: TradingWallet[] = Array.from({ length: 5 }, (_, index) => ({
      pubkey: `wallet-${index}`, source: 'signed', subjectKind: 'avatar',
      boundAt: '2026-09-20T00:00:00Z', lastPolledAt: null, operatedByClawville: false,
    }));
    const host = await renderTab({ wallets });
    for (const label of bindingLabels) expect(buttonWithLabel(host, label).disabled).toBe(true);
    expect(host.textContent).toContain('Five wallets are already bound.');
  });

  test('the enabled flag restores the original guest callback', async () => {
    enableSelfServe();
    const onGuestBlocked = mock(() => {});
    const host = await renderTab({ isGuest: true, onGuestBlocked });
    const control = buttonWithLabel(host, 'Create a free account');
    expect(control.disabled).toBe(false);
    await act(async () => { control.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onGuestBlocked).toHaveBeenCalledTimes(1);
    expect(queryClient!.getMutationCache().getAll()).toHaveLength(0);
  });
});

describe('Trading Floor rows', () => {
  const at = '2026-09-16T10:00:00.000Z';
  const now = Date.parse(at);

  test.each([
    ['scored', trade(true), now],
    ['unscored', trade(false), now],
    ['pending', decision('submitted', at), now],
    ['unconfirmed', decision('submitted', at), now + PENDING_UNCONFIRMED_AFTER_MS],
    ['executed', decision('executed', at), now + PENDING_UNCONFIRMED_AFTER_MS * 2],
    ['blocked', decision('refused', at), now],
  ] as const)('renders the %s state', async (state, entry, clock) => {
    const view = await renderRow(entry, clock);
    const row = view.querySelector('[data-testid="floor-tape-row"]');
    expect(row?.getAttribute('data-state')).toBe(state);
    expect(row?.getAttribute('data-opacity')).toBe(state === 'unscored' ? 'muted' : 'full');
  });

  test('decision rows keep wanted size text and no signature link', async () => {
    const view = await renderRow(decision('executed', at), now);
    expect(view.textContent).toContain('wanted');
    expect(view.querySelector('a')).toBeNull();
    expect(view.textContent).toContain('EXECUTED');
  });

  test('blocked rows show safe copy instead of the refusal code', async () => {
    const view = await renderRow(decision('refused', at), now);
    expect(view.textContent).toContain('The trading cooldown is active.');
    expect(view.textContent).not.toContain('cooldown_active');
  });

  test('an unknown blocked reason renders generic copy and never the raw code', async () => {
    const unknown = {
      ...decision('refused', at),
      reason: 'future_refusal_code',
    } as unknown as FloorDecision;
    const view = await renderRow(unknown, now);
    expect(view.textContent).toContain('Blocked by a floor rule.');
    expect(view.textContent).not.toContain('future_refusal_code');
    expect(view.querySelector('a')).toBeNull();
    expect(view.textContent).toContain('wanted');
  });

  test('a mounted submitted row relabels at the injected 15-minute edge', async () => {
    const entry = decision('submitted', at);
    const view = await renderRow(entry, now + PENDING_UNCONFIRMED_AFTER_MS - 1);
    expect(view.querySelector('[data-state="pending"]')).not.toBeNull();
    await act(async () => {
      root?.render(createElement(TapeRow, {
        entry,
        density: 'panel',
        nowMs: now + PENDING_UNCONFIRMED_AFTER_MS,
      }));
    });
    expect(view.querySelector('[data-state="unconfirmed"]')).not.toBeNull();
    expect(view.querySelector('[data-opacity="full"]')).not.toBeNull();
    expect(view.textContent).toContain('wanted');
  });

  test('verified rows expose a 44px signature target', async () => {
    const view = await renderRow(trade(true), now);
    const anchor = view.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.style.minHeight).toBe('44px');
  });

  test('stream states produce distinct header copy and stopped offers reload', () => {
    expect(floorStatusCopy('live', undefined).label).toBe('LIVE FLOOR');
    expect(floorStatusCopy('reconnecting', undefined).label).toBe('RECONNECTING');
    expect(floorStatusCopy('stopped', undefined).label).toBe('STOPPED');
    expect(floorStatusCopy('stopped', undefined, false)).toEqual({
      label: 'CONNECTING',
      detail: null,
      warning: false,
    });
    expect(floorStatusCopy('live', undefined, false).label).toBe('LIVE FLOOR');
  });
});
