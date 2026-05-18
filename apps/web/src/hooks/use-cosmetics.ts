/**
 * Q3 plan §4 — React Query hook for cosmetic SKU + ownership state.
 *
 * Queries:
 *   - `useOwnedCosmetics()`  — auth'd, returns the caller avatar's owned skins
 *     with equipped state. Polled every 60s + on window focus.
 *   - `useCosmeticCatalog(scope?)` — public, returns purchasable SKUs.
 *     Drives the Shop tab inside CosmeticDrawer.
 *
 * Mutations:
 *   - `useEquipCosmetic()`   — POST /equip; optimistic toggle then refetch.
 *   - `useBuyCosmetic()`     — POST /buy; debits CT, inserts avatar_skins,
 *     invalidates owned + avatar caches.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';

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
  /**
   * Pre-rendered preview thumbnail URL (square PNG, ~256×256). Null
   * when no asset has been baked for this SKU yet — drawer should fall
   * back to a category emoji in that case.
   */
  thumbnailUrl: string | null;
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

// ---------------------------------------------------------------------------
// Shop catalog
// ---------------------------------------------------------------------------

export interface CosmeticCatalogItem {
  id: string;
  slug: string;
  category: string;
  /** Pre-rendered preview thumbnail URL — see CosmeticSkuOwned for details. */
  thumbnailUrl: string | null;
  scope: string;
  displayName: string;
  description: string | null;
  rarity: string;
  priceCt: number;
  exclusiveCurrency: string | null;
  attribution: string | null;
  attributionUrl: string | null;
  licenseSpdx: string | null;
  availableUntil: string | null;
  supplyCap: number | null;
}

export interface CosmeticCatalogResponse {
  catalog: CosmeticCatalogItem[];
  generatedAt: string;
}

async function fetchCatalog(scope?: string): Promise<CosmeticCatalogResponse> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : '';
  const res = await fetch(`${API_URL}/api/cosmetics/catalog${qs}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Catalog request failed: ${res.status}`);
  return (await res.json()) as CosmeticCatalogResponse;
}

export function useCosmeticCatalog(scope?: string) {
  return useQuery({
    queryKey: ['cosmetics', 'catalog', scope ?? 'all'],
    queryFn: () => fetchCatalog(scope),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Buy mutation
// ---------------------------------------------------------------------------

export interface BuyResponse {
  ok: true;
  alreadyOwned: boolean;
  avatarSkinId: string;
  clawTokens: number;
  equipped?: boolean;
}

async function postBuy(skuId: string): Promise<BuyResponse> {
  const res = await fetch(`${API_URL}/api/cosmetics/${skuId}/buy`, {
    method: 'POST',
    credentials: 'include',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { message?: string })?.message ?? `Buy failed: ${res.status}`);
  }
  return body as BuyResponse;
}

export function useBuyCosmetic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skuId: string) => postBuy(skuId),
    onSuccess: () => {
      // Refetch owned (new row) and avatar (CT balance changed).
      qc.invalidateQueries({ queryKey: ['cosmetics', 'owned'] });
      qc.invalidateQueries({ queryKey: ['avatar'] });
    },
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

      // Toast feedback — fire on mutation start so the user sees something
      // happens before the GLB attach completes (~100-300ms first time,
      // instant after cache warm). Read the SKU display name from the
      // cached `owned` snapshot, which the drawer already populated. If
      // the sku isn't found there we fall back to a generic message.
      const item = prev?.owned.find((o) => o.sku.id === skuId);
      const name = item?.sku.displayName ?? 'cosmetic';
      const verb = equipped ? 'Equipping' : 'Unequipping';
      // addToast is called eagerly (not via React) so it works inside
      // useMutation callbacks without rules-of-hooks violations.
      useGameStore.getState().addToast('✨', `${verb} ${name}…`, 1800);

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
      return { prev, name };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        qc.setQueryData(['cosmetics', 'owned'], context.prev);
      }
      useGameStore.getState().addToast(
        '⚠️',
        `Couldn't equip ${context?.name ?? 'cosmetic'} — try again`,
        2400,
      );
    },
    onSuccess: (_data, vars, context) => {
      // Server confirmed the toggle. Confirmation toast lands ~ when the
      // cosmetic-loader's GLB attach is about to render.
      useGameStore.getState().addToast(
        vars.equipped ? '✅' : '👋',
        vars.equipped
          ? `${context?.name ?? 'Cosmetic'} equipped`
          : `${context?.name ?? 'Cosmetic'} unequipped`,
        1600,
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['cosmetics', 'owned'] });
    },
  });
}
