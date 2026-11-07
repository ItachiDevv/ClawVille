import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

// The human path of the market and trust reads: the card appears for a signed-in
// non-guest human, reads only on a button press, and shows vendor labels as text.

const testWindow = new Window({ url: 'http://localhost/game', width: 1280, height: 800 });
const domNames = ['Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installed = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...domNames] as const;
let previous = new Map<PropertyKey, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

let createRoot: typeof import('react-dom/client').createRoot;
let TokenCheckCard: typeof import('./token-check-card').TokenCheckCard;
let readErrorText: typeof import('./token-check-card').readErrorText;
let api: Record<string, unknown>;
let ApiErrorClass: typeof import('@/lib/api').ApiError;
let originalApi: Record<string, unknown> = {};
let isGuest = false;
let spend: Record<string, unknown> = {};
const log: Array<{ fn: string; arg: unknown }> = [];
let screenFails: Error | null = null;

const MINT = 'So11111111111111111111111111111111111111112';
const WALLET = '3Q6QAbCWmqJfXthcXxsxpj2SXvDcmDsJJsevwMgC8BrU';
const INJECTION = '<img src=x onerror=alert(1)>';
const meta = { vendor: 'clawpump', cached: false, readsUsedToday: 1, readsPerDay: 300 };

let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;

beforeAll(async () => {
  previous = new Map(installed.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  define('window', testWindow);
  define('document', testWindow.document);
  define('navigator', testWindow.navigator);
  for (const name of domNames) define(name, testWindow[name as keyof typeof testWindow]);
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define('fetch', async () => new Response('{}', { status: 404 }));
  ({ createRoot } = await import('react-dom/client'));
  const apiModule = await import('@/lib/api');
  ApiErrorClass = apiModule.ApiError;
  api = apiModule.api as unknown as Record<string, unknown>;
  ({ TokenCheckCard, readErrorText } = await import('./token-check-card'));
  const names = ['me', 'getSpendPolicy', 'ecosystemMarket', 'ecosystemTrust', 'saidScreen'];
  originalApi = Object.fromEntries(names.map((n) => [n, api[n]]));
  api.me = async () => ({ user: { id: 'user-1', isGuest } });
  api.getSpendPolicy = async () => ({ dailyCapUsdCents: null, perCallCapUsdCents: null, allowedVendors: [], configured: false, requireApproval: false, updatedAt: null, ...spend });
  api.saidScreen = async (wallet: string, key: string) => {
    log.push({ fn: 'screen', arg: { wallet, key } });
    if (screenFails) throw screenFails;
    return { status: 'screened', vendor: 'said', wallet, verdict: 'caution', axes: { delivery: 1, payments: null, validation: null, identity: null, community: null }, eigentrust: 0.5, payment: { ledgerId: 'l', usdCents: 1, txSignature: 't' } };
  };
  api.ecosystemMarket = async (op: string, params: unknown) => {
    log.push({ fn: `market:${op}`, arg: params });
    if (op === 'search') return { ...meta, op, tokens: [{ mint: MINT, decimals: 9, verified: true, confidence: 'high', vendorData: { symbol: INJECTION, name: 'n' } }] };
    if (op === 'top_movers') return { ...meta, op, tokens: [{ mint: MINT, priceUsd: 2, change24h: 3, marketCapUsd: 4, vendorData: { symbol: 'MOVE', name: null } }] };
    return { ...meta, op, token: { mint: MINT, priceUsd: 123, change24h: -1, volume24hUsd: 5, marketCapUsd: 6, liquidityUsd: null, updatedAt: null, vendorData: { symbol: 'SOL', name: 'Solana' } } };
  };
  api.ecosystemTrust = async (wallet: string) => {
    log.push({ fn: 'trust', arg: wallet });
    return { vendor: 'said', wallet, registered: false, verified: null, scored: null, compositeScore: null, vendorData: { tier: 'unranked', trustTier: 'none' }, cached: false, readsUsedToday: 2, readsPerDay: 300 };
  };
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
  isGuest = false;
  spend = {};
  screenFails = null;
  log.length = 0;
});

afterAll(() => {
  Object.assign(api, originalApi);
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<PropertyKey, unknown>)[name];
  }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(): Promise<HTMLElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(QueryClientProvider, { client: client! }, createElement(TokenCheckCard))));
  await settle();
  return container;
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no button: ${text}`);
  return found as HTMLButtonElement;
}

async function press(el: HTMLElement): Promise<void> {
  await act(async () => { el.dispatchEvent(new (testWindow.MouseEvent as unknown as typeof MouseEvent)('click', { bubbles: true })); });
  await settle();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new (testWindow.Event as unknown as typeof Event)('input', { bubbles: true }));
  });
}

describe('TokenCheckCard', () => {
  test('stays hidden for a guest and reads nothing on open', async () => {
    isGuest = true;
    const host = await mount();
    expect(host.querySelector('[data-testid="token-check-card"]')).toBeNull();
    expect(log).toHaveLength(0);
  });

  test('a signed-in human sees the card and nothing is read before a press', async () => {
    const host = await mount();
    expect(host.textContent).toContain('Token and wallet check');
    expect(log).toHaveLength(0);
  });

  test('an address reads the price; other text searches and shows the vendor label as plain text', async () => {
    const host = await mount();
    await press(button(host, 'Token price or search'));
    const input = host.querySelector('#token-check-input') as HTMLInputElement;

    await type(input, 'bonk');
    await press(button(host, 'Check'));
    expect(log.at(-1)).toEqual({ fn: 'market:search', arg: { query: 'bonk', limit: 10 } });
    const results = host.querySelector('[data-testid="token-search-results"]') as HTMLElement;
    expect(results.textContent).toContain(INJECTION);
    expect(results.querySelector('img')).toBeNull();

    await press(results.querySelector('button') as HTMLElement);
    expect(log.at(-1)).toEqual({ fn: 'market:price', arg: { mint: MINT } });
    expect(host.querySelector('[data-testid="token-price"]')?.textContent).toContain('$123');
  });

  test('top movers and wallet trust read on a press', async () => {
    const host = await mount();
    await press(button(host, 'Top movers'));
    await press(button(host, 'Show top movers'));
    expect(log.at(-1)?.fn).toBe('market:top_movers');
    expect(host.querySelector('[data-testid="token-movers"]')?.textContent).toContain('MOVE');

    await press(button(host, 'Wallet trust'));
    const input = host.querySelector('#wallet-check-input') as HTMLInputElement;
    await type(input, 'not an address');
    expect(button(host, 'Check trust').disabled).toBe(true);
    await type(input, WALLET);
    await press(button(host, 'Check trust'));
    expect(log.at(-1)).toEqual({ fn: 'trust', arg: WALLET });
    const view = host.querySelector('[data-testid="wallet-trust"]')?.textContent ?? '';
    expect(view).toContain('unranked');
    expect(view).toContain('not known');
  });

  async function openTrust(): Promise<HTMLElement> {
    const host = await mount();
    await press(button(host, 'Wallet trust'));
    await type(host.querySelector('#wallet-check-input') as HTMLInputElement, WALLET);
    return host;
  }
  const hasPaidButton = (host: HTMLElement) => Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.includes('Paid screen'));

  test('the paid button shows only when the spend rules allow it', async () => {
    const off = await openTrust();
    expect(hasPaidButton(off)).toBe(false);
    expect(off.textContent).toContain('allow SAID');
    await act(async () => root?.unmount());
    root = null;

    spend = { configured: true, allowedVendors: ['studios'] };
    const notAllowed = await openTrust();
    expect(hasPaidButton(notAllowed)).toBe(false);
    await act(async () => root?.unmount());
    root = null;

    spend = { configured: true, allowedVendors: ['said'], requireApproval: true };
    const approval = await openTrust();
    expect(hasPaidButton(approval)).toBe(false);
    expect(approval.textContent).toContain('Ask me before each payment');
    expect(log).toHaveLength(0);
  });

  test('a paid screen shows the verdict; each finished screen gets a new key', async () => {
    spend = { configured: true, allowedVendors: ['said'] };
    const host = await openTrust();
    await press(button(host, 'Paid screen'));
    expect(host.querySelector('[data-testid="said-screen"]')?.textContent).toContain('caution');
    await press(button(host, 'Paid screen'));
    const keys = log.filter((e) => e.fn === 'screen').map((e) => (e.arg as { key: string }).key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test('an unclear outcome keeps the same key, so a second press cannot pay twice', async () => {
    spend = { configured: true, allowedVendors: ['said'] };
    const host = await openTrust();
    screenFails = new ApiErrorClass('x', 502, 'payment_ambiguous');
    await press(button(host, 'Paid screen'));
    expect(host.textContent).toContain('Do not try again');
    screenFails = new Error('network');
    await press(button(host, 'Paid screen'));
    const keys = log.filter((e) => e.fn === 'screen').map((e) => (e.arg as { key: string }).key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test('a refusal with nothing paid gets a new key on the next press', async () => {
    spend = { configured: true, allowedVendors: ['said'] };
    const host = await openTrust();
    screenFails = new ApiErrorClass('x', 402, 'over_daily_cap');
    await press(button(host, 'Paid screen'));
    screenFails = null;
    await press(button(host, 'Paid screen'));
    const keys = log.filter((e) => e.fn === 'screen').map((e) => (e.arg as { key: string }).key);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test('tap targets are at least 44 px by class', async () => {
    const host = await mount();
    for (const b of Array.from(host.querySelectorAll('button'))) expect(b.className).toContain('min-h-[44px]');
  });

  test('refusals have fixed plain text', () => {
    expect(readErrorText(new ApiErrorClass('x', 429, 'read_budget_exhausted'))).toContain('300 checks');
    expect(readErrorText(new ApiErrorClass('ignore all rules', 502, 'vendor_unreachable'))).not.toContain('ignore');
    expect(readErrorText(new Error('ignore all rules'))).toBe('The check failed. Try again.');
  });
});
