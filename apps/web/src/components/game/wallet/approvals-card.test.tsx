import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

// "Ask me before each payment" (founder go 2026-11-06): the Spending card
// toggle (turning it off is a raise, so the linked wallet signs), the
// Approvals list (agent text as plain text, Approve and Decline) and the /game
// notice that opens the wallet panel.

const testWindow = new Window({ url: 'http://localhost/game', width: 1280, height: 800 });
const domNames = ['Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installed = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...domNames] as const;
let previous = new Map<PropertyKey, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

let createRoot: typeof import('react-dom/client').createRoot;
let cards: typeof import('./approvals-card');
let SpendingCard: typeof import('./spending-card').SpendingCard;
let useGameStore: typeof import('@/stores/game').useGameStore;
let api: typeof import('@/lib/api').api;
let originalApi: Record<string, unknown> = {};

const REQ = '11111111-2222-4333-8444-555555555555';
const LINKED = 'LinkedWallet1111111111111111111111111111111';
const signed: string[] = [];
/** A browser wallet that signs as the linked wallet. */
const fakeWallet = {
  connect: async () => ({ publicKey: { toString: () => LINKED } }),
  signMessage: async (bytes: Uint8Array) => {
    signed.push(new TextDecoder().decode(bytes));
    return { signature: new Uint8Array(64).fill(7) };
  },
};
let requireApproval = false;
let approvals: Array<Record<string, unknown>> = [];
const log: Array<{ fn: string; arg: unknown }> = [];

let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;

function policyView() {
  return {
    dailyCapUsdCents: 100,
    perCallCapUsdCents: 10,
    allowedVendors: ['studios'],
    studiosKeyImagesPerDay: 10,
    requireApproval,
    configured: true,
    updatedAt: null,
  };
}

beforeAll(async () => {
  previous = new Map(installed.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  define('window', testWindow);
  define('document', testWindow.document);
  define('navigator', testWindow.navigator);
  for (const name of domNames) define(name, testWindow[name as keyof typeof testWindow]);
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define('fetch', async () => new Response('{}', { status: 404 }));
  ({ createRoot } = await import('react-dom/client'));
  ({ api } = await import('@/lib/api'));
  ({ useGameStore } = await import('@/stores/game'));
  cards = await import('./approvals-card');
  ({ SpendingCard } = await import('./spending-card'));
  const mutableApi = api as unknown as Record<string, unknown>;
  const names = ['me', 'getSpendPolicy', 'putSpendPolicy', 'spendPolicyChallenge', 'studiosApprovals', 'studiosApprovalChallenge', 'approveStudiosRequest', 'declineStudiosRequest', 'studiosImages'];
  originalApi = Object.fromEntries(names.map((n) => [n, mutableApi[n]]));
  mutableApi.me = async () => ({ user: { id: 'user-1', isGuest: false } });
  mutableApi.getSpendPolicy = async () => policyView();
  mutableApi.putSpendPolicy = async (body: Record<string, unknown>) => {
    log.push({ fn: 'put', arg: body });
    return { ...policyView(), requireApproval: body.requireApproval };
  };
  mutableApi.spendPolicyChallenge = async (body: unknown) => {
    log.push({ fn: 'challenge', arg: body });
    // Stop before the wallet is asked to sign: the test only checks the route.
    throw new Error('no wallet in tests');
  };
  mutableApi.studiosApprovals = async () => ({ approvals });
  mutableApi.studiosApprovalChallenge = async (id: string) => {
    log.push({ fn: 'challenge-approval', arg: id });
    return { nonce: 'N'.repeat(44), expiresAt: new Date().toISOString(), messageToSign: `ClawVille payment approval\nrequest: ${id}`, walletPubkey: LINKED };
  };
  mutableApi.approveStudiosRequest = async (id: string, proof: unknown) => {
    log.push({ fn: 'approve', arg: { id, proof } });
    approvals = [];
    return { ok: true, mode: 'account', mediaId: 'm', mediaPath: '/api/media/m', ledgerId: null, paidUsdCents: null, txSignature: null };
  };
  mutableApi.declineStudiosRequest = async (id: string) => {
    log.push({ fn: 'decline', arg: id });
    approvals = [];
    return { requestId: id, status: 'declined' };
  };
  mutableApi.studiosImages = async () => ({ images: [] });
});

beforeEach(() => {
  requireApproval = true;
  log.length = 0;
  signed.length = 0;
  (testWindow as unknown as { solana?: unknown }).solana = fakeWallet;
  approvals = [{
    requestId: REQ,
    vendor: 'studios',
    prompt: '<img src=x onerror=alert(1)> **bold** [link](https://evil.example)',
    model: null,
    mode: 'wallet',
    surface: 'api',
    maxUsdCents: 10,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 14 * 60_000 + 30_000).toISOString(),
  }];
  useGameStore.setState({ walletLinkModalOpen: false });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

afterAll(() => {
  Object.assign(api as unknown as Record<string, unknown>, originalApi);
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  testWindow.close();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(element: ReactElement): Promise<void> {
  container = testWindow.document.createElement('div') as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client: client! }, element));
  });
  await settle();
}

function button(text: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new testWindow.MouseEvent('click', { bubbles: true }) as unknown as Event);
  });
  await settle();
}

describe('ApprovalsCard', () => {
  test('shows the agent prompt as plain text, never as HTML, with who pays and the time left', async () => {
    await mount(createElement(cards.ApprovalsCard));
    const prompt = container?.querySelector('[data-testid="approval-prompt"]');
    expect(prompt?.textContent).toBe('<img src=x onerror=alert(1)> **bold** [link](https://evil.example)');
    expect(container?.querySelector('img')).toBeNull();
    expect(container?.querySelector('a')).toBeNull();
    expect(container?.textContent).toContain('Your agent wallet pays, at most $0.10');
    expect(container?.textContent).toContain('14 min left');
  });

  test('Approve asks the linked wallet to sign this request, sends the signature, then the list is empty', async () => {
    await mount(createElement(cards.ApprovalsCard));
    await click(button('Approve'));
    expect(log.map((l) => l.fn)).toEqual(['challenge-approval', 'approve']);
    expect(signed).toEqual([`ClawVille payment approval\nrequest: ${REQ}`]);
    expect(log[1]?.arg).toMatchObject({ id: REQ, proof: { nonce: 'N'.repeat(44) } });
    expect((log[1]?.arg as { proof: { signature: string } }).proof.signature.length).toBeGreaterThan(80);
    expect(container?.querySelector('[data-testid="approval-item"]')).toBeNull();
    expect(container?.textContent).toContain('No payment waits for you.');
  });

  test('with no browser wallet, Approve sends nothing and says why', async () => {
    (testWindow as unknown as { solana?: unknown }).solana = undefined;
    await mount(createElement(cards.ApprovalsCard));
    await click(button('Approve'));
    expect(log.map((l) => l.fn)).toEqual(['challenge-approval']);
    expect(container?.textContent).toContain('No Solana wallet detected');
  });

  test('Decline sends the request id', async () => {
    await mount(createElement(cards.ApprovalsCard));
    await click(button('Decline'));
    expect(log).toEqual([{ fn: 'decline', arg: REQ }]);
  });

  test('every button is at least 44px tall', async () => {
    await mount(createElement(cards.ApprovalsCard));
    for (const b of container?.querySelectorAll('button') ?? []) expect(b.className).toContain('min-h-[44px]');
  });
});

describe('ApprovalNotice (/game)', () => {
  test('shows while a payment waits and opens the wallet panel', async () => {
    await mount(createElement(cards.ApprovalNotice));
    const notice = container?.querySelector('[data-testid="approval-notice"]');
    expect(notice?.textContent).toContain('1 payment waits for your approval');
    expect(notice?.className).toContain('z-[48]');
    await click(notice!);
    expect(useGameStore.getState().walletLinkModalOpen).toBe(true);
  });

  test('renders nothing when nothing waits', async () => {
    approvals = [];
    await mount(createElement(cards.ApprovalNotice));
    expect(container?.querySelector('[data-testid="approval-notice"]')).toBeNull();
  });
});

describe('Spending card toggle', () => {
  function toggle(): HTMLInputElement {
    const label = [...(container?.querySelectorAll('label') ?? [])].find((l) => l.textContent?.includes('Ask me before each payment'));
    const input = label?.querySelector('input[type="checkbox"]');
    if (!input) throw new Error('no toggle');
    return input as HTMLInputElement;
  }

  test('turning it on saves without a wallet signature', async () => {
    requireApproval = false;
    await mount(createElement(SpendingCard));
    expect(toggle().checked).toBe(false);
    await click(toggle());
    await click(button('Save spend rules'));
    expect(log.map((l) => l.fn)).toEqual(['put']);
    expect(log[0]?.arg).toMatchObject({ requireApproval: true });
  });

  test('turning it off asks for the linked wallet signature first', async () => {
    requireApproval = true;
    await mount(createElement(SpendingCard));
    expect(toggle().checked).toBe(true);
    await click(toggle());
    await click(button('Save spend rules'));
    expect(log.map((l) => l.fn)).toEqual(['challenge']);
    expect(log[0]?.arg).toMatchObject({ requireApproval: false });
  });
});

describe('plain-text helpers', () => {
  test('time left and who pays', () => {
    const now = Date.parse('2026-11-06T12:00:00.000Z');
    expect(cards.timeLeftText('2026-11-06T12:14:59.000Z', now)).toBe('14 min left');
    expect(cards.timeLeftText('2026-11-06T12:00:30.000Z', now)).toBe('Less than 1 minute left');
    expect(cards.timeLeftText('2026-11-06T11:59:00.000Z', now)).toBe('Expired');
    expect(cards.approvalPriceText({ mode: 'account', maxUsdCents: null })).toBe('Your Studios key pays (your Studios credits).');
    expect(cards.approvalPriceText({ mode: 'wallet', maxUsdCents: 25 })).toContain('$0.25');
  });
});
