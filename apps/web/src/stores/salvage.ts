/**
 * salvage.ts — Zustand store for seabed salvage node state + the pooled
 * material balance.
 *
 * Hydrated by `SalvageStateHydrator` (land-salvage-render.tsx) from
 * `GET /api/land/salvage/state`. The read model is NOT guest-accessible
 * (`requireNonGuestIdentity`), and part of it is PRIVATE to the account
 * (materialBalance, the claim counters, lastClaim). So the hydrator polls only
 * for a signed-in non-guest account, and `reset()` runs on every identity
 * change (clear-identity-state.ts and the hydrator itself) so one account's
 * materials never show under the next one (2026-09-18: guests polled it every
 * 45 s and drew a 401 each time, ~80 lines/hour in the prod log).
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
  /**
   * Identity generation: +1 on every reset(). A claim captures it when it
   * starts; its response only lands if the generation still matches, so a
   * claim that returns after sign-out or an account switch cannot write the
   * previous account's numbers back (Codex, 2026-09-18).
   */
  generation: number;

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

  /** Optimistic post-claim patch — one node + the two counters + balance.
   *  Ignored when `generation` no longer matches (identity changed mid-claim).
   *  Returns whether it applied. */
  applyClaimResult: (payload: LandSalvageClaimPayload, generation: number) => boolean;

  /** Back to the empty, never-hydrated state (identity change / sign-out). */
  reset: () => void;
}

const emptySalvageState = () => ({
  nodeCooldowns: new Map<string, number>(),
  materialBalance: 0,
  avatarClaims: { used: 0, remaining: 0 },
  ownerClaims: { used: 0, remaining: 0 },
  lastClaim: null,
  rules: EMPTY_RULES,
  hydratedAt: 0,
});

export const useSalvageStore = create<SalvageStore>()((set, get) => ({
  ...emptySalvageState(),
  generation: 0,

  reset: () => set((state) => ({ ...emptySalvageState(), generation: state.generation + 1 })),

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

  applyClaimResult: (payload, generation) => {
    if (get().generation !== generation) return false;
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
    });
    return true;
  },
}));

/** True when the node has no recorded cooldown, or its cooldown has elapsed. */
export function isSalvageNodeClaimable(nodeCooldowns: Map<string, number>, nodeId: string): boolean {
  const until = nodeCooldowns.get(nodeId);
  return until === undefined || until <= Date.now();
}
