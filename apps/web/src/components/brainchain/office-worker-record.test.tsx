import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { BrainchainEarningsPage } from '@clawville/shared';

mock.module('@/lib/fingerprint', () => ({ getFingerprint: async () => 'fixture' }));
mock.module('./brainchain-office.module.css', () => ({ default: {} }));
const browser = new Window({ url: 'http://localhost/brainchain' });
const originals = new Map<string, PropertyDescriptor | undefined>();
let createRoot: typeof import('react-dom/client').createRoot;
let Component: typeof import('./office-worker-record').OfficeWorkerRecord;
let format: typeof import('./office-worker-record').formatAtomic;
let formatUnlock: typeof import('./office-worker-record').formatUnlockTime;
let root: Root | undefined;
let client: QueryClient | undefined;
let container: HTMLElement | undefined;
const workerId = '11111111-1111-4111-8111-111111111111';
const address = `0x${'1'.repeat(40)}`;
const page: BrainchainEarningsPage = { workerId, environment: 'testnet', chainId: 274630, address, observedAt: '2026-11-09T00:00:00.000Z', blockAgeSeconds: 999,
  provisional: true, freshness: { state: 'stale', maxBlockAgeSeconds: 120 }, block: { number: '5000', hash: `0x${'a'.repeat(64)}`, timestamp: '123' },
  balances: { gasWei: '1', brainAtomic: '1000000000000000000', usdgAtomic: '9007199254740993000' },
  stake: { stakedAtomic: '1000000000000000000', unstakingAtomic: '2', unlocksAtUnix: '1800000000', priceAtomic: '0', registered: true, held: '3' },
  history: { boardAddress: address, deploymentBlock: '965', fromBlock: '965', throughBlock: '2964', nextBlock: '2965', coverage: 'selected_board_range', pageNetAtomic: '10',
    boards: [{ address, release: '3.5.0', fromBlock: '965' }], receipts: [] } };
beforeAll(async () => {
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    if (name === 'fetch') continue;
    const value = name === 'window' ? browser : name === 'document' ? browser.document : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : (browser as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  createRoot = (await import('react-dom/client')).createRoot;
  const module = await import('./office-worker-record'); Component = module.OfficeWorkerRecord; format = module.formatAtomic; formatUnlock = module.formatUnlockTime;
});
afterEach(async () => { await act(async () => root?.unmount()); client?.clear(); container?.remove(); root = undefined; });
afterAll(() => { browser.close(); for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name); } });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
test('private observations load only on explicit request, use credentialed GET, and preserve exact amounts and coverage', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init }); return Response.json(page); }) as typeof fetch;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient();
  await act(async () => { root!.render(createElement(QueryClientProvider, { client: client! }, createElement(Component, { workerId, ownerKey: 'owner-a' }))); await settle(); });
  expect(calls).toHaveLength(0);
  await act(async () => { container!.querySelector('button')!.click(); await settle(); });
  await act(settle);
  expect(calls).toHaveLength(1); expect(calls[0]!.init?.credentials).toBe('include'); expect(calls[0]!.init?.method).toBe('GET'); expect(calls[0]!.init?.body).toBeUndefined();
  expect(container.textContent).toContain('9007199254740.993 tUSDG');
  expect(container.textContent).toContain('Stale chain observation');
  expect(container.textContent).toContain('blocks 965–2964');
  expect(container.textContent).toContain('not lifetime income');
  expect(container.textContent).toContain('Stake: 1 tBRAIN');
  expect(container.textContent).toContain('Pending unstake: 0.000000000000000002');
  expect(container.textContent).toContain(`Unstake unlock time: ${new Date(1800000000000).toLocaleString()}`);
  await act(async () => { [...container!.querySelectorAll('button')].find(button => button.textContent === 'Read next range')!.click(); await settle(); });
  expect(calls[1]?.url).toContain(`board=${address}&fromBlock=2965`);
  expect(client.getQueryCache().getAll().every(query => query.queryKey.includes('owner-a'))).toBe(true);
});
test('atomic conversion retains small units and rejects malformed amounts', () => {
  expect(format('1', 18)).toBe('0.000000000000000001'); expect(format('1000000', 6)).toBe('1');
  expect(format('0', 6)).toBe('0'); expect(format('-1', 6)).toBe('Unavailable');
});
test('unlock dates use local time and bound invalid or unset timestamps', () => {
  expect(formatUnlock('1800000000')).toBe(new Date(1800000000000).toLocaleString());
  expect(formatUnlock('0')).toBe('No unlock time set');
  for (const value of ['bad', '-1', '01', '8640000000001', '9'.repeat(99)]) expect(formatUnlock(value)).toBe('Unlock time unavailable');
});
