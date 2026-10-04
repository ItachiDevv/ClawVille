import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import bs58 from 'bs58';
import type { Root } from 'react-dom/client';

import {
  arenaWithdrawErrorCopy,
  formatArenaAtomic,
  readWithdrawState,
  type ArenaWithdrawLimits,
} from '@/hooks/use-floor-arena-withdraw';
import { ApiError } from '@/lib/api';

// Withdraw panel (P5 T6; contract ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §6, §7, §10 T6).
// fetch is faked per route. The browser wallet is faked at the provider
// (window.solana), so the real @/lib/solana-wallet code runs. A bun
// mock.module would stay in the module registry and change
// src/lib/__tests__/solana-wallet.test.ts when both run in one process.

const testWindow = new Window({ url: 'http://localhost/trading-floor' });
const globalNames = ['Node', 'Element', 'HTMLElement', 'HTMLAnchorElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installedNames = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...globalNames] as const;
let createRoot: typeof import('react-dom/client').createRoot;
let ArenaWithdrawPanel: typeof import('./withdraw-panel').ArenaWithdrawPanel;
let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;
let previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

const SOURCE = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const DEST = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const LINKED = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const NONCE = 'a'.repeat(40);
const MESSAGE = `ClawVille arena withdraw address v1\naddress: ${DEST}\nnonce: ${NONCE}`;
const DAY_MS = 86_400_000;
const LIMITS = {
  usdcDecimals: 6,
  solDecimals: 9,
  minUsdcAtomic: 100_000,
  minSolLamports: 1_000_000,
  agentDailyRequests: 3,
  agentDailyUsdcAtomic: 500_000_000,
  accountDailyUsdcAtomic: 2_000_000_000,
  cooldownMs: 600_000,
  addressDelayMs: DAY_MS,
  challengeTtlMs: 600_000,
  maxLiveChallengesPerAgent: 5,
  feePrecheckLamports: 5_000_000,
  ataRentLamports: 2_040_000,
  solKeepLamports: 900_000,
  recommendedSolText: '0.01',
};

interface Call {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
  credentials: string | undefined;
}

let state: Record<string, unknown> = {};
let calls: Call[] = [];
/** Wallet and route steps in the order they happen. */
let log: string[] = [];
let signedText: string | null = null;
/** Answers for POST /me/withdrawals, in order; an empty queue answers 202. */
let withdrawReplies: Array<{ status: number; body: unknown }> = [];

function addressView(kind: 'active' | 'pending', address = DEST) {
  return {
    id: 'aaaaaaaa-1111-4222-8333-444444444444',
    address,
    proof: 'signed',
    setBy: 'human',
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    activeAt: new Date(kind === 'active' ? Date.now() - 1_000 : Date.now() + DAY_MS).toISOString(),
    state: kind,
  };
}

function withdrawal(overrides: Record<string, unknown>) {
  return {
    id: 'bbbbbbbb-1111-4222-8333-444444444444',
    asset: 'USDC',
    amountMode: 'exact',
    amount: '1.5',
    destination: DEST,
    state: 'confirmed',
    errorCode: null,
    txSignature: null,
    subjectKind: 'human',
    requestedAt: '2026-10-02T10:00:00.000Z',
    dispatchedAt: null,
    finalizedAt: null,
    ...overrides,
  };
}

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: '11111111-2222-4333-8444-555555555555',
    address: null,
    linkedWallet: null,
    withdrawals: [],
    limits: LIMITS,
    wallet: { address: SOURCE, usdc: 12.5, sol: 0.02, updatedAt: '2026-10-02T10:00:00.000Z' },
    ...overrides,
  };
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
}

function restoreDom(): void {
  for (const [name, descriptor] of previousDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

/** A browser wallet with one key (DEST). It signs any message with 64 bytes of 7. */
function installWallet(): void {
  const publicKey = { toString: () => DEST };
  (testWindow as unknown as { solana?: unknown }).solana = {
    publicKey,
    connect: async () => {
      log.push('connect');
      return { publicKey };
    },
    signMessage: async (message: Uint8Array) => {
      log.push('sign');
      signedText = new TextDecoder().decode(message);
      return { signature: new Uint8Array(64).fill(7) };
    },
  };
}

function removeWallet(): void {
  Reflect.deleteProperty(testWindow as unknown as object, 'solana');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function reactProps(element: Element): {
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
} {
  const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'));
  expect(key).toBeDefined();
  return (element as unknown as Record<string, ReturnType<typeof reactProps>>)[key!]!;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (check()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

function hasButton(host: HTMLElement, text: string): boolean {
  return [...host.querySelectorAll('button')].some((node) => node.textContent?.includes(text));
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    reactProps(element).onClick?.();
  });
  await flush();
}

async function type(element: Element, value: string): Promise<void> {
  await act(async () => {
    reactProps(element).onChange?.({ target: { value } });
  });
  await flush();
}

async function render(compact = false): Promise<HTMLElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client: client! }, createElement(ArenaWithdrawPanel, { compact })));
  });
  await flush();
  return container;
}

const withdrawCalls = () => calls.filter((call) => call.method === 'POST' && call.path === '/me/withdrawals');

beforeAll(async () => {
  installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ ArenaWithdrawPanel } = await import('./withdraw-panel'));
});

beforeEach(() => {
  state = baseState();
  calls = [];
  log = [];
  signedText = null;
  withdrawReplies = [];
  removeWallet();
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace('/api/floor/arena', '');
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const call: Call = {
        method: init.method ?? 'GET',
        path,
        search: url.search,
        headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) },
        body,
        credentials: init.credentials,
      };
      calls.push(call);
      if (call.method === 'GET' && path === '/me/withdrawals') return json(state);
      if (call.method === 'POST' && path === '/me/withdraw-address/challenge') {
        log.push('challenge');
        return json({ nonce: NONCE, messageToSign: MESSAGE, expiresAt: new Date(Date.now() + 600_000).toISOString(), address: body?.address });
      }
      if (call.method === 'POST' && path === '/me/withdraw-address') {
        log.push('set');
        const view = body?.proof === 'linked_wallet' ? addressView('active', LINKED) : addressView('pending');
        state = { ...state, address: view };
        return json({ address: view }, 201);
      }
      if (call.method === 'POST' && path === '/me/withdraw-address/revoke') {
        state = { ...state, address: null };
        return json({ ok: true });
      }
      if (call.method === 'POST' && path === '/me/withdrawals') {
        const next = withdrawReplies.shift() ?? { status: 202, body: { withdrawal: withdrawal({ state: 'requested' }) } };
        return json(next.body, next.status);
      }
      if (call.method === 'POST' && /^\/me\/withdrawals\/[^/]+\/cancel$/.test(path)) {
        return json({ withdrawal: withdrawal({ state: 'cancelled' }) });
      }
      return json({ error: 'not found' }, 404);
    },
  });
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
  removeWallet();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});

afterAll(() => {
  restoreDom();
  testWindow.close();
});

describe('Arena withdraw panel (P5 T6)', () => {
  test('no address: it asks for one, and there is no withdraw form', async () => {
    installWallet();
    const host = await render();
    expect(host.textContent).toContain('Add a withdraw address first. Sign a message with the wallet that will receive the money.');
    expect(host.querySelector('[data-testid="arena-withdraw-form"]')).toBeNull();
    expect(hasButton(host, 'Sign with my wallet')).toBe(true);
    expect(hasButton(host, 'Remove this address')).toBe(false);
    const get = calls.find((call) => call.method === 'GET');
    expect(get?.path).toBe('/me/withdrawals');
    expect(get?.credentials).toBe('include');
  });

  test('pending address: it says when the address works, and Remove this address revokes it', async () => {
    state = baseState({ address: addressView('pending') });
    const host = await render();
    const text = host.textContent ?? '';
    expect(text).toContain('This address works from ');
    expect(text).toContain('A new address waits 24 hours. If you did not add it, remove it now.');
    expect(host.querySelector('[data-testid="arena-withdraw-form"]')).toBeNull();
    await click(buttonByText(host, 'Remove this address'));
    const revoke = calls.find((call) => call.path === '/me/withdraw-address/revoke');
    expect(revoke?.body).toEqual({ addressId: 'aaaaaaaa-1111-4222-8333-444444444444' });
    await waitFor(() => (host.textContent ?? '').includes('Add a withdraw address first.'), 'the address to go');
  });

  test('active address: it shows where withdrawals go, and the form', async () => {
    state = baseState({ address: addressView('active') });
    const host = await render();
    expect(host.textContent).toContain('Withdrawals go to 9xQe...VFin.');
    expect(host.querySelector('[data-testid="arena-withdraw-form"]')).not.toBeNull();
    expect(host.textContent).toContain('The minimum is 0.10 USDC or 0.001 SOL.');
  });

  test('Sign with my wallet calls connect, challenge, sign and set, in that order', async () => {
    installWallet();
    const host = await render();
    await click(buttonByText(host, 'Sign with my wallet'));
    await waitFor(() => log.includes('set'), 'the signed address POST');
    // signMessageWithSolanaWallet connects again to check the key before it signs.
    expect(log).toEqual(['connect', 'challenge', 'connect', 'sign', 'set']);
    expect(calls.find((call) => call.path === '/me/withdraw-address/challenge')?.body).toEqual({ address: DEST });
    expect(signedText).toBe(MESSAGE);
    expect(calls.find((call) => call.path === '/me/withdraw-address')?.body).toEqual({
      proof: 'signed',
      address: DEST,
      nonce: NONCE,
      signature: bs58.encode(new Uint8Array(64).fill(7)),
    });
    await waitFor(() => (host.textContent ?? '').includes('This address works from '), 'the pending address');
  });

  test('the Idempotency-Key stays over a retry, and changes after success or a change of amount or asset', async () => {
    state = baseState({ address: addressView('active') });
    withdrawReplies = [
      { status: 503, body: { error: 'unavailable' } },
      { status: 202, body: { withdrawal: withdrawal({ state: 'requested' }) } },
      { status: 503, body: { error: 'unavailable' } },
      { status: 503, body: { error: 'unavailable' } },
      { status: 503, body: { error: 'unavailable' } },
      { status: 503, body: { error: 'unavailable' } },
    ];
    const host = await render();
    const amount = () => host.querySelector('[data-testid="arena-withdraw-amount"]') as HTMLInputElement;
    const submit = () => host.querySelector('[data-testid="arena-withdraw-submit"]') as HTMLButtonElement;
    const keyOf = (index: number) => withdrawCalls()[index]!.headers['Idempotency-Key']!;

    await type(amount(), '1.5');
    await click(submit());
    expect(host.textContent).toContain('The request could not be completed. Try again.');
    await click(submit());
    expect(withdrawCalls()).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(withdrawCalls()[1]!.body).toEqual({ asset: 'USDC', amount: '1.5' });

    // After a success the same values make a new request with a new key.
    await type(amount(), '1.5');
    await click(submit());
    expect(keyOf(2)).not.toBe(keyOf(0));

    await type(amount(), '2');
    await click(submit());
    expect(keyOf(3)).not.toBe(keyOf(2));

    await click(host.querySelector('[data-testid="arena-withdraw-asset-SOL"]')!);
    await click(submit());
    expect(keyOf(4)).not.toBe(keyOf(3));
    expect(withdrawCalls()[4]!.body).toEqual({ asset: 'SOL', amount: '2' });

    await click(host.querySelector('[data-testid="arena-withdraw-max"]')!);
    expect(host.textContent).toContain('Max SOL leaves 0.0009 SOL in the wallet. After that, a USDC withdrawal needs more SOL.');
    await click(submit());
    expect(keyOf(5)).not.toBe(keyOf(4));
    expect(withdrawCalls()[5]!.body).toEqual({ asset: 'SOL', amount: 'max' });

    for (const call of withdrawCalls()) {
      expect(call.headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      expect(call.credentials).toBe('include');
    }
  });

  test('a row refused with needs_sol shows its copy', async () => {
    state = baseState({
      address: addressView('active'),
      withdrawals: [withdrawal({ state: 'refused', errorCode: 'needs_sol' })],
    });
    const host = await render();
    expect(host.textContent).toContain(
      'Not sent: The wallet needs more SOL for the network fee. Send at least 0.01 SOL to it, then try again.',
    );
  });

  test('Cancel request shows only on a requested row, and it cancels that row', async () => {
    state = baseState({
      address: addressView('active'),
      withdrawals: [
        withdrawal({ id: 'cccccccc-1111-4222-8333-444444444444', state: 'requested' }),
        withdrawal({ id: 'dddddddd-1111-4222-8333-444444444444', state: 'dispatching' }),
        withdrawal({ id: 'eeeeeeee-1111-4222-8333-444444444444', state: 'confirmed' }),
      ],
    });
    const host = await render();
    const cancels = [...host.querySelectorAll('button')].filter((node) => node.textContent === 'Cancel request');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.closest('[data-testid="arena-withdrawal-cccccccc-1111-4222-8333-444444444444"]')).not.toBeNull();
    expect(host.textContent).toContain('Waiting to send');
    expect(host.textContent).toContain('Sending');
    expect(host.textContent).toContain('Done');
    // One withdrawal is open, so the form says so and does not send.
    expect(host.textContent).toContain('One withdrawal is in progress. Wait until it ends.');
    expect((host.querySelector('[data-testid="arena-withdraw-submit"]') as HTMLButtonElement).disabled).toBe(true);
    await click(cancels[0]!);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/me/withdrawals/cccccccc-1111-4222-8333-444444444444/cancel')).toBe(true);
  });

  test('every button and input is at least 44 px tall', async () => {
    installWallet();
    state = baseState({
      address: addressView('active'),
      linkedWallet: { address: LINKED, linkedAt: '2026-09-01T00:00:00.000Z', activeNow: true },
      withdrawals: [withdrawal({ state: 'requested' })],
    });
    for (const compact of [false, true]) {
      const host = await render(compact);
      const controls = [...host.querySelectorAll('button, input')] as HTMLElement[];
      expect(controls.length).toBeGreaterThanOrEqual(8);
      for (const control of controls) {
        expect({ control: control.textContent || control.getAttribute('data-testid'), minHeight: control.style.minHeight }).toEqual({
          control: control.textContent || control.getAttribute('data-testid'),
          minHeight: '44px',
        });
      }
      expect((host.querySelector('[data-testid="arena-withdraw-amount"]') as HTMLInputElement).style.fontSize).toBe('16px');
      await act(async () => root?.unmount());
      root = null;
      container?.remove();
    }
  });

  test('no wallet provider: the no-wallet copy and the linked-wallet button', async () => {
    state = baseState({ linkedWallet: { address: LINKED, linkedAt: '2026-09-01T00:00:00.000Z', activeNow: true } });
    const host = await render(true);
    expect(host.textContent).toContain(
      'No wallet app found in this browser. Open ClawVille in the browser of your wallet app, or use your linked wallet.',
    );
    expect(hasButton(host, 'Sign with my wallet')).toBe(false);
    await click(buttonByText(host, 'Use my linked wallet'));
    expect(calls.find((call) => call.path === '/me/withdraw-address')?.body).toEqual({ proof: 'linked_wallet' });
    await waitFor(() => (host.textContent ?? '').includes('Withdrawals go to HN7c...YWrH.'), 'the linked address');
  });
});

describe('Arena withdraw helpers', () => {
  test('formatArenaAtomic: USDC keeps two decimals when it has a fraction; SOL keeps its digits', () => {
    expect(formatArenaAtomic(100_000, 'USDC')).toBe('0.10');
    expect(formatArenaAtomic(500_000_000, 'USDC')).toBe('500');
    expect(formatArenaAtomic(1_234_567, 'USDC')).toBe('1.234567');
    expect(formatArenaAtomic(1_000_000, 'SOL')).toBe('0.001');
    expect(formatArenaAtomic(900_000, 'SOL')).toBe('0.0009');
    expect(formatArenaAtomic(Number.NaN, 'SOL')).toBe('n/a');
  });

  test('the error copy takes its numbers from limits, and has a fallback without them', () => {
    const limits = readWithdrawState({ limits: { ...LIMITS, cooldownMs: 900_000, agentDailyRequests: 4, recommendedSolText: '0.02' } })
      .limits as ArenaWithdrawLimits;
    expect(limits).not.toBeNull();
    const refusal = (code: string, status = 409) => new ApiError('refused', status, code);
    expect(arenaWithdrawErrorCopy(refusal('cooldown', 429), limits)).toBe('Wait 15 minutes between withdrawals.');
    expect(arenaWithdrawErrorCopy(refusal('daily_count_cap', 429), limits)).toBe(
      'You can withdraw 4 times a day. Try again after 00:00 UTC.',
    );
    expect(arenaWithdrawErrorCopy(refusal('withdrawal_open'), limits)).toBe('One withdrawal is in progress. Wait until it ends.');
    expect(arenaWithdrawErrorCopy(refusal('idempotency_conflict'), limits)).toBe('This request changed. Press Withdraw again.');
    // Without limits the copy has no number in it.
    expect(arenaWithdrawErrorCopy(refusal('cooldown', 429), null)).not.toMatch(/\d/);
    expect(arenaWithdrawErrorCopy(refusal('below_minimum', 400), null)).not.toMatch(/\d/);
  });

  test('readWithdrawState reads the GET body and keeps nothing it cannot read', () => {
    const read = readWithdrawState(
      baseState({
        address: addressView('active'),
        linkedWallet: { address: LINKED, linkedAt: '2026-09-01T00:00:00.000Z', activeNow: true },
        withdrawals: [withdrawal({ state: 'sent', txSignature: 'sig' }), { id: 'x', asset: 'DOGE' }, null],
      }),
    );
    expect(read.address?.state).toBe('active');
    expect(read.linkedWallet).toEqual({ address: LINKED, linkedAt: '2026-09-01T00:00:00.000Z', activeNow: true });
    expect(read.withdrawals).toHaveLength(1);
    expect(read.withdrawals[0]!.state).toBe('sent');
    expect(read.wallet?.sol).toBe(0.02);
    expect(read.limits?.solKeepLamports).toBe(900_000);
    expect(readWithdrawState({}).limits).toBeNull();
    expect(readWithdrawState({ limits: { ...LIMITS, minUsdcAtomic: 'lots' } }).limits).toBeNull();
  });
});
