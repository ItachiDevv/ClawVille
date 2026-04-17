'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';

export default function ShopOverlay() {
  const { shopOpen, closeShop, currentLocation, addToast } = useGameStore();
  const { data: avatar } = useAvatar();
  const queryClient = useQueryClient();
  const [buyingId, setBuyingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['shop-items', currentLocation],
    queryFn: () => api.getShopItems(currentLocation!),
    enabled: shopOpen && !!currentLocation,
  });

  const buyMutation = useMutation({
    mutationFn: (itemId: string) => api.buyItem(itemId),
    onSuccess: (res) => {
      addToast('🛒', `Bought ${res.item.name}!`);
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setBuyingId(null);
    },
    onError: (err: Error) => {
      addToast('❌', err.message);
      setBuyingId(null);
    },
  });

  if (!shopOpen || !currentLocation) return null;

  const items = data?.items ?? [];
  const tokens = avatar?.clawTokens ?? 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="claw-panel w-full max-w-md mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-bold text-lg">Shop</h2>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-xs font-bold text-cyan-200 bg-cyan-500/20 border border-cyan-400/30 rounded-full px-2 py-0.5">
              <span className="text-sm">&#x1FA99;</span>
              {tokens}
            </span>
            <button
              onClick={closeShop}
              className="w-7 h-7 flex items-center justify-center rounded-full bg-white/10 hover:bg-black/40 text-white font-bold text-sm transition-colors"
            >
              X
            </button>
          </div>
        </div>

        {/* Items list */}
        <div className="flex-1 overflow-y-auto space-y-2">
          {isLoading ? (
            <p className="text-cyan-300/60 text-sm text-center py-8 font-mono uppercase tracking-[0.2em]">Loading shop…</p>
          ) : items.length === 0 ? (
            <p className="text-cyan-300/60 text-sm text-center py-8 font-mono uppercase tracking-[0.2em]">No items available.</p>
          ) : (
            items.map((item) => {
              const canAfford = tokens >= item.price;
              const isBuying = buyingId === item.id;
              return (
                <div
                  key={item.id}
                  className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.04] border border-white/[0.06] hover:border-cyan-500/30 transition-colors"
                >
                  <span className="text-2xl">{item.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-white text-sm">{item.name}</div>
                    <p className="text-white/60 text-xs mt-0.5 line-clamp-2">{item.description}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-xs font-bold text-cyan-200">
                      {item.price} &#x1FA99;
                    </span>
                    <button
                      onClick={() => {
                        setBuyingId(item.id);
                        buyMutation.mutate(item.id);
                      }}
                      disabled={!canAfford || isBuying}
                      className="text-xs font-bold px-3 py-1 rounded bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 disabled:opacity-40 text-white transition-colors shadow-[0_0_12px_rgba(0,229,255,0.2)]"
                    >
                      {isBuying ? '...' : canAfford ? 'Buy' : 'Need more'}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
