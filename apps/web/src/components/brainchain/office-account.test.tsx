import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { createElement, act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

mock.module('@/lib/fingerprint', () => ({ getFingerprint: async () => '' }));
mock.module('./brainchain-office.module.css', () => ({ default: Object.fromEntries([
  'accountPanel', 'state', 'address', 'actionRow', 'outlineButton', 'small', 'binding', 'error', 'primaryButton',
  'textButton', 'notice', 'secondaryLink',
].map(name => [name, name])) }));
const browser = new Window({ url: 'http://localhost/brainchain' });
const names = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
let createRoot: typeof import('react-dom/client').createRoot;
let OfficeAccount: typeof import('./office-account').OfficeAccount;
let root: Root;
let container: HTMLElement;
let client: QueryClient;
let guest = false;
let posted: string[];
let pendingInstall: ((response: Response) => void) | null;
let installSignal: AbortSignal | null;
let deferInstall = false;
let workerRows: Array<{ id: string; environment: string; chainId: number; address: string; requestedState: string; observedEligibility: null }>;

const auth = (id: string, isGuest = false) => ({ user: { id, isGuest, email: null, name: id, username: id, emailVerified: true } });
const installation = { ok: true, version: 1, installed: 'marker', consumptionVerified: false, contentHash: 'sha256:test', note: 'Association saved. The connected agent must fetch and consume the manual.' };

beforeAll(async () => {
  for (const name of names) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent'] as const) {
    const value = name === 'window' ? browser : name === 'document' ? browser.document : browser[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  createRoot = (await import('react-dom/client')).createRoot;
  OfficeAccount = (await import('./office-account')).OfficeAccount;
});
beforeEach(() => {
  guest = false; posted = []; pendingInstall = null; installSignal = null; deferInstall = false; workerRows = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/auth/me') return Response.json(auth('owner-a', guest));
    if (init?.method === 'POST') posted.push(path);
    if (path.endsWith('/install')) {
      installSignal = init?.signal ?? null;
      if (deferInstall) return new Promise<Response>((resolve) => { pendingInstall = resolve; });
      return Response.json(installation);
    }
    if (path.endsWith('/workers')) return Response.json({ workers: workerRows });
    return new Response('Unexpected request', { status: 404 });
  }) as typeof fetch;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  client.clear(); container.remove();
});
afterAll(() => {
  browser.close();
  for (const name of names) {
    const original = originals.get(name);
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function render(mode: 'install' | 'workers') {
  await act(async () => { root.render(createElement(QueryClientProvider, { client }, createElement(OfficeAccount, { mode }))); await new Promise((resolve) => setTimeout(resolve, 25)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}
function saveButton() { return [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save to my agent')!; }

test('guest learning cannot submit a curriculum install or worker mutation', async () => {
  guest = true;
  await render('install');
  expect(container.textContent).toContain('Sign in');
  expect(saveButton()).toBeUndefined();
  expect(posted).toHaveLength(0);
});

test('an authenticated running-worker read displays local intent without a start action or automatic mutation', async () => {
  workerRows = [{ id: '00000000-0000-4000-8000-000000000001', environment: 'testnet', chainId: 274630,
    address: `0x${'1'.repeat(40)}`, requestedState: 'running', observedEligibility: null }];
  await render('workers');
  expect(container.textContent).toContain('Testnet work requested. This status does not confirm a task or payment.');
  expect(container.textContent).toContain('On-chain eligibility: not observed');
  expect([...container.querySelectorAll('button')].map(button => button.textContent)).toContain('Request pause');
  expect(container.textContent).not.toContain('Start worker'); expect(posted).toHaveLength(0);
});

test('a signed-in human saves through the real endpoint without claiming consumption', async () => {
  await render('install');
  await act(async () => { saveButton().click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(posted).toEqual(['/api/brainchain/install']);
  expect(container.textContent).toContain('Association saved');
  expect(container.textContent).toContain('remains unverified');
});

test('an account change aborts its old install and discards its late private response', async () => {
  deferInstall = true;
  await render('install');
  await act(async () => { saveButton().click(); await Promise.resolve(); });
  expect(pendingInstall).not.toBeNull();
  await act(async () => { client.setQueryData(['auth-me'], auth('owner-b')); await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(installSignal?.aborted).toBe(true);
  await act(async () => { pendingInstall!(Response.json(installation)); await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(container.textContent).not.toContain('Association saved');
  expect(saveButton().disabled).toBe(false);
});
