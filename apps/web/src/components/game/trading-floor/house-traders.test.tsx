import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

import type { HouseTraderSlotView } from '@/hooks/use-trading-floor';
import type { FloorTrade } from '@/stores/trade-ticker';

// Same DOM harness as floor-components.test.tsx.
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

const AVATAR_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

let createRoot: typeof import('react-dom/client').createRoot;
let HouseTradersView: typeof import('./house-traders').HouseTradersView;
let useTradeTickerStore: typeof import('@/stores/trade-ticker').useTradeTickerStore;
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

function slot(overrides: Partial<HouseTraderSlotView> = {}): HouseTraderSlotView {
  return {
    objective: 'momentum-board',
    slotName: 'Genesis',
    strategyNote: 'Momentum on small-cap memecoins, any venue.',
    status: 'not-yet-running',
    subject: null,
    counts: { verified: 0, scored: 0, lastTradeAt: null },
    recentTrades: [],
    ...overrides,
  };
}

function tickerTrade(): FloorTrade {
  return {
    kind: 'trade',
    keys: ['t:live-sig'],
    signature: 'LIVE000000000000000000000000000000000000000000000000000000000000',
    subject: { type: 'agent', id: AVATAR_ID, avatarName: 'Genesis' },
    wallet: null,
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    notionalUsd: 12,
    dex: 'jupiter',
    blockTime: 1_789_000_000,
    multiplier: 1,
    multiplierTier: 'base',
    decisionId: null,
    scored: true,
    unscoredReason: null,
    operatedByClawville: false,
  };
}

/** Drives the presentational half directly. No module stubbing: a module
 *  namespace object cannot be patched, and `mock.module` is process global and
 *  would poison every sibling file in the lane. */
async function renderWithSlots(slots: HouseTraderSlotView[]): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(HouseTradersView, {
        slots,
        isLoading: false,
        isError: false,
        nowMs: Date.now(),
        compact: false,
      }),
    );
  });
  return container;
}

beforeAll(async () => {
  rememberDom();
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ useTradeTickerStore } = await import('@/stores/trade-ticker'));
  ({ HouseTradersView } = await import('./house-traders'));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useTradeTickerStore.setState({ entries: [] });
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('House traders section', () => {
  test('renders the two lineup slots and the not-running copy', async () => {
    const host = await renderWithSlots([
      slot(),
      slot({
        objective: 'sol-usdc-mean-reversion',
        slotName: 'Dip Hunter',
        strategyNote: 'Buys sharp dips in strong mid-cap coins.',
      }),
    ]);
    const text = host.textContent ?? '';
    const occurrences = text.split('Not running yet. This slot has no paired trader.').length - 1;
    expect(occurrences).toBe(2);
    // Unpair deletes the link, so an unpaired slot cannot show `stopped` while
    // its old trades stay on the tape. This sentence is what keeps the two
    // public surfaces in one tab from contradicting each other.
    expect(text).toContain('can still appear on the tape');
    // A spinner would imply pending activity that does not exist.
    expect(text).not.toContain('Loading house traders');
    expect(text).toContain('Genesis');
    expect(text).toContain('Dip Hunter');
    // The three dropped profiles are TEMPLATES, not house traders.
    for (const dropped of ['AnsemDCA', 'MeanRevert', 'SignalFollower', 'SafeRebalancer']) {
      expect(text).not.toContain(dropped);
    }
  });

  test('renders the lineup strategy note, never the profile brief or its mints', async () => {
    const host = await renderWithSlots([slot()]);
    const text = host.textContent ?? '';
    expect(text).toContain('Momentum on small-cap memecoins, any venue.');
    // Genesis holds the momentum-board slot but trades far outside that
    // profile's allowed outputs, so the profile text would be a false claim.
    expect(text).not.toContain('Buy strength and take profit back into SOL or USDC');
    expect(text).not.toContain('SOL, USDC');
  });

  test('shows an occupied slot as live with its counts', async () => {
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: AVATAR_ID, avatarName: 'Genesis' },
        counts: { verified: 7, scored: 4, lastTradeAt: new Date().toISOString() },
      }),
    ]);
    const text = host.textContent ?? '';
    expect(text).toContain('Live as Genesis');
    expect(text).toContain('7 verified');
    expect(text).toContain('4 scored');
    expect(text).not.toContain('Not running yet');
  });

  test('prepends a live ticker row for the slot avatar', async () => {
    useTradeTickerStore.setState({ entries: [tickerTrade()] });
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: AVATAR_ID, avatarName: 'Genesis' },
        counts: { verified: 1, scored: 1, lastTradeAt: new Date().toISOString() },
      }),
    ]);
    // The ticker row reaches the card without a second poller.
    expect(host.querySelectorAll('[data-testid="floor-tape-row"]').length).toBeGreaterThan(0);
  });

  test('ignores ticker rows belonging to another avatar', async () => {
    useTradeTickerStore.setState({
      entries: [{ ...tickerTrade(), subject: { type: 'agent', id: 'someone-else', avatarName: 'Other' } }],
    });
    const host = await renderWithSlots([
      slot({
        status: 'live-observed',
        subject: { type: 'agent', id: AVATAR_ID, avatarName: 'Genesis' },
        counts: { verified: 0, scored: 0, lastTradeAt: null },
      }),
    ]);
    expect(host.querySelectorAll('[data-testid="floor-tape-row"]')).toHaveLength(0);
  });

  test('shows a stopped slot as stopped and keeps its counts', async () => {
    // Unpair revokes the wallet but the verified trades stay on the tape, so
    // the card must not flip to "not running yet" with a zero count and
    // contradict the tape two cards above it.
    const host = await renderWithSlots([
      slot({
        status: 'stopped',
        subject: { type: 'agent', id: AVATAR_ID, avatarName: 'Genesis' },
        counts: { verified: 9, scored: 5, lastTradeAt: new Date().toISOString() },
      }),
    ]);
    const text = host.textContent ?? '';
    expect(text).toContain('Stopped.');
    expect(text).toContain('past trades stay on the floor');
    expect(text).toContain('9 verified');
    expect(text).not.toContain('Not running yet');
  });

  test('states at section level that the tape outlives a pairing', async () => {
    // The ONLY thing covering a full unpair: `unpairObservedClawPumpAgent`
    // DELETES the link row, so that trader leaves the panel entirely while its
    // verified trades keep scrolling on the floor below. The per-card
    // `stopped` copy cannot cover it, because there is no card left.
    const host = await renderWithSlots([slot()]);
    const text = host.textContent ?? '';
    expect(text).toContain('This panel shows the traders paired right now.');
    expect(text).toContain('including trades from a trader that is no longer paired');
  });

  test('links to the templates section rather than duplicating it', async () => {
    const host = await renderWithSlots([slot()]);
    const link = [...host.querySelectorAll('a')].find(
      (node) => node.getAttribute('href') === '#clawpump-templates',
    );
    expect(link).toBeDefined();
  });
});
