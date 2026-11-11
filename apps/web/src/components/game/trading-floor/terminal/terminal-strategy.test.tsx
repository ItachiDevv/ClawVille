import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import { cloneFloorArenaParams, FLOOR_ARENA_TEMPLATES } from '@clawville/shared';
import { TerminalStrategy } from './terminal-strategy';
import type { Root } from 'react-dom/client';

const dom = new Window({ url: 'http://localhost' });
const names = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'] as const;
const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let root: Root;
let host: HTMLElement;
let client: QueryClient;
let writes: Array<{ method: string; body: unknown }> = [];
beforeAll(() => {
  for (const name of names) {
    if (name === 'fetch') continue;
    const value = name === 'window' ? dom : name === 'document' ? dom.document : name === 'navigator' ? dom.navigator : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
afterEach(async () => { await act(async () => root?.unmount()); client?.clear(); host?.remove(); });
afterAll(() => { for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } dom.close(); });
async function mount(invalid = false) {
  writes = [];
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (_url: unknown, init: RequestInit) => {
    writes.push({ method: init.method ?? '', body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  } });
  host = document.createElement('div'); document.body.appendChild(host);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const { createRoot } = await import('react-dom/client'); root = createRoot(host);
  const params = cloneFloorArenaParams(FLOOR_ARENA_TEMPLATES[0]!.params);
  if (invalid) params.limits.max_open = 99999;
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(TerminalStrategy, { params, compact: false }))));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === label);
  expect(button).toBeDefined();
  await act(async () => { button!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
}
test('five sections preserve filters and display a current-rule review', async () => {
  await mount();
  expect(host.textContent).toContain('Open positions keep their original exit rules.');
  expect(host.querySelector('[aria-label="Strategy sections"]')?.querySelectorAll('button')).toHaveLength(5);
  expect(host.querySelector('[data-testid="arena-field-filters.mcap_min"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="arena-field-filters.chg5m_min"]')).toBeNull();
  await click('When it buys');
  expect(host.querySelector('[data-testid="arena-field-filters.chg5m_min"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="arena-field-filters.mcap_min"]')).toBeNull();
  await click('Review'); expect(host.textContent).toContain('Current rules');
});
test('valid rules use the existing PATCH mutation', async () => {
  await mount(); await click('Save rules');
  expect(writes).toHaveLength(1); expect(writes[0]?.method).toBe('PATCH');
  expect(host.textContent).toContain('Rules saved.');
});
test('invalid rules never send a write and show review errors', async () => {
  await mount(true); await click('Save rules');
  expect(writes).toHaveLength(0); expect(host.querySelector('[role="alert"]')).not.toBeNull();
});
