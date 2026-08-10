/**
 * salvage.ts — Zustand store for seabed salvage node state + the pooled
 * material balance.
 *
 * Hydrated by `SalvageStateHydrator` (land-salvage-render.tsx) from
 * `GET /api/land/salvage/state`. Keyed like `useLandStore.pieces` — public
 * world state, not owner-private, so it survives auth transitions the same
 * way `parcels` does. NOTE: unlike `parcels`, the salvage read model is
 * NOT guest-accessible (`requireNonGuestIdentity`), so a guest session never
 * populates this — `SalvageGatherPill` gates on `useIsGuest()` before even
 * attempting a hydrate.
 */
import { create } from 'zustand';
import type { LandSalvageClaimPayload, LandSalvageRules } from '@/components/game/land/types';

const EMPTY_RULES: LandSalvageRules = Object.freeze({
  approachRangeWu: 260,
  cooldownMs: 6 * 60 * 60 * 1000,
  avatarDailyClaimCap: 20,
  ownerDailyClaimCap: 120,
  layoutVersion: 1,
});

interface SalvageClaimCounters {
  used: number;
  remaining: number;
}

interface SalvageStore {
  /** nodeId -> nextClaimAt (ms epoch), or 0 for "claimable now". */
  nodeCooldowns: Map<string, number>;
  materialBalance: number;
  avatarClaims: SalvageClaimCounters;
  ownerClaims: SalvageClaimCounters;
  lastClaim: LandSalvageClaimPayload | null;
  /** Rendered caps come FROM the server's `rules` — never hardcode them client-side. */
  rules: LandSalvageRules;
  /** Last successful full hydration, ms epoch — lets the HUD show staleness if the poll dies. */
  hydratedAt: number;

  setState: (input: {
    nodes: readonly { nodeId: string; nextClaimAt: string | null }[];
    materialBalance: number;
    claimsUsedToday: number;
    claimsRemainingToday: number;
    ownerClaimsUsedToday: number;
    ownerClaimsRemainingToday: number;
    lastClaim: LandSalvageClaimPayload | null;
    rules: LandSalvageRules;
  }) => void;

  /** Optimistic post-claim patch — one node + the two counters + balance. */
  applyClaimResult: (payload: LandSalvageClaimPayload) => void;
}

export const useSalvageStore = create<SalvageStore>()((set) => ({
  nodeCooldowns: new Map(),
  materialBalance: 0,
  avatarClaims: { used: 0, remaining: 0 },
  ownerClaims: { used: 0, remaining: 0 },
  lastClaim: null,
  rules: EMPTY_RULES,
  hydratedAt: 0,

  setState: ({
    nodes,
    materialBalance,
    claimsUsedToday,
    claimsRemainingToday,
    ownerClaimsUsedToday,
    ownerClaimsRemainingToday,
    lastClaim,
    rules,
  }) =>
    set(() => {
      const next = new Map<string, number>();
      for (const node of nodes) {
        next.set(node.nodeId, node.nextClaimAt ? Date.parse(node.nextClaimAt) || 0 : 0);
      }
      return {
        nodeCooldowns: next,
        materialBalance,
        avatarClaims: { used: claimsUsedToday, remaining: claimsRemainingToday },
        ownerClaims: { used: ownerClaimsUsedToday, remaining: ownerClaimsRemainingToday },
        lastClaim,
        rules,
        hydratedAt: Date.now(),
      };
    }),

  applyClaimResult: (payload) =>
    set((state) => {
      const next = new Map(state.nodeCooldowns);
      next.set(payload.nodeId, Date.parse(payload.nextClaimAt) || 0);
      return {
        nodeCooldowns: next,
        materialBalance: payload.balanceAfter,
        avatarClaims: {
          used: state.avatarClaims.used + 1,
          remaining: payload.claimsRemainingToday,
        },
        ownerClaims: {
          used: state.ownerClaims.used + 1,
          remaining: payload.ownerClaimsRemainingToday,
        },
        lastClaim: payload,
      };
    }),
}));

/** True when the node has no recorded cooldown, or its cooldown has elapsed. */
export function isSalvageNodeClaimable(nodeCooldowns: Map<string, number>, nodeId: string): boolean {
  const until = nodeCooldowns.get(nodeId);
  return until === undefined || until <= Date.now();
}
