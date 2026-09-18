import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

// 2026-09-18 (Codex r2): a salvage-state poll in flight when the identity
// reset landed wrote the previous account's private numbers back. With no
// account (guest / signed out) there must be no poll at all: the route
// refuses guests, and prod logged a 401 per guest tab every 45 s.
//
// The poller's inputs are injected, so this test needs NO process-wide module
// mocks (a mock of '@/lib/api' leaked into other suites in round 3).

const testWindow = new Window({ url: 'http://localhost/game' });
const saved = new Map<PropertyKey, PropertyDescriptor | undefined>();
const names = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const;

let createRoot: typeof import('react-dom/client').createRoot;
let SalvageStatePoller: typeof import('./land-salvage-render').SalvageStatePoller;
let useSalvageStore: typeof import('@/stores/salvage').useSalvageStore;

beforeAll(async () => {
  for (const n of names) saved.set(n, Object.getOwnPropertyDescriptor(globalThis, n));
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: testWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: testWindow.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: testWindow.navigator });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  ({ createRoot } = await import('react-dom/client'));
  ({ SalvageStatePoller } = await import('./land-salvage-render'));
  ({ useSalvageStore } = await import('@/stores/salvage'));
});

afterAll(() => {
  for (const [n, d] of saved) {
    if (d) Object.defineProperty(globalThis, n, d);
    else Reflect.deleteProperty(globalThis, n);
  }
});

const body = {
  nodes: [], materialBalance: 42, claimsUsedToday: 3, claimsRemainingToday: 17,
  ownerClaimsUsedToday: 0, ownerClaimsRemainingToday: 120, lastClaim: null,
  rules: { approachRangeWu: 260, cooldownMs: 1, avatarDailyClaimCap: 20, ownerDailyClaimCap: 120, layoutVersion: 1 },
};

function deferredFetch() {
  const state = { calls: 0, resolve: null as ((v: unknown) => void) | null };
  const fetchState = () => {
    state.calls += 1;
    return new Promise((resolve) => {
      state.resolve = resolve;
    }) as never;
  };
  return { state, fetchState };
}

function mount(accountId: string | null, fetchState: () => Promise<never>): Root {
  const el = testWindow.document.createElement('div') as unknown as HTMLElement;
  testWindow.document.body.appendChild(el as never);
  const root = createRoot(el);
  act(() => root.render(createElement(SalvageStatePoller, { accountId, fetchState })));
  return root;
}

describe('salvage state poller', () => {
  test('no account (guest / signed out): no poll, and private numbers are cleared', () => {
    useSalvageStore.getState().reset();
    const { state, fetchState } = deferredFetch();
    const root = mount(null, fetchState);
    expect(state.calls).toBe(0);
    expect(useSalvageStore.getState().materialBalance).toBe(0);
    act(() => root.unmount());
  });

  test('a poll in flight during an identity reset writes nothing', async () => {
    const { state, fetchState } = deferredFetch();
    const root = mount('u1', fetchState);
    expect(state.calls).toBe(1);
    useSalvageStore.getState().reset(); // sign-out / switch lands mid-request
    await act(async () => {
      state.resolve?.(body);
      await Promise.resolve();
    });
    expect(useSalvageStore.getState().materialBalance).toBe(0);
    act(() => root.unmount());
  });

  test('a poll for the current account still lands', async () => {
    const { state, fetchState } = deferredFetch();
    const root = mount('u2', fetchState);
    await act(async () => {
      state.resolve?.(body);
      await Promise.resolve();
    });
    expect(useSalvageStore.getState().materialBalance).toBe(42);
    act(() => root.unmount());
  });
});
