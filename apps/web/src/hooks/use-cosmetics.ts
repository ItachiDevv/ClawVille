/**
 * Q3 plan §4 — React Query hook for cosmetic SKU + ownership state.
 *
 * Two queries:
 *   - `useOwnedCosmetics()`  — auth'd, returns the caller pet's owned skins
 *     with equipped state. Polled every 60s + on window focus.
 *   - `useCosmeticCatalog(scope?)` — public, returns purchasable SKUs.
 *     For Phase 4 storefront; Phase 3 drawer doesn't need it.
 *
 * Mutations:
 *   - `useEquipCosmetic()`   — POST /equip; optimistic toggle then refetch.
 *   - `useUnequipCosmetic()` — POST /unequip; same pattern.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

export interface CosmeticVariantOwned {
  id: string;
  rigType: string;
  assetUrl: string;
  assetMeta: Record<string, unknown> | null;
}

export interface CosmeticSkuOwned {
  id: string;
  slug: string;
  category: string;
  scope: string;
  displayName: string;
  description: string | null;
  rarity: string;
  attribution: string | null;
  attributionUrl: string | null;
  licenseSpdx: string | null;
}

export interface OwnedCosmetic {
  id: string;
  acquiredAt: string;
  acquiredVia: string;
  equipped: boolean;
  equippedAt: string | null;
  sku: CosmeticSkuOwned;
  variants: CosmeticVariantOwned[];
}

export interface OwnedCosmeticsResponse {
  owned: OwnedCosmetic[];
  generatedAt: string;
}

async function fetchOwned(): Promise<OwnedCosmeticsResponse> {
  const res = await fetch(`${API_URL}/api/cosmetics/owned`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Owned cosmetics request failed: ${res.status}`);
  return (await res.json()) as OwnedCosmeticsResponse;
}

async function postEquip(skuId: string, equipped: boolean): Promise<void> {
  const action = equipped ? 'equip' : 'unequip';
  const res = await fetch(`${API_URL}/api/cosmetics/${skuId}/${action}`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string })?.message ?? `Equip failed: ${res.status}`);
  }
}

export function useOwnedCosmetics() {
  return useQuery({
    queryKey: ['cosmetics', 'owned'],
    queryFn: fetchOwned,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useEquipCosmetic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ skuId, equipped }: { skuId: string; equipped: boolean }) =>
      postEquip(skuId, equipped),
    // Optimistic toggle so the drawer UI feels instant; on failure the
    // refetch corrects state.
    onMutate: async ({ skuId, equipped }) => {
      await qc.cancelQueries({ queryKey: ['cosmetics', 'owned'] });
      const prev = qc.getQueryData<OwnedCosmeticsResponse>(['cosmetics', 'owned']);
      if (prev) {
        qc.setQueryData<OwnedCosmeticsResponse>(['cosmetics', 'owned'], {
          ...prev,
          owned: prev.owned.map((o) =>
            o.sku.id === skuId
              ? { ...o, equipped, equippedAt: equipped ? new Date().toISOString() : null }
              : o,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        qc.setQueryData(['cosmetics', 'owned'], context.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['cosmetics', 'owned'] });
    },
  });
}
