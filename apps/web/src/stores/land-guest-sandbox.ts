/**
 * land-guest-sandbox.ts — CLIENT-ONLY guest land sandbox state.
 *
 * ClawVille's shared world cannot mutate for a guest (a guest is a throwaway
 * demo identity — the land economy 403s every guest write, `land.ts`
 * `requireNonGuestIdentity` → `code:'guest_not_allowed'`). So a guest gets a
 * PRETEND land experience that lives ENTIRELY in the browser: claim a demo
 * Starter Cove, build a home/shop, upgrade it — all against a demo CT wallet
 * seeded here, with ZERO network calls.
 *
 * ISOLATION — this is the load-bearing guarantee:
 *   - This is a SEPARATE Zustand store from `useLandStore` (stores/land.ts),
 *     which is the REAL render/ownership state the 3D world reads. Nothing here
 *     ever writes into `useLandStore`, so a sandbox cove NEVER appears in the
 *     shared 3D world (correct v1 behaviour — see guest-land-sandbox.tsx copy).
 *   - No action here touches TanStack Query cache (no `LAND_PARCELS_QUERY_KEY`,
 *     no `['avatar']`, no `api.*`). There is literally no request path out of
 *     this module, so sandbox state can never leak into a server call.
 *   - Persisted to localStorage under a namespaced key so a guest's pretend
 *     holdings survive a reload. Plain-object/number state only (no Map), so
 *     JSON serialization is lossless.
 *
 * The demo CT wallet here is DISTINCT from the guest's 100-CT genesis display
 * in `avatar-status-bar.tsx` (that reads the real avatar row, which we must not
 * mutate). This wallet is the sandbox's own play-money, seeded generously so a
 * guest can claim + build + upgrade and feel the real economy's shape, and it
 * is only ever shown INSIDE the sandbox panel, always labelled DEMO.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  LAND_STARTER_DEPOSIT_CT,
  STRUCTURE_UPGRADE_COSTS,
  getTierMaxLevel,
} from '@clawville/shared';

/** localStorage key — bump the `:vN` suffix if the persisted shape changes. */
export const GUEST_SANDBOX_STORAGE_KEY = 'clawville:land-guest-sandbox:v1';

/**
 * Seed for the sandbox demo wallet. Sized so a guest can claim the Starter Cove
 * (a {@link LAND_STARTER_DEPOSIT_CT} deposit) AND upgrade to the starter cap
 * with comfortable headroom, so the demo never dead-ends on "need more CT".
 */
export const GUEST_SANDBOX_START_CT = 10_000;

/** The pretend parcel code shown for the guest's demo cove (display-only). */
export const GUEST_SANDBOX_PARCEL_CODE = 'demo-cove';

/** The sandbox cove is always a STARTER-tier lot (the only guest-reachable tier). */
export const GUEST_SANDBOX_TIER = 'starter' as const;

export interface GuestSandboxStructure {
  structureType: 'home' | 'shop';
  /** A starter-tier catalog key (e.g. `home-cottage`, `shop-stall`). */
  catalogKey: string;
  /** 1..starter maxLevel (2). Placement lands Lv1; upgrade climbs to the cap. */
  level: number;
}

export interface GuestSandboxCove {
  /** Display-only pretend code. */
  parcelCode: string;
  claimedAt: number;
  /** Original deposit escrowed at claim (CT). */
  depositCt: number;
  /** Refundable remainder returned to the demo wallet on release. */
  depositRemainingCt: number;
  structure: GuestSandboxStructure | null;
}

/** Machine result codes so the UI can branch without string-matching. */
export type GuestSandboxCode =
  | 'ok'
  | 'already_owned'
  | 'insufficient_ct'
  | 'no_cove'
  | 'has_structure'
  | 'no_structure'
  | 'max_level';

export interface GuestSandboxResult {
  ok: boolean;
  code: GuestSandboxCode;
  /** CT spent (upgrade) or refunded (release), when relevant. */
  amountCt?: number;
}

interface GuestSandboxState {
  /** Sandbox-only demo wallet (NOT the real avatar balance). */
  demoCt: number;
  /** The guest's single pretend cove, or null before they claim one. */
  cove: GuestSandboxCove | null;

  /** Escrow the starter deposit and create the demo cove. */
  claimCove: () => GuestSandboxResult;
  /** Place a FREE Lv1 structure on the cove (no existing structure). */
  buildStructure: (structureType: 'home' | 'shop', catalogKey: string) => GuestSandboxResult;
  /** Upgrade the structure one level, debiting the tier upgrade cost. */
  upgradeStructure: () => GuestSandboxResult;
  /** Release the cove, refunding the remaining deposit to the demo wallet. */
  releaseCove: () => GuestSandboxResult;
  /** Wipe the sandbox back to the seeded wallet + no cove. */
  resetSandbox: () => void;
}

const STARTER_MAX_LEVEL = getTierMaxLevel(GUEST_SANDBOX_TIER); // 2

export const useGuestLandSandbox = create<GuestSandboxState>()(
  persist(
    (set, get) => ({
      demoCt: GUEST_SANDBOX_START_CT,
      cove: null,

      claimCove: () => {
        const { cove, demoCt } = get();
        if (cove) return { ok: false, code: 'already_owned' };
        if (demoCt < LAND_STARTER_DEPOSIT_CT) return { ok: false, code: 'insufficient_ct' };
        set({
          demoCt: demoCt - LAND_STARTER_DEPOSIT_CT,
          cove: {
            parcelCode: GUEST_SANDBOX_PARCEL_CODE,
            claimedAt: Date.now(),
            depositCt: LAND_STARTER_DEPOSIT_CT,
            depositRemainingCt: LAND_STARTER_DEPOSIT_CT,
            structure: null,
          },
        });
        return { ok: true, code: 'ok', amountCt: LAND_STARTER_DEPOSIT_CT };
      },

      buildStructure: (structureType, catalogKey) => {
        const { cove } = get();
        if (!cove) return { ok: false, code: 'no_cove' };
        if (cove.structure) return { ok: false, code: 'has_structure' };
        // Placement is free and lands at Lv1 (mirrors STRUCTURE_UPGRADE_COSTS[1] === 0).
        set({ cove: { ...cove, structure: { structureType, catalogKey, level: 1 } } });
        return { ok: true, code: 'ok', amountCt: 0 };
      },

      upgradeStructure: () => {
        const { cove, demoCt } = get();
        if (!cove) return { ok: false, code: 'no_cove' };
        if (!cove.structure) return { ok: false, code: 'no_structure' };
        const nextLevel = cove.structure.level + 1;
        if (nextLevel > STARTER_MAX_LEVEL) return { ok: false, code: 'max_level' };
        const cost = STRUCTURE_UPGRADE_COSTS[nextLevel] ?? 0;
        if (demoCt < cost) return { ok: false, code: 'insufficient_ct' };
        set({
          demoCt: demoCt - cost,
          cove: { ...cove, structure: { ...cove.structure, level: nextLevel } },
        });
        return { ok: true, code: 'ok', amountCt: cost };
      },

      releaseCove: () => {
        const { cove, demoCt } = get();
        if (!cove) return { ok: false, code: 'no_cove' };
        const refund = cove.depositRemainingCt;
        set({ demoCt: demoCt + refund, cove: null });
        return { ok: true, code: 'ok', amountCt: refund };
      },

      resetSandbox: () => set({ demoCt: GUEST_SANDBOX_START_CT, cove: null }),
    }),
    {
      name: GUEST_SANDBOX_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        typeof window !== 'undefined'
          ? window.localStorage
          : // SSR fallback: a no-op storage so the store never throws during
            // Next.js server prerender of the 'use client' modal.
            { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      ),
      // Persist only DATA; the action closures are re-created on every load.
      partialize: (s) => ({ demoCt: s.demoCt, cove: s.cove }),
    },
  ),
);

/** The starter-tier upgrade cap, exposed for the sandbox UI's level ladder. */
export const GUEST_SANDBOX_MAX_LEVEL = STARTER_MAX_LEVEL;
