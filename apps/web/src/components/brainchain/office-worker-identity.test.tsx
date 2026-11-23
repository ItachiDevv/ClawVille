import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { BrainchainIdentityCredit } from '@clawville/shared';
mock.module('@/lib/fingerprint', () => ({ getFingerprint: async () => '' }));
mock.module('./brainchain-office.module.css', () => ({ default: {} }));
const browser = new Window({ url: 'http://localhost/brainchain' });
const originals = new Map<string, PropertyDescriptor | undefined>();
let createRoot: typeof import('react-dom/client').createRoot;
let Component: typeof import('./office-worker-identity').OfficeWorkerIdentity;
let format: typeof import('./office-worker-identity').formatReputation;
let root: Root | undefined, client: QueryClient | undefined, container: HTMLElement | undefined;
const workerId = '11111111-1111-4111-8111-111111111111', address = `0x${'1'.repeat(40)}`;
const data: BrainchainIdentityCredit = { workerId, agentId: '462', environment: 'mainnet', observedAt: '2026-11-09T16:00:00Z', provisional: true,
  identity: { state: 'verified', chainId: 4663, owner: address, registeredWallet: address, association: 'registered_wallet', blockAgeSeconds: 10,
    block: { number: '5000', hash: `0x${'a'.repeat(64)}`, timestamp: '1794240000' } },
  reputation: { state: 'observed', issuer: address, tag1: 'brainchain', tag2: 'task', count: '8', summaryValue: '875', summaryValueDecimals: 1 },
  record: { state: 'stale', owner: address, asOf: '2026-11-09T15:50:00Z', ageSeconds: 600, isRoot: false, backerId: '6234', line: '951.899279', available: '726.607614', drawn: '0.00',
    premiumBps: 0, loansRepaid: 565, qualifiedRepaid: 0, volumeRepaid: '3483.90', feesPaid: '4.137454', score: 121, defaulted: false, frozen: false,
    openLoans: { state: 'terms_unavailable', count: 1 } },
  routes: { state: 'observed', owner: address, asOf: { snapshot: '2026-11-09T16:00:00Z', stocks: null, directoryBlock: '5000' }, snapshotAgeSeconds: 0, stocksAgeSeconds: null,
    ownerDefaulted: false, options: [{ route: 'stock_line', open: true, line: null, bond: null, room: null, upTo: '500.00', maxLine: '500.00', weekLeft: '1000.00' }] } };
beforeAll(async () => {
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); if (name === 'fetch') continue;
    const value = name === 'window' ? browser : name === 'document' ? browser.document : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : (browser as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  createRoot = (await import('react-dom/client')).createRoot;
  const module = await import('./office-worker-identity'); Component = module.OfficeWorkerIdentity; format = module.formatReputation;
});
afterEach(async () => { await act(async () => root?.unmount()); client?.clear(); container?.remove(); root = undefined; });
afterAll(() => { browser.close(); for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name); } });
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
test('selected identity submits a credentialed read and displays exact record status without debt controls', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init }); return Response.json(data); }) as typeof fetch;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); client = new QueryClient();
  await act(async () => { root!.render(createElement(QueryClientProvider, { client: client! }, createElement(Component, { workerId, ownerKey: 'owner-a' }))); await settle(); });
  expect(calls).toHaveLength(0);
  await act(async () => {
    const input = container!.querySelector('input')!;
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, '462');
    input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
    await settle();
  });
  await act(async () => { container!.querySelector('form')!.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event); await settle(); });
  await act(settle);
  expect(calls).toHaveLength(1); expect(calls[0]!.url).toContain(`/workers/${workerId}/identity-credit?agentId=462`);
  expect(calls[0]!.init?.method).toBe('GET'); expect(calls[0]!.init?.credentials).toBe('include'); expect(calls[0]!.init?.body).toBeUndefined();
  expect(container.textContent).toContain('951.899279 USDG'); expect(container.textContent).toContain('726.607614 USDG');
  expect(container.textContent).toContain('Stale Priors record'); expect(container.textContent).toContain('Reported average: 87.5');
  expect(container.textContent).toContain('Open loan terms are unavailable'); expect(container.textContent).toContain('registered wallet');
  expect(container.textContent).toContain('not a credit offer');
  expect([...container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Read identity and credit record']);
  expect(client.getQueryCache().getAll().every(query => query.queryKey.includes('owner-a'))).toBe(true);
});
test('signed reputation preserves decimal scales without inventing accepted-task counts', () => {
  expect(format('875', 1)).toBe('87.5'); expect(format('-1', 2)).toBe('-0.01'); expect(format('0', 0)).toBe('0');
  expect(format('1', 19)).toBe('Unavailable'); expect(format('1e2', 0)).toBe('Unavailable');
});
