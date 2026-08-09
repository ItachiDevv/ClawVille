/**
 * salvage.ts — Zustand store for seabed salvage node state + the pooled
 * material balance.
 *
 * Hydrated by `SalvageStateHydrator` (land-salvage-render.tsx) from
 * `GET /api/land/salvage/state`. Keyed like `useLandStore.pieces` — public
 * world state, not owner-private, so it survives auth transitions the same
 * way `parcels` does (never wiped on logout, since a guest can still see
 * which nodes are on cooldown).
 */
import { create } from 'zustand';
import type { LandSalvageClaimWindow, LandSalvageReceiptDTO } from '@/components/game/land/types';

const EMPTY_WINDOW: LandSalvageClaimWindow = Object.freeze({ used: 0, remaining: 0, cap: 0 });

interface SalvageStore {
  /** nodeId -> nextClaimAt (ms epoch), or 0 for "claimable now". */
  nodeCooldowns: Map<string, number>;
  materialBalance: number;
  avatarClaims: LandSalvageClaimWindow;
  ownerClaims: LandSalvageClaimWindow;
  lastReceipt: LandSalvageReceiptDTO | null;
  /** Last successful full hydration, ms epoch — lets the HUD show staleness if the poll dies. */
  hydratedAt: number;

  setState: (input: {
    nodes: readonly { nodeId: string; nextClaimAt: string | null }[];
    materialBalance: number;
    avatarClaims: LandSalvageClaimWindow;
    ownerClaims: LandSalvageClaimWindow;
    lastReceipt: LandSalvageReceiptDTO | null;
  }) => void;

  /** Optimistic post-claim patch — one node + the two counters + balance. */
  applyClaimResult: (input: {
    nodeId: string;
    nextClaimAt: string;
    materialBalance: number;
    avatarClaims: LandSalvageClaimWindow;
    ownerClaims: LandSalvageClaimWindow;
    receipt: LandSalvageReceiptDTO;
  }) => void;
}

export const useSalvageStore = create<SalvageStore>()((set) => ({
  nodeCooldowns: new Map(),
  materialBalance: 0,
  avatarClaims: EMPTY_WINDOW,
  ownerClaims: EMPTY_WINDOW,
  lastReceipt: null,
  hydratedAt: 0,

  setState: ({ nodes, materialBalance, avatarClaims, ownerClaims, lastReceipt }) =>
    set(() => {
      const next = new Map<string, number>();
      for (const node of nodes) {
        next.set(node.nodeId, node.nextClaimAt ? Date.parse(node.nextClaimAt) || 0 : 0);
      }
      return {
        nodeCooldowns: next,
        materialBalance,
        avatarClaims,
        ownerClaims,
        lastReceipt,
        hydratedAt: Date.now(),
      };
    }),

  applyClaimResult: ({ nodeId, nextClaimAt, materialBalance, avatarClaims, ownerClaims, receipt }) =>
    set((state) => {
      const next = new Map(state.nodeCooldowns);
      next.set(nodeId, Date.parse(nextClaimAt) || 0);
      return {
        nodeCooldowns: next,
        materialBalance,
        avatarClaims,
        ownerClaims,
        lastReceipt: receipt,
      };
    }),
}));

/** True when the node has no recorded cooldown, or its cooldown has elapsed. */
export function isSalvageNodeClaimable(nodeCooldowns: Map<string, number>, nodeId: string): boolean {
  const until = nodeCooldowns.get(nodeId);
  return until === undefined || until <= Date.now();
}
