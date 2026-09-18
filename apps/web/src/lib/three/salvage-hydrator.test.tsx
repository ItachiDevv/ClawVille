import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

// 2026-09-18 (Codex r2): a salvage-state poll that was in flight when the
// identity reset landed wrote the previous account's private numbers back.
// Guests must not poll at all (the route refuses them; prod logged a 401 per
// guest tab every 45 s).

let auth: { user: { id: string; isGuest: boolean } } | null = null;
let calls = 0;
let resolvePoll: ((value: unknown) => void) | null = null;

mock.module('@/hooks/use-auth-me', () => ({
  useAuthMe: () => ({ data: auth }),
}));
mock.module('@/lib/api', () => ({
  api: {
    getLandSalvageState: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolvePoll = resolve;
      });
    },
  },
}));

const testWindow = new Window({ url: 'http://localhost/game' });
const saved = new Map<PropertyKey, PropertyDescriptor | undefined>();
const names = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const;

let createRoot: typeof import('react-dom/client').createRoot;
let SalvageStateHydrator: typeof import('./land-salvage-render').SalvageStateHydrator;
let useSalvageStore: typeof import('@/stores/salvage').useSalvageStore;

beforeAll(async () => {
  for (const n of names) saved.set(n, Object.getOwnPropertyDescriptor(globalThis, n));
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: testWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: testWindow.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: testWindow.navigator });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  ({ createRoot } = await import('react-dom/client'));
  ({ SalvageStateHydrator } = await import('./land-salvage-render'));
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

function mount(): { root: Root; el: HTMLElement } {
  const el = testWindow.document.createElement('div') as unknown as HTMLElement;
  testWindow.document.body.appendChild(el as never);
  const root = createRoot(el);
  act(() => root.render(createElement(SalvageStateHydrator)));
  return { root, el };
}

describe('salvage state hydrator', () => {
  test('a guest never polls', () => {
    calls = 0;
    auth = { user: { id: 'guest-1', isGuest: true } };
    const { root } = mount();
    expect(calls).toBe(0);
    act(() => root.unmount());
  });

  test('a poll in flight during an identity reset cannot write the old account back', async () => {
    calls = 0;
    auth = { user: { id: 'u1', isGuest: false } };
    const { root } = mount();
    expect(calls).toBe(1);
    // Sign-out / account switch lands while the request is in flight.
    useSalvageStore.getState().reset();
    await act(async () => {
      resolvePoll?.(body);
      await Promise.resolve();
    });
    expect(useSalvageStore.getState().materialBalance).toBe(0);
    act(() => root.unmount());
  });

  test('a poll for the current account still lands', async () => {
    calls = 0;
    auth = { user: { id: 'u2', isGuest: false } };
    const { root } = mount();
    await act(async () => {
      resolvePoll?.(body);
      await Promise.resolve();
    });
    expect(useSalvageStore.getState().materialBalance).toBe(42);
    act(() => root.unmount());
  });
});
