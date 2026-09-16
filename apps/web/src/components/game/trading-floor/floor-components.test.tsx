import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { act, createElement } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

import { PENDING_UNCONFIRMED_AFTER_MS } from './format';
import { floorStatusCopy } from './floor-tape';
import type { FloorDecision, FloorTrade, TapeEntry } from '@/stores/trade-ticker';

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

beforeAll(async () => {
  rememberDom();
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ TapeRow } = await import('./trade-row'));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

afterAll(() => {
  restoreDom();
  testWindow.close();
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
