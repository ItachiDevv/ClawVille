import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { OwnAiStatus } from '@clawville/shared';

// The human path of "own AI" (part A): the card shows for a signed-in human
// only, the estimate follows the contract math, the key never shows after a
// save, a raise runs the linked-wallet signature flow, and the UsePod link
// shows only after a tap.

const testWindow = new Window({ url: 'http://localhost/game', width: 390, height: 844 });
const domNames = ['Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent', 'MutationObserver'] as const;
const installed = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', ...domNames] as const;
let previous = new Map<PropertyKey, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

type CardModule = typeof import('./agent-ai-card');
let createRoot: typeof import('react-dom/client').createRoot;
let card: CardModule;
let SpendingCard: typeof import('./spending-card').SpendingCard;
let api: Record<string, unknown>;
let ApiErrorClass: typeof import('@/lib/api').ApiError;
let originalApi: Record<string, unknown> = {};
let isGuest = false;

const WALLET = '3Q6QAbCWmqJfXthcXxsxpj2SXvDcmDsJJsevwMgC8BrU';
const OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwxyzWXYZ';
const DASHBOARD = 'https://usepod.ai/dashboard/11111111-2222-4333-8444-555555555555';
const log: Array<{ method: string; path: string; body: unknown }> = [];
let status: OwnAiStatus;
let raiseOnce = false;
let keyTestFails: string | null = null;
let signed = 0;
let noLinkedWallet = false;
let depositApproval = false;
let depositEnabled = false;
let depositTimeout = false;
let depositRefusal: string | null = null;
let feeSponsored = false;
let feeReason = 'no_fee_wallet';
let depositChainStatus = 'paid';
let depositCreditStatus = 'unknown';
let solAtomic = "15000";

function baseStatus(over: Partial<OwnAiStatus> = {}): OwnAiStatus {
  return {
    source: 'clawville', provider: null, model: null, speedSeconds: 25, dailyLimitCents: null,
    keyLast4: null, usepodRegistered: false,
    today: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCents: 0 },
    activeNow: 'clawville', fallbackReason: null, fallbackAt: null, updatedAt: null,
    ...over,
  };
}

function json(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
}

async function router(input: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const path = new URL(input, 'http://localhost').pathname;
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  log.push({ method, path, body });
  if (path === '/api/agent-ai' && method === 'GET') return json({ ai: status });
  if (path === '/api/agent-ai' && method === 'PUT') {
    if (raiseOnce && !body.proof) return json({ error: 'raise_needs_signature', code: 'raise_needs_signature' }, 403);
    if (body.source === 'usepod' && status.usepodRegistered && body.key) {
      return json({ error: 'usepod_token_registered', code: 'usepod_token_registered' }, 400);
    }
    if (keyTestFails) return json({ error: 'key_test_failed', code: 'key_test_failed', reason: keyTestFails }, 400);
    // Like the server: a registered token in use shows its own last 4.
    const registeredInUse = body.source === 'usepod' && status.usepodRegistered;
    status = baseStatus({
      source: body.source, provider: body.provider, model: body.model, speedSeconds: body.speedSeconds,
      dailyLimitCents: body.dailyLimitCents, usepodRegistered: status.usepodRegistered,
      keyLast4: registeredInUse ? '5555' : body.key ? body.key.slice(-4) : status.keyLast4, activeNow: 'own',
    });
    return json({ ai: status });
  }
  if (path === '/api/agent-ai' && method === 'DELETE') {
    // The server keeps a registered UsePod token (its balance) and answers 200 { ai }.
    status = baseStatus({ usepodRegistered: status.usepodRegistered });
    return json({ ai: status });
  }
  if (path === '/api/agent-ai/challenge') {
    return json({ nonce: 'nonce-1', expiresAt: '2026-11-09T00:05:00Z', messageToSign: 'ClawVille own AI', walletPubkey: WALLET });
  }
  if (path === '/api/agent-ai/usepod/deposit/challenge') return json({ nonce: 'deposit-nonce', messageToSign: 'ClawVille usepod-deposit', walletPubkey: WALLET });
  if (path === '/api/agent-ai/usepod/deposit') {
    if (depositRefusal) return json({ error: depositRefusal, code: depositRefusal }, 400);
    if (depositTimeout) { depositTimeout = false; throw new Error('timeout'); }
    return json({ ok: true, ledgerId: 'ledger-1', status: depositChainStatus, txSignature: 'tx-1', usdCents: body.amountCents, creditStatus: depositCreditStatus, balance: { usdcMicro: 1500000, isActive: true }, feePayer: feeSponsored ? 'clawville' : 'avatar', feeCharged: depositChainStatus === 'ambiguous' ? null : true });
  }
  if (path === '/api/agent-ai/models') return json({ models: ['gpt-4.1', 'gpt-4o-mini', 'o4-mini'], recommended: [] });
  if (path === '/api/agent-ai/usepod/register/challenge' || path === '/api/agent-ai/usepod/link/challenge') {
    if (noLinkedWallet) return json({ error: 'wallet_link_required', code: 'wallet_link_required' }, 403);
    const action = path.includes('/register/') ? 'register' : 'link';
    return json({ nonce: `nonce-${action}`, expiresAt: '2026-11-09T00:05:00Z', messageToSign: `ClawVille UsePod ${action}`, walletPubkey: WALLET });
  }
  if (path === '/api/agent-ai/usepod/register' || path === '/api/agent-ai/usepod/link') {
    // Like the server: no proof -> 403, the token never leaves without it.
    if (method !== 'POST' || !body?.proof?.nonce || !body?.proof?.signature) {
      return json({ error: 'usepod_needs_signature', code: 'usepod_needs_signature' }, 403);
    }
  }
  if (path === '/api/agent-ai/usepod/register') {
    // Like the server: register leaves the source on ClawVille AI; only the flag changes.
    status = baseStatus({ usepodRegistered: true });
    return json({ dashboardUrl: DASHBOARD, depositCode: 'DEP-1', contractAddress: WALLET, ai: status });
  }
  if (path === '/api/agent-ai/usepod/link') return json({ dashboardUrl: DASHBOARD });
  if (path === '/api/agent-ai/usepod/balance') return json({ usdcMicro: 1_500_000, isActive: true });
  if (path === '/api/agent-ai/usepod/fee') return json({ sponsored: feeSponsored, reason: feeSponsored ? null : feeReason, avatarSponsoredToday: 0, sponsoredPerAvatarPerDay: 2, avatarMinSolLamports: 15000 });
  return json({ error: 'not found' }, 404);
}

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
  define('fetch', router);
  // A stored fingerprint, so the fetch helper never loads FingerprintJS.
  testWindow.localStorage.setItem('cv:fp:v1', '0123456789abcdef0123456789abcdef');
  // A fake injected wallet: the real signMessageWithSolanaWallet runs against it.
  const publicKey = { toString: () => WALLET };
  (testWindow as unknown as Record<string, unknown>).solana = {
    publicKey,
    connect: async () => ({ publicKey }),
    signMessage: async () => {
      signed += 1;
      return { signature: new Uint8Array(64).fill(7) };
    },
  };
  ({ createRoot } = await import('react-dom/client'));
  const apiModule = await import('@/lib/api');
  ApiErrorClass = apiModule.ApiError;
  api = apiModule.api as unknown as Record<string, unknown>;
  card = await import('./agent-ai-card');
  ({ SpendingCard } = await import('./spending-card'));
  const names = ['me', 'getSpendPolicy', 'walletBalances', 'spendPolicyChallenge', 'putSpendPolicy'];
  originalApi = Object.fromEntries(names.map((n) => [n, api[n]]));
  api.me = async () => ({ user: { id: 'user-1', isGuest } });
  api.getSpendPolicy = async () => ({ dailyCapUsdCents: depositEnabled ? 1000 : null, perCallCapUsdCents: depositEnabled ? 100 : null, allowedVendors: depositEnabled ? ['usepod'] : [], configured: depositEnabled, requireApproval: depositApproval, updatedAt: null });
  api.walletBalances = async () => ({ balances: { USDC: { available: true, uiAmount: 5, amountAtomic: '5000000' }, SOL: { available: true, uiAmount: Number(solAtomic) / 1e9, amountAtomic: solAtomic } } });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
  isGuest = false;
  raiseOnce = false;
  keyTestFails = null;
  signed = 0;
  noLinkedWallet = false;
  depositApproval = false;
  depositEnabled = false;
  depositTimeout = false;
  depositRefusal = null;
  feeSponsored = false;
  feeReason = 'no_fee_wallet';
  depositChainStatus = 'paid';
  depositCreditStatus = 'unknown';
  solAtomic = "15000";
  log.length = 0;
});

afterAll(async () => {
  Object.assign(api, originalApi);
  await testWindow.happyDOM.abort();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<PropertyKey, unknown>)[name];
  }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(component = card.AgentAiCard): Promise<HTMLElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(QueryClientProvider, { client: client! }, createElement(component))));
  await settle();
  return container;
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no button: ${text}`);
  return found as HTMLButtonElement;
}

async function press(el: Element): Promise<void> {
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

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new (testWindow.Event as unknown as typeof Event)('change', { bubbles: true }));
  });
  await settle();
}

function radio(host: HTMLElement, label: string): HTMLInputElement {
  const found = Array.from(host.querySelectorAll('label')).find((l) => l.textContent?.trim() === label);
  if (!found) throw new Error(`no radio: ${label}`);
  return found.querySelector('input') as HTMLInputElement;
}

async function openForm(): Promise<HTMLElement> {
  const host = await mount();
  await press(button(host, 'Change the AI'));
  return host;
}

/** Fill the own-key form with OpenAI, gpt-4.1, a $2 limit, and the given key. */
async function fillOwnKey(host: HTMLElement, key: string): Promise<void> {
  await press(radio(host, 'Your own key'));
  await type(host.querySelector('input[type="password"]') as HTMLInputElement, key);
  const [, model] = Array.from(host.querySelectorAll('select')) as HTMLSelectElement[];
  await choose(model, 'gpt-4.1');
  await type(host.querySelector('input[inputmode="decimal"]') as HTMLInputElement, '2');
}

describe('AgentAiCard', () => {
  test('stays hidden for a guest and reads nothing', async () => {
    isGuest = true;
    status = baseStatus();
    const host = await mount();
    expect(host.querySelector('[data-testid="agent-ai-card"]')).toBeNull();
    expect(log).toHaveLength(0);
  });

  test('a signed-in human sees the status and the three sources', async () => {
    status = baseStatus();
    const host = await openForm();
    expect(host.querySelector('[data-testid="agent-ai-status"]')?.textContent).toContain('ClawVille AI');
    for (const label of ['ClawVille AI', 'Your own key', 'UsePod']) expect(radio(host, label)).toBeTruthy();
    expect(radio(host, 'ClawVille AI').checked).toBe(true);
    expect(log.map((e) => `${e.method} ${e.path}`)).toEqual(['GET /api/agent-ai']);
  });

  test('the estimate follows price x (3000 input + output) x decisions per day', () => {
    // gpt-4.1 $2 in / $8 out, 25 s: (3000*2 + 200*8) / 1e6 = 0.0076 per call, 3456 calls a day.
    expect(card.estimateDailyUsd('gpt-4.1', 25, false)).toBeCloseTo(0.0076 * 3456, 6);
    // A reasoning model uses OWN_AI_REASONING_MAX_TOKENS (2000) output tokens: gpt-5.1 $1.25/$10 at 10 s.
    expect(card.estimateDailyUsd('gpt-5.1', 10, true)).toBeCloseTo(((3000 * 1.25 + 2000 * 10) / 1e6) * 8640, 6);
    // A 'provider/' prefix is stripped before the price lookup.
    expect(card.estimateDailyUsd('google/gemini-2.5-pro', 20, true)).toBeCloseTo(((3000 * 1.25 + 2000 * 10) / 1e6) * 4320, 6);
    // An unknown model takes the conservative $15/$75 price.
    expect(card.estimateDailyUsd('my-new-model', 20, false)).toBeCloseTo(((3000 * 15 + 200 * 75) / 1e6) * 4320, 6);
    expect(card.decisionsPerDay(15)).toBe(5760);
  });

  test('the form shows the estimate for the chosen model and speed', async () => {
    status = baseStatus();
    const host = await openForm();
    await fillOwnKey(host, OPENAI_KEY);
    const estimate = () => host.querySelector('[data-testid="agent-ai-estimate"]')?.textContent ?? '';
    expect(estimate()).toContain('Estimated');
    expect(estimate()).toContain('$26.27');
    const speed = Array.from(host.querySelectorAll('select'))[2] as HTMLSelectElement;
    await choose(speed, '10');
    expect(estimate()).toContain('$65.66');
    expect(estimate()).toContain('8,640 decisions');
  });

  test('the key goes to the server once, then shows only as last 4 and the input clears', async () => {
    status = baseStatus();
    const host = await openForm();
    await fillOwnKey(host, OPENAI_KEY);
    const input = host.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.type).toBe('password');
    await press(button(host, 'Save'));
    const put = log.find((e) => e.method === 'PUT');
    expect(put?.body).toEqual({ source: 'own_key', provider: 'openai', model: 'gpt-4.1', speedSeconds: 25, dailyLimitCents: 200, key: OPENAI_KEY });
    const after = host.querySelector('input[type="password"]') as HTMLInputElement;
    expect(after.value).toBe('');
    expect(host.querySelector('[data-testid="agent-ai-key-last4"]')?.textContent).toContain('WXYZ');
    expect(host.innerHTML).not.toContain(OPENAI_KEY);
    // A second save with an empty input keeps the stored key: no `key` in the body.
    log.length = 0;
    await press(button(host, 'Save'));
    expect((log.find((e) => e.method === 'PUT')?.body as Record<string, unknown>).key).toBeUndefined();
  });

  test('a key that does not match the provider pattern is refused before any request', async () => {
    status = baseStatus();
    const host = await openForm();
    await fillOwnKey(host, 'not-a-key');
    await press(button(host, 'Save'));
    expect(log.some((e) => e.method === 'PUT')).toBe(false);
    expect(host.textContent).toContain('does not look like a key');
  });

  test('a 403 raise_needs_signature runs the wallet signature flow and resends with the proof', async () => {
    status = baseStatus({ source: 'own_key', provider: 'openai', model: 'gpt-4.1', dailyLimitCents: 100, keyLast4: 'WXYZ', activeNow: 'own' });
    raiseOnce = true;
    const host = await openForm();
    await type(host.querySelector('input[inputmode="decimal"]') as HTMLInputElement, '5');
    await press(button(host, 'Save'));
    const calls = log.filter((e) => e.method !== 'GET').map((e) => `${e.method} ${e.path}`);
    expect(calls).toEqual(['PUT /api/agent-ai', 'POST /api/agent-ai/challenge', 'PUT /api/agent-ai']);
    expect(signed).toBe(1);
    const resend = log.filter((e) => e.method === 'PUT')[1].body as Record<string, unknown>;
    expect(resend.dailyLimitCents).toBe(500);
    expect((resend.proof as { nonce: string }).nonce).toBe('nonce-1');
    expect(typeof (resend.proof as { signature: string }).signature).toBe('string');
    expect(host.textContent).toContain('Saved.');
  });

  test('the UsePod link stays hidden until "Show my UsePod link" is tapped', async () => {
    status = baseStatus({ source: 'usepod', provider: 'usepod', model: 'gpt-oss-120b', dailyLimitCents: 100, keyLast4: '5555', usepodRegistered: true, activeNow: 'own' });
    const host = await openForm();
    expect(host.textContent).toContain('UsePod sends prompts to independent GPU operators who can read them.');
    expect(host.querySelector('[data-testid="usepod-link"]')).toBeNull();
    expect(host.innerHTML).not.toContain(DASHBOARD);
    expect(log.some((e) => e.path === '/api/agent-ai/usepod/link')).toBe(false);
    expect(host.querySelector('[data-testid="usepod-balance"]')?.textContent).toContain('$1.50');
    await press(button(host, 'Show my UsePod link'));
    // The linked wallet signs the link challenge first; the POST carries the proof.
    const posts = log.filter((e) => e.method !== 'GET').map((e) => `${e.method} ${e.path}`);
    expect(posts).toEqual(['POST /api/agent-ai/usepod/link/challenge', 'POST /api/agent-ai/usepod/link']);
    expect(signed).toBe(1);
    expect((log.find((e) => e.path === '/api/agent-ai/usepod/link')?.body as { proof: { nonce: string } }).proof.nonce).toBe('nonce-link');
    const link = host.querySelector('[data-testid="usepod-link"]') as HTMLElement;
    expect(link.textContent).toContain('This link controls your UsePod balance. Keep it private.');
    expect((link.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe(DASHBOARD);
    expect((link.querySelector('a') as HTMLAnchorElement).getAttribute('rel')).toBe('noopener noreferrer');
    // The link never enters the query cache.
    expect(JSON.stringify(client!.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(DASHBOARD);
  });

  test('register shows the link and the deposit code, and keeps the UsePod form open', async () => {
    status = baseStatus();
    const host = await openForm();
    await press(radio(host, 'UsePod'));
    await press(button(host, 'Create a UsePod balance for my agent'));
    expect(log.filter((e) => e.method !== 'GET').map((e) => `${e.method} ${e.path}`))
      .toEqual(['POST /api/agent-ai/usepod/register/challenge', 'POST /api/agent-ai/usepod/register']);
    expect(signed).toBe(1);
    expect((log.find((e) => e.path === '/api/agent-ai/usepod/register')?.body as { proof: { nonce: string } }).proof.nonce).toBe('nonce-register');
    expect(host.querySelector('[data-testid="usepod-link"]')?.textContent).toContain('DEP-1');
    expect(radio(host, 'UsePod').checked).toBe(true);
    // No second register button, no token field: the registered token is used.
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.includes('Create a UsePod balance'))).toBe(false);
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.querySelector('[data-testid="agent-ai-registered-pod"]')).not.toBeNull();

    // Save sends source 'usepod' with NO key.
    const [model] = Array.from(host.querySelectorAll('select')) as HTMLSelectElement[];
    await choose(model, 'gpt-5.1');
    await type(Array.from(host.querySelectorAll('label')).find((label) => label.textContent?.includes('Daily limit (US$)'))!.querySelector('input')!, '1');
    await press(button(host, 'Save'));
    const put = log.find((e) => e.method === 'PUT');
    expect(put?.body).toEqual({ source: 'usepod', provider: 'usepod', model: 'gpt-5.1', speedSeconds: 25, dailyLimitCents: 100 });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('Saved.');
  });

  test('without a linked wallet, register and the link say to link a wallet or paste a token from an own UsePod account', async () => {
    noLinkedWallet = true;
    status = baseStatus();
    const host = await openForm();
    await press(radio(host, 'UsePod'));
    await press(button(host, 'Create a UsePod balance for my agent'));
    const alert = host.querySelector('[data-testid="usepod-block"] [role="alert"]')?.textContent ?? '';
    expect(alert).toBe(card.USEPOD_NEEDS_WALLET_TEXT);
    expect(alert).toContain('own UsePod account');
    expect(signed).toBe(0);
    expect(log.some((e) => e.path === '/api/agent-ai/usepod/register')).toBe(false);
    expect(host.innerHTML).not.toContain(DASHBOARD);
  });

  test('a key_test_failed shows the plain words for its reason', async () => {
    status = baseStatus();
    keyTestFails = 'balance_empty';
    const host = await openForm();
    await fillOwnKey(host, OPENAI_KEY);
    await press(button(host, 'Save'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('UsePod balance is empty');
  });

  test('the fallback reason shows in plain words', async () => {
    status = baseStatus({ source: 'own_key', provider: 'openai', model: 'gpt-4.1', dailyLimitCents: 100, keyLast4: 'WXYZ', fallbackReason: 'daily_limit', fallbackAt: '2026-11-09T10:00:00Z', today: { calls: 40, inputTokens: 1, outputTokens: 1, estimatedCents: 100 } });
    const host = await mount();
    expect(host.querySelector('[data-testid="agent-ai-fallback"]')?.textContent)
      .toBe("Today's limit is reached. Your agent uses ClawVille AI until midnight UTC.");
    expect(host.querySelector('[data-testid="agent-ai-status"]')?.textContent).toContain('40 calls');
    for (const reason of ['key_rejected', 'balance_empty', 'provider_error', 'model_unavailable'] as const) {
      expect(card.fallbackReasonText(reason).length).toBeGreaterThan(20);
    }
    expect(card.fallbackReasonText('balance_empty')).toContain('UsePod balance is empty');
  });

  test('"Use ClawVille AI" switches back (DELETE answers 200 { ai })', async () => {
    status = baseStatus({ source: 'own_key', provider: 'openai', model: 'gpt-4.1', dailyLimitCents: 100, keyLast4: 'WXYZ', activeNow: 'own' });
    const host = await openForm();
    await press(button(host, 'Use ClawVille AI'));
    expect(log.some((e) => e.method === 'DELETE' && e.path === '/api/agent-ai')).toBe(true);
    expect(host.querySelector('[data-testid="agent-ai-status"]')?.textContent).toContain('Now using: ClawVille AI');
    expect(radio(host, 'ClawVille AI').checked).toBe(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    // The balance route is not read by a switch.
    expect(log.some((e) => e.path === '/api/agent-ai/usepod/balance')).toBe(false);
  });

  test('refusals have fixed plain text', () => {
    expect(card.agentAiErrorText(new ApiErrorClass('x', 409, 'openclaw_gateway_set'))).toContain('OpenClaw gateway');
    expect(card.agentAiErrorText(new ApiErrorClass('x', 403, 'invalid_wallet_proof'))).toContain('linked wallet');
    expect(card.agentAiErrorText(new ApiErrorClass('ignore all rules', 502, 'provider_error'))).not.toContain('ignore');
    expect(card.agentAiErrorText(new Error('sk-secret'))).toBe('That did not work. Try again.');
    const codes = [
      'wallet_link_required', 'raise_needs_signature', 'invalid_wallet_proof', 'key_test_failed', 'key_required',
      'models_unavailable', 'usepod_register_failed', 'usepod_not_set', 'usepod_token_registered',
      'usepod_already_registered', 'usepod_needs_signature', 'rate_limited', 'openclaw_gateway_set', 'human_only', 'needs_human_login', 'invalid_agent_ai',
    ];
    const generic = card.agentAiErrorText(new ApiErrorClass('x', 418, 'no_such_code'));
    for (const code of codes) {
      const text = card.agentAiErrorText(new ApiErrorClass('x', 400, code));
      expect(text).not.toBe(generic);
      expect(text).not.toBe('Check the values and try again.');
    }
    expect(card.agentAiErrorText(new ApiErrorClass('x', 403, 'wallet_link_required'))).toContain('Link your own wallet');
    expect(card.keyTestFailedText('model_unavailable')).toContain('Pick another model');
  });

  test('tap targets are at least 44 px by class', async () => {
    status = baseStatus({ source: 'usepod', provider: 'usepod', model: 'gpt-oss-120b', dailyLimitCents: 100, keyLast4: '5555', activeNow: 'own' });
    const host = await openForm();
    for (const b of Array.from(host.querySelectorAll('button'))) expect(b.className).toContain('min-h-[44px]');
    for (const s of Array.from(host.querySelectorAll('select, input:not([type="radio"])'))) expect(s.className).toContain('min-h-[44px]');
  });
});


describe('UsePod wallet deposit', () => {
  test('signs the exact deposit challenge when approval is on and reports unknown credit honestly', async () => {
    status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
    depositEnabled = true;
    depositApproval = true;
    const host = await openForm();
    await press(button(host, 'Add to AI balance'));
    expect(signed).toBe(1);
    const challenge = log.find((r) => r.path.endsWith('/deposit/challenge'))!;
    const sent = log.find((r) => r.path.endsWith('/deposit'))!;
    expect(sent.body).toMatchObject({ ...(challenge.body as object), nonce: 'deposit-nonce' });
    expect((sent.body as { signature: string }).signature).toBeTruthy();
    expect(host.textContent).toContain('Chain status: paid. UsePod credit: unknown.');
    expect(host.textContent).toContain('Do not repeat this deposit');
    expect(host.textContent).toContain('Wallet USDC: $5.00');
    expect(host.textContent).toContain('Your agent wallet paid the network fee.');
    expect(host.textContent).not.toContain('ClawVille paid the network fee.');
  });

  test('retries the same idempotency key after a transport error without a signature when approval is off', async () => {
    status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
    depositEnabled = true;
    depositTimeout = true;
    const host = await openForm();
    await press(button(host, 'Add to AI balance'));
    await press(button(host, 'Check the same deposit'));
    const posts = log.filter((r) => r.path.endsWith('/deposit'));
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toEqual(posts[1].body);
    expect(signed).toBe(0);
    expect(log.some((r) => r.path.endsWith('/deposit/challenge'))).toBe(false);
  });

  test('blocks deposits below the SOL fee budget', async () => {
    status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
    depositEnabled = true;
    solAtomic = '14999';
    const host = await openForm();
    expect(button(host, 'Add to AI balance').disabled).toBe(true);
    expect(host.textContent).toContain('0.000015 SOL');
    expect(log.some((r) => r.path.endsWith('/deposit'))).toBe(false);
  });

  test('ClawVille fee wallet: no SOL needed, the button stays on, the fallback refusal is plain text', async () => {
    status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
    depositEnabled = true;
    feeSponsored = true;
    solAtomic = '0';
    const host = await openForm();
    expect(host.querySelector('[data-testid="usepod-fee-note"]')!.textContent).toContain('ClawVille pays the network fee');
    expect(host.textContent).not.toContain('needs at least');
    expect(button(host, 'Add to AI balance').disabled).toBe(false);
    depositRefusal = 'fee_wallet_empty';
    await press(button(host, 'Add to AI balance'));
    expect(host.textContent).toContain('The ClawVille fee wallet is empty now');
  });

  test('ClawVille fee wallet sponsored: the receipt says ClawVille paid the fee', async () => {
    status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
    depositEnabled = true;
    feeSponsored = true;
    solAtomic = '0';
    const host = await openForm();
    await press(button(host, 'Add to AI balance'));
    expect(host.textContent).toContain('ClawVille paid the network fee.');
    expect(host.textContent).not.toContain('Your agent wallet paid the network fee.');
  });

  test('fee line text: paid only when charged, "if it lands" when unknown, none when it never landed', () => {
    expect(card.feeLineText('clawville', true)).toBe('ClawVille paid the network fee.');
    expect(card.feeLineText('avatar', true)).toBe('Your agent wallet paid the network fee.');
    expect(card.feeLineText('clawville', null)).toBe('ClawVille will pay the network fee if this deposit lands.');
    expect(card.feeLineText('avatar', null)).toBe('Your agent wallet will pay the network fee if this deposit lands.');
    expect(card.feeLineText('clawville', false)).toBeNull();
    expect(card.feeLineText('avatar', false)).toBeNull();
  });

  test('fee wallet exists but cannot pay now (cap or empty): the card asks for SOL, never says ClawVille pays', async () => {
    status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
    depositEnabled = true;
    feeSponsored = false;
    feeReason = 'avatar_daily_limit';
    solAtomic = '0';
    const host = await openForm();
    const note = host.querySelector('[data-testid="usepod-fee-note"]')!.textContent!;
    expect(note).not.toContain('ClawVille pays');
    expect(note).toContain('0.000015 SOL');
    expect(button(host, 'Add to AI balance').disabled).toBe(true);
  });

  test('blocks deposits until the human allows UsePod and caps', async () => {
    status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
    const host = await openForm();
    expect(button(host, 'Add to AI balance').disabled).toBe(true);
    expect(host.textContent).toContain('Allow UsePod and set both caps');
  });
});


test('adding UsePod in Spending requires the permission-raise wallet proof', async () => {
  const saved = { dailyCapUsdCents: 1000, perCallCapUsdCents: 100, allowedVendors: ['studios'], configured: true,
    requireApproval: false, studiosKeyImagesPerDay: 10, studiosVideosPerDay: 5, studiosCharacterShotsPerDay: 5,
    studiosRecastsPerDay: 5, studiosPayMode: null, updatedAt: null };
  const oldGet = api.getSpendPolicy;
  api.getSpendPolicy = async () => saved;
  let challenged: unknown;
  let submitted: unknown;
  api.spendPolicyChallenge = async (body: unknown) => {
    challenged = body;
    return { nonce: 'vendor-nonce', messageToSign: 'Allow UsePod', walletPubkey: WALLET };
  };
  api.putSpendPolicy = async (body: unknown) => { submitted = body; return { ...saved, ...(body as object) }; };
  try {
    const host = await mount(() => createElement(SpendingCard));
    const label = Array.from(host.querySelectorAll('label')).find((item) => item.textContent?.includes('UsePod (add wallet'))!;
    await press(label.querySelector('input')!);
    await press(button(host, 'Save spend rules'));
    expect(challenged).toMatchObject({ allowedVendors: ['studios', 'usepod'] });
    expect(submitted).toMatchObject({ allowedVendors: ['studios', 'usepod'], proof: { nonce: 'vendor-nonce' } });
    expect((submitted as { proof: { signature: string } }).proof.signature).toBeTruthy();
    expect(signed).toBe(1);
  } finally { api.getSpendPolicy = oldGet; }
});


test('a pre-admission cap refusal lets the human change the amount', async () => {
  status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
  depositEnabled = true;
  depositRefusal = 'over_per_call_cap';
  const host = await openForm();
  await press(button(host, 'Add to AI balance'));
  const input = host.querySelector('[data-testid="usepod-deposit"] input') as HTMLInputElement;
  expect(input.disabled).toBe(false);
  await type(input, '0.25');
  depositRefusal = null;
  await press(button(host, 'Add to AI balance'));
  const posts = log.filter((entry) => entry.path.endsWith('/deposit'));
  expect(posts.at(-1)?.body).toMatchObject({ amountCents: 25 });
});

test('an ambiguous deposit can only check its existing idempotency key', async () => {
  status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
  depositEnabled = true;
  depositChainStatus = 'ambiguous';
  const host = await openForm();
  await press(button(host, 'Add to AI balance'));
  expect(host.textContent).not.toContain('Start another deposit');
  // Not confirmed: the fee line never says "paid".
  expect(host.querySelector('[data-testid="usepod-fee-line"]')!.textContent).toBe(
    'Your agent wallet will pay the network fee if this deposit lands.',
  );
  expect(host.textContent).not.toContain('paid the network fee');
  expect((host.querySelector('[data-testid="usepod-deposit"] input') as HTMLInputElement).disabled).toBe(true);
  await press(button(host, 'Check the same deposit'));
  const posts = log.filter((entry) => entry.path.endsWith('/deposit'));
  expect(posts).toHaveLength(2);
  expect(posts[0].body).toEqual(posts[1].body);
});


test('paid deposits with unknown credit refresh the same deposit until credit is seen', async () => {
  status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
  depositEnabled = true;
  const host = await openForm();
  await press(button(host, 'Add to AI balance'));
  expect(host.textContent).toContain('Chain status: paid. UsePod credit: unknown.');
  depositCreditStatus = 'seen';
  await press(button(host, 'Check the same deposit'));
  const posts = log.filter((entry) => entry.path.endsWith('/deposit'));
  expect(posts).toHaveLength(2);
  expect(posts[0].body).toEqual(posts[1].body);
  expect(host.textContent).toContain('Chain status: paid. UsePod credit: seen.');
  expect(host.textContent).not.toContain('Check the same deposit');
});


test('known deposit refresh does not request a second wallet signature when approval is on', async () => {
  status = baseStatus({ source: 'usepod', provider: 'usepod', usepodRegistered: true });
  depositEnabled = true;
  depositApproval = true;
  const host = await openForm();
  await press(button(host, 'Add to AI balance'));
  expect(signed).toBe(1);
  depositCreditStatus = 'seen';
  await press(button(host, 'Check the same deposit'));
  expect(signed).toBe(1);
  expect(log.filter((entry) => entry.path.endsWith('/deposit/challenge'))).toHaveLength(1);
  const posts = log.filter((entry) => entry.path.endsWith('/deposit'));
  expect(posts).toHaveLength(2);
  const original = posts[0].body as { amountCents: number; idempotencyKey: string };
  expect(posts[1].body).toEqual({ amountCents: original.amountCents, idempotencyKey: original.idempotencyKey });
  expect(host.textContent).toContain('UsePod credit: seen.');
});
