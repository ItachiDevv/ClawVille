import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { useSalvageStore } from '../salvage';
import { clearIdentityState } from '@/lib/clear-identity-state';

// 2026-09-18: the salvage store holds an account's PRIVATE material balance
// and claim counters, and nothing cleared it on sign-out or account switch.

const hydrate = () =>
  useSalvageStore.getState().setState({
    nodes: [{ nodeId: 'n1', nextClaimAt: new Date(Date.now() + 60_000).toISOString() }],
    materialBalance: 42,
    claimsUsedToday: 3,
    claimsRemainingToday: 17,
    ownerClaimsUsedToday: 1,
    ownerClaimsRemainingToday: 119,
    lastClaim: null,
    rules: useSalvageStore.getState().rules,
  });

describe('salvage store never carries one account into the next', () => {
  test('reset() returns to the empty, never-hydrated state', () => {
    hydrate();
    expect(useSalvageStore.getState().materialBalance).toBe(42);
    useSalvageStore.getState().reset();
    const s = useSalvageStore.getState();
    expect(s.materialBalance).toBe(0);
    expect(s.avatarClaims).toEqual({ used: 0, remaining: 0 });
    expect(s.ownerClaims).toEqual({ used: 0, remaining: 0 });
    expect(s.nodeCooldowns.size).toBe(0);
    expect(s.hydratedAt).toBe(0);
  });

  test('sign-out / account switch (clearIdentityState) clears it', () => {
    hydrate();
    clearIdentityState(new QueryClient());
    expect(useSalvageStore.getState().materialBalance).toBe(0);
    expect(useSalvageStore.getState().hydratedAt).toBe(0);
  });
});
